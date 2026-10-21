import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
const load = (file: string) => JSON.parse(readFileSync(`docs/qa/jury/${file}.json`, 'utf8'))
const personal = load('v140-personal-no-doubt-capture')
const inquiry = load('v140-calibration-full-control-v138-historical-adoption-neutral-inquiry')
const report = load('v140-calibration-full-control-v137-negative-proof-reported')
function check(c: any, q = c.request, draft = c.draft ?? c.result, status = 'unsupported', recordCitations: any[] = [], whole = false) {
  const units = groundingUnits(draft)
  if (whole) units.push({ id: 'whole', kind: 'ballot_consistency', text: JSON.stringify(draft) })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Actual captured source and record boundary.', citations: [], recordCitations })) }), units,
    q.evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage })
}
describe('personal source weighting is not an asserted source fact', () => {
  it.each(['unsupported', 'contradicted'])('preserves the actual current juror assessment under %s', status => expect(check(personal, undefined, undefined, status).status).toBe('passed'))
  it('resolves changed exhibit identifiers', () => {
    const c = JSON.parse(JSON.stringify(personal).replaceAll('E-002', 'E-732'))
    expect(check(c).status).toBe('passed')
  })
  it.each(['source', 'empty-source', 'permission', 'stage', 'role'])('requires actual %s even if checker calls it analysis', missing => {
    const q = structuredClone(personal.request)
    if (missing === 'source') q.evidence = q.evidence.filter((e: any) => e.exhibitId !== 'E-002')
    if (missing === 'empty-source') q.evidence[1].text = ''
    if (missing === 'permission') q.groundingContext = q.groundingContext.replaceAll('Assess the fictional condition using the attributed disputed account.', 'Accurately attribute the account; not proof of receipt.')
    if (missing === 'stage') q.stage = 'witness_answer'
    if (missing === 'role') q.courtroomActor.roles = ['witness']
    expect(check(personal, q, undefined, 'analysis').status).toBe('failed')
  })
  it.each([' E-002 proves receipt.', ' Rowan concealed cash.'])('does not clear an added claim: %s', extra => expect(check(personal, undefined, { ...personal.draft, content: personal.draft.content + extra }).status).toBe('failed'))
  it('does not promote a failed whole ballot', () => expect(check(personal, undefined, undefined, 'unsupported', [], true).status).toBe('failed'))
})
describe('neutral inquiry into adoption of an actual public acknowledgement', () => {
  it.each(['unsupported', 'contradicted'])('requires no prior Defence adoption to ask neutrally under %s', status => expect(check(inquiry, undefined, undefined, status).status).toBe('passed'))
  it.each(['absent', 'private', 'wrong-actor', 'no-acknowledgement'])('requires the actual Crown acknowledgement: %s', missing => {
    const q = structuredClone(inquiry.request)
    if (missing === 'absent') q.courtroomEvents = []
    if (missing === 'private') q.courtroomEvents[0].type = 'private_submission'
    if (missing === 'wrong-actor') q.courtroomEvents[0].actorId = 'ellis'
    if (missing === 'no-acknowledgement') q.courtroomEvents[0].payload.text = 'The Crown asks the jury to assess the accounts.'
    expect(check(inquiry, q, undefined, 'analysis').status).toBe('failed')
  })
  it('preserves the actual locator and source words', () => {
    const r = check(inquiry)
    expect(r.findings[0].recordCitations).toEqual([{ eventId: 'fixture-public-concession', actorId: 'crown', quote: inquiry.request.courtroomEvents[0].payload.text }])
  })
  it.each(['It is incorrect to say the Crown burden is not met.', 'If the Crown burden is not met, the outcome may differ.', 'Is the Crown burden is not met?'])('requires an actual acknowledgement rather than: %s', text => {
    const q = structuredClone(inquiry.request); q.courtroomEvents[0].payload.text = text
    expect(check(inquiry, q, undefined, 'analysis').status).toBe('failed')
  })
  it('does not clear an invented adoption allegation', () => expect(check(inquiry, undefined, { ...inquiry.result, content: inquiry.result.content + ' The Defence already accepted it.' }).status).toBe('failed'))
})
describe('record locator wire shape preserves authorization checks', () => {
  const c = { ...report, result: { title: '', content: 'The Crown stated, "These disputed accounts leave receipt beyond a reasonable doubt."', citations: [], jurors: [] } }
  it.each([['actual-reported-assessment'], [{ eventId: 'actual-reported-assessment' }]])('resolves an exact supplied record ID in either supported wire shape: %j', locator => {
    const r = check(c, undefined, undefined, 'analysis', Array.isArray(locator) ? locator : [locator])
    expect(r.status).toBe('passed')
    expect(r.findings[0].recordCitations?.[0].eventId).toBe('actual-reported-assessment')
  })
  it.each([['not-supplied'], ['?'], [null], [{ eventId: 'not-supplied' }]])('rejects invalid IDs or malformed entries: %j', locator => expect(check(c, undefined, undefined, 'analysis', Array.isArray(locator) ? locator : [locator]).status).toBe('failed'))
  it('rejects private records even with an exact ID', () => {
    const q = structuredClone(c.request); q.courtroomEvents.at(-1).type = 'private_submission'
    expect(check(c, q, undefined, 'analysis', ['actual-reported-assessment']).status).toBe('failed')
  })
})
