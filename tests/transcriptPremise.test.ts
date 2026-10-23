import { expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const transcript = 'Fictional interview\nPage 10\n1 Q. What was said?\n2 A. I met Arin Vale, so Arin\n3 Vale is the main contact.\n4 They promised 24 percent.\n5 Q. Who paid?\n6 A. I paid $8,000.'
function check(quote: string, sourceText = transcript, exhibitId = 'E-003') {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', supportTypes: ['source'], explanation: 'The witness states these words.', citations: [{ exhibitId, paragraph: 1 }], recordCitations: [] }] }),
    [{ id: 'content:1', text: `The witness's recorded statement that “${quote}” (E-003).` }], [{ ...supportedOpeningSource, exhibitId: 'E-003', text: sourceText }])
}
it('uses the transcript comparison view for a reported quotation without changing saved source bytes', () => {
  const review = check('so Arin Vale is the main contact')
  expect(review.errors).toEqual([])
  expect(review.findings[0].citations[0]).toMatchObject({ quote: transcript, startOffset: 0, endOffset: transcript.length })
})
it.each(['so Arin Vale is the only contact', 'They promised 25 percent', 'I paid $9,000', '24 percent. I paid $8,000'])('rejects altered speech, numbers and joined question/answer turns: %s', quote => {
  expect(check(quote).status).toBe('failed')
})
it('does not erase numbers in ordinary records or accept a different source selector', () => {
  expect(check('so Arin Vale is the main contact', 'The account says so Arin\n3 Vale is the main contact.').status).toBe('failed')
  expect(check('so Arin Vale is the main contact', transcript, 'E-999').status).toBe('failed')
})
