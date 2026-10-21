import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import type { StageResult } from '../server/types'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v134-counteraccount-burden-scope-capture.json', import.meta.url), 'utf8'))
const request = capture.request as StageRequest
const invented = 'Rowan admitted knowingly concealing $250 cash.'
function base(): StageResult {
  return { title: 'Juror reply', content: 'I retain doubt under the Crown burden.', citations: [], jurors: [{ ...capture.generated.jurors[0], leaning: 'defence', rationale: 'I retain doubt under the Crown burden.', mindChangedBecause: 'This is my initial ballot.', consistencyWarnings: [], beliefTrail: [], deliberationRounds: [] }] }
}
const cases: Array<[string, (result: StageResult) => void]> = [
  ['juror warning', r => { r.jurors![0].consistencyWarnings = [invented] }],
  ...(['stage', 'belief', 'why'] as const).map(field => [
    `belief snapshot ${field}`, (r: StageResult) => { r.jurors![0].beliefTrail = [{ stage: 'after_crown_opening', leaning: 'defence', confidence: 60, belief: 'I retain doubt.', why: 'The burden remains unmet.', citations: [], [field]: invented }] },
  ] as [string, (result: StageResult) => void]),
  ...(['focus', 'exchange', 'responseTo'] as const).map(field => [
    `deliberation ${field}`, (r: StageResult) => { r.jurors![0].deliberationRounds = [{ round: 1, focus: 'Credibility', exchange: 'I retain doubt.', responseTo: 'juror-02', leaning: 'defence', confidence: 60, [field]: invented }] },
  ] as [string, (result: StageResult) => void]),
  ...(['outcome', 'citationWarnings'] as const).map(field => [
    `verdict ${field}`, (r: StageResult) => { r.verdict = { outcome: 'Not guilty', confidence: 60, keyFactors: [], unresolvedIssues: [], recommendedNextSteps: [], citationWarnings: [], [field]: field === 'outcome' ? invented : [invented] } },
  ] as [string, (result: StageResult) => void]),
]
function audit(result: StageResult) {
  const units = groundingUnits(result)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: unit.text.includes(invented) ? 'unsupported' : 'analysis', explanation: unit.text.includes(invented) ? 'No supplied source supports this admitted cash allegation.' : 'Current assessment or topic.', citations: [] })) }), units, request.evidence, request.groundingContext).status
}

describe('every normalized narrative field reaches the source auditor', () => {
  it.each(cases)('withholds an invented allegation in %s', (_name, inject) => {
    const result = base(); inject(result)
    expect(audit(result)).toBe('failed')
  })
  it('preserves a current assessment without additional claims', () => expect(audit(base())).toBe('passed'))
  it('withholds a live-client warning when its source auditor rejects the allegation', async () => {
    const draft = base(); draft.jurors![0].consistencyWarnings = [invented]
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const checker = String(body.messages[0].content).includes('factual-source auditor')
      let content = JSON.stringify(draft)
      if (checker) {
        const units = JSON.parse(String(body.messages[1].content).split('Draft units to check:\n')[1])
        content = JSON.stringify({ findings: units.map((unit: { id: string; text: string }) => ({ unitId: unit.id, status: unit.text.includes(invented) ? 'unsupported' : 'analysis', explanation: unit.text.includes(invented) ? 'Unsupported cash allegation.' : 'Current assessment and coherent ballot.', citations: [] })) })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional-fixture-key', baseUrl: 'https://fictional.invalid/v1', model: 'MiniMax-M3.1-Flash-Preview', timeoutMs: 1000, maxRetries: 0, requestIntervalMs: 0 }, undefined, fetcher)
    await expect(client.generateStage({ ...request, groundingRequired: true })).rejects.toThrow('Source verification rejected')
  })
})
