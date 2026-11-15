import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { ScriptedStructuredClient, type StructuredRequest } from '../server/analysis/structured'
import type { ModelProviderConfig } from '../server/minimax'
import {
  assertLiveAllowed, buildLiveClient, BudgetedStructuredClient, evaluate, liveBudgetFromEnv, loadThresholds, runExtractionSuite, runFalseConflictProbe, sameRef,
  scoreChronology, scoreEvidenceIndex, STANDING_STATEMENT, summaryLine, type MetricResult,
} from '../scripts/intelligenceEvaluation'
import { CaseStore } from '../server/db'
import { ChronologyService, type ChronologyContent } from '../server/analysis/chronology'
import { buildCivilWorld, intelligenceRouter, routedClient } from './intelligenceFixtures'

// The scripted evaluation harness must be able to fail. These tests keep it honest: a client that returns the answer key
// passes, a deliberately wrong one fails every family of metrics, and the live path refuses before any request.

const slow = 120_000
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const { thresholds } = loadThresholds()
const failedGroups = (metrics: MetricResult[]) => [...new Set(metrics.filter((item) => !item.passed).map((item) => item.group))].sort()

describe('thresholds come from one configuration', () => {
  it('has a target between 0 and 1 for every metric, proposed at 90 percent, and says they are unverified', () => {
    expect(Object.values(thresholds.targets).every((value) => value === 0.9)).toBe(true)
    expect(thresholds.status).toMatch(/NOT verified against a live model/)
    expect(thresholds.chronologyConflictScope.keyConflictIds).toEqual(['C1'])
  })

  it('refuses an out-of-range target or an unknown version', () => {
    const root = mkdtempSync(join(tmpdir(), 'triallens-thresholds-')); roots.push(root)
    let counter = 0
    const write = (value: unknown) => { counter += 1; const file = join(root, `thresholds-${counter}.json`); writeFileSync(file, JSON.stringify(value)); return pathToFileURL(file) }
    expect(() => loadThresholds(write({ ...thresholds, targets: { ...thresholds.targets, 'chronology.eventRecall': 1.5 } }))).toThrow(/from 0 to 1/)
    expect(() => loadThresholds(write({ ...thresholds, schemaVersion: 2 }))).toThrow(/Unknown threshold/)
  })
})

describe('the scorers can fail', () => {
  it('passes a client that returns the answer key, and fails a deliberately degraded one in every family', async () => {
    const key = await runExtractionSuite({ kind: 'key', thresholds })
    expect(key.failures).toEqual([])
    expect(key.metrics).toHaveLength(15)
    expect(key.metrics.filter((item) => !item.passed)).toEqual([])
    const degraded = await runExtractionSuite({ kind: 'degraded', thresholds })
    expect(failedGroups(degraded.metrics)).toEqual(['caseMap', 'chronology', 'evidenceIndex', 'experts'])
    // Valid control: the degraded client was damaged on purpose, so its worst scores are far below target.
    expect(degraded.metrics.find((item) => item.id === 'caseMap.partyAccuracy')!.score).toBeLessThan(0.5)
    expect(degraded.metrics.find((item) => item.id === 'chronology.dateAccuracy')!.score).toBeLessThan(0.5)
  }, slow)

  it('scores an empty chronology and an empty set of record gaps as failures, never as passes', () => {
    const world = buildCivilWorld({}, new CaseStore(':memory:'))
    const evidence = world.store.listEvidence(world.matterId)
    const empty = scoreChronology({ items: [], conflicts: [], candidateDates: [], documents: { processed: [], failed: [] }, reviewLog: [] }, evidence, thresholds)
    expect(empty.every((item) => !item.passed)).toBe(true)
    expect(scoreEvidenceIndex({ recordGaps: [] }, evidence, thresholds).every((item) => !item.passed)).toBe(true)
    world.store.close()
  })

  it('counts an event the key does not list against precision, and a missing key event against recall', async () => {
    const world = buildCivilWorld({}, new CaseStore(':memory:'))
    const evidence = world.store.listEvidence(world.matterId)
    const artifact = await new ChronologyService(world.store, world.service, world.workflow).generate(world.matterId, { client: routedClient(intelligenceRouter(world), 80) })
    const content = artifact.content as unknown as Parameters<typeof scoreChronology>[0]
    const control = scoreChronology(content, evidence, thresholds)
    expect(control.filter((item) => !item.passed)).toEqual([])
    const extra = { ...content.items[0], id: 'extra', sources: [{ evidenceId: content.items[0].sources[0].evidenceId, paragraph: 1, quote: 'FICTIONAL TEST SOURCE' }] }
    const withExtra = scoreChronology({ ...content, items: [...content.items, ...Array.from({ length: 10 }, (_, index) => ({ ...extra, id: `extra-${index}` }))] }, evidence, thresholds)
    expect(withExtra.find((item) => item.id === 'chronology.eventPrecision')!.passed).toBe(false)
    const withoutHalf = scoreChronology({ ...content, items: content.items.filter((_, index) => index % 2 === 0) }, evidence, thresholds)
    expect(withoutHalf.find((item) => item.id === 'chronology.eventRecall')!.passed).toBe(false)
    world.store.close()
  })
})

