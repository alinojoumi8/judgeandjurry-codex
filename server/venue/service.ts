import type { CaseStore } from '../db'
import { AnalysisService } from '../analysis/service'
import type { AnalysisArtifact } from '../analysis/types'
import { JURY_PROFILE_ALGORITHM_VERSION, MIN_AWARD_SAMPLE, MIN_SURVEY_RESPONDENTS, MIN_VERDICT_SAMPLE } from './constants'
import { validateDatasetImport } from './datasets'
import { eligibilityRuleForMatter } from './eligibility'
import { pinnedJuryProfileSchema, pinProfile, samplePanel } from './panelSampler'
import { buildProfileContent } from './profile'
import { buildProfileSchema, samplePanelSchema, type BuildProfileInput, type SamplePanelInput } from './schemas'
import type {
  JuryProfileContent, JuryProfileState, JuryProfileVersion, JuryProfileView, PinnedJuryProfile, SamplePanelResult, VenueDataset, VenueDatasetSummary,
} from './types'
export type { JuryProfileState, JuryProfileVersion, JuryProfileView } from './types'
import { evidenceHashesOf } from './verify'

const notFound = (what: string) => new Error(`${what} not found`)

export class VenueService {
  private readonly store: CaseStore
  private readonly analysis: AnalysisService

  constructor(store: CaseStore, analysis: AnalysisService = new AnalysisService(store)) {
    this.store = store
    this.analysis = analysis
  }

  // ---- datasets ----
  importDataset(matterId: string, input: unknown): VenueDatasetSummary {
    this.store.getMatter(matterId)
    const created = this.store.venue.create(matterId, validateDatasetImport(input))
    return this.withUse(matterId, [created])[0] as VenueDatasetSummary
  }

  listDatasets(matterId: string): VenueDatasetSummary[] {
    this.store.getMatter(matterId)
    return this.withUse(matterId, this.store.venue.listSummaries(matterId))
  }

  getDataset(matterId: string, datasetId: string): VenueDataset {
    this.store.getMatter(matterId)
    const dataset = this.store.venue.find(matterId, datasetId)
    if (!dataset) throw notFound('Dataset')
    return { ...dataset, usedByApprovedProfile: this.withUse(matterId, [dataset])[0]?.usedByApprovedProfile ?? false }
  }

  // A dataset an approved profile was built from cannot be deleted: the profile
  // could no longer be checked against its data. Withdraw the profile by
  // approving a newer one that does not use the dataset, then delete.
  deleteDataset(matterId: string, datasetId: string): void {
    this.store.getMatter(matterId)
    const dataset = this.store.venue.summary(matterId, datasetId)
    if (!dataset) throw notFound('Dataset')
    if (this.hashesUsedByApprovedProfiles(matterId).has(dataset.datasetHash)) {
      throw Object.assign(
        new Error(`The dataset "${dataset.name}" was used to build an approved jury profile, so it cannot be deleted. Approve a newer profile that does not use it first.`),
        { status: 409 },
      )
    }
    this.store.venue.delete(matterId, datasetId)
  }

  // ---- profile ----
  buildProfile(matterId: string, rawInput: unknown): JuryProfileView {
    const input: BuildProfileInput = buildProfileSchema.parse(rawInput ?? {})
    this.store.getMatter(matterId)
    const all = this.store.venue.list(matterId)
    const chosen = input.datasetIds
      ? input.datasetIds.map((id) => all.find((dataset) => dataset.id === id) ?? (() => { throw notFound(`Dataset ${id}`) })())
      : all
    if (chosen.length === 0) throw new Error('Import at least one dataset before building a jury profile.')
    const { rule, rulePackHash } = eligibilityRuleForMatter(this.store, matterId)
    const { content, rejected } = buildProfileContent({
      datasets: chosen, assumptions: input.assumptions, seed: input.seed, eligibilityRule: rule,
      cultureNotes: input.cultureNotes, evidenceHashes: evidenceHashesOf(this.store, matterId),
    })
    const saved = this.analysis.saveDraft({
      matterId, kind: 'jury_profile', content, rejected,
      inputManifest: {
        evidenceHashes: [], datasetHashes: content.build.datasetHashes, algorithmVersion: JURY_PROFILE_ALGORITHM_VERSION,
        ...(rulePackHash ? { rulePackHash } : {}),
      },
    })
    return this.view(saved)
  }

