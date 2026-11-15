import express from 'express'

import type { CaseStore } from '../db'
import { buildCognitionView, cognitionHeuristicVersion, heuristicNote, simulatedLabel, type CognitionView } from '../jurorCognition'

// Juror cognition for the owner audit view (F8). Like the rest of the owner audit,
// a run's private appraisals are available once the run has completed; a live or
// unfinished run reports that they are not available yet and shows none. Every
// value is labelled simulated.
export interface CognitionResponse {
  runId: string
  simulated: true
  label: string
  heuristicVersion: string
  heuristicNote: string
  enabled: boolean
  available: boolean
  reason?: string
  ballotContract: 'v1' | 'v2'
  view?: CognitionView
}

export function createCognitionRouter(store: CaseStore): express.Router {
  const router = express.Router()

  router.get('/trials/:runId/cognition', (request, response) => {
    const runId = request.params.runId
    if (typeof runId !== 'string') throw new Error('Missing route parameter: runId')
    const run = store.workflow.getTrialRun(runId)
    const base = {
      runId: run.id, simulated: true as const, label: simulatedLabel, heuristicVersion: cognitionHeuristicVersion, heuristicNote,
      enabled: Boolean(run.config.jurorCognition), ballotContract: run.config.ballotContract === 'v2' ? 'v2' as const : 'v1' as const,
    }
    if (!run.config.jurorCognition) {
      response.json({ ...base, available: false, reason: 'Juror cognition was not switched on for this run.' } satisfies CognitionResponse)
      return
    }
    if (run.status !== 'completed') {
      response.json({ ...base, available: false, reason: 'Private juror appraisals appear in the owner audit view once the run has completed.' } satisfies CognitionResponse)
      return
    }
    const events = store.workflow.listTrialEvents(run.id)
    const created = events.find((event) => event.type === 'run_created')
    const actors = (created?.payload.actors ?? []) as Array<{ id: string; role: string }>
    const body: CognitionResponse = {
      ...base, available: true,
      view: buildCognitionView({ runId: run.id, events, profiles: store.workflow.listJurorProfiles(run.id), foreperson: actors.find((actor) => actor.role === 'foreperson')?.id }),
    }
    response.json(body)
  })

  return router
}