describe('matching a cited passage to the key', () => {
  const file = '10-family-physician-chart.txt'
  const key = { file, quote: 'Patient reports a fall on January 14, 2025 at the Plaza.' }

  it('never matches an empty or very short fragment, in either direction', () => {
    for (const fragment of ['', '   ', 'the', 'Patient', 'January 14']) {
      expect(sameRef({ file, quote: fragment }, key), JSON.stringify(fragment)).toBe(false)
      expect(sameRef(key, { file, quote: fragment }), JSON.stringify(fragment)).toBe(false)
    }
  })

  it('still matches a real quotation that contains, or is contained in, the key, ignoring case and spacing (control)', () => {
    expect(sameRef({ file, quote: 'fall on January 14, 2025   at the Plaza' }, key)).toBe(true)
    expect(sameRef({ file, quote: `Chart note: ${key.quote} Follow up in two weeks.` }, key)).toBe(true)
    expect(sameRef(key, { ...key })).toBe(true)
    // A fragment must be at least 12 characters (or the whole of a shorter quotation) to count as the same passage.
    expect(sameRef({ file, quote: 'Fell approx 0900 per patient' }, { file, quote: 'approx 0900 per' })).toBe(true)
    expect(sameRef({ file, quote: 'Fell approx 0900 per patient' }, { file, quote: 'approx 0900' })).toBe(false)
    expect(sameRef({ file, quote: 'approx 0900' }, { file, quote: 'approx 0900' })).toBe(true)
    expect(sameRef({ file, quote: 'x' }, { file, quote: 'x' })).toBe(true)
    expect(sameRef({ file: 'other.txt', quote: key.quote }, key)).toBe(false)
  })

  it('earns no recall or precision from citing one-word fragments of the key passages', async () => {
    const world = buildCivilWorld({}, new CaseStore(':memory:'))
    const evidence = world.store.listEvidence(world.matterId)
    const artifact = await new ChronologyService(world.store, world.service, world.workflow).generate(world.matterId, { client: routedClient(intelligenceRouter(world), 80) })
    const content = artifact.content as unknown as ChronologyContent
    expect(scoreChronology(content, evidence, thresholds).filter((item) => !item.passed)).toEqual([])
    const fragments = { ...content, items: content.items.map((event) => ({ ...event, sources: event.sources.map((source) => ({ ...source, quote: 'the' })) })) }
    const scored = scoreChronology(fragments, evidence, thresholds)
    expect(scored.find((item) => item.id === 'chronology.eventRecall')!.score).toBe(0)
    expect(scored.find((item) => item.id === 'chronology.eventPrecision')!.score).toBe(0)
    expect(scored.find((item) => item.id === 'chronology.conflictRecall')!.score).toBe(0)
    world.store.close()
  })
})

