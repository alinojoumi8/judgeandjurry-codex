import { describe, expect, it } from 'vitest'

import { groundingUnits, ballotConsistencyUnits } from '../server/grounding'
import { validateJuryBallotContract } from '../server/juryBallotContract'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import type { StageResult } from '../server/types'

// The provider side of ballot contract v2 and juror appraisals, against a mocked
// HTTP endpoint. Scripted and fictional: this proves prompts, parsing and checks,
// not what a live model does with them.
const evidence = [{ id: 'e1', exhibitId: 'E-001', name: 'record.txt', text: 'A fictional collision occurred on a fictional road.', label: 'Record', kind: 'statement' }]
const profile = { id: 'p', sessionId: 's', juror: 'juror-01', role: 'Cognitive profile juror-01', skepticismLevel: 50, burdenSensitivity: 50, bias: 'neutral', evidenceFocus: 'x', reasoningStyle: 'x', doubtTriggers: 'x', trustAnchors: 'x', emotionalPosture: 'x', evidenceHierarchy: 'x', whatWouldChangeMind: 'x' }
const base = (extra: Record<string, unknown>) => ({ stage: 'juror_ballot', packet: 'Actor: juror-01\nDecide only claim: A fictional question.', evidence, previousTurns: '', jurorProfiles: [profile], courtroomActor: { id: 'juror-01', name: 'juror-01', roles: ['juror'] }, ballotRound: 'final', ...extra }) as unknown as StageRequest
const v2Ballot = (extra: Record<string, unknown> = {}) => ({
  title: 'Juror response', content: 'The record [E-001] shows a collision.', citations: ['E-001'], verdict: null,
  jurors: [{
    juror: 'juror-01', outcome: 'proved', confidence: 71, rationale: 'The fictional record [E-001] shows the collision.', citations: ['E-001'], instructionEventId: '', changedByEventId: null,
    mindChangedBecause: 'Not applicable.', beliefTrail: [], deliberationRounds: [], consistencyWarnings: [],
    elementFindings: [{ elementId: 'claim-duty', finding: 'met', confidence: 0.8, citations: ['E-001', 'E-999'], basis: 'The record [E-001] shows a collision.' }],
    amounts: [{ categoryId: 'general', amount: 10.5, currency: 'CAD', basis: 'The record [E-001].' }],
    apportionment: [{ partyId: 'defendant-1', percent: '60' }],
    ...extra,
  }],
})

function client(response: (body: Record<string, unknown>) => unknown, seen: Array<Record<string, unknown>> = []) {
  return new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 10_000, maxRetries: 0 }, undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    seen.push(body)
    return Response.json({ choices: [{ message: { content: JSON.stringify(response(body)) } }] })
  })
}
const userMessage = (body: Record<string, unknown>) => String((body.messages as Array<{ content: string }>)[1].content)

