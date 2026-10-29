import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const label = 'The value of the subject matter of the alleged fraud exceeds $1,500'
const approved = [{ issueId: 'fictional-count', elements: [{ label }] }]
const instruction: GroundingRecordEvent = { eventId: 'instruction', type: 'judicial_instruction', payload: { text: 'Apply these exercise elements.', issueInstructions: approved } }
const text = `For ${label}, Bryn’s $4,250 return request could support the element if established as the alleged subject-matter value in the applicable currency (E-001).`
function check(draft = text, options: { approved?: typeof approved; events?: GroundingRecordEvent[]; source?: string; status?: string } = {}) {
  const source = { ...supportedOpeningSource, exhibitId: 'E-001', text: options.source ?? 'Bryn requested a $4,250 return.' }
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': { status: options.status ?? 'supported', supportTypes: ['source', 'analysis'], explanation: 'The supplied element is a benchmark; the attributed source request remains a conditional factual premise.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] } } }), [{ id: 'content:1', text: draft }], [source], '', undefined, { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('approved element labels introducing evidence arguments', () => {
  it.each([
    text,
    text.replace('For The', 'For the'),
    text.replace('For The', 'Finally, for The'),
    text.replace('For The', 'For the approved element The'),
    text.replace('For The', 'For supplied element The'),
    text.replace('subject matter', 'subject   matter'),
    text.replace('$1,500,', '$1,500:'),
  ])('exempts only the exact approved label benchmark: %s', draft => {
    expect(check(draft).errors).toEqual([])
  })
  it('requires a unique usable current element and matching currency', () => {
    for (const options of [{ approved: [] }, { approved: [...approved, { ...approved[0], issueId: 'other' }] }, { approved: [{ ...approved[0], elements: [...approved[0].elements, ...approved[0].elements] }] }, { events: [{ ...instruction, payload: { ...instruction.payload, withheld: true } }] }, { events: [instruction, instruction] }]) expect(check(text, options).status).toBe('failed')
    expect(check(text, { events: [instruction], approved: [] }).errors).toEqual([])
    const later = { ...instruction, eventId: 'later', payload: { ...instruction.payload, issueInstructions: [{ ...approved[0], elements: [{ label: label.replace('$1,500', '$1,600') }] }] } }
    expect(check(text, { events: [instruction, later] }).status).toBe('failed')
    expect(check(text.replace('$1,500', 'USD $1,500')).status).toBe('failed')
    expect(check(text.replace('$1,500', '$1,600')).status).toBe('failed')
  })
  it.each([
    text.replace(label, label.replace('alleged fraud', 'payment received by Arin')),
    `The report states the following; ${text}`,
    `In the previous instruction; ${text}`,
    `“The source states; ${text}”`,
    `'The source states; ${text}'`,
    text.replace('$1,500,', '$1,500 for the filed charge,'),
    text.replace('$1,500,', '$1,500 for the actual criminal count,'),
    text.replace('For ', 'The record proves '),
    text.replace('For ', 'The source states '),
  ])('retains report, history, quotation and actual-charge boundaries: %s', draft => {
    expect(check(draft).status).toBe('failed')
  })
  it('checks each neighboring factual amount and independent semantic rejection', () => {
    expect(check(text.replace('$4,250', '$4,350')).status).toBe('failed')
    expect(check(text + ' Arin received $1,500 (E-001).').status).toBe('failed')
    expect(check(text.replace('$4,250', '$1,500')).status).toBe('failed')
    expect(check(text.replace('$4,250', '$1,500'), { source: 'Bryn requested a $1,500 return.' }).errors).toEqual([])
    expect(check(text, { status: 'unsupported' }).status).toBe('failed')
    expect(check(`The source states “${label}” (E-001).`, { source: `The source states “${label}”.` }).errors).toEqual([])
  })
})
