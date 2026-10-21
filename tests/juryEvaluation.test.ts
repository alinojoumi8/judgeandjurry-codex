import { describe, expect, it } from 'vitest'
import { ScriptedCourtroomModel } from '../samples/courtroom-realism/fixture'
import { runFictionalHearing } from '../scripts/hearingEvaluation'
import { runJuryScenario } from '../scripts/juryEvaluation'

// Persisted 60-actor journeys can exceed 45s under Windows disk contention.
// Bound completion without treating these functional checks as latency SLOs.
const fullHearingTimeoutMs = 120_000

describe('actual engine jury evaluation contracts', () => {
  it('continues the hearing through the charge gate, independent ballots, three deliberation phases and persisted decision', async () => {
    const scripted = new ScriptedCourtroomModel()
    const result = await runFictionalHearing({ variant: 'Rowan', throughDecision: true, model: { async generateStage(r) {
      if (r.stage === 'judge_ruling') return { title: 'Scope ruling', content: 'Sustained under the fictional instruction.', citations: [], jurors: [], verdict: { outcome: 'sustained', confidence: 80, keyFactors: [], unresolvedIssues: [], recommendedNextSteps: [], citationWarnings: [] } }
      return scripted.generateStage(r)
    } } })
    expect(result.error).toBeUndefined()
    expect(result.checks).toMatchObject({ chargeGate: true, instructionVersions: true, juryBallots: true, deliberationTurns: true, decisionIntegrity: true, juryRestart: true, fullCompleted: true })
    expect(Object.values(result.checks).every(Boolean)).toBe(true)
    expect(result.ballots).toHaveLength(24)
    expect(scripted.requests.filter(r => r.stage === 'jury_deliberation')).toHaveLength(36)
    expect(scripted.requests.filter(r => r.stage === 'jury_deliberation' && r.packet.includes('You may agree'))).toHaveLength(12)
    expect(scripted.requests.filter(r => r.stage === 'juror_ballot').every(r => r.courtroomState?.juryPresent)).toBe(true)
  }, fullHearingTimeoutMs)
  it.each(['conflicting-witnesses','later-exclusion','struck-testimony','missing-essential-proof'] as const)('runs %s with concrete scenario records, scoped restrictions and recovery', async scenario => {
    const scripted = new ScriptedCourtroomModel()
    const result = await runJuryScenario({ scenario, variant: 'Morgan', model: scripted })
    expect(result.error).toBeUndefined()
    expect(Object.values(result.checks).every(Boolean)).toBe(true)
    expect(result.ballots).toHaveLength(24)
    const jurors = scripted.requests.filter(r => ['juror_ballot','jury_deliberation'].includes(r.stage))
    expect(jurors).toHaveLength(60)
    expect(jurors.every(r => !JSON.stringify(r).match(/EXCLUDED_RECEIPT_734|STRUCK_RECEIPT_825|PRIVATE_JURY_917/))).toBe(true)
    if (scenario === 'conflicting-witnesses') expect(jurors.every(r => r.evidence.length === 2)).toBe(true)
    expect(result.fixture.scenario).toBe(scenario)
  }, fullHearingTimeoutMs)
  it('converts native traits to the actual 100-point scale in every ballot and deliberation request',async()=>{
    const scripted=new ScriptedCourtroomModel()
    const result=await runJuryScenario({scenario:'conflicting-witnesses',variant:'Rowan',model:scripted})
    expect(result.error).toBeUndefined()
    for(const request of scripted.requests.filter(r=>['juror_ballot','jury_deliberation'].includes(r.stage))){
      const legacy=request.jurorProfiles![0], native=result.jurorProfiles.find(p=>p.actorId===legacy.juror)!
      expect(legacy.skepticismLevel).toBe(Math.max(1,Math.round((1-native.traits.narrativeSusceptibility)*100)))
      expect(legacy.burdenSensitivity).toBe(Math.max(1,Math.round(native.traits.burdenSensitivity*100)))
    }
  },fullHearingTimeoutMs)
  it('reports swallowed ballot or deliberation generation failures as failures, never completed live quality', async () => {
    const scripted = new ScriptedCourtroomModel()
    const result = await runJuryScenario({ scenario: 'missing-essential-proof', variant: 'Rowan', model: { async generateStage(r) { if (r.stage === 'jury_deliberation') throw new Error('injected source failure'); return scripted.generateStage(r) } } })
    expect(result.checks.deliberationTurns).toBe(false)
  }, fullHearingTimeoutMs)
})
