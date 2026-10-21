import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v136-planned-crown-account-capture.json', import.meta.url), 'utf8'))
const preview = 'It will present the planned account within its attribution-only use limit.'
function check(request = structuredClone(capture.request), content = capture.result.content, previewStatus = 'unsupported', legacyActor = false) {
  const units = groundingUnits({ ...capture.result, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: unit.text === preview ? previewStatus : 'analysis', explanation: 'Captured actor-specific preview review.', citations: [] })) }), units, request.evidence, request.groundingContext, undefined,
    { packet: request.packet, events: request.courtroomEvents ?? [], actorRoles: request.courtroomActor.roles, partyRoles: request.approvedPartyRoles, actor: legacyActor ? undefined : request.courtroomActor, stage: request.stage }).status
}
describe('Crown previews its actually planned attributed witness account', () => {
  it('preserves the actual bounded preview via the planned witness', () => expect(check()).toBe('passed'))
  it('does not depend on a fixed witness name', () => {
    const q = JSON.parse(JSON.stringify(capture.request).replaceAll('Mira', 'Lena'))
    expect(check(q)).toBe('passed')
  })
  it.each(['plan', 'permission', 'source', 'actor', 'antecedent', 'stage'] as const)('does not supply a missing %s', missing => {
    const q = structuredClone(capture.request)
    let content = capture.result.content
    if (missing === 'plan') q.packet = q.packet.split('\n').filter((line: string) => !line.startsWith('Approved evidence plan:')).join('\n')
    if (missing === 'permission') q.groundingContext = 'E-101: excluded; no preview permitted.'
    if (missing === 'source') q.evidence = []
    if (missing === 'actor') q.courtroomActor = { id: 'defence', roles: ['defence'] }
    if (missing === 'antecedent') content = preview
    if (missing === 'stage') q.stage = 'witness_answer'
    expect(check(q, content)).toBe('failed')
  })
  it('does not confuse another planned account with the actual permitted source', () => {
    const q = structuredClone(capture.request); q.packet = q.packet.replace("Mira will present her attributed account in E-101", "Tavi will present their attributed account in E-102")
    expect(check(q)).toBe('failed')
  })
  it('preserves the legacy audit API when its actual Crown role, stage, plan, source and permission are supplied', () => expect(check(undefined, undefined, 'analysis', true)).toBe('passed'))
  it.each(['plan', 'permission', 'source', 'actor', 'antecedent', 'stage'] as const)('does not accept a missing %s merely because the model labels it analysis', missing => {
    const q = structuredClone(capture.request); let content = capture.result.content
    if (missing === 'plan') q.packet = q.packet.split('\n').filter((line: string) => !line.startsWith('Approved evidence plan:')).join('\n')
    if (missing === 'permission') q.groundingContext = 'E-101: excluded; no preview permitted.'
    if (missing === 'source') q.evidence = []
    if (missing === 'actor') q.courtroomActor = { id: 'defence', roles: ['defence'] }
    if (missing === 'antecedent') content = preview
    if (missing === 'stage') q.stage = 'witness_answer'
    expect(check(q, content, 'analysis')).toBe('failed')
  })
})
