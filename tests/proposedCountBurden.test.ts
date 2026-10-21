import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const approved = [{ issueId: 'exercise', elements: [{ label: 'The value of the alleged fraud exceeds $5,000' }] }]
const text = 'Members of the Jury Panel, the Crown must prove every element of the proposed fraud over $5,000 count beyond a reasonable doubt.'
function check(candidate = text, labels = approved, events: GroundingRecordEvent[] = []) {
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': { status: 'analysis', supportTypes: ['instruction'], explanation: 'The burden applies to the approved exercise count.', citations: [], recordCitations: [] } } }), [{ id: 'content:1', text: candidate }], [], '', undefined, { packet: '', actorRoles: [], partyRoles: [], events, approvedIssueInstructions: labels, stage: 'crown_opening' })
}

describe('approved proposed-count burden statement', () => {
  it.each([text, text.replace('Members of the Jury Panel, ', ''), 'The Crown must establish each element of the proposed fraud exceeding $5,000 count beyond a reasonable doubt.'])('accepts the approved exercise requirement without inventing a source amount: %s', candidate => {
    const review = check(candidate)
    expect(review.status).toBe('passed')
    expect(review.findings[0].explanation).toContain('scenario setup')
    expect(review.findings[0].citations).toEqual([])
  })
  it.each([
    text.replace('$5,000', '$10,000'), text.replace('$5,000', 'USD $5,000'),
    text.replace('proposed ', ''), text.replace('must prove', 'has proved'),
    text.replace('must prove', 'must not prove'), text.replace('the Crown', 'the Defence'),
    `“${text}”`, `The report says ${text}`, `${text} Arin received $9,000.`,
  ])('does not excuse factual claims, quotations, a reversed burden or another threshold: %s', candidate => {
    expect(check(candidate).status).toBe('failed')
  })
  it.each([{ labels: [] }, { labels: [{ issueId: 'other', elements: [{ label: 'The value exceeds $10,000' }] }] }, { labels: [...approved, { ...approved[0], issueId: 'duplicate' }] }])('requires unique matching approval: %j', ({ labels }) => {
    expect(check(text, labels).status).toBe('failed')
  })
  it('uses the current delivered instruction instead of earlier setup', () => {
    const event: GroundingRecordEvent = { eventId: 'instruction', type: 'judicial_instruction', payload: { text: 'Current exercise rule.', issueInstructions: [{ elements: [{ label: 'The value exceeds $10,000' }] }] } }
    expect(check(text, approved, [event]).status).toBe('failed')
    event.payload.issueInstructions = [{ elements: [{ label: 'The value exceeds $5,000' }] }]
    expect(check(text, [], [event]).status).toBe('passed')
  })
  it('cannot substitute a source transaction for missing exercise approval', () => {
    const source = { ...supportedOpeningSource, exhibitId: 'E-001', text: 'The report records a $5,000 deposit.' }
    const review = parseGroundingReview(JSON.stringify({ findings: { 'content:1': { status: 'analysis', supportTypes: ['instruction', 'source'], explanation: 'Candidate requirement.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] } } }), [{ id: 'content:1', text }], [source], '', undefined, { packet: '', actorRoles: [], partyRoles: [], events: [], approvedIssueInstructions: [], stage: 'crown_opening' })
    expect(review.status).toBe('failed')
  })
})
