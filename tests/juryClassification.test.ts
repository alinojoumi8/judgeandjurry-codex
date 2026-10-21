import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { EvidenceItem } from '../server/types'

const evidence = [{ exhibitId: 'E-001', text: 'Mira states: I saw Rowan hand a blue token to Ellis at the desk.' }] as EvidenceItem[]
const context = 'E-001: admitted; permitted purposes: Assess the fictional condition using the attributed disputed account.\nE-001: unclassified; unknown;'
const check = (text: string, approvedContext = context) => parseGroundingReview(
  JSON.stringify({ findings: [{ unitId: 'juror-0:1', status: 'analysis', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }),
  [{ id: 'juror-0:1', text }], evidence, approvedContext,
)

describe('source classification versus missing classification', () => {
  it.each([
    'On this contradicted, non-primary record, the Crown has not met the burden.',
    'E-001 is a non-primary source.',
    'These are non-primary accounts.',
    'E-001 and E-002 are competing attributed accounts, not primary proof.',
    'As competing attributed accounts with no primary corroboration, the Crown has not established receipt.',
    'With no primary source and no corroboration, the Crown cannot meet beyond-reasonable-doubt on this condition.',
    'There are no primary documents in the supplied record.',
    'No primary record is supplied.',
    'No primary or authentication record is supplied.',
    'Without primary records, I retain doubt.',
    'With no primary documentary support and both classified as attributed disputed accounts, the Crown cannot meet the beyond-reasonable-doubt standard on the blue-token receipt condition.',
    'E-001 supplies no primary documentary evidence.',
    'These accounts are not primary documentary proof.',
    'No primary documentary corroboration is supplied.',
    'No verified primary documentary support is supplied; no primary documentary support exists.',
    'As a juror focused on documentary proof, I find no documentary evidence here.',
    'These attributed accounts are not documentary proof.',
    'E-001 is a non-documentary source.',
    'There are no documentary sources in this supplied record.',
    'No verified documentary evidence is supplied; no documentary evidence exists.',
  ])('rejects invented classification even in an analysis unit: %s', text => {
    expect(check(text).status).toBe('failed')
  })
  it.each([
    'No source is classified as a primary document in the supplied record.',
    'Primary record classification is unknown.',
    'No verified primary record is supplied; classification remains unknown.',
    'Primary source status is unknown; this does not establish that the sources are non-primary.',
    'The disputed account does not convince me of receipt beyond reasonable doubt.',
    'No corroboration is supplied; I assess this disputed account as insufficient on this record.',
    'If these were non-primary sources, their classification would need to be established.',
    'No verified primary documentary support is supplied; primary status remains unknown.',
    'No source is classified as primary documentary evidence.',
    'It is incorrect to say no primary documentary support exists merely because classification is unknown.',
    'No source is classified as documentary evidence.',
    'No verified documentary support is supplied; documentary status remains unknown.',
    'It is incorrect to say no documentary evidence exists merely because classification is unknown.',
  ])('preserves uncertainty and individual proof assessment: %s', text => {
    expect(check(text).status).toBe('passed')
  })
  it('preserves an expressly supplied non-primary classification', () => {
    expect(check('E-001 is a non-primary source.', 'E-001: admitted; non-primary summary; classification verified.').status).toBe('passed')
  })
})
