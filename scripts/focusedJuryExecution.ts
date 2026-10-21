export type FocusedJuryJobResult = Record<string, unknown> & {
  id: string
  kind: 'control' | 'fresh'
  state: 'finished' | 'failed'
}
export type FocusedJuryExecution = {
  passed: boolean
  controlMismatches: string[]
  stoppedOnExecutionFailure: boolean
}

export async function runFocusedJuryJobs<C extends { id: string; expected: string }, F extends { id: string }>(
  controls: readonly C[], fresh: readonly F[],
  review: (job: C) => Promise<{ status: string }>,
  generate: (job: F) => Promise<unknown>,
  persist: (row: FocusedJuryJobResult) => Promise<void>,
): Promise<FocusedJuryExecution> {
  const controlMismatches: string[] = []
  for (const job of controls) {
    let row: FocusedJuryJobResult
    try {
      const result = await review(job)
      row = { id: job.id, kind: 'control', expected: job.expected, state: 'finished', review: result, expectedMatched: result.status === job.expected }
      if (!row.expectedMatched) controlMismatches.push(job.id)
    } catch (error) {
      row = { id: job.id, kind: 'control', expected: job.expected, state: 'failed', error: String(error) }
      await persist(row)
      return { passed: false, controlMismatches, stoppedOnExecutionFailure: true }
    }
    await persist(row)
  }
  if (controlMismatches.length) return { passed: false, controlMismatches, stoppedOnExecutionFailure: false }
  for (const job of fresh) {
    let row: FocusedJuryJobResult
    try { row = { id: job.id, kind: 'fresh', state: 'finished', generated: await generate(job) } }
    catch (error) {
      row = { id: job.id, kind: 'fresh', state: 'failed', error: String(error) }
      await persist(row)
      return { passed: false, controlMismatches, stoppedOnExecutionFailure: true }
    }
    await persist(row)
  }
  return { passed: true, controlMismatches, stoppedOnExecutionFailure: false }
}
