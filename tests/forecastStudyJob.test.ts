import { afterEach, describe, expect, it } from 'vitest'

import { CaseWorkflowService } from '../server/caseWorkflow'
import { createMatterArchive, importMatterArchive } from '../server/matterArchive'
import { AnalysisJobError } from '../server/analysis/jobs'
import { forecastLabel, type ForecastContent } from '../server/analysis/forecast'
import { NOT_YET_TESTED_SENTENCE } from '../server/forecast/winRates'
import { estimateRunCalls } from '../src/runEstimate'
import type { CaseStore } from '../server/db'
import { expectedJurorShare, forecastWorld, PlantedModel, runStudy, strongExhibit, weakExhibit, type ForecastWorld } from './forecastFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const contentOf = (world: ForecastWorld): ForecastContent => world.forecast.view(world.matterId).draft!.content
const slow = 120_000

describe('forecast study: cost preview, hard cap and the job queue', () => {
  it('previews calls as runs times the run screen estimate, with no model call and no stored run', () => {
    const world = forecastWorld(stores)
    const plan = world.forecast.plan(world.matterId, { runs: 5, mode: 'screen', seed: 's' })
    const perRun = estimateRunCalls({ panel: 6, issues: 1, parties: 2, approvedMotions: 0, mode: 'screen', witnesses: 0 }).calls
    expect(plan).toMatchObject({ blockers: [], panelSize: 6, threshold: 5, juryQuestions: 1, judgeQuestions: 0, callsPerRun: perRun, existingRuns: 0 })
    const preview = world.jobs.preview(world.matterId, { kind: 'forecast', params: { runs: 5, mode: 'screen', seed: 's' } })
    expect(preview.estimate.calls).toBe(5 * perRun)
    expect(preview).toMatchObject({ canStart: true, cap: { maxCalls: 1_000 } })
    expect(world.scripted.count).toBe(0)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
    expect(world.jobs.list(world.matterId)).toEqual([])
  })

  it('the estimate is a ceiling for a scripted run: it counts a source check for every stage', async () => {
    const world = forecastWorld(stores)
    const { job } = await runStudy(world, { runs: 2 })
    expect(job.status).toBe('succeeded')
    expect(world.scripted.count / 2).toBeLessThanOrEqual(job.estimate.calls / 2)
    expect(job.usage.calls).toBe(job.estimate.calls)
  })

  it('refuses a study over the cap, and a raise above the ceiling, before any model call', () => {
    const world = forecastWorld(stores, { limits: { tokensPerCall: 100, defaultMaxCalls: 150, absoluteMaxCalls: 400, maxConcurrentJobs: 2 } })
    const params = { runs: 3, mode: 'screen' as const, seed: 's' }
    const over = world.jobs.preview(world.matterId, { kind: 'forecast', params })
    expect(over).toMatchObject({ canStart: false, requiresAcknowledgement: true })
    expect(over.refusal).toMatch(/estimated at 204 calls.*over its cap of 150/)
    expect(() => world.jobs.start(world.matterId, { kind: 'forecast', params, estimateHash: over.estimate.hash })).toThrow(AnalysisJobError)
    // A raise needs an acknowledgement, and no cap may pass the ceiling.
    expect(world.jobs.preview(world.matterId, { kind: 'forecast', params, maxCalls: 300 }).canStart).toBe(false)
    expect(world.jobs.preview(world.matterId, { kind: 'forecast', params, maxCalls: 300, acknowledgeCost: true }).canStart).toBe(true)
    const huge = world.jobs.preview(world.matterId, { kind: 'forecast', params: { ...params, runs: 20 }, maxCalls: 9_999, acknowledgeCost: true })
    expect(huge.canStart).toBe(false)
    expect(huge.refusal).toMatch(/cannot be capped above 400 calls/)
    expect(world.scripted.count).toBe(0)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
  })

  it('a study that exactly fills its cap ends as succeeded and keeps its draft (the cap is reached, nothing is cut off)', async () => {
    const world = forecastWorld(stores)
    const { job } = await runStudy(world, { runs: 2, maxCalls: 136 })
    expect(job.usage.calls).toBe(136)
    expect(job.status).toBe('succeeded')
    expect(job.resultArtifactIds).toHaveLength(1)
    expect(contentOf(world).completedRuns).toBe(2)
  })

  it('runs one simulated panel at a time, never all at once', async () => {
    const world = forecastWorld(stores)
    let overlap = 0
    world.scripted.beforeCall = () => {
      const running = world.store.workflow.listTrialRuns(world.matterId).filter((run) => run.status === 'running').length
      overlap = Math.max(overlap, running)
    }
    await runStudy(world, { runs: 4 })
    expect(overlap).toBe(1)
  })

  it('blocks a study on unknown court rules with a readable message, and calls no model', async () => {
    const none = forecastWorld(stores, { framework: false })
    const plan = none.forecast.plan(none.matterId, { runs: 3, mode: 'screen', seed: 's' })
    expect(plan.blockers.join(' ')).toMatch(/No court rules are chosen.*are unknown\. .*Unknown is not treated as six jurors/)
    expect(none.jobs.preview(none.matterId, { kind: 'forecast', params: { runs: 3, mode: 'screen', seed: 's' } }).estimate.calls).toBe(0)

    const unknownSize = forecastWorld(stores, { framework: [{ field: 'panelSize', status: 'unknown', reason: 'Not yet researched.' }] })
    const blocked = unknownSize.forecast.plan(unknownSize.matterId, { runs: 3, mode: 'screen', seed: 's' })
    expect(blocked.blockers.join(' ')).toMatch(/do not state panel size \(unknown\)/i)
    expect(blocked.panelSize).toBeNull()
    await expect(runStudy(unknownSize, { runs: 3 })).resolves.toMatchObject({ job: { status: 'failed' } })
    expect(unknownSize.scripted.count).toBe(0)
    expect(unknownSize.store.workflow.listTrialRuns(unknownSize.matterId)).toEqual([])
  })
})

