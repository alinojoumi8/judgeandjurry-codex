import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const approved = [{ issueId: 'fictional-value', elements: [{ label: 'The value of the subject matter of the alleged fraud exceeds $1,500' }] }]
const text = 'The value element requires proof beyond a reasonable doubt that the subject matter exceeded $1,500.'
const instruction: GroundingRecordEvent = { eventId: 'current', type: 'judicial_instruction', payload: { text: 'Apply the supplied exercise.', issueInstructions: approved } }
function check(draft = text, options: { approved?: typeof approved; events?: GroundingRecordEvent[]; source?: string; status?: string } = {}) {
  const sources = options.source ? [{ ...supportedOpeningSource, exhibitId: 'E-001', text: options.source }] : []
  const finding = { unitId: 'content:1', status: options.status ?? 'analysis', supportTypes: sources.length ? ['instruction', 'source', 'analysis'] : ['instruction'], explanation: 'A restatement of the current approved value element, without asserting a source payment or completed proof.', citations: sources.map(source => ({ exhibitId: source.exhibitId, paragraph: 1 })), recordCitations: [] }
  return parseGroundingReview(JSON.stringify({ findings: [finding] }), [{ id: 'content:1', text: draft }], sources, '', undefined, { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('approved value-element proof requirements', () => {
  it.each([
    text,
    text.replace('value element', 'approved value element'),
    text.replace('value element', 'supplied exercise value element'),
    text.replace('subject matter exceeded', 'value of the subject matter exceeds'),
    text.replace('subject matter exceeded', 'subject matter of the alleged fraud is greater than'),
  ])('binds only the normative benchmark to the supplied element: %s', draft => {
    expect(check(draft).errors).toEqual([])
  })
  it('requires one matching current approval and currency', () => {
    expect(check(text, { approved: [] }).status).toBe('failed')
    expect(check(text, { approved: [...approved, { ...approved[0], issueId: 'another' }] }).status).toBe('failed')
    expect(check(text.replace('$1,500', '$1,600'), { source: 'The report records $1,600.' }).status).toBe('failed')
    expect(check(text.replace('$1,500', 'USD $1,500')).status).toBe('failed')
    expect(check(text, { events: [instruction], approved: [] }).errors).toEqual([])
    expect(check(text, { events: [{ ...instruction, payload: { ...instruction.payload, withheld: true } }] }).status).toBe('failed')
    expect(check(text, { events: [instruction, instruction] }).status).toBe('failed')
    const later = { ...instruction, eventId: 'later', payload: { ...instruction.payload, issueInstructions: [{ ...approved[0], elements: [{ label: 'The value exceeds $1,600' }] }] } }
    expect(check(text, { events: [instruction, later] }).status).toBe('failed')
  })
  it.each(['operative count', 'filed charge', 'charged count', 'actual criminal count'])('does not establish an actual %s', kind => {
    expect(check(text.replace('value element', `value element for the ${kind}`)).status).toBe('failed')
    expect(check(text.replace('.', ` for the ${kind}.`)).status).toBe('failed')
  })
  it.each([
    `The report states ${text}`,
    `The report states the following; ${text}`,
    `The report states “${text}” (E-001).`,
    `“${text}”`,
    text.replace('requires proof', 'does not require proof'),
    text.replace('requires proof', 'requires no proof'),
    text.replace('requires proof beyond a reasonable doubt that', 'has been proved because'),
    text.replace('beyond a reasonable doubt', 'on a balance of probabilities'),
    text.replace('subject matter exceeded', 'payment received by Rowan exceeded'),
  ])('does not exempt reported words, altered requirements or financial premises: %s', draft => {
    expect(check(draft).status).toBe('failed')
  })
  it('checks neighboring amounts and financial assertions separately', () => {
    expect(check(`The report records a blue token (E-001); ${text}`, { source: 'The report records a blue token.' }).errors).toEqual([])
    expect(check(`${text} Rowan received $1,500 (E-001).`, { source: 'The report records a blue token.' }).status).toBe('failed')
    expect(check(`${text} Rowan received $1,500 (E-001).`, { source: 'Rowan received $1,500.' }).errors).toEqual([])
    expect(check(text.replace('.', ', and Rowan received $1,500.')).status).toBe('failed')
  })
  it('does not override an independent rejection of the requirement', () => {
    expect(check(text, { status: 'unsupported' }).status).toBe('failed')
  })
})
