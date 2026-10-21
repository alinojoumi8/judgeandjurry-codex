import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v176-captured-neither-nor.json', 'utf8'))
function check(text: string, field = 'content', explicitDenial = false) {
  const q = structuredClone(capture.request), draft = structuredClone(capture.draft)
  draft.title = 'Juror response'
  draft.content = draft.jurors[0].rationale = 'I retain reasonable doubt on this record.'
  draft.jurors[0].mindChangedBecause = 'This is my initial assessment.'
  if (field === 'content' || field === 'title') draft[field] = text
  else draft.jurors[0][field] = text
  if (explicitDenial) q.evidence.find((x: any) => x.exhibitId === 'E-002').text = 'Tavi states: No handover occurred.'
  const units = groundingUnits(draft)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id,
    status: 'analysis', explanation: 'Current assessment.', citations: [], recordCitations: [] })) }),
  units, q.evidence, q.groundingContext,
  { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments, profile: q.jurorProfiles[0] },
  { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles,
    partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}

describe('coordinated negative event comparisons', () => {
  it('accepts the actual source-faithful first draft with its actual passing checker response', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
    async () => Response.json({ choices: [{ message: { content: capture.checkerContent } }] }))
    expect((await client.reviewGrounding(capture.request, capture.draft)).status).toBe('passed')
  })
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('preserves both negated predicates in %s', field => {
    expect(check('Tavi non-observation neither denies receipt nor supplies incompatible timing.', field)).toBe('passed')
  })
  it.each([
    'Tavi account neither directly contradicts Mira nor provides incompatible timing.',
    'Tavi non-observation neither establishes receipt nor shows incompatible timing.',
    'Tavi account neither contradicts Mira nor establishes incompatible timing.',
  ])('preserves ordinary coordinated negatives: %s', text => expect(check(text)).toBe('passed'))
  it.each([
    'Tavi non-observation neither denies receipt nor supplies timing, but the accounts are incompatible.',
    'Tavi non-observation neither denies receipt nor supplies timing; the accounts directly contradict.',
    'Tavi non-observation does not deny receipt and supplies incompatible timing.',
    'Neither account is verified, but the accounts directly contradict on receipt.',
  ])('still rejects the separate affirmative comparison: %s', text => expect(check(text)).toBe('failed'))
  it('preserves actual opposing event accounts', () => {
    expect(check('The accounts directly contradict on receipt.', 'content', true)).toBe('passed')
  })
})
