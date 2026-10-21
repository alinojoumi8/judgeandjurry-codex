import { reviewWithIndependentScopeCheck, fixtureCheckerWithIndependentFollowup } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v153-source-inventory-capture.json', 'utf8'))
const raw = JSON.parse(readFileSync('docs/qa/jury/v153-source-inventory-checker-raw.json', 'utf8')).checkerContent
const request = capture.request as StageRequest
function check(q = request, status = 'contradicted', content = capture.result.content) {
 const units = groundingUnits({ ...capture.result, content })
 return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'A public submission mentions another exhibit.',
  citations: status === 'supported' && q.evidence.length ? [{ exhibitId: q.evidence[0].exhibitId, quote: q.evidence[0].text }] : [] })) }),
  units, q.evidence, q.groundingContext, undefined,
  { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor!.roles, partyRoles: q.approvedPartyRoles ?? [], actor: q.courtroomActor, stage: q.stage }).status
}

describe('source passages supplied to the run remain distinct from permission metadata and advocacy', () => {
 it('requires an independent new review of the captured inventory statement through the production checker', async () => {
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 1 }, undefined,
   fixtureCheckerWithIndependentFollowup('analysis', raw))
  expect((await client.reviewGrounding(request, capture.result)).status).toBe('passed')
 })
 it.each(['analysis', 'supported', 'unsupported', 'contradicted'])('binds the complete source inventory under checker %s', status => expect(check(undefined, status)).toBe('passed'))
 it('does not promote an admitted-use metadata entry into a supplied source passage', () => {
  expect(request.evidence).toHaveLength(1)
  expect(request.groundingContext).toContain('E-002: admitted;')
  expect(check()).toBe('passed')
 })
 it('does not promote the verified Crown quotation into the missing source', () => {
  expect(capture.checkerResult.review.findings[0].recordCitations[0].quote).toContain('Under E-002, Tavi states:')
  expect(check()).toBe('passed')
 })
 it('binds renamed actual identifiers rather than fixed exhibit or speaker names', () => {
  const rename = (value: any) => JSON.parse(JSON.stringify(value).replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732').replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Savi'))
  expect(check(rename(request), 'contradicted', 'Only E-731 is supplied to this run.')).toBe('passed')
 })
 it.each(['analysis', 'supported', 'unsupported', 'contradicted'])('rejects an actual extra source under checker %s', status => {
  const q = structuredClone(request)
  q.evidence.push({ ...q.evidence[0], id: 'another-actual-source', exhibitId: 'E-002', text: 'Tavi states: I did not see a handover.' })
  expect(check(q, status)).toBe('failed')
 })
 it('rejects an empty inventory even if permissions mention the exhibit', () => expect(check({ ...request, evidence: [] }, 'analysis')).toBe('failed'))
 it('rejects a mismatched sole exhibit identifier', () => expect(check(undefined, 'analysis', 'Only E-002 is supplied to this run.')).toBe('failed'))
 it.each([
  'Only E-001 is supplied to this run; Mira concealed cash.',
  'Only E-001 is supplied to this run, so no other evidence exists.',
  'Only E-001 is supplied to this run, and it is authenticated.',
  'Only E-001 is supplied to this run, so the disclosure is complete.',
 ])('does not clear added allegations or record-completeness claims: %s', content => expect(check(undefined, 'unsupported', content)).toBe('failed'))
})
