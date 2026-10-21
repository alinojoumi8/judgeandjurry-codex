import { describe, expect, it } from 'vitest'
import { MiniMaxClient, ModelProviderError, type StageRequest } from '../server/minimax'
import { type GroundingUnit } from '../server/grounding'
import { groundingTool } from '../server/groundingFormat'

const request: StageRequest = { stage: 'juror_ballot', ballotRound: 'initial', packet: '', previousTurns: '', evidence: [], groundingRequired: true,
  courtroomActor: { id: 'juror-01', name: 'Juror 1', roles: ['juror'] }, courtroomEvents: [], courtroomAssessments: [],
  ballotContract: { permittedOutcomes: ['guilty', 'not_guilty', 'no_verdict'], events: [] } }
const draft = { title: 'Ballot', content: 'I vote not guilty.', citations: [], jurors: [{ juror: 'juror-01', leaning: 'defence' as const, confidence: 60, rationale: 'The burden remains unmet.', citations: [], mindChangedBecause: '' }] }
const row = (unit: GroundingUnit) => ({ unitId: unit.id, status: 'analysis', explanation: 'This is a current assessment consistent with the structured choice.', citations: [], recordCitations: [] })

function harness(check: (units: GroundingUnit[], attempt: number) => unknown, author = () => draft) {
  const prompts: string[] = []; let checks = 0; let authors = 0
  const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[1].content as string; prompts.push(prompt)
    const units = prompt.includes('Draft units to check:\n') ? JSON.parse(prompt.split('Draft units to check:\n')[1]) as GroundingUnit[] : undefined
    const result = units ? check(units, ++checks) : (authors++, author())
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
  })
  return { client, prompts, counts: () => ({ checks, authors }) }
}