describe('forecast study: what is stored and pinned', () => {
  it('stores ordinary runs, pins the study in the artifact manifest, and saves frozen numbers', async () => {
    const world = forecastWorld(stores, { evidence: [strongExhibit] })
    const { job, params } = await runStudy(world, { runs: 3 })
    expect(job.status).toBe('succeeded')
    const runs = world.store.workflow.listTrialRuns(world.matterId)
    expect(runs).toHaveLength(3)
    expect(new Set(runs.map((run) => run.seed)).size).toBe(3)
    for (const run of runs) {
      expect(run).toMatchObject({ status: 'completed', mode: 'screen', procedureAdapter: 'ontario_civil_v1' })
      expect(run.config.framework).toMatchObject({ panelSize: 6, threshold: 5, packId: 'ontario_civil_2026_11' })
      expect(run.seed.startsWith(`${params.seed}:run-`)).toBe(true)
    }
    const draft = world.forecast.view(world.matterId).draft!
    const manifest = draft.artifact.inputManifest
    expect(manifest).toMatchObject({ algorithmVersion: 'forecast-1', seed: 'study-seed', caseModelVersion: world.model.version })
    expect(manifest.runIds).toEqual(runs.map((run) => run.id).sort())
    expect(manifest.rulePackHash).toBe(runs[0]!.config.framework!.packHash)
    expect(manifest.admissionLedgerId).toBe(runs[0]!.admissionLedgerId)
    expect(draft.artifact).toMatchObject({ kind: 'forecast', status: 'draft', version: 1 })
    expect(job.resultArtifactIds).toEqual([draft.artifact.id])
    expect(draft.freshness.status).toBe('current')
    expect(draft.content.framework).toMatchObject({ panelSize: 6, threshold: 5, reviewStatus: 'unreviewed' })
    // The stored artifact holds the numbers; a read never recomputes them.
    const stored = world.analysis.get(world.matterId, draft.artifact.id).content as ForecastContent
    expect(stored.liability).toEqual(draft.content.liability)
    expect(stored.models[0]!.modelled).toEqual(draft.content.models[0]!.modelled)
  })

  it('stored results do not change when the runs are read again: recomputing from the stored runs and the seed gives the same hash', async () => {
    const world = forecastWorld(stores, { evidence: [strongExhibit] })
    const { params } = await runStudy(world, { runs: 4 })
    const first = world.forecast.view(world.matterId).draft!
    const again = world.forecast.computeAndSave(world.matterId, params)!
    expect(again.version).toBe(2)
    expect(again.contentHash).toBe(first.artifact.contentHash)
  })

  it('reproduces from the seed alone: a new matter with the same inputs and seed gives the same numbers', async () => {
    const a = forecastWorld(stores, { evidence: [strongExhibit] })
    const b = forecastWorld(stores, { evidence: [strongExhibit] })
    await runStudy(a, { runs: 6 })
    await runStudy(b, { runs: 6 })
    const strip = (content: ForecastContent) => ({ ...content, runs: content.runs.map((run) => ({ ...run, runId: '' })) })
    expect(strip(contentOf(a))).toEqual(strip(contentOf(b)))
    expect(contentOf(a).models[0]!.jurorShare.final).toBeGreaterThan(0)
  })
})

