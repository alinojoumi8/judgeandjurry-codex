import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const approved = [{ issueId: 'fictional-value', elements: [{ label: 'The value of the subject matter of the alleged fraud exceeds $1,500' }] }]
const text = 'The approved issue requires the Crown to prove beyond a reasonable doubt that the value of the subject matter of the alleged fraud exceeds $1,500; the supplied extracts record aggregate account and transfer figures, not an established valuation of the subject matter in that threshold’s currency, so the connection is unresolved on this record (E-001).'
const instruction: GroundingRecordEvent = { eventId: 'current', type: 'judicial_instruction', payload: { text: 'Apply the reviewed fictional exercise.', issueInstructions: approved } }
function check(draft = text, options: { source?: string; approved?: typeof approved; events?: GroundingRecordEvent[]; status?: string } = {}) {
  const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: options.source ?? 'The supplied extracts record aggregate account and transfer figures.' }]
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'analysis', supportTypes: ['instruction', 'source', 'analysis'], explanation: 'The supplied model defines the benchmark; the connection of source amounts remains unresolved.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }] }), [{ id: 'content:1', text: draft }], evidence, '', undefined, { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('explicit approved issue burden threshold', () => {
  it.each(['approved issue', 'supplied issue', 'current approved issue', 'approved value element', 'supplied exercise element', 'current exercise issue'])('binds the %s directive to the current approved threshold', prefix => {
    expect(check(text.replace('approved issue', prefix)).errors).toEqual([])
  })
  it.each(['$1,600', 'USD $1,500'])('does not exempt a different amount or currency: %s', amount => {
    expect(check(text.replace('$1,500', amount), { source: `The report records a transfer of ${amount}.` }).status).toBe('failed')
  })
  it('requires unique current approval even if a source contains the same money', () => {
    const source = 'The report records a transfer of $1,500.'
    expect(check(text, { approved: [], source }).status).toBe('failed')
    expect(check(text, { approved: [...approved, { ...approved[0], issueId: 'other' }], source }).status).toBe('failed')
    expect(check(text, { events: [instruction], approved: [] }).errors).toEqual([])
    expect(check(text, { events: [{ ...instruction, payload: { ...instruction.payload, withheld: true } }], source }).status).toBe('failed')
    const changed = { ...instruction, eventId: 'later', payload: { ...instruction.payload, issueInstructions: [{ ...approved[0], elements: [{ label: 'The value exceeds $1,600' }] }] } }
    expect(check(text, { events: [instruction, changed], source }).status).toBe('failed')
  })
  it('keeps neighboring factual amounts independent of the approved benchmark', () => {
    expect(check(`${text} Arin received $1,500 (E-001).`).status).toBe('failed')
    expect(check(`${text} Arin received $1,500 (E-001).`, { source: 'Arin received $1,500.' }).errors).toEqual([])
    expect(check(text.replace(';', ', and Arin received $1,500;')).status).toBe('failed')
  })
  it.each(['operative count', 'filed charge', 'charged count', 'actual criminal count'])('does not use an exercise model to establish the %s', kind => {
    for (const draft of [text.replace('approved issue', `approved issue for the ${kind}`), text.replace(';', ` for the ${kind};`)]) {
      expect(check(draft).status).toBe('failed')
    }
  })
  it('keeps source quotation, third-party reporting and semantic rejection independent', () => {
    expect(check(`The report states “${text}” (E-001).`).status).toBe('failed')
    expect(check(`The report states ${text}`).status).toBe('failed')
    expect(check(text.replace('prove beyond a reasonable doubt that', 'prove not that')).status).toBe('failed')
    expect(check(text, { status: 'unsupported' }).status).toBe('failed')
  })
})