describe('chronology conflict precision', () => {
  it('counts a flagged conflict as correct only when it covers the sides of a key conflict', async () => {
    const world = buildCivilWorld({}, new CaseStore(':memory:'))
    const evidence = world.store.listEvidence(world.matterId)
    const artifact = await new ChronologyService(world.store, world.service, world.workflow).generate(world.matterId, { client: routedClient(intelligenceRouter(world), 80) })
    const content = artifact.content as unknown as ChronologyContent
    const precision = (value: ChronologyContent) => scoreChronology(value, evidence, thresholds).find((item) => item.id === 'chronology.conflictPrecision')!
    // Control: the one true conflict (the three times for the fall) is counted, and a perfect client scores 1/1.
    expect(precision(content)).toMatchObject({ numerator: 1, denominator: 1, passed: true })
    const eventFrom = (file: string) => content.items.find((event) => event.sources.every((source) => source.evidenceId === world.byFile.get(file)!.id))!
    const unrelated = [eventFrom('11-physiotherapy-records.txt'), eventFrom('12-expert-report-plaintiff-orthopaedic.txt')]
    expect(unrelated.every(Boolean)).toBe(true)
    const falseConflict = { id: 'cf-false', kind: 'date' as const, eventIds: unrelated.map((event) => event.id), summary: 'Two unrelated events.' }
    const withFalse = precision({ ...content, conflicts: [...content.conflicts, falseConflict] })
    expect(withFalse).toMatchObject({ numerator: 1, denominator: 2, passed: false })
    expect(withFalse.score!).toBeLessThan(thresholds.targets['chronology.conflictPrecision'])
    // A false conflict alone is not a correct one, however valid its two events are.
    expect(precision({ ...content, conflicts: [falseConflict] })).toMatchObject({ numerator: 0, denominator: 1, passed: false })
    world.store.close()
  })

  it('lowers precision, through the real service, when a model flags a false conflict between two valid events; the true conflict still counts', async () => {
    const probe = await runFalseConflictProbe(thresholds)
    expect(probe.conflicts).toBe(2)
    expect(probe.precision).toMatchObject({ numerator: 1, denominator: 2, passed: false })
    expect(probe.recall).toMatchObject({ numerator: 1, denominator: 1, passed: true })
  }, slow)
})

describe('the refusal of an unsourced event stays visible', () => {
  it('keeps the refused event in the rejected list with its text, so the invariant can match it and not just count rejections', async () => {
    const world = buildCivilWorld({}, new CaseStore(':memory:'))
    const gold = intelligenceRouter(world)
    const quote = 'The plaintiff won a lottery.'
    const router = (request: StructuredRequest<unknown>) => {
      const reply = gold(request) as { events?: unknown[] }
      if (request.task !== 'chronology_extraction' || request.inputs[0].id !== world.exhibit('10-family-physician-chart.txt')) return reply
      return { events: [...reply.events!, { when: { precision: 'day', start: '2023-11-08', original: '2023-11-08' }, description: 'A refused event.', type: 'other', assertion: 'record', sources: [{ evidenceId: request.inputs[0].id, paragraph: 1, quote }], issueIds: [] }] }
    }
    const artifact = await new ChronologyService(world.store, world.service, world.workflow).generate(world.matterId, { client: routedClient(router, 80) })
    expect(artifact.rejected.some((entry) => JSON.stringify(entry).includes(quote))).toBe(true)
    expect(artifact.rejected.some((entry) => JSON.stringify(entry).includes('a quotation nobody made'))).toBe(false)
    world.store.close()
  })
})

describe('the whole evaluation', () => {
  it('reports provider mode scripted, the exact settings, counts, the standing sentence, and passes', async () => {
    const report = await evaluate({ now: () => '2026-11-09T00:00:00.000Z' })
    expect(report).toMatchObject({ providerMode: 'scripted', provider: { name: 'injected-fixture', model: 'scripted' }, standingStatement: STANDING_STATEMENT, passed: true, failures: [] })
    expect(report.standingStatement).toMatch(/prove software behaviour only/)
    expect(report.settings).toMatchObject({ thresholdsFile: 'scripts/case-intelligence-thresholds.json', fixtureDocuments: 19 })
    expect(report.counts).toMatchObject({ metricsEvaluated: 15, metricsFailed: 0, invariantsFailed: 0, vacuityChecksFailed: 0 })
    expect(report.invariants.map((item) => item.id)).toEqual(['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6', 'INV-7', 'INV-8'])
    // Every invariant has controls, and every check passed.
    for (const item of report.invariants) { expect(item.passed, item.id).toBe(true); expect(item.checks.length, item.id).toBeGreaterThanOrEqual(3) }
    expect(report.runs.find((run) => run.id === 'degraded')!.allTargetsMet).toBe(false)
    expect(report.vacuityChecks.every((check) => check.passed)).toBe(true)
    expect(report.vacuityChecks.map((check) => check.name)).toContain('a false conflict between two valid events lowers conflict precision below the target, and the true conflict still counts')
    expect(summaryLine(report)).toBe('15/15 targets met by the scripted client, 8/8 invariants, 0 vacuity failures.')
    // In a live report the scripted key run is fixture evidence: the summary counts the live run only, never both added together.
    const key = report.runs.find((run) => run.id === 'key')!
    const live = { ...key, id: 'live' as const, metrics: key.metrics.map((item, index) => ({ ...item, passed: index < 3 })) }
    const liveReport = { ...report, providerMode: 'live' as const, runs: [...report.runs, live], counts: { ...report.counts, metricsEvaluated: 30, metricsPassed: 18 } }
    expect(summaryLine(liveReport)).toBe('3/15 targets met by the live client, 8/8 invariants, 0 vacuity failures.')
  }, slow)
})

