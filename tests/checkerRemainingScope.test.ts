import { describe, expect, it } from 'vitest'
import { groundingUnits, type GroundingUnit } from '../server/grounding'
import { MiniMaxClient, normalizeStageResult, type StageRequest } from '../server/minimax'

const initial = { issueId: 'issue-1', round: 'initial', choice: 'requires_reassessment', confidence: 0, rationale: 'Withheld.', usable: false }
const request: StageRequest = { stage: 'jury_deliberation', packet: '', previousTurns: '', evidence: [],
  courtroomActor: { id: 'juror-01', name: 'Juror 1', roles: ['juror'] }, courtroomEvents: [], courtroomAssessments: [initial], verdictOutcomes: ['guilty', 'not_guilty', 'no_verdict'] }
const noUsable = 'No usable initial ballot exists, so I am recording a present not-guilty assessment rather than claiming continuity with an earlier position.'
const noInitial = 'No initial ballot was supplied, so no prior assessment or actual change can be assessed.'
function draft(reason: string) {
  return normalizeStageResult(JSON.stringify({ title: 'Review', content: 'I retain doubt.', citations: [], jurors: [{ juror: 'juror-01', leaning: 'defence', confidence: 60,
    rationale: 'I retain doubt.', citations: [], mindChangedBecause: reason, consistencyWarnings: [] }] }), request.stage, [])
}
function clientFor(reply: (units: GroundingUnit[], attempt: number) => unknown) {
  const prompts: string[] = []
  const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined,
    async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content
      prompts.push(prompt)
      return Response.json({ choices: [{ message: { content: JSON.stringify(reply(JSON.parse(prompt.split('Draft units to check:\n')[1]), prompts.length)) } }] })
    })
  return { client, prompts }
}
const findings = (units: GroundingUnit[]) => units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Current assessment.', citations: [], recordCitations: [] }))

describe('bounded re-review of actual absent or unusable initial history', () => {
  it.each([noUsable, noInitial])('asks the checker to distinguish the candidate and prior usable state: %s', async text => {
    const { client, prompts } = clientFor((units, attempt) => ({ findings: findings(units).map(row => row.unitId === 'juror-change-0:1' && attempt === 1
      ? { ...row, status: 'unsupported', explanation: 'The supplied initial assessment is unusable, but it exists, so no usable initial ballot is inaccurate.' } : row) }))
    const req = text === noInitial ? { ...request, stage: 'juror_ballot', ballotRound: 'initial' as const, courtroomAssessments: [] } : request
    const result = await client.reviewGrounding(req, draft(text))
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('checker current-juror-state mismatch')
    expect(prompts[1]).toContain('usable')
    expect(result.status).toBe('passed')
    expect(prompts[0].split('Draft units to check:\n')[1]).toBe(prompts[1].split('Draft units to check:\n')[1])
  })
  it.each([false, true])('does not retry false history or accept persistent negative meaning: usable=%s', async usable => {
    const { client, prompts } = clientFor(units => ({ findings: findings(units).map(row => row.unitId === 'juror-change-0:1'
      ? { ...row, status: 'unsupported', explanation: 'The supplied initial assessment is unusable, but it exists, so no usable initial ballot is inaccurate.' } : row) }))
    expect((await client.reviewGrounding({ ...request, courtroomAssessments: [{ ...initial, usable, choice: 'not_guilty' }] }, draft(noUsable))).status).toBe('failed')
    expect(prompts).toHaveLength(usable ? 1 : 2)
  })
})

describe('checker finding identifiers must exactly cover the requested units', () => {
  it.each(['misspelled', 'duplicate', 'omitted', 'extra'])('repairs %s IDs on the same draft with an exact inventory', async mode => {
    const result = draft(noUsable)
    const { client, prompts } = clientFor((units, attempt) => {
      const rows = findings(units)
      if (attempt === 1) {
        if (mode === 'misspelled') rows.at(-1)!.unitId = 'juror-change-0-1'
        if (mode === 'duplicate') rows.at(-1)!.unitId = rows[0].unitId
        if (mode === 'omitted') rows.pop()
        if (mode === 'extra') rows.push({ ...rows[0], unitId: 'invented-unit' })
      }
      return { findings: rows }
    })
    expect((await client.reviewGrounding(request, result)).status).toBe('passed')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('Exact finding ID inventory')
    expect(prompts[1]).toContain('Required finding slots')
    expect(prompts[1].split('Draft units to check:\n')[1]).toBe(JSON.stringify(groundingUnits(result)))
  })
  it('never silently repairs IDs after retry exhaustion', async () => {
    const { client, prompts } = clientFor(units => ({ findings: findings(units).map(row => ({ ...row, unitId: row.unitId.replace(/:/g, '-') })) }))
    const result = await client.reviewGrounding(request, draft(noUsable))
    expect(prompts).toHaveLength(2)
    expect(result.status).toBe('failed')
    expect(result.errors.some(error => error.includes('Exact finding ID inventory'))).toBe(true)
  })
})

describe('a peer did not resolve doubt is not a claim that the peer supplied nothing', () => {
  it.each([false, true])('rechecks the complete qualified statement without accepting a persistent rejection=%s', async repeat => {
    const reason = 'My initial not-guilty position remains stable because Juror-08 supplied no specific evidence resolving attribution, knowledge, deprivation, or value.'
    const peer = { eventId: 'peer-08', actorId: 'juror-08', type: 'juror_deliberation_turn', payload: { contribution: 'I identify unresolved attribution, knowledge and deprivation.' } }
    const { client, prompts } = clientFor((units, attempt) => ({ findings: findings(units).map(row => row.unitId === 'juror-change-0:1'
      ? { ...row, status: attempt === 1 || repeat ? 'unsupported' : 'analysis', explanation: 'The peer does not establish the negative premise that Juror-08 supplied no specific evidence.', recordCitations: [{ eventId: peer.eventId }] } : row) }))
    const result = await client.reviewGrounding({ ...request, courtroomEvents: [peer], courtroomAssessments: [{ ...initial, usable: true, choice: 'not_guilty' }] }, draft(reason))
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('checker peer-negation mismatch')
    expect(result.status).toBe(repeat ? 'failed' : 'passed')
  })
})
