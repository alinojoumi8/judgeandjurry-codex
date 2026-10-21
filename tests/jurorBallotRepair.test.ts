import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { ballotConsistencyUnits, groundingUnits, type GroundingReview, type GroundingUnit } from '../server/grounding'
import { applyGroundingPatch, groundingPatchTargets, groundingRepairDrift } from '../server/groundingRepair'
import type { StageResult } from '../server/types'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const request: StageRequest = { stage: 'juror_ballot', ballotRound: 'initial', packet: '', previousTurns: '', evidence: [], groundingRequired: true, courtroomProtocol: false,
  courtroomActor: { id: 'juror-01', name: 'Juror 1', roles: ['juror'] }, courtroomEvents: [], courtroomAssessments: [],
  ballotContract: { permittedOutcomes: ['guilty', 'not_guilty', 'no_verdict'], events: [] } }
const draft: StageResult = { title: 'Ballot', content: 'I vote no verdict.', citations: [], jurors: [{ juror: 'juror-01', leaning: 'defence', confidence: 60, rationale: 'I remain undecided.', citations: [], mindChangedBecause: '' }] }
function audit(jointFailure: boolean): GroundingReview {
  return { status: jointFailure ? 'failed' : 'passed', method: 'source-quotes-and-model-review', errors: [], repairs: 0,
    findings: [...groundingUnits(draft), ...ballotConsistencyUnits(draft)].map(unit => ({ unitId: unit.id, text: unit.text, status: jointFailure && unit.kind ? 'contradicted' : 'analysis', explanation: 'Check declared choice against the structured ballot.', citations: [] })) }
}

describe('bounded ballot choice repair', () => {
  it('exposes a choice only for a failed whole-ballot judgment', () => {
    expect(groundingPatchTargets(draft, audit(false)).some(t => t.unitId === 'ballot-choice-0:1')).toBe(false)
    expect(groundingPatchTargets(draft, audit(true))).toContainEqual({ unitId: 'ballot-choice-0:1', sourceText: 'defence' })
  })
  it.each(['crown', 'defence', 'mixed'])('permits an explicit %s choice patch and preserves identity, confidence and text', leaning => {
    const { result, edits } = applyGroundingPatch(draft, audit(true), { repairs: [{ unitId: 'ballot-choice-0:1', replacement: leaning }] })
    expect(result).toEqual({ ...draft, jurors: [{ ...draft.jurors![0], leaning }] })
    expect(groundingRepairDrift(draft, result, audit(true))).toEqual([])
    expect(edits).toEqual([{ unitId: 'ballot-choice-0:1', before: 'defence', replacement: leaning }])
    expect(draft.jurors![0].leaning).toBe('defence')
  })
  it.each(['', 'guilty', 'not_guilty', 'undecided', 'Mixed', 'mixed; new claim'])('refuses an invalid structured choice: %s', replacement => {
    expect(() => applyGroundingPatch(draft, audit(true), { repairs: [{ unitId: 'content:1', replacement: 'Changed.' }, { unitId: 'ballot-choice-0:1', replacement }] })).toThrow()
    expect(draft.content).toBe('I vote no verdict.')
  })
  it('cannot change an accepted ballot choice', () => {
    expect(() => applyGroundingPatch(draft, audit(false), { repairs: [{ unitId: 'ballot-choice-0:1', replacement: 'mixed' }] })).toThrow()
  })
  it.each([{ juror: 'juror-02' }, { confidence: 99 }])('a whole-ballot failure never licenses identity or confidence drift: %j', changes => {
    expect(groundingRepairDrift(draft, { ...draft, jurors: [{ ...draft.jurors![0], ...changes }] }, audit(true)).length).toBeGreaterThan(0)
  })
})

describe('legacy full-proceeding ballot checks', () => {
  it.each([false, true])('checks the whole ballot, repairs only an authorized choice and rechecks it: persistent=%s', async persistent => {
    const prompts: string[] = []
    let authors = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content as string
      prompts.push(prompt)
      const units = prompt.includes('Draft units to check:\n') ? JSON.parse(prompt.split('Draft units to check:\n')[1]) as GroundingUnit[] : undefined
      const result = units ? { findings: units.map(unit => ({ unitId: unit.id, status: unit.kind && (persistent || JSON.parse(unit.text).leaning !== 'mixed') ? 'contradicted' : 'analysis', explanation: 'The written no-verdict choice must match mixed; this is independent of the underlying evidence.', citations: [], recordCitations: [] })) }
        : ++authors === 1 ? draft : { repairs: [{ unitId: 'ballot-choice-0:1', replacement: 'mixed' }] }
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
    })
    if (persistent) await expect(client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', appliedRepairs: [{ unitId: 'ballot-choice-0:1', before: 'defence', replacement: 'mixed' }] } })
    else {
      const result = await client.generateStage(request)
      expect(result.jurors![0].leaning).toBe('mixed')
      expect(result.content).toBe(draft.content)
      expect(result.grounding?.priorFailures).toHaveLength(1)
    }
    expect(prompts).toHaveLength(4)
    expect(prompts[1]).toContain('ballot-consistency-0:1')
    expect(prompts[3]).toContain('ballot-consistency-0:1')
    expect(prompts[2]).toContain('ballot-choice-0:1')
  })
})

describe('quotation and pronoun repairs preserve the record', () => {
  it.each([false, true])('rechecks a correction to the exact supplied name: persistent=%s', async persistent => {
    const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'Avery said: I retained the funds.' }]
    const original = { ...draft, content: 'E-001 records that Avery said he retained the funds.', citations: ['E-001'], jurors: [{ ...draft.jurors![0], mindChangedBecause: 'Current assessment.' }] }
    const prompts: string[] = []
    let authors = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content as string; prompts.push(prompt)
      const units = prompt.includes('Draft units to check:\n') ? JSON.parse(prompt.split('Draft units to check:\n')[1]) as GroundingUnit[] : undefined
      const result = units ? { findings: units.map(unit => ({ unitId: unit.id, status: unit.id === 'content:1' ? 'supported' : 'analysis', explanation: 'Compare actual source words.', citations: unit.id === 'content:1' ? [{ exhibitId: 'E-001', paragraph: 1 }] : [] })) }
        : ++authors === 1 ? original : { repairs: [{ unitId: 'content:1', replacement: persistent ? original.content : 'E-001 records Avery’s statement: “I retained the funds.”' }] }
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
    })
    const req = { ...request, stage: 'jury_deliberation' as const, evidence }
    if (persistent) await expect(client.generateStage(req)).rejects.toMatchObject({ grounding: { status: 'failed', priorFailures: expect.any(Array) } })
    else {
      const result = await client.generateStage(req)
      expect(result.content).toBe('E-001 records Avery’s statement: “I retained the funds.”')
      expect(result.jurors).toMatchObject(original.jurors)
      expect(result.grounding?.appliedRepairs?.[0].before).toBe(original.content)
    }
    expect(prompts[2]).toContain('repeat the exact supplied name')
    expect(prompts[3]).toContain('Draft units to check:')
    expect(prompts).toHaveLength(4)
  })
})
