import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { EvidenceItem } from '../server/types'
const source = 'Tavi states: I saw Fictional Ellis standing at the desk. Fictional Morgan left with the blue token still in their hand. I did not see a handover.'
const check = (text: string) => parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [{ exhibitId: 'E-002', paragraph: 1 }] }] }), [{ id: 'content:1', text }], [{ exhibitId: 'E-002', text: source }] as EvidenceItem[])
describe('non-observation and explicitly denied non-occurrence', () => {
  it('does not turn non-observation into a direct handover negation', () => {
    expect(check("Tavi's account directly negates the handover the Crown must prove.").status).toBe('failed')
    expect(check("Tavi's account directly denies a handover.").status).toBe('failed')
    expect(check("Tavi's account does not directly negate a handover.").status).toBe('passed')
    expect(check("Tavi's account raises doubt about the handover.").status).toBe('passed')
    expect(check('If that account directly negates the handover, it matters to assessment.').status).toBe('passed')
  })
  it('preserves the captured distinction', () => expect(check('That statement records what Tavi states they observed, not that no handover occurred.').status).toBe('passed'))
  it('preserves a negated inference', () => expect(check('This does not mean no handover occurred.').status).toBe('passed'))
  it('rejects an unsupported non-occurrence', () => expect(check('No handover occurred.').status).toBe('failed'))
  it('rejects a later unsupported assertion after a correct denial', () => expect(check('This does not mean no handover occurred; no handover occurred.').status).toBe('failed'))
  it('preserves the seen qualifier', () => expect(check('Tavi states no handover was seen.').status).toBe('passed'))
  it.each([
    'Tavi states Morgan left with the token still in hand, and Tavi saw no handover.',
    'Tavi observed no handover.',
    'Tavi describes seeing no handover.',
  ])('preserves an active observation qualifier: %s', text => expect(check(text).status).toBe('passed'))
  it.each([
    'Tavi states Morgan left with the token still in hand and saw no handover.',
    'Tavi saw no handover; no handover occurred.',
    'Tavi saw no handover, establishing that no handover occurred.',
    'E-002 attributes the absence of a handover to Tavi.',
  ])('rejects a stronger mixed or absence assertion: %s', text => expect(check(text).status).toBe('failed'))
})
