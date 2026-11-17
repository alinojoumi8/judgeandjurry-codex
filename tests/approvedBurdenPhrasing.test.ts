import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const approved = [{ issueId: 'fictional-burden', elements: [
  { label: 'A dishonest act' }, { label: 'Economic prejudice caused by that act' },
  { label: 'Arin’s subjective knowledge of the act and possible prejudice' },
  { label: 'The value of the subject matter of the alleged fraud exceeds $1,750' },
] }]
const draft = 'The Crown bears the burden of proving each element of the proposed fraud-over-$1,750 count beyond a reasonable doubt: a dishonest act; economic prejudice caused by that act; Arin’s subjective knowledge of the facts and that prejudice could result; and a value of the subject matter of the alleged fraud exceeding $1,750.'
const instruction: GroundingRecordEvent = { eventId: 'current-actual-instruction', type: 'judicial_instruction', payload: { text: 'Apply the approved fictional elements.', issueInstructions: approved } }
function audit(text = draft, options: { approved?: typeof approved; events?: GroundingRecordEvent[]; source?: string; status?: string } = {}) {
  const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: options.source ?? 'The report records a transfer of $8,200.' }]
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'analysis', supportTypes: ['instruction', 'source', 'analysis'], explanation: 'A normative account of the current exercise burden, not a finding that a payment or fraud occurred.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }] }),
    [{ id: 'content:1', text }], evidence, '', undefined,
    { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('equivalent approved burden phrasing retains each threshold occurrence scope', () => {
  it.each(['proving', 'establishing'])('recognizes the full semicolon proof list with bears the burden of %s', verb => {
    expect(audit(draft.replace('proving', verb)).errors).toEqual([])
  })

  it.each(['proving', 'establishing'])('recognizes the isolated normative listed value with %s', verb => {
    expect(audit(`The Crown bears the burden of ${verb} that a value of the subject matter of the alleged fraud exceeds $1,750 beyond a reasonable doubt.`).errors).toEqual([])
  })

  it('uses the actual latest usable judicial instruction before the approved model', () => {
    expect(audit(draft, { approved: [], events: [instruction] }).errors).toEqual([])
    const changed = { ...instruction, eventId: 'later', payload: { ...instruction.payload, issueInstructions: [{ ...approved[0], elements: [{ label: 'The value exceeds $1,900' }] }] } }
    for (const events of [[instruction, changed], [{ ...instruction, payload: { ...instruction.payload, withheld: true } }], [instruction, instruction]]) {
      expect(audit(draft, { events, source: 'The report records $1,750.' }).status).toBe('failed')
    }
  })

  it.each(['$1,900', 'USD $1,750'])('requires approval of both the count and listed amount/currency: %s', amount => {
    for (const text of [draft.replace('$1,750', amount), draft.replace('exceeding $1,750', `exceeding ${amount}`)]) {
      expect(audit(text, { source: `The report records ${amount} and $1,750.` }).status).toBe('failed')
    }
  })

  it('does not use source money as approval for an absent, ambiguous or different model', () => {
    const source = 'The report records $1,750.'
    for (const model of [[], [...approved, { ...approved[0], issueId: 'another' }], [{ ...approved[0], elements: [{ label: 'The value exceeds $1,900' }] }]]) {
      expect(audit(draft, { approved: model, source }).status).toBe('failed')
      expect(audit('The Crown bears the burden of proving that the value exceeds $1,750.', { approved: model, source }).status).toBe('failed')
    }
  })

  it('keeps every neighboring factual amount subject to source support', () => {
    const mixed = draft.replace('; and a value', '; Arin received $1,750; and a value')
    expect(audit(mixed).status).toBe('failed')
    expect(audit(`${draft} Arin received $1,750.`).status).toBe('failed')
    expect(audit(`${draft} Arin received $1,750.`, { source: 'Arin received $1,750.' }).errors).toEqual([])
  })

  it.each(['operative count', 'filed charge', 'charged count', 'actual criminal count'])('does not establish an actual %s from the exercise model', kind => {
    for (const text of [draft.replace('proposed fraud-over-', `${kind} of fraud-over-`), draft.replace('; and a value', `; for the ${kind}, and a value`)]) {
      expect(audit(text).status).toBe('failed')
    }
  })

  it.each([
    draft.replace('Crown bears', 'Defence bears'),
    draft.replace('Crown bears the burden', 'Crown bears no burden'),
    draft.replace('proving each', 'proving not each'),
    draft.replace('The Crown bears', 'It is not true that the Crown bears'),
    `The report states “${draft}” (E-001).`,
    `The report states ${draft}`,
  ])('does not exempt a wrong-side, negated or reported burden claim: %s', text => {
    expect(audit(text).status).toBe('failed')
  })

  it('never promotes an explicit semantic rejection merely because the burden wording matches', () => {
    expect(audit(draft, { status: 'unsupported' }).status).toBe('failed')
  })

  it('keeps a reported burden directive in source scope across its semicolon list', () => {
    const reported = 'The report states that the Crown bears the burden of proving a dishonest act; and a value of the subject matter of the alleged fraud exceeding $1,750.'
    expect(audit(reported).status).toBe('failed')
    expect(audit(reported, { source: reported, status: 'supported' }).errors).toEqual([])
  })

  it('does not extend an earlier source-reporting clause over a new current Crown directive', () => {
    const text = 'The report records a transfer of $8,200; the Crown bears the burden of proving a dishonest act; and a value of the subject matter of the alleged fraud exceeding $1,750.'
    expect(audit(text).errors).toEqual([])
  })

  it.each(['I do not decide credibility', 'The supplied account does not resolve credibility'])('does not carry an unrelated earlier negation into the current burden: %s', prefix => {
    for (const value of ['a value of the subject matter of the alleged fraud exceeding $1,750', 'a dishonest act; and a value of the subject matter of the alleged fraud exceeding $1,750']) {
      expect(audit(`${prefix}; the Crown bears the burden of proving ${value}.`).errors).toEqual([])
    }
  })

  it('uses the latest independent Crown-bears directive after an earlier negated directive', () => {
    const text = 'It is not true that the Crown bears the burden of proving a source account correct; the Crown bears the burden of proving a dishonest act; and a value of the subject matter of the alleged fraud exceeding $1,750.'
    expect(audit(text).errors).toEqual([])
  })

  it.each([
    'It is not true that the Crown bears the burden of proving a dishonest act; and a value of the subject matter of the alleged fraud exceeding $1,750.',
    'The Crown bears the burden of proving not a dishonest act; and a value of the subject matter of the alleged fraud exceeding $1,750.',
    'The Crown bears the burden of proving a dishonest act; and not a value of the subject matter of the alleged fraud exceeding $1,750.',
  ])('retains negation within the governing directive or its continued list: %s', text => {
    expect(audit(text).status).toBe('failed')
  })
})
