export const analysisKinds = [
  'chronology', 'case_map', 'evidence_index', 'expert_assessment', 'case_summary', 'jury_profile',
  'forecast', 'damages_model', 'damages_psychology', 'improvement_plan', 'style_study',
] as const

export type AnalysisKind = (typeof analysisKinds)[number]
export const analysisStatuses = ['draft', 'approved', 'superseded', 'failed'] as const
export type AnalysisStatus = (typeof analysisStatuses)[number]
// Analysis is preparation material. There is deliberately no juror or witness audience.
export const analysisAudiences = ['owner', 'party'] as const
export type AnalysisAudience = (typeof analysisAudiences)[number]
export const analysisArtifactSchemaVersion = 1

export interface AnalysisInputManifest {
  caseModelVersion?: number
  admissionLedgerId?: string
  evidenceHashes: string[]
  rulePackHash?: string
  juryProfileHash?: string
  // Content hashes of the imported datasets a jury profile was built from.
  datasetHashes?: string[]
  runIds?: string[]
  promptVersion?: string
  algorithmVersion?: string
  // The seed a seeded study (a forecast) was computed from, so its numbers can be reproduced.
  seed?: string
  provider?: { name: string; model: string; mode: string }
  // Set only when the optional tier-2 model check was on for this artifact.
  modelCheck?: { promptVersion: string; batchSize: number }
}

export interface AnalysisRejectedItem {
  item: unknown
  reason: string
}

export interface AnalysisImportProvenance {
  originalArtifactId: string
  originalContentHash: string
  remappedReferences: true
}

export interface AnalysisArtifact<T = unknown> {
  id: string
  matterId: string
  caseModelId?: string
  kind: AnalysisKind
  subjectKey: string
  version: number
  status: AnalysisStatus
  schemaVersion: number
  audience: AnalysisAudience
  inputManifest: AnalysisInputManifest
  // IDs must appear only as JSON values, never as object keys: archive import
  // remaps ids by walking values only.
  content: T
  contentHash: string
  rejected: AnalysisRejectedItem[]
  importProvenance?: AnalysisImportProvenance
  createdAt: string
  approvedAt?: string
}

export interface VerifiedPassageRef {
  evidenceId: string
  paragraph: number
  quote: string
}

export type AnalysisViewer = { role: 'owner' } | { role: 'party'; partyId: string }

export interface AnalysisFreshness {
  status: 'current' | 'out_of_date'
  reasons: string[]
  notChecked: string[]
}
