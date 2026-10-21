import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import type { StageRequest } from '../server/minimax'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v129-contents-statement-control-capture.json', import.meta.url), 'utf8'))
const request = capture.control.request as StageRequest
function check(q = request, content = capture.control.draft.content, status = 'unsupported') {
  const units = groundingUnits({ ...capture.control.draft, content })
  const setup = { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage, actor: q.courtroomActor }
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'The checker incorrectly inferred Defence identity from the stage label.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined, setup).status
}

describe('current actor identity controls an own-account attribution', () => {
  it.each(['unsupported', 'contradicted'])('preserves the captured actual witness statement despite %s', status => {
    expect(check(request, undefined, status)).toBe('passed')
  })
  it('binds renamed actual witness and source', () => {
    const renamed = JSON.parse(JSON.stringify(request).replaceAll('Mira', 'Nira')) as StageRequest
    expect(check(renamed)).toBe('passed')
  })
  it('passes the actual actor identity through the production checker client', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional-key', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [{ unitId: 'content:1', status: 'unsupported', explanation: 'The stage label suggests Defence.', citations: [] }] }) } }] }))
    const review = await client.reviewGrounding(request, capture.control.draft)
    expect(review.status).toBe('passed')
  })
  it('does not assign the source to a different actual witness', () => {
    expect(check({ ...request, courtroomActor: { ...request.courtroomActor!, name: 'Fictional Nira' } })).toBe('failed')
    expect(check({ ...request, courtroomActor: { ...request.courtroomActor!, name: 'Fictional Nira' } }, undefined, 'analysis')).toBe('failed')
  })
  it('requires witness role despite a matching name', () => {
    expect(check({ ...request, courtroomActor: { ...request.courtroomActor!, roles: ['defence'] } })).toBe('failed')
    expect(check({ ...request, courtroomActor: { ...request.courtroomActor!, roles: ['defence'] } }, undefined, 'analysis')).toBe('failed')
  })
  it('requires an actual actor name, own unknown-contents source, and its permission', () => {
    expect(check({ ...request, courtroomActor: { id: 'w1', name: '', roles: ['witness'] } })).toBe('failed')
    expect(check({ ...request, evidence: [] })).toBe('failed')
    expect(check({ ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text.replace('I do not know what the envelope contained.', 'The envelope contained cash.') })) })).toBe('failed')
    expect(check({ ...request, groundingContext: request.groundingContext!.replace('Mira', 'Nira') })).toBe('failed')
    expect(check({ ...request, evidence: [] }, undefined, 'analysis')).toBe('failed')
    expect(check({ ...request, groundingContext: request.groundingContext!.replace('Mira', 'Nira') }, undefined, 'analysis')).toBe('failed')
  })
  it('does not clear added claims or broaden unknown contents to all knowledge', () => {
    expect(check(request, capture.control.draft.content + ' Ellis knowingly received cash.')).toBe('failed')
    expect(check(request, 'My approved account states I know nothing about the handover.')).toBe('failed')
  })
})
