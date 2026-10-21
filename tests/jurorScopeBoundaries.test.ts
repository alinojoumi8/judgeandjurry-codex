import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { EvidenceItem } from '../server/types'

const source: EvidenceItem = { id: 'fictional', matterId: 'fictional', exhibitId: 'E-001', name: 'Interview', text: 'Fictional Avery states: Guaranteed 12 percent. No cash was returned to me.', type: 'text', mimeType: 'text/plain', size: 0, summary: '', tags: [], uploadedAt: '2026-01-01', sha256: null, sourceAvailable: false, ingestionStatus: 'metadata_only', extractionWarning: null, archivedAt: null }
const peer = { eventId: 'peer-04', type: 'juror_deliberation_turn', actorId: 'juror-04', payload: { contribution: 'I focus on knowledge and matched deprivation. Concrete authorized proof could change my assessment; these issues remain unresolved.' } }
const instruction = { eventId: 'instruction', type: 'judicial_instruction', actorId: 'judge', payload: { text: 'Apply the supplied exercise elements.', issueInstructions: [{ issueId: 'issue-1', elements: [{ id: 'value', label: 'The value of the subject matter exceeds $5,000' }], outcomes: ['guilty', 'not_guilty', 'no_verdict'] }] } }
const history = { actorId: 'juror-01', assessments: [{ round: 'initial', usable: true, choice: 'not_guilty' }] }
const setup = { packet: '', stage: 'jury_deliberation', actor: { id: 'juror-01' }, actorRoles: ['juror'], partyRoles: [], events: [peer, instruction], currentJuror: { actorId: 'juror-01', stage: 'jury_deliberation', proceedingPhase: 'deliberation_review', ballotRound: null, leaning: 'defence' as const, choice: 'not_guilty', confidence: 60 } }
function check(text: string, options: { records?: string[]; status?: string; citations?: Array<{ exhibitId: string; paragraph: number }>; history?: typeof history; setup?: Parameters<typeof parseGroundingReview>[5]; evidence?: EvidenceItem[] } = {}) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'supported', explanation: 'The selected record supports the bounded attribution.', citations: options.citations ?? [], recordCitations: options.records ?? [] }] }), [{ id: 'content:1', text }], options.evidence ?? [source], 'Only accurate attribution is permitted.', options.history ?? history, options.setup ?? setup)
}
const citations = [{ exhibitId: 'E-001', paragraph: 1 }]

describe('peer assessment wording', () => {
  it.each([
    'I agree with juror-04’s document-focused conclusion.',
    'I agree with juror-04’s assessment that the Crown has not met the charge beyond a reasonable doubt.',
    'I agree with juror-04’s focus on the decisive elements: conduct, deprivation, and knowledge.',
    'Juror-04 correctly focuses on subjective knowledge and matched deprivation.',
    'Juror-04 is correct that authorized proof could change the assessment.',
    'My initial not-guilty position remains stable because juror-04’s visible review supplied no concrete evidence resolving knowledge or matched deprivation.',
    'My initial not-guilty view remains because juror-04 identified no concrete evidence resolving knowledge or matched deprivation.',
  ])('uses the actual peer record for %s', text => {
    expect(check(text, { records: ['peer-04'] }).errors).toEqual([])
    expect(check(text, { records: ['peer-04'], status: 'unsupported' }).status).toBe('failed')
    expect(check(text.replace(/juror-04/gi, 'juror-05'), { records: ['peer-04'] }).status).toBe('failed')
    expect(check(text).status).toBe('failed')
  })
  it.each([
    'Juror-04 is correct that the accused received the money.',
    'Juror-04 correctly focuses on knowledge, and the accused transferred the funds.',
    'I agree with juror-04’s conclusion that the witness lied.',
    'I agree with juror-04’s conclusion; the accused had the funds.',
  ])('does not let peer agreement supply facts: %s', text => {
    expect(check(text, { records: ['peer-04'] }).status).toBe('failed')
  })
  it('requires usable matching history for the combined state and peer claim', () => {
    const text = 'My initial not-guilty view remains because juror-04 identified no concrete evidence resolving knowledge.'
    for (const own of [{ ...history, assessments: [] }, { ...history, assessments: [{ ...history.assessments[0], usable: false }] }, { ...history, assessments: [{ ...history.assessments[0], choice: 'guilty' }] }]) {
      expect(check(text, { records: ['peer-04'], history: own, status: 'analysis' }).status).toBe('failed')
    }
  })
})

