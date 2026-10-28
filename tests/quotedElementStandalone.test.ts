import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const label = 'The value of the subject matter of the alleged fraud exceeds $1,500'
const approved = [{ issueId: 'fictional-count', elements: [{ label }] }]
const text = `Finally, “${label}” requires an established matching amount; the supplied figures do not establish that connection beyond a reasonable doubt (E-001).`
function check(content = text, options: { approved?: typeof approved; events?: GroundingRecordEvent[]; status?: string; source?: string } = {}) {
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': {
    status: options.status ?? 'analysis', supportTypes: ['analysis', 'source'], explanation: 'The approved element is a requirement; the source figures and their weight are separately assessed.',
    citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [],
  } } }), [{ id: 'content:1', text: content }], [{ ...supportedOpeningSource, exhibitId: 'E-001', text: options.source ?? 'The report records a disputed $4,250 investment.' }], '', undefined,
  { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('standalone quoted approved threshold labels', () => {
  it.each([
    text,
    text.replace('Finally, ', ''),
    text.replaceAll('“', '"').replaceAll('”', '"'),
    text.replace('requires an established matching amount', 'requires proof beyond a reasonable doubt'),
    text.replace('subject matter', 'subject   matter'),
  ])('accepts a current exact normative label without requiring for: %s', content => {
    expect(check(content).errors).toEqual([])
  })
  it.each([
    text.replace('$1,500', '$1,600'),
    text.replace('$1,500', 'USD $1,500'),
    text.replace('alleged fraud', 'payment received by Arin'),
    `The source states the following; ${text}`,
    `In the previous instruction; ${text}`,
    `The report says “${text}”`,
    text.replace('requires an established matching amount', 'records a payment'),
    text.replace('requires an established matching amount', 'requires payment of that amount'),
    text.replace('requires an established matching amount', 'requires an established matching amount for the filed charge'),
    text + ' Arin received $1,500 (E-001).',
    text.replace('the supplied figures', 'the supplied $1,500 payment figures'),
  ])('does not exempt a different label, attributed claim or factual payment: %s', content => {
    expect(check(content).status).toBe('failed')
  })
  it('requires unique usable current approval and retains independent rejection', () => {
    expect(check(text, { approved: [] }).status).toBe('failed')
    expect(check(text, { approved: [...approved, { ...approved[0], issueId: 'other' }] }).status).toBe('failed')
    expect(check(text, { approved: [{ ...approved[0], elements: [...approved[0].elements, ...approved[0].elements] }] }).status).toBe('failed')
    const event: GroundingRecordEvent = { eventId: 'instruction', type: 'judicial_instruction', payload: { text: 'Current exercise elements.', issueInstructions: approved } }
    expect(check(text, { approved: [], events: [event] }).errors).toEqual([])
    expect(check(text, { events: [{ ...event, payload: { ...event.payload, withheld: true } }] }).status).toBe('failed')
    expect(check(text, { status: 'unsupported' }).status).toBe('failed')
    expect(check(text + ' The report records $4,250 (E-001).').errors).toEqual([])
    expect(check(text + ' The report records $4,350 (E-001).').status).toBe('failed')
  })
})
