import { describe, expect, it } from 'vitest'
import { MiniMaxClient, normalizeStageResult, type StageRequest } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import type { GroundingUnit } from '../server/grounding'

const source = { ...supportedOpeningSource, exhibitId: 'E-001', text: 'The report records a blue token at the desk.' }
const request: StageRequest = { stage: 'crown_opening', packet: 'Fictional exercise.', previousTurns: '', evidence: [source], groundingRequired: true }
const draft = { title: '', content: 'E-001 records a blue token at the desk.', citations: ['E-001'], jurors: [] }
const config = { provider: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }
const reply = (content: string, finish_reason = 'stop') => Response.json({ choices: [{ finish_reason, message: { content } }] })
const reviewText = (prompt: string, citation: unknown, reject = false) => JSON.stringify({ findings: (JSON.parse(prompt.split('Draft units to check:\n').at(-1)!) as GroundingUnit[]).map(unit => ({ unitId: unit.id, status: reject ? 'unsupported' : 'supported', explanation: reject ? 'The draft adds an unsupported fact.' : 'The selected report supports this attribution.', citations: [citation] })) })

describe('structured response repairs', () => {
  it.each(['length', 'max_tokens'])('withholds even valid JSON marked %s and regenerates within the same budget', async finishReason => {
    const sent: Array<{ messages: Array<{ content: string }>; max_tokens: number }> = []
    const client = new MiniMaxClient(config, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); sent.push(body)
      const prompt = body.messages.map((m: { content: string }) => m.content).join('\n')
      return prompt.includes('Draft units to check:\n') ? reply(reviewText(prompt, { exhibitId: 'E-001', paragraph: 1 })) : reply(JSON.stringify(draft), sent.length === 1 ? finishReason : 'stop')
    })
    const result = await client.generateStage(request)
    expect(sent).toHaveLength(3)
    expect(result.grounding?.status).toBe('passed')
    expect(result.grounding?.priorFailures?.[0].errors.join(' ')).toContain('truncated')
    expect(sent[1].messages[1].content).toContain('finish_reason')
    expect(sent[1].messages[1].content).toContain('Do not repeat identifiers')
    expect(new Set(sent.map(body => body.max_tokens)).size).toBe(1)
  })

  it('keeps exhausted truncation visible without another request', async () => {
    let calls = 0
    const client = new MiniMaxClient(config, undefined, async () => { calls++; return reply(JSON.stringify(draft), 'length') })
    await expect(client.generateStage(request)).rejects.toThrow('truncated')
    expect(calls).toBe(2)
  })

  it.each(['length', 'invalid JSON', 'misspelled exhibitId'])('repairs checker %s on the identical draft', async failure => {
    const sent: string[] = []
    const client = new MiniMaxClient(config, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); const prompt = body.messages.map((m: { content: string }) => m.content).join('\n'); sent.push(prompt)
      const valid = reviewText(prompt, { exhibitId: 'E-001', paragraph: 1 })
      return sent.length === 1 ? failure === 'length' ? reply(valid, 'length') : failure === 'invalid JSON' ? reply('{"findings":[') : reply(reviewText(prompt, { expitId: 'E-001', paragraph: 1 })) : reply(valid)
    })
    const review = await client.reviewGrounding(request, draft)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain('SAME draft')
    expect(sent[0].split('Draft units to check:\n')[1]).toBe(sent[1].split('Draft units to check:\n')[1])
    expect(review.findings[0].citations[0].quote).toBe(source.text)
  })

  it.each(['length', 'invalid JSON', 'misspelled exhibitId'])('withholds repeated checker %s after the existing retry', async failure => {
    let calls = 0
    const client = new MiniMaxClient(config, undefined, async (_url, init) => {
      calls++; const prompt = JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content).join('\n')
      return failure === 'length' ? reply(reviewText(prompt, { exhibitId: 'E-001', paragraph: 1 }), 'length') : failure === 'invalid JSON' ? reply('{"findings":[') : reply(reviewText(prompt, { expitId: 'E-001', paragraph: 1 }))
    })
    expect((await client.reviewGrounding(request, draft)).status).toBe('failed')
    expect(calls).toBe(2)
  })

  it('preserves a substantive rejection even with a malformed locator', async () => {
    let calls = 0
    const client = new MiniMaxClient(config, undefined, async (_url, init) => {
      calls++; const prompt = JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content).join('\n')
      return reply(reviewText(prompt, { expitId: 'E-001', paragraph: 1 }, true))
    })
    const review = await client.reviewGrounding(request, draft)
    expect(review.status).toBe('failed')
    expect(review.findings[0].explanation).toContain('unsupported fact')
    expect(calls).toBe(1)
  })

  it('accepts a complete response without a repair', async () => {
    let calls = 0
    const client = new MiniMaxClient(config, undefined, async () => { calls++; return reply(JSON.stringify(draft)) })
    expect((await client.generateStage({ ...request, groundingRequired: false })).content).toBe(draft.content)
    expect(calls).toBe(1)
  })

  it('preserves a separate substantive failure during locator repair', async () => {
    let calls = 0
    const client = new MiniMaxClient(config, undefined, async (_url, init) => {
      calls++; const prompt = JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content).join('\n')
      const output = JSON.parse(reviewText(prompt, { expitId: 'E-001', paragraph: 1 }))
      output.findings.at(-1).status = 'unsupported'
      output.findings.at(-1).explanation = 'The second sentence invents an event.'
      return reply(JSON.stringify(output))
    })
    const review = await client.reviewGrounding(request, { ...draft, content: `${draft.content} The witness admitted fraud.` })
    expect(review.status).toBe('failed')
    expect(calls).toBe(1)
  })

  it.each(['401', 'transport'])('does not relabel %s failures as checker JSON failures', async failure => {
    let calls = 0
    const client = new MiniMaxClient(config, undefined, async () => { calls++; if (failure === 'transport') throw new Error('Network unavailable'); return new Response('Denied', { status: 401 }) })
    await expect(client.reviewGrounding(request, draft)).rejects.toThrow(failure === 'transport' ? 'Network unavailable' : 'request failed (401')
    expect(calls).toBe(1)
  })

  it.each(['null', '[{"content":"An array is not a stage result."}]', '[]'])('rejects the non-object root %s with a retryable format error', raw => {
    expect(() => normalizeStageResult(raw, request.stage, [])).toThrow(/Model output (?:was not valid JSON|did not contain a JSON object)/)
  })
})
