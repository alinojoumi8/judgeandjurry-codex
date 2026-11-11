import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { AnalysisJobError } from '../server/analysis/jobs'
import { createMatterArchive, importMatterArchive, type MatterArchive } from '../server/matterArchive'
import { NOT_YET_TESTED_SENTENCE } from '../server/forecast/winRates'
import type { CaseStore } from '../server/db'
import { styleCatalogueVersion, styleById } from '../server/styles/catalogue'
import { styleStudyLabel, type StyleStudyContent } from '../server/styles/types'
import { estimateRunCalls } from '../src/runEstimate'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import { categoriesOnly } from './damagesFixtures'
import { runStyleStudy, StyleModel, styleWorld, type StyleWorld } from './styleFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const slow = 180_000
const perRun = estimateRunCalls({ panel: 6, issues: 1, parties: 2, approvedMotions: 0, mode: 'screen', witnesses: 0 }).calls
const contentOf = (world: StyleWorld): StyleStudyContent => world.styles.view(world.matterId).draft!.content
const rowOf = (content: StyleStudyContent, id: string) => content.results.find((row) => row.styleId === id)!

describe('style study: plan, cost preview and the job queue', () => {
  it('previews calls as common seeds times (the baseline and every style) times the run screen estimate, and runs nothing', () => {
    const world = styleWorld(stores)
    const params = { runs: 5, mode: 'screen' as const, seed: 's', partyId: 'plaintiff', styles: ['moral_appeal' as const, 'concise' as const] }
    const plan = world.styles.plan(world.matterId, params)
    expect(plan).toMatchObject({ blockers: [], panelSize: 6, threshold: 5, juryQuestions: 1, runsTotal: 15, callsPerRun: perRun, existingRuns: 0, party: { id: 'plaintiff' }, catalogueVersion: styleCatalogueVersion })
    const preview = world.jobs.preview(world.matterId, { kind: 'style_study', params })
    expect(preview.estimate.calls).toBe(5 * 3 * perRun)
    expect(preview).toMatchObject({ canStart: true, cap: { maxCalls: 5_000 } })
    expect(preview.estimate.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(world.scripted.count).toBe(0)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
    expect(world.jobs.list(world.matterId)).toEqual([])
  })

  it('replaces the 24-variant limit for this study: a study of more than 24 runs is priced and capped by the job queue instead', () => {
    const world = styleWorld(stores)
    const params = { runs: 30, mode: 'screen' as const, seed: 's', partyId: 'plaintiff', styles: ['moral_appeal' as const, 'concise' as const, 'thorough' as const] }
    // 30 seeds x 4 conditions = 120 runs, far past 24.
    expect(world.styles.plan(world.matterId, params).runsTotal).toBe(120)
    const preview = world.jobs.preview(world.matterId, { kind: 'style_study', params })
    expect(preview.estimate.calls).toBe(120 * perRun)
    // 120 x 68 = 8,160 calls is over the default cap of 5,000: the cap, not a fixed 24, stops it unless the cost is acknowledged.
    expect(preview).toMatchObject({ canStart: false, requiresAcknowledgement: true })
    expect(preview.refusal).toMatch(/over its cap/)
    expect(world.jobs.preview(world.matterId, { kind: 'style_study', params, maxCalls: 9_000, acknowledgeCost: true }).canStart).toBe(true)
    // The legacy robustness variants keep their own limit of 24: that path is unchanged.
    const run = world.engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { mode: 'screen', procedureAdapter: 'ontario_civil_v1', seed: 'legacy', checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 4 }, civilDecisionMaker: 'jury', externalDisclosureConfirmed: false } }).run
    expect(world.engine.createRobustnessVariants(run.id, Array.from({ length: 30 }, (_, index) => `legacy-${index}`))).toHaveLength(24)
  })

  it('refuses a study over the cap, and a raise above the ceiling, before any model call', () => {
    const world = styleWorld(stores, { limits: { tokensPerCall: 100, defaultMaxCalls: 150, absoluteMaxCalls: 400, maxConcurrentJobs: 2 } })
    const params = { runs: 2, mode: 'screen' as const, seed: 's', partyId: 'plaintiff', styles: ['concise' as const] }
    const over = world.jobs.preview(world.matterId, { kind: 'style_study', params })
    expect(over).toMatchObject({ canStart: false, requiresAcknowledgement: true })
    expect(() => world.jobs.start(world.matterId, { kind: 'style_study', params, estimateHash: over.estimate.hash })).toThrow(AnalysisJobError)
    expect(() => world.jobs.start(world.matterId, { kind: 'style_study', params, estimateHash: 'f'.repeat(64) })).toThrow(/cost estimate has changed/)
    expect(world.jobs.preview(world.matterId, { kind: 'style_study', params: { ...params, runs: 20 }, maxCalls: 9_999, acknowledgeCost: true }).refusal).toMatch(/cannot be capped above 400 calls/)
    expect(world.scripted.count).toBe(0)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
  })

  it('blocks a study with a readable reason, and an estimate of zero, when court rules are missing, the party is unknown or has no jury question', () => {
    const none = styleWorld(stores, { framework: false })
    const base = { runs: 3, mode: 'screen' as const, seed: 's', partyId: 'plaintiff', styles: ['concise' as const] }
    expect(none.styles.plan(none.matterId, base).blockers.join(' ')).toMatch(/No court rules are chosen.*Unknown is not treated as six jurors/)
    expect(none.jobs.preview(none.matterId, { kind: 'style_study', params: base }).estimate.calls).toBe(0)

    const world = styleWorld(stores)
    expect(world.styles.plan(world.matterId, { ...base, partyId: 'stranger' }).blockers.join(' ')).toMatch(/not a party of the approved case model/)
    expect(world.styles.plan(world.matterId, base).blockers).toEqual([])
    expect(world.styles.catalogue(world.matterId)).toMatchObject({ catalogueVersion: styleCatalogueVersion, blockers: [], label: styleStudyLabel, parties: [{ id: 'plaintiff' }, { id: 'defendant-1' }] })
    expect(world.styles.catalogue(world.matterId).styles.map((style) => style.text)).toEqual(expect.arrayContaining([styleById('concise').text]))
  })
})

