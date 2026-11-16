import { AnalysisJobService, type AnalysisJob } from '../server/analysis/jobs'
import { AnalysisService } from '../server/analysis/service'
import { normalizeStyleStudyParams, registerStyleStudyJob, StyleStudyService } from '../server/analysis/styleStudy'
import type { CaseStore } from '../server/db'
import { FrameworkService } from '../server/frameworks/service'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import type { FrameworkOverrideInput } from '../server/frameworks/framework'
import type { ModelClient, StageRequest } from '../server/minimax'
import { advocacyStyles } from '../server/styles/catalogue'
import type { StyleStudyJobParams } from '../server/styles/types'
import { TrialEngineService } from '../server/trialEngine'
import { cognitionWorld, type CognitionWorld } from './cognitionFixtures'
import { PlantedModel } from './forecastFixtures'

// Fictional fixtures for the advocacy style study tests (F15). A scripted model plays the advocates and the jurors. The plaintiff's argument
// carries a tag naming the style it was given and its length, and a simulated juror's vote moves with a PLANTED boost that depends on that tag, so
// a style effect (or a pure length effect) can be planted and the study must recover it, or report nothing. Nothing here calls a model, and nothing
// proves how a live model behaves.

export const styleLimits = { tokensPerCall: 100, defaultMaxCalls: 5_000, absoluteMaxCalls: 20_000, maxConcurrentJobs: 2 }

export interface StyleScript {
  // Claimant-side boost for a juror (added to a base of 0.5 plus the juror's own noise): a value of 0.12 moves the claimant share from 0.5 to 0.8.
  boost?: (style: string, words: number) => number
  // Words in the plaintiff's argument. The default depends on the style, plus noise that varies from one call to the next.
  words?: (style: string, call: number) => number
}

export const defaultWords = (style: string, call: number): number => {
  const base: Record<string, number> = { none: 200, concise: 100, thorough: 400 }
  return (base[style] ?? 200) + 10 * ((call * 7 + 3) % 5)
}

const tagOf = (party: string, style: string, words: number) => `[[d:${party}:${style}:${words}]]`
const tagPattern = /\[\[d:plaintiff:([a-z_]+):(\d+)\]\]/g

export function styleInPacket(packet: string): string {
  return advocacyStyles.find((style) => packet.includes(style.text))?.id ?? 'none'
}

export class StyleModel implements ModelClient {
  readonly requests: StageRequest[] = []
  private readonly inner = new PlantedModel()
  private readonly script: StyleScript
  private calls = 0

  constructor(script: StyleScript = {}) {
    this.script = script
  }

  get count() { return this.requests.length }
  // Set by a test that needs to know how many runs exist when a call is made.
  runsSeen: () => number = () => 0

  async generateStage(request: StageRequest) {
    this.requests.push(request)
    const result = await this.inner.generateStage(request)
    const exhibit = request.evidence[0]?.exhibitId ?? 'E-001'
    if (/_opening$|_rebuttal$/.test(request.stage)) {
      const party = request.stage.startsWith('crown') ? 'plaintiff' : 'defendant-1'
      const style = styleInPacket(request.packet)
      const words = (this.script.words ?? defaultWords)(style, this.calls++)
      return { ...result, content: `${request.stage} argument ${tagOf(party, style, words)} [${exhibit}] ${'word '.repeat(words)}`.trim(), citations: [exhibit] }
    }
    if (request.stage !== 'juror_ballot' || !result.jurors?.[0]) return result
    // The juror reads the plaintiff's arguments on the record. A boost moves the juror toward the claimant side.
    const tags = [...request.previousTurns.matchAll(tagPattern)].map((match) => ({ style: match[1]!, words: Number(match[2]) }))
    const boost = tags.length ? Math.max(...tags.map((tag) => (this.script.boost ?? (() => 0))(tag.style, tag.words))) : 0
    const profile = request.jurorProfiles?.[0]
    const claimantSide = profile !== undefined && 0.5 + 0.4 * (0.5 - profile.burdenSensitivity / 100) + boost >= 0.5
    const juror = result.jurors[0]
    return { ...result, jurors: [{ ...juror, leaning: claimantSide ? 'crown' as const : 'defence' as const }] }
  }
}

export interface StyleWorld extends CognitionWorld {
  scripted: StyleModel
  engine: TrialEngineService
  jobs: AnalysisJobService
  styles: StyleStudyService
  frameworks: FrameworkService
  analysis: AnalysisService
}

export function styleWorld(stores: CaseStore[], options: { framework?: boolean | FrameworkOverrideInput[]; limits?: typeof styleLimits; model?: StyleModel; script?: StyleScript } = {}): StyleWorld {
  const world = cognitionWorld(stores)
  const scripted = options.model ?? new StyleModel(options.script)
  const engine = new TrialEngineService(world.store, scripted)
  const frameworks = new FrameworkService(world.store)
  if (options.framework !== false) frameworks.setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'Fictional Paralegal', overrides: Array.isArray(options.framework) ? options.framework : [] })
  const analysis = new AnalysisService(world.store)
  const jobs = new AnalysisJobService(world.store, options.limits ?? styleLimits)
  const styles = new StyleStudyService(world.store, analysis, frameworks)
  registerStyleStudyJob(jobs, styles, engine)
  return { ...world, scripted, engine, jobs, styles, frameworks, analysis }
}

// Previews the study and starts it exactly as a person would, then waits for the queue to finish.
export async function runStyleStudy(world: StyleWorld, input: Partial<StyleStudyJobParams> & { maxCalls?: number; acknowledgeCost?: boolean } = {}): Promise<{ job: AnalysisJob; params: StyleStudyJobParams }> {
  const { maxCalls, acknowledgeCost, ...rest } = input
  const params = normalizeStyleStudyParams({ partyId: 'plaintiff', seed: 'style-study', ...rest })
  const preview = world.jobs.preview(world.matterId, { kind: 'style_study', params: { ...params }, maxCalls, acknowledgeCost })
  const job = world.jobs.start(world.matterId, { kind: 'style_study', params: { ...params }, maxCalls, acknowledgeCost, estimateHash: preview.estimate.hash })
  await world.jobs.whenIdle()
  return { job: world.jobs.get(world.matterId, job.id), params }
}
