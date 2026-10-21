import { describe, expect, it } from 'vitest'
import { MiniMaxClient, normalizeStageResult, type StageRequest } from '../server/minimax'
import type { GroundingUnit } from '../server/grounding'

const peer = { eventId: 'peer-04', type: 'juror_deliberation_turn', actorId: 'juror-04', payload: { contribution: 'My classification concern leaves knowledge and matched loss unresolved.' } }
const other = { ...peer, eventId: 'peer-02', actorId: 'juror-02', payload: { contribution: 'I focus on the order of presentation.' } }
const initial = { issueId: 'issue-1', round: 'initial', choice: 'not_guilty', confidence: 60, rationale: 'I retain doubt.', usable: true }
const request: StageRequest = { stage: 'jury_deliberation', proceedingPhase: 'deliberation_challenges', packet: 'Current discussion', previousTurns: '', evidence: [], courtroomProtocol: false,
  courtroomActor: { id: 'juror-01', name: 'Juror 1', roles: ['juror'] }, courtroomEvents: [other, peer], courtroomAssessments: [initial], verdictOutcomes: ['guilty', 'not_guilty', 'no_verdict'] }
const influence = 'Juror-04’s classification concern reinforced my position without resolving matched loss or knowledge.'
const influenceError = 'The peer concern is visible, but the record does not establish that it actually reinforced the author’s position as a historical event.'
function harness(text: string, options: { mode?: 'peer' | 'influence'; repeat?: boolean; extraFailure?: boolean; explanation?: string; rejectRepair?: boolean } = {}) {
  const sent: Array<{ messages: Array<{ content: string }> }> = []
  const result = normalizeStageResult(JSON.stringify({ title: 'Assessment', content: text, citations: [], jurors: [{ juror: 'juror-01', leaning: 'defence', confidence: 60, rationale: options.extraFailure ? 'The witness fabricated a receipt.' : 'I retain doubt.', citations: [], mindChangedBecause: '', beliefTrail: [], deliberationRounds: [], consistencyWarnings: [] }] }), request.stage, [])
  const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); sent.push(body)
    const units = JSON.parse(body.messages[1].content.split('Draft units to check:\n')[1]) as GroundingUnit[]
    const first = sent.length === 1 || options.repeat
    return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id,
      status: unit.id === 'content:1' ? (options.mode === 'influence' && first || options.rejectRepair && !first ? 'unsupported' : 'supported') : options.extraFailure ? 'unsupported' : 'analysis',
      explanation: unit.id === 'content:1' ? options.mode === 'influence' && first ? options.explanation ?? influenceError : 'Check the actual peer premise.' : options.extraFailure ? 'An unsupported source claim.' : 'Current opinion.',
      citations: [], recordCitations: unit.id === 'content:1' ? [{ eventId: options.mode !== 'influence' && first ? 'peer-02' : 'peer-04' }] : [],
    })) }) } }] })
  })
  return { client, result, sent }
}

describe('bounded peer selector review', () => {
  const text = 'I agree with juror-04 that the accounting materials do not resolve matched loss or subjective knowledge.'
  it('rechecks the same draft and persists the checker-selected actual peer', async () => {
    const h = harness(text)
    const review = await h.client.reviewGrounding(request, h.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].messages[1].content).toContain('peer reference')
    expect(h.sent.every(body => body.messages[1].content.includes(text))).toBe(true)
    expect(review.findings.find(finding => finding.unitId === 'content:1')?.recordCitations).toEqual([{ eventId: 'peer-04', actorId: 'juror-04', quote: peer.payload.contribution }])
  })
  it.each([{ repeat: true }, { rejectRepair: true }])('does not auto-accept a failed repair: %j', async options => {
    const h = harness(text, options)
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(2)
  })
  it('does not retry an absent named peer', async () => {
    const h = harness(text)
    expect((await h.client.reviewGrounding({ ...request, courtroomEvents: [other] }, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })
  it('preserves an unrelated rejected source claim', async () => {
    const h = harness(text, { extraFailure: true })
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })
})

describe('bounded current-influence scope review', () => {
  it('rechecks an internal-history objection against the actual peer and unchanged choice', async () => {
    const h = harness(influence, { mode: 'influence' })
    const review = await h.client.reviewGrounding(request, h.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].messages[1].content).toContain('checker current-influence scope mismatch')
    expect(h.sent.every(body => body.messages[1].content.includes(influence))).toBe(true)
  })
  it.each([{ repeat: true }, { rejectRepair: true }])('requires a successful new meaning judgment: %j', async options => {
    const h = harness(influence, { mode: 'influence', ...options })
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(2)
  })
  it.each([{ courtroomAssessments: [] }, { courtroomAssessments: [{ ...initial, choice: 'guilty' }] }])('reviews current influence without adding a stability claim: %j', async ({ courtroomAssessments }) => {
    const h = harness(influence, { mode: 'influence' })
    const review = await h.client.reviewGrounding({ ...request, courtroomAssessments }, h.result)
    expect(review.status).toBe('passed')
    expect(h.sent).toHaveLength(2)
  })
  it.each([
    { name: 'changed choice', change: { courtroomAssessments: [{ ...initial, choice: 'guilty' }] } },
    { name: 'unknown history', change: { courtroomAssessments: undefined } },
    { name: 'unusable history', change: { courtroomAssessments: [{ ...initial, usable: false }] } },
    { name: 'withheld peer', change: { courtroomEvents: [{ ...peer, payload: { ...peer.payload, withheld: true } }] } },
    { name: 'wrong author', change: { courtroomActor: { id: 'juror-02', name: 'Juror 2', roles: ['juror'] } } },
  ])('does not review away $name', async ({ change }) => {
    const h = harness(influence.replace('my position', 'my stable position'), { mode: 'influence' })
    expect((await h.client.reviewGrounding({ ...request, ...change }, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })
  it.each([
    'The cited peer never raised the classification concern.',
    'The draft invents the witness admission and adds an unsupported knowledge premise.',
  ])('preserves a substantive meaning rejection: %s', async explanation => {
    const h = harness(influence, { mode: 'influence', explanation })
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })
  it('retains a separate failure in the same output', async () => {
    const h = harness(influence, { mode: 'influence', extraFailure: true })
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })
  it('does not reinterpret an express prior-round influence claim as current', async () => {
    const h = harness(influence.replace('reinforced', 'previously reinforced'), { mode: 'influence' })
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })
})
