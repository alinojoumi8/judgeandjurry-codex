import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CaseMapService, type CaseMapModelItem } from '../server/analysis/caseMap'
import { AnalysisService } from '../server/analysis/service'
import { ScriptedStructuredClient, type StructuredRequest } from '../server/analysis/structured'
import { CaseWorkflowService } from '../server/caseWorkflow'
import type { CaseStore } from '../server/db'
import { FrameworkService } from '../server/frameworks/service'
import type { CaseModelV1 } from '../server/trialEngineTypes'
import { addSource, memoryStore } from './analysisFixtures'

// The fictional civil negligence packet and its answer key, loaded from the
// working directory (the jsdom tests cannot resolve import.meta.url paths).
const root = join(process.cwd(), 'samples', 'civil-negligence')
const read = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n')
export const civilFiles = readdirSync(join(root, 'sources')).filter((name) => name.endsWith('.txt')).sort()
export const civilText = new Map(civilFiles.map((name) => [name, read(`sources/${name}`)]))

export type Router = (request: StructuredRequest<unknown>) => unknown
export function routedClient(router: Router, calls = 60): ScriptedStructuredClient {
  return new ScriptedStructuredClient(Array.from({ length: calls }, () => router))
}
export const documentOf = (request: StructuredRequest<unknown>) => request.inputs[0]?.id

export interface CivilWorld {
  store: CaseStore
  service: AnalysisService
  workflow: CaseWorkflowService
  matterId: string
  model: CaseModelV1
  byFile: Map<string, ReturnType<typeof addSource>>
  exhibit: (file: string) => string
}

const refs = [{ attribution: 'manual' as const }]

// A matter holding the 19 fictional sources (E-001 to E-019, in file order) and
// an approved Ontario civil case model with three placeholder-free questions.
export function buildCivilWorld(options: { approve?: boolean } = {}, store: CaseStore = memoryStore()): CivilWorld {
  const matter = store.createMatter({ title: 'Ellery v. Tamarack Quay Holdings Inc. and Greyvale Grounds Ltd.', narrative: 'Fictional slip and fall.' })
  const byFile = new Map(civilFiles.map((name) => [name, addSource(store, matter.id, name, civilText.get(name)!)]))
  const workflow = new CaseWorkflowService(store)
  const draft = workflow.draftCaseModel(matter.id, 'ontario_civil_v1', {
    parties: [
      { id: 'ellery', name: 'Jordan Ellery', role: 'plaintiff', sourceRefs: refs },
      { id: 'tamarack', name: 'Tamarack Quay Holdings Inc.', role: 'defendant', sourceRefs: refs },
      { id: 'greyvale', name: 'Greyvale Grounds Ltd.', role: 'defendant', sourceRefs: refs },
    ],
    decisionIssues: [
      {
        id: 'issue-occupier', kind: 'civil_claim', label: "Occupiers' liability: Tamarack", claimantPartyId: 'ellery', respondingPartyIds: ['tamarack'],
        elements: [
          { id: 'el-duty', label: 'Tamarack was the occupier', burden: 'Plaintiff, balance of probabilities', sourceRefs: refs },
          { id: 'el-care', label: 'Tamarack did not take reasonable care', burden: 'Plaintiff, balance of probabilities', sourceRefs: refs },
        ],
        permittedOutcomes: ['proved', 'not_proved', 'no_decision'], sourceRefs: refs,
      },
      {
        id: 'issue-greyvale', kind: 'civil_claim', label: 'Negligence: Greyvale', claimantPartyId: 'ellery', respondingPartyIds: ['greyvale'],
        elements: [{ id: 'el-salt', label: 'Greyvale did not salt the east walkway before the fall', burden: 'Plaintiff, balance of probabilities', sourceRefs: refs }],
        permittedOutcomes: ['proved', 'not_proved', 'no_decision'], sourceRefs: refs,
      },
      {
        id: 'issue-damages', kind: 'damages', label: 'Damages', claimantPartyId: 'ellery', respondingPartyIds: ['tamarack', 'greyvale'],
        elements: [{ id: 'el-loss', label: 'Loss of income is proved', burden: 'Plaintiff, balance of probabilities', sourceRefs: refs }],
        permittedOutcomes: ['proved', 'not_proved', 'no_decision'], sourceRefs: refs,
      },
    ],
    witnesses: [], disputedFacts: [],
  })
  const model = options.approve === false ? draft : workflow.approveCaseModel(draft.id)
  return {
    store, service: new AnalysisService(store), workflow, matterId: matter.id, model, byFile,
    exhibit: (file) => byFile.get(file)!.exhibitId,
  }
}

