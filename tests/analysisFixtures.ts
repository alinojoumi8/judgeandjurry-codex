import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { AnalysisService } from '../server/analysis/service'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { CaseStore } from '../server/db'
import type { CaseModelV1, TrialRunConfig } from '../server/trialEngineTypes'

// Shared helpers for the analysis-artifact tests. Everything here is fictional.
const stores: CaseStore[] = []
const roots: string[] = []

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export function cleanupAnalysisFixtures(): void {
  for (const store of stores.splice(0)) {
    try { store.close() } catch { /* already closed by the test */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

export function trackStore(store: CaseStore): CaseStore {
  stores.push(store)
  return store
}

export function tempDir(prefix = 'triallens-analysis-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

export function fileStore(): { store: CaseStore; path: string; dir: string } {
  const dir = tempDir()
  const path = join(dir, 'case.db')
  return { store: trackStore(new CaseStore(path)), path, dir }
}

export function memoryStore(): CaseStore {
  return trackStore(new CaseStore(':memory:'))
}

export function rawDb(path: string): DatabaseSync {
  return new DatabaseSync(path)
}

export function addSource(store: CaseStore, matterId: string, name: string, text: string) {
  return store.addEvidence(matterId, {
    name, type: 'text', mimeType: 'text/plain', size: Buffer.byteLength(text), text,
    summary: '', tags: [], sha256: sha256(text), ingestionStatus: 'stored',
  })
}

export interface AnalysisWorld {
  store: CaseStore
  service: AnalysisService
  workflow: CaseWorkflowService
  matterId: string
  model: CaseModelV1
  evidence: ReturnType<typeof addSource>[]
}

// One matter with two hashed sources and an approved criminal-jury case model
// (parties: crown, accused-1).
export function buildWorld(store: CaseStore = memoryStore(), title = 'Analysis fixture'): AnalysisWorld {
  const matter = store.createMatter({ title, narrative: 'Count 1: Fictional allegation.' })
  const evidence = [
    addSource(store, matter.id, 'one.txt', 'First fictional record. It was delivered on a fictional date.'),
    addSource(store, matter.id, 'two.txt', 'Second fictional record. It describes a fictional meeting.'),
  ]
  const workflow = new CaseWorkflowService(store)
  const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, 'ontario_criminal_jury_v1', { witnesses: [] }).id)
  return { store, service: new AnalysisService(store), workflow, matterId: matter.id, model, evidence }
}

export function currentManifest(world: AnalysisWorld, extra: Record<string, unknown> = {}) {
  return {
    evidenceHashes: world.store.listEvidence(world.matterId).map((item) => item.sha256!),
    caseModelVersion: world.model.version,
    ...extra,
  }
}

export function runConfig(): TrialRunConfig {
  return {
    mode: 'screen', procedureAdapter: 'ontario_criminal_jury_v1', seed: 'analysis-seed',
    checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true },
    witnessPlan: [], deliberation: { maxRounds: 3, concurrency: 1 }, externalDisclosureConfirmed: false,
  }
}
