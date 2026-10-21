import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const source = { ...supportedOpeningSource, exhibitId: 'E-001', text: 'The fictional email records deposits of $8,000 and fees of $120.' }
const instruction: GroundingRecordEvent = { eventId: 'instruction', type: 'judicial_instruction', actorId: 'judge', payload: {
  text: 'Use these proposed exercise requirements.', issueInstructions: [{ elements: [
    { label: 'A dishonest act', burden: 'Beyond a reasonable doubt' },
    { label: 'Deprivation or risk of loss', burden: 'Beyond a reasonable doubt' },
    { label: 'Subjective knowledge of the act', burden: 'Beyond a reasonable doubt' },
    { label: 'Knowledge of risk', burden: 'Beyond a reasonable doubt' },
    { label: 'The value of the subject matter exceeds $5,000', burden: 'Beyond a reasonable doubt' },
  ] }],
} }
const peer: GroundingRecordEvent = { eventId: 'peer-08', type: 'juror_deliberation_turn', actorId: 'juror-08', payload: {
  contribution: 'I give E-001 limited weight. My evidentiary concerns about attribution, knowledge, deprivation and value remain unresolved.',
} }
const initial = { round: 'initial', choice: 'not_guilty', usable: true }
const current: NonNullable<NonNullable<Parameters<typeof parseGroundingReview>[5]>['currentJuror']> = { actorId: 'juror-01', stage: 'jury_deliberation', proceedingPhase: 'deliberation_review', ballotRound: null, leaning: 'defence', choice: 'not_guilty', confidence: 60 }
type Options = { status?: string; records?: string[]; events?: GroundingRecordEvent[]; history?: typeof initial[]; actorId?: string; current?: typeof current; citations?: boolean }
function check(text: string, options: Options = {}) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'supported',
    explanation: 'The selected actual record supports this bounded assessment.', recordCitations: options.records ?? ['peer-08'],
    citations: options.citations ? [{ exhibitId: 'E-001', paragraph: 1 }] : [],
  }] }), [{ id: 'content:1', text }], [source], '', { actorId: options.actorId ?? 'juror-01', assessments: options.history ?? [initial] },
  { packet: '', stage: options.current?.stage ?? current.stage, actor: { id: 'juror-01' }, actorRoles: ['juror'], partyRoles: [], events: options.events ?? [instruction, peer], currentJuror: options.current ?? current })
}

describe('peer influence distinguishes descriptions, choices and explicit continuity', () => {
  const present = [
    'Juror-08’s concern reinforces my exhibit-by-exhibit position.',
    'Juror-08 reinforced my documentary concern without supplying verified evidence resolving attribution, knowledge, deprivation, or value.',
    'Juror-08 identified the same unresolved elements without supplying admitted evidence that would alter my present Defence assessment.',
    'I agree with Juror-08’s focus on the limit of E-001.',
  ]
  it.each(present)('accepts the actual peer and current state without inventing history: %s', text => {
    expect(check(text).errors).toEqual([])
    expect(check(text, { history: [] }).status).toBe('passed')
  })
  it.each(present)('requires the selected actual usable peer: %s', text => {
    expect(check(text, { records: [] }).status).toBe('failed')
    expect(check(text, { events: [instruction, { ...peer, actorId: 'juror-02' }] }).status).toBe('failed')
    expect(check(text, { events: [instruction, { ...peer, payload: { ...peer.payload, withheld: true } }] }).status).toBe('failed')
    expect(check(text, { status: 'unsupported' }).status).toBe('failed')
  })
  const stable = 'Juror-08 reinforced my evidentiary concerns without supplying a specific fact resolving knowledge, deception-linked deprivation, or value, so my position remains stable.'
  it('requires actual matching usable history for a compound stability explanation', () => {
    expect(check(stable).errors).toEqual([])
    for (const history of [[], [{ ...initial, usable: false }], [{ ...initial, choice: 'guilty' }], [initial, initial]]) {
      expect(check(stable, { history }).status).toBe('failed')
    }
  })
  it.each([
    present[0].replace('exhibit-by-exhibit', 'guilty'),
    present[0].replace('exhibit-by-exhibit', 'initial guilty'),
    present[0].replace('reinforces', 'previously reinforced'),
    present[1].replace('resolving attribution, knowledge, deprivation, or value', 'at all'),
    present[2].replace('Defence', 'Crown'),
    present[3].replace('E-001', 'E-999'),
    present[3].replace('.', ', and Avery received the money.'),
    present[1].replace('.', ' because Avery stole the money.'),
  ])('does not exempt conflicting choices or new factual claims: %s', text => {
    expect(check(text).status).toBe('failed')
  })
})