describe('live gating (nothing here makes a request)', () => {
  const external: ModelProviderConfig = { provider: 'openai-compatible', apiKey: 'fictional', baseUrl: 'https://api.example.test/v1', model: 'fictional-model', timeoutMs: 60_000, maxRetries: 2 }
  const local: ModelProviderConfig = { ...external, baseUrl: 'http://localhost:11434/v1' }

  it('refuses an external provider without the disclosure confirmation, and allows it with one (control)', () => {
    expect(() => assertLiveAllowed(external, {})).toThrow(/EVAL_EXTERNAL_DISCLOSURE_CONFIRMED=1.*No request was made/)
    expect(() => assertLiveAllowed(external, { EVAL_EXTERNAL_DISCLOSURE_CONFIRMED: 'true' })).toThrow(/No request was made/)
    expect(assertLiveAllowed(external, { EVAL_EXTERNAL_DISCLOSURE_CONFIRMED: '1' })).toEqual({ mode: 'external' })
    expect(assertLiveAllowed(local, {})).toEqual({ mode: 'local' })
  })

  it('reports the mode the gate decided, not one guessed from the host name', () => {
    const budget = liveBudgetFromEnv(thresholds, {})
    const refuse = (() => { throw new Error('no request may be made') }) as unknown as typeof fetch
    expect(buildLiveClient(local, budget, refuse, {}).mode).toBe('local')
    expect(buildLiveClient(external, budget, refuse, { EVAL_EXTERNAL_DISCLOSURE_CONFIRMED: '1' }).mode).toBe('external')
    // A hosted provider configured with a loopback address is still external to the gate: a host-name check would call it local.
    const hosted: ModelProviderConfig = { ...local, provider: 'minimax' }
    expect(() => buildLiveClient(hosted, budget, refuse, {})).toThrow(/EVAL_EXTERNAL_DISCLOSURE_CONFIRMED=1/)
    expect(buildLiveClient(hosted, budget, refuse, { EVAL_EXTERNAL_DISCLOSURE_CONFIRMED: '1' }).mode).toBe('external')
  })

  it('takes request, time and retry limits from the one configuration, lets the environment lower them, and refuses nonsense', () => {
    expect(liveBudgetFromEnv(thresholds, {})).toEqual(thresholds.live)
    expect(liveBudgetFromEnv(thresholds, { EVAL_MAX_CALLS: '5', EVAL_MAX_RETRIES: '0' })).toMatchObject({ maxCalls: 5, maxRetries: 0 })
    // Retries can be lowered but never raised past the configured ceiling.
    expect(liveBudgetFromEnv(thresholds, { EVAL_MAX_RETRIES: '9' }).maxRetries).toBe(thresholds.live.maxRetries)
    expect(() => liveBudgetFromEnv(thresholds, { EVAL_MAX_CALLS: '-1' })).toThrow(/non-negative/)
    expect(() => liveBudgetFromEnv(thresholds, { EVAL_MAX_CALLS: '0' })).toThrow(/positive/)
  })

  it('stops at the call budget before the inner client is reached, and records the stop', async () => {
    const inner = new ScriptedStructuredClient([() => ({ ok: true })])
    const budgeted = new BudgetedStructuredClient(inner, { ...thresholds.live, maxCalls: 1 }, 'local', false)
    const request = { task: 'x', promptVersion: 'x', schema: { safeParse: (value: unknown) => ({ success: true, data: value }) }, instructions: 'x', inputs: [{ id: 'a', text: 'b' }] } as unknown as StructuredRequest<unknown>
    await budgeted.generate(request)
    await expect(budgeted.generate(request)).rejects.toThrow(/resource limit reached; no provider call was made/)
    expect(inner.calls).toHaveLength(1)
    expect(budgeted.attempts.map((attempt) => attempt.status)).toEqual(['passed', 'budget_stopped'])
  })
})
