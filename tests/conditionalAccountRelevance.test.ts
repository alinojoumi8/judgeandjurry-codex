import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
const capture = JSON.parse(readFileSync('docs/qa/jury/v125-conditional-relevance-control-capture.json', 'utf8'))
const request = capture.control.request
const text = capture.control.draft.content as string
function check(content = text, q = request, status = 'unsupported') {
  const units = groundingUnits({ ...capture.control.draft, content })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({
    ...capture.actual.review.findings[0], unitId: unit.id, status, citations: [],
  })) }), units, q.evidence, q.groundingContext, undefined, {
    packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles,
    partyRoles: q.approvedPartyRoles, stage: q.stage,
  }).status
}

describe('conditional account relevance preserves the actual attribution limit', () => {
  it('accepts the captured relevance statement without granting occurrence proof', () => expect(check()).toBe('passed'))
  it('binds a renamed source speaker and permission', () => {
    const rename = (s: string) => s.replaceAll('Mira', 'Nira')
    expect(check(rename(text), { ...request, evidence: request.evidence.map((e: any) => ({ ...e, text: rename(e.text) })), groundingContext: rename(request.groundingContext) })).toBe('passed')
  })
  it.each(['analysis', 'supported'])('rejects a different speaker despite checker %s', status => expect(check(text.replace('Mira', 'Nox'), request, status)).toBe('failed'))
  it.each(['analysis', 'supported'])('requires the actual source despite checker %s', status => expect(check(text, { ...request, evidence: [] }, status)).toBe('failed'))
  it('requires the permitted account preview', () => expect(check(text, { ...request, groundingContext: 'E-101: excluded.' }, 'analysis')).toBe('failed'))
  it('requires a handover in the actual account', () => expect(check(text, {
    ...request, evidence: request.evidence.map((e: any) => ({ ...e, text: 'Fictional witness Mira states: I saw Ellis standing at the desk. I do not know what the envelope contained.' })),
  }, 'analysis')).toBe('failed'))
  it('does not treat a hypothetical source account as a recorded observation', () => expect(check(text, {
    ...request, evidence: request.evidence.map((e: any) => ({ ...e, text: e.text.replace('I saw', 'If I saw') })),
  }, 'analysis')).toBe('failed'))
  it.each([
    text + ' No handover occurred.',
    text + ' The envelope contained cash.',
    text.replace('could bear on a handover', 'could establish the receipt condition'),
    text.replace('does not establish contents or guilt', 'establishes contents and guilt'),
    text.replace('if accepted', 'because it was authenticated'),
  ])('does not clear additional facts or a proof grant: %s', value => expect(check(value)).toBe('failed'))
  it('never promotes a whole-ballot consistency judgment', () => {
    const unit = { id: 'ballot-consistency-1', kind: 'ballot_consistency' as const, text }
    expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: [{ unitId: unit.id, status: 'unsupported', explanation: 'Contradictory ballot.', citations: [] }] }), [unit], request.evidence, request.groundingContext).status).toBe('failed')
  })
})
