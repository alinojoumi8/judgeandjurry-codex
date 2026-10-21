import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync('docs/qa/jury/v122-native-attribution-proof-grant-capture.json', 'utf8'))
const q = capture.request
function audit(content: string, permission = q.groundingContext, status = 'analysis') {
  const units = groundingUnits({ title: '', content, citations: ['E-001'] })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Source quotation is accurate.', citations: [{ exhibitId: 'E-001', paragraph: 1 }] })) }),
    units, q.evidence, permission, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}

describe('conditional proof use of an attribution-only account', () => {
  it.each(['supported', 'analysis'])('withholds the actual accepted Crown closing under %s', status => {
    expect(audit(capture.result.content, undefined, status)).toBe('failed')
  })
  it.each([
    'If you credit the account, it may satisfy the supplied receipt condition.',
    'If credited, the account could establish the supplied receipt condition.',
    'The account may satisfy the Crown burden on receipt.',
    'The attributed account might prove the required receipt condition.',
    'E-001 could meet the burden on the receipt condition.',
    'The Crown does not promise it will meet the burden, but the account could prove the receipt condition.',
  ])('rejects a conditional grant of prohibited proof use: %s', text => {
    expect(audit(text)).toBe('failed')
  })
  it.each([
    'If credited, the account describes the supplied receipt condition.',
    'You must assess whether the account proves the condition under its permitted attribution-only use.',
    'The account may not satisfy the supplied receipt condition.',
    'If a permitted proof source established receipt, the element could be satisfied.',
    'If the account were permitted for proof, it could satisfy the receipt condition.',
    'The Crown does not promise it will meet the burden with attribution-only material.',
    'You must assess whether the account could establish receipt under the permitted attribution-only use.',
  ])('preserves descriptions, inquiries, denials and different-permission hypotheses: %s', text => {
    expect(audit(text)).toBe('passed')
  })
  it('preserves an actual permission to assess the account as proof', () => {
    expect(audit('If credited, the account could establish the supplied receipt condition.', 'E-001: admitted; permitted purposes: Assess the fictional condition using the attributed disputed account.')).toBe('passed')
  })
  it('does not impose the restriction on a distinct permitted proof source', () => {
    const evidence = [...q.evidence, { ...q.evidence[0], id: 'other', exhibitId: 'E-002', text: 'Receipt proof.' }]
    const unit = { id: 'content:1', text: 'E-002 could satisfy the supplied receipt condition.' }
    expect(parseGroundingReview(JSON.stringify({ findings: [{ unitId: unit.id, status: 'analysis', citations: [] }] }), [unit], evidence,
      q.groundingContext + '\nE-002: admitted; permitted purposes: Assess the receipt condition.').status).toBe('passed')
  })
})
