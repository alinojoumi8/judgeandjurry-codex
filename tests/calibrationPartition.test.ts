import { describe, expect, it } from 'vitest'
import { partitionCalibration } from '../scripts/calibrationPartition'

const base = { request: { source: 'fictional' }, draft: { content: 'Actual source quotation.' }, expected: 'passed' }

describe('calibration execution keeps all obligations without repeating native controls', () => {
  it('defers only an exact unchanged native control payload', () => {
    const job = { id: 'calibration', ...base }
    const native = { id: 'native', ...base }
    const result = partitionCalibration([job], [native])
    expect(result.jobs).toEqual([])
    expect(result.deferred).toMatchObject([{ jobId: 'calibration', nativeControlIds: ['native'] }])
  })
  it('retains different expected results', () => {
    const job = { id: 'calibration', ...base, expected: 'failed' }
    expect(partitionCalibration([job], [{ id: 'native', ...base }]).jobs).toEqual([job])
  })
  it('retains a different validation contract', () => {
    const job = { id: 'calibration', ...base, validation: 'ballot_contract' }
    expect(partitionCalibration([job], [{ id: 'native', ...base }]).jobs).toEqual([job])
  })
  it('always retains every predeclared fresh author attempt', () => {
    const jobs = [1, 2, 3].map(attempt => ({ id: `fresh-${attempt}`, fresh: true, ...base }))
    const result = partitionCalibration(jobs, [{ id: 'native', ...base }])
    expect(result.jobs).toEqual(jobs)
    expect(result.deferred).toEqual([])
  })
  it('records all native aliases without changing or dropping required native controls', () => {
    const controls = ['one', 'two'].map(id => ({ id, ...base }))
    const snapshot = structuredClone(controls)
    const result = partitionCalibration([{ id: 'calibration', ...base }], controls)
    expect(result.deferred[0].nativeControlIds).toEqual(['one', 'two'])
    expect(controls).toEqual(snapshot)
  })
  it('preserves unmatched work and partitions each original job exactly once', () => {
    const jobs = [{ id: 'native-match', ...base }, { id: 'additional', ...base, draft: { content: 'Different current claim.' } }]
    const snapshot = structuredClone(jobs)
    const result = partitionCalibration(jobs, [{ id: 'native', ...base }])
    expect(result.jobs.map(job => job.id)).toEqual(['additional'])
    expect([...result.jobs.map(job => job.id), ...result.deferred.map(job => job.jobId)].sort()).toEqual(jobs.map(job => job.id).sort())
    expect(jobs).toEqual(snapshot)
  })
})
