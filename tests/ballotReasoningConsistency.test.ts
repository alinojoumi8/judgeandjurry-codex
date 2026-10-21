import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import type { StageResult } from '../server/types'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v117-ballot-rationale-contradiction-capture.json', import.meta.url), 'utf8'))
const request = capture.job.request as StageRequest
const captured = capture.result.generated as StageResult
type Unit = { id: string; text: string; kind?: string }
function readUnits(body: string): Unit[] {
  const user = JSON.parse(body).messages[1].content as string
  return JSON.parse(user.split('Draft units to check:\n')[1])
}
function clientWithAudit(transform: (units: Unit[]) => unknown) {
  return new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 10000, maxRetries: 0 }, undefined,
    async (_url, init) => Response.json({ choices: [{ message: { content: JSON.stringify(transform(readUnits(String(init?.body)))) } }] }))
}
const coherent = (units: Unit[]) => ({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Current ballot is coherent under the supplied issue and burden.', citations: [] })) })

describe('whole-ballot reasoning audit before commitment', () => {
  it('withholds the actual accepted not-guilty ballot when its full required account is expressly credited beyond reasonable doubt', async () => {
    const before = JSON.stringify(captured)
    const client = clientWithAudit(units => ({ findings: units.map(unit => ({ unitId: unit.id,
      status: unit.kind === 'ballot_consistency' ? 'contradicted' : 'analysis',
      explanation: unit.kind === 'ballot_consistency' ? 'The selected not-guilty outcome contradicts the expressed finding that the sole required receipt account is credited beyond reasonable doubt.' : 'Accurate source-scoped assessment.', citations: [] })) }))
    const review = await client.reviewGrounding(request, captured)
    expect(review.status).toBe('failed')
    expect(review.findings.some(finding => finding.unitId.startsWith('ballot-consistency-') && finding.status === 'contradicted')).toBe(true)
    expect(JSON.stringify(captured)).toBe(before)
  })

  it('sends one unsplit unit containing the actual selected vote and every current reasoning field', async () => {
    let received: Unit[] = []
    const client = clientWithAudit(units => { received = units; return coherent(units) })
    await client.reviewGrounding(request, captured)
    const units = received.filter(unit => unit.kind === 'ballot_consistency')
    expect(units).toHaveLength(1)
    expect(JSON.parse(units[0].text)).toEqual({ juror: captured.jurors![0].juror, leaning: 'defence',
      title: captured.title, content: captured.content, rationale: captured.jurors![0].rationale,
      mindChangedBecause: captured.jurors![0].mindChangedBecause })
  })

  it('keeps source-only reviews without a current ballot contract separate from a proposed native ballot', async () => {
    let received: Unit[] = []
    const client = clientWithAudit(units => { received = units; return coherent(units) })
    await client.reviewGrounding({ ...request, ballotContract: undefined }, captured)
    expect(received.some(unit => unit.kind === 'ballot_consistency')).toBe(false)
    expect(received.some(unit => unit.id.startsWith('juror-0:'))).toBe(true)
  })

  it.each(['missing', 'duplicate'])('withholds a %s mandatory whole-ballot finding', async mode => {
    const client = clientWithAudit(units => {
      const review = coherent(units)
      const ballot = review.findings.find(finding => finding.unitId.startsWith('ballot-consistency-'))
      if (mode === 'missing') review.findings = review.findings.filter(finding => finding !== ballot)
      else if (ballot) review.findings.push(ballot)
      return review
    })
    expect((await client.reviewGrounding(request, captured)).status).toBe('failed')
  })

  it('does not turn a coherence finding into source proof merely because the checker selects a real exhibit', async () => {
    const client = clientWithAudit(units => ({ findings: units.map(unit => ({ unitId: unit.id,
      status: unit.kind === 'ballot_consistency' ? 'supported' : 'analysis', explanation: 'A source quotation alone does not establish outcome consistency.',
      citations: unit.kind === 'ballot_consistency' ? [{ exhibitId: 'E-001', paragraph: 1 }] : [] })) }))
    expect((await client.reviewGrounding(request, captured)).status).toBe('failed')
  })

  it.each(['crown', 'defence', 'mixed'] as const)('preserves a coherent %s selection without choosing a preferred verdict', async leaning => {
    const result = structuredClone(captured)
    result.content = leaning === 'crown' ? 'I find the condition proved beyond reasonable doubt.' : leaning === 'defence' ? 'I am not satisfied beyond reasonable doubt.' : 'I remain undecided on the supplied condition.'
    result.jurors![0].leaning = leaning
    result.jurors![0].rationale = result.content
    result.jurors![0].mindChangedBecause = 'This is my current initial assessment.'
    const before = JSON.stringify(result)
    expect((await clientWithAudit(coherent).reviewGrounding(request, result)).status).toBe('passed')
    expect(JSON.stringify(result)).toBe(before)
  })

  it('retains the rejected draft and lets the author choose a coherent repaired outcome', async () => {
    let authors = 0
    const original = structuredClone(captured)
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 10000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = String(init?.body)
      if (body.includes('factual-source auditor')) {
        const units = readUnits(body)
        return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id,
          status: unit.kind === 'ballot_consistency' && authors === 1 ? 'contradicted' : 'analysis',
          explanation: authors === 1 ? 'The current not-guilty choice contradicts the expressed sole-condition proof finding.' : 'The author returned a coherent current selection.', citations: [] })) }) } }] })
      }
      authors++
      const result = structuredClone(original)
      if (authors > 1) {
        result.jurors![0].leaning = 'crown'
        result.content = 'I vote guilty because I credit Mira’s handover account beyond reasonable doubt (E-001).'
        result.jurors![0].mindChangedBecause = 'My position is stable because I independently credit Mira’s complete handover account.'
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
    })
    const result = await client.generateStage(request)
    expect(authors).toBe(2)
    expect(result.jurors![0].leaning).toBe('crown')
    expect(result.grounding!.priorFailures!.some(failure => failure.findings.some(finding => finding.unitId.startsWith('ballot-consistency-') && finding.status === 'contradicted'))).toBe(true)
    expect(original).toEqual(captured)
  })
})
