import { z } from 'zod'

import type { CaseStore } from '../db'
import type { CaseModelV1 } from '../trialEngineTypes'
import { analysisAudienceSchema, analysisInputManifestSchema, analysisKindSchema } from './schemas'
import { partitionSourcedItems, type SourcedItem } from './sourceCheck'
import {
  analysisKinds,
  type AnalysisArtifact,
  type AnalysisAudience,
  type AnalysisFreshness,
  type AnalysisInputManifest,
  type AnalysisKind,
  type AnalysisRejectedItem,
  type AnalysisViewer,
} from './types'

export interface SaveAnalysisInput<T = unknown> {
  matterId: string
  kind: AnalysisKind
  subjectKey?: string
  audience?: AnalysisAudience
  caseModelId?: string
  inputManifest: AnalysisInputManifest
  content: T
  rejected?: AnalysisRejectedItem[]
}

type DraftInput = Omit<SaveAnalysisInput, 'content' | 'rejected'>

// The current inputs a manifest is compared with. Compute it once per request.
export interface FreshnessContext {
  evidenceHashes: Set<string>
  caseModelVersion?: number
  ledgers: Array<{ id: string; trialRunId?: string }>
  runIds: Set<string>
}

const notAvailable = 'Analysis artifacts are not available to this participant.'

export class AnalysisService {
  private readonly store: CaseStore

  constructor(store: CaseStore) {
    this.store = store
  }

  saveDraft<T>(input: SaveAnalysisInput<T>): AnalysisArtifact<T> {
    return this.save(input, 'draft') as AnalysisArtifact<T>
  }

  saveFailed(input: DraftInput & { reason: string }): AnalysisArtifact {
    const { reason, ...rest } = input
    return this.save({ ...rest, content: {}, rejected: [{ item: null, reason }] }, 'failed')
  }

  // Runs the free source check. Accepted items become the content; failures are
  // stored in `rejected` so they stay visible after a reload.
  saveSourcedDraft<T extends SourcedItem>(input: DraftInput & { items: readonly unknown[] }): AnalysisArtifact<{ items: T[] }> {
    const { items, ...rest } = input
    this.store.getMatter(input.matterId)
    const { accepted, rejected } = partitionSourcedItems<T>(items, this.store.listEvidence(input.matterId))
    return this.save({ ...rest, content: { items: accepted }, rejected }, 'draft') as AnalysisArtifact<{ items: T[] }>
  }

  get(matterId: string, artifactId: string): AnalysisArtifact {
    this.store.getMatter(matterId)
    const artifact = this.store.analysis.find(matterId, artifactId)
    if (!artifact) throw new Error('Analysis artifact not found')
    return artifact
  }

  // Owner review: every status.
  list(matterId: string, filter: { kind?: AnalysisKind; subjectKey?: string } = {}): AnalysisArtifact[] {
    this.store.getMatter(matterId)
    return this.store.analysis.list(matterId, filter)
  }

  approve(matterId: string, artifactId: string): AnalysisArtifact {
    const artifact = this.get(matterId, artifactId)
    if (artifact.status !== 'draft') throw new Error(`Only a draft analysis artifact can be approved; this one is ${artifact.status}.`)
    const freshness = this.freshness(artifact)
    if (freshness.status === 'out_of_date') {
      throw new Error(`This analysis is out of date and cannot be approved: ${freshness.reasons.join(' ')}`)
    }
    return this.store.analysis.approve(matterId, artifactId)
  }

  // The only read path for later features: approved artifacts the viewer may see.
  // Anything that is not a well-formed owner or party viewer is refused.
  approvedFor(viewer: AnalysisViewer, matterId: string, kind?: AnalysisKind): AnalysisArtifact[] {
    const scope = viewerScope(viewer)
    if (kind !== undefined && !analysisKinds.includes(kind)) throw new Error('Unknown analysis kind.')
    this.store.getMatter(matterId)
    const approved = this.store.analysis.list(matterId, { kind, status: 'approved' })
    if (scope.role === 'owner') return approved
    return approved.filter((artifact) => artifact.audience === 'party' && artifact.subjectKey === scope.partyId)
  }

  freshnessContext(matterId: string): FreshnessContext {
    const models = this.store.workflow.listCaseModels(matterId)
    const current = models.find((model) => model.status === 'approved') ?? models[0]
    return {
      evidenceHashes: new Set(this.store.listEvidence(matterId).flatMap((item) => (item.sha256 ? [item.sha256] : []))),
      caseModelVersion: current?.version,
      ledgers: this.store.workflow.listAdmissionLedgers(matterId).map((ledger) => ({ id: ledger.id, trialRunId: ledger.trialRunId })),
      runIds: new Set(this.store.workflow.listTrialRuns(matterId).map((run) => run.id)),
    }
  }

