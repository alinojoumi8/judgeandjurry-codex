import { reviewWithIndependentScopeCheck, fixtureCheckerWithIndependentFollowup } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v155-explicit-placement-capture.json', 'utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v155-explicit-placement-checker-raw.json', 'utf8')).checkerContent
const request = capture.request as StageRequest
function check(q = request, status = 'unsupported', content = capture.result.content) {
 const units = groundingUnits({ ...capture.result, content })
 const source = q.evidence.find(e => e.exhibitId === 'E-002') ?? q.evidence.at(-1)
 return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status,
  citations: status === 'supported' && source ? [{ exhibitId: source.exhibitId, quote: source.text }] : [] })) }),
  units, q.evidence, q.groundingContext, undefined,
  { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles, partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage }).status
}
const changed = (from: string, to: string) => ({ ...request, evidence: request.evidence.map(e => ({ ...e, text: e.text.replace(from, to) })) })

describe('an account placement attribution does not assert a firsthand or simultaneous observation', () => {
 it('requires an independent new review of the captured account placement through the production checker', async () => {
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 1 }, undefined,
   fixtureCheckerWithIndependentFollowup('analysis', raw))
  expect((await client.reviewGrounding(request, capture.result)).status).toBe('passed')
 })
 it.each(['analysis', 'supported', 'unsupported', 'contradicted'])('binds actual explicit placement under checker %s', status => expect(check(undefined, status)).toBe('passed'))
 it('requires the actual account after renaming speakers, participants, sources and actor', () => {
  const q = JSON.parse(JSON.stringify(request).replaceAll('Tavi','Savi').replaceAll('Mira','Nira').replaceAll('Morgan','Orin').replaceAll('Ellis','Evan').replaceAll('E-002','E-732').replaceAll('E-001','E-731').replaceAll('crown','prosecutor'))
  expect(check(q, 'unsupported', 'Savi places both at the desk.')).toBe('passed')
 })
 it.each(['analysis', 'supported', 'unsupported', 'contradicted'])('requires explicit placement of the other participant under checker %s', status => {
  expect(check(changed(' Morgan was also at the desk.', ''), status)).toBe('failed')
 })
 it('does not substitute a differently named person for the actual second participant', () => {
  expect(check(changed('Morgan was also at the desk.', 'Nox was also at the desk.'), 'analysis')).toBe('failed')
 })
 it('does not transfer another speaker account to Tavi', () => expect(check(changed('Tavi states:', 'Nox states:'), 'analysis')).toBe('failed'))
 it('does not treat a negated placement as an affirmative placement', () => expect(check(changed('Morgan was also at the desk.', 'Morgan was not at the desk.'), 'analysis')).toBe('failed'))
 it('requires an actual source passage rather than the retained permission metadata', () => expect(check({ ...request, evidence: request.evidence.slice(0,1) }, 'analysis')).toBe('failed'))
 it('requires the actual account to be available for permitted use', () => {
  expect(check({ ...request, groundingContext: request.groundingContext!.replace('E-002: admitted;', 'E-002: excluded;') }, 'analysis')).toBe('failed')
 })
 it('keeps accurate attribution under actual attribution-only permission', () => {
  const q = { ...request, groundingContext: 'Only accurate attribution is permitted.' }
  expect(check(q)).toBe('passed')
 })
 it('preserves actual source attribution for a legacy parser caller without a permission context', () => {
  expect(check({ ...request, groundingContext:'' })).toBe('passed')
 })
 it.each(['analysis','supported'])('does not promote narrative placement to firsthand observation under checker %s', status => {
  expect(check(undefined, status, 'Tavi saw both at the desk.')).toBe('failed')
 })
 it.each([
  'Tavi places both at the desk because Morgan returned.',
  'Tavi places both at the desk at the same time.',
  'Tavi places both at the desk, so the disclosure is complete.',
  'Tavi places both at the desk and establishes receipt beyond reasonable doubt.',
 ])('does not clear added claims: %s', content => expect(check(undefined, 'unsupported', content)).toBe('failed'))
})
