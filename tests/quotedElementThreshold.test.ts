import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const label = 'The value of the subject matter of the alleged fraud exceeds $1,500'
const approved = [{ issueId: 'fictional-value', elements: [{ label }] }]
const source = { ...supportedOpeningSource, exhibitId: 'E-001', text: 'The report records aggregate account totals of $8,200.' }
const text = `Finally, for “${label},” I remain unpersuaded by the aggregate account totals recorded in the report. E-001.`
const instruction: GroundingRecordEvent = { eventId: 'current-instruction', type: 'judicial_instruction', payload: { text: 'Apply the reviewed fictional elements.', issueInstructions: approved } }
function check(draft = text, options: { events?: GroundingRecordEvent[]; approved?: typeof approved; sourceText?: string; status?: string; explanation?: string } = {}) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'supported', supportTypes: ['source', 'instruction', 'analysis'], explanation: options.explanation ?? 'The quoted approved element is setup, and the source supplies the account totals; weight remains an assessment.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }] }), [{ id: 'content:1', text: draft }], [{ ...source, text: options.sourceText ?? source.text }], '', undefined, { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('quoted approved element thresholds in mixed argument', () => {
  it.each(['supported', 'analysis'])('separates an exact quoted element from source amounts when classified %s', status => {
    const review = check(text, { status })
    expect(review.errors).toEqual([])
    expect(review.findings[0].explanation).toContain(`Approved exercise threshold: ${label}`)
    expect(check(text.replace('Finally, for', 'For the approved element'), { status }).errors).toEqual([])
    expect(check(text.replace(/[“”]/g, '"'), { status }).errors).toEqual([])
  })

  it('retains the source check for each neighboring actual amount, even when equal to the quoted threshold', () => {
    expect(check(`${text} The report records $8,200 (E-001).`).errors).toEqual([])
    const invented = check(`${text} Arin received $1,500 (E-001).`)
    expect(invented.status).toBe('failed')
    expect(invented.validationErrors?.some(error => error.includes('stated dollar amount'))).toBe(true)
    expect(check(`${text} Arin received $1,500 (E-001).`, { sourceText: `${source.text} Arin received $1,500.` }).errors).toEqual([])
    expect(check(`${text} The report records $9,200 (E-001).`).status).toBe('failed')
  })

  it.each([
    text.replace('$1,500', '$1,600'),
    text.replace('$1,500', 'USD $1,500'),
    text.replace('exceeds', 'is below'),
    text.replace('alleged fraud', 'proved fraud'),
    text.replace('Finally, for', 'The report states'),
  ])('does not exempt an altered label or source-attributed quotation: %s', draft => {
    expect(check(draft).status).toBe('failed')
  })

  it('requires one usable current model rather than an absent or ambiguous setup', () => {
    expect(check(text, { approved: [] }).status).toBe('failed')
    expect(check(text, { approved: [approved[0], { ...approved[0], issueId: 'another-issue' }] }).status).toBe('failed')
    expect(check(text, { approved: [{ ...approved[0], elements: [{ label }, { label }] }] }).status).toBe('failed')
    expect(check(text, { approved: [{ ...approved[0], elements: [{ label: 'Arin received $1,500' }] }] }).status).toBe('failed')
  })

  it('uses only the latest usable delivered instruction and records its provenance', () => {
    const review = check(text, { events: [instruction], approved: [] })
    expect(review.errors).toEqual([])
    expect(review.findings[0].recordCitations?.map(citation => citation.eventId)).toEqual(['current-instruction'])
    const changed = { ...instruction, eventId: 'later-instruction', payload: { ...instruction.payload, issueInstructions: [{ ...approved[0], elements: [{ label: label.replace('$1,500', '$1,600') }] }] } }
    expect(check(text, { events: [instruction, changed] }).status).toBe('failed')
    expect(check(text, { events: [{ ...instruction, payload: { ...instruction.payload, withheld: true } }] }).status).toBe('failed')
    expect(check(text, { events: [{ ...instruction, payload: { issueInstructions: approved } }] }).status).toBe('failed')
    expect(check(text, { events: [instruction, instruction] }).status).toBe('failed')
  })

  it('does not reverse a semantic rejection of an added transaction-specific proof requirement', () => {
    const explanation = 'The supplied model does not require a transaction-specific value as an additional element.'
    const draft = `Finally, for “${label},” the Crown must prove a transaction-specific value; aggregate totals cannot suffice. E-001.`
    const review = check(draft, { status: 'unsupported', explanation })
    expect(review.status).toBe('failed')
    expect(review.findings[0]).toMatchObject({ status: 'unsupported', explanation })
  })
})
