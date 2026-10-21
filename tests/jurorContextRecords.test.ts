import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'

const instruction = { eventId: 'instruction', type: 'judicial_instruction', actorId: 'judge', payload: {
  text: 'Apply the supplied exercise elements, with the burden on the Crown.',
  issueInstructions: [{ issueId: 'fictional-fraud', elements: [
    { id: 'conduct', label: 'A dishonest act', burden: 'Beyond a reasonable doubt' },
    { id: 'loss', label: 'Deprivation or risk of loss', burden: 'Beyond a reasonable doubt' },
    { id: 'knowledge', label: 'Avery’s subjective knowledge of the act and risk', burden: 'Beyond a reasonable doubt' },
    { id: 'value', label: 'The value of the subject matter exceeds $5,000', burden: 'Beyond a reasonable doubt' },
  ] }],
} }
const peer = { eventId: 'peer-04', type: 'juror_deliberation_turn', actorId: 'juror-04', payload: { contribution: 'My element-by-element caution concerns classifications and investor-specific tracing. The accounting materials do not resolve knowledge or matched loss.' } }
const other = { ...peer, eventId: 'peer-02', actorId: 'juror-02', payload: { contribution: 'I discuss the presentation order.' } }
const setup = { packet: '', stage: 'jury_deliberation', actor: { id: 'juror-01' }, actorRoles: ['juror'], partyRoles: [], events: [instruction, other, peer],
  currentJuror: { actorId: 'juror-01', stage: 'jury_deliberation', proceedingPhase: 'deliberation_challenges', ballotRound: null, leaning: 'defence' as const, choice: 'not_guilty', confidence: 60 } }
const history = { actorId: 'juror-01', assessments: [{ round: 'initial', usable: true, choice: 'not_guilty' }] }
const requirement = 'The proposed fraud issue requires proof of a dishonest act, deprivation, Avery’s knowledge, risk knowledge, and value exceeding $5,000 beyond a reasonable doubt.'
function check(text: string, options: { records?: string[]; status?: string; events?: typeof setup.events; history?: typeof history; current?: typeof setup.currentJuror } = {}) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'supported', explanation: 'The actual selected record supports the bounded statement.', citations: [], recordCitations: options.records ?? [] }] }),
    [{ id: 'content:1', text }], [], '', options.history ?? history, { ...setup, events: options.events ?? setup.events, currentJuror: options.current ?? setup.currentJuror })
}

describe('instruction-only requirements', () => {
  it.each(['supported', 'analysis'])('preserves instruction provenance with checker status %s', status => {
    const review = check(requirement, { status, records: ['instruction'] })
    expect(review.errors).toEqual([])
    expect(review.findings[0].status).toBe('analysis')
    expect(review.findings[0].citations).toEqual([])
    expect(review.findings[0].recordCitations).toEqual([{ eventId: 'instruction', actorId: 'judge', quote: instruction.payload.text }])
    expect(review.findings[0].explanation).toContain(instruction.payload.issueInstructions[0].elements[3].label)
  })
  it.each([
    { name: 'missing citation', records: [] },
    { name: 'wrong record type', records: ['peer-04'] },
    { name: 'missing record', records: ['absent'] },
    { name: 'withheld instruction', records: ['instruction'], events: [{ ...instruction, payload: { ...instruction.payload, withheld: true } }] },
    { name: 'duplicate identifier', records: ['instruction'], events: [instruction, instruction] },
    { name: 'ambiguous issues', records: ['instruction'], events: [{ ...instruction, payload: { ...instruction.payload, issueInstructions: [instruction.payload.issueInstructions[0], instruction.payload.issueInstructions[0]] } }] },
    { name: 'superseded instruction', records: ['instruction'], events: [instruction, { ...instruction, eventId: 'new', payload: { ...instruction.payload, issueInstructions: [] } }] },
  ])('does not accept $name', options => {
    expect(check(requirement, { ...options, events: options.events as typeof setup.events | undefined }).status).toBe('failed')
  })
  it.each([
    requirement.replace('$5,000', '$6,000'),
    requirement.replace('exceeding', 'below'),
    requirement.replace('exceeding', 'at least'),
    requirement.replace('The proposed', 'The operative'),
    requirement.replace('requires proof of', 'establishes'),
    'The proposed fraud issue requires proof of knowledge, and Avery received $5,000.',
  ])('does not turn a different threshold or case fact into instruction support: %s', text => {
    expect(check(text, { records: ['instruction'] }).status).toBe('failed')
  })
  it('preserves a rejected meaning judgment', () => {
    expect(check(requirement, { records: ['instruction'], status: 'unsupported' }).status).toBe('failed')
  })
})

