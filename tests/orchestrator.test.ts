import { afterEach, describe, expect, it } from 'vitest'

import { CaseStore } from '../server/db'
import { SimulationService } from '../server/orchestrator'

let store: CaseStore | null = null

afterEach(() => {
  store?.close()
  store = null
})

type TestJurorProfile = {
  juror: string
  evidenceFocus: string
}

function deliberatingJuror(
  profile: TestJurorProfile,
  exhibitId: string,
  leaning: 'defence' | 'crown' | 'mixed',
  confidence: number,
  rationale: string,
) {
  return {
    juror: profile.juror,
    leaning,
    confidence,
    rationale,
    citations: [exhibitId],
    beliefTrail: [
      {
        stage: 'after_defence_opening',
        leaning: 'defence' as const,
        confidence: Math.max(40, confidence - 18),
        belief: `${profile.evidenceFocus} initially left room for the defence theory.`,
        why: `The first defence account highlighted a proof gap in ${exhibitId}.`,
        citations: [exhibitId],
      },
      {
        stage: 'after_crown_opening',
        leaning,
        confidence: Math.max(45, confidence - 8),
        belief: `${profile.evidenceFocus} became more important after the Crown chronology.`,
        why: `The Crown tied the point to ${exhibitId}.`,
        citations: [exhibitId],
      },
      {
        stage: 'after_rebuttals',
        leaning,
        confidence: Math.max(50, confidence - 4),
        belief: `${profile.evidenceFocus} survived the rebuttal exchange.`,
        why: `The rebuttals did not displace the exhibit-cited point.`,
        citations: [exhibitId],
      },
      {
        stage: 'final_deliberation',
        leaning,
        confidence,
        belief: rationale,
        why: `The jury-room debate kept returning to ${profile.evidenceFocus}.`,
        citations: [exhibitId],
      },
    ],
    deliberationRounds: [
      {
        round: 1,
        focus: profile.evidenceFocus,
        exchange: `${profile.juror} tested whether ${profile.evidenceFocus} was actually supported by ${exhibitId}.`,
        responseTo: 'initial panel split',
        leaning,
        confidence: Math.max(45, confidence - 6),
      },
      {
        round: 2,
        focus: 'burden and corroboration',
        exchange: `${profile.juror} updated the vote only after the cited record answered the main doubt.`,
        responseTo: 'Juror 2',
        leaning,
        confidence,
      },
    ],
    mindChangedBecause:
      'The final vote followed the exhibit-cited chronology after the panel tested the competing explanation.',
    consistencyWarnings: [],
  }
}

