import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const captures = ['no-incompatible-timing-credit', 'timing-gap-credit'].map(name =>
  JSON.parse(readFileSync(`docs/qa/jury/v162-captured-${name}.json`, 'utf8')))

function check(c: any, value = c.result, whole = false) {
  const q = c.request as StageRequest
  const units = whole ? ballotConsistencyUnits(value) : groundingUnits(value)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({
    unitId: unit.id, status: 'analysis', explanation: 'Current source assessment.', citations: [], recordCitations: [],
  })) }), units, q.evidence, q.groundingContext,
  { actorId: q.courtroomActor!.id, assessments: q.courtroomAssessments ?? [], profile: q.jurorProfiles?.[0] },
  { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles,
    partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}

function ballot(c: any, text: string) {
  const value = structuredClone(c.result)
  value.content = text
  value.jurors[0].rationale = text
  value.jurors[0].mindChangedBecause = 'This is my initial assessment.'
  return value
}

describe('unknown comparison timing is not a causal basis for proof-level account credit', () => {
  it.each(captures)('withholds the actual accepted fields from $id', c => {
    expect(check(c)).toBe('failed')
    expect(check(c, c.result, true)).toBe('failed')
  })
  it.each(captures)('replays the exact recorded checker response from $id', async c => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
    async () => Response.json({ choices: [{ message: { content: c.checkerContent } }] }))
    expect((await client.reviewGrounding(c.request, c.result)).status).toBe('failed')
  })
  it.each(['so', 'therefore', 'thus', 'hence'])('checks the explicit proof-credit consequence with %s', marker => {
    const c = captures[1]
    const value = ballot(c, `Their timing is unspecified, ${marker} I credit Mira beyond reasonable doubt.`)
    expect(check(c, value)).toBe('failed')
    expect(check(c, value, true)).toBe('failed')
  })
  it.each([
    "I credit Mira beyond reasonable doubt because their timing is unspecified.",
    "I credit Mira's account beyond a reasonable doubt since no incompatible timing is supplied.",
  ])('checks the same causal dependency in reverse order: %s', text => {
    expect(check(captures[0], ballot(captures[0], text))).toBe('failed')
  })
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('checks the criterion independently in %s', field => {
    const c = captures[1], value = ballot(c, "I credit Mira's actual handover account after weighing it and find the Crown proved receipt beyond a reasonable doubt.")
    const text = c.result.jurors[0].rationale
    if (field === 'title' || field === 'content') value[field] = text
    else value.jurors[0][field] = text
    expect(check(c, value)).toBe('failed')
    expect(check(c, value, true)).toBe('failed')
  })
  it('binds renamed actual accounts rather than fixture names', () => {
    const c = JSON.parse(JSON.stringify(captures[1]).replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Savi')
      .replaceAll('Rowan', 'Orin').replaceAll('Ellis', 'Evan').replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732'))
    expect(check(c)).toBe('failed')
  })
  it.each([
    'Their timing is unspecified.',
    "Their timing is unspecified. I credit Mira's supplied account because it directly describes the giver, blue token, recipient and desk.",
    'It is incorrect to conclude their timing is unspecified, so I credit Mira beyond reasonable doubt.',
    'Their timing is unspecified; should I therefore credit Mira beyond reasonable doubt?',
    'Their timing is unspecified, so I do not credit Mira beyond reasonable doubt.',
  ])('preserves bounded comparison, independent source credit, correction, inquiry or doubt: %s', text => {
    const value = ballot(captures[0], text)
    if (text.includes('do not credit')) value.jurors[0].leaning = 'defence'
    expect(check(captures[0], value)).toBe('passed')
  })
})
