import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import type { GroundingRecordEvent } from '../server/groundingRecords'

const source = { ...supportedOpeningSource, exhibitId: 'E-001', text: 'The report records $3,445.15 spent on research. Its findings depend on information supplied during the investigation.' }
const peer: GroundingRecordEvent = { eventId: 'peer-one', type: 'juror_deliberation_turn', actorId: 'juror-01', payload: { contribution: 'I give E-001 limited weight. Its figures need reconciliation and do not resolve knowledge or matched deprivation.' } }
const instruction: GroundingRecordEvent = { eventId: 'instruction-one', type: 'judicial_instruction', actorId: 'judge', payload: {
  text: 'Each accused and count verdict-sheet item requires 12 valid, unanimous final ballots. The Crown bears the burden on every element beyond a reasonable doubt.',
  issueInstructions: [{ elements: [{ label: 'The value of the subject matter exceeds $5,000', burden: 'Crown must prove beyond a reasonable doubt' }] }],
} }
const initial = { round: 'initial', usable: true, choice: 'not_guilty' }
const current = { actorId: 'juror-02', stage: 'juror_ballot', proceedingPhase: 'deliberation_review', ballotRound: 'final', choice: 'not_guilty', leaning: 'defence' as const, confidence: 70 }
type Options = { status?: string; records?: string[]; cite?: boolean; events?: GroundingRecordEvent[]; history?: typeof initial[]; actorId?: string; choice?: string; source?: string }
function check(text: string, options: Options = {}) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'supported', explanation: 'Checked against the actual selected record and present assessment.', citations: options.cite ? [{ exhibitId: 'E-001', paragraph: 1 }] : [], recordCitations: options.records ?? ['peer-one'] }] }),
    [{ id: 'content:1', text }], [{ ...source, text: options.source ?? source.text }], '', { actorId: options.actorId ?? current.actorId, assessments: options.history ?? [initial] },
    { packet: '', actor: { id: current.actorId }, actorRoles: ['juror'], partyRoles: [], stage: current.stage, ballotRound: current.ballotRound, currentJuror: { ...current, choice: options.choice ?? current.choice }, events: options.events ?? [instruction, peer] })
}

describe('peer assessments retain their actual support domain', () => {
  const cases = [
    "I agree with Juror-01's caution about E-001.",
    'I agree with juror-01’s source-specific caution about E-001, but not its broader weight.',
    'I agree with juror-01 that the June correspondence has limited value on the proposed issue.',
    'Juror-01’s final review credited E-001 only for limited purposes; I agree with that treatment.',
    'Juror-01 (record:2) has raised a visible challenge to the Crown case in this round, and I address that challenge below.',
  ]
  it.each(cases)('accepts a checked peer assessment without an exhibit quote: %s', text => {
    expect(check(text).errors).toEqual([])
    expect(check(text, { records: [] }).status).toBe('failed')
    expect(check(text, { status: 'unsupported' }).status).toBe('failed')
    expect(check(text, { events: [instruction, { ...peer, actorId: 'juror-03' }] }).status).toBe('failed')
  })
  it.each([
    "I agree with Juror-01's caution about E-001 because Avery stole the money.",
    "I agree with Juror-01's conclusion that Avery received $5,000.",
    "Juror-01's final review established that E-001 proves knowledge; I agree with that treatment.",
    'I agree with juror-01 that the June correspondence proves Avery paid the money.',
  ])('does not turn peer agreement into evidence: %s', text => expect(check(text).status).toBe('failed'))
})

