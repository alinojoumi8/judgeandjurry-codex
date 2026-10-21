import { reviewWithIndependentScopeCheck, fixtureCheckerWithIndependentFollowup } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const captures = ['negated-timing-comparison', 'negated-nonoccurrence-proof', 'initial-current-stability']
  .map(name => JSON.parse(readFileSync(`docs/qa/jury/v163-captured-${name}.json`, 'utf8')))

function check(c: any, draft = c.result, checker = c.checkerContent, q: StageRequest = c.request) {
  const units = [...groundingUnits(draft), ...ballotConsistencyUnits(draft)]
  return reviewWithIndependentScopeCheck('analysis', checker, units, q.evidence, q.groundingContext,
    { actorId: q.courtroomActor!.id, assessments: q.courtroomAssessments ?? [], profile: q.jurorProfiles?.[0] },
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles,
      partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound })
}

function variant(text: string) {
  const c = structuredClone(captures[1])
  c.result.content = 'I assess the actual disputed accounts under the supplied burden.'
  c.result.jurors[0].rationale = text
  c.result.jurors[0].mindChangedBecause = 'This is my initial assessment.'
  const units = [...groundingUnits(c.result), ...ballotConsistencyUnits(c.result)]
  c.checkerContent = JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis',
    explanation: 'Current bounded source comparison.', citations: [{ exhibitId: 'E-001', paragraph: 1 }, { exhibitId: 'E-002', paragraph: 1 }], recordCitations: [] })) })
  // Whole-ballot findings are independent semantic checks and carry no source citations.
  const review = JSON.parse(c.checkerContent)
  for (const finding of review.findings) if (finding.unitId.startsWith('ballot-consistency-')) finding.citations = []
  c.checkerContent = JSON.stringify(review)
  return c
}

describe('negated comparison and proof propositions preserve their scope', () => {
  it.each(captures)('requires a fresh checker judgment for a rejected captured draft: $id', async c => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture', timeoutMs: 2000, maxRetries: 1 }, undefined,
    fixtureCheckerWithIndependentFollowup('analysis', c.checkerContent))
    expect((await client.reviewGrounding(c.request, c.result)).status).toBe('passed')
  })

  it.each([
    "Tavi's non-observation and separate narrated departure do not negate it without supplied incompatible timing (E-002).",
    "Tavi's non-observation does not negate receipt without recorded incompatible timing (E-002).",
    'Tavi states, "I did not see a handover"; I treat that as non-observation, not proof that no handover occurred (E-002).',
    'Tavi states, "I did not see a handover"; that is not evidence that no handover occurred (E-002).',
  ])('accepts the bounded comparison: %s', text => expect(check(variant(text)).status).toBe('passed'))

  it.each([
    'The accounts have incompatible timing (E-001; E-002).',
    'Tavi supplies incompatible timing (E-002).',
    'Tavi proves that no handover occurred (E-002).',
    'Tavi states no handover occurred (E-002).',
    'It is not proof that no handover occurred, but no handover occurred (E-002).',
    'Without supplied incompatible timing, the accounts are incompatible (E-001; E-002).',
    'Their timing is unspecified, so I credit Mira beyond reasonable doubt (E-001; E-002).',
  ])('still rejects an adopted unsupported proposition: %s', text => expect(check(variant(text)).status).toBe('failed'))

  it('does not infer an earlier vote from a present initial assessment', () => expect(check(captures[2]).status).toBe('passed'))
  it('does not clear a real prior-vote claim', () => {
    const c = structuredClone(captures[2])
    c.result.jurors[0].mindChangedBecause += ' I voted guilty earlier.'
    expect(check(c).status).toBe('failed')
  })
  it('does not clear a final-ballot history claim', () => {
    const c = structuredClone(captures[2])
    c.request.packet = c.request.packet.replace('private initial ballot', 'private final ballot')
    c.request.ballotRound = 'final'
    expect(check(c).status).toBe('failed')
  })
  it('does not promote a separate source error in the stability reason', () => {
    const c = structuredClone(captures[2])
    const review = JSON.parse(c.checkerContent)
    review.findings.find((f: any) => f.unitId.startsWith('juror-change-')).explanation =
      'The claim that Tavi personally observed a departure is unsupported by E-002; empty history also does not establish prior stability.'
    c.result.jurors[0].mindChangedBecause = 'My position remains stable because Tavi personally observed the departure (E-002).'
    expect(check(c, c.result, JSON.stringify(review)).status).toBe('failed')
  })
  it('does not promote an independently rejected whole ballot', () => {
    const c = structuredClone(captures[2])
    const review = JSON.parse(c.checkerContent)
    const whole = review.findings.find((f: any) => f.unitId.startsWith('ballot-consistency-'))
    whole.status = 'unsupported'; whole.explanation = 'The current outcome and proof assessment conflict.'
    expect(check(c, c.result, JSON.stringify(review)).status).toBe('failed')
  })
})
