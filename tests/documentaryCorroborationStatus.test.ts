import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v132-full-control-documentary-status-unknown-positive-control-capture.json', import.meta.url), 'utf8'))
const request = capture.control.request as StageRequest
function check(q = request, status = 'unsupported', content = capture.control.draft.content) {
  const units = groundingUnits({ ...capture.control.draft, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Captured documentary-status information distinction.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('unknown documentary-corroboration status is distinct from absent corroboration', () => {
  it.each(['unsupported', 'contradicted'])('corrects the actual false %s judgment', status => {
    expect(check(request, status)).toBe('passed')
  })
  it('uses actual identifiers and people', () => {
    expect(check(JSON.parse(JSON.stringify(request).replaceAll('Mira', 'Nira').replaceAll('E-001', 'E-731')))).toBe('passed')
  })
  it.each(['verified', 'present', 'absent'])('does not deny an explicit documentary corroboration status %s', value => {
    expect(check({ ...request, groundingContext: request.groundingContext + `\nDocumentary corroboration status: ${value}.` }, 'analysis')).toBe('failed')
  })
  it('preserves an explicitly unknown status', () => {
    expect(check({ ...request, groundingContext: request.groundingContext + '\nDocumentary corroboration status: unknown.' })).toBe('passed')
  })
  it('reads actual packet status', () => {
    expect(check({ ...request, packet: request.packet + '\nDocumentary corroboration status: verified.' }, 'analysis')).toBe('failed')
  })
  it('reads an explicit source status statement without authenticating it', () => {
    const q = { ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text + '\nDocumentary corroboration status: verified.' })) }
    expect(check(q, 'analysis')).toBe('failed')
  })
  it('does not mistake a hypothetical status for an actual value', () => {
    const q = { ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text + '\nIf documentary corroboration status is verified, it may affect weight.' })) }
    expect(check(q)).toBe('passed')
  })
  it('does not turn a status question into an actual known value', () => {
    expect(check({ ...request, packet: request.packet + '\nDocumentary corroboration status: verified?' })).toBe('passed')
  })
  it('does not infer corroboration absence from unknown status', () => {
    expect(check(request, 'unsupported', 'No documentary corroboration exists.')).toBe('failed')
  })
  it('does not clear an added allegation', () => {
    expect(check(request, 'unsupported', capture.control.draft.content + ' Rowan concealed cash.')).toBe('failed')
  })
  it('does not clear missing metadata after an actual source classification changes', () => {
    const q = { ...request, groundingContext: (request.groundingContext ?? '').replace('E-001: unclassified; unknown;', 'E-001: primary_document; verified; corroborates receipt;') }
    expect(check(q)).toBe('failed')
  })
})