describe('style study: planted effects are recovered and a planted null is reported as null', () => {
  it('recovers a planted style effect, reports a style with no effect as no reliable difference, and recommends only the one that is reliable', async () => {
    // moral_appeal moves a simulated juror toward the plaintiff (0.5 -> 0.8 of jurors); plain_factual changes nothing. Lengths do not matter here.
    const world = styleWorld(stores, { script: { boost: (style) => (style === 'moral_appeal' ? 0.12 : 0), words: () => 200 } })
    const { job } = await runStyleStudy(world, { runs: 24, styles: ['moral_appeal', 'plain_factual'] })
    expect(job.status).toBe('succeeded')
    const content = contentOf(world)
    expect(content).toMatchObject({ requestedRuns: 24, completedRuns: 24, complete: true, exploratory: false, partyId: 'plaintiff', partyName: 'Fictional Plaintiff', catalogueVersion: styleCatalogueVersion })
    const moral = rowOf(content, 'moral_appeal')
    const plain = rowOf(content, 'plain_factual')
    // The planted effect is found, with an interval that excludes zero, on both measures.
    expect(moral.pairs).toBe(24)
    expect(moral.win.verdict).toBe('better')
    expect(moral.win.adjusted!.lower).toBeGreaterThan(0)
    expect(moral.share.verdict).toBe('better')
    expect(moral.share.adjusted!.estimate).toBeGreaterThan(0.15)
    expect(moral.share.adjusted!.estimate).toBeLessThan(0.45)
    expect(moral.winRate!).toBeGreaterThan(content.baseline.winRate!)
    expect(moral.summary).toMatch(/reliably better than the unstyled baseline on the panel decision/)
    // The planted null is reported as null, never as an effect.
    expect(plain.win.verdict).toBe('no reliable difference')
    expect(plain.win.adjusted!.lower).toBeLessThanOrEqual(0)
    expect(plain.win.adjusted!.upper).toBeGreaterThanOrEqual(0)
    expect(plain.share.verdict).toBe('no reliable difference')
    expect(plain.share.adjusted!.estimate).toBe(0)
    expect(plain.summary).toMatch(/no reliable difference from the unstyled baseline.*not that the effect is zero/)
    expect(content.recommendation).toMatchObject({ recommended: 'moral_appeal', recommendedLabel: 'Moral appeal (bounded)' })
    expect(content.recommendation.reason).toMatch(/Moral appeal \(bounded\) beats the unstyled baseline after controlling for length/)
    expect(content.recommendation.reason).not.toMatch(/moral_appeal|\bnone\b/)
    // Per-style run counts and lengths are recorded.
    expect(content.baseline.runsCompleted).toBe(24)
    expect(content.results.map((row) => [row.styleId, row.runsCompleted])).toEqual([['moral_appeal', 24], ['plain_factual', 24]])
    expect(moral.meanWords).toBeGreaterThan(190)
    expect(content.multipleComparisonsNote).toMatch(/2 styles were compared.*not adjusted/)
    expect(content.excludedRuns).toEqual([])
  }, slow)

  it('a planted null across every style recommends nothing and says there is no reliable difference', async () => {
    const world = styleWorld(stores, { script: { boost: () => 0, words: () => 200 } })
    await runStyleStudy(world, { runs: 12, styles: ['moral_appeal', 'theatrical_storytelling'] })
    const content = contentOf(world)
    expect(content.recommendation.recommended).toBeUndefined()
    expect(content.recommendation.reason).toMatch(/^No reliable difference: no style is reliably better than the unstyled baseline after controlling for argument length/)
    for (const row of content.results) {
      expect(row.win.verdict).toBe('no reliable difference')
      expect(row.share.adjusted!.estimate).toBe(0)
    }
  }, slow)

  it('a style that only wins by being longer is not recommended: the effect is controlled for length', async () => {
    // The juror's boost depends on the argument's length alone (0.0006 per extra word beyond 200), never on the style. "Thorough" runs about 200 words
    // longer, so it looks better until length is controlled; "concise" is shorter and looks worse.
    const world = styleWorld(stores, { script: { boost: (_style, words) => 0.0006 * (words - 200), words: (style, call) => ({ none: 200, concise: 80, thorough: 420 }[style] ?? 200) + 12 * ((call * 7 + 3) % 5) } })
    await runStyleStudy(world, { runs: 24, styles: ['thorough', 'concise'] })
    const content = contentOf(world)
    const thorough = rowOf(content, 'thorough')
    // The raw difference is real and reliable...
    expect(thorough.share.raw!.lower).toBeGreaterThan(0)
    expect(thorough.meanWords!).toBeGreaterThan(content.baseline.meanWords! + 150)
    // ...and the length-adjusted effect is not: it is the intercept of the regression on length, and it does not exclude zero.
    expect(thorough.share.lengthControl).toBe('regression')
    expect(thorough.share.verdict).toBe('no reliable difference')
    expect(thorough.share.lengthExplainsEffect).toBe(true)
    expect(thorough.win.verdict).not.toBe('better')
    expect(content.recommendation.recommended).not.toBe('thorough')
    expect(content.lengthNote).toMatch(/longer closing must not pass as a better style/)
  }, slow)

  it('marks a small study exploratory, and a style with too few pairs as insufficient data, never as an effect', async () => {
    const world = styleWorld(stores, { script: { boost: (style) => (style === 'moral_appeal' ? 0.12 : 0) } })
    await runStyleStudy(world, { runs: 4, styles: ['moral_appeal'] })
    const content = contentOf(world)
    expect(content).toMatchObject({ exploratory: true, completedRuns: 4, exploratoryThreshold: 20 })
    expect(rowOf(content, 'moral_appeal')).toMatchObject({ pairs: 4, win: { verdict: 'insufficient data', raw: null, adjusted: null } })
    expect(rowOf(content, 'moral_appeal').summary).toMatch(/insufficient data \(4 paired seeds; at least 8 are needed\)/)
    expect(content.notes.join(' ')).toMatch(/Exploratory: only 4 common seeds/)
    expect(content.multipleComparisonsNote).toMatch(/One style was compared/)
  }, slow)

  it('uses common seeds: the same simulated jurors meet every style, and runs of a style are never reused for another', async () => {
    const world = styleWorld(stores, { script: { boost: () => 0 } })
    await runStyleStudy(world, { runs: 3, styles: ['concise', 'thorough'] })
    const runs = world.store.workflow.listTrialRuns(world.matterId)
    expect(runs).toHaveLength(9)
    const seeds = [...new Set(runs.map((run) => run.seed))].sort()
    expect(seeds).toEqual(['style-study:seed-001', 'style-study:seed-002', 'style-study:seed-003'])
    for (const seed of seeds) {
      const same = runs.filter((run) => run.seed === seed)
      expect(same.map((run) => run.config.advocacy?.[0]?.id ?? 'none').sort()).toEqual(['concise', 'none', 'thorough'])
      // Same seed, same simulated jurors in every condition.
      const traits = same.map((run) => JSON.stringify(world.store.workflow.listJurorProfiles(run.id).map((profile) => profile.traits)))
      expect(new Set(traits).size).toBe(1)
    }
    // Only the styled party's setting differs between the runs of one seed.
    const styled = runs.find((run) => run.config.advocacy)!
    expect(styled.config.advocacy).toEqual([{ partyId: 'plaintiff', id: styled.config.advocacy![0]!.id, catalogueVersion: styleCatalogueVersion, text: styleById(styled.config.advocacy![0]!.id).text }])
    expect(runs.filter((run) => !run.config.advocacy)).toHaveLength(3)
  }, slow)
})

