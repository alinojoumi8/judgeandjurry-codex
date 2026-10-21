import { describe, expect, it } from 'vitest'
import type { GroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const request: StageRequest = { stage: 'crown_opening', packet: '', previousTurns: '', evidence: [], groundingRequired: true }
const draft = { title: '', content: 'I assess the supplied account.', citations: [], jurors: [] }
const previous = (status: 'analysis' | 'unsupported', text = draft.content): GroundingReview => ({ status: 'failed', method: 'source-quotes-and-model-review', repairs: 0, errors: ['A different unit requires repair.'], findings: [{ unitId: 'content:1', text, status, explanation: 'Earlier independent judgment.', citations: [] }] })
describe('independent checker consistency across repair', () => {
  it.each(['reject twice', 'accept twice', 'alternate'] as const)('rechecks changed judgments without treating the prior review as truth: %s', mode => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      calls++
      const status = mode === 'accept twice' || mode === 'alternate' && calls === 2 ? 'analysis' : 'unsupported'
      if (calls === 2) expect(JSON.parse(String(init?.body)).messages[1].content).toContain('checker changed judgment on unchanged text')
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: { 'content:1': { status, supportTypes: ['analysis'], explanation: 'Fresh independent judgment.', citations: [], recordCitations: [] } } }) } }] })
    })
    return client.reviewGrounding(request, draft, previous(mode === 'accept twice' ? 'unsupported' : 'analysis')).then(result => {
      expect(calls).toBe(2)
      expect(result.status).toBe(mode === 'accept twice' ? 'passed' : 'failed')
      expect(result.verificationFailures?.[0].errors.join(' ')).toContain('checker changed judgment on unchanged text')
    })
  })
  it('does not constrain a genuinely changed draft unit with its old judgment', async () => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async () => {
      calls++
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: { 'content:1': { status: 'analysis', supportTypes: ['analysis'], explanation: 'Current assessment only.', citations: [], recordCitations: [] } } }) } }] })
    })
    expect((await client.reviewGrounding(request, draft, previous('unsupported', 'Different rejected text.'))).status).toBe('passed')
    expect(calls).toBe(1)
  })
  it('passes the previous review into checking of an actual author patch and retains the disagreement', async () => {
    let authors = 0, checks = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content as string
      if (!prompt.includes('Draft units to check:\n')) {
        authors++
        return Response.json({ choices: [{ message: { content: JSON.stringify(authors === 1 ? { ...draft, content: 'I assess the account. Repair this phrase.' } : { repairs: [{ unitId: 'content:2', replacement: 'This is my corrected assessment.' }] }) } }] })
      }
      checks++
      const units = JSON.parse(prompt.split('Draft units to check:\n')[1]) as Array<{ id: string }>
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: Object.fromEntries(units.map(unit => [unit.id, { status: checks === 1 ? unit.id === 'content:2' ? 'unsupported' : 'analysis' : unit.id === 'content:1' ? 'unsupported' : 'analysis', supportTypes: ['analysis'], explanation: 'Independent substantive assessment.', citations: [], recordCitations: [] }])) }) } }] })
    })
    await expect(client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', verificationFailures: expect.arrayContaining([expect.objectContaining({ errors: expect.arrayContaining([expect.stringContaining('checker changed judgment on unchanged text')]) })]) } })
    expect({ authors, checks }).toEqual({ authors: 2, checks: 3 })
  })
})
