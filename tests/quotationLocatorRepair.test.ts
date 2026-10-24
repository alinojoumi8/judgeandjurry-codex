import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview, type GroundingReview, type GroundingUnit } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const transcript = 'Fictional interview of Mira\nPage 4\n1 Q. What was said?\n2 A. The account was described as a registered\n3 custodian, with no custody finding established here.\n4 Q. Any other statement?\n5 A. The envelope was sealed.'
const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-003', name: 'Fictional interview', text: `Mira said the envelope was sealed.\n\n${transcript}` }]
const claim = 'In the fictional interview, Mira said the account was described “as a registered custodian”, and said “the envelope was sealed” (E-003).'
const draft = { title: 'Source review', content: claim, citations: ['E-003'], jurors: [] }
const request: StageRequest = { stage: 'crown_opening', packet: '', previousTurns: '', evidence }
const analysis = { status: 'analysis', supportTypes: ['analysis'], explanation: 'A neutral heading.', citations: [], recordCitations: [] }
const finding = (paragraph: number, status = 'supported') => ({ status, supportTypes: ['source'], explanation: status === 'supported' ? 'The witness uses the quoted words in this selected passage.' : 'The quotation does not support the asserted context.', citations: [{ exhibitId: 'E-003', paragraph }], recordCitations: [] })
const rows = (units: GroundingUnit[], paragraph: number, status = 'supported') => ({ findings: Object.fromEntries(units.map(unit => [unit.id, unit.id === 'content:1' ? finding(paragraph, status) : analysis])) })
function harness(replies: Array<(units: GroundingUnit[]) => unknown>, q = request, current = draft, maxRetries = 1) {
  const prompts: string[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries }, undefined, async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[1].content
    prompts.push(prompt)
    if (!replies[prompts.length - 1]) throw new Error('Unexpected extra fixture call.')
    return Response.json({ choices: [{ message: { content: JSON.stringify(replies[prompts.length - 1](JSON.parse(prompt.split('Draft units to check:\n')[1]))) } }] })
  })
  return { prompts, run: (previous?: GroundingReview) => client.reviewGrounding(q, current, previous) }
}

