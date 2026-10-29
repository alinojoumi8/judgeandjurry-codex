import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const approved = [{ issueId: 'fictional-value', elements: [{ label: 'The value of the subject matter of the alleged fraud exceeds $1,500' }] }]
const text = 'Deception, deprivation, Arin’s knowledge of the facts, conscious recklessness regarding deprivation, and a subject-matter value exceeding $1,500 must each be proved beyond a reasonable doubt; failure of a business alone proves none of them (E-001).'
const count = 'Each element of the proposed fraud over $1,500 count — deception, deprivation, knowledge, and a subject-matter value exceeding $1,500 — must be proved beyond a reasonable doubt.'
const instruction: GroundingRecordEvent = { eventId: 'current', type: 'judicial_instruction', payload: { text: 'Apply the reviewed fictional exercise.', issueInstructions: approved } }
function check(draft = text, options: { source?: string; approved?: typeof approved; events?: GroundingRecordEvent[]; status?: string } = {}) {
  const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: options.source ?? 'The report records transfers totaling $8,200.' }]
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'analysis', supportTypes: ['instruction', 'source', 'analysis'], explanation: 'The supplied elements and burden remain normative; a business failure alone proves no element.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }] }), [{ id: 'content:1', text: draft }], evidence, '', undefined, { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('passive approved proof-list threshold', () => {
  it.each([text, count, text.replace('each be proved', 'all be established'), count.replace('be proved', 'be proven')])('recognizes each normative benchmark independently: %s', draft => {
    expect(check(draft).errors).toEqual([])
  })
  it.each([text, count])('requires unique current matching approval, even when source money matches: %s', draft => {
    const source = 'The report records $1,500 and USD $1,600.'
    expect(check(draft.replace('$1,500', '$1,600'), { source }).status).toBe('failed')
    expect(check(draft.replace('$1,500', 'USD $1,500'), { source }).status).toBe('failed')
    expect(check(draft, { source, approved: [] }).status).toBe('failed')
    expect(check(draft, { source, approved: [...approved, { ...approved[0], issueId: 'other' }] }).status).toBe('failed')
    expect(check(draft, { events: [instruction], approved: [] }).errors).toEqual([])
    expect(check(draft, { source, events: [{ ...instruction, payload: { ...instruction.payload, withheld: true } }] }).status).toBe('failed')
    const later = { ...instruction, eventId: 'later', payload: { ...instruction.payload, issueInstructions: [{ ...approved[0], elements: [{ label: 'The value exceeds $1,600' }] }] } }
    expect(check(draft, { source, events: [instruction, later] }).status).toBe('failed')
  })
  it('keeps both count and listed-element amounts independent', () => {
    expect(check(count.replace('exceeding $1,500', 'exceeding $1,600')).status).toBe('failed')
    expect(check(`${text} Arin received $1,500 (E-001).`).status).toBe('failed')
    expect(check(text.replace(';', ', and Arin received $1,500;')).status).toBe('failed')
    expect(check(`${text} Arin received $1,500 (E-001).`, { source: 'Arin received $1,500.' }).errors).toEqual([])
  })
  it.each([
    'Arin received funds with a value exceeding $1,500, and knowledge must be proved beyond a reasonable doubt.',
    'A payment value exceeding $1,500 was made to Arin, and the disputed knowledge element must be proved beyond a reasonable doubt.',
  ])('does not borrow an unrelated passive burden to exempt a factual payment: %s', draft => {
    expect(check(draft).status).toBe('failed')
  })
  it.each(['operative count', 'filed charge', 'charged count', 'actual criminal count'])('does not supply an actual %s from exercise setup', kind => {
    expect(check(text.replace('subject-matter value', `${kind} subject-matter value`)).status).toBe('failed')
    expect(check(text.replace('must each', `for the ${kind} must each`)).status).toBe('failed')
  })
  it('keeps source reporting, quotations, completed proof findings and semantic rejection separate', () => {
    for (const draft of [`The report states ${text}`, `“${text}” (E-001).`, text.replace('must each be proved', 'have each been proved'), text.replace('must each be proved', 'need not be proved')]) expect(check(draft).status).toBe('failed')
    expect(check(text, { status: 'unsupported' }).status).toBe('failed')
  })
  it('does not exempt the separate source-absence amount added beside a valid passive proof list', () => {
    const draft = `${count} The supplied exhibits do not state the $1,500 figure (E-001).`
    const review = check(draft)
    expect(review.status).toBe('failed')
    expect(review.validationErrors?.some(error => error.includes('stated dollar amount'))).toBe(true)
    expect(check(draft, { source: 'The report records $1,500.', status: 'unsupported' }).status).toBe('failed')
  })
})
