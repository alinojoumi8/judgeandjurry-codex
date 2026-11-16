import type { CaseStore } from '../db'
import type { AnalysisArtifact } from '../analysis/types'
import { damagesInputsHash, parseDamagesInputs } from './inputs'
import type { DamagesInputs } from './types'

// Where the damages artifacts live. Both kinds hold versioned, hash-verified
// content in the analysis store:
//   damages_model, subject "inputs": what the person entered (claimed amounts,
//     policy limit, assets, liens, fees, fault assumption, ...)
//   damages_model, subject "study": a finished F12 study with its inputs pinned
//   damages_psychology, subject "": a finished F13 study with its inputs pinned
// This is the one place that knows those names. Another feature (the case
// improvement plan) that wants damages signals should read `approvedDamagesStudy`.

export const inputsSubject = 'inputs'
export const studySubject = 'study'

export interface DamagesInputsContent { inputs: DamagesInputs; inputsHash: string }

export interface StoredInputs {
  artifact: AnalysisArtifact<DamagesInputsContent>
  inputs: DamagesInputs
  inputsHash: string
}

// The newest saved version of the inputs, whatever its status. A stored version whose hash no longer matches its content is refused.
export function latestInputs(store: Pick<CaseStore, 'analysis'>, matterId: string): StoredInputs | null {
  const [artifact] = store.analysis.list(matterId, { kind: 'damages_model', subjectKey: inputsSubject })
  if (!artifact) return null
  const content = artifact.content as DamagesInputsContent
  const inputs = parseDamagesInputs(content.inputs)
  if (damagesInputsHash(inputs) !== content.inputsHash) throw new Error('The saved damages inputs do not match their recorded hash, so they cannot be used.')
  return { artifact: artifact as AnalysisArtifact<DamagesInputsContent>, inputs, inputsHash: content.inputsHash }
}

// The newest APPROVED damages study of a matter, or undefined. Read-only: the accessor other features use.
export function approvedDamagesStudy(store: Pick<CaseStore, 'analysis'>, matterId: string): AnalysisArtifact | undefined {
  return store.analysis.list(matterId, { kind: 'damages_model', subjectKey: studySubject, status: 'approved' })[0]
}
