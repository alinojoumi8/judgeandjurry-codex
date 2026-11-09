import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createMiniMaxConfig } from '../server/minimax'
import { EvaluationTransport } from '../server/courtroomEvaluation'
import { buildLiveClient, evaluate, liveBudgetFromEnv, loadThresholds, STANDING_STATEMENT, type EvaluationReport } from './intelligenceEvaluation'

// Scripted by default. `--live` is gated exactly like `npm run eval:courtroom -- --live`: an explicit flag, external
// disclosure confirmation, request, time and retry limits, and a call/character budget. This script never runs a live
// model unless --live is on the command line. Fictional fixtures only.
const live = process.argv.includes('--live')
const output = join(process.cwd(), 'tmp', 'qa', 'intelligence')

function printSummary(report: EvaluationReport): void {
  console.log(`Provider mode: ${report.providerMode}. ${STANDING_STATEMENT}`)
  console.log(`Targets: ${report.thresholdStatus}`)
  for (const run of report.runs) {
    console.log(`\n${run.id.toUpperCase()} run: ${run.purpose}`)
    for (const item of run.metrics) console.log(`  ${item.passed ? 'PASS' : 'FAIL'} ${item.id} ${item.score === null ? 'n/a' : `${(item.score * 100).toFixed(1)}%`} (${item.numerator}/${item.denominator}, target ${(item.threshold * 100).toFixed(0)}%)`)
    for (const failure of run.failures) console.log(`  STEP FAILED ${failure}`)
    console.log(`  ${run.expectedToPass ? 'Expected to meet every target' : 'Expected to FAIL targets'}: ${run.allTargetsMet ? 'all targets met' : `targets missed in ${run.groupsFailed.join(', ')}`}`)
  }
  console.log('\nVacuity checks (the scorer must be able to fail)')
  for (const check of report.vacuityChecks) console.log(`  ${check.passed ? 'PASS' : 'FAIL'} ${check.name}`)
  console.log('\nInvariants (real services)')
  for (const item of report.invariants) {
    console.log(`  ${item.passed ? 'PASS' : 'FAIL'} ${item.id} ${item.statement}`)
    for (const check of item.checks.filter((candidate) => !candidate.passed)) console.log(`      FAIL ${check.name}${check.detail ? ` (${check.detail})` : ''}`)
  }
}

async function main(): Promise<void> {
  const { thresholds } = loadThresholds()
  let liveSetup: Parameters<typeof evaluate>[0]['live']
  let transport: EvaluationTransport | undefined
  if (live) {
    const config = createMiniMaxConfig()
    const budget = liveBudgetFromEnv(thresholds)
    transport = new EvaluationTransport({ maxCalls: budget.maxCalls * (budget.maxRetries + 1), maxInputCharacters: budget.maxInputCharacters * (budget.maxRetries + 1), maxElapsedMs: budget.maxElapsedMs })
    // Refuses here, before any request, when an external provider has no disclosure confirmation.
    const client = buildLiveClient(config, budget, transport.fetch)
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(config.baseUrl).hostname)
    liveSetup = { client, budget, provider: { name: config.provider, model: config.model, mode: local ? 'local' : 'external' } }
  }
  const report = await evaluate({ live: liveSetup })
  if (transport && report.runs.some((run) => run.id === 'live')) {
    ;(report.settings as Record<string, unknown>).providerTransport = transport.usage()
    ;(report.settings as Record<string, unknown>).liveStructuredCalls = liveSetup!.client.usage()
    ;(report as unknown as { liveAttempts: unknown }).liveAttempts = liveSetup!.client.attempts
  }
  printSummary(report)
  await mkdir(output, { recursive: true })
  const file = join(output, `${report.providerMode}-evaluation.json`)
  const body = JSON.stringify(report, null, 2)
  await writeFile(file, body)
  await writeFile(file.replace('-evaluation.json', `-evaluation-${report.createdAt.replace(/[:.]/g, '-')}.json`), body)
  console.log(`\n${report.passed ? 'PASS' : 'FAIL'}: ${report.counts.metricsPassed}/${report.counts.metricsEvaluated} targets met by the ${report.providerMode} client, ${report.counts.invariantsPassed}/${report.invariants.length} invariants, ${report.counts.vacuityChecksFailed} vacuity failures.`)
  console.log(`Report: ${file}`)
  if (!report.passed) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