describe('simulation orchestration', () => {
  it('runs structured courtroom rounds with a test model client', async () => {
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
      new DeterministicModelClient(),
    )
    const session = await service.runToCompletion(matter.id)

    expect(session.status).toBe('completed')
    expect(session.turns.map((turn) => turn.stage)).toContain('defence_opening')
    expect(session.turns.map((turn) => turn.stage)).toContain('judge_ruling')
    expect(session.juryOpinions).toHaveLength(6)
    expect(session.juryOpinions[0]?.beliefTrail).toHaveLength(4)
    expect(session.juryOpinions[0]?.deliberationRounds).toHaveLength(2)
    expect(session.juryOpinions[0]?.mindChangedBecause).toContain('exhibit-cited')
    expect(session.jurorProfiles[0]?.whatWouldChangeMind).toBeTruthy()
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
    // Crown now opens third (intake and issue spotting complete first).
    expect(failed.progress.completed).toBe(2)

    const resumed = await service.resumeToCompletion(failed.id)

    expect(resumed.status).toBe('completed')
    expect(resumed.progress.completed).toBe(resumed.progress.total)
    expect(client.stageCalls.filter((stage) => stage === 'intake_normalization')).toHaveLength(1)
    expect(client.stageCalls.filter((stage) => stage === 'crown_opening')).toHaveLength(2)
  })

  it('feeds the structured jury record into the judge synthesis', async () => {
    store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'Jury Context Matter',
      narrative: 'The Crown relies on one witness and bank records.',
    })
    store.addEvidence(matter.id, {
      name: 'bank record.txt',
      type: 'text',
      mimeType: 'text/plain',
      size: 100,
      text: 'The bank record corroborates the transfer.',
      summary: 'Bank record.',
      tags: ['Banking'],
    })

    const client = new JuryContextModelClient()
    const service = new SimulationService(store, client)
    await service.runToCompletion(matter.id, { jurorCount: 3 })

    expect(client.judgePreviousTurns).toContain('Jury deliberation record')
    expect(client.judgePreviousTurns).toContain('Split:')
    expect(client.judgePreviousTurns).toContain('voted crown')
    expect(client.judgePreviousTurns).toContain('Belief trail:')
    expect(client.judgePreviousTurns).toContain('Deliberation rounds:')
  })

  it('runs the courtroom in a realistic order with a charge before deliberation', async () => {
    store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'Order Matter',
      narrative: 'A dispute about stage ordering.',
    })
    store.addEvidence(matter.id, {
      name: 'notes.txt',
      type: 'text',
      mimeType: 'text/plain',
      size: 50,
      text: 'Ordering evidence.',
      summary: 'Ordering evidence.',
      tags: ['Evidence'],
    })

    const service = new SimulationService(store, new DeterministicModelClient())
    const session = await service.runToCompletion(matter.id)

    const stageOrder = session.turns.map((turn) => turn.stage)
    expect(stageOrder.indexOf('crown_opening')).toBeLessThan(
      stageOrder.indexOf('defence_opening'),
    )
    expect(stageOrder.indexOf('crown_rebuttal')).toBeLessThan(
      stageOrder.indexOf('defence_rebuttal'),
    )
    expect(stageOrder.indexOf('jury_instructions')).toBeLessThan(
      stageOrder.indexOf('jury_deliberation'),
    )
    expect(stageOrder.indexOf('jury_deliberation')).toBeLessThan(
      stageOrder.indexOf('judge_ruling'),
    )
  })

  it('collects independent secret ballots before deliberation and records them', async () => {
    store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'Ballot Matter',
      narrative: 'A dispute deliberated with secret ballots.',
    })
    store.addEvidence(matter.id, {
      name: 'ledger.txt',
      type: 'text',
      mimeType: 'text/plain',
      size: 80,
      text: 'The ledger shows the transfer.',
      summary: 'Ledger.',
      tags: ['Evidence'],
    })

    const client = new BallotAwareModelClient()
    const service = new SimulationService(store, client)
    const session = await service.runToCompletion(matter.id, {
      jurorCount: 3,
      deliberationMode: 'independent',
    })

    expect(client.ballotCalls).toHaveLength(3)
    expect(client.ballotCalls.every((call) => call.profileCount === 1)).toBe(true)
    expect(client.deliberationBallots.map((ballot) => ballot.juror)).toEqual([
      'Juror 1',
      'Juror 2',
      'Juror 3',
    ])
    expect(session.juryOpinions).toHaveLength(3)
    for (const opinion of session.juryOpinions) {
      expect(opinion.beliefTrail[0]?.stage).toBe('secret_ballot')
    }
    // Juror 3 flipped from its ballot without explaining why.
    const flipped = session.juryOpinions.find((opinion) => opinion.juror === 'Juror 3')
    expect(flipped?.consistencyWarnings.join(' ')).toContain('secret ballot')
  })

  it('skips ballots entirely in grouped deliberation mode', async () => {
    store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'Grouped Matter',
      narrative: 'A dispute deliberated in one pass.',
    })
    store.addEvidence(matter.id, {
      name: 'notes.txt',
      type: 'text',
      mimeType: 'text/plain',
      size: 50,
      text: 'Grouped evidence.',
      summary: 'Grouped evidence.',
      tags: ['Evidence'],
    })

    const client = new BallotAwareModelClient()
    const service = new SimulationService(store, client)
    await service.runToCompletion(matter.id, {
      jurorCount: 3,
      deliberationMode: 'grouped',
    })

    expect(client.ballotCalls).toHaveLength(0)
  })

  it('treats a non-unanimous criminal jury as hung and caps confidence', async () => {
    store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'Split Panel Matter',
      narrative: 'A charge screening with a divided panel.',
    })
    store.addEvidence(matter.id, {
      name: 'disclosure.txt',
      type: 'text',
      mimeType: 'text/plain',
      size: 90,
      text: 'Disclosure records for the charge.',
      summary: 'Disclosure.',
      tags: ['Evidence'],
    })

    const service = new SimulationService(store, new SplitPanelModelClient())
    const session = await service.runToCompletion(matter.id, {
      templateId: 'criminal_defence',
      jurorCount: 12,
      deliberationMode: 'grouped',
    })

    expect(session.juryOpinions).toHaveLength(12)
    expect(session.verdict?.confidence).toBeLessThanOrEqual(64)
    expect(session.verdict?.keyFactors.join(' ')).toContain('required agreement')
    expect(session.verdict?.unresolvedIssues.join(' ')).toContain('hung')
  })

  it('ignores duplicate jurors and jurors that are not on the panel', async () => {
    store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'Rogue Juror Matter',
      narrative: 'The model invents jurors.',
    })
    store.addEvidence(matter.id, {
      name: 'notes.txt',
      type: 'text',
      mimeType: 'text/plain',
      size: 40,
      text: 'Panel evidence.',
      summary: 'Panel evidence.',
      tags: ['Evidence'],
    })

    const service = new SimulationService(store, new RogueJurorModelClient())
    const session = await service.runToCompletion(matter.id, {
      jurorCount: 2,
      deliberationMode: 'grouped',
    })

    expect(session.juryOpinions).toHaveLength(2)
    expect(session.juryOpinions.map((opinion) => opinion.juror)).toEqual([
      'Juror 1',
      'Juror 2',
    ])
  })

  it('removes stale error turns and duplicate stage turns when resuming', async () => {
    store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'Clean Resume Matter',
      narrative: 'A dispute whose first run fails.',
    })
    store.addEvidence(matter.id, {
      name: 'notes.txt',
      type: 'text',
      mimeType: 'text/plain',
      size: 60,
      text: 'Resume evidence.',
      summary: 'Resume evidence.',
      tags: ['Evidence'],
    })

    const client = new FlakyModelClient()
    const service = new SimulationService(store, client)
    const failed = await service.runToCompletion(matter.id)
    expect(failed.turns.some((turn) => turn.stage === 'simulation_error')).toBe(true)

    const resumed = await service.resumeToCompletion(failed.id)

    expect(resumed.status).toBe('completed')
    expect(resumed.turns.some((turn) => turn.stage === 'simulation_error')).toBe(false)
    const stageCounts = resumed.turns.reduce<Record<string, number>>((counts, turn) => {
      counts[turn.stage] = (counts[turn.stage] ?? 0) + 1
      return counts
    }, {})
    for (const [stage, count] of Object.entries(stageCounts)) {
      expect(count, `stage ${stage} should appear once`).toBe(1)
    }
  })

  it('calibrates a strong unanimous jury toward high judge confidence', async () => {
    store = new CaseStore(':memory:')
    const matter = store.createMatter({
      title: 'Consensus Matter',
      narrative: 'The documentary record strongly supports the Crown theory.',
    })
    store.addEvidence(matter.id, {
      name: 'corroborated record.txt',
      type: 'text',
      mimeType: 'text/plain',
      size: 100,
      text: 'Witness evidence and bank records corroborate the alleged transfer.',
      summary: 'Corroborated record.',
      tags: ['Evidence'],
    })

    const service = new SimulationService(store, new HighConsensusModelClient())
    const session = await service.runToCompletion(matter.id, { jurorCount: 12 })

    expect(session.juryOpinions).toHaveLength(12)
    expect(session.verdict?.confidence).toBeGreaterThanOrEqual(88)
    expect(session.verdict?.keyFactors.join(' ')).toContain(
      'Confidence calibrated from jury consensus',
    )
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
              deliberatingJuror(
                { juror: 'Juror 1', evidenceFocus: 'procedural gaps' },
                exhibitId,
                'mixed',
                60,
                `procedural gaps remain mixed after ${exhibitId}.`,
              ),
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

class DeterministicModelClient {
  async generateStage(request: {
    stage: string
    evidence: Array<{ exhibitId: string }>
    jurorProfiles?: TestJurorProfile[]
  }) {
    const exhibitId = request.evidence[0]?.exhibitId ?? 'E-001'
    return {
      title: request.stage,
      content: `${request.stage} cites ${exhibitId}.`,
      citations: [exhibitId],
      jurors:
        request.stage === 'jury_deliberation'
          ? (request.jurorProfiles ?? []).map((profile, index) =>
              deliberatingJuror(
                profile,
                exhibitId,
                index % 2 === 0 ? 'mixed' : 'defence',
                60 + index,
                `${profile.evidenceFocus} focus cites ${exhibitId}.`,
              ),
            )
          : undefined,
      verdict:
        request.stage === 'judge_ruling'
          ? {
              outcome: 'Further Review Needed',
              confidence: 60,
              keyFactors: [`Evidence ${exhibitId}`],
              unresolvedIssues: [],
              recommendedNextSteps: ['Review with counsel.'],
              citationWarnings: [],
            }
          : undefined,
    }
  }
}

class JuryContextModelClient {
  judgePreviousTurns = ''

  async generateStage(request: {
    stage: string
    evidence: Array<{ exhibitId: string }>
    previousTurns: string
    jurorProfiles?: TestJurorProfile[]
  }) {
    const exhibitId = request.evidence[0]?.exhibitId ?? 'E-001'
    if (request.stage === 'judge_ruling') {
      this.judgePreviousTurns = request.previousTurns
    }

    return {
      title: request.stage,
      content: `${request.stage} cites ${exhibitId}.`,
      citations: [exhibitId],
      jurors:
        request.stage === 'jury_deliberation'
          ? (request.jurorProfiles ?? []).map((profile) =>
              deliberatingJuror(
                profile,
                exhibitId,
                'crown',
                86,
                `${profile.evidenceFocus} supports the Crown theory with ${exhibitId}.`,
              ),
            )
          : undefined,
      verdict:
        request.stage === 'judge_ruling'
          ? {
              outcome: 'crown',
              confidence: 75,
              keyFactors: [`Corroborated evidence ${exhibitId}`],
              unresolvedIssues: [],
              recommendedNextSteps: ['Review with counsel.'],
              citationWarnings: [],
            }
          : undefined,
    }
  }
}

interface TestStageRequest {
  stage: string
  evidence: Array<{ exhibitId: string }>
  jurorProfiles?: Array<TestJurorProfile & { bias?: string }>
  juryBallots?: Array<{
    juror: string
    leaning: 'defence' | 'crown' | 'mixed'
    confidence: number
    rationale: string
    citations: string[]
  }>
}

class BallotAwareModelClient {
  readonly ballotCalls: Array<{ juror: string; profileCount: number }> = []
  deliberationBallots: NonNullable<TestStageRequest['juryBallots']> = []

  async generateStage(request: TestStageRequest) {
    const exhibitId = request.evidence[0]?.exhibitId ?? 'E-001'

    if (request.stage === 'juror_ballot') {
      const profile = request.jurorProfiles?.[0]
      const juror = profile?.juror ?? 'Juror ?'
      this.ballotCalls.push({
        juror,
        profileCount: request.jurorProfiles?.length ?? 0,
      })
      const leaning = juror === 'Juror 2' ? ('defence' as const) : ('crown' as const)
      return {
        title: 'Secret Ballot',
        content: `Ballot summary citing ${exhibitId}.`,
        citations: [exhibitId],
        jurors: [
          {
            juror,
            leaning,
            confidence: 66,
            rationale: `Independent ballot rationale citing ${exhibitId}.`,
            citations: [exhibitId],
          },
        ],
      }
    }

    if (request.stage === 'jury_deliberation') {
      this.deliberationBallots = request.juryBallots ?? []
      return {
        title: 'Jury Deliberation',
        content: `The panel deliberated over ${exhibitId}.`,
        citations: [exhibitId],
        jurors: (request.jurorProfiles ?? []).map((profile) => {
          if (profile.juror === 'Juror 3') {
            // Flips from its crown ballot to defence without explaining why.
            return {
              ...deliberatingJuror(profile, exhibitId, 'defence', 58, 'Changed vote.'),
              mindChangedBecause: 'No explicit reason.',
            }
          }
          const leaning =
            profile.juror === 'Juror 2' ? ('defence' as const) : ('crown' as const)
          return deliberatingJuror(
            profile,
            exhibitId,
            leaning,
            72,
            `${profile.evidenceFocus} rationale cites ${exhibitId}.`,
          )
        }),
      }
    }

    return {
      title: request.stage,
      content: `${request.stage} cites ${exhibitId}.`,
      citations: [exhibitId],
      verdict:
        request.stage === 'judge_ruling'
          ? {
              outcome: 'Further Review Needed',
              confidence: 60,
              keyFactors: [`Evidence ${exhibitId}`],
              unresolvedIssues: [],
              recommendedNextSteps: ['Review with counsel.'],
              citationWarnings: [],
            }
          : undefined,
    }
  }
}

class SplitPanelModelClient {
  async generateStage(request: TestStageRequest) {
    const exhibitId = request.evidence[0]?.exhibitId ?? 'E-001'
    return {
      title: request.stage,
      content: `${request.stage} cites ${exhibitId}.`,
      citations: [exhibitId],
      jurors:
        request.stage === 'jury_deliberation'
          ? (request.jurorProfiles ?? []).map((profile, index) =>
              deliberatingJuror(
                profile,
                exhibitId,
                index < 9 ? 'crown' : 'defence',
                80,
                `${profile.evidenceFocus} rationale cites ${exhibitId}.`,
              ),
            )
          : undefined,
      verdict:
        request.stage === 'judge_ruling'
          ? {
              outcome: 'Guilty (elements proven beyond a reasonable doubt)',
              confidence: 90,
              keyFactors: [`Corroboration from ${exhibitId}`],
              unresolvedIssues: [],
              recommendedNextSteps: ['Review with counsel.'],
              citationWarnings: [],
            }
          : undefined,
    }
  }
}

class RogueJurorModelClient {
  async generateStage(request: TestStageRequest) {
    const exhibitId = request.evidence[0]?.exhibitId ?? 'E-001'
    return {
      title: request.stage,
      content: `${request.stage} cites ${exhibitId}.`,
      citations: [exhibitId],
      jurors:
        request.stage === 'jury_deliberation'
          ? [
              deliberatingJuror(
                { juror: 'Juror 1', evidenceFocus: 'chronology' },
                exhibitId,
                'crown',
                70,
                `Chronology rationale cites ${exhibitId}.`,
              ),
              deliberatingJuror(
                { juror: 'Juror 1', evidenceFocus: 'chronology' },
                exhibitId,
                'defence',
                60,
                'Duplicate entry that must be ignored.',
              ),
              deliberatingJuror(
                { juror: 'Juror 2', evidenceFocus: 'records' },
                exhibitId,
                'defence',
                64,
                `Records rationale cites ${exhibitId}.`,
              ),
              deliberatingJuror(
                { juror: 'Juror 9', evidenceFocus: 'invented' },
                exhibitId,
                'crown',
                90,
                'Juror invented by the model.',
              ),
            ]
          : undefined,
      verdict:
        request.stage === 'judge_ruling'
          ? {
              outcome: 'Further Review Needed',
              confidence: 55,
              keyFactors: [`Evidence ${exhibitId}`],
              unresolvedIssues: [],
              recommendedNextSteps: ['Review with counsel.'],
              citationWarnings: [],
            }
          : undefined,
    }
  }
}

class HighConsensusModelClient {
  async generateStage(request: {
    stage: string
    evidence: Array<{ exhibitId: string }>
    jurorProfiles?: TestJurorProfile[]
  }) {
    const exhibitId = request.evidence[0]?.exhibitId ?? 'E-001'
    return {
      title: request.stage,
      content: `${request.stage} cites ${exhibitId}.`,
      citations: [exhibitId],
      jurors:
        request.stage === 'jury_deliberation'
          ? (request.jurorProfiles ?? []).map((profile) =>
              deliberatingJuror(
                profile,
                exhibitId,
                'crown',
                90,
                `${profile.evidenceFocus} strongly supports the same Crown conclusion.`,
              ),
            )
          : undefined,
      verdict:
        request.stage === 'judge_ruling'
          ? {
              outcome: 'crown',
              confidence: 74,
              keyFactors: [`Uncontested corroboration from ${exhibitId}`],
              unresolvedIssues: [],
              recommendedNextSteps: ['Prepare source-citation review.'],
              citationWarnings: [],
            }
          : undefined,
    }
  }
}
