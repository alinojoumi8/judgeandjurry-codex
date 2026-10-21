import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
import type { StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v134-complete-account-control-capture.json', import.meta.url), 'utf8'))
const request = capture.request as StageRequest
function check(content = capture.draft.content, q = request, status = 'unsupported', wholeBallot = false) {
  const units = groundingUnits({ title: '', content, citations: [] })
  if (wholeBallot) units.push({ id: 'ballot:whole', kind: 'ballot_consistency', text: content })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Actual complete source paraphrase.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('complete attributed paraphrases need not duplicate each adjective', () => {
  it.each(['unsupported', 'contradicted'])('corrects the actual complete-summary false rejection: %s', status => expect(check(capture.draft.content, request, status)).toBe('passed'))
  it('binds actual renamed speakers, participants and source identifiers', () => {
    const rename = (text: string) => text.replaceAll('Tavi', 'Sol').replaceAll('Ellis', 'Nox').replaceAll('Rowan', 'Avery').replaceAll('E-002', 'E-732')
    expect(check(rename(capture.draft.content), JSON.parse(rename(JSON.stringify(request))))).toBe('passed')
  })
  it('does not hide an additional actual source proposition', () => {
    expect(check(capture.draft.content, { ...request, evidence: request.evidence.map(e => e.exhibitId === 'E-002' ? { ...e, text: e.text + ' I also saw a car leave.' } : e) }, 'analysis')).toBe('failed')
  })
  it('does not substitute a different observation actor', () => expect(check(capture.draft.content.replace('Tavi saw', 'Mira saw'), request, 'analysis')).toBe('failed'))
  it('does not substitute a different departure actor', () => expect(check(capture.draft.content.replace('Rowan left', 'Ellis left'), request, 'analysis')).toBe('failed'))
  it('does not replace nonobservation with a global denial', () => expect(check(capture.draft.content.replace('Tavi did not see a handover', 'no handover occurred'), request, 'analysis')).toBe('failed'))
  it('does not clear an added allegation', () => expect(check(capture.draft.content + ' Rowan concealed cash.')).toBe('failed'))
  it('does not promote a failed whole-ballot consistency finding', () => expect(check(capture.draft.content, request, 'unsupported', true)).toBe('failed'))
})