describe('current peer assessments and references', () => {
  it.each([
    'Juror-04’s element-by-element caution is persuasive to me.',
    'Juror-04’s concern about investor-specific tracing is persuasive to me.',
    'I agree with juror-04 that the accounting materials do not resolve investor-specific tracing or subjective knowledge.',
    'I disagree with juror-04 that the accounting materials do not resolve subjective knowledge.',
  ])('uses the actual peer for %s', text => {
    expect(check(text, { records: ['peer-04'] }).errors).toEqual([])
    expect(check(text, { records: ['peer-02'] }).status).toBe('failed')
    expect(check(text, { records: ['peer-04'], status: 'unsupported' }).status).toBe('failed')
  })
  it('classifies a wrong selector as repairable without choosing or accepting a replacement', () => {
    const review = check('Juror-04’s tracing concern is persuasive to me.', { records: ['peer-02'] })
    expect(review.status).toBe('failed')
    expect(review.validationErrors?.some(error => error.includes('peer reference'))).toBe(true)
    expect(review.findings[0].recordCitations?.[0].eventId).toBe('peer-02')
    expect(review.findings[0].recordCitations?.some(c => c.eventId === 'peer-04')).toBe(false)
  })
  it.each([
    { name: 'absent peer', events: [instruction, other] },
    { name: 'withheld peer', events: [instruction, other, { ...peer, payload: { ...peer.payload, withheld: true } }] },
    { name: 'duplicate peer ID', events: [instruction, other, peer, peer] },
  ])('retains a substantive failure for $name', ({ events }) => {
    const review = check('Juror-04’s tracing concern is persuasive to me.', { records: ['peer-02'], events: events as typeof setup.events })
    expect(review.status).toBe('failed')
    expect(review.findings[0].status).toBe('unsupported')
  })
  it.each([
    'I agree with juror-04 that Avery received the money.',
    'I agree with juror-04 that the witness lied.',
    'Juror-04’s caution is persuasive to me, and Avery transferred $5,000.',
    'I agree with juror-04 that the accounting materials do not resolve knowledge because the witness lied.',
  ])('still requires factual support for %s', text => {
    expect(check(text, { records: ['peer-04'] }).status).toBe('failed')
  })
})

describe('influence explanation and actual choice history', () => {
  const text = 'Juror-04’s classification concern reinforced my position without resolving investor-specific loss or Avery’s knowledge.'
  it('permits a checked current explanation with its actual peer reference', () => {
    expect(check(text, { records: ['peer-04'], status: 'analysis' }).errors).toEqual([])
  })
  it.each([{ assessments: [] }, { assessments: [{ round: 'initial', usable: true, choice: 'guilty' }] }])('does not invent an unchanged-vote claim from current influence: %j', ({ assessments }) => {
    expect(check(text, { records: ['peer-04'], status: 'analysis', history: { ...history, assessments } }).errors).toEqual([])
  })
  it('checks an explicit present choice without imposing initial stability', () => {
    const changed = { ...history, assessments: [{ round: 'initial', usable: true, choice: 'guilty' }] }
    expect(check(text.replace('my position', 'my current not guilty position'), { records: ['peer-04'], status: 'analysis', history: changed }).errors).toEqual([])
    expect(check(text.replace('my position', 'my guilty position'), { records: ['peer-04'], status: 'analysis' }).status).toBe('failed')
  })
  it.each(['not-guilty', 'not guilty', 'not_guilty'])('checks explicit stable choice wording: %s', choice => {
    const statement = `Juror-04’s classification concern reinforced my stable ${choice} assessment without resolving knowledge.`
    expect(check(statement, { records: ['peer-04'], status: 'analysis' }).errors).toEqual([])
    expect(check(statement, { records: ['peer-04'], status: 'analysis', history: { ...history, assessments: [{ ...history.assessments[0], choice: 'guilty' }] } }).status).toBe('failed')
  })
  it.each([
    { actorId: 'juror-01', assessments: [] },
    { actorId: 'juror-02', assessments: history.assessments },
    { actorId: 'juror-01', assessments: [{ round: 'initial', usable: false, choice: 'not_guilty' }] },
    { actorId: 'juror-01', assessments: [{ round: 'initial', usable: true, choice: 'guilty' }] },
  ])('does not conceal inconsistent or unavailable history: %j', own => {
    expect(check(text.replace('my position', 'my stable position'), { records: ['peer-04'], status: 'analysis', history: own }).status).toBe('failed')
  })
})
