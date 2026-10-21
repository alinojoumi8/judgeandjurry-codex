import { describe, expect, it } from 'vitest'
import { parseGroundingReview, sourceParagraphs } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const transcript = 'Fictional interview\nPage 3\n9 \tQ. \tWhat return was discussed?\n10 \tA. \tThey\n11 \tA. \t-- told me 24 percent.\n12 \tGuaranteed 24 percent.\n13 \tQ. \tWhen?\n14 \tA. \tIn 2023, on June 12, for $5,000.'
const check = (quote: string, text = transcript) => {
  const source = { ...supportedOpeningSource, exhibitId: 'E-003', text }
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', explanation: 'The transcript records this statement.', citations: [{ exhibitId: 'E-003', paragraph: 1 }] }] }), [{ id: 'content:1', text: `E-003 records "${quote}".` }], [source])
}
describe('printed transcript line labels', () => {
  it('matches words across consecutively numbered transcript lines', () => {
    const result = check('told me 24 percent. Guaranteed 24 percent')
    expect(result.status).toBe('passed')
    expect(result.findings[0].citations[0]).toMatchObject({ quote: transcript, startOffset: 0, endOffset: transcript.length, paragraph: 1 })
    expect(sourceParagraphs({ ...supportedOpeningSource, text: transcript })[0].text).toBe(transcript)
  })
  it('preserves numeric speech after a printed line label', () => {
    expect(check('told me 24 percent. 24 percent was guaranteed', transcript.replace('Guaranteed 24 percent.', '24 percent was guaranteed.')).status).toBe('passed')
  })
  it('also accepts an exact quotation retaining printed labels', () => {
    expect(check('told me 24 percent. 12 Guaranteed 24 percent').status).toBe('passed')
  })
  it.each(['told 24 percent. Guaranteed 24 percent', 'told me 25 percent. Guaranteed 24 percent', 'In 2024, on June 12, for $5,000', 'In 2023, on June 13, for $5,000', 'In 2023, on June 12, for $6,000'])('still rejects altered spoken words or numbers: %s', quote => {
    expect(check(quote).status).toBe('failed')
  })
  it('preserves question and answer boundaries', () => {
    expect(check('Guaranteed 24 percent. In 2023, on June 12, for $5,000').status).toBe('failed')
  })
  it('does not strip arbitrary numbers from unnumbered records or lists', () => {
    expect(check('told me 24 percent. Guaranteed 24 percent', 'The witness told me 24 percent.\n12 Guaranteed 24 percent.').status).toBe('failed')
    expect(check('units were sold. units were returned', '10 units were ordered.\n11 units were sold.\n12 units were returned.').status).toBe('failed')
  })
  it('does not borrow inaccessible transcript lines', () => {
    const source = { ...supportedOpeningSource, exhibitId: 'E-003', text: transcript, authorizedPassages: [] }
    const result = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [{ exhibitId: 'E-003', paragraph: 1 }] }] }), [{ id: 'content:1', text: 'E-003 records "told me 24 percent. Guaranteed 24 percent".' }], [source])
    expect(result.status).toBe('failed')
  })
})
