import { describe, expect, it } from 'vitest'
import type { GroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const request: StageRequest = { stage: 'crown_closing', packet: '', previousTurns: '', evidence: [] }
// Isolate review completion from the separate party/source attribution guards.
const draft = { title: 'Closing', content: 'I assess the supplied explanation.', citations: [], jurors: [] }
const positive = { status: 'analysis', supportTypes: ['analysis'], explanation: 'A present assessment.', citations: [], recordCitations: [] }
const negative = { ...positive, status: 'unsupported', explanation: 'The assessment needs an independently checked explanation.' }

function harness(rows: unknown[], maxRetries = 1) {
  const prompts: string[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries }, undefined, async (_url, init) => {
    prompts.push(JSON.parse(String(init?.body)).messages[1].content)
    return Response.json({ choices: [{ message: { content: JSON.stringify(rows[prompts.length - 1]) } }] })
  })
  return { client, prompts }
}

describe('same-draft completeness and judgment consistency', () => {
  it.each(['accepted', 'rejected'] as const)('retains an explicit rejection despite a malformed sibling row: %s completion', async completion => {
    const { recordCitations: _omittedRecord, ...partialNegative } = negative
    const { supportTypes: _omittedDomains, ...malformedPositive } = positive
    const h = harness([
      { findings: { 'title:1': malformedPositive, 'content:1': partialNegative } },
      { findings: { 'title:1': positive, 'content:1': completion === 'accepted' ? positive : negative } },
    ])
    const review = await h.client.reviewGrounding(request, draft)
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[0].split('Draft units to check:\n')[1]).toBe(h.prompts[1].split('Draft units to check:\n')[1])
    expect(h.prompts[1]).toContain(negative.explanation)
    expect(review.status).toBe('failed')
    expect(review.verificationFailures?.[0]).toMatchObject({ findings: [], explicitRejections: [{ unitId: 'content:1', text: draft.content, status: 'unsupported', explanation: negative.explanation }] })
    expect(review.errors.join(' ')).toContain(completion === 'accepted' ? 'checker changed judgment on unchanged text' : negative.explanation)
    if (completion === 'rejected') expect(review.validationErrors ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining('checker changed judgment')]))
  })

  it('completes a current negative without preserving a prior false acceptance', async () => {
    const { supportTypes: _omittedDomains, ...partialNegative } = negative
    const h = harness([
      { findings: { 'title:1': positive, 'content:1': partialNegative } },
      { findings: { 'title:1': positive, 'content:1': negative } },
    ])
    const previous: GroundingReview = { status: 'failed', method: 'source-quotes-and-model-review', repairs: 0, errors: ['Another unit needed repair.'], findings: [{ unitId: 'content:1', text: draft.content, ...positive, status: 'analysis', supportTypes: ['analysis'] }] }
    const review = await h.client.reviewGrounding(request, draft, previous)
    expect(h.prompts).toHaveLength(2)
    expect(review.status).toBe('failed')
    expect(review.findings.find(finding => finding.unitId === 'content:1')?.status).toBe('unsupported')
    expect(review.errors.join(' ')).not.toContain('checker changed judgment on unchanged text')
    expect(review.findings.find(finding => finding.unitId === 'content:1')?.supportTypes).toEqual(['analysis'])
    expect(review.verificationFailures?.[0].findings?.find(finding => finding.unitId === 'content:1')?.supportTypes).toBeUndefined()
  })

  it('allows a genuinely independent consistency recheck to resolve an earlier negative', async () => {
    const { supportTypes: _omittedDomains, ...malformedPositive } = positive
    const h = harness([
      { findings: { 'title:1': malformedPositive, 'content:1': negative } },
      { findings: { 'title:1': positive, 'content:1': positive } },
      { findings: { 'title:1': positive, 'content:1': positive } },
    ], 2)
    const review = await h.client.reviewGrounding(request, draft)
    expect(h.prompts).toHaveLength(3)
    expect(h.prompts[2]).toContain('checker changed judgment on unchanged text')
    expect(review.status).toBe('passed')
    expect(review.verificationFailures).toHaveLength(2)
  })
})
