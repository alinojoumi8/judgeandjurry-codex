import { describe, expect, it } from 'vitest'
import { parseGroundingReview, sourceParagraphs } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const source = { ...supportedOpeningSource, exhibitId: 'E-001', text: 'Confirmed deposits totalled $420.\n\nTrading-related charges totalled $18.\n\nThe account remained open during the review.' }
const review = (text: string, citations = [{ exhibitId: 'E-001', paragraph: 2 }], evidence = [source], context = '') =>
  parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', explanation: 'The source records these words.', citations }] }), [{ id: 'content:1', text }], evidence, context)

describe('complete quotation citation coverage', () => {
  it('attaches each unique supporting paragraph when a unit has two quotations', () => {
    const result = review('E-001 records "Confirmed deposits totalled $420" and "Trading-related charges totalled $18".')
    expect(result.status).toBe('passed')
    expect(result.findings[0].citations.map(c => c.paragraph).sort()).toEqual([1, 2])
    expect(result.citationCorrections).toContainEqual({ unitId: 'content:1', exhibitId: 'E-001', toParagraph: 1 })
  })

  it('finds a uniquely quoted paragraph when the checker selected a different paragraph', () => {
    const result = review('E-001 states "The account remained open during the review".')
    expect(result.status).toBe('passed')
    expect(result.findings[0].citations).toContainEqual(expect.objectContaining({ paragraph: 3, quote: sourceParagraphs(source)[2].text, startOffset: sourceParagraphs(source)[2].startOffset }))
  })

  it('uses a separate named exhibit for each quotation', () => {
    const other = { ...source, exhibitId: 'E-002', text: 'The audit took place in June.\n\nThe report was signed in July.' }
    const result = review('E-001 states "The account remained open during the review", while E-002 records "The audit took place in June".', [{ exhibitId: 'E-001', paragraph: 2 }, { exhibitId: 'E-002', paragraph: 2 }], [source, other])
    expect(result.status).toBe('passed')
    expect(result.findings[0].citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ exhibitId: 'E-001', paragraph: 3 }),
      expect.objectContaining({ exhibitId: 'E-002', paragraph: 1 }),
    ]))
  })

  it('does not change an altered amount or repair the words of a quotation', () => {
    expect(review('E-001 records "Confirmed deposits totalled $421" and "Trading-related charges totalled $18".').status).toBe('failed')
  })

  it('keeps a previous clause locator from becoming the next speaker quotation source', () => {
    const other = { ...source, exhibitId: 'E-002', text: 'Tavi states: The audit took place in June.' }
    expect(review('Mira states, "The account remained open during the review" (E-001); Tavi states, "The audit took place in June", according to the report (E-002).', [{ exhibitId: 'E-001', paragraph: 3 }, { exhibitId: 'E-002', paragraph: 1 }], [source, other]).status).toBe('passed')
  })

  it('checks a second quotation even without a repeated reporting verb', () => {
    expect(review('E-001 records "Trading-related charges totalled $18" and "The account was closed during the review".').status).toBe('failed')
  })

  it('does not bind a previous quotation parenthetical to the next speaker', () => {
    const other = { ...source, exhibitId: 'E-002', text: 'Tavi states: The audit took place in June.' }
    expect(review('Mira states, "The account remained open during the review" (E-001), while Tavi states, "The audit took place in June", according to the report (E-002).', [{ exhibitId: 'E-001', paragraph: 3 }, { exhibitId: 'E-002', paragraph: 1 }], [source, other]).status).toBe('passed')
  })

  it('does not complete coverage from an unrelated exhibit selection', () => {
    const other = { ...source, exhibitId: 'E-002', text: 'The audit took place in June.' }
    expect(review('E-001 states "The account remained open during the review".', [{ exhibitId: 'E-002', paragraph: 1 }], [source, other]).status).toBe('failed')
  })

  it('does not treat a leading leftover parenthetical as the next speaker source', () => {
    const other = { ...source, exhibitId: 'E-002', text: 'Tavi states: The audit took place in June.' }
    expect(review('(E-001) Tavi states: "The audit took place in June."', [{ exhibitId: 'E-002', paragraph: 1 }], [source, other]).status).toBe('passed')
  })

  it('uses the current clause rather than a source in a prior comparison', () => {
    const other = { ...source, exhibitId: 'E-002', text: 'Tavi states: The audit took place in June.' }
    expect(review('I credit the account (E-001), but Tavi records "The audit took place in June" (E-002).', [{ exhibitId: 'E-002', paragraph: 1 }], [source, other]).status).toBe('passed')
  })

  it('does not borrow a matching quotation from a different cited exhibit', () => {
    const other = { ...source, exhibitId: 'E-002', text: 'The account was closed during the review.' }
    const result = review('E-001 states "The account was closed during the review".', [{ exhibitId: 'E-001', paragraph: 2 }, { exhibitId: 'E-002', paragraph: 1 }], [source, other])
    expect(result.status).toBe('failed')
  })

  it('cannot recover a quotation outside the authorized passage projection', () => {
    const scoped = { ...source, authorizedPassages: [sourceParagraphs(source)[1]] }
    expect(review('E-001 records "Confirmed deposits totalled $420".', undefined, [scoped]).status).toBe('failed')
  })

  it('does not infer a new citation for an explicitly excluded exhibit', () => {
    expect(review('E-001 states "The account remained open during the review".', undefined, [source], 'E-001: excluded; permitted purposes: none.').status).toBe('failed')
  })

  it('does not guess between repeated passages', () => {
    const repeated = { ...source, text: `${source.text}\n\nThe account remained open during the review.` }
    expect(review('E-001 states "The account remained open during the review".', undefined, [repeated]).status).toBe('failed')
  })
})
