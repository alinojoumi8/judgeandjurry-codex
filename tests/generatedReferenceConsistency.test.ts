import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { sourcePageReferenceErrors } from '../server/sourcePageReferences'
import { instructionElementDriftError } from '../server/instructionElementDrift'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const source = { ...supportedOpeningSource, exhibitId: 'E-006', type: 'pdf' as const, sourcePages: [1], text: 'The email records no cash returned.' }
const approved = [{ issueId: 'fictional', elements: [{ label: 'A dishonest act' }, { label: 'Economic prejudice caused by the act' }, { label: 'The value exceeds $5,000' }] }]
function review(text: string, status = 'supported', issues = approved) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, explanation: 'Review the source and the approved model independently.', citations: status === 'supported' ? [{ exhibitId: 'E-006', paragraph: 1 }] : [] }] }), [{ id: 'content:1', text }], [source], '', undefined, { packet: '', events: [], actorRoles: [], partyRoles: [], approvedIssueInstructions: issues })
}

describe('generated references and supplied element consistency', () => {
  it.each(['E-006 pp. 1-2', 'E-006, pp. 1–2', 'E-006 page 2', 'E-006 pages 1, 2', 'E-006 p. 0', 'E-006 pp. 2-1'])('rejects invented supplied-file page locators: %s', locator => {
    const result = review(`The email records no cash returned (${locator}).`)
    expect(result.status).toBe('failed')
    expect(result.findings[0].explanation).toContain('verified supplied PDF pages')
  })
  it('retains valid packet pagination without treating a printed folio as a packet page', () => {
    expect(review('The email records no cash returned (E-006, p. 1).').status).toBe('passed')
    expect(sourcePageReferenceErrors('The report records a payment (E-001, p. 41).', [{ ...source, exhibitId: 'E-001', sourcePages: [1, 2, 3] }])).toHaveLength(1)
  })
  it('requires real page metadata and preserves source and paragraph fallback', () => {
    expect(sourcePageReferenceErrors('The email records no cash returned (E-006, p. 1).', [{ ...source, sourcePages: undefined }])).toHaveLength(1)
    expect(sourcePageReferenceErrors('The email records no cash returned (E-006 paragraph 1).', [{ ...source, sourcePages: undefined }])).toEqual([])
    expect(sourcePageReferenceErrors('The email states “see E-999 p. 2” (E-006 paragraph 1).', [source])).toEqual([])
  })
  it('checks ranges and separate page groups without unchecked loop expansion', () => {
    expect(sourcePageReferenceErrors('E-006 pp. 1-99999999', [source])).toHaveLength(1)
    expect(sourcePageReferenceErrors('E-006 pp. 1, 3 and 5', [{ ...source, sourcePages: [1, 3, 5] }])).toEqual([])
    expect(sourcePageReferenceErrors('E-006 pp. 1-3', [{ ...source, sourcePages: [1, 3, 5] }])).toHaveLength(1)
  })
  it.each(['The Crown must prove reliance by the particular investor.', 'The Crown must still prove deception, reliance, and deprivation.'])('does not add a reliance requirement absent from the approved model: %s', text => {
    const result = review(text, 'analysis')
    expect(result.status).toBe('failed')
    expect(result.findings[0].explanation).toContain('controlling supplied issue elements')
  })
  it('permits a supplied reliance element and factual reliance arguments', () => {
    expect(review('The Crown must prove reliance by the particular investor.', 'analysis', [{ issueId: 'fictional', elements: [{ label: 'Investor reliance on the representation' }] }]).status).toBe('passed')
    expect(review('Whether the alleged reliance supports causation remains a matter of weight.', 'analysis').status).toBe('passed')
    expect(review('The Crown need not prove reliance by the particular investor.', 'analysis').status).toBe('passed')
  })
  it('does not borrow an old model when the latest instruction is unusable', () => {
    const approvedReliance = [{ issueId: 'old', elements: [{ label: 'Investor reliance' }] }]
    expect(instructionElementDriftError('The Crown must prove reliance.', approvedReliance, [{ eventId: 'withheld', type: 'judicial_instruction', payload: { withheld: true, text: 'No valid instruction' } }])).toContain('usable controlling')
  })
  it('uses a valid delivered instruction in preference to older approved labels', () => {
    const event = { eventId: 'delivered', type: 'judicial_instruction', payload: { text: 'Apply the supplied elements.', issueInstructions: [{ issueId: 'fictional', elements: [{ label: 'Investor reliance' }] }] } }
    expect(instructionElementDriftError('The Crown must prove investor reliance.', approved, [event])).toBeUndefined()
    const different = { ...event, payload: { ...event.payload, issueInstructions: approved } }
    expect(instructionElementDriftError('The Crown must prove investor reliance.', [{ issueId: 'old', elements: [{ label: 'Investor reliance' }] }], [different])).toContain('do not supply')
    expect(instructionElementDriftError('The Crown must prove investor reliance.', [{ issueId: 'negative', elements: [{ label: 'No investor reliance is required' }] }], [])).toContain('do not supply')
  })
})