describe('ballot contract v2 at the provider', () => {
  it('asks for an outcome and element findings, not a leaning, and keeps what comes back as given', async () => {
    const seen: Array<Record<string, unknown>> = []
    const result = await client(() => v2Ballot(), seen).generateStage(base({ ballotContractVersion: 'v2', groundingRequired: false, ballotContract: { permittedOutcomes: ['proved', 'not_proved', 'no_decision'], events: [] } }))
    const prompt = userMessage(seen[0])
    expect(prompt).toMatch(/Ballot contract v2: return outcome, exactly one of the permitted outcomes/)
    expect(prompt).toMatch(/Do not return a crown or defence leaning/)
    expect(prompt).toContain('"outcome":"exactly one permitted outcome"')
    expect(prompt).not.toContain('"leaning":"defence|crown|mixed"')
    expect(prompt).not.toMatch(/reconcile the content, rationale and structured leaning/)
    const juror = result.jurors![0]
    expect(juror.outcome).toBe('proved')
    // An exhibit that does not exist is dropped from the citations; nothing else is touched.
    expect(juror.elementFindings).toEqual([{ elementId: 'claim-duty', finding: 'met', confidence: 0.8, citations: ['E-001'], basis: 'The record [E-001] shows a collision.' }])
    // Not clamped, rounded or coerced beyond a number: the engine flags these.
    expect(juror.amounts).toEqual([{ categoryId: 'general', amount: 10.5, currency: 'CAD', basis: 'The record [E-001].' }])
    expect(juror.apportionment).toEqual([{ partyId: 'defendant-1', percent: 60 }])
  })

  it('leaves the ballot prompt of an ordinary run as it was', async () => {
    const seen: Array<Record<string, unknown>> = []
    await client(() => ({ title: 'x', content: 'y [E-001]', citations: ['E-001'], jurors: [{ juror: 'juror-01', leaning: 'crown', confidence: 60, rationale: 'z [E-001]', citations: ['E-001'], beliefTrail: [], deliberationRounds: [] }] }), seen)
      .generateStage(base({ groundingRequired: false }))
    const prompt = userMessage(seen[0])
    expect(prompt).toContain('reconcile the content, rationale and structured leaning')
    expect(prompt).toContain('"leaning":"defence|crown|mixed"')
    expect(prompt).not.toMatch(/Ballot contract v2|Appraisal contract|elementFindings/)
  })

  it('sends the basis of each element finding and amount to the source check', () => {
    const result = { title: 't', content: 'c [E-001].', citations: ['E-001'], jurors: [{ juror: 'juror-01', leaning: 'mixed', outcome: 'proved', confidence: 70, rationale: 'r [E-001].', citations: ['E-001'],
      elementFindings: [{ elementId: 'a', finding: 'met', confidence: 0.8, citations: ['E-001'], basis: 'The record [E-001] shows a collision.' }, { elementId: 'b', finding: 'met', confidence: 0.7, citations: ['E-001'] }],
      amounts: [{ categoryId: 'general', amount: 100, currency: 'CAD', basis: 'The bill [E-001].' }] }] } as StageResult
    const ids = groundingUnits(result).map((unit) => unit.id)
    expect(ids).toContain('juror-element-0-0:1')
    expect(ids).toContain('juror-amount-0-0:1')
    expect(ids).not.toContain('juror-element-0-1:1')
    // The consistency unit names the outcome the juror chose, not a leaning.
    expect(JSON.parse(ballotConsistencyUnits(result)[0].text)).toMatchObject({ juror: 'juror-01', outcome: 'proved' })
    expect(JSON.parse(ballotConsistencyUnits(result)[0].text)).not.toHaveProperty('leaning')
    // An ordinary ballot has neither unit.
    const plain = { title: 't', content: 'c [E-001].', citations: ['E-001'], jurors: [{ juror: 'juror-01', leaning: 'crown', confidence: 70, rationale: 'r [E-001].', citations: ['E-001'] }] } as StageResult
    expect(groundingUnits(plain).map((unit) => unit.id).some((id) => /element|amount/.test(id))).toBe(false)
    expect(JSON.parse(ballotConsistencyUnits(plain)[0].text)).toHaveProperty('leaning', 'crown')
  })
})

