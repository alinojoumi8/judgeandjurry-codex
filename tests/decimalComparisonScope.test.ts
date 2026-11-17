import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const text = 'The report records a deposit of $1,200.50 and lists $8,000 above $5,000 (E-001).'
const source = 'The report records a deposit of $1,200.50 and a balance of $8,000.'
function check(draft = text, options: { source?: string; status?: string; second?: string } = {}) {
  const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: options.source ?? source }]
  if (options.second) evidence.push({ ...supportedOpeningSource, id: 'other-source', exhibitId: 'E-002', text: options.second })
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'analysis', supportTypes: ['source', 'analysis'], explanation: 'The source supplies the recorded figures; a comparison supplies no transaction or proved element.', citations: evidence.map(item => ({ exhibitId: item.exhibitId, paragraph: 1 })), recordCitations: [] }] }), [{ id: 'content:1', text: draft }], evidence, '')
}

describe('decimal-aware source comparison scope', () => {
  it.each(['analysis', 'supported'])('retains the preceding report lead for a %s comparison', status => {
    expect(check(text, { status }).errors).toEqual([])
  })
  it.each(['$0.50', '$1.25 million', '$12,345.67'])('preserves a decimal in an earlier source amount: %s', value => {
    expect(check(text.replace('$1,200.50', value), { source: source.replace('$1,200.50', value) }).errors).toEqual([])
  })
  it('keeps the named exhibit before the decimal attached to the comparison', () => {
    const draft = text.replace('The report', 'The report (E-001)').replace(' (E-001).', '.')
    expect(check(draft, { second: 'An unrelated document records USD $800.' }).errors).toEqual([])
    expect(check(draft, { source: source.replace('$8,000', '$800'), second: source }).status).toBe('failed')
  })
  it.each(['.', ';', '!', '?'])('does not borrow report attribution across a real %s boundary', punctuation => {
    expect(check(text.replace(' and lists', `${punctuation} Rowan lists`)).status).toBe('failed')
  })
  it.each([
    text.replace('above', 'below'),
    text.replace('$8,000 above', '$800 above'),
    text.replace('$8,000 above $5,000', 'USD $8,000 above CAD $5,000'),
    text.replace('$1,200.50', '$1,200.05'),
    text.replace('E-001', 'E-999'),
    `${text} Rowan received $5,000 (E-001).`,
    text.replace('lists', 'proves a loss of'),
  ])('keeps false, unverified and proof claims rejected: %s', draft => {
    expect(check(draft).status).toBe('failed')
  })
  it('preserves an independent semantic rejection after recognizing the comparison', () => {
    expect(check(text, { status: 'unsupported' }).status).toBe('failed')
  })
  it('preserves a faithfully attributed quotation without adopting its false inequality', () => {
    const quote = 'The report records $1,200.50 and states “$8,000 below $5,000” (E-001).'
    expect(check(quote, { source: 'The report records $1,200.50 and states “$8,000 below $5,000”.' }).errors).toEqual([])
  })
})