describe('quotation speaker and wording boundaries', () => {
  const text = 'I agree with juror-04’s documentary point: E-001 records Avery’s specific account that the offer gave “Guaranteed 12 percent,” but it remains a disputed recorded interview (E-001).'
  it('retains a document speaker across an intervening account clause', () => {
    expect(check(text, { records: ['peer-04'], citations }).errors).toEqual([])
  })
  it('allows capitalization changes while retaining exact source text in citations', () => {
    const review = check(text.replace('Guaranteed', 'guaranteed'), { records: ['peer-04'], citations })
    expect(review.errors).toEqual([])
    expect(review.findings[0].citations[0].quote).toBe(source.text)
    expect(check('Avery’s interview records the representation “guaranteed 12 percent” (E-001).', { citations }).errors).toEqual([])
  })
  it.each(['Guaranteed 21 percent', 'Guaranteed return of 12 percent', 'Guaranteed percent'])('rejects changed source words: %s', quotation => {
    expect(check(text.replace('Guaranteed 12 percent', quotation), { records: ['peer-04'], citations }).status).toBe('failed')
  })
  it('does not use a document quotation as proof that a peer spoke it', () => {
    expect(check('E-001 records an interview, and juror-04 says “Guaranteed 12 percent” (E-001).', { records: ['peer-04'], citations }).status).toBe('failed')
    expect(check('Juror-04 quotes E-001’s interview: “Guaranteed 12 percent” (E-001).', { records: ['peer-04'], citations }).status).toBe('failed')
  })
  it('keeps the selected exhibit boundary and rejected checker judgment', () => {
    expect(check(text.replaceAll('E-001', 'E-002'), { records: ['peer-04'], citations }).status).toBe('failed')
    expect(check(text, { records: ['peer-04'], citations, status: 'unsupported' }).status).toBe('failed')
  })
})

describe('instruction thresholds and source amounts', () => {
  const text = 'E-001 reports no cash returned to Avery, but does not independently prove deception, causation, matched loss, or value exceeding $5,000 (E-001).'
  it('checks the threshold against the actual supplied element, preserving its provenance', () => {
    const review = check(text, { citations })
    expect(review.errors).toEqual([])
    expect(review.findings[0].recordCitations).toContainEqual(expect.objectContaining({ eventId: 'instruction', quote: instruction.payload.text }))
    expect(review.findings[0].explanation).toContain(instruction.payload.issueInstructions[0].elements[0].label)
  })
  it.each([
    { name: 'missing instruction', events: [peer] },
    { name: 'withheld instruction', events: [peer, { ...instruction, payload: { ...instruction.payload, withheld: true } }] },
    { name: 'wrong threshold', events: [peer, { ...instruction, payload: { ...instruction.payload, issueInstructions: [{ ...instruction.payload.issueInstructions[0], elements: [{ id: 'value', label: 'The value exceeds $6,000' }] }] } }] },
    { name: 'ambiguous issues', events: [peer, { ...instruction, payload: { ...instruction.payload, issueInstructions: [instruction.payload.issueInstructions[0], { ...instruction.payload.issueInstructions[0], issueId: 'issue-2' }] } }] },
    { name: 'superseded instruction', events: [peer, instruction, { ...instruction, eventId: 'new-instruction', payload: { ...instruction.payload, issueInstructions: [] } }] },
    { name: 'duplicate event ID', events: [peer, instruction, instruction] },
    { name: 'peer masquerading as instruction', events: [peer, { ...instruction, type: 'juror_deliberation_turn' }] },
  ])('rejects $name', ({ events }) => {
    expect(check(text, { citations, setup: { ...setup, events } }).status).toBe('failed')
  })
  it.each([
    'E-001 proves that Avery lost $5,000.',
    'E-001 proves value exceeding $5,000.',
    'E-001 records a $5,000 payment but does not prove value exceeding $5,000.',
    'E-001 does not prove a $5,000 payment.',
    'E-001 does not prove value below $5,000.',
    'E-001 does not prove value exceeding $5,000 million.',
  ])('does not substitute an instruction for a transaction or different comparison: %s', claim => {
    expect(check(claim, { citations }).status).toBe('failed')
  })
  it('retains missing source and rejected meaning failures', () => {
    expect(check(text).status).toBe('failed')
    expect(check(text, { citations, status: 'contradicted' }).status).toBe('failed')
  })
  it('keeps an independently quoted transaction amount separate from the threshold', () => {
    const evidence = [{ ...source, text: 'Fictional Avery states: I paid $300 for the goods.' }]
    const claim = 'E-001 records a $300 payment but does not prove value exceeding $5,000.'
    expect(check(claim, { citations, evidence }).errors).toEqual([])
    expect(check(claim.replace('$300', '$400'), { citations, evidence }).status).toBe('failed')
  })
})
