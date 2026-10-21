import { reviewWithIndependentScopeCheck, fixtureCheckerWithIndependentFollowup } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const c = JSON.parse(readFileSync('docs/qa/jury/v152-burden-counterfactual-capture.json', 'utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v152-burden-counterfactual-checker-raw.json', 'utf8')).checkerContent
const request = c.request as StageRequest
function check(q = request, text = c.result.content, status = 'unsupported') {
 const units = groundingUnits({ ...c.result, content: text })
 return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Counterfactual not supplied.', citations: [] })) }), units,
  q.evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles, partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage }).status
}

describe('explicit change of burden allocation preserves the supplied hypothetical standard', () => {
 it('requires an independent new review of the complete counterfactual through the production checker client', async () => {
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 1 }, undefined, fixtureCheckerWithIndependentFollowup('analysis', raw))
  expect((await client.reviewGrounding(request, c.result)).status).toBe('passed')
 })
 it.each(['analysis', 'supported', 'unsupported', 'contradicted'])('preserves the complete bounded hypothesis under checker %s', status => expect(check(undefined, undefined, status)).toBe('passed'))
 it('uses actual renamed Crown identity with the real Crown role', () => {
  const q = JSON.parse(JSON.stringify(request).replaceAll('crown', 'prosecution-731'))
  q.approvedPartyRoles = request.approvedPartyRoles?.map(party => ({ ...party, id: party.id === 'crown' ? 'prosecution-731' : party.id }))
  expect(check(q)).toBe('passed')
 })
 it.each(['missing', 'opposite', 'wrong-standard'])('does not invent a %s actual burden anchor', kind => {
  const q = structuredClone(request)
  if (kind === 'missing') q.packet = q.packet.split('\n').filter(line => !line.startsWith('Pinned legal packet ')).join('\n')
  if (kind === 'opposite') q.packet = q.packet.replaceAll('"burdenPartyId":"crown"', '"burdenPartyId":"accused-1"')
  if (kind === 'wrong-standard') q.packet = q.packet.replaceAll('"standard":"beyond a reasonable doubt"', '"standard":"balance of probabilities"')
  expect(check(q)).toBe('failed')
 })
 it('does not invent an opposing party role', () => expect(check({ ...request, approvedPartyRoles: request.approvedPartyRoles?.filter(party => party.role === 'crown') })).toBe('failed'))
 it.each([
  'The Defence must disprove receipt beyond a reasonable doubt.',
  'If Mira is credible, the Defence must disprove receipt beyond a reasonable doubt.',
  'If the burden were instead on the Defence, the Defence must disprove receipt beyond a reasonable doubt. Mira concealed cash.',
  'If the burden were instead on the Defence, the Defence must disprove knowing participation beyond a reasonable doubt.',
 ])('does not clear an actual shifted threshold or added claim: %s', text => expect(check(undefined, text)).toBe('failed'))
})