describe('the v2 ballot contract check before a ballot is committed', () => {
  const request = (round: 'initial' | 'final', initialChoice?: string) => base({ ballotRound: round, ballotContractVersion: 'v2', ballotContract: { initialChoice, permittedOutcomes: ['proved', 'not_proved', 'no_decision'], events: [{ eventId: 'peer', exhibitIds: ['E-001'] }] } })
  const result = (juror: Record<string, unknown>) => ({ title: 't', content: 'c', citations: [], jurors: [{ juror: 'juror-01', leaning: 'mixed', confidence: 60, rationale: 'r', citations: ['E-001'], ...juror }] }) as unknown as StageResult

  it('accepts a permitted outcome, an unchanged position and an initial undecided', () => {
    expect(validateJuryBallotContract(request('final'), result({ outcome: 'proved' }))).toEqual([])
    expect(validateJuryBallotContract(request('final', 'proved'), result({ outcome: 'proved' }))).toEqual([])
    expect(validateJuryBallotContract(request('initial'), result({ outcome: 'undecided' }))).toEqual([])
    expect(validateJuryBallotContract(request('final'), result({ outcome: 'Not Proved' }))).toEqual([])
  })

  it('refuses an outcome that is not permitted, spelled any way', () => {
    for (const outcome of ['liable', '', undefined, 'crown']) expect(validateJuryBallotContract(request('final'), result({ outcome })).join(' ')).toMatch(/exactly one of the permitted outcomes/)
    expect(validateJuryBallotContract(request('final'), result({ outcome: 'undecided' })).join(' ')).toMatch(/exactly one of the permitted outcomes/)
  })

  it('still requires an eligible event and a shared source for a changed final ballot', () => {
    expect(validateJuryBallotContract(request('final', 'proved'), result({ outcome: 'not_proved' })).join(' ')).toMatch(/changed final ballot requires/)
    expect(validateJuryBallotContract(request('final', 'proved'), result({ outcome: 'not_proved', changedByEventId: 'peer', mindChangedBecause: 'The turn clarified the point.' }))).toEqual([])
    expect(validateJuryBallotContract(request('final', 'proved'), result({ outcome: 'not_proved', changedByEventId: 'peer', mindChangedBecause: '', citations: ['E-001'] })).join(' ')).toMatch(/changed final ballot requires/)
  })

  it('refuses text that declares a different vote from the outcome the juror named', () => {
    const declared = result({ outcome: 'not_guilty' })
    declared.content = 'My vote is guilty.'
    const criminal = base({ ballotRound: 'final', ballotContractVersion: 'v2', ballotContract: { permittedOutcomes: ['guilty', 'not_guilty', 'no_verdict'], events: [] } })
    expect(validateJuryBallotContract(criminal, declared).join(' ')).toMatch(/structured outcome/)
    declared.content = 'My vote is not guilty.'
    expect(validateJuryBallotContract(criminal, declared)).toEqual([])
  })
})

describe('the juror appraisal stage at the provider', () => {
  const appraisal = { comprehension: 0.7, valence: 5, intensity: 0.4, speakerCredibility: { rating: 0.6, note: 'n' }, noted: ['a'], wonders: [], elementShifts: [] }

  it('asks for an appraisal, makes one call with no source check, and returns the appraisal untouched', async () => {
    const seen: Array<Record<string, unknown>> = []
    const result = await client(() => ({ title: 'Appraisal', content: 'One sentence.', citations: [], jurors: [], verdict: null, appraisal }), seen)
      .generateStage(base({ stage: 'juror_appraisal', ballotRound: undefined, groundingRequired: false }))
    expect(seen).toHaveLength(1)
    const prompt = userMessage(seen[0])
    expect(prompt).toMatch(/Appraisal contract: this is a private juror appraisal/)
    expect(prompt).toMatch(/simulated reaction and not a measurement/)
    expect(prompt).toContain('"appraisal":{"comprehension"')
    expect(prompt).toContain('Your juror profile:')
    expect(prompt).toMatch(/one sentence on what you took from this segment/)
    expect(seen[0].temperature).toBe(0.5)
    // Out-of-range values are the engine's to refuse; the provider does not tidy them.
    expect(result.appraisal).toEqual(appraisal)
    expect(result.jurors).toBeUndefined()
  })

  it('does not add an appraisal to any other stage', async () => {
    const result = await client(() => ({ title: 'x', content: 'y [E-001]', citations: ['E-001'], appraisal }))
      .generateStage(base({ stage: 'crown_opening', jurorProfiles: undefined, groundingRequired: false }))
    expect(result).not.toHaveProperty('appraisal')
  })
})
