import express from 'express'
import { z } from 'zod'

import type { CaseStore } from '../db'
import {
  analyseDeliberation, deliberationAlgorithmVersion, deliberationTable, forecastLabel,
  type DeliberationTable, type DeliberationView, type TableRunInput,
} from '../deliberationAnalysis'
import { isJudgeDecided } from '../procedureAdapters'
import type { TrialRun } from '../trialEngineTypes'

// Deliberation forecast (F9), for the owner audit view. Like the rest of the
// owner audit, a run's private votes, straw polls and who-moved-whom are
// available once the run has completed. A live or unfinished run reports that
// they are not available yet and shows none. Every value is labelled simulated.

export interface DeliberationResponse {
  runId: string
  simulated: true
  label: string
  algorithmVersion: string
  enabled: boolean
  available: boolean
  reason?: string
  // Whether the simulated jurors were shown the straw-poll counts. Null when the forecast was off.
  strawPollCounts: 'visible' | 'hidden' | null
  view?: DeliberationView
}

export interface DeliberationTableResponse {
  matterId: string
  simulated: true
  label: string
  algorithmVersion: string
  filters: { issueId?: string; panelSize?: number; baseRunId?: string }
  // Completed jury runs read, and how many of those recorded straw polls.
  runsRead: number
  runsWithStrawPolls: number
  table: DeliberationTable
}

const querySchema = z.object({
  issueId: z.string().min(1).max(200).optional(),
  baseRunId: z.string().min(1).max(200).optional(),
  panelSize: z.coerce.number().int().min(1).max(12).optional(),
})

export function createDeliberationRouter(store: CaseStore): express.Router {
  const router = express.Router()

  const juryIssues = (run: TrialRun) => store.workflow.getCaseModel(run.caseModelId).decisionIssues
    .filter((issue) => !isJudgeDecided(issue, run.config.framework))

  router.get('/trials/:runId/deliberation', (request, response) => {
    const runId = request.params.runId
    if (typeof runId !== 'string') throw new Error('Missing route parameter: runId')
    const run = store.workflow.getTrialRun(runId)
    const base = {
      runId: run.id, simulated: true as const, label: forecastLabel, algorithmVersion: deliberationAlgorithmVersion,
      enabled: Boolean(run.config.deliberationForecast), strawPollCounts: run.config.deliberationForecast ? run.config.strawPollCounts ?? 'visible' as const : null,
    }
    if (!run.config.deliberationForecast) {
      response.json({ ...base, available: false, reason: 'The deliberation forecast was not switched on for this run.' } satisfies DeliberationResponse)
      return
    }
    if (run.status !== 'completed') {
      response.json({ ...base, available: false, reason: 'Private votes, straw polls and who moved whom appear in the owner audit view once the run has completed.' } satisfies DeliberationResponse)
      return
    }
    const issues = juryIssues(run)
    const decisions = store.workflow.getDecisionSheet(run.id)?.decisions
    const body: DeliberationResponse = {
      ...base, available: true,
      view: analyseDeliberation({
        runId: run.id, jurorIds: store.workflow.listJurorProfiles(run.id).map((profile) => profile.actorId),
        issues: issues.map((issue) => ({ id: issue.id, label: issue.label, permittedOutcomes: issue.permittedOutcomes })),
        ballots: store.workflow.listBallots(run.id), events: store.workflow.listTrialEvents(run.id),
        decisions: decisions?.map(({ issueId, outcome, complete, rule, warnings }) => ({ issueId, outcome, complete, rule, warnings })),
      }),
    }
    response.json(body)
  })

  // How often each final split occurs across the completed runs of a matter, and
  // how initial splits turn into final outcomes. Counts only: no juror is named.
  router.get('/matters/:matterId/deliberation/table', (request, response) => {
    const matterId = request.params.matterId
    if (typeof matterId !== 'string') throw new Error('Missing route parameter: matterId')
    store.getMatter(matterId)
    const filters = querySchema.parse(request.query)
    const runs = store.workflow.listTrialRuns(matterId)
      .filter((run) => run.status === 'completed' && (!filters.baseRunId || run.id === filters.baseRunId || run.parentRunId === filters.baseRunId))
    const inputs: TableRunInput[] = []
    for (const run of runs) {
      const jurorIds = store.workflow.listJurorProfiles(run.id).map((profile) => profile.actorId)
      if (jurorIds.length === 0) continue
      const sheet = store.workflow.getDecisionSheet(run.id)
      inputs.push({
        runId: run.id, seed: run.seed, status: run.status, jurorIds,
        issues: juryIssues(run).map((issue) => ({ id: issue.id, permittedOutcomes: issue.permittedOutcomes })),
        ballots: store.workflow.listBallots(run.id),
        decisions: sheet?.decisions.map(({ issueId, outcome, complete, rule, warnings }) => ({ issueId, outcome, complete, rule, warnings })),
        strawPolls: Boolean(run.config.deliberationForecast),
      })
    }
    const body: DeliberationTableResponse = {
      matterId, simulated: true, label: forecastLabel, algorithmVersion: deliberationAlgorithmVersion, filters,
      runsRead: inputs.length, runsWithStrawPolls: inputs.filter((input) => input.strawPolls).length,
      table: deliberationTable(inputs, { issueId: filters.issueId, panelSize: filters.panelSize }),
    }
    response.json(body)
  })

  return router
}
