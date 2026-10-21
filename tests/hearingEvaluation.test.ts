import { describe, expect, it } from 'vitest'
import { runFictionalHearing } from '../scripts/hearingEvaluation'
import { ScriptedCourtroomModel } from '../samples/courtroom-realism/fixture'

// These integration checks exercise persistence/recovery rather than a latency SLO.
const fullHearingTimeoutMs = 120_000

describe('fictional hearing evaluation: injected software controls', () => {
  it.each(['Rowan', 'Morgan'])('runs %s through openings, scope objection, all examinations, recovery and closings', async variant => {
    const scripted = new ScriptedCourtroomModel()
    const result = await runFictionalHearing({ variant, model: { async generateStage(r) {
      if (r.stage === 'objection_submission') return { title: 'Fictional objection', content: 'The question assumes contents beyond the approved account.', citations: [], jurors: [] }
      if (r.stage === 'judge_ruling') return { title: 'Fictional scope ruling', content: 'Sustained under the supplied fictional exercise rule.', citations: [], jurors: [], verdict: { outcome: 'sustained', confidence: 80, keyFactors: [], unresolvedIssues: [], recommendedNextSteps: [], citationWarnings: [] } }
      return scripted.generateStage(r)
    } } })
    expect(result.error).toBeUndefined()
    expect(Object.values(result.checks).every(Boolean)).toBe(true)
    expect(result.checks).toMatchObject({ closingsReached: true, sustainedAndReplaced: true, allExaminations: true, instructionGate: true, witnessIsolation: true, privateIsolation: true, restartNoDuplicate: true, manifestInputs: true })
    const answer = scripted.requests.find(r => r.stage === 'witness_answer')!
    expect(answer.packet).toContain('sustain an objection to a question')
    expect(answer.packet).not.toContain('sustain a question')
    expect(answer.courtroomActor).toMatchObject({ id: 'w1', name: 'Fictional Mira', roles: ['witness'] })
    expect(answer.courtroomEvents?.some(e => e.type === 'witness_question')).toBe(true)
    expect(JSON.stringify(answer.evidence)).not.toContain('OTHER_HEARING_ACCOUNT_827')
    expect(scripted.requests.find(r => r.stage === 'crown_rebuttal')?.courtroomEvents?.some(e => e.type === 'witness_answer')).toBe(true)
  }, fullHearingTimeoutMs)
})
