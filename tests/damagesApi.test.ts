import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { AnalysisJobService } from '../server/analysis/jobs'
import { createApp } from '../server/app'
import { damagesLabel, psychologyLabel } from '../server/damages/types'
import type { CaseStore } from '../server/db'
import { categoriesOnly, damagesLimits, damagesWorld, DamagesModel, fullInputs, fullRules } from './damagesFixtures'
import type { FrameworkOverrideInput } from '../server/frameworks/framework'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function appWorld(options: { rules?: FrameworkOverrideInput[] | false; model?: DamagesModel } = {}) {
  const world = damagesWorld(stores, { rules: options.rules, model: options.model })
  const jobs = new AnalysisJobService(world.store, damagesLimits)
  const scripted = options.model ?? new DamagesModel({ base: (category) => ({ past_income: 5_000_000, general: 12_000_000, punitive: 0 })[category]! })
  const app = createApp({ store: world.store, trialForgeModelClient: scripted, analysisJobs: jobs })
  const base = `/api/matters/${world.matterId}/damages`
  const psych = `/api/matters/${world.matterId}/damages-psychology`
  const putInputs = (inputs: unknown = fullInputs()) => request(app).put(`${base}/inputs`).send(inputs as object)
  const study = async (extra: Record<string, unknown> = {}) => {
    const preview = (await request(app).post(`${base}/study/preview`).send({ runs: 2, seed: 'api-seed', draws: 200, ...extra }).expect(200)).body
    const started = (await request(app).post(`${base}/study`).send({ ...preview.params, estimateHash: preview.job.estimate.hash }).expect(202)).body
    await jobs.whenIdle()
    return { preview, started }
  }
  return { ...world, app, jobs, base, psych, scripted, putInputs, study }
}

