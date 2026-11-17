import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'

const approved = [{ issueId: 'fictional-value', elements: [{ label: 'The value of the subject matter of the alleged fraud exceeds $1,750' }] }]
const text = 'Members of the Jury Panel, the Crown must prove every element of the proposed fraud count against Arin beyond a reasonable doubt: a prohibited dishonest act; resulting deprivation; knowledge of the facts constituting that act; knowledge that deprivation could result; and a subject-matter value exceeding $1,750.'
const instruction: GroundingRecordEvent = { eventId: 'current', type: 'judicial_instruction', payload: { text: 'Reviewed fictional exercise.', issueInstructions: approved } }
function check(draft = text, issues = approved, events: GroundingRecordEvent[] = [], status = 'analysis') {
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': { status, supportTypes: ['instruction'], explanation: 'A restatement of the supplied exercise burden, not a payment or proved fact.', citations: [], recordCitations: [] } } }), [{ id: 'content:1', text: draft }], [], '', undefined, { packet: '', events, actorRoles: [], partyRoles: [], approvedIssueInstructions: issues })
}

describe('approved subject-matter value in a proof list', () => {
  it.each(['a subject-matter value', 'the subject-matter value', 'subject-matter value', 'a subject matter value', 'the subject matter', 'a value'])('recognizes the locally scoped %s', label => {
    expect(check(text.replace('a subject-matter value', label)).errors).toEqual([])
  })
  it.each([
    text.replace('$1,750', '$1,900'),
    text.replace('$1,750', 'USD $1,750'),
    text.replace('Crown must prove', 'Defence must disprove'),
    text.replace('Crown must prove', 'Crown must not prove'),
    text.replace('proposed fraud count', 'operative charged count'),
    `The report states “${text}” (E-001).`,
    `The report states ${text}`,
    text.replace('and a subject-matter value', 'and Arin received a subject-matter value'),
    `${text} Arin received $1,750.`,
  ])('does not exempt a factual, unapproved or reversed requirement: %s', draft => {
    expect(check(draft).status).toBe('failed')
  })
  it('requires a unique current approved amount and respects actual delivered instruction provenance', () => {
    expect(check(text, []).status).toBe('failed')
    expect(check(text, [...approved, { ...approved[0], issueId: 'other' }]).status).toBe('failed')
    expect(check(text, [{ ...approved[0], elements: [...approved[0].elements, ...approved[0].elements] }]).status).toBe('failed')
    const delivered = check(text, [], [instruction])
    expect(delivered.errors).toEqual([])
    expect(delivered.findings[0].recordCitations?.map(citation => citation.eventId)).toEqual(['current'])
    expect(check(text, approved, [{ ...instruction, payload: { ...instruction.payload, withheld: true } }]).status).toBe('failed')
    const later = { ...instruction, eventId: 'later', payload: { ...instruction.payload, issueInstructions: [{ ...approved[0], elements: [{ label: 'The value exceeds $1,900' }] }] } }
    expect(check(text, approved, [instruction, later]).status).toBe('failed')
    expect(check(text, approved, [], 'unsupported').status).toBe('failed')
  })
})
