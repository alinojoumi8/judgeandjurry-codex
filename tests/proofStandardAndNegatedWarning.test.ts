import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v199-captured-proof-standard-shortcut.json', 'utf8'))
function check(result: any, whole = false, warningOnly = false) {
  const q = capture.request
  const units = (whole ? ballotConsistencyUnits(result) : groundingUnits(result)).filter(unit => !warningOnly || unit.id.startsWith('juror-warning-'))
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Current fictional assessment.', citations: [], recordCitations: [] })) }), units, q.evidence, q.groundingContext,
    { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments, profile: q.jurorProfiles[0] },
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}
function draft(text: string, field = 'rationale', leaning = 'crown') {
  const result = structuredClone(capture.accepted)
  delete result.grounding
  result.content = leaning === 'crown' ? 'I credit Mira’s permitted account of the listed handover and find the condition proved beyond a reasonable doubt (E-001).' : 'I retain reasonable doubt about the listed condition.'
  result.jurors[0].rationale = 'Mira describes the required handover; I credit the permitted disputed account.'
  result.jurors[0].mindChangedBecause = 'This is my initial assessment.'
  result.jurors[0].leaning = leaning
  result.jurors[0].consistencyWarnings = []
  if (field === 'title' || field === 'content') result[field] = text
  else if (field === 'warning') result.jurors[0].consistencyWarnings = [text]
  else result.jurors[0][field] = text
  return result
}

describe('proof sufficiency cannot follow from absent contrary evidence', () => {
  it('withholds the actual accepted fields', () => expect(check(capture.accepted)).toBe('failed'))
  it('withholds the actual whole ballot', () => expect(check(capture.accepted, true)).toBe('failed'))
  it('withholds the captured checker false acceptance', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
      async () => Response.json({ choices: [{ message: { content: capture.checkerContent } }] }))
    expect((await client.reviewGrounding(capture.request, capture.accepted)).status).toBe('failed')
  })
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('checks the non-denial conclusion in %s', field => {
    const result = draft('Tavi does not deny receipt, so I find the Crown’s proof meets the required standard.', field)
    expect(check(result)).toBe('failed')
    expect(check(result, true)).toBe('failed')
  })
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('checks the fronted timing premise in %s', field => {
    const result = draft('With no incompatible timing supplied, I find the Crown’s proof sufficient.', field)
    expect(check(result)).toBe('failed')
    expect(check(result, true)).toBe('failed')
  })
  it.each([
    'Tavi does not deny receipt, so I find the Crown’s proof satisfies the supplied standard.',
    'Tavi does not deny receipt, so I find the proof sufficient.',
    'With no incompatible timing supplied, I conclude the Crown’s proof is sufficient.',
    'With no supplied timing, I find the Crown’s proof adequate.',
  ])('recognizes the same proof predicate: %s', text => {
    expect(check(draft(text))).toBe('failed')
    expect(check(draft(text), true)).toBe('failed')
  })
  it.each([
    { text: 'I find the Crown’s proof meets the required standard because I credit Mira’s permitted handover account.', leaning: 'crown' },
    { text: 'I find the Crown’s proof sufficient after crediting Mira’s direct account. Tavi’s non-observation does not deny receipt.', leaning: 'crown' },
    { text: 'Tavi does not deny receipt. I find the Crown’s proof sufficient because I credit Mira’s permitted handover account.', leaning: 'crown' },
    { text: 'No incompatible timing is supplied. I find the Crown’s proof sufficient because I credit Mira’s actual handover account.', leaning: 'crown' },
    { text: 'With no supplied timing, I doubt whether I find the Crown’s proof sufficient.', leaning: 'defence' },
    { text: 'With no supplied timing, I do not find the Crown’s proof sufficient.', leaning: 'defence' },
    { text: 'Would Tavi’s non-denial mean I find the Crown’s proof sufficient?', leaning: 'crown' },
    { text: 'It is incorrect to conclude I find the Crown’s proof sufficient because no supplied timing is available.', leaning: 'crown' },
    { text: 'Tavi does not deny receipt, so I find the Crown’s proof sufficient to formulate a question about timing.', leaning: 'crown' },
  ])('preserves independently justified proof or non-adoption: $text', ({ text, leaning }) => {
    expect(check(draft(text, 'rationale', leaning))).toBe('passed')
    expect(check(draft(text, 'rationale', leaning), true)).toBe('passed')
  })
})

describe('negated direct-contradiction warning', () => {
  it('preserves the actual warning without excusing the original metadata failure', () => {
    expect(check(capture.falseWarningRejection.result, false, true)).toBe('passed')
  })
  it.each([
    'E-002 narrates Rowan leaving with the token; its relative timing is unspecified, so I do not treat it as a direct contradiction.',
    'E-002 does not supply relative timing, so I do not regard the account as a direct contradiction.',
    'I do not treat these accounts as directly incompatible (E-001; E-002).',
  ])('preserves a bounded negative predicate: %s', text => expect(check(draft(text, 'warning'), false, true)).toBe('passed'))
  it.each([
    'E-002 narrates Rowan leaving with the token; I treat it as a direct contradiction.',
    'E-002 does not supply relative timing, so I do not treat it as a direct contradiction, but the accounts directly contradict.',
    'I do not treat these accounts as directly incompatible. However, the accounts directly contradict (E-001; E-002).',
  ])('still rejects affirmative or appended conflict: %s', text => expect(check(draft(text, 'warning'), false, true)).toBe('failed'))
})
