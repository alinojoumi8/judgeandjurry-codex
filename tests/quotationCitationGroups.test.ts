import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const blue = 'The ledger is an internal calculation'
const green = 'No cash was returned to ExampleCo'
const red = 'The affidavit disputes the account'
const evidence = [
  { ...supportedOpeningSource, exhibitId: 'E-001', name: 'Report annex', text: blue + '.' },
  { ...supportedOpeningSource, exhibitId: 'E-006', name: 'Email', text: green + '.' },
  { ...supportedOpeningSource, exhibitId: 'E-004', name: 'Affidavit', text: red + '.' },
]
function check(text: string, selected = evidence.map(source => source.exhibitId)) {
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': {
    status: 'supported', supportTypes: ['source'], explanation: 'Independently verified reported contents.',
    citations: selected.map(exhibitId => ({ exhibitId, paragraph: 1 })), recordCitations: [],
  } } }), [{ id: 'content:1', text }], evidence)
}

describe('quotation citation groups', () => {
  it.each(['[E-006] [E-001]', '[E-001] [E-006]', '[E-006; E-001]', '(E-006) (E-001)', '[E-006], [E-001]'])('keeps every local reference in %s', refs => {
    expect(check(`The provider reports “${green},” and the ledger figure was “${blue}.” ${refs}`).errors).toEqual([])
  })
  it.each(['[E-006] [E-001]', '[E-006; E-001]'])('does not borrow matching words from outside the local reference set %s', refs => {
    const result = check(`The report states “${red}.” ${refs}`)
    expect(result.status).toBe('failed')
    expect(result.errors.join(' ')).toContain('Quotation source mismatch')
    expect(result.errors.join(' ')).toContain('E-006, E-001')
  })
  it.each(['[E-006] [E-001]', '[E-001] [E-006]'])('does not override an explicit wrong source ID with %s', refs => {
    const result = check(`E-006 states “${blue}.” ${refs}`)
    expect(result.status).toBe('failed')
    expect(result.errors.join(' ')).toContain('Quotation source mismatch')
  })
  it('distinguishes wrong-source binding from words absent from every selected passage', () => {
    const wrongSource = check(`The email states “${blue}.” [E-006]`)
    expect(wrongSource.errors.join(' ')).toContain('Quotation source mismatch')
    expect(wrongSource.errors.join(' ')).not.toContain('silently delete or change words')
    const altered = check('The report states “The ledger is an external calculation.” [E-006] [E-001]')
    expect(altered.status).toBe('failed')
    expect(altered.errors.join(' ')).toContain('preserve the actual words in order')
  })
  it('requires a verified selected passage even if an unselected source has the words', () => {
    expect(check(`The report states “${blue}.” [E-006] [E-001]`, ['E-006']).status).toBe('failed')
  })
  it.each([
    `E-006 states “${blue}.” [E-006] The report is supplied. [E-001]`,
    `E-006 states “${blue},” and E-001 reports “${blue}.” [E-001]`,
  ])('keeps later sentences and source clauses outside the current quote: %s', text => {
    expect(check(text).status).toBe('failed')
  })
  it('retains an explicit correct source regardless of extra trailing references', () => {
    expect(check(`E-001 states “${blue}.” [E-006] [E-001]`).errors).toEqual([])
  })
})
