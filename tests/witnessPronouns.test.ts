import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { EvidenceItem } from '../server/types'

const source = 'Mira states: I saw Fictional Morgan hand a blue token to Fictional Ellis at the desk.'
const check = (text: string, passage = source) => parseGroundingReview(
  JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }),
  [{ id: 'content:1', text }], [{ exhibitId: 'E-001', text: passage }] as EvidenceItem[],
).status
describe('witness pronouns must come from source', () => {
  it('rejects invented gender in an otherwise faithful first-person paraphrase', () => {
    expect(check('Mira states she saw Morgan hand a blue token to Ellis.')).toBe('failed')
    expect(check('Mira states he saw Morgan hand a blue token to Ellis.')).toBe('failed')
    expect(check('Her account describes the handover.')).toBe('failed')
    expect(check('His account describes the handover.')).toBe('failed')
  })
  it('preserves exact first-person or named attribution and explicit source pronouns', () => {
    expect(check('Mira states: "I saw Fictional Morgan hand a blue token to Fictional Ellis at the desk."')).toBe('passed')
    expect(check('Mira describes Morgan handing a blue token to Ellis at the desk.')).toBe('passed')
    expect(check('Mira states she saw Morgan hand a blue token to Ellis.', 'Mira states that she saw Morgan hand a blue token to Ellis.')).toBe('passed')
    expect(check('His account describes the handover.', 'Mira uses he/him pronouns. Mira states: I saw the handover.')).toBe('passed')
  })
})
