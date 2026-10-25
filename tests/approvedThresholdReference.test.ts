import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const approved = [{ issueId: 'fictional-value', elements: [{ label: 'The value of the subject matter of the alleged fraud exceeds $1,500' }] }]
const lead = "On the supplied record, the Crown may pursue the proposed fictional issue on Mira's attributed interview answers, but must prove each approved element beyond a reasonable doubt: "
const proof = `${lead}a prohibited dishonest act; deprivation caused by that act; knowledge of the facts; and subject matter of the alleged fraud exceeding $1,500.`
const reference = "The $1,500 figure is the approved element's threshold, not an amount proved by the supplied exhibits."
const instruction: GroundingRecordEvent = { eventId: 'current', type: 'judicial_instruction', payload: { text: 'Apply the reviewed fictional exercise.', issueInstructions: approved } }
function check(text: string, options: { source?: string; approved?: typeof approved; events?: GroundingRecordEvent[]; status?: string } = {}) {
  const evidence = options.source ? [{ ...supportedOpeningSource, exhibitId: 'E-001', text: options.source }] : []
  const finding = { unitId: 'content:1', status: options.status ?? 'analysis', supportTypes: evidence.length ? ['instruction', 'source', 'analysis'] : ['instruction', 'analysis'], explanation: 'A current exercise benchmark, without any completed proof or transaction.', citations: evidence.map(item => ({ exhibitId: item.exhibitId, paragraph: 1 })), recordCitations: [] }
  return parseGroundingReview(JSON.stringify({ findings: [finding] }), [{ id: 'content:1', text }], evidence, '', undefined, { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('approved threshold references and long current proof directives', () => {
  it.each([
    proof,
    proof.replace("may pursue the proposed fictional issue on Mira's attributed interview answers, but", 'bears the burden and'),
    proof.replace('a prohibited dishonest act; ', 'a prohibited dishonest act, '),
    proof.replace("Mira's attributed interview answers", 'the separately supplied attributed accounts and their expressly preserved uncertainties concerning the disputed event and the source-use limitations applicable to this exercise'),
    reference,
    reference.replace("approved element's", 'supplied exercise element’s'),
  ])('recognizes the approved benchmark without a source transaction: %s', text => {
    expect(check(text).errors).toEqual([])
  })

  it.each([proof, reference])('requires matching unique current approval for %s', text => {
    expect(check(text.replace('$1,500', '$1,600')).status).toBe('failed')
    expect(check(text.replace('$1,500', 'USD $1,500')).status).toBe('failed')
    expect(check(text, { approved: [] }).status).toBe('failed')
    expect(check(text, { approved: [...approved, { ...approved[0], issueId: 'other' }] }).status).toBe('failed')
    expect(check(text, { events: [instruction], approved: [] }).errors).toEqual([])
    expect(check(text, { events: [{ ...instruction, payload: { ...instruction.payload, withheld: true } }] }).status).toBe('failed')
    const changed = { ...instruction, eventId: 'later', payload: { ...instruction.payload, issueInstructions: [{ ...approved[0], elements: [{ label: 'The value exceeds $1,600' }] }] } }
    expect(check(text, { events: [instruction, changed] }).status).toBe('failed')
  })

  it.each([proof, reference])('checks each neighboring payment independently: %s', text => {
    const rejected = check(`${text} Rowan received $1,500 (E-001).`, { source: 'The report records a blue token.' })
    expect(rejected.validationErrors).toEqual(expect.arrayContaining([expect.stringContaining('stated dollar amount')]))
    expect(check(`${text} Rowan received $1,500 (E-001).`, { source: 'Rowan received $1,500.' }).errors).toEqual([])
    expect(check(text.replace('$1,500', '$1,500, and Rowan received $1,500')).status).toBe('failed')
  })

  it.each([
    `The report states ${proof}`,
    `The report states “${proof}” (E-001).`,
    'The Crown reports that Mira said she must prove a subject-matter value exceeding $1,500.',
    'The Crown says that Mira must prove a subject-matter value exceeding $1,500.',
    proof.replace('but must prove', 'but does not have to prove'),
    proof.replace('but must prove', 'but has proved'),
    proof.replace('but must prove', 'but must not prove'),
    `“${reference}” (E-001).`,
    `The report states ${reference}`,
    reference.replace('is the approved', 'is not the approved'),
    reference.replace('is the approved', 'was the approved'),
    reference.replace('threshold,', 'threshold for the filed charge,'),
    'The approved threshold proves that Rowan received $1,500.',
  ])('does not turn reported words, factual proof or charge status into setup: %s', text => {
    expect(check(text).status).toBe('failed')
  })

  it.each([proof, reference])('retains an independent semantic rejection for %s', text => {
    const result = check(text, { status: 'unsupported' })
    expect(result.status).toBe('failed')
    expect(result.findings[0].status).toBe('unsupported')
  })
})