  // Compares only the inputs the manifest names. Never regenerates anything and
  // never puts document text in a reason.
  freshness(artifact: AnalysisArtifact, context: FreshnessContext = this.freshnessContext(artifact.matterId)): AnalysisFreshness {
    const manifest = artifact.inputManifest
    const reasons: string[] = []
    const notChecked: string[] = []

    if (manifest.evidenceHashes?.length) {
      const used = new Set(manifest.evidenceHashes)
      const removed = [...used].filter((hash) => !context.evidenceHashes.has(hash)).length
      const added = [...context.evidenceHashes].filter((hash) => !used.has(hash)).length
      if (removed) reasons.push(`${removed} source document${removed === 1 ? '' : 's'} used for this analysis ${removed === 1 ? 'is' : 'are'} no longer current evidence in this matter.`)
      if (added) reasons.push(`${added} source document${added === 1 ? ' has' : 's have'} been added to this matter since this analysis was prepared.`)
    }

    if (manifest.caseModelVersion !== undefined && manifest.caseModelVersion !== context.caseModelVersion) {
      reasons.push(context.caseModelVersion === undefined
        ? `This analysis used case model version ${manifest.caseModelVersion}, but the matter has no case model.`
        : `The case model has changed: this analysis used version ${manifest.caseModelVersion} and the current version is ${context.caseModelVersion}.`)
    }

    if (manifest.admissionLedgerId !== undefined) {
      const own = context.ledgers.find((ledger) => ledger.id === manifest.admissionLedgerId)
      if (!own) reasons.push('The admission ledger used for this analysis no longer exists.')
      else if (own.trialRunId) notChecked.push('Admission ledger: it belongs to a single run, so it is not compared with the matter-wide ledger.')
      else if (context.ledgers.find((ledger) => !ledger.trialRunId)?.id !== own.id) reasons.push('A newer admission ledger has been saved since this analysis was prepared.')
    }

    if (manifest.runIds?.length) {
      const missing = manifest.runIds.filter((id) => !context.runIds.has(id)).length
      if (missing) reasons.push(`${missing} run${missing === 1 ? '' : 's'} used for this analysis no longer ${missing === 1 ? 'exists' : 'exist'}.`)
    }

    if (manifest.rulePackHash !== undefined) notChecked.push('Rule pack: no current rule pack is available to compare with.')
    if (manifest.juryProfileHash !== undefined) notChecked.push('Jury profile: no current jury profile is available to compare with.')

    return { status: reasons.length ? 'out_of_date' : 'current', reasons, notChecked }
  }

  private save(input: SaveAnalysisInput, status: 'draft' | 'failed'): AnalysisArtifact {
    this.store.getMatter(input.matterId)
    const parsed = parseHeader(input)
    const manifest = { ...parsed.inputManifest, evidenceHashes: [...new Set(parsed.inputManifest.evidenceHashes)].sort() }
    const subjectKey = input.subjectKey ?? ''
    if (typeof subjectKey !== 'string') throw new Error('The analysis subject must be text.')
    if (input.content === undefined) throw new Error('An analysis artifact needs content.')

    const model = input.caseModelId === undefined ? undefined : this.caseModel(input.matterId, input.caseModelId)
    if (model && manifest.caseModelVersion !== undefined && manifest.caseModelVersion !== model.version) {
      throw new Error(`The manifest case model version ${manifest.caseModelVersion} does not match the case model's version ${model.version}.`)
    }
    if (manifest.admissionLedgerId !== undefined
      && !this.store.workflow.listAdmissionLedgers(input.matterId).some((ledger) => ledger.id === manifest.admissionLedgerId)) {
      throw new Error('The admission ledger does not belong to this matter.')
    }
    if (manifest.runIds?.length) {
      const runs = new Set(this.store.workflow.listTrialRuns(input.matterId).map((run) => run.id))
      if (manifest.runIds.some((id) => !runs.has(id))) throw new Error('A run in the manifest does not belong to this matter.')
    }
    if (manifest.evidenceHashes.length) {
      const current = new Set(this.store.listEvidence(input.matterId).flatMap((item) => (item.sha256 ? [item.sha256] : [])))
      if (manifest.evidenceHashes.some((hash) => !current.has(hash))) {
        throw new Error('An evidence hash in the manifest is not on current evidence in this matter.')
      }
    }
    if (parsed.audience === 'party') {
      if (!model) throw new Error('A party-audience analysis needs the case model that defines the party.')
      if (!model.parties.some((party) => party.id === subjectKey)) throw new Error('A party-audience analysis needs a subject that is a party of the case model.')
    }

    return this.store.analysis.create({
      matterId: input.matterId, caseModelId: input.caseModelId, kind: parsed.kind, subjectKey, status,
      audience: parsed.audience, inputManifest: manifest, content: input.content, rejected: input.rejected ?? [],
    })
  }

  private caseModel(matterId: string, caseModelId: string): CaseModelV1 {
    const model = this.store.workflow.listCaseModels(matterId).find((candidate) => candidate.id === caseModelId)
    if (!model) throw new Error('The case model does not belong to this matter.')
    return model
  }
}

function parseHeader(input: SaveAnalysisInput) {
  try {
    return z.object({
      kind: analysisKindSchema, audience: analysisAudienceSchema.default('owner'), inputManifest: analysisInputManifestSchema,
    }).parse({ kind: input.kind, audience: input.audience, inputManifest: input.inputManifest })
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid analysis artifact: ${error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}`)
    }
    throw error
  }
}

function viewerScope(viewer: unknown): { role: 'owner' } | { role: 'party'; partyId: string } {
  if (viewer && typeof viewer === 'object') {
    const { role, partyId } = viewer as { role?: unknown; partyId?: unknown }
    if (role === 'owner') return { role }
    if (role === 'party' && typeof partyId === 'string' && partyId.trim() !== '') return { role, partyId }
  }
  throw new Error(notAvailable)
}
