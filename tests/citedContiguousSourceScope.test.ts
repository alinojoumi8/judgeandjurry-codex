import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const captures = ['conditional-source', 'excluded', 'negated-source'].map(kind =>
  JSON.parse(readFileSync(`docs/qa/jury/v143-calibration-full-control-v142-excerpt-${kind}.json`, 'utf8')))
const original = JSON.parse(readFileSync('docs/qa/jury/v141-contiguous-quote-capture.json', 'utf8'))
function check(q: any, draft: any, findings: any[]) {
  return parseGroundingReview(JSON.stringify({ findings }), groundingUnits(draft), q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage })
}

describe('a returned locator cannot erase quotation scope or permission', () => {
  it.each(captures)('withholds actual accepted control $checkerResult.id', capture => {
    expect(check(capture.request, capture.result, capture.checkerResult.review.findings).status).toBe('failed')
  })
  for (const kind of ['conditional-source', 'negated-source', 'excluded', 'wrong-speaker', 'unauthorized-passage', 'internal-deletion']) {
    it.each(['supported', 'analysis', 'unsupported', 'contradicted'])(`withholds ${kind} despite a real locator and %s`, status => {
      const q = structuredClone(original.request), draft = structuredClone(original.draft)
      if (kind === 'conditional-source') q.evidence[0].text = q.evidence[0].text.replace('I saw', 'If I saw')
      if (kind === 'negated-source') q.evidence[0].text = q.evidence[0].text.replace('I saw', 'I did not see')
      if (kind === 'excluded') q.groundingContext = q.groundingContext.replace('E-001: admitted;', 'E-001: excluded;')
      if (kind === 'wrong-speaker') draft.content = draft.content.replace('Mira', 'Tavi')
      if (kind === 'unauthorized-passage') q.evidence[0].authorizedPassages = [{ paragraph: 1, text: 'Mira states:', startOffset: 0, endOffset: 12 }]
      if (kind === 'internal-deletion') draft.content = draft.content.replace('a blue token', 'a token')
      const findings = groundingUnits(draft).map(unit => ({ unitId: unit.id, status, explanation: 'Actual locator returned.', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }))
      expect(check(q, draft, findings).status).toBe('failed')
    })
  }
  it.each(['supported', 'analysis', 'unsupported', 'contradicted'])('preserves the actual unconditional permitted excerpt under %s', status => {
    const findings = groundingUnits(original.draft).map(unit => ({ unitId: unit.id, status, explanation: 'Actual locator returned.', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }))
    expect(check(original.request, original.draft, findings).status).toBe('passed')
  })
  it.each(['If I saw', 'I did not see'])('preserves the complete honestly qualified source sentence: %s', prefix => {
    const q = structuredClone(original.request), draft = structuredClone(original.draft)
    q.evidence[0].text = q.evidence[0].text.replace('I saw', prefix)
    draft.content = `E-001 records Mira stating "${q.evidence[0].text.split('states: ')[1]}"`
    const findings = groundingUnits(draft).map(unit => ({ unitId: unit.id, status: 'supported', explanation: 'The qualification is preserved.', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }))
    expect(check(q, draft, findings).status).toBe('passed')
  })
})