// Fictional. The scripted replies are what a faithful model would return for
// each pleading in the civil negligence fixture, built from its answer key.
export interface KeyPleading {
  id: string
  kind: 'claim' | 'allegation' | 'defence' | 'crossclaim' | 'relief'
  by: string
  against: string[]
  summary: string
  source: { file: string; quote: string; paragraph: number }
}

export const pleadingKey = (JSON.parse(read('answer-key.json')) as { pleadings: KeyPleading[] }).pleadings

export const defenceKindOf: Record<string, 'denial' | 'affirmative' | 'factual_question'> = {
  PL13: 'denial', PL14: 'affirmative', PL15: 'affirmative', PL18: 'affirmative', PL19: 'affirmative',
  PL22: 'denial', PL23: 'factual_question', PL24: 'affirmative', PL25: 'affirmative', PL26: 'denial',
}
export const reliefKindOf: Record<string, 'general_damages' | 'special_damages' | 'punitive_damages' | 'interest'> = {
  PL1: 'general_damages', PL2: 'special_damages', PL3: 'punitive_damages', PL4: 'interest',
}

export type ReplyItem = Omit<CaseMapModelItem, 'against'> & { against?: string[] }

export function goldItemsFor(world: CivilWorld, file: string): ReplyItem[] {
  return pleadingKey.filter((entry) => entry.source.file === file).map((entry) => ({
    kind: entry.kind, summary: entry.summary, by: entry.by, against: entry.against,
    ...(entry.kind === 'defence' ? { defenceKind: defenceKindOf[entry.id] } : {}),
    ...(entry.kind === 'relief' ? { reliefKind: reliefKindOf[entry.id] } : {}),
    sources: [{ evidenceId: world.exhibit(file), paragraph: 1, quote: entry.source.quote }],
  }))
}

export interface RouterOptions {
  // Changes what extraction returns for one file.
  items?: (file: string, gold: ReplyItem[]) => ReplyItem[]
  // Replaces the element suggestions. Receives the asked question keys.
  elements?: (keys: string[]) => Array<{ issueKey: string; label: string; burdenParty?: 'claimant' | 'responding' }>
  elementsError?: Error
}

export function caseMapRouter(world: CivilWorld, options: RouterOptions = {}): Router {
  const byExhibit = new Map([...world.byFile].map(([file, item]) => [item.exhibitId, file]))
  return (request: StructuredRequest<unknown>) => {
    if (request.task === 'case_map_extraction') {
      const file = byExhibit.get(documentOf(request)!)!
      const gold = goldItemsFor(world, file)
      return { items: options.items ? options.items(file, gold) : gold }
    }
    if (request.task === 'case_map_elements') {
      if (options.elementsError) throw options.elementsError
      const keys = (JSON.parse(request.inputs[0].text) as Array<{ issueKey: string }>).map((entry) => entry.issueKey)
      return {
        elements: options.elements ? options.elements(keys)
          : keys.flatMap((issueKey) => [
            { issueKey, label: 'The pleaded event happened as alleged', burdenParty: 'claimant' as const },
            { issueKey, label: 'The pleaded event caused the harm that is claimed', burdenParty: 'claimant' as const },
          ]),
      }
    }
    throw new Error(`Unexpected task ${request.task}`)
  }
}

export interface CaseMapWorld extends CivilWorld {
  caseMap: CaseMapService
  frameworks: FrameworkService
}

export function caseMapWorld(options: { approve?: boolean } = {}, store?: CaseStore): CaseMapWorld {
  const world = buildCivilWorld(options, store)
  const frameworks = new FrameworkService(world.store)
  return { ...world, frameworks, caseMap: new CaseMapService(world.store, world.service, world.workflow, frameworks) }
}

export const scripted = (world: CivilWorld, options?: RouterOptions) => routedClient(caseMapRouter(world, options))
