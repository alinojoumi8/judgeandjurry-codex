import { describe, expect, it } from 'vitest'
import { groundingPatchInstructions, groundingPatchTargets } from '../server/groundingRepair'
import { groundingUnits, type GroundingReview } from '../server/grounding'
import type { StageResult } from '../server/types'
import { MiniMaxClient } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const draft: StageResult = { title: 'Fictional opening', content: 'The Crown must prove the proposed fraud over $1,500 count. Arin received $1,900 (E-001).', citations: ['E-001'], jurors: [] }
const review: GroundingReview = { status: 'failed', method: 'source-quotes-and-model-review', repairs: 0, findings: groundingUnits(draft).map(unit => ({ unitId: unit.id, text: unit.text, status: 'analysis', supportTypes: ['analysis'], explanation: 'Model finding accepted; a separate deterministic check is still enforced.', citations: [] })), errors: ['content:2: the payment amount is not present in its supporting quotation.'] }

describe('unit-local author repair feedback', () => {
  it('puts deterministic errors beside the editable text even if its model finding was analysis', () => {
    const prompt = groundingPatchInstructions(draft, review)
    expect(prompt).toContain('"errors":["content:2: the payment amount is not present in its supporting quotation."]')
    expect(prompt).toContain('Resolve the listed errors in the rejected clause itself')
    expect(groundingPatchTargets(draft, review)).toEqual([{ unitId: 'content:2', sourceText: 'Arin received $1,900 (E-001).' }])
    expect(prompt).not.toContain('"unitId":"content:1"')
  })
  it('keeps semantic rejection feedback when the error list has no unit entry', () => {
    const changed: GroundingReview = { ...review, errors: [], findings: review.findings.map(f => f.unitId === 'content:2' ? { ...f, status: 'unsupported', explanation: 'The source supplies a different recipient.' } : f) }
    expect(groundingPatchInstructions(draft, changed)).toContain('The source supplies a different recipient.')
  })
  it.each([false, true])('preserves an accepted burden reference through a bounded repair; append-only=%s', async appendOnly => {
    const burden = 'Members of the Jury Panel, the Crown bears the burden on every element of the proposed fraud over $1,500 count and must prove each beyond a reasonable doubt.'
    const bad = 'The report records a payment of $1,900 (E-001).'
    const good = 'The report records a payment of $1,800 (E-001).'
    const replacement = appendOnly ? `${bad} The connection remains unresolved.` : good
    const prompts: string[] = []
    let authors = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', model: 'fictional', apiKey: 'fixture', maxRetries: 1, timeoutMs: 1000 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)), prompt = body.messages[1].content as string
      prompts.push(prompt)
      const units = prompt.includes('Draft units to check:\n') ? JSON.parse(prompt.split('Draft units to check:\n')[1]) as Array<{ id: string; text: string }> : undefined
      const value = units ? { findings: Object.fromEntries(units.map(unit => [unit.id, { status: unit.text.includes('report records') ? 'supported' : 'analysis', supportTypes: unit.text === burden ? ['instruction'] : unit.text.includes('report records') ? ['source'] : ['analysis'], explanation: 'Scripted complete review; the deterministic amount check still applies.', citations: unit.text.includes('report records') ? [{ exhibitId: 'E-001', paragraph: 1 }] : [], recordCitations: [] }])) } : ++authors === 1 ? { title: 'Fictional opening', content: `${burden} ${bad}`, citations: ['E-001'], jurors: [] } : { repairs: [{ unitId: 'content:2', replacement }] }
      return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] })
    })
    const result = client.generateStage({ stage: 'crown_opening', packet: 'Fictional approved exercise.', previousTurns: '', groundingRequired: true, evidence: [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'The report records a payment of $1,800.' }], approvedIssueInstructions: [{ issueId: 'fictional-count', elements: [{ label: 'The value exceeds $1,500' }] }] })
    if (appendOnly) await expect(result).rejects.toMatchObject({ grounding: { status: 'failed' } })
    else {
      const accepted = await result
      expect(accepted.content).toBe(`${burden} ${good}`)
      expect(accepted.grounding?.status).toBe('passed')
      expect(accepted.grounding?.appliedRepairs).toEqual([{ unitId: 'content:2', before: bad, replacement: good }])
    }
    const repair = prompts.find(prompt => prompt.includes('OUTPUT CONTRACT FOR THIS REPAIR:'))!
    expect(repair).toContain('"unitId":"content:2","sourceText":')
    expect(repair).toContain('"errors":["content:2:')
    expect(repair.slice(repair.indexOf('OUTPUT CONTRACT FOR THIS REPAIR:'))).not.toContain('"unitId":"content:1"')
    expect(prompts.at(-1)).toContain(appendOnly ? 'The connection remains unresolved.' : good)
    expect(authors).toBe(2)
    expect(prompts.length).toBeLessThanOrEqual(6)
  })
})
