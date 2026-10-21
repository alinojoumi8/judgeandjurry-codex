import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
const capture = JSON.parse(readFileSync('docs/qa/jury/v144-calibration-v84-explicit-ellipsis-positive.json', 'utf8'))
function check(q: any, draft: any, status = 'supported', citations: any[] = [{ exhibitId: 'E-002', paragraph: 1 }]) {
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: groundingUnits(draft).map(unit => ({ unitId: unit.id, status, explanation: 'Recorded source locator.', citations })) }), groundingUnits(draft), q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage })
}

describe('explicit quotation ellipses preserve ordered source sentences and scope', () => {
  it('reproduces the actual V144 false rejection', () => {
    const c = capture
    expect(reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: c.checkerResult.review.findings }), groundingUnits(c.result), c.request.evidence, c.request.groundingContext, undefined,
      { packet: c.request.packet, events: c.request.courtroomEvents, actorRoles: c.request.courtroomActor.roles, partyRoles: c.request.approvedPartyRoles, stage: c.request.stage }).status).toBe('passed')
  })
  for (const marker of ['...', '…', '[...]']) {
    it.each(['supported', 'analysis', 'unsupported', 'contradicted'])(`preserves full retained sentences using ${marker} under %s`, status => {
      const draft = { ...capture.result, content: capture.result.content.replace('...', marker) }
      expect(check(capture.request, draft, status).status).toBe('passed')
    })
  }
  it.each(['supported', 'analysis', 'unsupported', 'contradicted'])('preserves a retained conditional sentence in full under %s', status => {
    const q = structuredClone(capture.request), draft = structuredClone(capture.result)
    q.evidence[1].text = q.evidence[1].text.replace('I saw', 'If I saw')
    draft.content = draft.content.replace('I saw', 'If I saw')
    expect(check(q, draft, status).status).toBe('passed')
  })
  it('preserves attribution analysis without manufacturing a citation', () => {
    const review = check(capture.request, capture.result, 'analysis', [])
    expect(review.status).toBe('passed')
    expect(review.findings[0].citations).toEqual([])
  })
  it('requires a same-draft locator retry for a rejected uncited valid quote', () => {
    const review = check(capture.request, capture.result, 'unsupported', [])
    expect(review.status).toBe('failed')
    expect(review.sourceLocatorValidationUnitIds).toEqual(['content:1'])
  })
  for (const kind of ['reversed', 'changed-words', 'missing-ellipsis', 'removed-condition', 'removed-negation', 'omitted-qualification', 'excluded', 'wrong-speaker', 'wrong-exhibit', 'unauthorized-passage', 'invalid-locator']) {
    it.each(['supported', 'analysis', 'unsupported', 'contradicted'])(`withholds ${kind} under %s`, status => {
      const q = structuredClone(capture.request), draft = structuredClone(capture.result)
      if (kind === 'reversed') draft.content = 'E-002 records Tavi stating "I did not see a handover... I saw Fictional Ellis standing at the desk."'
      if (kind === 'changed-words') draft.content = draft.content.replace('standing', 'sitting')
      if (kind === 'missing-ellipsis') draft.content = draft.content.replace('...', '.')
      if (kind === 'removed-condition') q.evidence[1].text = q.evidence[1].text.replace('I saw', 'If I saw')
      if (kind === 'removed-negation') draft.content = draft.content.replace('I did not see', 'I did see')
      if (kind === 'omitted-qualification') q.evidence[1].text = q.evidence[1].text.replace('Fictional Morgan left with the blue token still in their hand.', 'I may have been mistaken about the person at the desk.')
      if (kind === 'excluded') q.groundingContext = q.groundingContext.replace('E-002: admitted;', 'E-002: excluded;')
      if (kind === 'wrong-speaker') draft.content = draft.content.replace('Tavi', 'Mira')
      if (kind === 'wrong-exhibit') draft.content = draft.content.replace('E-002', 'E-001')
      if (kind === 'unauthorized-passage') q.evidence[1].authorizedPassages = [{ paragraph: 1, text: 'Tavi states: I saw Fictional Ellis standing at the desk.', startOffset: 0, endOffset: 53 }]
      expect(check(q, draft, status, [{ exhibitId: 'E-002', paragraph: kind === 'invalid-locator' ? 999 : 1 }]).status).toBe('failed')
    })
  }
})