describe('absence of usable history is different from absence of recorded history', () => {
  const noUsable = 'No usable initial ballot exists, so I am recording a present not-guilty assessment rather than claiming continuity with an earlier position.'
  it.each([{ history: [] }, { history: [{ ...initial, choice: 'requires_reassessment', usable: false }] }])('accepts the actual lack of usable initial state: %j', ({ history }) => {
    expect(check(noUsable, { history, records: [] }).errors).toEqual([])
  })
  it.each([
    { name: 'usable initial', history: [initial] },
    { name: 'wrong current choice', history: [], current: { ...current, choice: 'guilty', leaning: 'crown' as const } },
    { name: 'another actor', history: [], actorId: 'juror-02' },
  ])('rejects $name', options => {
    expect(check(noUsable, options).status).toBe('failed')
  })
  it('accepts a no-prior-comparison initial statement only with explicitly empty own history', () => {
    const text = 'No initial ballot was supplied, so no prior assessment or actual change can be assessed.'
    const first = { ...current, stage: 'juror_ballot', ballotRound: 'initial' }
    expect(check(text, { current: first, history: [], records: [] }).errors).toEqual([])
    expect(check(text, { current: first, history: [{ ...initial, usable: false }], records: [] }).status).toBe('failed')
  })
  it('does not grant a negative checker judgment or appended facts a history exemption', () => {
    expect(check(noUsable, { history: [], status: 'contradicted' }).status).toBe('failed')
    expect(check(noUsable.replace('.', ', because the witness lied.'), { history: [] }).status).toBe('failed')
    expect(check('My initial not-guilty assessment remains stable.', { history: [{ ...initial, usable: false }] }).status).toBe('failed')
  })
})

describe('proposed instruction thresholds are not amounts attributed to an exhibit', () => {
  const requirement = 'For the proposed Avery fraud issue, the Crown must prove a dishonest act, deprivation, subjective knowledge, risk knowledge, and value over $5,000 beyond a reasonable doubt [record:1].'
  const limitation = 'The email reports deposits and fees but does not itself establish dishonesty, knowledge, deprivation, or a matched loss over $5,000 [E-001].'
  const unresolved = 'Those limits leave control, matched loss, and the $5,000 value unresolved [E-001].'
  it('resolves a proposed instruction reference without treating it as evidence', () => {
    const result = check(requirement, { records: ['record:1'] })
    expect(result.errors).toEqual([])
    expect(result.findings[0].status).toBe('analysis')
    expect(result.findings[0].recordCitations?.[0].eventId).toBe('instruction')
  })
  it.each([limitation, unresolved])('keeps the instruction threshold separate from quoted transaction amounts: %s', text => {
    const result = check(text, { records: [], citations: true })
    expect(result.errors).toEqual([])
    expect(result.findings[0].recordCitations?.[0].eventId).toBe('instruction')
    expect(check(text.replace('$5,000', '$6,000'), { records: [], citations: true }).status).toBe('failed')
  })
  it.each([
    { name: 'absent', events: [peer] },
    { name: 'withheld', events: [{ ...instruction, payload: { ...instruction.payload, withheld: true } }, peer] },
    { name: 'duplicate', events: [instruction, instruction, peer] },
    { name: 'superseded', events: [instruction, { ...instruction, eventId: 'later', payload: { text: 'No threshold is supplied.' } }, peer] },
  ])('does not infer a threshold from $name instruction', options => {
    expect(check(limitation, { ...options, records: [], citations: true }).status).toBe('failed')
    expect(check(requirement, { ...options, records: ['instruction'] }).status).toBe('failed')
  })
  it.each([
    requirement.replace('proposed', 'operative'),
    requirement.replace('must prove', 'proved'),
    requirement.replace('over', 'at least'),
    limitation.replace('does not itself establish', 'establishes'),
    limitation.replace('.', '; Avery received $5,000.'),
    unresolved.replace('unresolved', 'proved'),
  ])('does not use an instruction to establish money or a charge: %s', text => {
    expect(check(text, { records: ['instruction'], citations: true }).status).toBe('failed')
  })
})
