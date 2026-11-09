import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnalysisJobService } from '../server/analysis/jobs'
import { createApp } from '../server/app'
import type { ModelClient } from '../server/minimax'
import { collectOptionalSignals } from '../server/analysis/improvementPlanSignals'
import { approvedArtifactSignalSources } from '../server/analysis/improvementPlanSources'
import type { AnalysisKind } from '../server/analysis/types'
import { NOT_YET_TESTED_SENTENCE } from '../server/forecast/winRates'
import { addSource, cleanupAnalysisFixtures } from './analysisFixtures'
import { planClient, planWorld, type PlanWorld } from './improvementPlanFixtures'

vi.setConfig({ testTimeout: 30_000 }) // building the plan world takes about 2 s alone; headroom for loaded or instrumented runs

afterEach(cleanupAnalysisFixtures)

// Fictional stored studies, written straight into the analysis store. They are shaped like what the real services save,
// carry only the fields the sources read, and prove the code around them, not a study's numbers.

const canary = 'TAMARACK_STYLE_CANARY_5c19e0'
const wins = (claimantWins: number, trials: number) => ({ successes: claimantWins, trials, estimate: claimantWins / trials, lower: 0.1, upper: 0.9, confidence: 0.95 })

const liabilityRow = (issueId: string, label: string, defendantId: string, claimantWins: number, trials = 40) => ({
  issueId, label, kind: 'civil_claim', defendantId, defendantName: defendantId, burdenPartyName: 'Jordan Ellery', burdenPartyRole: 'plaintiff',
  completedRuns: trials, excludedRuns: 0, claimantWins, defenceWins: trials - claimantWins, hung: 0,
  claimantWin: wins(claimantWins, trials), defenceWin: wins(trials - claimantWins, trials), hungShare: wins(0, trials), exploratory: false, exploratoryThreshold: 20,
  statement: `Probability the plaintiff prevails: ${Math.round((claimantWins / trials) * 100)}% (${claimantWins} of ${trials} simulated panels; 95% interval 10% to 90%). ${NOT_YET_TESTED_SENTENCE}`,
  excludedReasons: [],
})

const forecastContent = () => ({
  liability: [
    liabilityRow('issue-greyvale', 'Negligence: Greyvale', 'greyvale', 12),
    liabilityRow('issue-occupier', 'Occupiers\' liability: Tamarack', 'tamarack', 32),
  ],
})

const damagesContent = () => ({
  calculation: {
    status: 'incomplete', message: 'The calculation stopped.', order: null, orderRuleRef: null, steps: [], excludedLines: [],
    missing: [{ stepId: 'interest', input: 'prejudgment interest rate', where: 'court_rules', say: 'The court rules chosen for this case do not state the prejudgment interest rate, so no net figure is given.' }],
  },
})

const psychologyContent = (backfire: boolean) => ({
  exploratory: false,
  backfire: { highId: 'anchor_high', lowerId: 'anchor_central', pairs: 12, differenceCents: -5000, interval: null, backfire, possibleBackfire: !backfire, monotone: false },
})

const styleContent = (partyId: string, partyName: string, winRate: number | null, recommendedLabel?: string) => ({
  partyId, partyName, partyRole: 'plaintiff', exploratory: false,
  baseline: { runsCompleted: 20, winRate, meanJurorShare: 0.4, meanWords: 300 },
  recommendation: { reason: 'From the study.', ...(recommendedLabel ? { recommended: 'plain_and_factual', recommendedLabel } : {}) },
})

async function world(): Promise<PlanWorld> {
  const planned = await planWorld({ theories: false, disclosure: false })
  for (const source of approvedArtifactSignalSources(planned.store, planned.service, planned.frameworks)) planned.plans.registerSignalSource(source)
  return planned
}

const sources = (w: PlanWorld) => approvedArtifactSignalSources(w.store, w.service, w.frameworks)
const collect = (w: PlanWorld, partyId: string) => collectOptionalSignals(w.matterId, partyId, sources(w))

function store(w: PlanWorld, kind: AnalysisKind, content: unknown, options: { subjectKey?: string; approve?: boolean } = {}) {
  const draft = w.service.saveDraft({
    matterId: w.matterId, kind, subjectKey: options.subjectKey, caseModelId: w.model.id,
    inputManifest: { caseModelVersion: w.model.version, evidenceHashes: w.store.listEvidence(w.matterId).flatMap((item) => (item.sha256 ? [item.sha256] : [])) },
    content,
  })
  return options.approve === false ? draft : w.service.approve(w.matterId, draft.id)
}

const kindsOf = (w: PlanWorld, partyId: string) => collect(w, partyId).signals.map((signal) => `${signal.sourceId}:${signal.key}`)

