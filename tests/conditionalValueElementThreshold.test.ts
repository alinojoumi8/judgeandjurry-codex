import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const approved = [{ issueId: 'fictional-value', elements: [{ label: 'The value of the subject matter of the alleged fraud exceeds $1,500' }] }]
const text = 'If a recorded figure matching the alleged subject matter is established in the threshold’s currency, it could support the element that the value exceeds $1,500; the Crown has not yet established that connection on this record.'
const instruction: GroundingRecordEvent = { eventId: 'current', type: 'judicial_instruction', payload: { text: 'Apply the reviewed fictional exercise.', issueInstructions: approved } }
function check(draft = text, options: { source?: string; approved?: typeof approved; events?: GroundingRecordEvent[]; status?: string; explanation?: string } = {}) {
  const sources = options.source ? [{ ...supportedOpeningSource, exhibitId: 'E-001', text: options.source }] : []
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'analysis', supportTypes: sources.length ? ['source', 'instruction', 'analysis'] : ['instruction', 'own_assessment'], explanation: options.explanation ?? 'The conditional element application supplies no occurrence fact.', citations: sources.map(source => ({ exhibitId: source.exhibitId, paragraph: 1 })), recordCitations: [] }] }), [{ id: 'content:1', text: draft }], sources, '', undefined, { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('conditional application of an approved value threshold', () => {
  it.each([
    text,
    text.replace('the value exceeds', 'the value of the subject matter of the alleged fraud exceeds'),
    text.replace('a recorded figure', 'the supplied figure').replace('it could support the element', 'that figure would support the approved value element'),
  ])('classifies only the conditional element benchmark as setup: %s', draft => {
    const review = check(draft)
    expect(review.errors).toEqual([])
    expect(review.findings[0].explanation).toContain('Approved exercise threshold:')
  })

  it.each([
    text.replace('$1,500', '$1,600'),
    text.replace('$1,500', 'USD $1,500'),
    text.replace('exceeds', 'is below'),
    text.replace('it could support the element that', 'it proves that'),
    text.replace('If a recorded figure', 'A recorded figure'),
    text.replace('recorded figure', 'recorded figure of $1,500'),
  ])('does not exempt wrong thresholds, factual figures or positive findings: %s', draft => {
    expect(check(draft).status).toBe('failed')
  })

  it('retains independent factual-amount checks and preserves actual sourced payments', () => {
    const source = 'The report records a payment of $8,200.'
    expect(check(`${text} The report records a payment of $8,200 (E-001).`, { source }).errors).toEqual([])
    for (const amount of ['$1,500', '$9,200']) {
      const review = check(`${text} Arin received ${amount} (E-001).`, { source })
      expect(review.status).toBe('failed')
      expect(review.validationErrors?.some(error => error.includes('stated dollar amount'))).toBe(true)
    }
    expect(check(`${text} Arin received $1,500 (E-001).`, { source: `${source} Arin received $1,500.` }).errors).toEqual([])
  })

  it('requires the current unique approved threshold and preserves delivered instruction provenance', () => {
    expect(check(text, { approved: [] }).status).toBe('failed')
    expect(check(text, { approved: [approved[0], { ...approved[0], issueId: 'other' }] }).status).toBe('failed')
    expect(check(text, { approved: [{ ...approved[0], elements: [{ label: 'Arin received $1,500' }] }] }).status).toBe('failed')
    const review = check(text, { approved: [], events: [instruction] })
    expect(review.errors).toEqual([])
    expect(review.findings[0].recordCitations?.map(citation => citation.eventId)).toEqual(['current'])
    expect(check(text, { events: [{ ...instruction, payload: { ...instruction.payload, withheld: true } }] }).status).toBe('failed')
    const later = { ...instruction, eventId: 'later', payload: { ...instruction.payload, issueInstructions: [{ ...approved[0], elements: [{ label: approved[0].elements[0].label.replace('$1,500', '$1,600') }] }] } }
    expect(check(text, { events: [instruction, later] }).status).toBe('failed')
  })

  it('does not reverse an independent semantic rejection of an added source-absence claim', () => {
    const explanation = 'The extra clause makes an unsupported global source-absence assertion.'
    const review = check(`${text} The threshold figure is not present in any source.`, { status: 'unsupported', explanation })
    expect(review.status).toBe('failed')
    expect(review.findings[0]).toMatchObject({ status: 'unsupported', explanation })
  })
})
