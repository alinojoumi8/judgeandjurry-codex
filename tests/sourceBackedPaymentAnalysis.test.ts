import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { checkerSchemaFailure } from '../server/groundingFormat'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const evidence = [
  { ...supportedOpeningSource, id: 'withdrawal', exhibitId: 'E-001', text: 'Mira states: I requested a $640,000 withdrawal. The request was delayed and no money was returned.' },
  { ...supportedOpeningSource, id: 'cash', exhibitId: 'E-002', text: 'Ellis states: I paid $72,000 in cash to Mira.' },
]
const text = 'The deprivation assessment draws on Mira’s account of a $640,000 withdrawal request that was delayed and never returned, plus $72,000 that Ellis asserts Ellis paid in cash to Mira (E-001; E-002).'
const selectors = evidence.map(item => ({ exhibitId: item.exhibitId, paragraph: 1 }))
const finding = { unitId: 'content:1', status: 'analysis', supportTypes: ['source', 'analysis'], explanation: 'The selected accounts supply the attributed request and payment; deprivation remains an assessment.', citations: selectors, recordCitations: [] }
function check(overrides: Partial<typeof finding> = {}, draft = text, sources = evidence) {
  return parseGroundingReview(JSON.stringify({ findings: [{ ...finding, ...overrides }] }), [{ id: 'content:1', text: draft }], sources, '', undefined, { packet: '', events: [], actorRoles: [], partyRoles: [] })
}

describe('source-backed payment analysis', () => {
  it('preserves mixed attributed facts and evaluation with explicit verified source support', () => {
    const review = check()
    expect(review.status).toBe('passed')
    expect(review.errors).toEqual([])
    expect(review.findings[0]).toMatchObject({ status: 'analysis', supportTypes: ['source', 'analysis'] })
    expect(review.findings[0].citations.map(citation => citation.quote)).toEqual(evidence.map(item => item.text))
  })

  it.each([
    { supportTypes: ['analysis'] },
    { citations: [] },
    { supportTypes: ['analysis'], citations: [] },
  ])('requires both explicit source classification and verified locators: %j', overrides => {
    expect(check(overrides).errors).toContain('content:1: a payment assertion requires factual source support, not an analysis label.')
  })

  it.each([{ source: '', analysis: '' }, 'source', null])('rejects malformed support types without throwing or converting them: %j', supportTypes => {
    const raw = JSON.stringify({ findings: [{ ...finding, supportTypes }] })
    const review = parseGroundingReview(raw, [{ id: 'content:1', text }], evidence)
    expect(review.status).toBe('failed')
    expect(review.validationErrors).toEqual(['content:1: invalid support types for this finding.'])
    expect(checkerSchemaFailure(review)).toBe(true)
    expect(review.findings[0].supportTypes).toBeUndefined()
    expect(review.errors).toContain('content:1: a payment assertion requires factual source support, not an analysis label.')
  })

  it.each([
    { citations: [{ exhibitId: 'E-999', paragraph: 1 }] },
    { citations: [{ exhibitId: 'E-001', paragraph: 99 }] },
    { citations: [{ exhibitId: 'E-001', paragraph: 1, quote: 'Mira states: I requested a $900,000 withdrawal.' }] },
  ])('rejects unavailable or fabricated source selectors: %j', ({ citations }) => {
    expect(check({ citations }).status).toBe('failed')
  })

  it('requires every factual amount in a mixed analysis to occur in a supporting source', () => {
    const review = check({}, text.replace('$72,000', '$73,000'))
    expect(review.status).toBe('failed')
    expect(review.errors.some(error => error.includes('stated dollar amount'))).toBe(true)
  })

  it('keeps exact quoted words and their source attribution mandatory for analysis', () => {
    for (const draft of [
      'Ellis states “I paid $72,000 in gold to Mira” (E-002); this could support a deprivation assessment.',
      'Mira states “I paid $72,000 in cash to Mira” (E-001); this could support a deprivation assessment.',
    ]) expect(check({}, draft).status).toBe('failed')
  })

  it.each([
    ['contradicted', 'Mira states Mira paid $72,000 in cash to Ellis (E-002); this supports deprivation.', 'The payer and recipient are reversed.'],
    ['unsupported', 'Rowan states Rowan paid $72,000 in cash to Mira (E-002); this supports deprivation.', 'The account is attributed to Ellis, not Rowan.'],
    ['unsupported', 'Ellis states Ellis paid USD $72,000 in cash to Mira (E-002); this supports deprivation.', 'The selected account does not supply USD currency.'],
  ])('does not override the semantic checker on actor, direction or currency: %s %s', (status, draft, explanation) => {
    const review = check({ status, explanation }, draft)
    expect(review.status).toBe('failed')
    expect(review.findings[0]).toMatchObject({ status, explanation })
  })

  it('does not treat a sourced payment as evidence of an invented earlier juror position', () => {
    const review = check({}, `${text} Earlier juror-2 argued that Ellis paid $72,000 to Mira.`)
    expect(review.status).toBe('failed')
  })

  it('does not turn an unknown return into a sourced no-payment assertion', () => {
    const sources = [{ ...evidence[0], text: 'Mira states: I requested a $640,000 withdrawal. I do not know whether any money was returned.' }, evidence[1]]
    const review = check({ status: 'unsupported', explanation: 'Unknown return does not establish that no money was returned.' }, text, sources)
    expect(review.status).toBe('failed')
    expect(review.findings[0].status).toBe('unsupported')
  })
})
