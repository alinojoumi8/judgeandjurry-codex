import { AnalysisJobService, type AnalysisJob } from '../server/analysis/jobs'
import { AnalysisService } from '../server/analysis/service'
import { ForecastService, normalizeForecastParams, type ForecastJobParams } from '../server/analysis/forecast'
import { FrameworkService } from '../server/frameworks/service'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import type { FrameworkOverrideInput } from '../server/frameworks/framework'
import type { ModelClient, StageRequest } from '../server/minimax'
import { TrialEngineService } from '../server/trialEngine'
import { registerForecastJob } from '../server/analysis/forecast'
import type { CaseStore } from '../server/db'
import { cognitionWorld, type CognitionWorld } from './cognitionFixtures'

// Fictional fixtures for the forecast tests. A scripted juror model whose answer depends on a PLANTED exhibit and on the
// juror's seeded traits, so the simulated panels move when the evidence moves and carry real seed-to-seed noise.
// Nothing here calls a model, and nothing proves how a live model behaves.

export const strongExhibit = { name: 'bystander.txt', text: 'The fictional bystander clearly saw the fictional defendant drive through the red light.' }
export const weakExhibit = { name: 'bystander.txt', text: 'The fictional bystander is unsure whether the light was red when the fictional defendant drove through.' }

// Claimant-side probability of one simulated juror, by evidence strength: a juror votes for the claimant when
// strength + 0.4 * (0.5 - burdenSensitivity) >= 0.5, and burdenSensitivity is uniform on (0, 1) from the run seed.
// strong: 0.8, none: 0.5, weak: 0.2.
const strengthOf = (request: StageRequest): number => {
  const texts = request.evidence.map((item) => item.text ?? '').join('\n')
  if (/clearly saw/.test(texts)) return 0.62
  if (/is unsure whether/.test(texts)) return 0.38
  return 0.5
}
export const expectedJurorShare = { strong: 0.8, none: 0.5, weak: 0.2 } as const

export class PlantedModel implements ModelClient {
  readonly requests: StageRequest[] = []
  // Called before each call; throw from it to fail that call.
  beforeCall?: (index: number, request: StageRequest) => void

  get count() { return this.requests.length }

  async generateStage(request: StageRequest) {
    this.beforeCall?.(this.requests.length, request)
    this.requests.push(request)
    const exhibit = request.evidence[0]?.exhibitId ?? 'E-001'
    const profile = request.jurorProfiles?.[0]
    const juror = profile?.juror
    const claimantSide = profile !== undefined && strengthOf(request) + 0.4 * (0.5 - profile.burdenSensitivity / 100) >= 0.5
    if (request.stage === 'juror_ballot' && request.ballotContractVersion === 'v2') {
      const rawElements = /Controlling issue elements and burdens: (\[.*\])\n/.exec(request.packet)?.[1]
      const elements = rawElements ? JSON.parse(rawElements) as Array<{ id: string }> : []
      return {
        title: 'Fixture actor output', content: `Source-grounded fixture output [${exhibit}].`, citations: [exhibit],
        jurors: [{
          juror: juror!, leaning: 'mixed' as const, outcome: claimantSide ? 'proved' : 'not_proved', confidence: 70,
          rationale: `Admitted evidence [${exhibit}] bears on the question.`, citations: [exhibit],
          elementFindings: elements.map((element, index) => ({
            elementId: element.id, finding: (index === 0 || claimantSide ? 'met' : 'not_met') as 'met' | 'not_met', confidence: 0.8, citations: [exhibit],
          })),
        }],
      }
    }
    return {
      title: 'Fixture actor output', content: `Source-grounded fixture output [${exhibit}].`, citations: [exhibit],
      jurors: juror ? [{ juror, leaning: claimantSide ? 'crown' as const : 'defence' as const, confidence: 70, rationale: `Admitted evidence [${exhibit}] bears on the question.`, citations: [exhibit] }] : [],
      verdict: request.stage === 'judge_ruling' ? { outcome: 'not_proved', confidence: 70, keyFactors: [exhibit], unresolvedIssues: [], recommendedNextSteps: [], citationWarnings: [] } : undefined,
    }
  }
}

export interface ForecastWorld extends CognitionWorld {
  scripted: PlantedModel
  engine: TrialEngineService
  jobs: AnalysisJobService
  forecast: ForecastService
  frameworks: FrameworkService
  analysis: AnalysisService
}

export const forecastLimits = { tokensPerCall: 100, defaultMaxCalls: 1_000, absoluteMaxCalls: 5_000, maxConcurrentJobs: 2 }

export function forecastWorld(
  stores: CaseStore[],
  options: { evidence?: Array<{ name: string; text: string }>; framework?: boolean | FrameworkOverrideInput[]; limits?: typeof forecastLimits; model?: PlantedModel } = {},
): ForecastWorld {
  const world = cognitionWorld(stores, options.evidence ?? [])
  const scripted = options.model ?? new PlantedModel()
  const engine = new TrialEngineService(world.store, scripted)
  const frameworks = new FrameworkService(world.store)
  if (options.framework !== false) {
    frameworks.setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'Fictional Paralegal', overrides: Array.isArray(options.framework) ? options.framework : [] })
  }
  const analysis = new AnalysisService(world.store)
  const jobs = new AnalysisJobService(world.store, options.limits ?? forecastLimits)
  const forecast = new ForecastService(world.store, analysis, frameworks)
  registerForecastJob(jobs, forecast, engine)
  return { ...world, scripted, engine, jobs, forecast, frameworks, analysis }
}

// Previews the study and starts it exactly as a person would, then waits for the queue to finish.
export async function runStudy(world: ForecastWorld, input: Partial<ForecastJobParams> & { maxCalls?: number; acknowledgeCost?: boolean } = {}): Promise<{ job: AnalysisJob; params: ForecastJobParams }> {
  const { maxCalls, acknowledgeCost, ...rest } = input
  const params = normalizeForecastParams({ seed: 'study-seed', ...rest })
  const preview = world.jobs.preview(world.matterId, { kind: 'forecast', params: { ...params }, maxCalls, acknowledgeCost })
  const job = world.jobs.start(world.matterId, { kind: 'forecast', params: { ...params }, maxCalls, acknowledgeCost, estimateHash: preview.estimate.hash })
  await world.jobs.whenIdle()
  return { job: world.jobs.get(world.matterId, job.id), params }
}
