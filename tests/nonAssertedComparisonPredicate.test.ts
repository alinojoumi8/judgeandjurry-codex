import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const captures = ['without-supplying-timing', 'prevented-comparison'].map(name =>
  JSON.parse(readFileSync(`docs/qa/jury/v164-captured-${name}.json`, 'utf8')))

function variant(text: string) {
  const c = structuredClone(captures[0])
  c.result.content = 'I assess the supplied condition under the actual burden.'
  c.result.jurors[0].rationale = text
  c.result.jurors[0].mindChangedBecause = 'This is my initial assessment.'
  const units = [...groundingUnits(c.result), ...ballotConsistencyUnits(c.result)]
  c.checkerContent = JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis',
    explanation: 'Bounded present source comparison.', citations: unit.kind === 'ballot_consistency' ? [] :
      [{ exhibitId: 'E-001', paragraph: 1 }, { exhibitId: 'E-002', paragraph: 1 }], recordCitations: [] })) })
  return c
}

function check(c: any) {
  const q = c.request, units = [...groundingUnits(c.result), ...ballotConsistencyUnits(c.result)]
  return parseGroundingReview(c.checkerContent, units, q.evidence, q.groundingContext,
    { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments, profile: q.jurorProfiles[0] },
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles,
      partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}

describe('an absent or prevented comparison predicate is not an adopted conflict', () => {
  it.each(captures)('replays the actual first-author/checker pair: $id', async c => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
    async () => Response.json({ choices: [{ message: { content: c.checkerContent } }] }))
    expect((await client.reviewGrounding(c.request, c.result)).status).toBe('passed')
  })

  it.each([
    "Tavi's account does not negate receipt without supplying incompatible timing (E-002).",
    "Tavi's account does not negate receipt without providing incompatible timing (E-002).",
    "Tavi's account does not negate receipt without showing incompatible timing (E-002).",
    "Tavi's account does not negate receipt without establishing incompatible timing (E-002).",
    "Tavi's account does not negate receipt without any supplied incompatible timing (E-002).",
    'The unspecified timing prevents me from treating those accounts as necessarily incompatible (E-001; E-002).',
    'Unsupplied timing prevents me from calling the accounts incompatible (E-001; E-002).',
  ])('preserves the non-asserted predicate: %s', text => expect(check(variant(text))).toBe('passed'))

  it.each([
    'Without supplying incompatible timing, Tavi directly contradicts the handover (E-001; E-002).',
    'Timing prevents me from treating the accounts as incompatible, but they are incompatible (E-001; E-002).',
    'Timing prevents me from treating the accounts as incompatible and they are incompatible (E-001; E-002).',
    'Timing prevents me from treating the accounts as incompatible while the accounts directly contradict each other (E-001; E-002).',
    'The accounts are incompatible despite unspecified timing (E-001; E-002).',
    'Their timing is unspecified, so I credit Mira beyond reasonable doubt (E-001; E-002).',
    'Tavi supplies no incompatible timing; Tavi saw Rowan leaving with the token (E-002).',
  ])('still rejects the separate adopted assertion: %s', text => expect(check(variant(text))).toBe('failed'))

  it.each(captures)('binds renamed actual sources for $id', c => {
    const renamed = JSON.parse(JSON.stringify(c).replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Savi')
      .replaceAll('Rowan', 'Orin').replaceAll('Ellis', 'Evan').replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732'))
    expect(check(renamed)).toBe('passed')
  })

  it('preserves an independently failed whole ballot', () => {
    const c = structuredClone(captures[1]), review = JSON.parse(c.checkerContent)
    review.findings.find((f: any) => f.unitId.startsWith('ballot-consistency-')).status = 'unsupported'
    c.checkerContent = JSON.stringify(review)
    expect(check(c)).toBe('failed')
  })
})
