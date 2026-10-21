import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const c = JSON.parse(readFileSync('docs/qa/jury/v143-calibration-full-control-v143-threshold-correction.json', 'utf8'))
function check(q = c.request, text = c.result.content, status = 'unsupported', actual = false) {
  const units = groundingUnits({ ...c.result, content: text })
  return parseGroundingReview(JSON.stringify({ findings: actual ? c.checkerResult.review.findings : units.map(unit => ({ unitId: unit.id, status, explanation: 'No matching prior Defence submission.', citations: [] })) }), units,
    q.evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage })
}

describe('current correction of a shifted counteraccount proof threshold', () => {
  it('does not misread the actual complete correction as an earlier Defence submission', () => expect(check(undefined, undefined, undefined, true).status).toBe('passed'))
  it.each(['analysis', 'supported', 'unsupported', 'contradicted'])('preserves the complete correction under the actual Crown burden with %s', status => expect(check(undefined, undefined, status).status).toBe('passed'))
  it('uses the actual renamed Crown party', () => {
    const q = JSON.parse(JSON.stringify(c.request).replaceAll('crown', 'prosecution-731'))
    q.approvedPartyRoles = c.request.approvedPartyRoles.map((p: any) => ({ ...p, id: p.id === 'crown' ? 'prosecution-731' : p.id }))
    expect(check(q).status).toBe('passed')
  })
  for (const kind of ['missing', 'opposite', 'wrong-standard']) {
    it.each(['analysis', 'supported', 'unsupported', 'contradicted'])(`does not infer ${kind} allocation despite %s`, status => {
      const q = structuredClone(c.request)
      if (kind === 'missing') q.packet = q.packet.split('\n').filter((line: string) => !line.startsWith('Pinned legal packet ')).join('\n')
      if (kind === 'opposite') q.packet = q.packet.replaceAll('"burdenPartyId":"crown"', '"burdenPartyId":"accused-1"')
      if (kind === 'wrong-standard') q.packet = q.packet.replaceAll('"standard":"beyond a reasonable doubt"', '"standard":"balance of probabilities"')
      expect(check(q, undefined, status).status).toBe('failed')
    })
  }
  it.each([
    'The Defence does not negate receipt beyond a reasonable doubt.',
    'It is incorrect to say the Defence does not negate receipt beyond a reasonable doubt. Mira concealed cash.',
    'The Defence previously said it negated receipt beyond a reasonable doubt.',
  ])('does not clear a shifted threshold or added assertion: %s', text => expect(check(undefined, text).status).toBe('failed'))
})
