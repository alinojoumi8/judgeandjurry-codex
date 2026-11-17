import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const c = JSON.parse(readFileSync('docs/qa/jury/v141-contiguous-quote-capture.json', 'utf8'))
function check(q = structuredClone(c.request), content = c.draft.content, status = 'unsupported', whole = false, citations: any[] = []) {
  const units = groundingUnits({ ...c.draft, content })
  if (whole) units.push({ id: 'whole', kind: 'ballot_consistency', text: JSON.stringify(c.draft) })
  return reviewWithIndependentScopeCheck('analysis', JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Captured excerpt rejected as an inexact full-sentence quote.', citations })) }), units,
    q.evidence, q.groundingContext, undefined, { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, stage: q.stage })
}
describe('actual contiguous excerpt with omitted checker source locator', () => {
  it('preserves the existing analysis classification for an actual exact permitted excerpt', () => {
    const r = check(undefined, undefined, 'analysis')
    expect(r.status).toBe('passed')
    expect(r.findings[0].status).toBe('analysis')
    expect(r.sourceLocatorValidationUnitIds).toBeUndefined()
  })
  it.each(['unsupported', 'contradicted'])('withholds the uncited review and requests a same-draft locator correction under %s', status => {
    const r = check(undefined, undefined, status)
    expect(r.status).toBe('failed')
    expect(r.sourceLocatorValidationUnitIds).toEqual(['content:1'])
    expect(r.findings[0].citations).toEqual([])
  })
  it('requires a returned verified locator before resolving actual text and raw offsets', () => {
    const r = check(undefined, undefined, 'unsupported', false, [{ exhibitId: 'E-001', paragraph: 1 }])
    expect(r.status).toBe('passed')
    expect(r.findings[0].citations).toEqual([{ exhibitId: 'E-001', paragraph: 1, quote: c.request.evidence[0].text, startOffset: 0, endOffset: c.request.evidence[0].text.length, quoteMethod: 'source-paragraph' }])
  })
  it('resolves actual renamed sources and participants', () => {
    const rename = (s: string) => s.replaceAll('E-001', 'E-731').replaceAll('Mira', 'Nia').replaceAll('Morgan', 'Avery')
    const r = check(JSON.parse(rename(JSON.stringify(c.request))), rename(c.draft.content))
    expect(r.status).toBe('failed')
    expect(r.sourceLocatorValidationUnitIds).toEqual(['content:1'])
  })
  it.each(['missing', 'wrong-speaker', 'wrong-source', 'internal-deletion', 'excluded', 'unauthorized-passage', 'negated-source', 'conditional-source'])('does not clear %s under an analysis label', kind => {
    const q = structuredClone(c.request); let text = c.draft.content
    if (kind === 'missing') q.evidence = q.evidence.filter((e: any) => e.exhibitId !== 'E-001')
    if (kind === 'wrong-speaker') text = text.replace('Mira', 'Tavi')
    if (kind === 'wrong-source') text = text.replace('E-001', 'E-002')
    if (kind === 'internal-deletion') text = text.replace('a blue token', 'a token')
    if (kind === 'excluded') q.groundingContext = q.groundingContext.replace('E-001: admitted;', 'E-001: excluded;')
    if (kind === 'unauthorized-passage') q.evidence[0].authorizedPassages = [{ paragraph: 1, text: 'Mira states:', startOffset: 0, endOffset: 12 }]
    if (kind === 'negated-source') q.evidence[0].text = q.evidence[0].text.replace('I saw', 'I did not see')
    if (kind === 'conditional-source') q.evidence[0].text = q.evidence[0].text.replace('I saw', 'If I saw')
    expect(check(q, text, 'analysis').status).toBe('failed')
  })
  it('does not clear an added allegation', () => expect(check(undefined, c.draft.content + ' Morgan concealed cash.').status).toBe('failed'))
  it('preserves an invalid supplied paragraph as a validation failure', () => expect(check(undefined, undefined, 'analysis', false, [{ exhibitId: 'E-001', paragraph: 999 }]).status).toBe('failed'))
  it('requires the named source rather than another valid source locator', () => expect(check(undefined, undefined, 'analysis', false, [{ exhibitId: 'E-002', paragraph: 1 }]).status).toBe('failed'))
  it('does not promote an independently failed whole ballot', () => expect(check(undefined, undefined, 'unsupported', true).status).toBe('failed'))
  it.each([['recovered', 2, 2, 'passed'], ['exhausted', 2, 3, 'failed'], ['disabled', 0, 1, 'failed']] as const)('keeps same-draft source locator recovery bounded: %s', async (kind, maxRetries, calls, expected) => {
    const bodies: string[] = [], original = JSON.stringify(c.draft)
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional-key', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined, async (_url, init) => {
      bodies.push(String(init?.body))
      const recovered = kind === 'recovered' && bodies.length > 1
      const rows = { findings: groundingUnits(c.draft).map(unit => ({ unitId: unit.id, status: recovered ? 'supported' : 'unsupported', supportTypes: ['source'], explanation: recovered ? 'The exact quotation matches the selected source paragraph.' : 'The quotation omits I saw and is inexact.', citations: recovered ? [{ exhibitId: 'E-001', paragraph: 1 }] : [], recordCitations: [] })) }
      return Response.json({ choices: [{ message: { content: JSON.stringify(rows) } }] })
    })
    const review = await client.reviewGrounding(c.request, c.draft)
    expect(review.status).toBe(expected)
    expect(bodies).toHaveLength(calls)
    expect(review.verificationRetries).toBe(calls - 1)
    expect(JSON.stringify(c.draft)).toBe(original)
    if (bodies.length > 1) expect(JSON.parse(bodies[1]).messages[1].content).toContain('Re-check the SAME draft units')
  })
  it('retains a separate substantive invented allegation while locator corrections exhaust their cap', async () => {
    const draft = { ...c.draft, content: c.draft.content + ' Morgan concealed cash.' }
    let calls = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional-key', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 2 }, undefined, async () => {
      calls++
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: groundingUnits(draft).map(unit => ({ unitId: unit.id, status: 'unsupported', supportTypes: ['source'], explanation: unit.text.includes('concealed') ? 'No source identifies concealed cash.' : 'Quotation omits I saw.', citations: [], recordCitations: [] })) }) } }] })
    })
    const review = await client.reviewGrounding(c.request, draft)
    expect(review.status).toBe('failed')
    expect(calls).toBe(3)
    expect(review.findings.find(finding => finding.text.includes('concealed'))?.status).toBe('unsupported')
    expect(review.errors.join(' ')).toContain('No source identifies concealed cash.')
  })
})
