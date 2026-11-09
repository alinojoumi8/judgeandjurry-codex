import type { CaseStore } from '../db'
import type { AnalysisService } from './service'
import type { AnalysisArtifact, AnalysisKind } from './types'

// Saved artifacts are immutable, so a review decision is a new draft version
// that copies the content of the latest draft or approved version and changes
// one thing. Older versions stay as the audit trail.
export interface ArtifactViews<T> {
  approved?: AnalysisArtifact<T>
  // The newest draft, shown only while it is newer than the approved version.
  draft?: AnalysisArtifact<T>
  // Whichever is newest.
  latest?: AnalysisArtifact<T>
}

export function artifactViews<T>(analysis: AnalysisService, matterId: string, kind: AnalysisKind, subjectKey = ''): ArtifactViews<T> {
  const versions = analysis.list(matterId, { kind, subjectKey }).filter((artifact) => artifact.status === 'draft' || artifact.status === 'approved')
  const approved = versions.find((artifact) => artifact.status === 'approved') as AnalysisArtifact<T> | undefined
  const draft = versions.find((artifact) => artifact.status === 'draft' && (!approved || artifact.version > approved.version)) as AnalysisArtifact<T> | undefined
  return { approved, draft, latest: draft ?? approved }
}

// The newest case model version, approved or not. Preparation work (issue links,
// the evidence matrix, disputed facts) builds on the version being worked on, so
// a suggestion accepted into a new draft version shows at once. Artifacts here
// do not pin a case model version: accepting a suggestion or promoting a fact
// makes a new version by design, and pinning would mark the artifact in use as
// out of date the moment its own result is approved.
export function latestCaseModel(store: CaseStore, matterId: string) {
  return store.workflow.listCaseModels(matterId)[0]
}
