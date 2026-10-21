import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v203-captured-coordinated-proof-and-relative-negation.json', 'utf8'))
function check(item: any, result = item.result, whole = false) {
  const q = item.request
  const units = whole ? ballotConsistencyUnits(result) : groundingUnits(result)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Injected labels for deterministic application regression, not live grading.', citations: [], recordCitations: [] })) }), units, q.evidence, q.groundingContext,
    { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments, profile: q.jurorProfiles[0] },
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}
function draft(text: string, field = 'content', leaning = 'crown') {
  const result = structuredClone(capture.independentAssessmentPositives[0].result)
  delete result.grounding
  result.content = leaning === 'crown' ? 'I credit Mira’s permitted receipt account and find the Crown’s burden met beyond a reasonable doubt (E-001).' : 'I retain reasonable doubt about the listed condition.'
  result.jurors[0].rationale = 'I assess the permitted attributed accounts under the supplied instruction.'
  result.jurors[0].mindChangedBecause = 'This is my initial assessment.'
  result.jurors[0].leaning = leaning
  if (field === 'title' || field === 'content') result[field] = text
  else result.jurors[0][field] = text
  return result
}
function client(content: string) {
  return new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
    async () => Response.json({ choices: [{ message: { content } }] }))
}

describe('explicit coordinated non-denial proof reasons', () => {
  for (const item of capture.acceptedFailures) {
    it(`withholds captured accepted fields: ${item.id}`, () => expect(check(item)).toBe('failed'))
    it(`withholds captured whole ballot: ${item.id}`, () => expect(check(item, item.result, true)).toBe('failed'))
    it(`withholds captured checker false acceptance: ${item.id}`, async () => {
      expect((await client(item.checker.content).reviewGrounding(item.request, item.result)).status).toBe('failed')
    })
  }
  it.each(capture.independentAssessmentPositives as { id: string; request: any; result: any }[])('preserves actual independent credit with bounded comparison: $id', item => {
    expect(check(item)).toBe('passed')
    expect(check(item, item.result, true)).toBe('passed')
  })
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('checks an explicit proof co-basis in %s', field => {
    const result = draft('I vote guilty because I credit Mira’s admitted handover account and Tavi’s account does not disprove it without supplied timing (E-001; E-002).', field)
    expect(check(capture.acceptedFailures[0], result)).toBe('failed')
    expect(check(capture.acceptedFailures[0], result, true)).toBe('failed')
  })
  it.each([
    'I vote guilty because I credit Mira and Tavi’s non-observation does not contradict it.',
    'I vote for the Crown because I credit Mira and Tavi’s account does not deny receipt.',
    'I vote guilty because Tavi’s account does not contradict Mira and I credit Mira.',
  ])('withholds equivalent coordinated proof reasons: %s', text => {
    const result = draft(text)
    expect(check(capture.acceptedFailures[0], result)).toBe('failed')
    expect(check(capture.acceptedFailures[0], result, true)).toBe('failed')
  })
  it.each([
    'I vote guilty because I credit Mira’s permitted handover account. Tavi’s non-observation does not deny receipt.',
    'Tavi’s account does not disprove it without supplied timing. I vote guilty because I credit Mira’s permitted handover account.',
    'Would I vote guilty because I credit Mira and Tavi’s account does not deny receipt?',
    'If I vote guilty because I credit Mira and Tavi’s account does not deny receipt, that would require a proper independent assessment.',
    'It is incorrect to vote guilty because I credit Mira and Tavi’s account does not deny receipt.',
  ])('preserves separate independent credit, questions and non-adoption: %s', text => {
    const result = draft(text, 'rationale')
    expect(check(capture.acceptedFailures[0], result)).toBe('passed')
    expect(check(capture.acceptedFailures[0], result, true)).toBe('passed')
  })
  it('does not depend on captured witness or exhibit names', () => {
    const item = JSON.parse(JSON.stringify(capture.acceptedFailures[0]).replaceAll('Mira', 'Nora').replaceAll('Tavi', 'Oren').replaceAll('E-001', 'X-101').replaceAll('E-002', 'X-202'))
    expect(check(item)).toBe('failed')
    expect(check(item, item.result, true)).toBe('failed')
  })
})

describe('negative treatment in a relative clause', () => {
  const item = capture.falseComparisonRejection
  it('preserves every field in the actual source-faithful original and its whole ballot', () => {
    expect(check(item)).toBe('passed')
    expect(check(item, item.result, true)).toBe('passed')
  })
  it('preserves the actual positive checker review without an unnecessary author repair', async () => {
    expect((await client(item.checker.content).reviewGrounding(item.request, item.result)).status).toBe('passed')
  })
  it.each([
    'which I do not treat as incompatible without supplied timing',
    'which I don’t regard as directly incompatible without supplied timing',
    'which I do not consider a direct contradiction without supplied timing',
  ])('keeps the bounded negative predicate: %s', negative => {
    const result = structuredClone(item.result)
    result.content = result.content.replace('which I do not treat as incompatible without supplied timing', negative)
    expect(check(item, result)).toBe('passed')
    expect(check(item, result, true)).toBe('passed')
  })
  it('retains an appended affirmative event-conflict claim', () => {
    const result = structuredClone(item.result)
    result.content += ' The accounts directly contradict.'
    expect(check(item, result)).toBe('failed')
  })
  it('retains an affirmative treatment of incompatible events without supplied opposition', () => {
    const result = structuredClone(item.result)
    result.content = result.content.replace('which I do not treat as', 'which I treat as')
    expect(check(item, result)).toBe('failed')
  })
  it('preserves the same relative negation with renamed witnesses and source IDs', () => {
    const renamed = JSON.parse(JSON.stringify(item).replaceAll('Mira', 'Nora').replaceAll('Tavi', 'Oren').replaceAll('E-001', 'X-101').replaceAll('E-002', 'X-202'))
    expect(check(renamed)).toBe('passed')
    expect(check(renamed, renamed.result, true)).toBe('passed')
  })
})