describe('damages inputs API', () => {
  it('serves an empty inputs view with the categories and the missing list, then saves and reloads a version', async () => {
    const { app, base, putInputs } = appWorld()
    const empty = (await request(app).get(`${base}/inputs`).expect(200)).body
    expect(Object.keys(empty).sort()).toEqual(['categories', 'currency', 'inputs', 'inputsHash', 'label', 'missing', 'rejected', 'rulesNotice', 'status', 'version'])
    expect(empty).toMatchObject({ label: damagesLabel, currency: 'CAD', version: null, inputsHash: null })
    expect(empty.categories.map((category: { id: string }) => category.id)).toEqual(['past_income', 'general', 'punitive'])
    expect(empty.inputs.fees).toEqual({ status: 'unknown' })
    const saved = (await putInputs().expect(200)).body
    expect(saved).toMatchObject({ version: 1, status: 'draft', inputsHash: expect.stringMatching(/^[a-f0-9]{64}$/), missing: [] })
    expect((await request(app).get(`${base}/inputs`).expect(200)).body.inputs.claimed).toHaveLength(2)
  })

  it('refuses malformed inputs (400) and unverifiable ones (422), and saves nothing', async () => {
    const { app, base, putInputs, matterId, store } = appWorld()
    const bad = await putInputs({ ...fullInputs(), fees: { status: 'entered', value: {} } }).expect(400)
    expect(bad.body.error).toMatch(/Enter a percentage, a fixed fee, or both/)
    const fraction = await putInputs({ ...fullInputs(), policyLimit: { status: 'entered', value: { limitCents: 10.5 } } }).expect(400)
    expect(fraction.body.error).toMatch(/limitCents/)
    const source = await putInputs({ ...fullInputs(), claimed: [{ categoryId: 'general', lowCents: null, likelyCents: 5, highCents: null, sources: [{ evidenceId: 'nope', paragraph: 1, quote: 'not a real passage' }] }] }).expect(422)
    expect(source.body.error).toMatch(/The inputs were not saved.*not part of this matter's current evidence/)
    const category = await putInputs({ ...fullInputs(), claimed: [{ categoryId: 'invented', lowCents: 1, likelyCents: 2, highCents: 3, sources: [] }] }).expect(422)
    expect(category.body.error).toMatch(/not a damages category in the chosen court rules/)
    expect((await request(app).get(`${base}/inputs`).expect(200)).body.version).toBeNull()
    expect(store.analysis.list(matterId, { kind: 'damages_model' })).toEqual([])
  })
})

describe('damages study API', () => {
  it('previews a study with its plan, parameters, pinned inputs and cost, without a run or a model call', async () => {
    const { app, base, jobs, matterId, scripted, store, putInputs } = appWorld()
    const inputs = (await putInputs().expect(200)).body
    const preview = (await request(app).post(`${base}/study/preview`).send({ runs: 4 }).expect(200)).body
    expect(preview.label).toBe(damagesLabel)
    expect(preview.params).toMatchObject({ runs: 4, mode: 'screen', draws: 1000, inputsHash: inputs.inputsHash })
    expect(preview.params.seed).toMatch(/^[0-9a-f-]{36}$/)
    expect(preview.plan).toMatchObject({ blockers: [], panelSize: 6, threshold: 5, callsPerRun: 92, currency: 'CAD', calculation: { status: 'ready', missing: [] } })
    expect(preview.job).toMatchObject({ kind: 'damages_study', estimate: { calls: 368, tokens: 36_800 }, canStart: true })
    expect(preview.job.estimate.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(jobs.list(matterId)).toEqual([])
    expect(store.workflow.listTrialRuns(matterId)).toEqual([])
    expect(scripted.count).toBe(0)
    expect((await request(app).get(base).expect(200)).body).toEqual({ label: damagesLabel, current: null })
  })

  it('runs a study through the job queue and serves the draft, the versions, one version, approval and the export, each with the label', async () => {
    const { app, base, study, matterId, jobs, putInputs } = appWorld()
    await putInputs().expect(200)
    const { started } = await study()
    expect(started.label).toBe(damagesLabel)
    expect(started.job).toMatchObject({ kind: 'damages_study', params: { runs: 2, seed: 'api-seed' } })
    expect(jobs.get(matterId, started.job.id)).toMatchObject({ status: 'succeeded', usage: { calls: 184 } })

    const body = (await request(app).get(base).expect(200)).body
    expect(body).toMatchObject({ label: damagesLabel, current: 'draft' })
    const draft = body.draft
    expect(Object.keys(draft).sort()).toEqual(['artifact', 'content', 'freshness', 'label'])
    expect(draft.artifact).toMatchObject({ kind: 'damages_model', subjectKey: 'study', status: 'draft' })
    expect(draft.content.calculation).toMatchObject({ status: 'complete', capCheck: { violations: 0 } })
    expect(Object.keys(draft.content).sort()).toEqual(['aggregationRule', 'algorithmVersion', 'amountQuestions', 'calculation', 'categories', 'categoryResults', 'complete', 'completedRuns', 'currency', 'excludedCategories', 'exploratory', 'exploratoryThreshold', 'framework', 'inputs', 'label', 'mode', 'notes', 'questions', 'requestedRuns', 'runs', 'seed', 'shift', 'usedRuns'])
    expect(JSON.stringify(draft)).toContain(damagesLabel)

    const versions = (await request(app).get(`${base}/versions`).expect(200)).body
    expect(versions.label).toBe(damagesLabel)
    expect(versions.versions.map((entry: { kind: string }) => entry.kind).sort()).toEqual(['inputs', 'study'])
    const one = (await request(app).get(`${base}/versions/${draft.artifact.id}`).expect(200)).body
    expect(one.content.categoryResults).toEqual(draft.content.categoryResults)
    await request(app).get(`${base}/versions/not-a-real-id`).expect(404)

    const approved = (await request(app).post(`${base}/approve`).send({}).expect(200)).body
    expect(approved.artifact.status).toBe('approved')
    await request(app).post(`${base}/approve`).send({}).expect(409)
    const exported = (await request(app).get(`${base}/export`).expect(200)).body
    expect(exported).toMatchObject({ label: damagesLabel, filename: expect.stringMatching(/damages-v\d+\.md$/) })
    expect(exported.markdown).toContain(damagesLabel)
    expect(exported.html).toContain('Damages')
    await request(app).get(`${base}/export?which=draft`).expect(404)
  })

  it('refuses a start that is blocked (409), one with a stale estimate hash, and one whose inputs changed since the preview', async () => {
    const blocked = appWorld({ rules: [] })
    const preview = (await request(blocked.app).post(`${blocked.base}/study/preview`).send({ runs: 2 }).expect(200)).body
    expect(preview.plan.blockers.join(' ')).toMatch(/do not state the damages categories/)
    const refused = await request(blocked.app).post(`${blocked.base}/study`).send({ ...preview.params, estimateHash: preview.job.estimate.hash }).expect(409)
    expect(refused.body.error).toMatch(/damages categories/)
    expect(blocked.store.workflow.listTrialRuns(blocked.matterId)).toEqual([])

    const world = appWorld()
    await world.putInputs().expect(200)
    const good = (await request(world.app).post(`${world.base}/study/preview`).send({ runs: 2, seed: 'x', draws: 200 }).expect(200)).body
    await request(world.app).post(`${world.base}/study`).send({ ...good.params, estimateHash: 'f'.repeat(64) }).expect(409)
    await world.putInputs({ ...fullInputs(), perDiemDays: 30 }).expect(200)
    const stale = await request(world.app).post(`${world.base}/study/preview`).send({ runs: 2, seed: 'x', inputsHash: good.params.inputsHash }).expect(409)
    expect(stale.body.error).toMatch(/inputs have changed since this preview/)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
  })

  it('shows one run\'s panel award before and after deliberation, and nothing for a run that did not opt in', async () => {
    const { app, study, store, matterId, putInputs } = appWorld({ model: new DamagesModel({ base: (c) => ({ past_income: 100_000, general: 200_000, punitive: 0 })[c]!, finalFactor: 2 }) })
    await putInputs().expect(200)
    await study()
    const [run] = store.workflow.listTrialRuns(matterId)
    const view = (await request(app).get(`/api/trials/${run!.id}/damages`).expect(200)).body
    expect(view).toMatchObject({ enabled: true, label: damagesLabel, currency: 'CAD' })
    expect(view.questions[0].categories[1]).toEqual({ categoryId: 'general', label: 'General damages', preMedianCents: 200_000, panelAwardCents: 400_000, shiftCents: 200_000 })
  })

  it('accepts damagesAmounts on a run, pins the categories from the court rules, ignores forged pinned values and refuses a malformed setting', async () => {
    const world = appWorld()
    const config = { mode: 'screen', procedureAdapter: 'ontario_civil_v1', seed: 'api-run', checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 4 }, civilDecisionMaker: 'jury', externalDisclosureConfirmed: false, ballotContract: 'v2', damagesAmounts: true }
    const created = (await request(world.app).post(`/api/matters/${world.matterId}/trials`).send({ caseModelId: world.model.id, config: { ...config, damagesCategories: [{ id: 'forged', label: 'Forged', kind: 'economic' }], damagesCurrency: 'USD' } }).expect(201)).body
    expect(created.run.config).toMatchObject({ damagesAmounts: true, damagesCurrency: 'CAD' })
    expect(created.run.config.damagesCategories.map((category: { id: string }) => category.id)).toEqual(['past_income', 'general', 'punitive'])
    await request(world.app).post(`/api/matters/${world.matterId}/trials`).send({ caseModelId: world.model.id, config: { ...config, damagesAmounts: 'yes' } }).expect(400)
    const noV2 = await request(world.app).post(`/api/matters/${world.matterId}/trials`).send({ caseModelId: world.model.id, config: { ...config, ballotContract: undefined } }).expect(400)
    expect(noV2.body.error).toMatch(/need ballot contract v2/)
  })
})

describe('damages psychology API', () => {
  const forbidding = [...categoriesOnly(), { field: 'counselMaySuggestAmounts' as const, status: 'known' as const, value: { allowed: false, scope: 'Fictional scope' }, authorities: [{ title: 'Fictional Damages Act', pinpoint: 's. 9' }] }]

  it('lists every condition with whether it can run, why not, and the text it would inject; and the research as a reference', async () => {
    const { app, psych, putInputs } = appWorld()
    await putInputs().expect(200)
    const body = (await request(app).get(`${psych}/conditions`).expect(200)).body
    expect(body.label).toBe(psychologyLabel)
    expect(body.conditions).toHaveLength(8)
    expect(body.conditions.find((entry: { conditionId: string }) => entry.conditionId === 'anchor_central')).toMatchObject({ available: true, runnable: true, plaintiffText: expect.stringContaining('$150,000.00 CAD') })
    expect(body.references).toHaveLength(2)
    const forbidden = appWorld({ rules: forbidding })
    const refused = (await request(forbidden.app).get(`${forbidden.psych}/conditions`).expect(200)).body.conditions
    expect(refused.find((entry: { conditionId: string }) => entry.conditionId === 'anchor_central')).toMatchObject({ available: false, runnable: false, reason: expect.stringMatching(/forbidden by rule pack/) })
  })

  it('refuses a forbidden condition with 422 and a readable reason, before anything is queued or run', async () => {
    const world = appWorld({ rules: forbidding })
    await world.putInputs().expect(200)
    const preview = (await request(world.app).post(`${world.psych}/study/preview`).send({ conditions: ['anchor_central'], seeds: 3, seed: 'p' }).expect(200)).body
    expect(preview.plan.blockers.join(' ')).toMatch(/Plaintiff anchor, central cannot run: forbidden by rule pack/)
    const refused = await request(world.app).post(`${world.psych}/study`).send({ ...preview.params, estimateHash: preview.job.estimate.hash }).expect(422)
    expect(refused.body.error).toMatch(/conditions cannot run: anchor_central \(forbidden by rule pack.*Nothing was run/)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
    expect(world.jobs.list(world.matterId)).toEqual([])
    // A run created directly with the condition is refused too, with 422.
    const direct = await request(world.app).post(`/api/matters/${world.matterId}/trials`).send({
      caseModelId: world.model.id,
      config: { mode: 'full', procedureAdapter: 'ontario_civil_v1', seed: 'forbidden', checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 4 }, civilDecisionMaker: 'jury', externalDisclosureConfirmed: false, ballotContract: 'v2', damagesAmounts: true, damagesCondition: { id: 'anchor_central' } },
    }).expect(422)
    expect(direct.body.error).toMatch(/cannot run: forbidden by rule pack/)
  })

  it('runs a study, serves it with the label and the references, approves and exports it', async () => {
    const world = appWorld()
    await world.putInputs().expect(200)
    const preview = (await request(world.app).post(`${world.psych}/study/preview`).send({ conditions: ['fairness_framing'], seeds: 2, seed: 'p' }).expect(200)).body
    expect(preview.plan).toMatchObject({ blockers: [], runsTotal: 4, callsPerRun: 92, requested: ['fairness_framing'] })
    expect(preview.job.estimate.calls).toBe(4 * 92)
    expect(preview.params).toMatchObject({ mode: 'full', seeds: 2, conditions: ['fairness_framing'] })
    const started = await request(world.app).post(`${world.psych}/study`).send({ ...preview.params, estimateHash: preview.job.estimate.hash }).expect(202)
    expect(started.body.label).toBe(psychologyLabel)
    await world.jobs.whenIdle()
    const body = (await request(world.app).get(world.psych).expect(200)).body
    expect(body).toMatchObject({ label: psychologyLabel, current: 'draft' })
    expect(Object.keys(body.draft.content).sort()).toEqual(['algorithmVersion', 'backfire', 'baseline', 'completedSeeds', 'complete', 'conditions', 'counterVersusCentral', 'currency', 'exploratory', 'framework', 'inputs', 'label', 'measure', 'mode', 'notes', 'numeracyNote', 'references', 'requestedSeeds', 'results', 'seed'].sort())
    expect(body.draft.content.results[0]).toMatchObject({ conditionId: 'fairness_framing', effect: { classification: expect.any(String) } })
    expect((await request(world.app).post(`${world.psych}/approve`).send({}).expect(200)).body.artifact.status).toBe('approved')
    const exported = (await request(world.app).get(`${world.psych}/export`).expect(200)).body
    expect(exported.markdown).toContain('Human research (reference only')
    expect((await request(world.app).get(`${world.psych}/versions`).expect(200)).body.versions).toHaveLength(1)
  }, 120_000)

  it('refuses a screen run and unknown condition names at the door', async () => {
    const world = appWorld()
    await world.putInputs().expect(200)
    await request(world.app).post(`${world.psych}/study/preview`).send({ conditions: ['fairness_framing'], mode: 'screen' }).expect(400)
    await request(world.app).post(`${world.psych}/study/preview`).send({ conditions: ['none'] }).expect(400)
    await request(world.app).post(`${world.psych}/study/preview`).send({ conditions: ['invented'] }).expect(400)
    expect(fullRules().length).toBeGreaterThan(0)
  })
})
