import { contextHash } from '../server/actorMemory'

interface CalibrationPayload {
  id: string
  fresh?: boolean
  request: unknown
  draft: unknown
  expected: string
  validation?: string
}

export const calibrationPayloadHash = (job: CalibrationPayload) => contextHash({
  request: job.request, draft: job.draft, expected: job.expected, validation: job.validation,
})

// Deferral is an execution dependency, never a passing grade or prior-run reuse.
export function partitionCalibration<T extends CalibrationPayload>(jobs: T[], nativeControls: CalibrationPayload[]) {
  const native = new Map<string, string[]>()
  for (const control of nativeControls) {
    const hash = calibrationPayloadHash(control)
    native.set(hash, [...(native.get(hash) ?? []), control.id])
  }
  const selected: T[] = []
  const deferred: Array<{ jobId: string; payloadHash: string; nativeControlIds: string[] }> = []
  for (const job of jobs) {
    const payloadHash = calibrationPayloadHash(job)
    const nativeControlIds = native.get(payloadHash)
    if (job.fresh || !nativeControlIds) selected.push(job)
    else deferred.push({ jobId: job.id, payloadHash, nativeControlIds })
  }
  return { jobs: selected, deferred }
}
