import { describe, expect, it, vi } from 'vitest'
import { reviewWithRecordReferenceRetries } from '../scripts/pilotEvidence'

const invalid = { status: 'failed', validationErrors: ['content:1: record citation 24625448 is not an authorized visible contribution. Select an actual projected juror contribution or public submission event ID.'] }
const rejected = { status: 'failed', validationErrors: [] }
const valid = { status: 'passed', validationErrors: [] }
describe('checker record reference retries', () => {
 it('rechecks invalid references and retains the invalid review', async () => {
  const call=vi.fn().mockResolvedValueOnce(invalid).mockResolvedValue(valid)
  expect(await reviewWithRecordReferenceRetries(call)).toEqual({review:valid,priorReviews:[invalid]})
  expect(call).toHaveBeenCalledTimes(2)
 })
 it('does not retry a substantive failed verdict', async () => {
  const call=vi.fn().mockResolvedValue(rejected)
  expect(await reviewWithRecordReferenceRetries(call)).toEqual({review:rejected,priorReviews:[]})
  expect(call).toHaveBeenCalledTimes(1)
 })
 it('stops at the bound even if references stay invalid', async () => {
  const call=vi.fn().mockResolvedValue(invalid)
  const result=await reviewWithRecordReferenceRetries(call,3)
  expect(result.review).toBe(invalid)
  expect(result.priorReviews).toHaveLength(3)
  expect(call).toHaveBeenCalledTimes(4)
 })
 it('does not retry an unrelated validation error', async () => {
  const row={status:'failed',validationErrors:['content:1: invalid source quotation']}
  const call=vi.fn().mockResolvedValue(row)
  expect((await reviewWithRecordReferenceRetries(call)).priorReviews).toEqual([])
  expect(call).toHaveBeenCalledTimes(1)
 })
})
