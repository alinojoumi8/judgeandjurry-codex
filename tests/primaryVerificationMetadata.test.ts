import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v131-primary-verification-control-capture.json', import.meta.url), 'utf8'))
const request = capture.control.request as StageRequest
function check(q = request, status = 'unsupported', content = capture.control.draft.content, wholeBallot = false) {
  const units = groundingUnits({ ...capture.control.draft, content })
  if (wholeBallot) units.push({ id: 'ballot:whole', kind: 'ballot_consistency', text: content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Captured status-metadata classification.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('primary verification-status information is distinct from a source property', () => {
  it.each(['unsupported', 'contradicted'])('preserves the captured metadata absence despite checker %s', status => {
    expect(check(request, status)).toBe('passed')
  })
  it('does not depend on fixture identities', () => {
    const renamed = JSON.parse(JSON.stringify(request).replaceAll('Mira', 'Nira').replaceAll('Rowan', 'Avery')) as StageRequest
    expect(check(renamed)).toBe('passed')
  })
  it.each(['verified', 'unknown'])('does not deny an explicitly supplied %s status value', value => {
    expect(check({ ...request, groundingContext: request.groundingContext + `\nPrimary verification status: ${value}.` }, 'analysis')).toBe('failed')
  })
  it('checks an actual status supplied in the packet', () => {
    expect(check({ ...request, packet: request.packet + '\nPrimary verification status: verified.' }, 'analysis')).toBe('failed')
  })
  it('checks an explicit source status statement without treating it as authenticated truth', () => {
    const q = { ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text + '\nPrimary verification status: verified.' })) }
    expect(check(q, 'analysis')).toBe('failed')
  })
  it('does not mistake a hypothetical status for an actually supplied status', () => {
    const q = { ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text + '\nIf primary verification status is verified, it would affect weight.' })) }
    expect(check(q)).toBe('passed')
  })
  it('does not clear verification-process absence or added allegations', () => {
    expect(check(request, 'unsupported', 'The accounts lack primary verification.')).toBe('failed')
    expect(check(request, 'unsupported', capture.control.draft.content + ' Rowan concealed cash.')).toBe('failed')
  })
  it('does not promote failed whole-ballot consistency', () => {
    expect(check(request, 'unsupported', capture.control.draft.content, true)).toBe('failed')
  })
})
