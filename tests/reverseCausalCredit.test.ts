import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, ballotConsistencyUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v173-captured-reverse-causal-credit.json', 'utf8'))
function check(result = capture.result, whole = false, c = capture) {
  const q = c.request, units = whole ? ballotConsistencyUnits(result) : groundingUnits(result)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Current source assessment.', citations: [], recordCitations: [] })) }), units, q.evidence, q.groundingContext,
    { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments, profile: q.jurorProfiles[0] },
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}
function draft(text: string, field = 'rationale') {
  const result = structuredClone(capture.result)
  result.jurors[0].rationale = 'I credit the permitted Mira account after weighing its direct description of the listed condition.'
  result.jurors[0].mindChangedBecause = 'This is my initial assessment.'
  if (field === 'title' || field === 'content') result[field] = text + (field === 'content' ? ' I find the condition proved beyond a reasonable doubt.' : '')
  else result.jurors[0][field] = text
  return result
}
describe('causal account credit keeps the actual whole-ballot proof context', () => {
  it('withholds the accepted fresh first draft in individual fields and the whole ballot', () => {
    expect(check()).toBe('failed')
    expect(check(capture.result, true)).toBe('failed')
  })
  it('replays the actual accepted checker response without granting its false acceptance', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async () => Response.json({ choices: [{ message: { content: capture.checkerContent } }] }))
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
  })
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('checks causal credit independently in %s', field => {
    const result = draft('I credit Mira because no incompatible timing is supplied.', field)
    expect(check(result)).toBe('failed')
    expect(check(result, true)).toBe('failed')
  })
  it.each([
    'I credit E-001 because no incompatible timing is supplied.',
    'I credit Mira since the timing remains unspecified.',
    'No supplied timing makes the accounts incompatible, so I credit Mira.',
    'Timing is unspecified, therefore I accept E-001.',
    "My position is stable because I credit Mira's direct account and no incompatible timing is supplied.",
  ])('checks both causal orders under current Crown proof: %s', text => {
    expect(check(draft(text))).toBe('failed')
    expect(check(draft(text), true)).toBe('failed')
  })
  it.each([
    'No incompatible timing is supplied.',
    'No incompatible timing is supplied. I credit Mira because the actual account directly describes the listed condition.',
    'I credit Mira because the actual account directly describes the listed condition, while the supplied relative timing remains unknown.',
    'I do not credit Mira merely because no incompatible timing is supplied.',
    'Should I credit Mira because no incompatible timing is supplied?',
    'It is incorrect to conclude I credit Mira because no incompatible timing is supplied.',
  ])('preserves comparison, independent assessment, negation, inquiry and correction: %s', text => {
    expect(check(draft(text))).toBe('passed')
  })
  it('keeps references bound to actual renamed sources', () => {
    const c = JSON.parse(JSON.stringify(capture).replaceAll('Mira', 'Nira').replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732'))
    expect(check(c.result, false, c)).toBe('failed')
  })
  it('checks the structured Crown ballot even when its prose omits the burden phrase', () => {
    const result = draft('I credit Mira because no incompatible timing is supplied.')
    result.content = 'I vote guilty, crediting the permitted Mira account.'
    expect(check(result, true)).toBe('failed')
  })
})
