import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'A blue token is on the desk.' }]
const draft = { title: '', content: 'The token remains disputed.', citations: [], jurors: [] }
const request: StageRequest = { stage: 'crown_opening', packet: '', previousTurns: '', evidence, groundingRequired: true }
const valid = JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', explanation: 'An unresolved assessment.', citations: [] }] })

describe('checker JSON integrity', () => {
  it.each(['{"findings":[{"citations":{}}]}', '{"findings":[{"citations":[null]}]}', '{"findings":[{"recordCitations":{}}]}'])('rejects malformed locator containers %s', raw => {
    expect(parseGroundingReview(raw, [{ id: 'content:1', text: draft.content }], evidence).status).toBe('failed')
  })
  it('uses a MiniMax tool schema and checks its arguments as the original complete review', async () => {
    let body: any
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 0 }, undefined, async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: valid } }] } }] })
    })
    expect((await client.reviewGrounding(request, draft)).status).toBe('passed')
    expect(body.tool_choice).toBe('required')
    const findings = body.tools[0].function.parameters.properties.findings
    expect(findings.required).toEqual(['content:1'])
    expect(findings.properties['content:1'].required).toContain('status')
    expect(findings.additionalProperties).toBe(false)
    expect(body.response_format).toBeUndefined()
  })
  it.each(['other_tool', 'duplicate', 'competing', 'trailing', 'wrong_status'])('withholds malformed tool output: %s', mode => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 0 }, undefined, async () => {
      const call = { type: 'function', function: { name: mode === 'other_tool' ? 'other_tool' : 'record_grounding_review', arguments: mode === 'trailing' ? valid + '],"extra":true}' : mode === 'wrong_status' ? valid.replace('"status":"analysis"', '"content:1":"analysis"') : valid } }
      return Response.json({ choices: [{ message: { content: mode === 'competing' ? valid : null, tool_calls: mode === 'duplicate' ? [call, call] : [call] } }] })
    })
    return expect(client.reviewGrounding(request, draft)).resolves.toMatchObject({ status: 'failed' })
  })
  it('rechecks a missing status before author repair even alongside a substantive failure', async () => {
    const prompts: string[] = []
    const current = { ...draft, title: 'Review' }
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      prompts.push(JSON.parse(String(init?.body)).messages[1].content)
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [{ unitId: 'title:1', ...(prompts.length === 1 ? { 'title:1': 'analysis' } : { status: 'analysis' }), explanation: 'Heading.', citations: [] }, { unitId: 'content:1', status: 'unsupported', explanation: 'An independent substantive problem.', citations: [] }] }) } }] })
    })
    const review = await client.reviewGrounding(request, current)
    expect(prompts).toHaveLength(2)
    expect(prompts[0].split('Draft units to check:\n')[1]).toBe(prompts[1].split('Draft units to check:\n')[1])
    expect(review.status).toBe('failed')
    expect(review.verificationFailures?.[0].errors.join(' ')).toContain('valid finding status')
    expect(review.errors.join(' ')).toContain('independent substantive problem')
  })
  it.each(['null', '[]', '17', '"findings"', '{"findings":[null]}', '{"findings":[4]}'])('rejects malformed schema %s without a parser crash', raw => {
    expect(() => parseGroundingReview(raw, [{ id: 'content:1', text: draft.content }], evidence)).not.toThrow()
    expect(parseGroundingReview(raw, [{ id: 'content:1', text: draft.content }], evidence).status).toBe('failed')
  })
  it.each([false, true])('rechecks broken checker JSON without repeating the corrupt output: persistent=%s', async persistent => {
    const prompts: string[] = []
    const corrupt = '{"findings":[{"unitId":"content:1","status":"analysis"}],"recordCitations":[]}],"BROKEN_CHECKER_SENTINEL":true}'
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content as string; prompts.push(prompt)
      return Response.json({ choices: [{ message: { content: prompts.length === 1 || persistent ? corrupt : valid } }] })
    })
    const result = await client.reviewGrounding(request, draft)
    expect(result.status).toBe(persistent ? 'failed' : 'passed')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).not.toContain('BROKEN_CHECKER_SENTINEL')
    expect(prompts[0].split('Draft units to check:\n')[1]).toBe(prompts[1].split('Draft units to check:\n')[1])
    expect(result.verificationRetries).toBe(1)
    expect(result.verificationFailures?.[0].errors.join(' ')).toContain('invalid JSON')
  })
  it('withholds exhausted malformed checks without regenerating a factual draft', async () => {
    let authors = 0, checks = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content as string
      const audit = prompt.includes('Draft units to check:\n')
      if (audit) checks++; else authors++
      return Response.json({ choices: [{ message: { content: audit ? '{"findings":[' : JSON.stringify({ ...draft, title: 'Review' }) } }] })
    })
    await expect(client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', verificationFailures: expect.arrayContaining([expect.objectContaining({ attempt: 1 }), expect.objectContaining({ attempt: 2 })]) } })
    expect(authors).toBe(1)
    expect(checks).toBe(2)
  })
})