describe('the approved forecast', () => {
  it('gives a plaintiff the question the simulated panels mostly went against, with the D1 sentence and the artifact it cites', async () => {
    const w = await world()
    const forecast = store(w, 'forecast', forecastContent())
    const found = collect(w, 'ellery').signals.filter((signal) => signal.sourceId === 'approved-forecast')
    // 12 of 40 on Greyvale is against the plaintiff; 32 of 40 on Tamarack is for the plaintiff (valid control: no signal).
    expect(found.map((signal) => signal.key)).toEqual(['forecast:issue-greyvale:greyvale'])
    expect(found[0]).toMatchObject({ kind: 'forecast_signal', issueId: 'issue-greyvale', signal: { origin: 'optional_source', sourceId: forecast.id, sourceKind: 'forecast', sourceVersion: forecast.version, passages: [] } })
    expect(found[0].statement).toContain('12 of 40 simulated panels')
    expect(found[0].statement).toContain(NOT_YET_TESTED_SENTENCE)
    expect(found[0].factors.lackOfSupport).toBeCloseTo(0.7)
  })

  it('gives a respondent only the question it answers, and only when the claimant mostly prevailed', async () => {
    const w = await world()
    store(w, 'forecast', forecastContent())
    const tamarack = collect(w, 'tamarack').signals
    expect(tamarack.map((signal) => signal.key)).toEqual(['forecast:issue-occupier:tamarack'])
    expect(tamarack[0].statement).toContain(NOT_YET_TESTED_SENTENCE)
    expect(tamarack[0].statement).toMatch(/the claimant prevailed against Tamarack Quay Holdings Inc\. in 32 of 40 simulated panels/)
    // Greyvale answers a question the claimant mostly lost, and has no signal about the Tamarack question at all.
    expect(kindsOf(w, 'greyvale')).toEqual([])
  })

  it('contributes nothing while it is a draft, and nothing once it is out of date', async () => {
    const w = await world()
    const draft = store(w, 'forecast', forecastContent(), { approve: false })
    expect(kindsOf(w, 'ellery')).toEqual([])
    w.service.approve(w.matterId, draft.id)
    expect(kindsOf(w, 'ellery')).toEqual(['approved-forecast:forecast:issue-greyvale:greyvale'])
    // A source document added after the study was prepared makes it stale.
    addSource(w.store, w.matterId, 'late-addition.txt', 'A fictional document added after the study was approved.')
    expect(kindsOf(w, 'ellery')).toEqual([])
  })
})

describe('the approved damages study and damages psychology study', () => {
  it('give the party that claims the damages its missing proof, and no one else', async () => {
    const w = await world()
    const damages = store(w, 'damages_model', damagesContent(), { subjectKey: 'study' })
    const found = collect(w, 'ellery').signals.filter((signal) => signal.sourceId === 'approved-damages-study')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: 'damages_proof', issueId: 'issue-damages', signal: { sourceId: damages.id, sourceKind: 'damages_model', itemId: 'missing:interest:prejudgment interest rate', passages: [] } })
    expect(found[0].statement).toContain('prejudgment interest rate')
    expect(kindsOf(w, 'tamarack')).toEqual([])
    expect(kindsOf(w, 'greyvale')).toEqual([])
  })

  it('give a reliable anchor backfire to the claimant, and nothing for a possible one (valid control)', async () => {
    const w = await world()
    store(w, 'damages_psychology', psychologyContent(false))
    expect(kindsOf(w, 'ellery')).toEqual([])
    const backfired = store(w, 'damages_psychology', psychologyContent(true))
    const found = collect(w, 'ellery').signals.filter((signal) => signal.sourceId === 'approved-damages-psychology')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: 'forecast_signal', signal: { sourceId: backfired.id, sourceKind: 'damages_psychology' } })
    expect(found[0].statement).toMatch(/has not been tested against real outcomes/)
    expect(kindsOf(w, 'tamarack')).toEqual([])
  })

  it('contribute nothing as drafts, and nothing when out of date', async () => {
    const w = await world()
    const damages = store(w, 'damages_model', damagesContent(), { subjectKey: 'study', approve: false })
    const psychology = store(w, 'damages_psychology', psychologyContent(true), { approve: false })
    expect(kindsOf(w, 'ellery')).toEqual([])
    w.service.approve(w.matterId, damages.id)
    w.service.approve(w.matterId, psychology.id)
    expect(kindsOf(w, 'ellery')).toHaveLength(2)
    addSource(w.store, w.matterId, 'late-addition.txt', 'A fictional document added after both studies were approved.')
    expect(kindsOf(w, 'ellery')).toEqual([])
  })
})

