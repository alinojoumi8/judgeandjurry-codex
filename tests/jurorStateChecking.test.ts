import { describe, expect, it } from 'vitest'
import { MiniMaxClient, normalizeStageResult, type StageRequest } from '../server/minimax'
import type { GroundingUnit } from '../server/grounding'

const initial = { issueId: 'issue-1', round: 'initial', choice: 'not_guilty', confidence: 60, rationale: 'I retain doubt.', usable: true }
const request: StageRequest = { stage: 'jury_deliberation', packet: 'Current discussion', previousTurns: '', evidence: [], courtroomProtocol: false,
  courtroomActor: { id: 'juror-01', name: 'Juror 1', roles: ['juror'] }, courtroomEvents: [], courtroomAssessments: [initial],
  verdictOutcomes: ['guilty', 'not_guilty', 'no_verdict'],
}
function harness(statement: string, correction = true, extraFailure = false, firstStatus = 'unsupported', explanation = 'No current ballot is supplied to establish that this assessment remains stable; no earlier own assessment is established outside the supplied history.') {
  const sent: Array<{ messages: Array<{ content: string }> }> = []
  const result = normalizeStageResult(JSON.stringify({ title: 'Current assessment', content: statement, citations: [], jurors: [{ juror: 'juror-01', leaning: 'defence', confidence: 60, rationale: 'I assess the supplied record.', citations: [], beliefTrail: [], deliberationRounds: [], mindChangedBecause: '', consistencyWarnings: [] }] }), request.stage, [])
  const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); sent.push(body)
    const units = JSON.parse(body.messages[1].content.split('Draft units to check:\n')[1]) as GroundingUnit[]
    return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id,
      status: extraFailure && unit.id.startsWith('juror-0:') ? 'unsupported' : unit.id === 'content:1' && (!correction || sent.length === 1) ? firstStatus : 'analysis',
      explanation: unit.id === 'content:1' ? explanation : extraFailure && unit.id.startsWith('juror-0:') ? 'A separate substantive source failure.' : 'Current analysis.', citations: [],
    })) }) } }] })
  })
  return { client, sent, result }
}

describe('juror current-state checking', () => {
  it('supplies the current candidate position separately from saved prior assessments', async () => {
    const h = harness('My initial not-guilty assessment remains stable.')
    await h.client.reviewGrounding(request, h.result)
    const prompt = h.sent[0].messages[1].content
    expect(prompt).toContain('Current juror draft assessment (unverified candidate, not a saved prior ballot)')
    expect(prompt).toContain('"leaning":"defence"')
    expect(prompt).toContain('"choice":"not_guilty"')
  })

  it('rechecks a current-state/history mismatch on the same unchanged draft', async () => {
    const h = harness('My initial not-guilty assessment remains stable.')
    const result = await h.client.reviewGrounding(request, h.result)
    expect(result.status).toBe('passed')
    expect(result.verificationRetries).toBe(1)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].messages[1].content).toContain('checker current-juror-state mismatch')
    expect(h.sent.every(body => body.messages[1].content.includes(h.result.content))).toBe(true)
  })

  it('recognizes initial no-change metadata with explicitly empty history in the legacy workflow', async () => {
    const h = harness('No earlier own assessment exists for comparison, so this ballot does not record a change.')
    expect((await h.client.reviewGrounding({ ...request, stage: 'juror_ballot', ballotRound: 'initial', courtroomAssessments: [] }, h.result)).status).toBe('passed')
    expect(h.sent).toHaveLength(2)
  })

  it('keeps a repeated rejection failed at the unchanged retry limit', async () => {
    const h = harness('My initial not-guilty assessment remains stable.', false)
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(2)
  })

  it.each([
    { name: 'contrary prior choice', change: { courtroomAssessments: [{ ...initial, choice: 'guilty' }] } },
    { name: 'unusable prior ballot', change: { courtroomAssessments: [{ ...initial, usable: false }] } },
    { name: 'omitted history', change: { courtroomAssessments: undefined } },
    { name: 'a different actor', change: { courtroomActor: { id: 'juror-02', name: 'Juror 2', roles: ['juror'] } } },
  ])('does not reclassify an unsupported comparison with $name', async ({ change }) => {
    const h = harness('My initial not-guilty assessment remains stable.')
    expect((await h.client.reviewGrounding({ ...request, ...change }, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })

  it('does not repair a stability claim when the current choice changed', async () => {
    const h = harness('My initial not-guilty assessment remains stable.')
    h.result.jurors![0].leaning = 'crown'
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })

  it('does not clear source assertions mixed into a state statement', async () => {
    const h = harness('My initial not-guilty assessment remains stable because the witness fabricated evidence.')
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })

  it('keeps a separate substantive failure withheld', async () => {
    const h = harness('My initial not-guilty assessment remains stable.', true, true)
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })

  it('does not demand an exhibit for a supported pure state declaration', async () => {
    const h = harness('My initial not-guilty assessment remains stable.', false, false, 'supported')
    expect((await h.client.reviewGrounding(request, h.result)).status).toBe('passed')
    expect(h.sent).toHaveLength(1)
  })

  it('checks the current final review separately from a formally saved final ballot', async () => {
    const h = harness('My final element review remains unchanged.', true, false, 'unsupported', 'No final element review is supplied and the current ballot is not marked final.')
    expect((await h.client.reviewGrounding({ ...request, proceedingPhase: 'deliberation_review' }, h.result)).status).toBe('passed')
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0].messages[1].content).toContain('deliberation_review')
  })

  it.each(['deliberation_inventory', 'deliberation_challenges', undefined])('does not invent a final review phase in %s', async proceedingPhase => {
    const h = harness('My final element review remains unchanged.')
    expect((await h.client.reviewGrounding({ ...request, proceedingPhase }, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })

  it('does not treat a prior final ballot claim as the current review', async () => {
    const h = harness('My final ballot remains unchanged.')
    expect((await h.client.reviewGrounding({ ...request, proceedingPhase: 'deliberation_review' }, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })

  it('gets the current choice vocabulary from the actual projected exercise instruction', async () => {
    const h = harness('My initial not-guilty assessment remains stable.', false, false, 'supported')
    const exercise = { eventId: 'instruction', type: 'judicial_instruction', payload: { text: 'Proposed exercise.', issueInstructions: [{ issueId: 'issue-1', outcomes: ['guilty', 'not_guilty', 'no_verdict'] }] } }
    expect((await h.client.reviewGrounding({ ...request, verdictOutcomes: undefined, courtroomEvents: [exercise] }, h.result)).status).toBe('passed')
  })

  it('still rejects admission claims mixed into current-state metadata', async () => {
    const h = harness('My initial assessment remains stable because no admitted evidence resolved the issue.')
    expect((await h.client.reviewGrounding({ ...request, proceedingPhase: 'deliberation_review' }, h.result)).status).toBe('failed')
    expect(h.sent).toHaveLength(1)
  })
})
