import { afterEach, describe, expect, it } from 'vitest'

import { CaseStore } from '../server/db'
import { MiniMaxClient } from '../server/minimax'
import { SimulationService } from '../server/orchestrator'

let store: CaseStore | null = null

afterEach(() => {
  store?.close()
  store = null
})

describe('simulation orchestration', () => {
  it('runs structured courtroom rounds with mock MiniMax responses', async () => {
    store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'Test Matter',
      narrative: 'The claimant alleges a parking lot hazard.',
    })
    store.addEvidence(matter.id, {
      name: 'Incident report.txt',
      type: 'text',
      mimeType: 'text/plain',
      size: 100,
      text: 'The lot was wet and poorly lit.',
      summary: 'Wet lot and poor lighting.',
      tags: ['Timeline'],
    })

    const service = new SimulationService(
      store,
      new MiniMaxClient({
        provider: 'minimax',
        apiKey: undefined,
        baseUrl: 'https://api.minimax.io/v1',
        model: 'MiniMax-M3',
        mock: true,
        timeoutMs: 10_000,
        maxRetries: 0,
      }),
    )
    const session = await service.runToCompletion(matter.id)

    expect(session.status).toBe('completed')
    expect(session.turns.map((turn) => turn.stage)).toContain('defence_opening')
    expect(session.turns.map((turn) => turn.stage)).toContain('judge_ruling')
    expect(session.juryOpinions).toHaveLength(6)
    expect(session.verdict?.disclaimer).toContain('not legal advice')
  })

  it('resumes from the first failed stage without rerunning completed stages', async () => {
    store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'Resume Matter',
      narrative: 'The claimant alleges a repair delay.',
    })
    store.addEvidence(matter.id, {
      name: 'repair timeline.txt',
      type: 'text',
      mimeType: 'text/plain',
      size: 100,
      text: 'The repair was requested on Monday and completed on Friday.',
      summary: 'Repair timeline.',
      tags: ['Timeline'],
    })

    const client = new FlakyModelClient()
    const service = new SimulationService(store, client)
    const failed = await service.runToCompletion(matter.id)

    expect(failed.status).toBe('failed')
    expect(failed.currentStage).toBe('crown_opening')
    expect(failed.progress.completed).toBe(3)

    const resumed = await service.resumeToCompletion(failed.id)

    expect(resumed.status).toBe('completed')
    expect(resumed.progress.completed).toBe(resumed.progress.total)
    expect(client.stageCalls.filter((stage) => stage === 'intake_normalization')).toHaveLength(1)
    expect(client.stageCalls.filter((stage) => stage === 'crown_opening')).toHaveLength(2)
  })
})

class FlakyModelClient {
  readonly stageCalls: string[] = []
  private failed = false

  async generateStage(request: { stage: string; evidence: Array<{ exhibitId: string }> }) {
    this.stageCalls.push(request.stage)
    if (request.stage === 'crown_opening' && !this.failed) {
      this.failed = true
      throw new Error('temporary model failure')
    }

    const exhibitId = request.evidence[0]?.exhibitId ?? 'E-001'
    return {
      title: request.stage,
      content: `${request.stage} cites ${exhibitId}.`,
      citations: [exhibitId],
      jurors:
        request.stage === 'jury_deliberation'
          ? [
              {
                juror: 'Juror 1',
                leaning: 'mixed' as const,
                confidence: 60,
                rationale: `Profile-aware rationale citing ${exhibitId}.`,
                citations: [exhibitId],
              },
            ]
          : undefined,
      verdict:
        request.stage === 'judge_ruling'
          ? {
              outcome: 'Further Review Needed',
              confidence: 60,
              keyFactors: [`Key factor from ${exhibitId}`],
              unresolvedIssues: [],
              recommendedNextSteps: ['Review with counsel.'],
              citationWarnings: [],
            }
          : undefined,
    }
  }
}
