import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { EvidenceItem } from '../server/types'

const peer = { eventId: 'peer-04', type: 'juror_deliberation_turn', actorId: 'juror-04', payload: { contribution: 'I credit the recorded rate and dated entries, but knowledge, deception, matched deprivation, and value remain unresolved.' } }
const instruction = { eventId: 'instruction', type: 'judicial_instruction', actorId: 'judge', payload: { text: 'The Crown must prove every required element beyond a reasonable doubt.' } }
const source: EvidenceItem = { id: 'source', matterId: 'fictional', exhibitId: 'E-001', name: 'Fictional interview', text: 'Fictional Avery states: Guaranteed 12 percent. The accounts remain disputed.', type: 'text', mimeType: 'text/plain', size: 0, summary: '', tags: [], uploadedAt: '2026-01-01', sha256: null, sourceAvailable: false, ingestionStatus: 'metadata_only', extractionWarning: null, archivedAt: null }
const history = { actorId: 'juror-01', assessments: [{ round: 'initial', usable: true, choice: 'not_guilty' }] }
const setup = { packet: '', stage: 'jury_deliberation', actor: { id: 'juror-01' }, actorRoles: ['juror'], partyRoles: [], events: [peer, instruction], currentJuror: { actorId: 'juror-01', stage: 'jury_deliberation', proceedingPhase: 'deliberation_review', ballotRound: null, leaning: 'defence' as const, choice: 'not_guilty', confidence: 60 } }
function check(text: string, options: { records?: string[]; status?: string; citations?: Array<{ exhibitId: string; paragraph: number }>; history?: typeof history; setup?: Parameters<typeof parseGroundingReview>[5] } = {}) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'supported', explanation: 'The selected source or visible contribution supports the attributed clause.', citations: options.citations ?? [], recordCitations: options.records ?? [] }] }), [{ id: 'content:1', text }], [source], 'Only accurate attribution is permitted.', options.history ?? history, options.setup ?? setup)
}

describe('prior assessment denials', () => {
  const text = 'No earlier juror-01 assessment was supplied, so this initial position establishes my baseline.'
  const initial = { ...setup, stage: 'juror_ballot', currentJuror: { ...setup.currentJuror, stage: 'juror_ballot', ballotRound: 'initial' }, events: [instruction] }
  it('accepts a denial against explicitly empty own history', () => {
    expect(check(text, { status: 'analysis', history: { ...history, assessments: [] }, setup: initial }).errors).toEqual([])
  })
  it.each([history, { ...history, assessments: [{ ...history.assessments[0], usable: false }] }, { ...history, actorId: 'juror-02', assessments: [] }])('rejects a false or differently owned denial', own => {
    expect(check(text, { status: 'analysis', history: own, setup: initial }).status).toBe('failed')
  })
  it('does not excuse an invented affirmative argument or appended claim', () => {
    for (const claim of ['Juror-01’s earlier assessment established receipt.', `${text} Juror-05 previously argued receipt was proved.`]) {
      expect(check(claim, { status: 'analysis', history: { ...history, assessments: [] }, setup: initial }).status).toBe('failed')
    }
  })
})

describe('mixed source and instruction support', () => {
  const text = 'E-001 records disputed interview accounts; these sources do not resolve every required element beyond a reasonable doubt.'
  const citations = [{ exhibitId: 'E-001', paragraph: 1 }]
  it('keeps both the verified document and actual instruction on a supported mixed unit', () => {
    const result = check(text, { records: ['instruction'], citations })
    expect(result.errors).toEqual([])
    expect(result.findings[0].recordCitations?.[0].eventId).toBe('instruction')
    expect(result.findings[0].citations[0].exhibitId).toBe('E-001')
  })
  it.each([{ citations: [] }, { citations: [{ exhibitId: 'E-999', paragraph: 1 }] }, { citations: [{ exhibitId: 'E-001', paragraph: 99 }] }])('does not substitute the instruction for missing factual support', invalid => {
    expect(check(text, { records: ['instruction'], ...invalid }).status).toBe('failed')
  })
  it('keeps a rejected factual judgment rejected despite real citations', () => {
    expect(check(text, { records: ['instruction'], citations, status: 'unsupported' }).status).toBe('failed')
  })
  it('does not use the instruction as a peer contribution', () => {
    expect(check('Juror-04 said E-001 records disputed accounts.', { records: ['instruction'], citations }).status).toBe('failed')
  })
  it('checks each quotation against its document or instruction', () => {
    const mixed = 'E-001 states “Guaranteed 12 percent”; the instruction says “The Crown must prove every required element beyond a reasonable doubt.”'
    expect(check(mixed, { records: ['instruction'], citations }).errors).toEqual([])
    expect(check(mixed.replace('Crown must', 'Defence must'), { records: ['instruction'], citations }).status).toBe('failed')
  })
})