describe('quotation citation repair requires a new checker selection', () => {
  it('already matches a short quotation across verified numbered transcript lines with the correct selector', () => {
    const review = parseGroundingReview(JSON.stringify(rows(groundingUnits(draft), 2)), groundingUnits(draft), evidence)
    expect(review.errors).toEqual([])
    expect(review.findings.find(row => row.unitId === 'content:1')?.citations[0].quote).toBe(transcript)
  })
  it('flags an omitted permitted passage as a checker locator failure without adding or remapping a selector', () => {
    const review = parseGroundingReview(JSON.stringify(rows(groundingUnits(draft), 1)), groundingUnits(draft), evidence)
    expect(review.status).toBe('failed')
    expect(review.sourceLocatorValidationUnitIds).toContain('content:1')
    expect(review.validationErrors?.join(' ')).toContain('"exhibitId":"E-003","paragraph":2')
    expect(review.findings.find(row => row.unitId === 'content:1')?.citations.map(citation => citation.paragraph)).toEqual([1])
    expect(review.citationCorrections).toEqual([])
  })
  it('rechecks the same text and accepts only after an explicit fresh supporting selection', async () => {
    const h = harness([units => rows(units, 1), units => rows(units, 2)])
    const review = await h.run()
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[1]).toContain('checker quotation locator')
    expect(h.prompts[1].split('Draft units to check:\n')[1]).toBe(h.prompts[0].split('Draft units to check:\n')[1])
    expect(review.status).toBe('passed')
    expect(review.findings.find(row => row.unitId === 'content:1')?.citations.map(citation => citation.paragraph)).toEqual([2])
    expect(review.verificationFailures?.[0].errors.join(' ')).toContain('checker quotation locator')
  })
  it('retains an independent rejection while correcting the quotation locator', async () => {
    const current = { ...draft, content: `${claim} Arin received $1,900.` }
    const reply = (paragraph: number) => (units: GroundingUnit[]) => ({ findings: Object.fromEntries(units.map(unit => [unit.id, unit.id === 'content:1' ? finding(paragraph) : unit.id === 'content:2' ? { ...analysis, status: 'unsupported', explanation: 'No supplied source supports the asserted payment.' } : analysis])) })
    const h = harness([reply(1), reply(2)], request, current)
    const review = await h.run()
    expect(h.prompts).toHaveLength(2)
    expect(review.status).toBe('failed')
    expect(review.findings.find(row => row.unitId === 'content:1')?.status).toBe('supported')
    expect(review.findings.find(row => row.unitId === 'content:2')?.status).toBe('unsupported')
  })
  it.each(['same-wrong-selector', 'semantic-rejection'] as const)('withholds an unresolved %s within the same retry cap', async mode => {
    const h = harness([units => rows(units, 1), units => rows(units, mode === 'same-wrong-selector' ? 1 : 2, mode === 'same-wrong-selector' ? 'supported' : 'unsupported')])
    const review = await h.run()
    expect(h.prompts).toHaveLength(2)
    expect(review.status).toBe('failed')
  })
  it.each(['wrong-source', 'excluded-passage', 'altered-words'] as const)('does not invent a candidate for %s', mode => {
    const source = mode === 'wrong-source' ? { ...evidence[0], text: 'This source does not supply that quotation.' }
      : mode === 'excluded-passage' ? { ...evidence[0], authorizedPassages: [{ paragraph: 1, text: 'Only the sealed envelope statement is permitted.', startOffset: 0, endOffset: 48 }] } : evidence[0]
    const current = mode === 'altered-words' ? { ...draft, content: claim.replace('registered', 'licensed') } : draft
    const sources = mode === 'wrong-source' ? [source, { ...evidence[0], id: 'other-source', exhibitId: 'E-004' }] : [source]
    const review = parseGroundingReview(JSON.stringify(rows(groundingUnits(current), 1)), groundingUnits(current), sources)
    expect(review.status).toBe('failed')
    expect(review.sourceLocatorValidationUnitIds ?? []).not.toContain('content:1')
  })
  it('withholds the original wrong selector if no correction allowance remains', async () => {
    const h = harness([units => rows(units, 1)], request, draft, 0)
    expect((await h.run()).status).toBe('failed')
    expect(h.prompts).toHaveLength(1)
  })

  it.each(['unsupported', 'analysis'])('reconciles a valid %s judgment alongside another unit’s locator correction', async status => {
    const current = { ...draft, content: `${claim} I assess the supplied explanation.` }
    const reply = (paragraph: number, judgment: string) => (units: GroundingUnit[]) => ({ findings: Object.fromEntries(units.map(unit => [unit.id, unit.id === 'content:1' ? finding(paragraph) : unit.id === 'content:2' ? { ...analysis, status: judgment, explanation: 'An independent assessment of the same current claim.' } : analysis])) })
    const prior = await harness([reply(2, status === 'unsupported' ? 'analysis' : 'unsupported')], request, current, 0).run()
    const h = harness([reply(1, status), reply(2, status)], request, current)
    const review = await h.run(prior)
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[1]).toContain('checker changed judgment on unchanged text')
    expect(review.status).toBe(status === 'analysis' ? 'passed' : 'failed')
    expect(review.errors.join(' ')).not.toContain('checker changed judgment on unchanged text')
    expect(review.findings.find(row => row.unitId === 'content:2')?.status).toBe(status)
  })

  it('keeps disagreement withheld if an independent judgment reverses again during locator correction', async () => {
    const current = { ...draft, content: `${claim} I assess the supplied explanation.` }
    const reply = (paragraph: number, status: string) => (units: GroundingUnit[]) => ({ findings: Object.fromEntries(units.map(unit => [unit.id, unit.id === 'content:1' ? finding(paragraph) : { ...analysis, ...(unit.id === 'content:2' ? { status } : {}) }])) })
    const previous = await harness([reply(2, 'analysis')], request, current, 0).run()
    const h = harness([reply(1, 'unsupported'), reply(2, 'analysis')], request, current)
    const review = await h.run(previous)
    expect(h.prompts).toHaveLength(2)
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain('checker changed judgment on unchanged text')
  })

  it('does not treat a prior invalid locator as a substantive rejection of unchanged text', async () => {
    const previous = await harness([units => rows(units, 1)], request, draft, 0).run()
    expect(previous.sourceLocatorValidationUnitIds).toContain('content:1')
    const h = harness([units => rows(units, 2)], request, draft, 0)
    const review = await h.run(previous)
    expect(review.status).toBe('passed')
    expect(h.prompts).toHaveLength(1)
  })
})
