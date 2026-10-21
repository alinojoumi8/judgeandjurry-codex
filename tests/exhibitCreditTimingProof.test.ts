import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v165-captured-exhibit-id-timing-gap-proof.json', 'utf8'))

function check(c = capture, draft = c.result, whole = false) {
  const q = c.request, units = whole ? ballotConsistencyUnits(draft) : groundingUnits(draft)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id,
    status: 'analysis', explanation: 'Current source assessment.', citations: [], recordCitations: [] })) }),
  units, q.evidence, q.groundingContext,
  { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments, profile: q.jurorProfiles[0] },
  { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles,
    partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}

function ballot(text: string, leaning = 'crown') {
  const draft = structuredClone(capture.result)
  draft.content = text
  draft.jurors[0].rationale = text
  draft.jurors[0].leaning = leaning
  draft.jurors[0].mindChangedBecause = 'This is my initial assessment.'
  return draft
}

describe('exhibit references do not turn missing timing into proof-level credit', () => {
  it('withholds the actual accepted repair in fields and the whole ballot', () => {
    expect(check()).toBe('failed')
    expect(check(capture, capture.result, true)).toBe('failed')
  })
  it('replays the actual accepted final checker response', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
    async () => Response.json({ choices: [{ message: { content: capture.checkerContent } }] }))
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
  })
  it.each(['so', 'therefore', 'thus', 'hence', 'accordingly'])('rejects the actual exhibit-credit consequence with %s', marker => {
    const value = ballot(`E-002 supplies no timing that resolves E-001, ${marker} I credit E-001 beyond a reasonable doubt.`)
    expect(check(capture, value)).toBe('failed')
    expect(check(capture, value, true)).toBe('failed')
  })
  it.each(['Mira', 'E-001', 'that account', 'it'])('checks the actual source reference %s', reference => {
    expect(check(capture, ballot(`E-002 supplies no timing that resolves E-001, so I credit ${reference} beyond a reasonable doubt.`))).toBe('failed')
  })
  it.each(['credit', 'accept', 'believe'])('checks %s of a current exhibit', verb => {
    expect(check(capture, ballot(`Timing is unspecified, so I ${verb} E-001 beyond reasonable doubt.`))).toBe('failed')
  })
  it.each([
    'I credit E-001 beyond a reasonable doubt because E-002 supplies no timing that resolves E-001.',
    'I credit E-001 beyond reasonable doubt since E-002 provides no relative timing.',
  ])('checks the reversed dependency: %s', text => expect(check(capture, ballot(text))).toBe('failed'))
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('checks the criterion independently in %s', field => {
    const value = ballot('I credit the actual Mira handover account after weighing it and find the supplied condition proved beyond a reasonable doubt.')
    const text = 'E-002 supplies no timing that resolves E-001, so I credit E-001 beyond a reasonable doubt.'
    if (field === 'title' || field === 'content') value[field] = text
    else value.jurors[0][field] = text
    expect(check(capture, value)).toBe('failed')
    expect(check(capture, value, true)).toBe('failed')
  })
  it('binds renamed actual exhibit IDs and speakers', () => {
    const c = JSON.parse(JSON.stringify(capture).replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732')
      .replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Savi'))
    expect(check(c)).toBe('failed')
  })
  it.each([
    'Timing is unspecified, so the Crown proved receipt beyond a reasonable doubt.',
    'E-002 supplies no resolving timing, so I find the condition proved beyond a reasonable doubt.',
    'I find the condition proved beyond a reasonable doubt because E-002 provides no relative timing.',
    'The Crown proved receipt beyond a reasonable doubt because E-002 provides no relative timing.',
    'E-002 supplies no resolving timing, so I find the condition proved beyond reasonable doubt.',
  ])('checks a proof finding rather than account credit: %s', text => {
    expect(check(capture, ballot(text))).toBe('failed')
    expect(check(capture, ballot(text), true)).toBe('failed')
  })
  it.each([
    'E-002 supplies no timing that resolves E-001.',
    'E-002 supplies no timing that resolves E-001. I credit E-001 because its actual account directly describes the supplied condition.',
    'I credit E-001 beyond a reasonable doubt because its actual account directly describes the supplied condition, while E-002 supplies no timing that resolves E-001.',
    'E-002 supplies no timing that resolves E-001, but the actual E-001 account directly describes the supplied condition, so I credit E-001 beyond a reasonable doubt.',
    'Timing is unspecified, so I do not credit E-001 beyond reasonable doubt.',
    'Their timing is unspecified; should I therefore credit E-001 beyond reasonable doubt?',
    'It is incorrect to conclude E-002 supplies no resolving timing, so I credit E-001 beyond reasonable doubt.',
    'E-002 supplies no resolving timing, but the actual E-001 account directly describes the supplied condition, so the Crown proved receipt beyond a reasonable doubt.',
    'Timing is unspecified, so it is incorrect to conclude the Crown proved receipt beyond a reasonable doubt.',
  ])('preserves bounded comparison, independent credit, doubt, inquiry or correction: %s', text => {
    expect(check(capture, ballot(text, text.includes('do not credit') ? 'defence' : 'crown'))).toBe('passed')
  })
})
