import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const approved = [{ issueId: 'fictional-value', elements: [{ label: 'The value of the subject matter of the alleged fraud exceeds $1,500' }] }]
const text = 'If the $8,200 total from Recorded Contributors to the Arin accounts, converted to Cdn$ under the report’s stated footnote, is established as the value of the alleged subject matter, it could support the element exceeding $1,500; otherwise the qualifying value and its currency require further linkage (E-001).'
const instruction: GroundingRecordEvent = { eventId: 'current', type: 'judicial_instruction', payload: { text: 'Apply the reviewed fictional exercise.', issueInstructions: approved } }
function check(draft = text, options: { source?: string; approved?: typeof approved; events?: GroundingRecordEvent[]; status?: string } = {}) {
  const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: options.source ?? 'The report records a total of $8,200 from Recorded Contributors to the Arin accounts. Its footnote converts the accounts to Cdn$.' }]
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'analysis', supportTypes: ['source', 'analysis'], explanation: 'The source supplies the figure; the proposed connection to the approved value element remains conditional.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }] }), [{ id: 'content:1', text: draft }], evidence, '', undefined, { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('conditional source figure and approved value benchmark', () => {
  it.each(['could', 'would', 'may', 'might'])('recognizes the %s implication without converting the premise into established value', modal => {
    expect(check(text.replace('it could', `it ${modal}`)).errors).toEqual([])
  })
  it('retains decimal source amounts and explicit source references in the antecedent', () => {
    expect(check(text.replace('$8,200', 'E-001’s $8,200.50').replace('it could', 'that figure may'), { source: 'The report records a total of $8,200.50 from Recorded Contributors to the Arin accounts.' }).errors).toEqual([])
  })
  it('binds only the final threshold occurrence, leaving every unsupported antecedent or neighboring amount rejected', () => {
    for (const draft of [text.replace('$8,200', '$1,500'), text.replace('$8,200', '$9,200'), `${text} Arin received $1,500 (E-001).`, text.replace(';', ', and Arin received $1,500;')]) {
      expect(check(draft).status).toBe('failed')
    }
    expect(check(`${text} Arin received $1,500 (E-001).`, { source: 'The report records $8,200. Arin received $1,500.' }).errors).toEqual([])
  })
  it('requires the current unique amount and currency even if source money matches the claimed benchmark', () => {
    const source = 'The report records $8,200, $1,500 and USD $1,600.'
    for (const draft of [text.replace('$1,500', '$1,600'), text.replace('$1,500', 'USD $1,500')]) expect(check(draft, { source }).status).toBe('failed')
    expect(check(text, { source, approved: [] }).status).toBe('failed')
    expect(check(text, { source, approved: [...approved, { ...approved[0], issueId: 'other' }] }).status).toBe('failed')
    expect(check(text, { approved: [], events: [instruction] }).errors).toEqual([])
    expect(check(text, { source, events: [{ ...instruction, payload: { ...instruction.payload, withheld: true } }] }).status).toBe('failed')
    const later = { ...instruction, eventId: 'later', payload: { ...instruction.payload, issueInstructions: [{ ...approved[0], elements: [{ label: 'The value exceeds $1,600' }] }] } }
    expect(check(text, { source, events: [instruction, later] }).status).toBe('failed')
  })
  it.each(['operative count', 'filed charge', 'charged count', 'actual criminal count'])('does not let exercise setup supply the %s amount', kind => {
    for (const draft of [text.replace('alleged subject matter', `alleged subject matter of the ${kind}`), text.replace(';', ` for the ${kind};`)]) expect(check(draft).status).toBe('failed')
  })
  it('does not exempt quotations, source-reported conditionals, a positive finding or a rejected semantic judgment', () => {
    for (const draft of [`The report states “${text}” (E-001).`, `The report states ${text}`, text.replace('If the', 'The'), text.replace('could support', 'proves')]) expect(check(draft).status).toBe('failed')
    expect(check(text, { status: 'unsupported' }).status).toBe('failed')
  })
})
