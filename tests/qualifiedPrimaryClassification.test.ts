import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync('docs/qa/jury/v140-qualified-primary-classification-capture.json', 'utf8'))
function check(q = structuredClone(capture.request), text = capture.draft.content, status = 'unsupported', wholeBallot = false) {
  const units = groundingUnits({ ...capture.draft, content: text })
  if (wholeBallot) units.push({ id: 'whole-ballot', kind: 'ballot_consistency', text })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Captured qualified classification judgment.', citations: [] })) }), units,
    q.evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage }).status
}

describe('qualified verified-primary inventory versus source absence', () => {
  it.each(['unsupported', 'contradicted'])('preserves the actual qualified uncertainty under checker %s', status => expect(check(undefined, undefined, status)).toBe('passed'))
  it.each([
    'No verified primary record is supplied; classification remains unknown.',
    'No verified documentary support is supplied; documentary status remains unknown.',
    'No source is classified as primary documentary evidence.',
    'No source is classified as a primary document in the supplied record.',
  ])('preserves the same actual missing-classification boundary: %s', text => expect(check(undefined, text)).toBe('passed'))
  it('does not depend on fictional identities or exhibit numbering', () => {
    const q = JSON.parse(JSON.stringify(capture.request).replaceAll('Morgan', 'Avery').replaceAll('Mira', 'Nia').replaceAll('E-001', 'E-701').replaceAll('E-002', 'E-702'))
    expect(check(q)).toBe('passed')
  })
  it('covers a single actually unclassified account too', () => {
    const q = structuredClone(capture.request); q.evidence = q.evidence.slice(0, 1)
    expect(check(q)).toBe('passed')
  })
  it('requires actual source inventory', () => expect(check({ ...capture.request, evidence: [] }, undefined, 'analysis')).toBe('failed'))
  it('requires unknown classification for every actual source', () => {
    expect(check({ ...capture.request, groundingContext: '' }, undefined, 'analysis')).toBe('failed')
    const q = structuredClone(capture.request); q.groundingContext = q.groundingContext.replace('E-002: unclassified; unknown;', 'E-002: primary; verified;')
    expect(check(q, undefined, 'analysis')).toBe('failed')
  })
  it('does not ignore a conflicting classification row', () => {
    const q = structuredClone(capture.request); q.groundingContext += '\nE-001: primary; verified;'
    expect(check(q, undefined, 'analysis')).toBe('failed')
  })
  it('requires classification coverage for an additional source', () => {
    const q = structuredClone(capture.request); q.evidence.push({ ...q.evidence[0], id: 'additional', exhibitId: 'E-003' })
    expect(check(q, undefined, 'analysis')).toBe('failed')
  })
  it.each(['groundingContext', 'packet'])('checks an actual primary-status declaration in %s', key => {
    const q = structuredClone(capture.request); q[key] += '\nPrimary source status: verified primary.'
    expect(check(q, undefined, 'analysis')).toBe('failed')
  })
  it('preserves an explicit unknown status', () => {
    const q = structuredClone(capture.request); q.groundingContext += '\nPrimary source status: unknown.'
    expect(check(q)).toBe('passed')
  })
  it('does not turn a status question into a declaration', () => {
    const q = structuredClone(capture.request); q.packet += '\nPrimary source status: verified primary?'
    expect(check(q)).toBe('passed')
  })
  it.each([
    'No primary documentary support is supplied.',
    'No verified primary documentary support is supplied; no primary documentary support exists.',
    'No verified primary documentary support is supplied; primary status remains unknown. Rowan concealed cash.',
    'No verification occurred; primary status remains unknown.',
  ])('does not clear an absence, process or added-fact claim: %s', text => expect(check(undefined, text)).toBe('failed'))
  it('does not promote an independently failed whole ballot', () => expect(check(undefined, undefined, 'unsupported', true)).toBe('failed'))
})
