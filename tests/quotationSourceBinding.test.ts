import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const evidence = [
  { ...supportedOpeningSource, exhibitId: 'E-001', name: 'Accounting report', text: 'Confirmed participants supplied a blue ledger. This is an aggregate entry across related accounts.' },
  { ...supportedOpeningSource, exhibitId: 'E-003', name: 'Interview', text: 'The witness describes a presentation.' },
  { ...supportedOpeningSource, exhibitId: 'E-004', name: 'Affidavit', text: 'Rowan disputes the witness account.' },
  { ...supportedOpeningSource, exhibitId: 'E-006', name: 'Email', text: 'There were no withdrawals of cash sent back to ExampleCo. The email describes a licence relationship.' },
]
const reportQuote = 'Confirmed participants supplied a blue ledger'
const emailQuote = 'There were no withdrawals of cash sent back to ExampleCo'
const report = `The accounting report states that, for Rowan, "${reportQuote}," an aggregate entry across related accounts. [E-001]`
const email = `The email states that "${emailQuote}," and describes a licence relationship. [E-006]`
function check(text: string, status = 'supported') {
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': { status, supportTypes: ['source'], explanation: 'Each quotation is checked against its own source.', citations: evidence.map(e => ({ exhibitId: e.exhibitId, paragraph: 1 })), recordCitations: [] } } }), [{ id: 'content:1', text }], evidence)
}

describe('local quotation-to-source binding', () => {
  it.each(['supported', 'analysis'])('preserves two local quotations after a semicolon citation group under %s', status => {
    expect(check(`The supplied interview is disputed in the affidavit. [E-003; E-004] ${report} ${email}`, status).status).toBe('passed')
  })
  it.each(['[E-003; E-004]', '(E-003; E-004)', '[E-003, E-004]'])('does not treat citation punctuation as a prose clause boundary: %s', refs => {
    expect(check(`A disputed account is supplied. ${refs} ${report}`).status).toBe('passed')
  })
  it.each(['.', ';'])('binds the source after a quoted appositive and delimiter %s', delimiter => {
    expect(check(`A disputed account is supplied. [E-004] The report states "${reportQuote}," an aggregate entry${delimiter} [E-001]`).status).toBe('passed')
  })
  it('preserves an explicit same-clause source ID', () => {
    expect(check(`E-001 records "${reportQuote}," an aggregate entry. [E-001]`).status).toBe('passed')
  })
  it('rejects the wrong local suffix source even when another selected source contains the words', () => {
    expect(check(`A disputed account is supplied. [E-003; E-004] ${report.replace('[E-001]', '[E-006]')}`).status).toBe('failed')
  })
  it('does not override an explicit wrong source ID with a convenient trailing citation', () => {
    expect(check(`E-004 records "${reportQuote}," an aggregate entry. [E-001]`).status).toBe('failed')
  })
  it.each([report.replace('blue ledger', 'red ledger'), email.replace('no withdrawals', 'several withdrawals')])('rejects altered quotation words: %s', quote => {
    expect(check(`A disputed account is supplied. [E-003; E-004] ${quote}`).status).toBe('failed')
  })
  it('does not borrow a source selector from a later sentence', () => {
    expect(check(`E-004 records "${reportQuote}". The report is also supplied [E-001].`).status).toBe('failed')
  })
  it('does not borrow a source selector from the next quoted document clause', () => {
    expect(check(`E-004 records "${reportQuote}", and E-001 states "${reportQuote}".`).status).toBe('failed')
  })
})
