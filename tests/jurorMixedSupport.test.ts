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

describe('mixed support domains', () => {
  it.each([
    'My final position remains with the Defence, and it matches my initial ballot.',
    'My not-guilty position remains stable because my own element-by-element reading leaves each required element unproved.',
  ])('requires the actual usable history for an assessment explanation: %s', text => {
    expect(check(text, { status: 'analysis', records: [] }).errors).toEqual([])
    for (const history of [[], [{ ...initial, usable: false }], [{ ...initial, choice: 'guilty' }], [initial, initial]]) expect(check(text, { status: 'analysis', records: [], history }).status).toBe('failed')
  })
  it.each([
    'No usable earlier ballot was supplied, so my position is an independent assessment: specific proof resolving knowledge could change it.',
    'No usable earlier ballot of mine was supplied for this issue, so my position is an independent assessment; juror-01’s emphasis on quantified records is consistent with it without changing it.',
  ])('separates unusable history from a recorded successful ballot: %s', text => {
    expect(check(text, { status: 'analysis', history: [{ ...initial, usable: false }] }).errors).toEqual([])
    expect(check(text, { status: 'analysis' }).status).toBe('failed')
    expect(check(text, { status: 'analysis', actorId: 'juror-03', history: [] }).status).toBe('failed')
  })
  it('rejects a written stable choice that conflicts with otherwise matching history', () => {
    expect(check('My guilty position remains stable because my own review supports it.', { status: 'analysis', records: [] }).status).toBe('failed')
    expect(check('My position remains with the Crown, and it matches my initial ballot.', { status: 'analysis', records: [] }).status).toBe('failed')
  })
  it('still requires every visible contribution for a mixed stability/peer claim', () => {
    const text = 'My position remains stable; juror-01 read E-001 narrowly, and no visible turn supplied proof resolving my knowledge doubts.'
    const other = { ...peer, eventId: 'peer-three', actorId: 'juror-03' }
    expect(check(text, { status: 'analysis', events: [instruction, peer, other], records: ['peer-one', 'peer-three'] }).errors).toEqual([])
    expect(check(text, { status: 'analysis', events: [instruction, peer, other] }).status).toBe('failed')
  })
  it.each([
    'I agree with juror-01’s documentary approach.',
    'Juror-01, I credit your distinction between quantified receipts and proof.',
    'Nothing in juror-01’s visible contribution resolves representation, knowledge, matched loss, or value.',
  ])('binds peer evaluations to their own contribution: %s', text => {
    expect(check(text).errors).toEqual([])
    expect(check(text, { records: [] }).status).toBe('failed')
    expect(check(text, { records: ['instruction-one'] }).status).toBe('failed')
    expect(check(text, { status: 'unsupported' }).status).toBe('failed')
  })
})

describe('document quotation boundaries after peer attribution', () => {
  const evidence = [{ ...source, text: 'Suspected investors were not interviewed during the investigation.' }, { ...source, exhibitId: 'E-002', text: 'Avery said: They told me guaranteed twenty percent.' }]
  const checkQuotes = (text: string, records = ['peer-one'], events = [instruction, peer]) => parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', explanation: 'Verify each clause against its own source.', citations: evidence.map(e => ({ exhibitId: e.exhibitId, paragraph: 1 })), recordCitations: records }] }), [{ id: 'content:1', text }], evidence, '', { actorId: current.actorId, assessments: [initial] }, { packet: '', actor: { id: current.actorId }, actorRoles: ['juror'], partyRoles: [], stage: current.stage, currentJuror: current, events })
  it.each(['defines', 'labels', 'describes'])('keeps a document %s clause out of the earlier peer quote', verb => {
    const text = `Responding to juror-01’s point: E-001 itself ${verb} “Suspected investors” as people who were “not interviewed during the investigation” (E-001).`
    expect(checkQuotes(text).errors).toEqual([])
    expect(checkQuotes(text.replace('not interviewed', 'interviewed twice')).status).toBe('failed')
    expect(checkQuotes(text.replaceAll('E-001', 'E-002')).status).toBe('failed')
    expect(checkQuotes(text, []).status).toBe('failed')
    expect(checkQuotes(text.replace(`E-001 itself ${verb}`, 'juror-01 says')).status).toBe('failed')
  })
  it('binds coordinated quotations separately and retains an unresolved instruction threshold', () => {
    const text = 'Because E-001 states investors were “not interviewed during the investigation,” and because Avery’s recorded account attributes a promise of “guaranteed twenty percent” (E-002), I still doubt representation, knowledge, deprivation, and value exceeding $5,000.'
    expect(checkQuotes(text, []).errors).toEqual([])
    for (const changed of [text.replace('E-002', 'E-001'), text.replace('twenty percent', 'thirty percent'), text.replace('$5,000', '$6,000'), text.replace('exceeding', 'at least'), text.replace('I still doubt', 'I find proved')]) expect(checkQuotes(changed, []).status).toBe('failed')
    expect(checkQuotes(text, [], [peer]).status).toBe('failed')
  })
  it('does not clear a separate factual payment when a threshold matches', () => {
    const text = 'I still doubt value exceeding $5,000, but Avery received $5,000.'
    expect(checkQuotes(text, []).status).toBe('failed')
  })
})
