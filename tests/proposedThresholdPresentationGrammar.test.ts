import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const approved = [{ issueId: 'fictional-value', elements: [{ label: 'The value of the subject matter of the alleged fraud exceeds $1,500' }] }]
const heading = 'Defence opening on proposed fraud-over-$1,500 count'
const burden = 'Defence submits that the Crown must prove every element of the proposed fraud-over-$1,500 count beyond a reasonable doubt.'
const elements = 'The evidence must establish a prohibited dishonest act, deprivation caused by that act, Arin’s subjective knowledge of the facts constituting it, subjective knowledge that deprivation could result, and a subject-matter value exceeding $1,500.'
const instruction: GroundingRecordEvent = { eventId: 'current', type: 'judicial_instruction', payload: { text: 'Apply the reviewed fictional exercise.', issueInstructions: approved } }
function check(text: string, options: { title?: boolean; source?: string; approved?: typeof approved; events?: GroundingRecordEvent[]; status?: string; explanation?: string } = {}) {
  const unitId = options.title ? 'title:1' : 'content:1'
  const sources = options.source ? [{ ...supportedOpeningSource, exhibitId: 'E-001', text: options.source }] : []
  const finding = { unitId, status: options.status ?? 'analysis', supportTypes: sources.length ? ['source', 'instruction', 'analysis'] : ['instruction', 'analysis'], explanation: options.explanation ?? 'The amount names the supplied exercise threshold; the wording supplies no transaction.', citations: sources.map(source => ({ exhibitId: source.exhibitId, paragraph: 1 })), recordCitations: [] }
  return parseGroundingReview(JSON.stringify({ findings: [finding] }), [{ id: unitId, text }], sources, '', undefined, { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('approved thresholds in advocate presentation grammar', () => {
  it.each([
    [heading, true], [heading.replaceAll('-', ' '), true], [heading.replace('on', ':'), true],
    [burden, false], [burden.replaceAll('-', ' '), false], [burden.replace('Defence submits that ', ''), false],
    [elements, false], [elements.replace('establish', 'prove'), false],
  ] as const)('recognizes only the local exercise benchmark in %s', (text, title) => {
    expect(check(text, { title }).errors).toEqual([])
  })

  it.each([[heading, true], [burden, false], [elements, false]] as const)('requires the actual threshold and current model for %s', (text, title) => {
    expect(check(text.replace('$1,500', '$1,600'), { title }).status).toBe('failed')
    expect(check(text.replace('$1,500', 'USD $1,500'), { title }).status).toBe('failed')
    expect(check(text, { title, approved: [] }).status).toBe('failed')
    expect(check(text, { title, approved: [approved[0], { ...approved[0], issueId: 'other' }] }).status).toBe('failed')
    expect(check(text, { title, events: [{ ...instruction, payload: { ...instruction.payload, withheld: true } }] }).status).toBe('failed')
    const changed = { ...instruction, eventId: 'later', payload: { ...instruction.payload, issueInstructions: [{ ...approved[0], elements: [{ label: approved[0].elements[0].label.replace('$1,500', '$1,600') }] }] } }
    expect(check(text, { title, events: [instruction, changed] }).status).toBe('failed')
    expect(check(text, { title, events: [instruction], approved: [] }).errors).toEqual([])
  })

  it.each([burden, elements])('does not hide a neighboring factual payment of the same benchmark amount: %s', text => {
    const source = 'The report records a payment of $8,200.'
    expect(check(`${text} The report records a payment of $8,200 (E-001).`, { source }).errors).toEqual([])
    const rejected = check(`${text} Arin received $1,500 (E-001).`, { source })
    expect(rejected.status).toBe('failed')
    expect(rejected.validationErrors?.some(error => error.includes('stated dollar amount'))).toBe(true)
    expect(check(`${text} Arin received $1,500 (E-001).`, { source: `${source} Arin received $1,500.` }).errors).toEqual([])
  })

  it('does not recognize operative captions, source quotations or factual findings as exercise instructions', () => {
    expect(check(heading.replace('proposed', 'operative'), { title: true }).status).toBe('failed')
    expect(check(`${heading}; Arin received $1,500.`, { title: true }).status).toBe('failed')
    const source = 'The report records a payment of $8,200.'
    for (const text of [`The report states “${burden}” (E-001).`, `The report states “${elements}” (E-001).`, elements.replace('must establish', 'establishes')]) {
      expect(check(text, { source }).status).toBe('failed')
    }
  })

  it('preserves independent semantic rejection in otherwise recognized grammar', () => {
    const explanation = 'The draft adds an unsupported independent corroboration requirement.'
    const review = check(`${elements} Independent corroboration is a separate required element.`, { status: 'unsupported', explanation })
    expect(review.status).toBe('failed')
    expect(review.findings[0]).toMatchObject({ status: 'unsupported', explanation })
  })

  it.each(['operative count has', 'filed charge requires', 'charged count requires', 'actual criminal count requires'])('keeps an actual charge amount outside the exercise exemption: %s', status => {
    const draft = `The evidence must establish the ${status} subject-matter value exceeding $1,500.`
    const rejected = check(draft, { source: 'The report records a transfer of $8,200.' })
    expect(rejected.status).toBe('failed')
    expect(rejected.validationErrors?.some(error => error.includes('stated dollar amount'))).toBe(true)
    // Matching source support can establish the reported amount; setup cannot.
    const source = `The report records that the ${status} subject-matter value exceeding $1,500.`
    expect(check(draft, { source }).errors).toEqual([])
    expect(check(`${draft} Arin received $1,500 (E-001).`, { source: 'The report records a transfer of $8,200.' }).status).toBe('failed')
  })

  it('keeps an ordinary deprivation requirement with actual loss within the approved exercise comparison', () => {
    expect(check(elements.replace('deprivation caused by that act', 'deprivation through actual loss caused by that act')).errors).toEqual([])
  })

  it.each(['for the operative count', 'on the filed charge', 'for the charged count', 'for the actual criminal count'])('checks charge scope after the amount: %s', suffix => {
    const draft = `The evidence must establish subject-matter value exceeding $1,500 ${suffix}.`
    const rejected = check(draft, { source: 'The report records a transfer of $8,200.' })
    expect(rejected.status).toBe('failed')
    expect(rejected.validationErrors?.some(error => error.includes('stated dollar amount'))).toBe(true)
    expect(check(draft, { source: draft.replace('The evidence must establish', 'The report records') }).errors).toEqual([])
    const decimal = check(draft.replace('$1,500', '$1,500.50'), { source: 'The report records a transfer of $8,200.', approved: [{ ...approved[0], elements: [{ label: approved[0].elements[0].label.replace('$1,500', '$1,500.50') }] }] })
    expect(decimal.validationErrors?.some(error => error.includes('stated dollar amount'))).toBe(true)
  })

  it('does not extend the status guard across a separate sentence or semicolon clause', () => {
    expect(check(`${elements} Whether there is an operative count remains unresolved.`).errors).toEqual([])
    expect(check(`${elements.slice(0, -1)}; whether there is a filed charge remains unresolved.`).errors).toEqual([])
  })
})
