import { describe, expect, it } from 'vitest'

import {
  cleanModelJsonText,
  createMiniMaxConfig,
  MiniMaxClient,
  ModelProviderError,
  normalizeStageResult,
} from '../server/minimax'
import { defaultRunConfig, getLegalTemplate } from '../server/runConfig'
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
    sha256: null,
    sourceAvailable: false,
    ingestionStatus: 'metadata_only',
    extractionWarning: null,
    archivedAt: null,
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
      reasoningStyle: 'Document-led reasoning with a chronology check.',
      doubtTriggers: 'Unsupported inference and missing source records.',
      trustAnchors: 'Contemporaneous exhibits and corroborated timelines.',
      emotionalPosture: 'Measured and cautious.',
      evidenceHierarchy: 'Documents, chronology, witnesses, then inference.',
      whatWouldChangeMind: 'A cited exhibit that closes the main uncertainty.',
    }))
    const client = new MiniMaxClient(
      {
        provider: 'minimax',
        apiKey: 'test-key',
        baseUrl: 'https://api.minimax.io/v1',
        model: 'MiniMax-M3',
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
    expect(requestBody?.messages?.[1]?.content).toContain(
      'Fresh session jury profiles',
    )
    expect(requestBody?.messages?.[0]?.content).toContain(
      'strongest prior opposing point',
    )
    expect(requestBody?.messages?.[1]?.content).toContain('beliefTrail')
    expect(requestBody?.messages?.[1]?.content).toContain('deliberationRounds')
    expect(requestBody?.messages?.[1]?.content).toContain('What would change mind')
  })

  it('builds an independent single-juror prompt for secret ballots', async () => {
    let requestBody: {
      temperature?: number
      messages?: Array<{ role: string; content: string }>
    } | undefined
    const profile: JurorProfile = {
      id: 'profile-1',
      sessionId: 'session-1',
      juror: 'Juror 4',
      role: 'Skeptical engineer',
      skepticismLevel: 82,
      burdenSensitivity: 88,
      bias: 'defence',
      evidenceFocus: 'causation, alternative hypotheses',
      reasoningStyle: 'Scientific-skeptic reasoning.',
      doubtTriggers: 'Weak correlation.',
      trustAnchors: 'Reproducible records.',
      emotionalPosture: 'Guarded.',
      evidenceHierarchy: 'Documents first.',
      whatWouldChangeMind: 'Clean corroboration.',
    }
    const client = new MiniMaxClient(
      {
        provider: 'openai-compatible',
        apiKey: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
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
                  '{"title":"Secret Ballot","content":"Ballot cites E-001.","citations":["E-001"],"jurors":[{"juror":"Juror 4","leaning":"defence","confidence":64,"rationale":"Causation remains unproven per E-001.","citations":["E-001"]}]}',
              },
            },
          ],
        })
      },
    )

    const result = await client.generateStage({
      stage: 'juror_ballot',
      packet: 'packet',
      evidence,
      previousTurns: 'Prior record.',
      jurorProfiles: [profile],
      runConfig: defaultRunConfig({ templateId: 'criminal_defence' }),
      legalTemplate: getLegalTemplate('criminal_defence'),
    })

    expect(requestBody?.temperature).toBe(0.7)
    const userPrompt = requestBody?.messages?.[1]?.content ?? ''
    expect(userPrompt).toContain('exactly ONE object for Juror 4')
    expect(userPrompt).toContain('Panel decision rule: unanimous verdict')
    expect(result.jurors).toHaveLength(1)
    expect(result.jurors?.[0]?.leaning).toBe('defence')
  })

  it('feeds secret ballots and the decision rule into the deliberation prompt', async () => {
    let requestBody: {
      messages?: Array<{ role: string; content: string }>
    } | undefined
    const client = new MiniMaxClient(
      {
        provider: 'openai-compatible',
        apiKey: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
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
                  '{"title":"Jury","content":"The panel weighed E-001.","citations":["E-001"],"jurors":[]}',
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
      previousTurns: 'Prior record.',
      juryBallots: [
        {
          juror: 'Juror 1',
          leaning: 'crown',
          confidence: 71,
          rationale: 'The chronology holds together.',
          citations: ['E-001'],
        },
      ],
      runConfig: defaultRunConfig({ templateId: 'civil_dispute' }),
      legalTemplate: getLegalTemplate('civil_dispute'),
    })

    const userPrompt = requestBody?.messages?.[1]?.content ?? ''
    expect(userPrompt).toContain('Independent secret ballots cast before deliberation')
    expect(userPrompt).toContain('Juror 1 voted crown at 71%')
    expect(userPrompt).toContain('Panel decision rule:')
  })

  it('instructs the judge to use template outcome language', async () => {
    let requestBody: {
      temperature?: number
      messages?: Array<{ role: string; content: string }>
    } | undefined
    const client = new MiniMaxClient(
      {
        provider: 'openai-compatible',
        apiKey: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
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
                  '{"title":"Ruling","content":"Ruling cites E-001.","citations":["E-001"],"verdict":{"outcome":"Hung jury - no verdict","confidence":55,"keyFactors":["E-001"],"unresolvedIssues":[],"recommendedNextSteps":[],"citationWarnings":[]}}',
              },
            },
          ],
        })
      },
    )

    await client.generateStage({
      stage: 'judge_ruling',
      packet: 'packet',
      evidence,
      previousTurns: 'Jury deliberation record: Split: 5 crown / 7 defence / 0 mixed.',
      runConfig: defaultRunConfig({ templateId: 'criminal_defence' }),
      legalTemplate: getLegalTemplate('criminal_defence'),
    })

    expect(requestBody?.temperature).toBe(0.2)
    const userPrompt = requestBody?.messages?.[1]?.content ?? ''
    expect(userPrompt).toContain('"Hung jury - no verdict"')
    expect(userPrompt).toContain(
      'the outcome must be the hung/no-verdict option',
    )
  })

  it('normalizes juror belief trails and deliberation rounds', () => {
    const result = normalizeStageResult(
      JSON.stringify({
        title: 'Jury',
        content: 'The panel debated E-001.',
        citations: ['E-001'],
        jurors: [
          {
            juror: 'Juror 1',
            leaning: 'defence',
            confidence: 68,
            rationale: 'Source reliability keeps a reasonable doubt alive with E-001.',
            citations: ['E-001'],
            beliefTrail: [
              {
                stage: 'after_defence_opening',
                leaning: 'defence',
                confidence: 55,
                belief: 'The defence gap mattered.',
                why: 'The record did not close the gap.',
                citations: ['E-001'],
              },
            ],
            deliberationRounds: [
              {
                round: 1,
                focus: 'source reliability',
                exchange: 'Juror 1 pressed the source-record gap.',
                responseTo: 'Juror 2',
                leaning: 'defence',
                confidence: 68,
              },
            ],
            mindChangedBecause: 'The vote stayed stable because the cited record left the same gap.',
            consistencyWarnings: [],
          },
        ],
      }),
      'jury_deliberation',
      evidence,
    )

    expect(result.jurors?.[0]?.beliefTrail?.[0]).toMatchObject({
      stage: 'after_defence_opening',
      leaning: 'defence',
      confidence: 55,
    })
    expect(result.jurors?.[0]?.beliefTrail?.[0]?.citations).toEqual(['E-001'])
    expect(result.jurors?.[0]?.deliberationRounds?.[0]?.responseTo).toBe('Juror 2')
    expect(result.jurors?.[0]?.mindChangedBecause).toContain('stayed stable')
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

  it('blocks MiniMax requests when no API key is configured', async () => {
    const client = new MiniMaxClient(
      {
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/v1',
        model: 'MiniMax-M3',
        timeoutMs: 2_000,
        maxRetries: 0,
      },
      undefined,
      async () => {
        throw new Error('fetch should not be called')
      },
    )

    await expect(
      client.generateStage({
        stage: 'issue_spotting',
        packet: 'packet',
        evidence,
        previousTurns: '',
      }),
    ).rejects.toThrow(/MINIMAX_API_KEY/)
  })
})