describe('checker contract repair without author drift', () => {
  it.each(['supported', 'analysis'])('repairs an invalid coherence record (%s) on the same draft', async status => {
    const h = harness((units, n) => ({ findings: units.map(unit => unit.kind && n === 1 ? { ...row(unit), status, citations: [{ exhibitId: 'E-001', paragraph: 1 }] } : row(unit)) }))
    const result = await h.client.generateStage(request)
    expect(result.content).toBe(draft.content)
    expect(h.counts()).toEqual({ authors: 1, checks: 2 })
    expect(result.grounding?.verificationFailures).toHaveLength(1)
  })
  it('does not rewrite the author after repeated coherence-format errors', async () => {
    const h = harness(units => ({ findings: units.map(unit => unit.kind ? { ...row(unit), status: 'supported' } : row(unit)) }))
    await expect(h.client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', verificationRetries: 1 } })
    expect(h.counts()).toEqual({ authors: 1, checks: 2 })
  })
  it('does not mistake a missing finding for a substantive author defect', async () => {
    const h = harness(units => ({ findings: units.slice(1).map(row) }))
    await expect(h.client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed' } })
    expect(h.counts()).toEqual({ authors: 1, checks: 2 })
  })
  it('does not use an incomplete inventory to retry away a substantive rejection', async () => {
    const h = harness(units => ({ findings: units.filter(unit => !unit.kind).map(unit => ({ ...row(unit), status: 'unsupported', explanation: 'The actual claim is unsupported.' })) }))
    expect((await h.client.reviewGrounding(request, draft)).status).toBe('failed')
    expect(h.counts()).toEqual({ authors: 0, checks: 1 })
  })
  it('repairs a non-source supported label using the explicit support type', async () => {
    const h = harness((units, n) => ({ findings: units.map(unit => ({ ...row(unit), status: n === 1 && !unit.kind ? 'supported' : 'analysis', supportTypes: [unit.kind ? 'coherence' : 'own_assessment'] })) }))
    const result = await h.client.generateStage(request)
    expect(result.grounding?.status).toBe('passed')
    expect(h.counts()).toEqual({ authors: 1, checks: 2 })
  })
  it('uses one provider-compatible finding shape with explicit coherence rules', () => {
    const tool = groundingTool([{ id: 'content:1', text: 'Speech.' }, { id: 'ballot-consistency-0:1', text: '{}', kind: 'ballot_consistency' }], { exhibits: ['E-001'], records: ['R-001'] }).function
    const items = tool.parameters.properties.findings.properties['content:1']
    expect(items).not.toHaveProperty('oneOf')
    expect(tool.parameters.properties.findings.required).toEqual(['content:1', 'ballot-consistency-0:1'])
    expect(items.properties.citations.type).toBe('array')
    expect(items.properties.recordCitations.type).toBe('array')
    expect(items.properties.recordCitations.items.properties.eventId.enum).toEqual(['R-001'])
    expect(tool.description).toContain('supportTypes ["coherence"], status analysis/contradicted/unsupported, and empty citations and recordCitations arrays')
  })
  it.each(['citations', 'recordCitations'])('rechecks a captured empty-string %s without changing the draft', async field => {
    const h = harness((units, n) => ({ findings: units.map(unit => n === 1 ? { ...row(unit), [field]: '' } : row(unit)) }))
    const result = await h.client.generateStage(request)
    expect(result.content).toBe(draft.content)
    expect(result.grounding?.verificationFailures?.[0].errors).toEqual(expect.arrayContaining([expect.stringMatching(/schema/i)]))
    expect(h.counts()).toEqual({ authors: 1, checks: 2 })
  })
  it('withholds repeated empty-string selectors instead of treating them as empty arrays', async () => {
    const h = harness(units => ({ findings: units.map(unit => ({ ...row(unit), citations: '', recordCitations: '' })) }))
    await expect(h.client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', validationErrors: ['Invalid findings schema'] } })
    expect(h.counts()).toEqual({ authors: 1, checks: 2 })
  })
})

describe('checker and repair audit survives provider stops', () => {
  it.each([false, true])('retains prior checker findings on retry failure (retryable=%s)', async retryable => {
    const h = harness((units, n) => {
      if (n > 1) throw new ModelProviderError('Fixture budget exhausted', { retryable })
      return { findings: units.map(unit => unit.kind ? { ...row(unit), status: 'supported' } : row(unit)) }
    })
    await expect(h.client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', findings: expect.arrayContaining([expect.objectContaining({ unitId: 'ballot-consistency-0:1' })]), verificationFailures: expect.arrayContaining([expect.objectContaining({ attempt: 1 })]), errors: expect.arrayContaining([expect.stringContaining('Fixture budget exhausted')]) } })
  })
  it.each(['author', 'checker'])('preserves failed findings and applied patches when the %s stops', async stop => {
    let authors = 0
    const h = harness((units, n) => {
      if (n > 1) throw new ModelProviderError('Fixture budget exhausted', { retryable: false })
      return { findings: units.map(unit => unit.id === 'content:1' ? { ...row(unit), status: 'unsupported', explanation: 'Revise this assessment.' } : row(unit)) }
    }, () => {
      if (++authors === 1) return draft
      if (stop === 'author') throw new ModelProviderError('Fixture budget exhausted', { retryable: false })
      return { repairs: [{ unitId: 'content:1', replacement: 'The Crown has not met its burden.' }] } as unknown as typeof draft
    })
    try { await h.client.generateStage(request); expect.fail('A stopped review cannot pass') } catch (error) {
      expect(error).toMatchObject({ grounding: { status: 'failed', priorFailures: expect.arrayContaining([expect.objectContaining({ findings: expect.arrayContaining([expect.objectContaining({ unitId: 'content:1', status: 'unsupported' })]) })]) } })
      if (stop === 'checker') expect((error as ModelProviderError).grounding?.appliedRepairs).toEqual([{ unitId: 'content:1', before: draft.content, replacement: 'The Crown has not met its burden.' }])
    }
  })
})