describe('forecast study: resumes after an interruption', () => {
  it('keeps finished runs, retries the one that failed, and never repeats a finished run', async () => {
    const world = forecastWorld(stores, { evidence: [strongExhibit] })
    // The provider goes away during the third run, and stays away until it is switched back on.
    let providerDown = true
    world.scripted.beforeCall = (_index, request) => {
      const runs = world.store.workflow.listTrialRuns(world.matterId).length
      if (providerDown && runs === 3 && request.stage !== 'juror_ballot') throw new Error('The scripted provider went away.')
    }
    const { job, params } = await runStudy(world, { runs: 5 })
    expect(job).toMatchObject({ status: 'failed', usage: { calls: 2 * 68 } })
    expect(job.error).toMatch(/scripted provider went away/)
    const afterFailure = world.store.workflow.listTrialRuns(world.matterId)
    expect(afterFailure.map((run) => run.status).sort()).toEqual(['completed', 'completed', 'failed'])
    const finishedIds = afterFailure.filter((run) => run.status === 'completed').map((run) => run.id)
    const finishedEvents = finishedIds.map((id) => world.store.workflow.listTrialEvents(id).length)
    expect(world.forecast.view(world.matterId).current).toBeNull()

    providerDown = false
    const resumed = world.jobs.resume(world.matterId, job.id)
    expect(['queued', 'running']).toContain(resumed.status)
    await world.jobs.whenIdle()
    const done = world.jobs.get(world.matterId, job.id)
    expect(done.status).toBe('succeeded')
    const runs = world.store.workflow.listTrialRuns(world.matterId)
    expect(runs).toHaveLength(5)
    expect(runs.every((run) => run.status === 'completed')).toBe(true)
    // The runs that had finished were not touched again.
    expect(finishedIds.map((id) => world.store.workflow.listTrialEvents(id).length)).toEqual(finishedEvents)
    const content = contentOf(world)
    expect(content).toMatchObject({ completedRuns: 5, requestedRuns: 5, complete: true })
    expect(content.runs.map((run) => run.seed)).toEqual(Array.from({ length: 5 }, (_, index) => `${params.seed}:run-00${index + 1}`))
    expect(done.usage.calls).toBe(5 * 68)
  }, slow)

  it('refuses to start a second study on a seed that is already waiting or running', async () => {
    const world = forecastWorld(stores)
    const params = { runs: 2, mode: 'screen' as const, seed: 'busy' }
    const preview = world.jobs.preview(world.matterId, { kind: 'forecast', params })
    world.jobs.start(world.matterId, { kind: 'forecast', params, estimateHash: preview.estimate.hash })
    expect(() => world.forecast.assertNotRunning(world.matterId, 'busy', world.jobs)).toThrow(/already waiting or running/)
    await world.jobs.whenIdle()
    expect(() => world.forecast.assertNotRunning(world.matterId, 'busy', world.jobs)).not.toThrow()
  })
})

