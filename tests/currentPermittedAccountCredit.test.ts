import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync('docs/qa/jury/v128-current-credit-control-capture.json', 'utf8'))
const request = capture.control.request
const text = capture.control.draft.content as string
function check(content = text, q = request, status = 'unsupported', whole = false) {
  const units = whole ? [{ id: 'ballot-consistency-1', kind: 'ballot_consistency' as const, text: content }] : groundingUnits({ ...capture.control.draft, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({
    ...capture.actual.review.findings[0], unitId: unit.id, status,
    citations: q.evidence.map((e: any) => ({ exhibitId: e.exhibitId, paragraph: 1 })),
  })) }), units, q.evidence, q.groundingContext, undefined, {
    packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles,
    partyRoles: q.approvedPartyRoles, stage: q.stage,
  }).status
}

describe('current credit under actual assessment permission', () => {
  it.each(['unsupported', 'contradicted'])('preserves the captured own assessment despite checker %s', status => expect(check(text, request, status)).toBe('passed'))
  it('binds renamed actual participants', () => {
    const rename = (s: string) => s.replaceAll('Mira', 'Nira').replaceAll('Rowan', 'Lea').replaceAll('Ellis', 'Nox')
    expect(check(rename(text), JSON.parse(rename(JSON.stringify(request))))).toBe('passed')
  })
  it.each(['analysis', 'supported'])('requires the actual account under %s', status => expect(check(text, { ...request, evidence: [] }, status)).toBe('failed'))
  it.each(['Mira', 'Rowan', 'Ellis'])('rejects a different %s', name => expect(check(text.replace(name, 'Nox'), request, 'analysis')).toBe('failed'))
  it('requires assessment permission rather than exclusive attribution', () => expect(check(text, { ...request, groundingContext: request.groundingContext.replaceAll('Assess the fictional condition using the attributed disputed account.', 'Accurately attribute the disputed account; not proof of contents or guilt.') }, 'analysis')).toBe('failed'))
  it('requires an unconditional actual account', () => expect(check(text, { ...request, evidence: request.evidence.map((e: any) => ({ ...e, text: e.text.replace('I saw', 'If I saw') })) }, 'analysis')).toBe('failed'))
  it('requires a current assessment task', () => expect(check(text, { ...request, stage: 'witness_answer', courtroomActor: { id: 'w1', roles: ['witness'] } }, 'analysis')).toBe('failed'))
  it('does not clear an added contents claim', () => expect(check(text + ' The envelope contained cash.')).toBe('failed'))
  it('never promotes a failed whole-ballot judgment', () => expect(check(text, request, 'unsupported', true)).toBe('failed'))
})
