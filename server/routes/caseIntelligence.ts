import express from 'express'

import type { CaseIntelligence } from '../analysis/intelligenceJobs'
import type { AnalysisJobService } from '../analysis/jobs'
import { createChronologyRouter } from './chronology'
import { createEvidenceIndexRouter } from './evidenceIndex'
import { createExpertRouter } from './experts'

// One mount for the three M3 features: chronology, evidence index, experts.
export function createCaseIntelligenceRouter(intelligence: CaseIntelligence, jobs: AnalysisJobService): express.Router {
  const router = express.Router()
  router.use(createChronologyRouter(intelligence.chronology, jobs))
  router.use(createEvidenceIndexRouter(intelligence.evidenceIndex, jobs))
  router.use(createExpertRouter(intelligence.experts, jobs))
  return router
}