describe('forecast study: the result moves with the evidence (metamorphic, scripted jurors)', () => {
  const runs = 20

  async function shareFor(evidence: Array<{ name: string; text: string }>, seed = 'metamorphic') {
    const world = forecastWorld(stores, { evidence })
    await runStudy(world, { runs, seed, maxCalls: 2_000, acknowledgeCost: true })
    const content = contentOf(world)
    const row = content.liability[0]!
    return { world, content, share: content.models[0]!.jurorShare.final!, win: row.claimantWin }
  }

  it('strengthening the planted evidence raises the claimant share, and weakening or removing it lowers it', async () => {
    const strong = await shareFor([strongExhibit])
    const none = await shareFor([])
    const weak = await shareFor([weakExhibit])
    // Expected juror shares are 0.8, 0.5 and 0.2; with 120 simulated jurors each, the standard error is about 0.04.
    expect(strong.share).toBeGreaterThan(none.share)
    expect(none.share).toBeGreaterThan(weak.share)
    expect(Math.abs(strong.share - expectedJurorShare.strong)).toBeLessThan(0.12)
    expect(Math.abs(none.share - expectedJurorShare.none)).toBeLessThan(0.12)
    expect(Math.abs(weak.share - expectedJurorShare.weak)).toBeLessThan(0.12)
    // The win rates over runs move the same way, and the strong and weak intervals do not overlap.
    expect(strong.win.estimate!).toBeGreaterThan(none.win.estimate! - 1e-9)
    expect(none.win.estimate!).toBeGreaterThanOrEqual(weak.win.estimate!)
    expect(strong.win.lower).toBeGreaterThan(weak.win.upper)
  }, slow)

  it('swapping exhibit order or names moves the result less than seed noise', async () => {
    const base = await shareFor([strongExhibit, { name: 'diary.txt', text: 'A fictional diary entry about a fictional picnic.' }])
    const swapped = await shareFor([{ name: 'zzz-diary.txt', text: 'A fictional diary entry about a fictional picnic.' }, { name: 'aaa-witness.txt', text: strongExhibit.text }])
    const otherSeed = await shareFor([strongExhibit, { name: 'diary.txt', text: 'A fictional diary entry about a fictional picnic.' }], 'another-metamorphic-seed')
    const standardError = Math.sqrt(0.8 * 0.2 / (runs * 6))
    const swapMove = Math.abs(base.share - swapped.share)
    expect(swapMove).toBeLessThan(standardError)
    // Seed noise is real: a different seed moves the share by more than a renaming does.
    expect(Math.abs(base.share - otherSeed.share)).toBeGreaterThanOrEqual(swapMove)
    // And the evidence effect dwarfs both.
    const none = await shareFor([{ name: 'diary.txt', text: 'A fictional diary entry about a fictional picnic.' }])
    expect(base.share - none.share).toBeGreaterThan(5 * standardError)
  }, slow)
})

describe('forecast study: approval, freshness and the label', () => {
  it('approves a draft, flags a changed case model as out of date, and carries the label on every answer', async () => {
    const world = forecastWorld(stores, { evidence: [strongExhibit] })
    await runStudy(world, { runs: 3 })
    expect(world.forecast.view(world.matterId).label).toBe(forecastLabel)
    const approved = world.forecast.approve(world.matterId)
    expect(approved.artifact.status).toBe('approved')
    expect(approved.label).toBe(forecastLabel)
    expect(world.forecast.view(world.matterId)).toMatchObject({ current: 'approved' })
    expect(world.forecast.versions(world.matterId)).toMatchObject({ label: forecastLabel, versions: [{ status: 'approved', completedRuns: 3, requestedRuns: 3, exploratory: true }] })

    // A newer case model makes the result out of date. Nothing is recalculated for it.
    const workflow = new CaseWorkflowService(world.store)
    workflow.approveCaseModel(workflow.reviseCaseModel(world.model.id, { unresolved: ['A new open point.'] }).id)
    const view = world.forecast.view(world.matterId).approved!
    expect(view.freshness.status).toBe('out_of_date')
    expect(view.freshness.reasons.join(' ')).toMatch(/case model has changed/i)
  })

  it('exports Markdown and HTML that open and close with the label, and say the figure is not tested', async () => {
    const world = forecastWorld(stores, { evidence: [strongExhibit] })
    await runStudy(world, { runs: 3 })
    const report = world.forecast.exportReport(world.matterId)
    for (const text of [report.markdown, report.html]) {
      expect(text).toContain(NOT_YET_TESTED_SENTENCE)
      expect(text).toMatch(/no calibrated estimate in this build/)
      expect(text).toContain('Probability the plaintiff prevails')
      expect(text).toContain('Exploratory')
    }
    expect(report.markdown.split(NOT_YET_TESTED_SENTENCE).length - 1).toBeGreaterThanOrEqual(3)
    expect(report.markdown.indexOf('Important:')).toBeLessThan(report.markdown.indexOf('## The study'))
    expect(report.filename).toMatch(/forecast-v1\.md$/)
  })
})

