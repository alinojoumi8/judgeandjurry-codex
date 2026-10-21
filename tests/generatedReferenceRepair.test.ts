import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import type { GroundingUnit } from '../server/grounding'

const instruction = { eventId: '11111111-1111-4111-8111-111111111111', type: 'judicial_instruction', actorId: 'judge', payload: { text: 'Apply only the supplied fictional issue.' } }
const invented = '22222222-2222-4222-8222-222222222222'
const sources = [
  { ...supportedOpeningSource, id: 'source-1', exhibitId: 'E-001', text: 'The accounting report states that the balance was not money held by the broker.' },
  { ...supportedOpeningSource, id: 'source-2', exhibitId: 'E-002', text: 'The broker report states that no cash was returned.' },
]
const request: StageRequest = { stage: 'crown_opening', packet: 'A fictional exercise.', previousTurns: '', evidence: sources, groundingRequired: true, courtroomActor: { id: 'crown', name: 'Crown', roles: ['crown'] }, courtroomEvents: [instruction] }

describe('generated references through author repair', () => {
  it.each(['instruction', 'compound source'])('regenerates the %s error within the existing budget and retains its audit', async kind => {
    const sent: string[] = []
    let authorCalls = 0
    const draft = () => kind === 'instruction'
      ? `I apply the supplied fictional issue (Instruction Event ${authorCalls === 1 ? invented : instruction.eventId}).`
      : authorCalls === 1 ? 'The broker report states that no cash was returned and the balance was not money held by the broker (E-002).'
        : 'E-002 states that no cash was returned. E-001 states that the balance was not money held by the broker.'
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); const prompt = body.messages.map((m: { content: string }) => m.content).join('\n'); sent.push(prompt)
      let output: unknown
      if (!prompt.includes('Draft units to check:\n')) {
        authorCalls++
        output = { title: 'Submission', content: draft(), citations: kind === 'instruction' ? [] : authorCalls === 1 ? ['E-002'] : ['E-001', 'E-002'], jurors: [] }
      } else {
        const units = JSON.parse(prompt.split('Draft units to check:\n').at(-1)!) as GroundingUnit[]
        output = { findings: units.map(unit => ({ unitId: unit.id,
          status: unit.id.startsWith('content:') ? kind === 'instruction' ? 'analysis' : authorCalls === 1 ? 'unsupported' : 'supported' : 'analysis',
          explanation: kind === 'compound source' && authorCalls === 1 ? 'E-002 does not supply the balance clause; that clause belongs to E-001.' : 'The selected actual record supports this bounded statement.',
          citations: kind === 'compound source' && unit.id.startsWith('content:') ? [{ exhibitId: authorCalls === 1 || unit.text.includes('E-002') ? 'E-002' : 'E-001', paragraph: 1 }] : [],
          recordCitations: kind === 'instruction' && unit.id.startsWith('content:') ? [instruction.eventId] : [],
        })) }
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] })
    })
    const result = await client.generateStage(request)
    expect(result.grounding?.status).toBe('passed')
    expect(authorCalls).toBe(2)
    expect(sent).toHaveLength(4)
    expect(result.grounding?.repairs).toBe(1)
    expect(result.grounding?.priorFailures).toHaveLength(1)
    expect(sent[0]).toContain('Approved record reference choices:')
    expect(sent[0]).toContain(instruction.eventId)
    expect(sent[0]).toContain('Split statements from different documents into separately cited sentences')
    expect(sent[2]).toContain(kind === 'instruction' ? 'invented' : 'balance clause')
    expect(result.grounding?.priorFailures?.[0].findings.some(f => f.status === 'unsupported')).toBe(true)
    expect(result.content).not.toContain(invented)
  })
})
