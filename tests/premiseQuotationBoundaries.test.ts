import { expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const sources = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'There were no withdrawals of cash sent back to ExampleCo. All withdrawals covered fees.' }, { ...supportedOpeningSource, exhibitId: 'E-002', text: 'A different report describes an investment.' }]
function check(text: string) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', supportTypes: ['source', 'analysis'], explanation: 'Document wording and separate assessment.', citations: sources.map(source => ({ exhibitId: source.exhibitId, paragraph: 1 })), recordCitations: [] }] }), [{ id: 'content:1', text }], sources)
}
it.each(['“', '"'])('checks quoted nominal premises without treating the opening %s as a source word', open => {
  const close = open === '“' ? '”' : '"'
  const text = `Avery's statement that ${open}There were no withdrawals of cash sent back to ExampleCo. All withdrawals covered fees${close} concerns reported activity, not knowledge (E-001).`
  expect(check(text).errors).toEqual([])
  expect(check(text.replace('(E-001)', '(E-002)')).status).toBe('failed')
  expect(check(text.replace('no withdrawals', 'several withdrawals')).status).toBe('failed')
})
