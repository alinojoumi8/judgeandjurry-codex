import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'

const check = (text: string) => parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', explanation: 'A statement about the scope of this assessment.', citations: [] }] }), [{ id: 'content:1', text }], [])
describe('negated inference of evidence absence', () => {
  it.each(['imply', 'mean', 'establish'])('preserves does not %s that evidence is absent', verb => {
    expect(check(`This sufficiency assessment does not ${verb} that other evidence does not exist.`).status).toBe('passed')
  })
  it.each([
    'Other evidence does not exist.',
    'This assessment does not imply that other evidence does not exist, but no independent evidence exists.',
    'This assessment does not mean that other evidence does not exist, but no independent evidence exists.',
  ])('still rejects a separate affirmative absence claim: %s', text => {
    expect(check(text).status).toBe('failed')
  })
})
