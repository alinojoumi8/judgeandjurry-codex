import type { CaseStore } from '../db'
import type { AnalysisArtifact } from '../analysis/types'
import { buildProfileContent, profileReproduces } from './profile'
import type { JuryProfileContent } from './types'

export function evidenceHashesOf(store: CaseStore, matterId: string): Set<string> {
  return new Set(store.listEvidence(matterId).flatMap((item) => (item.sha256 ? [item.sha256] : [])))
}

// A jury profile may become approved only if rebuilding it from its recorded
// datasets, assumptions, seed and eligibility snapshot gives exactly the stored
// content. That is what stops a profile carrying a figure that did not come from
// an imported row, whoever saved the draft. Whether the court rules have moved
// since is the freshness check's job, not this one's.
export function assertJuryProfileReproducible(store: CaseStore, artifact: AnalysisArtifact): void {
  const refuse = (reason: string): never => {
    throw new Error(`This jury profile cannot be approved: ${reason}`)
  }
  const content = artifact.content as Partial<JuryProfileContent> | null
  const build = content?.build
  if (!build || !Array.isArray(build.datasetHashes) || typeof build.seed !== 'string') {
    return refuse('it does not record the datasets, assumptions and seed it was built from, so its figures cannot be checked.')
  }
  const datasets = store.venue.list(artifact.matterId)
  const used = build.datasetHashes.map((hash) => datasets.find((dataset) => dataset.datasetHash === hash))
  if (used.some((dataset) => dataset === undefined)) return refuse('a dataset it was built from is no longer in this case.')
  let rebuilt
  try {
    rebuilt = buildProfileContent({
      datasets: used.map((dataset) => dataset as NonNullable<typeof dataset>),
      assumptions: build.assumptions, seed: build.seed, eligibilityRule: build.eligibilityRule,
      cultureNotes: build.cultureNoteInputs, evidenceHashes: evidenceHashesOf(store, artifact.matterId),
    })
  } catch {
    return refuse('its recorded inputs no longer produce a profile.')
  }
  if (!profileReproduces(artifact, rebuilt)) {
    return refuse('its figures do not reproduce from its imported datasets, so some of them did not come from the data.')
  }
}
