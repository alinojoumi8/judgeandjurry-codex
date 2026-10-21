import { describe, expect, it } from 'vitest'
import { MiniMaxClient, normalizeStageResult, type StageRequest } from '../server/minimax'
import { jurorInfluenceStatement, matchingJurorInfluence } from '../server/checkerJurorState'
import type { GroundingUnit } from '../server/grounding'

const peer = { eventId: 'peer-04', type: 'juror_deliberation_turn', actorId: 'juror-04', payload: { contribution: 'I credit specific attribution but retain doubt about knowledge and matched loss.' } }
const other = { ...peer, eventId: 'peer-02', actorId: 'juror-02' }
const initial = { issueId: 'issue-1', round: 'initial', choice: 'not_guilty', confidence: 70, rationale: 'I retain doubt.', usable: true }
const request: StageRequest = { stage: 'jury_deliberation', proceedingPhase: 'deliberation_challenges', packet: '', previousTurns: '', evidence: [], courtroomActor: { id: 'juror-01', name: 'Juror 1', roles: ['juror'] }, courtroomEvents: [peer, other], courtroomAssessments: [initial], verdictOutcomes: ['guilty', 'not_guilty', 'no_verdict'] }
const texts = [
  'Juror-04’s documentary point reinforced my position but supplied no new evidence resolving knowledge or matched loss.',
  'Juror-04’s visible point reinforced my initial position but supplied no state-of-mind evidence or investor-level tracing resolving my doubts.',
]
const current = { actorId: 'juror-01', stage: 'jury_deliberation', proceedingPhase: 'deliberation_challenges', ballotRound: null, leaning: 'defence' as const, choice: 'not_guilty', confidence: 70 }
async function review(text: string, options: { explanation?: string; wrongPeer?: boolean; extraFailure?: boolean; repeat?: boolean; request?: Partial<StageRequest> } = {}) {
  const sent: string[] = []
  const result = normalizeStageResult(JSON.stringify({ title: 'View', content: text, citations: [], jurors: [{ juror: 'juror-01', leaning: 'defence', confidence: 70, rationale: options.extraFailure ? 'Avery received the money.' : 'I retain doubt.', citations: [], mindChangedBecause: '', beliefTrail: [], deliberationRounds: [], consistencyWarnings: [] }] }), request.stage, [])
  const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[1].content; sent.push(prompt)
    const units = JSON.parse(prompt.split('Draft units to check:\n')[1]) as GroundingUnit[]
    const reject = sent.length === 1 || options.repeat
    return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id,
      status: unit.id === 'content:1' && reject || unit.id.startsWith('juror-') && options.extraFailure ? 'unsupported' : 'analysis',
      explanation: unit.id === 'content:1' ? options.explanation ?? 'The record does not establish that the peer actually reinforced this position as an internal influence event.' : options.extraFailure ? 'The receipt is unsupported.' : 'Current opinion.',
      citations: [], recordCitations: unit.id === 'content:1' ? [options.wrongPeer && reject ? 'peer-02' : 'peer-04'] : [],
    })) }) } }] })
  })
  return { result: await client.reviewGrounding({ ...request, ...options.request }, result), sent }
}

describe('compound present influence and initial stability', () => {
  it.each(texts)('requests a new same-draft review of internal-influence scope: %s', async text => {
    const r = await review(text)
    expect(r.result.status).toBe('passed')
    expect(r.sent).toHaveLength(2)
    expect(r.sent[1]).toContain('checker current-influence scope mismatch')
    expect(r.sent.every(prompt => prompt.includes(text))).toBe(true)
  })
  it.each(['initial', 'stable', 'unchanged'])('requires matching usable own history for %s', adjective => {
    const parsed = jurorInfluenceStatement(texts[0].replace('my position', `my ${adjective} position`))
    expect(parsed).toBeDefined()
    expect(matchingJurorInfluence(parsed, current, { actorId: current.actorId, assessments: [initial] })).toBe(true)
    for (const assessments of [[], [{ ...initial, choice: 'guilty' }], [{ ...initial, usable: false }], [initial, initial]]) {
      expect(matchingJurorInfluence(parsed, current, { actorId: current.actorId, assessments })).toBe(false)
    }
  })
  it.each(['previously reinforced', 'earlier reinforced', 'initially reinforced'])('does not reinterpret %s as present explanation', async wording => {
    const r = await review(texts[0].replace('reinforced', wording))
    expect(r.result.status).toBe('failed'); expect(r.sent).toHaveLength(1)
  })
  it('preserves an inconsistent initial choice', async () => {
    const r = await review(texts[1], { request: { courtroomAssessments: [{ ...initial, choice: 'guilty' }] } })
    expect(r.result.status).toBe('failed'); expect(r.sent).toHaveLength(1)
  })
  it('preserves a repeated rejection', async () => {
    const r = await review(texts[0], { repeat: true })
    expect(r.result.status).toBe('failed'); expect(r.sent).toHaveLength(2)
  })
  it('repairs an already rejected wrong peer selector on the same draft', async () => {
    const r = await review(texts[0], { wrongPeer: true })
    expect(r.result.status).toBe('passed'); expect(r.sent).toHaveLength(2)
    expect(r.sent[1]).toContain('peer reference')
    expect(r.result.findings.find(f => f.unitId === 'content:1')?.recordCitations?.[0].actorId).toBe('juror-04')
  })
  it.each([false, true])('retains a separate factual failure (wrong selector=%s)', async wrongPeer => {
    const r = await review(texts[0], { wrongPeer, extraFailure: true })
    expect(r.result.status).toBe('failed'); expect(r.sent).toHaveLength(1)
  })
})

describe('qualified peer-evidence negation', () => {
  const explanation = 'The peer discusses unresolved knowledge, but the record does not support that juror-04 supplied no new evidence.'
  it.each(texts)('rechecks a denial whose resolving qualifier was dropped: %s', async text => {
    const r = await review(text, { explanation })
    expect(r.result.status).toBe('passed'); expect(r.sent).toHaveLength(2)
    expect(r.sent[1]).toContain('checker peer-negation mismatch')
    expect(r.sent[1]).toContain('resolving')
  })
  it.each([
    'Juror-04’s documentary point reinforced my position but supplied no new evidence.',
    'Juror-04’s documentary point reinforced my position because Avery received money.',
  ])('does not narrow an actual blanket absence or factual assertion: %s', async text => {
    const r = await review(text, { explanation })
    expect(r.result.status).toBe('failed'); expect(r.sent).toHaveLength(1)
  })
  it('retains a substantive rejection of the complete qualifier', async () => {
    const r = await review(texts[0], { explanation: 'Juror-04 expressly supplied new evidence resolving knowledge, contrary to this denial.' })
    expect(r.result.status).toBe('failed'); expect(r.sent).toHaveLength(1)
  })
})