describe('own state and procedural clauses', () => {
  const cases = [
    'My not-guilty position stands under the Crown’s burden.',
    'Per the judge\'s instruction that each accused and count verdict-sheet item requires 12 valid, unanimous final ballots, the Crown bears the burden on every element; I do not alter my initial assessment.',
    'My not-guilty position, consistent with my usable initial ballot, is unchanged; matched transaction evidence tying receipts to unpaid investors, or evidence of Avery’s state of mind, would change it.',
  ]
  it.each(cases)('uses matching own history and the actual instruction: %s', text => {
    expect(check(text, { records: ['instruction-one'] }).errors).toEqual([])
    for (const history of [[], [{ ...initial, usable: false }], [{ ...initial, choice: 'guilty' }], [initial, initial]]) {
      expect(check(text, { history, records: ['instruction-one'] }).status).toBe('failed')
    }
    expect(check(text, { status: 'contradicted', records: ['instruction-one'] }).status).toBe('failed')
    expect(check(text, { actorId: 'juror-03', records: ['instruction-one'] }).status).toBe('failed')
    expect(check(text, { choice: 'guilty', records: ['instruction-one'] }).status).toBe('failed')
  })
  it('does not invent or alter a procedural rule', () => {
    for (const text of [cases[0], cases[1]]) {
      expect(check(text, { records: [], events: [peer] }).status).toBe('failed')
      expect(check(text, { records: ['instruction-one'], events: [instruction, instruction] }).status).toBe('failed')
    }
    expect(check(cases[1].replace('12 valid', '10 valid'), { records: ['instruction-one'] }).status).toBe('failed')
    expect(check(cases[0].replace('.', ', because Avery paid the money.'), { records: ['instruction-one'] }).status).toBe('failed')
  })
  it('reads a structured Crown burden without requiring it in the instruction summary', () => {
    const structured = { ...instruction, payload: { ...instruction.payload, text: 'Every accused/count verdict-sheet item requires 12 valid, unanimous final ballots.' } }
    expect(check(cases[0], { records: [], events: [structured] }).errors).toEqual([])
    expect(check(cases[1], { records: ['instruction-one'], events: [structured] }).errors).toEqual([])
    const different = { ...structured, payload: { ...structured.payload, issueInstructions: [{ elements: [{ label: 'Value', burden: 'Defence must disprove the allegation' }] }] } }
    expect(check(cases[0], { records: [], events: [different] }).status).toBe('failed')
  })
  it('requires all usable contributions for a claim about the whole visible discussion', () => {
    const text = 'My position stays stable because no visible contribution adds matched transaction evidence or a specific foundation proving Avery’s knowledge.'
    const second = { ...peer, eventId: 'peer-three', actorId: 'juror-03' }
    expect(check(text, { events: [instruction, peer, second], records: ['peer-one', 'peer-three'] }).errors).toEqual([])
    expect(check(text, { events: [instruction, peer, second], records: ['peer-one'] }).errors.join(' ')).toContain('every usable visible contribution')
    expect(check(text, { history: [], records: ['peer-one'] }).status).toBe('failed')
    expect(check(text, { status: 'contradicted' }).status).toBe('failed')
  })
  it('requires the actual Crown reply and matching own history for a causal explanation', () => {
    const reply: GroundingRecordEvent = { eventId: 'reply', type: 'public_submission', actorId: 'crown', payload: { text: 'The Crown still cannot establish matched deprivation or knowledge on this record.' } }
    const text = 'My position remains stable because the Crown reply supplies no matched transaction evidence or specific foundation proving Avery’s knowledge.'
    const evaluate = (records: string[], history = [initial], role = 'crown') => parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', explanation: 'Checked against the reply and own history.', citations: [], recordCitations: records }] }), [{ id: 'content:1', text }], [source], '', { actorId: current.actorId, assessments: history }, { packet: '', actor: { id: current.actorId }, actorRoles: ['juror'], currentJuror: current, stage: current.stage, partyRoles: [{ id: 'crown', role }], events: [reply] })
    expect(evaluate(['reply']).errors).toEqual([])
    expect(evaluate([]).status).toBe('failed')
    expect(evaluate(['reply'], []).status).toBe('failed')
    expect(evaluate(['reply'], [initial], 'defence').status).toBe('failed')
  })
  it.each([
    'I have no usable earlier ballot; my present not-guilty assessment is independent.',
    'No usable initial ballot exists, so I am recording a present not-guilty assessment rather than claiming continuity with an earlier position.',
  ])('distinguishes unusable history from no recorded history: %s', text => {
    expect(check(text, { records: [], history: [{ ...initial, usable: false }] }).errors).toEqual([])
    expect(check(text, { records: [], history: [initial] }).status).toBe('failed')
    expect(check(text, { records: [], history: [], choice: 'guilty' }).status).toBe('failed')
  })
})