describe('style study: the hard cap, interruption and resume', () => {
  it('a study that exactly fills its cap ends as succeeded and keeps its draft', async () => {
    const world = styleWorld(stores, { script: { boost: () => 0 } })
    // 2 seeds x 2 conditions = 4 runs, priced at 68 calls each.
    const { job } = await runStyleStudy(world, { runs: 2, styles: ['concise'], maxCalls: 4 * perRun })
    expect(job.usage.calls).toBe(4 * perRun)
    expect(job.status).toBe('succeeded')
    expect(job.resultArtifactIds).toHaveLength(1)
    expect(contentOf(world).completedRuns).toBe(2)
  }, slow)

  it('keeps finished runs when the provider goes away, retries the run that failed, and never repeats a finished run', async () => {
    const model = new StyleModel({ boost: () => 0 })
    const original = model.generateStage.bind(model)
    let providerDown = true
    model.generateStage = async (request) => {
      // The provider goes away during the fourth run (the second seed's baseline has finished; the second seed's styled run is the fourth).
      if (providerDown && model.runsSeen() === 4 && request.stage !== 'juror_ballot') throw new Error('The scripted provider went away.')
      return original(request)
    }
    const world = styleWorld(stores, { model })
    model.runsSeen = () => world.store.workflow.listTrialRuns(world.matterId).length
    const { job } = await runStyleStudy(world, { runs: 3, styles: ['concise'] })
    expect(job).toMatchObject({ status: 'failed', usage: { calls: 3 * perRun } })
    expect(job.error).toMatch(/scripted provider went away/)
    const afterFailure = world.store.workflow.listTrialRuns(world.matterId)
    expect(afterFailure.map((run) => run.status).sort()).toEqual(['completed', 'completed', 'completed', 'failed'])
    // A failed run is a failure, never a loss: no result was saved from a study that has not finished a seed on every style.
    const finishedIds = afterFailure.filter((run) => run.status === 'completed').map((run) => run.id)
    const finishedEvents = finishedIds.map((id) => world.store.workflow.listTrialEvents(id).length)

    providerDown = false
    const resumed = world.jobs.resume(world.matterId, job.id)
    expect(['queued', 'running']).toContain(resumed.status)
    await world.jobs.whenIdle()
    const done = world.jobs.get(world.matterId, job.id)
    expect(done.status).toBe('succeeded')
    const runs = world.store.workflow.listTrialRuns(world.matterId)
    expect(runs).toHaveLength(6)
    expect(runs.every((run) => run.status === 'completed')).toBe(true)
    expect(finishedIds.map((id) => world.store.workflow.listTrialEvents(id).length)).toEqual(finishedEvents)
    expect(contentOf(world)).toMatchObject({ completedRuns: 3, requestedRuns: 3, complete: true, excludedRuns: [] })
    expect(done.usage.calls).toBe(6 * perRun)
  }, slow)

  it('refuses to start a second study on the seed of one that is queued or running', async () => {
    const world = styleWorld(stores, { script: { boost: () => 0 } })
    const params = { runs: 2, mode: 'screen' as const, seed: 'busy', partyId: 'plaintiff', styles: ['concise' as const] }
    const preview = world.jobs.preview(world.matterId, { kind: 'style_study', params })
    world.jobs.start(world.matterId, { kind: 'style_study', params, estimateHash: preview.estimate.hash })
    expect(() => world.styles.assertNotRunning(world.matterId, 'busy', world.jobs)).toThrow(/already waiting or running/)
    await world.jobs.whenIdle()
    expect(() => world.styles.assertNotRunning(world.matterId, 'busy', world.jobs)).not.toThrow()
  }, slow)

  it('runs one simulated panel at a time, never all at once', async () => {
    const model = new StyleModel({ boost: () => 0 })
    const world = styleWorld(stores, { model })
    let overlap = 0
    const original = model.generateStage.bind(model)
    model.generateStage = async (request) => {
      overlap = Math.max(overlap, world.store.workflow.listTrialRuns(world.matterId).filter((run) => run.status === 'running').length)
      return original(request)
    }
    await runStyleStudy(world, { runs: 2, styles: ['concise'] })
    expect(overlap).toBe(1)
  }, slow)
})

