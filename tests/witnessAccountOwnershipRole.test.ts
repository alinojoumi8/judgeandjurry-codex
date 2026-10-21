import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v150-calibration-full-control-v149-matching-name-defence-account-negative.json', 'utf8'))
const capturedRaw = JSON.parse(readFileSync('docs/qa/jury/v150-wrong-role-own-account-checker-raw.json', 'utf8')).checkerContent
const request = capture.request as StageRequest
const draft = capture.result
const config = { provider: 'minimax' as const, apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }

function check(q: StageRequest = request, status = 'supported', content = draft.content) {
  const units = groundingUnits({ ...draft, content })
  const raw = JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'The matching witness name owns this account.', citations: status === 'supported' ? [{ exhibitId: 'E-101', paragraph: 1 }] : [] })) })
  return parseGroundingReview(raw, units, q.evidence, q.groundingContext, undefined, {
    packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [],
    partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage,
  }).status
}

describe('first-person approved witness account ownership', () => {
  it('rejects the exact live wrong-role acceptance through production', async () => {
    const client = new MiniMaxClient(config, undefined, async () => Response.json({ choices: [{ message: { content: capturedRaw } }] }))
    expect((await client.reviewGrounding(request, draft)).status).toBe('failed')
  })
  it.each(['supported', 'analysis', 'unsupported', 'contradicted'])('does not let %s confer ownership on matching-name Defence', status => {
    expect(check(request, status)).toBe('failed')
  })
  it.each(['crown', 'juror', 'foreperson', 'judge', 'accused'])('rejects ownership by a matching-name %s', role => {
    expect(check({ ...request, courtroomActor: { ...request.courtroomActor!, roles: [role] } })).toBe('failed')
  })
  it('accepts the actual named witness even with a legacy Defence stage', () => {
    expect(check({ ...request, courtroomActor: { ...request.courtroomActor!, roles: ['witness'] } })).toBe('passed')
  })
  it('rejects a differently named witness', () => {
    expect(check({ ...request, courtroomActor: { ...request.courtroomActor!, name: 'Fictional Nira', roles: ['witness'] } })).toBe('failed')
  })
  it('rejects missing identity and missing permission', () => {
    expect(check({ ...request, courtroomActor: undefined })).toBe('failed')
    expect(check({ ...request, courtroomActor: { ...request.courtroomActor!, roles: ['witness'] }, groundingContext: '' })).toBe('failed')
  })
  it('accepts a renamed source, permission and actual witness together', () => {
    const renamed = JSON.parse(JSON.stringify(request).replaceAll('Mira', 'Nira')) as StageRequest
    renamed.courtroomActor!.roles = ['witness']
    expect(check(renamed)).toBe('passed')
  })
  it('keeps an accurate third-person Defence attribution permitted', () => {
    expect(check(request, 'supported', "Mira's approved account records the sealed handover and unknown contents.")).toBe('passed')
  })
  it('does not confer source ownership through an invented role in the text', () => {
    expect(check(request, 'supported', 'As the witness, ' + draft.content)).toBe('failed')
  })
  it('rejects source ownership when the matching actor has only an empty role list', () => {
    expect(check({ ...request, courtroomActor: { ...request.courtroomActor!, roles: [] } })).toBe('failed')
  })
})
