import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync('docs/qa/jury/v124-active-observation-control-capture.json', 'utf8'))
const request = capture.control.request
const text = capture.control.draft.content as string
function check(content = text, q = request, status = 'unsupported', citations = ['E-001', 'E-002']) {
  const units = groundingUnits({ ...capture.control.draft, content })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({
    ...capture.actual.review.findings[0], unitId: unit.id, status,
    citations: citations.map(exhibitId => ({ exhibitId, paragraph: 1 })),
  })) }), units, q.evidence, q.groundingContext, undefined, {
    packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles,
    partyRoles: q.approvedPartyRoles, stage: q.stage,
  }).status
}

describe('personal non-observation remains non-observation in a complete cited summary', () => {
  it('accepts the actual falsely rejected complete summary and checker finding', () => expect(check()).toBe('passed'))
  it('also accepts did-not-see wording', () => expect(check(text.replace('saw no handover', 'did not see a handover'))).toBe('passed'))
  it('binds the actual source names rather than fixture names', () => {
    const rename = (value: string) => value.replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Lio').replaceAll('Morgan', 'Ena')
    expect(check(rename(text), { ...request, evidence: request.evidence.map((e: any) => ({ ...e, text: rename(e.text) })) })).toBe('passed')
  })
  it.each(['analysis', 'supported'])('rejects a wrong handover speaker despite checker %s', status => expect(check(text.replace('Mira describes', 'Nox describes'), request, status)).toBe('failed'))
  it.each(['analysis', 'supported'])('rejects a wrong departure person despite checker %s', status => expect(check(text.replace('Morgan left', 'Ellis left'), request, status)).toBe('failed'))
  it.each(['analysis', 'supported'])('rejects a wrong final observer despite checker %s', status => expect(check(text.replace('and Tavi saw', 'and Morgan saw'), request, status)).toBe('failed'))
  it('requires both actual cited accounts', () => expect(check(text, request, 'unsupported', ['E-002'])).toBe('failed'))
  it('does not accept a handover from a source that supplies only receipt uncertainty', () => expect(check(text, {
    ...request, evidence: request.evidence.map((e: any) => e.exhibitId === 'E-001' ? { ...e, text: 'Mira states: I do not know whether Ellis received a token.' } : e),
  }, 'analysis')).toBe('failed'))
  it('does not accept non-observation from a source that supplies only receipt uncertainty', () => expect(check(text, {
    ...request, evidence: request.evidence.map((e: any) => ({ ...e, text: e.text.replace('I did not see a handover.', 'I do not know whether Ellis received a token.') })),
  }, 'analysis')).toBe('failed'))
  it('does not accept a conditional departure as a completed departure', () => expect(check(text, {
    ...request, evidence: request.evidence.map((e: any) => ({ ...e, text: e.text.replace('Fictional Morgan left', 'If Fictional Morgan left') })),
  }, 'analysis')).toBe('failed'))
  it.each([
    text + ' No handover occurred.',
    text.replace('saw no handover', 'saw that no handover occurred'),
    text.replace('Tavi states Morgan left', 'Tavi saw Morgan leave'),
    text.replace('and Tavi saw', 'and saw'),
  ])('does not clear an added event, stronger observation or wrong subject: %s', value => expect(check(value)).toBe('failed'))
  it('does not override an exclusive source-use prohibition', () => expect(check(text, { ...request, groundingContext: 'E-001: excluded.\nE-002: excluded.' })).toBe('failed'))
})
