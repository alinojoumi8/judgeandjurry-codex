import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const c = JSON.parse(readFileSync('docs/qa/jury/v142-neutral-personal-observation-inquiry-capture.json', 'utf8'))
function check(q = structuredClone(c.request), text = c.draft.content, status = 'unsupported', citations: any[] = []) {
  const units = groundingUnits({ title: '', content: text, citations: [], jurors: [] })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'The prior mention to the examiner is not supplied.', citations })) }), units,
    q.evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage })
}

describe('neutral personal-observation request bound to the approved account', () => {
  it('requests same-draft locator repair rather than inventing prior oral testimony', () => {
    const r = check()
    expect(r.status).toBe('failed')
    expect(r.sourceLocatorValidationUnitIds).toEqual(['content:1'])
    expect(r.findings[0].citations).toEqual([])
  })
  it('accepts the exact named account after the checker selects its actual paragraph', () => expect(check(undefined, undefined, 'unsupported', [{ exhibitId: 'E-001', paragraph: 1 }]).status).toBe('passed'))
  it('preserves analysis for the complete bound neutral request', () => expect(check(undefined, undefined, 'analysis').status).toBe('passed'))
  it('binds renamed speakers, people and sources to the actual input', () => {
    const rename = (s: string) => s.replaceAll('Mira', 'Nia').replaceAll('Rowan', 'Avery').replaceAll('Ellis', 'Parker').replaceAll('E-001', 'E-731')
    expect(check(JSON.parse(rename(JSON.stringify(c.request))), rename(c.draft.content), 'unsupported', [{ exhibitId: 'E-731', paragraph: 1 }]).status).toBe('passed')
  })
  it.each(['missing', 'wrong-speaker', 'wrong-object', 'same-person', 'conditional', 'excluded', 'unauthorized-passage', 'wrong-stage', 'missing-plan'])('does not clear %s under an analysis label', kind => {
    const q = structuredClone(c.request); let text = c.draft.content
    if (kind === 'missing') q.evidence = []
    if (kind === 'wrong-speaker') text = text.replace('Mira', 'Tavi')
    if (kind === 'wrong-object') text = text.replace('sealed envelope', 'stolen cash')
    if (kind === 'same-person') q.evidence[0].text = q.evidence[0].text.replaceAll('Ellis', 'Rowan')
    if (kind === 'conditional') q.evidence[0].text = q.evidence[0].text.replace('I saw', 'If I saw')
    if (kind === 'excluded') q.groundingContext = q.groundingContext.replace('E-001: limited;', 'E-001: excluded;')
    if (kind === 'unauthorized-passage') q.evidence[0].authorizedPassages = [{ paragraph: 1, text: 'Mira states:', startOffset: 0, endOffset: 12 }]
    if (kind === 'wrong-stage') q.stage = 'defence_rebuttal'
    if (kind === 'missing-plan') q.packet = q.packet.split('\nApproved evidence plan:')[0]
    expect(check(q, text, 'analysis').status).toBe('failed')
  })
  it('retains a supplied invalid paragraph as a validation failure', () => expect(check(undefined, undefined, 'analysis', [{ exhibitId: 'E-001', paragraph: 999 }]).status).toBe('failed'))
  it('does not clear an appended cash allegation', () => expect(check(undefined, c.draft.content + ' Ellis knowingly received cash.').status).toBe('failed'))
  it('rechecks the same draft once and requires the returned supporting paragraph', async () => {
    const bodies: string[] = [], draft = { title: '', content: c.draft.content, citations: ['E-001'], jurors: [] }
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional-key', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 2 }, undefined, async (_url, init) => {
      bodies.push(String(init?.body))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: groundingUnits(draft).map(unit => ({ unitId: unit.id, status: bodies.length > 1 ? 'analysis' : 'unsupported', explanation: bodies.length > 1 ? 'The selected paragraph supplies the approved account.' : 'No prior mention supplied.', citations: bodies.length > 1 ? [{ exhibitId: 'E-001', paragraph: 1 }] : [] })) }) } }] })
    })
    expect((await client.reviewGrounding(c.request, draft)).status).toBe('passed')
    expect(bodies).toHaveLength(2)
    expect(JSON.parse(bodies[1]).messages[1].content).toContain('Re-check the SAME draft units')
  })
})
