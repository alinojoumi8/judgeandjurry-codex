import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const approved = [{ issueId: 'fictional-value', elements: [{ label: 'The value of the subject matter of the alleged fraud exceeds $1,500' }] }]
const simple = 'Crown must prove every element of the proposed fraud over $1,500 count beyond a reasonable doubt.'
const listed = 'Crown must prove beyond a reasonable doubt each element of the proposed fraud over $1,500 count: a dishonest act; economic prejudice caused by that act; subjective knowledge of the act and of the risk of prejudice; and that the value of the subject matter of the alleged fraud exceeds $1,500.'
const instruction: GroundingRecordEvent = { eventId: 'reviewed-instruction', type: 'judicial_instruction', payload: { text: 'Apply the approved fictional exercise.', issueInstructions: approved } }
function check(text = simple, options: { source?: string; events?: GroundingRecordEvent[]; approved?: typeof approved; status?: string } = {}) {
  const sources = options.source ? [{ ...supportedOpeningSource, exhibitId: 'E-001', text: options.source }] : []
  const finding = { unitId: 'content:1', status: options.status ?? 'analysis', supportTypes: options.source ? ['source', 'instruction', 'analysis'] : ['instruction', 'analysis'], explanation: 'The supplied instruction defines the exercise threshold; each factual source amount still requires support.', citations: sources.map(item => ({ exhibitId: item.exhibitId, paragraph: 1 })), recordCitations: [] }
  return parseGroundingReview(JSON.stringify({ findings: [finding] }), [{ id: 'content:1', text }], sources, '', undefined, { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('proposed-count threshold in proof directives', () => {
  it.each([
    simple, listed,
    simple.replace('Crown', 'The Crown'),
    simple.replace('prove every', 'establish each'),
    simple.replace('the proposed', 'proposed'),
    listed.replace('Crown must', 'Members of the Jury Panel, the Crown must'),
    listed.replace('over', 'greater than'),
    `${simple.slice(0, -1)}, without asserting a transaction.`,
  ])('validates the local proposed-count benchmark independently of its proof-list position: %s', text => {
    expect(check(text).errors).toEqual([])
  })

  it('requires matching approval for both the count caption and the later value element independently', () => {
    expect(check(listed.replace('$1,500', '$1,600')).status).toBe('failed')
    expect(check(listed.replace('exceeds $1,500', 'exceeds $1,600')).status).toBe('failed')
    expect(check(simple.replace('$1,500', 'USD $1,500')).status).toBe('failed')
    expect(check(simple, { approved: [] }).status).toBe('failed')
    expect(check(simple, { approved: [approved[0], { ...approved[0], issueId: 'another-value' }] }).status).toBe('failed')
    expect(check(simple, { approved: [{ ...approved[0], elements: [{ label: 'Arin received $1,500' }] }] }).status).toBe('failed')
  })

  it.each([simple, listed])('keeps every neighboring transaction amount sourced: %s', text => {
    const source = 'The report records a transfer of $8,200.'
    expect(check(`${text} The report records a transfer of $8,200 (E-001).`, { source }).errors).toEqual([])
    for (const draft of [`${text} Arin received $1,500 (E-001).`, `${text} Arin received $9,200 (E-001).`]) {
      const review = check(draft, { source })
      expect(review.status).toBe('failed')
      expect(review.validationErrors?.some(error => error.includes('stated dollar amount'))).toBe(true)
    }
    expect(check(`${text} Arin received $1,500 (E-001).`, { source: `${source} Arin received $1,500.` }).errors).toEqual([])
  })

  it('does not treat a quote, source statement or factual payment as the author proof directive', () => {
    for (const text of [`The report states “${simple}” (E-001).`, `The report states ${simple} E-001.`, simple.replace('proposed fraud over', 'payment of'), simple.replace('proposed', 'operative')]) {
      expect(check(text, { source: 'The report records a transfer of $8,200.' }).status).toBe('failed')
    }
    expect(check(simple, { status: 'unsupported' }).status).toBe('failed')
  })

  it('obeys the latest usable instruction without falling back to stale scenario approval', () => {
    expect(check(listed, { events: [instruction], approved: [] }).errors).toEqual([])
    const changed = { ...instruction, eventId: 'later', payload: { ...instruction.payload, issueInstructions: [{ ...approved[0], elements: [{ label: approved[0].elements[0].label.replace('$1,500', '$1,600') }] }] } }
    expect(check(listed, { events: [instruction, changed] }).status).toBe('failed')
    expect(check(simple, { events: [{ ...instruction, payload: { ...instruction.payload, withheld: true } }] }).status).toBe('failed')
  })
})
