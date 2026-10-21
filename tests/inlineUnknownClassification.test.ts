import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
const c = JSON.parse(readFileSync('docs/qa/jury/v141-alternate-classification-capture.json', 'utf8'))
function check(q = structuredClone(c.request), status = 'unsupported', content = c.draft.content, whole = false) {
  const units = groundingUnits({ ...c.draft, content })
  if (whole) units.push({ id: 'whole', kind: 'ballot_consistency', text: JSON.stringify(c.draft) })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Actual inline classification metadata.', citations: [] })) }), units,
    q.evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage }).status
}
describe('inline unknown classification and row metadata have the same scope', () => {
  it.each(['unsupported', 'contradicted', 'analysis'])('preserves the actual supplied unknown status under %s', status => expect(check(undefined, status)).toBe('passed'))
  it('resolves the actual source identifier after renaming', () => expect(check(JSON.parse(JSON.stringify(c.request).replaceAll('E-101', 'E-731')))).toBe('passed'))
  it.each(['missing-source', 'missing-metadata', 'known-value', 'conflicting-row', 'additional-source', 'known-packet'])('requires actual consistent unknown coverage: %s', kind => {
    const q = structuredClone(c.request)
    if (kind === 'missing-source') q.evidence = []
    if (kind === 'missing-metadata') q.groundingContext = q.groundingContext.replace(' Unclassified; primary/documentary status is not supplied.', '')
    if (kind === 'known-value') q.groundingContext = q.groundingContext.replace('Unclassified; primary/documentary status is not supplied.', 'Primary/documentary status is verified primary.')
    if (kind === 'conflicting-row') q.groundingContext += '\nE-101: primary; verified;'
    if (kind === 'additional-source') q.evidence.push({ ...q.evidence[0], exhibitId: 'E-732' })
    if (kind === 'known-packet') q.packet += '\nPrimary/documentary status is verified primary.'
    expect(check(q, 'analysis')).toBe('failed')
  })
  it('does not clear unqualified source absence', () => expect(check(undefined, 'unsupported', 'No primary document exists.')).toBe('failed'))
  it('does not clear an added allegation', () => expect(check(undefined, 'unsupported', c.draft.content + ' Ellis concealed cash.')).toBe('failed'))
  it('does not promote a failed whole ballot', () => expect(check(undefined, 'unsupported', undefined, true)).toBe('failed'))
})
