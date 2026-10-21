import { describe, expect, it } from 'vitest'
import { runFocusedJuryJobs, type FocusedJuryJobResult } from '../scripts/focusedJuryExecution'

const controls = [{ id: 'positive-one', expected: 'passed' }, { id: 'negative', expected: 'failed' }, { id: 'positive-two', expected: 'passed' }]
const fresh = [{ id: 'author-one' }, { id: 'author-two' }]
function harness(statuses: (string | Error)[], authorFailure = false, persistFailure = false) {
  const reviewed: string[] = [], authored: string[] = [], saved: FocusedJuryJobResult[] = []
  const run = () => runFocusedJuryJobs(controls, fresh, async job => {
    const value = statuses[reviewed.length]
    reviewed.push(job.id)
    if (value instanceof Error) throw value
    return { status: value }
  }, async job => {
    authored.push(job.id)
    if (authorFailure) throw new Error('fictional author transport failure')
    return { content: 'fictional accepted response' }
  }, async row => {
    saved.push(row)
    if (persistFailure) throw new Error('fictional durable write failure')
  })
  return { run, reviewed, authored, saved }
}

describe('focused control diagnostics preserve the all-controls fresh gate', () => {
  it('collects all fixed controls after a semantic mismatch and starts no fresh authors', async () => {
    const h = harness(['failed', 'failed', 'passed'])
    expect(await h.run()).toEqual({ passed: false, controlMismatches: ['positive-one'], stoppedOnExecutionFailure: false })
    expect(h.reviewed).toEqual(controls.map(job => job.id))
    expect(h.saved.map(row => row.expectedMatched)).toEqual([false, true, true])
    expect(h.authored).toEqual([])
  })
  it('retains every mismatch when later controls match', async () => {
    const h = harness(['failed', 'passed', 'passed'])
    expect((await h.run()).controlMismatches).toEqual(['positive-one', 'negative'])
    expect(h.saved).toHaveLength(3)
    expect(h.authored).toEqual([])
  })
  it('starts the declared fresh jobs only after every fixed control matches', async () => {
    const h = harness(['passed', 'failed', 'passed'])
    expect((await h.run()).passed).toBe(true)
    expect(h.authored).toEqual(fresh.map(job => job.id))
    expect(h.saved.map(row => row.kind)).toEqual(['control', 'control', 'control', 'fresh', 'fresh'])
  })
  it('stops immediately on an actual control execution failure after a mismatch', async () => {
    const h = harness(['failed', new Error('fictional provider transport failure'), 'passed'])
    expect(await h.run()).toEqual({ passed: false, controlMismatches: ['positive-one'], stoppedOnExecutionFailure: true })
    expect(h.reviewed).toEqual(['positive-one', 'negative'])
    expect(h.saved[1].state).toBe('failed')
    expect(h.authored).toEqual([])
  })
  it('stops at an enforced budget/deadline error without starting later controls', async () => {
    const h = harness([new Error('declared HTTP budget exhausted'), 'failed', 'passed'])
    expect((await h.run()).stoppedOnExecutionFailure).toBe(true)
    expect(h.reviewed).toEqual(['positive-one'])
    expect(h.saved).toHaveLength(1)
    expect(h.authored).toEqual([])
  })
  it('persists a fresh execution failure and leaves later fresh attempts unexecuted', async () => {
    const h = harness(['passed', 'failed', 'passed'], true)
    expect((await h.run()).stoppedOnExecutionFailure).toBe(true)
    expect(h.authored).toEqual(['author-one'])
    expect(h.saved.at(-1)?.state).toBe('failed')
  })
  it('propagates persistence failure before any additional inference callback', async () => {
    const h = harness(['passed', 'failed', 'passed'], false, true)
    await expect(h.run()).rejects.toThrow('fictional durable write failure')
    expect(h.reviewed).toEqual(['positive-one'])
    expect(h.authored).toEqual([])
  })
})
