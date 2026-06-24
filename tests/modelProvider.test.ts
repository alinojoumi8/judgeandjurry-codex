import { describe, expect, it } from 'vitest'

import {
  cleanModelJsonText,
  createMiniMaxConfig,
  MiniMaxClient,
  ModelProviderError,
  normalizeStageResult,
} from '../server/minimax'
import type { EvidenceItem, JurorProfile } from '../server/types'

const evidence: EvidenceItem[] = [
  {
    id: 'ev1',
    matterId: 'm1',
    exhibitId: 'E-001',
    name: 'note.txt',
    type: 'text',
    mimeType: 'text/plain',
    size: 20,
    text: 'Evidence text.',
    summary: 'Evidence summary.',
    tags: ['Evidence'],
    uploadedAt: new Date().toISOString(),
  },
]

describe('model provider reliability', () => {
  it('infers OpenAI-compatible provider configuration from env', () => {
    const previous = { ...process.env }
    process.env.MODEL_PROVIDER = 'openai-compatible'
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:11434/v1'
    process.env.OPENAI_COMPATIBLE_MODEL = 'qwen2.5:7b'
    process.env.OPENAI_COMPATIBLE_API_KEY = 'ollama'
    process.env.MODEL_TIMEOUT_MS = '1234'
    process.env.MODEL_MAX_RETRIES = '4'

    const config = createMiniMaxConfig()

    expect(config.provider).toBe('openai-compatible')
    expect(config.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(config.model).toBe('qwen2.5:7b')
    expect(config.timeoutMs).toBe(1234)
    expect(config.maxRetries).toBe(4)

    process.env = previous
  })

  it('cleans thinking tags and fenced JSON before parsing', () => {
    const cleaned = cleanModelJsonText(
      '<think>private reasoning</think>```json\n{"title":"Ok","content":"Uses E-001","citations":["E-001"]}\n```',
    )

    expect(JSON.parse(cleaned)).toMatchObject({ title: 'Ok' })
  })

  it('cleans an unclosed thinking prefix before JSON', () => {
    const cleaned = cleanModelJsonText(
      '<think>private reasoning that was cut off\n{"title":"Ok","content":"Uses E-001","citations":["E-001"]}',
    )

    expect(JSON.parse(cleaned)).toMatchObject({ title: 'Ok' })
  })

  it('uses a configurable output token budget for MiniMax requests', async () => {
    const previous = process.env.MODEL_MAX_OUTPUT_TOKENS
    process.env.MODEL_MAX_OUTPUT_TOKENS = '4321'
    let requestBody: Record<string, unknown> | undefined
    const client = new MiniMaxClient(
      {
        provider: 'minimax',
        apiKey: 'test-key',
        baseUrl: 'https://api.minimax.io/v1',
        model: 'MiniMax-M3',
        mock: false,
        timeoutMs: 2_000,
        maxRetries: 0,
      },
      undefined,
      async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          choices: [
            {
              message: {
                content:
                  '{"title":"Token Budget","content":"Uses E-001.","citations":["E-001"]}',
              },
            },
          ],
        })
      },
    )

    await client.generateStage({
      stage: 'issue_spotting',
      packet: 'packet',
      evidence,
      previousTurns: '',
    })

    expect(requestBody?.max_completion_tokens).toBe(4321)
    if (previous === undefined) {
      delete process.env.MODEL_MAX_OUTPUT_TOKENS
    } else {
      process.env.MODEL_MAX_OUTPUT_TOKENS = previous
    }
  })

  it('asks the model for exactly the supplied jury profile count', async () => {
    let requestBody: {
      messages?: Array<{ role: string; content: string }>
    } | undefined
    const jurorProfiles: JurorProfile[] = Array.from({ length: 12 }, (_, index) => ({
      id: `profile-${index + 1}`,
      sessionId: 'session-1',
      juror: `Juror ${index + 1}`,
      role: `Profile ${index + 1}`,
      skepticismLevel: 50,
      burdenSensitivity: 60,
      bias: 'neutral',
      evidenceFocus: 'source reliability',
    }))
    const client = new MiniMaxClient(
      {
        provider: 'minimax',
        apiKey: 'test-key',
        baseUrl: 'https://api.minimax.io/v1',
        model: 'MiniMax-M3',
        mock: false,
        timeoutMs: 2_000,
        maxRetries: 0,
      },
      undefined,
      async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as typeof requestBody
        return Response.json({
          choices: [
            {
              message: {
                content:
                  '{"title":"Jury","content":"Uses E-001.","citations":["E-001"],"jurors":[]}',
              },
            },
          ],
        })
      },
    )

    await client.generateStage({
      stage: 'jury_deliberation',
      packet: 'packet',
      evidence,
      previousTurns: '',
      jurorProfiles,
    })

    expect(requestBody?.messages?.[1]?.content).toContain(
      'include exactly 12 juror objects',
    )
  })

  it('ignores jurors and verdicts returned on the wrong stage', () => {
    const result = normalizeStageResult(
      '{"title":"Issues","content":"Uses E-001.","citations":["E-001"],"jurors":[{"juror":"Juror 1","leaning":"crown","confidence":70,"rationale":"Uses E-001.","citations":["E-001"]}],"verdict":{"outcome":"Too early","confidence":70,"keyFactors":["E-001"],"unresolvedIssues":[],"recommendedNextSteps":[],"citationWarnings":[]}}',
      'issue_spotting',
      evidence,
    )

    expect(result.jurors).toBeUndefined()
    expect(result.verdict).toBeUndefined()
  })

  it('retries transient provider failures and parses the successful response', async () => {
    let calls = 0
    const client = new MiniMaxClient(
      {
        provider: 'openai-compatible',
        apiKey: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
        mock: false,
        timeoutMs: 2_000,
        maxRetries: 1,
      },
      undefined,
      async () => {
        calls += 1
        if (calls === 1) {
          return new Response('temporary', { status: 503 })
        }

        return Response.json({
          choices: [
            {
              message: {
                content:
                  '{"title":"Recovered","content":"Recovered with E-001.","citations":["E-001"]}',
              },
            },
          ],
        })
      },
    )

    const result = await client.generateStage({
      stage: 'issue_spotting',
      packet: 'packet',
      evidence,
      previousTurns: '',
    })

    expect(calls).toBe(2)
    expect(result.title).toBe('Recovered')
    expect(result.citations).toEqual(['E-001'])
  })

  it('does not retry auth failures', async () => {
    let calls = 0
    const client = new MiniMaxClient(
      {
        provider: 'minimax',
        apiKey: 'bad-key',
        baseUrl: 'https://api.minimax.io/v1',
        model: 'MiniMax-M3',
        mock: false,
        timeoutMs: 2_000,
        maxRetries: 2,
      },
      undefined,
      async () => {
        calls += 1
        return new Response('unauthorized', { status: 401 })
      },
    )

    await expect(
      client.generateStage({
        stage: 'issue_spotting',
        packet: 'packet',
        evidence,
        previousTurns: '',
      }),
    ).rejects.toBeInstanceOf(ModelProviderError)
    expect(calls).toBe(1)
  })
})