  state(matterId: string): JuryProfileState {
    this.store.getMatter(matterId)
    const artifacts = this.analysis.list(matterId, { kind: 'jury_profile' })
    const approved = artifacts.find((artifact) => artifact.status === 'approved')
    const drafts = artifacts.filter((artifact) => artifact.status === 'draft')
    const current = approved ?? drafts[0]
    return {
      profile: current ? this.view(current) : null,
      versions: artifacts.map(toVersion),
      datasets: this.listDatasets(matterId),
      eligibilityNow: eligibilityRuleForMatter(this.store, matterId).rule,
      minimums: { verdictObservations: MIN_VERDICT_SAMPLE, awards: MIN_AWARD_SAMPLE, surveyRespondents: MIN_SURVEY_RESPONDENTS },
    }
  }

  getProfile(matterId: string, artifactId: string): JuryProfileView {
    return this.view(this.profileArtifact(matterId, artifactId))
  }

  approveProfile(matterId: string, artifactId: string): JuryProfileView {
    this.profileArtifact(matterId, artifactId)
    return this.view(this.analysis.approve(matterId, artifactId))
  }

  // A preview of synthetic jurors drawn from a profile's strata. It uses the
  // approved profile unless a specific version is named.
  sample(matterId: string, rawInput: unknown): SamplePanelResult {
    const input: SamplePanelInput = samplePanelSchema.parse(rawInput ?? {})
    this.store.getMatter(matterId)
    const artifact = input.artifactId
      ? this.profileArtifact(matterId, input.artifactId)
      : this.analysis.list(matterId, { kind: 'jury_profile' }).find((candidate) => candidate.status === 'approved')
    if (!artifact) throw new Error('There is no approved jury profile to sample from. Approve a profile first, or name a draft.')
    const content = artifact.content as JuryProfileContent
    return samplePanel({ profileHash: artifact.contentHash, strata: content.strata, seed: input.seed, count: input.count, label: content.noCalibration })
  }

  // Resolves the profile a run asks for. Only an approved, current profile can be
  // pinned, and the pin keeps the strata so reading the run later never consults
  // the current profile.
  resolvePin(matterId: string, profileHash: string): PinnedJuryProfile {
    this.store.getMatter(matterId)
    const artifact = this.analysis.list(matterId, { kind: 'jury_profile' }).find((candidate) => candidate.status === 'approved' && candidate.contentHash === profileHash)
    if (!artifact) throw new Error('That jury profile is not the approved jury profile for this case, so it cannot be used for a run.')
    const freshness = this.analysis.freshness(artifact)
    if (freshness.status === 'out_of_date') throw new Error(`The approved jury profile is out of date and cannot be used for a run: ${freshness.reasons.join(' ')}`)
    const content = artifact.content as JuryProfileContent
    if (!content.strata.length) throw new Error('The approved jury profile has no attitude strata with enough respondents, so it has nothing to sample jurors from.')
    return pinnedJuryProfileSchema.parse(pinProfile(artifact.contentHash, content.strata))
  }

  private profileArtifact(matterId: string, artifactId: string): AnalysisArtifact {
    const artifact = this.analysis.get(matterId, artifactId)
    if (artifact.kind !== 'jury_profile') throw notFound('Jury profile')
    return artifact
  }

  private view(artifact: AnalysisArtifact): JuryProfileView {
    return {
      ...toVersion(artifact), content: artifact.content as JuryProfileContent, rejected: artifact.rejected,
      freshness: this.analysis.freshness(artifact),
    }
  }

  private hashesUsedByApprovedProfiles(matterId: string): Set<string> {
    const hashes = new Set<string>()
    for (const artifact of this.analysis.list(matterId, { kind: 'jury_profile' })) {
      if (artifact.status !== 'approved') continue
      for (const hash of artifact.inputManifest.datasetHashes ?? []) hashes.add(hash)
    }
    return hashes
  }

  private withUse<T extends VenueDatasetSummary>(matterId: string, datasets: T[]): T[] {
    const used = this.hashesUsedByApprovedProfiles(matterId)
    return datasets.map((dataset) => ({ ...dataset, usedByApprovedProfile: used.has(dataset.datasetHash) }))
  }
}

const toVersion = (artifact: AnalysisArtifact): JuryProfileVersion => ({
  id: artifact.id, version: artifact.version, status: artifact.status, createdAt: artifact.createdAt,
  ...(artifact.approvedAt ? { approvedAt: artifact.approvedAt } : {}), contentHash: artifact.contentHash,
})
