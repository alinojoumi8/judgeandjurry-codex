import type { CaseStore } from '../db'
import type { TrialEngineService } from '../trialEngine'
import type { CaseModelV1, TrialRun, TrialRunConfig } from '../trialEngineTypes'
import type { JobContext } from './jobs'

// Runs a list of seeded runs of the approved case model one at a time, in order,
// as a job: the shape the forecast study uses (server/analysis/forecast.ts), shared
// here by the damages studies. A finished run is kept and never repeated, so a
// study that was interrupted, capped or failed continues where it stopped. Usage
// is counted at the cost-preview figure after each run, so the cap holds even for
// a provider that reports no usage. Runs never overlap.

export class StudyRunError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'StudyRunError'
    this.status = status
  }
}

export interface SeededRunSpec {
  // Stable name inside the study, for the error message ("seed-003 under per_diem").
  label: string
  config: TrialRunConfig
  // The stored run this spec already has, when one exists.
  existing?: TrialRun
}

export async function runSeededRuns(input: {
  context: JobContext
  engine: TrialEngineService
  store: CaseStore
  matterId: string
  model: CaseModelV1
  specs: SeededRunSpec[]
  callsPerRun: number
  tokensPerCall: number
  // True when an existing run with this seed was made with the settings this study needs.
  compatible: (run: TrialRun, spec: SeededRunSpec) => boolean
}): Promise<{ completed: boolean }> {
  const { context, engine, store, matterId, model, callsPerRun, tokensPerCall } = input
  let ledgerId = input.specs.map((spec) => spec.existing).find((run) => run?.admissionLedgerId)?.admissionLedgerId
    ?? store.workflow.listAdmissionLedgers(matterId).find((ledger) => !ledger.trialRunId)?.id
  // True only when the loop ran to the end. Reaching the cap on the last run aborts the signal after that run, so it does not clear this.
  let completed = true
  for (const spec of input.specs) {
    if (context.signal.aborted) { completed = false; break }
    let run = spec.existing
    if (run?.status === 'completed') continue
    if (!run) {
      const created = engine.createRun({ matterId, caseModelId: model.id, config: spec.config, admissionLedgerId: ledgerId })
      run = created.run
      ledgerId ??= run.admissionLedgerId
    } else if (!input.compatible(run, spec)) {
      throw new StudyRunError(`A run for ${spec.label} already exists with different settings or court rules. Start a new study with a new seed.`, 409)
    }
    try {
      const finished = await engine.runAutonomous(run.id)
      if (finished.run.status !== 'completed') throw new StudyRunError(`A run stopped at ${finished.run.phase.replaceAll('_', ' ')} with status ${finished.run.status}.`, 409)
    } catch (error) {
      // The run keeps its record. It is marked failed, so a resumed study picks it up again.
      const status = store.workflow.getTrialRun(run.id).status
      if (status !== 'completed' && status !== 'failed') store.workflow.updateTrialRun(run.id, { status: 'failed', error: error instanceof Error ? error.message : 'The run failed.' })
      throw error
    }
    context.recordUsage(callsPerRun, callsPerRun * tokensPerCall)
  }
  return { completed }
}
