import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { ScriptedStructuredClient, type StructuredRequest } from '../server/analysis/structured'
import type { ModelProviderConfig } from '../server/minimax'
import {
  assertLiveAllowed, BudgetedStructuredClient, evaluate, liveBudgetFromEnv, loadThresholds, runExtractionSuite, scoreChronology, scoreEvidenceIndex,
  STANDING_STATEMENT, type MetricResult,
} from '../scripts/intelligenceEvaluation'
import { CaseStore } from '../server/db'
import { ChronologyService } from '../server/analysis/chronology'
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