describe('the approved style study', () => {
  it('gives the styled party its own weak baseline, with the D1 sentence, and never another party\'s study', async () => {
    const w = await world()
    store(w, 'style_study', styleContent('tamarack', 'Tamarack Quay Holdings Inc.', 0.3, canary))
    expect(kindsOf(w, 'ellery')).toEqual([])
    expect(JSON.stringify(collect(w, 'ellery'))).not.toContain(canary)
    expect(JSON.stringify(collect(w, 'greyvale'))).not.toContain(canary)
    const own = collect(w, 'tamarack').signals.filter((signal) => signal.sourceId === 'approved-style-study')
    expect(own).toHaveLength(1)
    expect(own[0].statement).toContain(NOT_YET_TESTED_SENTENCE)
    expect(own[0].statement).toContain('30%')
    expect(own[0].signal).toMatchObject({ sourceKind: 'style_study', itemId: 'baseline', passages: [] })
  })

  it('gives nothing for a baseline that carried the decision at least half the time, or none at all (valid control)', async () => {
    const w = await world()
    store(w, 'style_study', styleContent('ellery', 'Jordan Ellery', 0.5))
    expect(kindsOf(w, 'ellery')).toEqual([])
    store(w, 'style_study', styleContent('ellery', 'Jordan Ellery', null))
    expect(kindsOf(w, 'ellery')).toEqual([])
    store(w, 'style_study', styleContent('ellery', 'Jordan Ellery', 0.35, 'Plain and factual'))
    const found = collect(w, 'ellery').signals
    expect(found).toHaveLength(1)
    expect(found[0].statement).toContain('"Plain and factual" style')
  })

  it('contributes nothing as a draft', async () => {
    const w = await world()
    store(w, 'style_study', styleContent('ellery', 'Jordan Ellery', 0.2), { approve: false })
    expect(kindsOf(w, 'ellery')).toEqual([])
  })
})

describe('the improvement plan reads the sources', () => {
  it('cites each approved study in the register of the party it is about, and keeps the other party\'s private study out of the plan', async () => {
    const w = await world()
    const forecast = store(w, 'forecast', forecastContent())
    store(w, 'damages_model', damagesContent(), { subjectKey: 'study' })
    store(w, 'style_study', styleContent('tamarack', 'Tamarack Quay Holdings Inc.', 0.3, canary))

    const ellery = await w.plans.generate(w.matterId, { client: planClient({}), partyId: 'ellery', maxCures: 1, maxIdeas: 0 })
    const fromSources = ellery.content.register.filter((item) => item.kind === 'forecast_signal' || item.kind === 'damages_proof')
    expect(fromSources.map((item) => item.kind).sort()).toEqual(['damages_proof', 'forecast_signal'])
    const cited = fromSources.find((item) => item.kind === 'forecast_signal')!
    expect(cited.signals[0]).toMatchObject({ origin: 'optional_source', sourceId: forecast.id, sourceKind: 'forecast' })
    expect(cited.statement).toContain(NOT_YET_TESTED_SENTENCE)
    expect(ellery.content.optionalSources.map((entry) => `${entry.id}=${entry.count}`)).toEqual([
      'approved-forecast=1', 'approved-damages-study=1', 'approved-damages-psychology=0', 'approved-style-study=0',
    ])
    expect(JSON.stringify(ellery)).not.toContain(canary)

    const tamarack = await w.plans.generate(w.matterId, { client: planClient({}), partyId: 'tamarack', maxCures: 1, maxIdeas: 0 })
    expect(tamarack.content.register.filter((item) => item.kind === 'damages_proof')).toEqual([])
    // Its own forecast question and its own style study (a forecast signal with no question), nothing of Jordan Ellery's.
    expect(tamarack.content.register.filter((item) => item.kind === 'forecast_signal').map((item) => item.key).sort())
      .toEqual(['optional:approved-forecast:forecast:issue-occupier:tamarack', 'optional:approved-style-study:style-study:baseline'])
    expect(tamarack.content.optionalSources.find((entry) => entry.id === 'approved-style-study')?.count).toBe(1)
  })

  it('reads no study at all while none is approved, and says so', async () => {
    const w = await world()
    store(w, 'forecast', forecastContent(), { approve: false })
    const plan = await w.plans.generate(w.matterId, { client: planClient({}), partyId: 'ellery', maxCures: 1, maxIdeas: 0 })
    expect(plan.content.register.some((item) => item.kind === 'forecast_signal' || item.kind === 'damages_proof')).toBe(false)
    expect(plan.content.optionalSources.every((entry) => entry.status === 'none' && entry.count === 0)).toBe(true)
  })
})

describe('the app wires the sources into the plan route', () => {
  it('reports the approved forecast in the plan prerequisites once it is approved, and not before', async () => {
    const w = await planWorld({ theories: false, disclosure: false })
    class Unused implements ModelClient { async generateStage(): Promise<never> { throw new Error('No simulation model call is expected here.') } }
    const jobs = new AnalysisJobService(w.store, { tokensPerCall: 100, defaultMaxCalls: 20, absoluteMaxCalls: 50, maxConcurrentJobs: 2 })
    const app = createApp({ store: w.store, trialForgeModelClient: new Unused(), analysisJobs: jobs, structuredModelClient: planClient({}) })
    const optional = async () => {
      const body = (await request(app).post(`/api/matters/${w.matterId}/improvement-plan/generate/preview`).send({}).expect(200)).body
      return body.prerequisites.items.find((item: { key: string }) => item.key === 'optional_sources') as { status: string; detail: string }
    }
    expect((await optional()).detail).toContain('Approved forecast: 0 signals')
    store(w, 'forecast', forecastContent())
    const after = await optional()
    expect(after.status).toBe('available')
    expect(after.detail).toContain('Approved forecast: 1 signal;')
  })
})
