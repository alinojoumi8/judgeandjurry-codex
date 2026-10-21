import { describe, expect, it } from 'vitest'
import { MiniMaxClient, normalizeStageResult, type StageRequest } from '../server/minimax'
import { validateJuryBallotContract } from '../server/juryBallotContract'
import type { GroundingUnit } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'Avery said: So, that is - I retained the money.' }]
const request: StageRequest = { stage: 'jury_deliberation', packet: '', previousTurns: '', evidence, groundingRequired: true, courtroomProtocol: false,
  courtroomActor: { id: 'juror-01', name: 'Juror 1', roles: ['juror'] }, courtroomEvents: [], courtroomAssessments: [], verdictOutcomes: ['guilty', 'not_guilty', 'no_verdict'] }
const rawDraft = (bad: boolean) => ({ title: 'Review', content: `E-001 records “${bad ? 'So, I retained the money' : 'So, that is - I retained the money'}” [E-001].`, citations: ['E-001'], jurors: [{ juror: 'juror-01', leaning: 'defence', confidence: 60, rationale: 'I retain doubt.', citations: [], mindChangedBecause: '' }] })

describe('bounded author source repairs', () => {
  it.each([false, true])('retains altered-quote failures and requires a successful new review: persistent=%s', async persistent => {
    let authors = 0
    const prompts: string[] = []
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content as string; prompts.push(prompt)
      const audit = prompt.includes('Draft units to check:\n')
      const result = audit ? { findings: (JSON.parse(prompt.split('Draft units to check:\n')[1]) as GroundingUnit[]).map(unit => ({ unitId: unit.id, status: unit.id === 'content:1' ? 'supported' : 'analysis', explanation: 'Compare the literal selected quotation.', citations: unit.id === 'content:1' ? [{ exhibitId: 'E-001', paragraph: 1 }] : [] })) } : rawDraft(++authors === 1 || persistent)
      return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
    })
    if (persistent) await expect(client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', repairs: 1, priorFailures: expect.arrayContaining([expect.objectContaining({ errors: expect.arrayContaining([expect.stringContaining('quotation')]) })]) } })
    else {
      const result = await client.generateStage(request)
      expect(result.grounding?.status).toBe('passed')
      expect(result.grounding?.priorFailures).toHaveLength(1)
      expect(result.content).toContain('So, that is - I retained the money')
    }
    expect(authors).toBe(2)
    expect(prompts).toHaveLength(4)
    expect(prompts[2]).toContain('Repair each rejected clause against its own named source')
    expect(prompts[2]).toContain('mark every omission with an ellipsis')
  })
})

describe('eligible peer repair inventory', () => {
  it.each([false, true])('provides exact named-peer words without granting acceptance: persistent=%s', async persistent => {
    const events = [
      { eventId: 'wrong', actorId: 'juror-02', type: 'juror_deliberation_turn', payload: { contribution: 'I focus on timing.' } },
      { eventId: 'right', actorId: 'juror-06', type: 'juror_deliberation_turn', payload: { contribution: 'I retain doubt about the totals.' } },
      { eventId: 'withheld', actorId: 'juror-06', type: 'juror_deliberation_turn', payload: { contribution: 'UNUSABLE_WORDS', withheld: true } },
    ]
    const prompts: string[] = []
    const result = normalizeStageResult(JSON.stringify({ ...rawDraft(false), content: 'I agree with juror-06’s concrete review.' }), request.stage, evidence)
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content as string; prompts.push(prompt)
      const units = JSON.parse(prompt.split('Draft units to check:\n')[1]) as GroundingUnit[]
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: units.map(u => ({ unitId: u.id, status: 'analysis', explanation: 'Peer assessment.', citations: [], recordCitations: u.id === 'content:1' ? [prompts.length === 1 || persistent ? 'wrong' : 'right'] : [] })) }) } }] })
    })
    expect((await client.reviewGrounding({ ...request, courtroomEvents: events }, result)).status).toBe(persistent ? 'failed' : 'passed')
    expect(prompts).toHaveLength(2)
    const inventory = prompts[1].match(/Eligible named-peer records: (\[[^\n]+?\])/u)![1]
    expect(JSON.parse(inventory)).toEqual([{ actorId: 'juror-06', eventId: 'right', contribution: 'I retain doubt about the totals.' }])
    expect(prompts[0].split('Draft units to check:\n')[1]).toBe(prompts[1].split('Draft units to check:\n')[1])
  })
})

describe('legacy ballots use the same explicit causal event contract', () => {
  const req: StageRequest = { ...request, stage: 'juror_ballot', ballotRound: 'final', ballotContract: { initialChoice: 'guilty', permittedOutcomes: ['guilty', 'not_guilty', 'no_verdict'], events: [{ eventId: 'actual-peer', exhibitIds: ['E-001'] }] } }
  it.each([undefined, 'made-up', 'actual-peer'])('checks selected event %s without requiring legacy instruction acknowledgment', eventId => {
    const result = normalizeStageResult(JSON.stringify(rawDraft(false)), 'juror_ballot', evidence)
    Object.assign(result.jurors![0], { changedByEventId: eventId, citations: ['E-001'], mindChangedBecause: 'The peer clarified the account.' })
    expect(validateJuryBallotContract(req, result).length).toBe(eventId === 'actual-peer' ? 0 : 1)
    expect(validateJuryBallotContract({ ...req, ballotContract: { ...req.ballotContract!, initialChoice: undefined } }, result)).toEqual([])
    expect(validateJuryBallotContract({ ...req, courtroomProtocol: true }, result)).toContain('Acknowledge the current instructionEventId.')
  })
})