describe('forecast study: element findings (ballot contract v2)', () => {
  it('reports each element as a juror share and never as a probability of winning', async () => {
    const world = forecastWorld(stores, { evidence: [strongExhibit] })
    const { job } = await runStudy(world, { runs: 3, ballotContractV2: true })
    expect(job.status).toBe('succeeded')
    const content = contentOf(world)
    expect(content.ballotContract).toBe('v2')
    expect(content.elements.map((element) => element.elementLabel)).toEqual(['Breach of the standard of care', 'Duty of care'])
    // The scripted jurors always find the first element met, and the second only when they side with the claimant.
    const duty = content.elements.find((element) => element.elementId === 'claim-duty')!
    const breach = content.elements.find((element) => element.elementId === 'claim-breach')!
    expect(duty.jurorShare).toBe(1)
    expect(breach.jurorShare).toBeCloseTo(content.models[0]!.jurorShare.final!, 9)
    expect(duty.panelMet).toBeNull()
    expect(breach.panelMet).toBeNull()
    expect(content.liability[0]!.claimantWin.estimate).not.toBeCloseTo(duty.jurorShare! * breach.jurorShare!, 3)
  })
})

describe('forecast study: preparation never reaches a simulated juror', () => {
  it('no model request for a later run carries the forecast label or any forecast text', async () => {
    const model = new PlantedModel()
    const world = forecastWorld(stores, { evidence: [strongExhibit], model })
    await runStudy(world, { runs: 2 })
    const before = model.requests.length
    await runStudy(world, { runs: 2, seed: 'second-study' })
    const later = model.requests.slice(before)
    expect(later.length).toBeGreaterThan(0)
    for (const request of later) {
      const text = JSON.stringify(request)
      expect(text).not.toContain(NOT_YET_TESTED_SENTENCE)
      expect(text).not.toMatch(/calibrated estimate|forecast-1|simulated panels/i)
    }
  })
})

describe('forecast study: a failed ballot is a missing ballot, never a hung panel', () => {
  it('leaves that run out of the question, with the reason, and counts it as excluded', async () => {
    const world = forecastWorld(stores, { evidence: [strongExhibit] })
    // One juror's ballot calls fail in the second run only. The engine saves the ballot invalid and finishes the run.
    world.scripted.beforeCall = (_index, request) => {
      const runs = world.store.workflow.listTrialRuns(world.matterId).length
      if (runs === 2 && request.stage === 'juror_ballot' && request.jurorProfiles?.[0]?.juror === 'juror-02') throw new Error('One juror call failed.')
    }
    const { job } = await runStudy(world, { runs: 4 })
    expect(job.status).toBe('succeeded')
    const row = contentOf(world).liability[0]!
    expect(row.excludedRuns).toBe(1)
    expect(row.completedRuns).toBe(3)
    expect(row.claimantWins + row.defenceWins + row.hung).toBe(3)
    expect(row.excludedReasons).toEqual([{ reason: '5 valid final ballots, expected 6.', runs: 1 }])
    expect(row.statement).toContain('of 3 simulated panels')
  })
})

describe('forecast study: archives', () => {
  it('round-trips a saved forecast: run ids are remapped, the hash is recomputed, and the numbers and label are unchanged', async () => {
    const world = forecastWorld(stores, { evidence: [strongExhibit] })
    await runStudy(world, { runs: 3 })
    const original = world.forecast.view(world.matterId).draft!
    const archive = await createMatterArchive(world.store, world.matterId)
    const imported = await importMatterArchive(world.store, JSON.parse(JSON.stringify(archive)))
    const copy = world.forecast.view(imported.id).draft!
    const newRuns = world.store.workflow.listTrialRuns(imported.id)
    expect(newRuns).toHaveLength(3)
    expect([...copy.artifact.inputManifest.runIds!].sort()).toEqual(newRuns.map((run) => run.id).sort())
    expect(copy.artifact.inputManifest.runIds).not.toEqual(original.artifact.inputManifest.runIds)
    expect(copy.artifact.inputManifest).toMatchObject({ seed: 'study-seed', algorithmVersion: 'forecast-1' })
    expect(copy.content.liability).toEqual(original.content.liability)
    expect(copy.content.models).toEqual(original.content.models)
    expect(copy.content.runs.map((run) => run.runId).sort()).toEqual(newRuns.map((run) => run.id).sort())
    expect(copy.label).toBe(forecastLabel)
  })
})

