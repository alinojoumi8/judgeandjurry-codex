import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { EvidenceItem } from '../server/types'

const evidence = [{ exhibitId: 'E-001', text: 'Mira states: I saw Rowan hand a blue token to Ellis.' }, { exhibitId: 'E-002', text: 'Tavi states: Rowan left with the token in hand. I did not see a handover.' }] as EvidenceItem[]
const context = evidence.map(e => `${e.exhibitId}: admitted; permitted purposes: Assess the fictional condition using the attributed disputed account.`).join('\n')
const check = (text: string, approvedContext = context, history = false) => parseGroundingReview(
  JSON.stringify({ findings: [{ unitId: 'juror-0:1', status: 'analysis', citations: evidence.map(e => ({ exhibitId: e.exhibitId, paragraph: 1 })), recordCitations: history ? [{ eventId: 'peer' }] : [] }] }),
  [{ id: 'juror-0:1', text }], evidence, approvedContext, undefined,
  { packet: '', actorRoles: ['juror'], partyRoles: [], events: [{ eventId: 'peer', type: 'juror_deliberation_turn', actorId: 'juror-04', payload: { contribution: 'This is attribution-only material.' } }] },
)

describe('collective permission claims without sentence-local exhibit IDs', () => {
  it.each([
    'The direct conflict leaves receipt unproven beyond a reasonable doubt on attribution-only material.',
    'The instruction bars using these accounts as substantive proof.',
  ])('rejects an invented collective permission: %s', text => expect(check(text).status).toBe('failed'))
  it.each([
    'I assess the permitted disputed accounts as insufficient on this supplied record.',
    'If this were attribution-only material, that restriction would matter.',
  ])('preserves assessment and a counterfactual: %s', text => expect(check(text).status).toBe('passed'))
  it('preserves accurate reporting of a visible erroneous peer argument', () => expect(check('Juror-04 argued that this is attribution-only material.', context, true).status).toBe('passed'))
  it('preserves a genuinely attribution-only record', () => expect(check('Receipt remains unproven on attribution-only material.', evidence.map(e => `${e.exhibitId}: limited; permitted purposes: Accurately attribute the account; not proof of contents or guilt.`).join('\n')).status).toBe('passed'))
})

describe('account coverage is not the extent of personal observation', () => {
  const record = [{ exhibitId: 'E-001', text: 'Mira states: I saw Rowan hand the sealed envelope to Ellis. I do not know what it contained.' }] as EvidenceItem[]
  const review = (text: string, source = record) => parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }), [{ id: 'content:1', text }], source)
  it.each([
    'That is the full extent of my personal observation regarding the handover; my approved account does not address any further detail.',
    'That is the entire extent of her observation.',
  ])('rejects invented personal coverage: %s', text => expect(review(text).status).toBe('failed'))
  it.each([
    'That is the full extent of the observations recorded in my approved account.',
    'The full extent of my personal observations recorded in my approved account is the handover; it does not address further details.',
    'My approved account does not address further observations; I cannot add facts outside it.',
  ])('preserves the approved-account boundary: %s', text => expect(review(text).status).toBe('passed'))
  it('preserves an explicit source statement of personal coverage', () => expect(review('That is the full extent of my personal observation.', [{ ...record[0], text: 'Mira states: That is the full extent of my personal observation.' }]).status).toBe('passed'))
})
