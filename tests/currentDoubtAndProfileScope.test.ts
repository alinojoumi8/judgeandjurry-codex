import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'

const doubt = JSON.parse(readFileSync('docs/qa/jury/v138-full-control-current-permitted-doubt-positive-capture.json', 'utf8'))
const trait = JSON.parse(readFileSync('docs/qa/jury/v138-full-control-v107-current-profile-positive-capture.json', 'utf8'))
function check(c: any, q = structuredClone(c.request), text = c.draft.content, status = 'unsupported', withProfile = true) {
  const actor = q.courtroomActor
  const profile = q.jurorProfiles.find((p: any) => p.juror === actor.id)
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, explanation: 'Captured current assessment rejection.', citations: [] }] }),
    [{ id: 'content:1', text }], q.evidence, q.groundingContext,
    { actorId: actor.id, assessments: q.courtroomAssessments, profile: withProfile ? profile : undefined },
    { packet: q.packet, events: q.courtroomEvents, actorRoles: actor.roles, partyRoles: q.approvedPartyRoles, actor, stage: q.stage }).status
}

describe('current negative assessment is not an exhibit inventory', () => {
  it('preserves the explicit negative correction while still withholding the failed whole ballot', () => {
    const c = JSON.parse(readFileSync('docs/qa/jury/v138-full-control-v137-negative-proof-correction-capture.json', 'utf8'))
    const q = c.request
    const review = parseGroundingReview(JSON.stringify({ findings: c.checkerResult.review.findings }), [...groundingUnits(c.draft), ...ballotConsistencyUnits(c.draft)], q.evidence, q.groundingContext,
      { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments },
      { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage })
    expect(review.findings.find(f => f.unitId === 'content:1')?.status).toBe('analysis')
    expect(review.status).toBe('failed')
    expect(review.findings.find(f => f.unitId === 'ballot-consistency-0:1')?.status).toBe('contradicted')
  })
  it.each(['unsupported', 'contradicted'])('preserves captured current doubt despite checker %s', status => expect(check(doubt, undefined, undefined, status)).toBe('passed'))
  it('permits current doubt with multiple permitted accounts too', () => {
    const q = structuredClone(doubt.request); q.evidence.push({ ...q.evidence[0], id: 'second-source', exhibitId: 'E-002' })
    q.groundingContext += '\nE-002: limited; permitted purposes: Accurately attribute Mira\'s disputed account; not proof of contents or guilt.'
    expect(check(doubt, q)).toBe('passed')
  })
  it('requires an actual supplied account', () => expect(check(doubt, { ...doubt.request, evidence: [] })).toBe('failed'))
  it('requires actual permitted use', () => expect(check(doubt, { ...doubt.request, groundingContext: 'E-001: excluded; no use permitted.' })).toBe('failed'))
  it.each(['witness_answer', 'crown_opening'])('does not replace checker judgment in %s', stage => expect(check(doubt, { ...doubt.request, stage })).toBe('failed'))
  it('requires actual juror role', () => expect(check(doubt, { ...doubt.request, courtroomActor: { id: 'w1', roles: ['witness'] } })).toBe('failed'))
  it.each(['My current assessment of two permitted accounts leaves reasonable doubt.', 'My current assessment of the permitted accounts leaves reasonable doubt because Rowan concealed cash.', 'My earlier assessment of the permitted accounts leaves reasonable doubt.'])('does not clear a new inventory, fact or past-position premise: %s', text => expect(check(doubt, undefined, text)).toBe('failed'))
})

describe('actual own assessment traits may inform a present assessment', () => {
  it.each(['unsupported', 'contradicted'])('preserves captured high sensitivity despite checker %s', status => expect(check(trait, undefined, undefined, status)).toBe('passed'))
  it('preserves actual low sensitivity without changing the burden', () => {
    const q = structuredClone(trait.request); q.jurorProfiles[0].burdenSensitivity = 10
    expect(check(trait, q, 'My low burden sensitivity informs my current assessment.')).toBe('passed')
  })
  it('preserves actual high skepticism', () => {
    const q = structuredClone(trait.request); q.jurorProfiles[0].skepticismLevel = 90
    expect(check(trait, q, 'My high skepticism informs my current assessment.')).toBe('passed')
  })
  it('does not invent an unsupplied profile', () => expect(check(trait, undefined, undefined, 'unsupported', false)).toBe('failed'))
  it('does not use a peer profile', () => {
    const q = structuredClone(trait.request); q.jurorProfiles[0].juror = 'juror-99'
    expect(check(trait, q)).toBe('failed')
  })
  it('does not classify an intermediate trait as high', () => {
    const q = structuredClone(trait.request); q.jurorProfiles[0].burdenSensitivity = 50
    expect(check(trait, q)).toBe('failed')
  })
  it('rejects a contradicted profile even when checker accepts', () => {
    const q = structuredClone(trait.request); q.jurorProfiles[0].burdenSensitivity = 10
    expect(check(trait, q, undefined, 'analysis')).toBe('failed')
  })
  it('requires a current juror task', () => expect(check(trait, { ...trait.request, stage: 'witness_answer' })).toBe('failed'))
  it.each(['My high burden sensitivity proves receipt.', 'My high burden sensitivity informs my current assessment because Rowan concealed cash.', 'My high burden sensitivity informed my earlier guilty vote.'])('does not clear proof, factual or historical additions: %s', text => expect(check(trait, undefined, text)).toBe('failed'))
})
