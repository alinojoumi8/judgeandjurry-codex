import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

describe('proof assessment repairs retain their source boundary', () => {
  it.each([false, true])('freshly checks a repair without accepting a new document-wide absence premise: absence=%s', async absence => {
    const original = 'The supplied figures do not establish the value over $1,600 beyond a reasonable doubt (E-001).'
    const replacement = absence ? 'No passage in E-001 ties a recorded figure to the alleged subject matter (E-001).'
      : original.replace('$1,600', '$1,500')
    let authors = 0
    const prompts: string[] = []
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', model: 'fictional', apiKey: 'fixture', maxRetries: 1, timeoutMs: 1000 }, undefined, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content as string
      prompts.push(prompt)
      const marker = 'Draft units to check:\n'
      const units = prompt.includes(marker) ? JSON.parse(prompt.split(marker)[1]) as Array<{ id: string }> : undefined
      const value = units ? { findings: Object.fromEntries(units.map(unit => [unit.id, { status: 'analysis', supportTypes: ['analysis', 'source'], explanation: 'Fixture classifies weight as analysis; deterministic scope checks remain active.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }])) }
        : ++authors === 1 ? { title: '', content: original, citations: ['E-001'], jurors: [] } : { repairs: [{ unitId: 'content:1', replacement }] }
      return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] })
    })
    const result = client.generateStage({ stage: 'defence_opening', packet: 'Fictional source exercise.', previousTurns: '', groundingRequired: true,
      evidence: [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'The report records a disputed $4,250 investment.' }],
      groundingContext: 'E-001: admitted; selected_extracts; only supplied passages.',
      approvedIssueInstructions: [{ issueId: 'fictional-count', elements: [{ label: 'The value exceeds $1,500' }] }] })
    if (absence) await expect(result).rejects.toMatchObject({ grounding: { status: 'failed', appliedRepairs: [{ replacement }], errors: expect.arrayContaining([expect.stringContaining('document-wide absence')]) } })
    else {
      const accepted = await result
      expect(accepted.content).toBe(replacement)
      expect(accepted.grounding?.status).toBe('passed')
    }
    expect(authors).toBe(2)
    expect(prompts.at(-1)).toContain(replacement)
    expect(prompts.find(prompt => prompt.includes('OUTPUT CONTRACT FOR THIS REPAIR:'))).toContain('Not established beyond the supplied standard does not mean no passage contains a relevant amount or connection')
  })
})
