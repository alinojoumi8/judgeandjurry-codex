import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'

const approved = [{ issueId: 'fictional-value', elements: [{ label: 'The value of the subject matter of the alleged fraud exceeds $1,500' }] }]
const text = 'If the Crown establishes one of these figures as the value of the alleged subject matter in the currency of the approved $1,500 element, it could support that element, but the transaction-specific connection remains unproved.'
function check(draft = text, issues = approved, events: GroundingRecordEvent[] = [], status = 'analysis') {
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': { status, supportTypes: ['analysis', 'instruction'], explanation: 'Conditional application of the supplied value element; no transaction amount or occurrence is asserted.', citations: [], recordCitations: [] } } }), [{ id: 'content:1', text: draft }], [], '', undefined, { packet: '', events, actorRoles: [], partyRoles: [], approvedIssueInstructions: issues })
}

describe('conditional references to a numeric approved element label', () => {
  it.each(['could', 'would', 'may', 'might'])('recognizes the %s conditional against the sole approved element', modal => {
    const review = check(text.replace('it could', `it ${modal}`))
    expect(review.errors).toEqual([])
    expect(review.findings[0].explanation).toContain('Approved exercise threshold:')
  })

  it.each([
    text.replace('$1,500', '$1,600'),
    text.replace('$1,500', 'USD $1,500'),
    text.replace('If the Crown establishes', 'The Crown establishes'),
    text.replace('it could support', 'it proves'),
    text.replace('approved $1,500 element', 'operative charge’s $1,500 element'),
    text.replace('alleged subject matter', 'subject matter of the actual criminal charge'),
    `The report states “${text}”`,
    `The report states ${text}`,
    `${text} Arin received $1,500.`,
    text.replace('these figures', 'these $1,500 figures'),
  ])('retains source and approval boundaries: %s', draft => {
    expect(check(draft).status).toBe('failed')
  })

  it('requires a unique current approval and preserves a controlling delivered instruction', () => {
    expect(check(text, []).status).toBe('failed')
    expect(check(text, [...approved, { ...approved[0], issueId: 'other' }]).status).toBe('failed')
    expect(check(text, [{ ...approved[0], elements: [...approved[0].elements, ...approved[0].elements] }]).status).toBe('failed')
    const delivered: GroundingRecordEvent = { eventId: 'current', type: 'judicial_instruction', payload: { text: 'Reviewed fictional exercise.', issueInstructions: approved } }
    expect(check(text, [], [delivered]).findings[0].recordCitations?.map(citation => citation.eventId)).toEqual(['current'])
    expect(check(text, approved, [{ ...delivered, payload: { ...delivered.payload, withheld: true } }]).status).toBe('failed')
    const later = { ...delivered, eventId: 'later', payload: { ...delivered.payload, issueInstructions: [{ ...approved[0], elements: [{ label: 'The value exceeds $1,600' }] }] } }
    expect(check(text, approved, [delivered, later]).status).toBe('failed')
    expect(check(text, approved, [], 'unsupported').status).toBe('failed')
  })
})
