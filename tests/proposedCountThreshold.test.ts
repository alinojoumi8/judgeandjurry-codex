import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import type { GroundingRecordEvent } from '../server/groundingRecords'

const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'The summary combines accounts and groups receipts by investor category. It records deposits of $8,000.' }]
const approved = [{ issueId: 'exercise', elements: [{ label: 'The value of the alleged fraud exceeds $5,000' }] }]
const text = 'Those selected passages aggregate by category across accounts; whether the underlying schedules match each remitter to an individual return, and what principal is attributable to Arin on the proposed fraud over $5,000 count, remains an unresolved question on this record.'
function check(content = text, labels = approved, events: GroundingRecordEvent[] = [], status = 'analysis', sources = evidence) {
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': { status, supportTypes: ['source', 'analysis'], explanation: 'The summary and unresolved exercise question have separate support.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] } } }), [{ id: 'content:1', text: content }], sources, '', undefined, { packet: '', actorRoles: [], partyRoles: [], events, approvedIssueInstructions: labels, stage: 'defence_opening' })
}

describe('approved proposed-count threshold in an unresolved mixed paragraph', () => {
  it.each(['analysis', 'supported'])('keeps the approved threshold separate from financial assertions: %s', status => {
    const result = check(text, approved, [], status)
    expect(result.errors).toEqual([])
    expect(result.findings[0].explanation).toContain('scenario setup')
  })
  it('recognizes a standalone unresolved question with the same approved threshold', () => {
    expect(check('What principal is attributable to Arin on the proposed fraud exceeding $5,000 count remains an unresolved question within the supplied record.').status).toBe('passed')
  })
  it.each([
    text.replace('over $5,000', 'over $10,000'),
    text.replace('over $5,000', 'over USD $5,000'),
    `${text} Arin received $5,000 (E-001).`,
    `The report records deposits of $9,000 (E-001); ${text.split('; ')[1]}`,
    'Arin committed fraud over $5,000 (E-001).',
    'The report asks what principal is attributable to Arin on the proposed fraud over $5,000 count, remains an unresolved question on this record (E-001).',
    `“${text}” (E-001).`,
  ])('does not excuse an unsupported fact, quotation, source assertion or different threshold: %s', candidate => {
    expect(check(candidate).status).toBe('failed')
  })
  it.each([{ labels: [] }, { labels: [{ issueId: 'different', elements: [{ label: 'The value exceeds $10,000' }] }] }, { labels: [...approved, { ...approved[0], issueId: 'ambiguous' }] }])('requires unique approved setup: %j', ({ labels }) => {
    expect(check(text, labels).status).toBe('failed')
  })
  it('uses the current delivered instruction instead of superseded setup', () => {
    const event: GroundingRecordEvent = { eventId: 'instruction', type: 'judicial_instruction', payload: { text: 'Current exercise rule.', issueInstructions: [{ elements: [{ label: 'The value exceeds $10,000' }] }] } }
    expect(check(text, approved, [event]).status).toBe('failed')
  })
  const matchingAmounts = [{ ...evidence[0], text: evidence[0].text + ' Another deposit was $10,000 and a fee was $5,000.' }]
  it('does not use a matching source transaction to authorize a different exercise threshold', () => {
    expect(check(text.replace('over $5,000', 'over $10,000'), approved, [], 'analysis', matchingAmounts).status).toBe('failed')
  })
  it('does not use matching source money as missing exercise approval', () => {
    expect(check(text, [], [], 'analysis', matchingAmounts).status).toBe('failed')
  })
  it('still accepts a genuinely source-backed amount without an exercise threshold', () => {
    expect(check('The report records a fee of $5,000 (E-001).', [], [], 'supported', matchingAmounts).status).toBe('passed')
  })
  it.each([
    'Crown Opening: Proposed Fraud Over $5,000 Count - Arin',
    'Defence Closing — Proposed Fraud Exceeding $5,000 Count — Arin Vale',
  ])('recognizes a proposed-count caption with a party suffix: %s', caption => {
    const review = parseGroundingReview(JSON.stringify({ findings: { 'title:1': { status: 'analysis', supportTypes: ['analysis'], explanation: 'Exercise caption.', citations: [], recordCitations: [] } } }), [{ id: 'title:1', text: caption }], evidence, '', undefined, { packet: '', actorRoles: [], partyRoles: [], events: [], approvedIssueInstructions: approved, stage: 'crown_opening' })
    expect(review.status).toBe('passed')
  })
  it.each([
    'Crown Opening: Proposed Fraud Over $10,000 Count - Arin',
    'Crown Opening: Proposed Fraud Over USD $5,000 Count - Arin',
    'Crown Opening: Fraud Over $5,000 Count - Arin',
    'Crown Opening: Proposed Fraud Over $5,000 Count - Arin received $9,000',
  ])('does not exempt another threshold, actual-charge label or appended payment: %s', caption => {
    const review = parseGroundingReview(JSON.stringify({ findings: { 'title:1': { status: 'analysis', supportTypes: ['analysis'], explanation: 'Candidate caption.', citations: [], recordCitations: [] } } }), [{ id: 'title:1', text: caption }], evidence, '', undefined, { packet: '', actorRoles: [], partyRoles: [], events: [], approvedIssueInstructions: approved, stage: 'crown_opening' })
    expect(review.status).toBe('failed')
  })
})
