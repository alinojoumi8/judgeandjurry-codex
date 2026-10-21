import { describe, expect, it } from 'vitest'
import { MiniMaxClient, normalizeStageResult, type StageRequest } from '../server/minimax'
import type { GroundingUnit } from '../server/grounding'

const initial = { issueId: 'issue-1', round: 'initial', choice: 'not_guilty', confidence: 60, rationale: 'I retain doubt.', usable: true }
const peer = { eventId: 'peer-04', type: 'juror_deliberation_turn', actorId: 'juror-04', payload: { contribution: 'Knowledge and matched deprivation remain unresolved. Concrete authorized proof could change my position.' } }
const request: StageRequest = { stage: 'jury_deliberation', proceedingPhase: 'deliberation_challenges', packet: 'Current discussion', previousTurns: '', evidence: [], courtroomProtocol: false,
  courtroomActor: { id: 'juror-01', name: 'Juror 1', roles: ['juror'] }, courtroomEvents: [peer], courtroomAssessments: [initial], verdictOutcomes: ['guilty', 'not_guilty', 'no_verdict'] }
const negative = 'My initial not-guilty position remains stable because juror-04 identified no new concrete proof resolving knowledge or matched deprivation.'
const negativeExplanation = 'The current position is unchanged, but juror-04 did not identify any new concrete proof. The peer instead retained doubt.'
const noHistory = 'No prior ballot exists, so this is my initial independent assessment.'
const historyExplanation = 'The supplied initial round and empty own history do not establish that no prior ballot ever existed.'
function harness(text: string, explanation: string, options: { repeat?: boolean; extraFailure?: boolean; references?: string[]; status?: string } = {}) {
  const sent: Array<{ messages: Array<{ content: string }> }> = []
  const result = normalizeStageResult(JSON.stringify({ title: 'Assessment', content: text, citations: [], jurors: [{ juror: 'juror-01', leaning: 'defence', confidence: 60, rationale: options.extraFailure ? 'The witness fabricated a receipt.' : 'I retain doubt.', citations: [], beliefTrail: [], deliberationRounds: [], mindChangedBecause: '', consistencyWarnings: [] }] }), request.stage, [])
  const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); sent.push(body)
    const units = JSON.parse(body.messages[1].content.split('Draft units to check:\n')[1]) as GroundingUnit[]
    return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id,
      status: options.extraFailure && unit.id.startsWith('juror-0:') ? 'unsupported' : unit.id === 'content:1' && (sent.length === 1 || options.repeat) ? options.status ?? 'contradicted' : 'analysis',
      explanation: unit.id === 'content:1' ? explanation : options.extraFailure ? 'Unrelated unsupported source premise.' : 'Current opinion.', citations: [],
      recordCitations: unit.id === 'content:1' && /juror-04/.test(text) ? (options.references ?? ['peer-04']).map(eventId => ({ eventId })) : [],
    })) }) } }] })
  })
  return { client, result, sent }
}

describe('bounded history scope review', () => {
  const first: StageRequest = { ...request, stage: 'juror_ballot', ballotRound: 'initial', courtroomAssessments: [], courtroomEvents: [] }
  it('rechecks a pure initial history statement against the current run', async () => {
    const h = harness(noHistory, historyExplanation)
    const review = await h.client.reviewGrounding(first, h.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].messages[1].content).toContain('checker current-juror-state mismatch')
    expect(h.sent.every(body => body.messages[1].content.includes(noHistory))).toBe(true)
  })
  it.each([
    { name: 'recorded own ballot', change: { courtroomAssessments: [initial] } },
    { name: 'missing own history', change: { courtroomAssessments: undefined } },
    { name: 'final round', change: { ballotRound: 'final' as const } },
    { name: 'different author', change: { courtroomActor: { id: 'juror-02', name: 'Juror 2', roles: ['juror'] } } },
  ])('retains a rejection with $name', async ({ change }) => {
    const h = harness(noHistory, historyExplanation)
    expect((await h.client.reviewGrounding({ ...first, ...change }, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })
  it('does not turn an explicit global claim into run metadata', async () => {
    const h = harness('No prior ballot ever existed anywhere, so this is my initial independent assessment.', historyExplanation)
    expect((await h.client.reviewGrounding(first, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })
  it('requires a successful new finding within the existing limit', async () => {
    const h = harness(noHistory, historyExplanation, { repeat: true })
    expect((await h.client.reviewGrounding(first, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(2)
  })
  it('rejects false history even if the first checker labels it analysis', async () => {
    const h = harness(noHistory, 'Current opinion.', { status: 'analysis' })
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
  })
  it('does not substitute empty history when the caller omitted it', async () => {
    const h = harness(noHistory, 'Current opinion.', { status: 'analysis' })
    expect((await h.client.reviewGrounding({ ...first, courtroomAssessments: undefined }, h.result)).status).toBe('failed')
  })
})

describe('peer proof negation review', () => {
  it('rechecks a rejection that repeats the same negative proposition', async () => {
    const h = harness(negative, negativeExplanation)
    const review = await h.client.reviewGrounding(request, h.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].messages[1].content).toContain('checker peer-negation mismatch')
    expect(h.sent.every(body => body.messages[1].content.includes(negative))).toBe(true)
  })
  it('does not approve a repeated rejection', async () => {
    const h = harness(negative, negativeExplanation, { repeat: true })
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(2)
  })
  it.each([
    'The peer did identify concrete proof resolving knowledge.',
    'Juror-05 did not identify any new concrete proof.',
    'The peer discusses knowledge but the draft adds a new causation premise.',
  ])('preserves a different substantive rejection: %s', async explanation => {
    const h = harness(negative, explanation)
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })
  it.each([
    { name: 'unusable own history', change: { courtroomAssessments: [{ ...initial, usable: false }] } },
    { name: 'changed choice', change: { courtroomAssessments: [{ ...initial, choice: 'guilty' }] } },
    { name: 'withheld peer', change: { courtroomEvents: [{ ...peer, payload: { ...peer.payload, withheld: true } }] } },
    { name: 'missing peer', change: { courtroomEvents: [] } },
  ])('cannot repair $name', async ({ change }) => {
    const h = harness(negative, negativeExplanation)
    expect((await h.client.reviewGrounding({ ...request, ...change }, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })
  it('does not override another failed source unit', async () => {
    const h = harness(negative, negativeExplanation, { extraFailure: true })
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })
  it('rechecks every qualifier, retaining an unsupported added cause on review', async () => {
    const h = harness(negative.replace('or matched deprivation', ', matched deprivation, or causation'), negativeExplanation, { repeat: true })
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].messages[1].content).toContain('each added premise')
  })
})