describe('style study: the artifact, its freshness, approval, export and archive', () => {
  async function study(options: { boost?: (style: string) => number; runs?: number } = {}) {
    const world = styleWorld(stores, { script: { boost: (style) => options.boost?.(style) ?? 0, words: () => 200 } })
    await runStyleStudy(world, { runs: options.runs ?? 10, styles: ['moral_appeal', 'concise'] })
    return world
  }

  it('saves an owner-only draft with its inputs pinned and its hash verified, then approves it', async () => {
    const world = await study()
    const views = world.styles.view(world.matterId)
    expect(views).toMatchObject({ label: styleStudyLabel, current: 'draft' })
    const draft = views.draft!
    expect(draft.artifact).toMatchObject({ kind: 'style_study', status: 'draft', version: 1, audience: 'owner', subjectKey: '' })
    expect(draft.artifact.inputManifest).toMatchObject({ algorithmVersion: 'style-study-1', promptVersion: styleCatalogueVersion, seed: 'style-study' })
    expect(draft.artifact.inputManifest.rulePackHash).toMatch(/^[a-f0-9]{64}$/)
    expect(draft.artifact.inputManifest.runIds).toHaveLength(30)
    expect(draft.freshness.status).toBe('current')
    expect(draft.content.styles.map((style) => style.text)).toEqual([styleById('moral_appeal').text, styleById('concise').text])
    expect(world.analysis.get(world.matterId, draft.artifact.id).contentHash).toBe(draft.artifact.contentHash)
    const approved = world.styles.approve(world.matterId)
    expect(approved.artifact.status).toBe('approved')
    expect(world.styles.view(world.matterId)).toMatchObject({ current: 'approved' })
    // Owner audience only: no party viewer can read it.
    expect(world.analysis.approvedFor({ role: 'party', partyId: 'plaintiff' }, world.matterId, 'style_study')).toEqual([])
    expect(world.analysis.approvedFor({ role: 'owner' }, world.matterId, 'style_study')).toHaveLength(1)
    expect(world.styles.versions(world.matterId).versions).toMatchObject([{ version: 1, status: 'approved', partyName: 'Fictional Plaintiff', completedRuns: 10, requestedRuns: 10, exploratory: true }])
    expect(world.styles.version(world.matterId, draft.artifact.id).content.seed).toBe('style-study')
    expect(() => world.styles.version(world.matterId, 'nope')).toThrow()
  }, slow)

  it('is out of date, and cannot be approved, when the court rules, the case model or the style catalogue changed', async () => {
    const world = await study()
    const draft = world.styles.view(world.matterId).draft!
    // The style catalogue: a study prepared with an older catalogue version.
    const older = world.analysis.saveDraft<StyleStudyContent>({
      matterId: world.matterId, kind: 'style_study', subjectKey: '', audience: 'owner', caseModelId: draft.artifact.caseModelId,
      inputManifest: { ...draft.artifact.inputManifest, promptVersion: 'advocacy-styles-0' }, content: draft.content,
    })
    expect(world.styles.version(world.matterId, older.id).freshness).toMatchObject({ status: 'out_of_date', reasons: [expect.stringMatching(/style catalogue has changed/)] })
    expect(() => world.styles.approve(world.matterId)).toThrow(/out of date and cannot be approved/)
    // The court rules.
    const world2 = await study()
    world2.frameworks.setForMatter(world2.matterId, { packId: ontarioCivilPack.id, changedBy: 'Fictional Reviewer', overrides: categoriesOnly() })
    const after = world2.styles.view(world2.matterId).draft!
    expect(after.freshness.status).toBe('out_of_date')
    expect(after.freshness.reasons.join(' ')).toMatch(/court rules/)
    expect(() => world2.styles.approve(world2.matterId)).toThrow(/out of date/)
  }, slow)

  it('exports Markdown and HTML with the D1 label wherever win rates appear, and escapes anything dynamic', async () => {
    const world = await study({ boost: (style) => (style === 'moral_appeal' ? 0.12 : 0), runs: 12 })
    // Hostile text in the matter title and in a model-written passage must stay literal.
    world.store.getMatter(world.matterId)
    const report = world.styles.exportReport(world.matterId)
    expect(report.filename).toMatch(/style-study-v1\.md$/)
    expect(report.markdown.split('\n')[0]).toMatch(/^# Advocacy style study \(simulated panels\)/)
    expect(report.markdown).toContain(NOT_YET_TESTED_SENTENCE)
    // The sentence opens the report, sits beside the figures and closes it.
    expect(report.markdown.indexOf(NOT_YET_TESTED_SENTENCE)).toBeLessThan(report.markdown.indexOf('## The study'))
    expect(report.markdown.indexOf(NOT_YET_TESTED_SENTENCE, report.markdown.indexOf('## Styles compared'))).toBeGreaterThan(-1)
    expect(report.markdown.trimEnd().endsWith(styleStudyLabel)).toBe(true)
    expect(report.markdown).toMatch(/Common seeds finished on every style: 12 of 12/)
    expect(report.markdown).toMatch(/### Moral appeal \(bounded\)/)
    expect(report.markdown).toMatch(/Panel decision: reliably better/)
    expect(report.markdown).toMatch(/Exploratory: fewer than 20 common seeds/)
    expect(report.markdown).toMatch(/Preparation material for the party named below/)
    expect(report.html).toContain('TrialLens style study')
    expect(report.html).toContain(NOT_YET_TESTED_SENTENCE)
  }, slow)

  it('escapes a leading heading or list mark and HTML in dynamic strings', async () => {
    const world = await study()
    const draft = world.styles.view(world.matterId).draft!
    const hostile = { ...draft, content: { ...draft.content, partyName: '# Not a heading', examples: [{ styleId: 'concise' as const, runId: 'r1', phase: 'openings', excerpt: '- a list item <img src=x onerror=alert(1)> ## sneaky' }], excludedRuns: [{ runId: 'r2', seed: 's', styleId: 'none' as const, reason: '1. numbered <script>alert(1)</script>' }] } }
    const { buildStyleStudyReport } = await import('../server/analysis/styleStudyExport')
    const report = buildStyleStudyReport({ matter: { ...world.store.getMatter(world.matterId), title: '## Hostile title' }, view: hostile })
    expect(report.markdown).toContain('# Advocacy style study (simulated panels): \\## Hostile title')
    expect(report.markdown).toContain('Styled party: \\# Not a heading')
    for (const forbidden of ['\n## sneaky', '\n# Not a heading', '\n## Hostile title', '\n1. numbered', '\n- a list item']) expect(report.markdown).not.toContain(forbidden)
    expect(report.markdown).toMatch(/\(run r1\): \\- a list item/)
    expect(report.html).not.toContain('<img src=x')
    expect(report.html).not.toContain('<script>alert')
    expect(report.html).toContain('&lt;img')
  }, slow)

  it('travels in an archive with its runs, and fails closed on a run whose advocacy setting this version cannot read', async () => {
    const world = await study({ runs: 3 })
    const original = world.styles.view(world.matterId).draft!
    const archive = await createMatterArchive(world.store, world.matterId)
    const imported = await importMatterArchive(world.store, JSON.parse(JSON.stringify(archive)))
    const copy = world.styles.view(imported.id).draft!
    const newRuns = world.store.workflow.listTrialRuns(imported.id)
    expect(newRuns).toHaveLength(9)
    expect([...copy.artifact.inputManifest.runIds!].sort()).toEqual(newRuns.map((run) => run.id).sort())
    expect(copy.content.results).toEqual(original.content.results)
    expect(copy.content.styles).toEqual(original.content.styles)
    expect(copy.content.examples.map((example) => example.runId).every((id) => newRuns.some((run) => run.id === id))).toBe(true)
    expect(newRuns.filter((run) => run.config.advocacy).map((run) => run.config.advocacy![0]!.partyId)).toEqual(Array(6).fill('plaintiff'))

    const resign = (changed: MatterArchive): MatterArchive => {
      const { checksum: _old, ...unsigned } = changed
      return { ...unsigned, checksum: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') } as MatterArchive
    }
    const tamper = (advocacy: unknown) => {
      const changed = JSON.parse(JSON.stringify(archive)) as MatterArchive
      const row = changed.snapshot.trialRuns.find((candidate) => String((candidate as Record<string, unknown>).config_json).includes('"advocacy"')) as Record<string, unknown>
      row.config_json = JSON.stringify({ ...JSON.parse(String(row.config_json)), advocacy })
      return resign(changed)
    }
    await expect(importMatterArchive(world.store, tamper([{ partyId: 'plaintiff', id: 'invented_style', text: 'x' }]))).rejects.toThrow(/advocacy style that this application cannot read/)
    await expect(importMatterArchive(world.store, tamper('concise'))).rejects.toThrow(/advocacy style that this application cannot read/)
    await expect(importMatterArchive(world.store, tamper([]))).rejects.toThrow(/advocacy style that this application cannot read/)
    await expect(importMatterArchive(world.store, tamper([{ partyId: 'plaintiff', id: 'concise' }]))).rejects.toThrow(/advocacy style that this application cannot read/)
    // A valid control: an untouched archive still imports.
    await expect(importMatterArchive(world.store, resign(JSON.parse(JSON.stringify(archive))))).resolves.toBeDefined()
  }, slow)
})
