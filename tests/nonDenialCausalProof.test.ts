import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v161-captured-non-denial-proof.json', 'utf8'))
const request = capture.request as StageRequest
const shortcut = capture.result.content as string
const checker = JSON.parse(readFileSync('docs/qa/jury/v161-non-denial-checker-capture.json', 'utf8'))
const nonObservation = JSON.parse(readFileSync('docs/qa/jury/v161-captured-non-observation-proof.json', 'utf8'))
const result = (content = shortcut) => ({ ...structuredClone(capture.result), content })

function check(value = result(), q = request, whole = false) {
  const units = whole ? ballotConsistencyUnits(value) : groundingUnits(value)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({
    unitId: unit.id, status: 'analysis', explanation: 'Current assessment of permitted accounts.', citations: [], recordCitations: [],
  })) }), units, q.evidence, q.groundingContext,
  { actorId: q.courtroomActor!.id, assessments: q.courtroomAssessments ?? [] },
  { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles,
    partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}

describe('a preceding credited account does not cure an explicit non-denial-to-proof inference', () => {
  it('withholds the second captured limited-non-observation proof consequence', () => {
    expect(check(nonObservation.result, nonObservation.request)).toBe('failed')
    expect(check(nonObservation.result, nonObservation.request, true)).toBe('failed')
  })
  it('replays the second exact checker response through the production path', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
    async () => Response.json({ choices: [{ message: { content: nonObservation.checkerContent } }] }))
    expect((await client.reviewGrounding(nonObservation.request, nonObservation.result)).status).toBe('failed')
  })
  it.each(['so', 'therefore', 'thus'])('rejects non-observation as the explicit proof cause with %s', marker => {
    const value = structuredClone(nonObservation.result)
    value.content = value.content.replace('so I find', `${marker} I find`)
    expect(check(value, nonObservation.request)).toBe('failed')
    expect(check(value, nonObservation.request, true)).toBe('failed')
  })
  it('withholds the newly captured accepted response through the real checker parser', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
    async () => Response.json({ choices: [{ message: { content: checker.checkerContent } }] }))
    expect((await client.reviewGrounding(request, capture.result)).status).toBe('failed')
  })
  it('rejects the exact current field under an analysis finding', () => expect(check()).toBe('failed'))
  it('checks the exact complete ballot', () => expect(check(result(), request, true)).toBe('failed'))
  it.each(['so', 'therefore', 'thus', 'hence', 'consequently', 'accordingly'])('rejects the same explicit consequence with %s', marker => {
    const value = result(shortcut.replace('so my assessment', `${marker} my assessment`))
    expect(check(value)).toBe('failed')
    expect(check(value, request, true)).toBe('failed')
  })
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('checks the shortcut independently in %s', field => {
    const value = result("I credit Mira's supplied handover account after weighing it and find the Crown proved receipt beyond a reasonable doubt.")
    if (field === 'title' || field === 'content') value[field] = shortcut
    else value.jurors[0][field] = shortcut
    expect(check(value)).toBe('failed')
    expect(check(value, request, true)).toBe('failed')
  })
  it('binds renamed source and participant identities', () => {
    const rename = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Savi')
      .replaceAll('Rowan', 'Orin').replaceAll('Ellis', 'Evan').replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732'))
    expect(check(rename(result()), rename(request))).toBe('failed')
  })
  it.each([
    "I credit Mira's supplied handover account after weighing it and find the Crown proved receipt beyond a reasonable doubt.",
    "Tavi's non-observation does not establish receipt. I retain reasonable doubt whether the Crown proved receipt.",
    'It is incorrect to conclude that non-denial proves receipt beyond a reasonable doubt.',
    'Does non-denial establish receipt beyond a reasonable doubt?',
  ])('preserves a bounded independent assessment, doubt, correction or inquiry: %s', content => {
    const value = result(content)
    if (content.includes('retain reasonable doubt')) value.jurors[0].leaning = 'defence'
    expect(check(value)).toBe('passed')
  })
})
