import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v166-captured-no-supplied-timing-cause.json', 'utf8'))
function review(text: string, whole = false, profile = capture.request.jurorProfiles[0]) {
  const q = capture.request, draft = structuredClone(capture.result)
  draft.title = ''
  draft.content = text
  draft.jurors[0].rationale = text
  draft.jurors[0].mindChangedBecause = 'This is my initial assessment.'
  const units = whole ? ballotConsistencyUnits(draft) : groundingUnits(draft)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Current source assessment.', citations: [], recordCitations: [] })) }),
    units, q.evidence, q.groundingContext, { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments, profile },
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles,
      actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}

describe('nominal negative timing remains scoped to its own predicate', () => {
  it('accepts the original recorded source-faithful draft and checker findings', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
    async () => Response.json({ choices: [{ message: { content: capture.checkerContent } }] }))
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('passed')
  })
  it.each([
    'No supplied timing makes those accounts incompatible.',
    'No provided timing renders the accounts mutually incompatible.',
    'No recorded timing makes these accounts directly incompatible.',
  ])('preserves the bounded observation: %s', text => {
    expect(review(text)).toBe('passed')
    expect(review(text, true)).toBe('passed')
  })
  it.each(['but', 'and', 'while'])('still withholds a separate adopted conflict after %s', join => {
    const text = `No supplied timing makes those accounts incompatible, ${join} those accounts are incompatible.`
    expect(review(text)).toBe('failed')
  })
  it.each([
    'No supplied timing makes those accounts incompatible, so I credit E-001 beyond a reasonable doubt.',
    'No supplied timing makes those accounts incompatible, so the Crown proved receipt beyond a reasonable doubt.',
  ])('does not convert bounded non-contradiction into proof: %s', text => {
    expect(review(text)).toBe('failed')
    expect(review(text, true)).toBe('failed')
  })
  it('retains the actual final checker rejection of a conflict overstatement', async () => {
    const c = JSON.parse(readFileSync('docs/qa/jury/v166-captured-unqualified-conflict.json', 'utf8'))
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
    async () => Response.json({ choices: [{ message: { content: c.checkerContent } }] }))
    expect((await client.reviewGrounding(c.request, c.result)).status).toBe('failed')
  })
  it('withholds a hyphenated high-trait claim against the actual low profile', () => {
    expect(review('My high-skepticism approach informs my current assessment.')).toBe('failed')
  })
  it('withholds a hyphenated low-burden claim against a high profile', () => {
    expect(review('My low-burden-sensitivity approach informs my current assessment.', false,
      { ...capture.request.jurorProfiles[0], burdenSensitivity: 81 })).toBe('failed')
  })
  it('preserves a matching low trait', () => {
    expect(review('My low-skepticism approach informs my current assessment.')).toBe('passed')
  })
})