describe('document quotation scope in peer replies', () => {
  const citations = [{ exhibitId: 'E-001', paragraph: 1 }]
  const replies = [
    'Juror-04’s proof point is persuasive insofar as Avery’s recorded interview states, “Guaranteed 12 percent,” while the accounts remain disputed (E-001).',
    'Responding to juror-04’s point about the chronology, I credit the specific recorded statement, “Guaranteed 12 percent,” in Avery’s disputed interview (E-001).',
  ]
  it.each(replies)('checks the explicitly attributed document quotation: %s', text => {
    expect(check(text, { records: ['peer-04'], citations }).errors).toEqual([])
  })
  it.each(replies)('rejects an altered document quotation in the same reply: %s', text => {
    expect(check(text.replace('12 percent', '15 percent'), { records: ['peer-04'], citations }).status).toBe('failed')
  })
  it('does not use a document to invent words attributed to a peer', () => {
    expect(check('Juror-04 said “Guaranteed 12 percent” (E-001).', { records: ['peer-04'], citations }).status).toBe('failed')
  })
  it('checks peer and document quotations separately within one unit', () => {
    const text = 'Juror-04 said “knowledge, deception, matched deprivation, and value remain unresolved”; Avery’s interview states “Guaranteed 12 percent” (E-001).'
    expect(check(text, { records: ['peer-04'], citations }).errors).toEqual([])
    expect(check(text.replace('remain unresolved', 'are proved'), { records: ['peer-04'], citations }).status).toBe('failed')
  })
  it('does not excuse a peer quotation following a document mention', () => {
    expect(check('The interview was discussed, and juror-04 said “Guaranteed 12 percent” (E-001).', { records: ['peer-04'], citations }).status).toBe('failed')
  })
  it('does not confuse a peer quoting a document with the document speaking', () => {
    expect(check('Juror-04 quotes the interview: “Guaranteed 12 percent” (E-001).', { records: ['peer-04'], citations }).status).toBe('failed')
  })
  it('checks present-tense peer and document quotations against their respective texts', () => {
    const text = 'Juror-04 says “knowledge, deception, matched deprivation, and value remain unresolved”; Avery’s interview states “Guaranteed 12 percent” (E-001).'
    expect(check(text, { records: ['peer-04'], citations }).errors).toEqual([])
  })
})

describe('peer agreement and own-state combinations', () => {
  const text = 'My initial not-guilty ballot remains stable because juror-04 added specificity without resolving knowledge, deception, matched deprivation, or value.'
  it('accepts a supported agreement with the actual peer proof point', () => {
    expect(check('I agree with juror-04’s concrete proof point.', { records: ['peer-04'] }).errors).toEqual([])
  })
  it('checks the own-state prefix and peer assessment against their separate records', () => {
    expect(check(text, { records: ['peer-04'] }).errors).toEqual([])
  })
  it.each([
    { ...history, assessments: [] },
    { ...history, actorId: 'juror-02' },
    { ...history, assessments: [{ ...history.assessments[0], choice: 'guilty' }] },
    { ...history, assessments: [{ ...history.assessments[0], usable: false }] },
  ])('rejects unmatched own history even when the peer reference is real', own => {
    for (const status of ['supported', 'analysis']) expect(check(text, { records: ['peer-04'], history: own, status }).status).toBe('failed')
  })
  it('rejects a changed current choice or wrong peer', () => {
    expect(check(text, { records: ['peer-04'], setup: { ...setup, currentJuror: { ...setup.currentJuror, choice: 'guilty' } } }).status).toBe('failed')
    expect(check(text.replace('juror-04', 'juror-05'), { records: ['peer-04'] }).status).toBe('failed')
  })
  it.each([
    'I agree with juror-04’s concrete proof point; the accused received $5,000.',
    'I agree with juror-04’s proof point that the accused transferred the funds.',
    `${text.slice(0, -1)}, and the accused stole the funds.`,
  ])('still demands support for added case facts: %s', claim => {
    expect(check(claim, { records: ['peer-04'] }).status).toBe('failed')
  })
  it('preserves a checker rejection of an inaccurate peer paraphrase', () => {
    expect(check(text, { records: ['peer-04'], status: 'unsupported' }).status).toBe('failed')
  })
})