describe('source amounts and instruction thresholds in one assessment', () => {
  const text = 'The report records $3,445.15 spent on research, but it does not connect any dishonest representation to Avery’s knowledge or to a matched deprivation exceeding $5,000 [E-001].'
  it('preserves the source amount while binding the assessment threshold to its instruction', () => {
    const result = check(text, { cite: true, records: [] })
    expect(result.errors).toEqual([])
    expect(result.findings[0].recordCitations?.map(c => c.eventId)).toContain('instruction-one')
  })
  it.each([
    text.replace('$5,000', '$6,000'), text.replace('$3,445.15', '$4,445.15'),
    text.replace('does not connect', 'connects'), text.replace('exceeding', 'at least'),
    `${text} Avery received $5,000.`,
  ])('does not exempt factual amounts, wrong thresholds or changed operators: %s', value => expect(check(value, { cite: true, records: [] }).status).toBe('failed'))
  it('requires the current unique instruction', () => {
    for (const events of [[peer], [instruction, instruction], [{ ...instruction, payload: { ...instruction.payload, withheld: true } }], [instruction, { ...instruction, eventId: 'new', payload: { text: 'No threshold is supplied.' } }]]) {
      expect(check(text, { cite: true, records: [], events }).status).toBe('failed')
    }
  })
  it('keeps an explicitly unresolved element-threshold question separate from a payment', () => {
    const question = 'The report records $3,445.15 spent on research; whether any element amount above $5,000 is tied to Avery on this record is a question I still cannot answer.'
    expect(check(question, { cite: true, records: [] }).errors).toEqual([])
    expect(check(question, { cite: true, records: [], events: [peer] }).status).toBe('failed')
    expect(check(question.replace('$5,000', '$6,000'), { cite: true, records: [] }).status).toBe('failed')
    expect(check(question.replace('is a question I still cannot answer', 'is established'), { cite: true, records: [] }).status).toBe('failed')
  })
})

describe('quotations after peer agreement', () => {
  it.each(['"B"', '“B”', "'B'"])('does not pair the closing quote of a short label with the next quotation: %s', label => {
    const text = `Counsel states the ${label} account figure is "a separate internal ledger" [E-001].`
    const quoted = 'The "B" account is a separate internal ledger. Actual transfers were recorded elsewhere.'
    expect(check(text, { cite: true, records: [], source: quoted }).errors).toEqual([])
    expect(check(text.replace('a separate internal ledger', 'an external bank account'), { cite: true, records: [], source: quoted }).status).toBe('failed')
    expect(check(text.replace('[E-001]', '[E-002]'), { cite: true, records: [], source: quoted }).status).toBe('failed')
  })
  const text = 'On Juror-01’s narrow reading, I agree about E-001: Example Markets’ counsel writes, “Actual deposits were $8,000” and states “Withdrawals covered fees” [E-001].'
  const quoted = 'Actual deposits were $8,000. Withdrawals covered fees.'
  it('binds the explicitly introduced document words to that document', () => {
    expect(check(text, { cite: true, source: quoted }).errors).toEqual([])
    expect(check(text, { cite: true, source: quoted, records: [] }).status).toBe('failed')
    expect(check(text, { source: quoted }).status).toBe('failed')
  })
  it.each([text.replace('were $8,000', 'were $9,000'), text.replace('Withdrawals covered fees', 'Withdrawals were refunds'), text.replace('Example Markets’ counsel writes', 'Juror-01 writes')])('retains actual misquotations and wrong speakers: %s', value => {
    expect(check(value, { cite: true, source: quoted }).status).toBe('failed')
  })
  it('keeps a preceding sentence locator out of the next quoted source', () => {
    const unit = 'The interview remains disputed. [E-002 paragraphs 1–2] The report states: “Actual deposits were $8,000.” [E-001 paragraph 1]'
    const evaluate = (text: string) => parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', explanation: 'Separate source statements.', citations: [{ exhibitId: 'E-001', paragraph: 1 }, { exhibitId: 'E-002', paragraph: 1 }] }] }), [{ id: 'content:1', text }], [{ ...source, text: quoted }, { ...source, exhibitId: 'E-002', text: 'The disputed interview describes an automated platform.' }])
    expect(evaluate(unit).errors).toEqual([])
    expect(evaluate(unit.replace('[E-001 paragraph 1]', '[E-002 paragraph 1]')).status).toBe('failed')
    expect(evaluate('[E-002 paragraph 1] records “Actual deposits were $8,000.”').status).toBe('failed')
  })
})
