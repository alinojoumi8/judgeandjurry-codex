import { describe, expect, it } from 'vitest'
import { groundingMessages, parseGroundingReview } from '../server/grounding'
import { groundingCorrectionContent } from '../server/groundingFormat'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const units = [{ id: 'content:1', text: 'The Defence points to an unsigned contract (E-001).' }]
const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'Blake states: The financing contract does not bear my signature.' }]
const negative = { status: 'unsupported', supportTypes: ['source', 'record'], explanation: 'The affidavit contains the signature dispute, but no visible Defence submission makes that argument.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }
const parse = (row: Record<string, unknown>, arrayCorrection = false) => {
  const raw = JSON.stringify({ findings: arrayCorrection ? [{ unitId: 'content:1', ...row }] : { 'content:1': row } })
  return parseGroundingReview(arrayCorrection ? groundingCorrectionContent(raw) : raw, units, evidence)
}

describe('structured incomplete rejection metadata', () => {
  it('retains an exact text-bound raw rejection when malformed siblings prevent any validated findings', () => {
    const current = [...units, { id: 'title:1', text: 'Source review' }]
    const review = parseGroundingReview(JSON.stringify({ findings: {
      'content:1': { status: 'unsupported', explanation: negative.explanation },
      'title:1': { status: 'analysis' },
    } }), current, evidence)
    expect(review.status).toBe('failed')
    expect(review.findings).toEqual([])
    expect(review.explicitRejections).toEqual([{ unitId: 'content:1', text: units[0].text, status: 'unsupported', explanation: negative.explanation }])
    expect(review.explicitRejections?.[0]).not.toHaveProperty('supportTypes')
    expect(review.explicitRejections?.[0]).not.toHaveProperty('citations')
    expect(review.explicitRejections?.[0]).not.toHaveProperty('recordCitations')
  })

  it.each([
    { findings: [{ unitId: 'unknown:1', ...negative }] },
    { findings: [{ unitId: 'content:1', ...negative }, { unitId: 'content:1', ...negative }] },
    { findings: [{ unitId: 'content:1', ...negative, explanation: '   ' }] },
    { findings: [{ unitId: 'content:1', ...negative, explanation: null }] },
    { findings: [{ unitId: 'content:1', ...negative, status: 'analysis' }] },
    { findings: { 'content:1': { ...negative, unitId: 'other:1' } } },
  ])('does not anchor ambiguous or absent raw judgments: %j', raw => {
    expect(parseGroundingReview(JSON.stringify(raw), units, evidence).explicitRejections).toBeUndefined()
  })

  it('does not infer a rejection from unparseable JSON', () => {
    expect(() => parseGroundingReview('{"findings":', units, evidence)).toThrow(SyntaxError)
  })

  it.each(['unsupported', 'contradicted'] as const)('retains a %s judgment while identifying exactly the omitted fields', status => {
    for (const fields of [['supportTypes'], ['recordCitations'], ['supportTypes', 'recordCitations']]) {
      for (const arrayCorrection of [false, true]) {
        const row: Record<string, unknown> = { ...negative, status }
        for (const field of fields) delete row[field]
        const review = parse(row, arrayCorrection)
        expect(review.status).toBe('failed')
        expect(review.incompleteFindings).toEqual([{ unitId: 'content:1', status, missingFields: fields }])
        expect(review.findings[0].status).toBe(status)
        expect(review.findings[0].explanation).toBe(negative.explanation)
        if (fields.includes('supportTypes')) expect(review.findings[0].supportTypes).toBeUndefined()
        if (fields.includes('recordCitations')) expect(review.findings[0].recordCitations).toBeUndefined()
        expect(review.findings[0].citations[0].quote).toBe(evidence[0].text)
      }
    }
  })

  it('distinguishes a complete negative review from an incomplete one without promoting either', () => {
    const review = parse(negative)
    expect(review.status).toBe('failed')
    expect(review.findings[0].status).toBe('unsupported')
    expect(review.findings[0].supportTypes).toEqual(['source', 'record'])
    expect(review.incompleteFindings).toBeUndefined()
  })

  it('does not label a present malformed value as an omission', () => {
    for (const row of [{ ...negative, supportTypes: null }, { ...negative, recordCitations: '' }]) {
      const review = parse(row)
      expect(review.status).toBe('failed')
      expect(review.incompleteFindings).toBeUndefined()
      expect(review.validationErrors?.length).toBeGreaterThan(0)
    }
  })

  it('requires complete accepted rows while keeping a properly attributed source account usable', () => {
    const row = { ...negative, status: 'supported', supportTypes: ['source'], explanation: 'The affidavit contains this attributed signature dispute.' }
    const { recordCitations: _, ...incomplete } = row
    expect(parse(incomplete).validationErrors).toContain('Invalid findings schema')
    const sourceUnits = [{ id: 'content:1', text: "Blake's affidavit disputes Blake's signature on the financing contract (E-001)." }]
    const review = parseGroundingReview(JSON.stringify({ findings: { 'content:1': row } }), sourceUnits, evidence)
    expect(review.status).toBe('passed')
    expect(review.incompleteFindings).toBeUndefined()
  })

  it('preserves historical array readability without inventing mandatory live metadata', () => {
    const { supportTypes: _, recordCitations: __, ...legacy } = negative
    const review = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', ...legacy }] }), units, evidence)
    expect(review.status).toBe('failed')
    expect(review.findings[0].status).toBe('unsupported')
    expect(review.findings[0].supportTypes).toBeUndefined()
    expect(review.incompleteFindings).toBeUndefined()
  })

  it('asks the checker to distinguish document speakers and public positions while completing negative metadata', () => {
    const message = groundingMessages(units, evidence, '')[0].content
    expect(message).toContain('document authors, embedded speakers and proceeding advocates')
    expect(message).toContain('faithfully attributed source account remains reviewable')
    expect(message).toContain('including unsupported and contradicted findings')
    expect(message).toContain('Completing JSON alone supplies no new support')
  })
})
