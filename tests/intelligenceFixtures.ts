import { readFileSync, readdirSync } from 'node:fs'

import { AnalysisService } from '../server/analysis/service'
import { ScriptedStructuredClient, type StructuredRequest } from '../server/analysis/structured'
import { CaseWorkflowService } from '../server/caseWorkflow'
import type { CaseStore } from '../server/db'
import type { CaseModelV1 } from '../server/trialEngineTypes'
import { addSource, memoryStore } from './analysisFixtures'

// The fictional civil negligence packet, loaded into a store with the real
// answer key. Everything here is fictional test data. Fixtures establish
// software behaviour only: a scripted model proves the code around the model,
// never the quality of a live model.
// Found from the working directory so that the jsdom screen tests can load it too.
const root = `${process.cwd().replaceAll('\\', '/')}/samples/civil-negligence/`
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8').replace(/\r\n/g, '\n')

export const civilFiles = readdirSync(`${root}sources`).filter((name) => name.endsWith('.txt')).sort()
export const civilText = new Map(civilFiles.map((name) => [name, read(`sources/${name}`)]))
export const answerKey = JSON.parse(read('answer-key.json')) as {
  chronology: Array<{
    id: string; description: string; type: string; assertion: string
    when: { precision: string; start?: string; end?: string; original: string }
    sources: Array<{ file: string; quote: string }>
  }>
  conflicts: Array<{ id: string; topic: string; sides: Array<{ file: string; quote: string; says: string }> }>
  gaps: Array<{ id: string; description: string; pointer: { file: string; quote: string }; absentFilePattern?: string }>
  experts: Array<{
    id: string; name: string; retainedBy: string; field: string; file: string; qualificationsStated: boolean
    opinions: Array<{ summary: string; file: string; quote: string }>
    plantedWeaknesses: Array<{ description: string; file: string; quote: string }>
  }>
  injection: { file: string; line: string; canary: string }
}

export interface CivilWorld {
  store: CaseStore
  service: AnalysisService
  workflow: CaseWorkflowService
  matterId: string
  model: CaseModelV1
  // evidence by source file name
  byFile: Map<string, ReturnType<typeof addSource>>
  exhibit: (file: string) => string
}

const refs = [{ attribution: 'manual' as const }]

// A matter holding all 19 fictional sources (E-001 to E-019, in file order) and
// an approved Ontario civil case model with three issues.
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
        id: 'issue-occupier', kind: 'civil_claim', label: 'Occupiers\' liability: Tamarack', claimantPartyId: 'ellery', respondingPartyIds: ['tamarack'],
        questionText: 'Did Tamarack fail to take reasonable care for the Plaintiff\'s safety?',
        elements: [
          { id: 'el-duty', label: 'Tamarack was the occupier', burden: 'Plaintiff, balance of probabilities', sourceRefs: refs },
          { id: 'el-care', label: 'Tamarack did not take reasonable care', burden: 'Plaintiff, balance of probabilities', sourceRefs: refs },
          { id: 'el-notice', label: 'Written notice within 60 days', burden: 'Plaintiff, balance of probabilities', sourceRefs: refs },
        ],
        permittedOutcomes: ['proved', 'not_proved', 'no_decision'], sourceRefs: refs,
      },
      {
        id: 'issue-greyvale', kind: 'civil_claim', label: 'Negligence: Greyvale', claimantPartyId: 'ellery', respondingPartyIds: ['greyvale'],
        elements: [
          { id: 'el-salt', label: 'Greyvale did not salt the east walkway before the fall', burden: 'Plaintiff, balance of probabilities', sourceRefs: refs },
          { id: 'el-cause', label: 'The fall caused the injury', burden: 'Plaintiff, balance of probabilities', sourceRefs: refs },
        ],
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
  const world: CivilWorld = {
    store, service: new AnalysisService(store), workflow, matterId: matter.id, model, byFile,
    exhibit: (file) => byFile.get(file)!.exhibitId,
  }
  return world
}

// ---------------------------------------------------------------------------
// Scripted model replies

export const fallDescription = 'Plaintiff slipped and fell on ice at the east entrance of the Plaza'
// The three planted sources that give different times for the fall.
const fallEvents: Record<string, string> = { CH08: fallDescription, CH09: fallDescription, CH10: fallDescription }
const issueByEvent: Record<string, string[]> = {
  CH08: ['issue-greyvale'], CH09: ['issue-greyvale'], CH10: ['issue-greyvale'], CH04: ['issue-greyvale'], CH06: ['issue-greyvale'],
  CH07: ['issue-greyvale'], CH18: ['issue-occupier'], CH19: ['issue-occupier'], CH15: ['issue-damages'], CH26: ['issue-damages'],
}

export interface ScriptedEvent {
  when: { precision: string; start?: string; end?: string; original: string }
  description: string
  type: string
  assertion: string
  eventKey?: string
  sources: Array<{ evidenceId: string; paragraph: number; quote: string }>
  issueIds: string[]
}

// What a faithful model would return for one document, built from the answer
// key: each key event that cites the file, with only that file's sources. Every
// fixture file is one paragraph, so every paragraph number is 1.
export function goldEventsFor(world: CivilWorld, file: string): ScriptedEvent[] {
  const exhibitId = world.exhibit(file)
  const events: ScriptedEvent[] = answerKey.chronology
    .filter((event) => event.sources.some((source) => source.file === file))
    .map((event) => ({
      when: { ...event.when }, description: fallEvents[event.id] ?? event.description, type: event.type, assertion: event.assertion,
      ...(fallEvents[event.id] ? { eventKey: 'the fall' } : {}),
      sources: event.sources.filter((source) => source.file === file).map((source) => ({ evidenceId: exhibitId, paragraph: 1, quote: source.quote })),
      issueIds: issueByEvent[event.id] ?? [],
    }))
  if (file === '05-incident-report.txt') {
    // The guard's own time for the fall: a third time in the planted conflict.
    events.push({
      when: { precision: 'exact', start: '2025-01-14T08:05', original: 'Time of occurrence: 08:05' }, description: fallDescription, eventKey: 'the fall', type: 'incident', assertion: 'record',
      sources: [{ evidenceId: exhibitId, paragraph: 1, quote: 'Date of occurrence: January 14, 2025' }, { evidenceId: exhibitId, paragraph: 1, quote: 'Time of occurrence: 08:05' }],
      issueIds: ['issue-greyvale'],
    })
  }
  if (file === '09-emergency-record.txt') {
    // The hospital record gives an approximate time and no date: it must stay undated.
    events.push({
      when: { precision: 'approximate', start: '2025-01-14T09:00', original: 'approx 0900' }, description: fallDescription, eventKey: 'the fall', type: 'incident', assertion: 'record',
      sources: [{ evidenceId: exhibitId, paragraph: 1, quote: 'Fell approx 0900 per patient on ice in parking area.' }], issueIds: ['issue-greyvale'],
    })
  }
  return events
}

export type Router = (request: StructuredRequest<unknown>) => unknown

// A scripted client that answers every call with the router's reply. Replies go
// through the request's schema, exactly as a real client's would.
export function routedClient(router: Router, calls = 60): ScriptedStructuredClient {
  return new ScriptedStructuredClient(Array.from({ length: calls }, () => router))
}

export const documentOf = (request: StructuredRequest<unknown>) => request.inputs[0]?.id

// Replies to chronology extraction with the gold events and ignores other tasks.
export function chronologyRouter(world: CivilWorld): Router {
  const byExhibit = new Map([...world.byFile].map(([file, item]) => [item.exhibitId, file]))
  return (request) => {
    if (request.task !== 'chronology_extraction') throw new Error(`Unexpected task ${request.task}`)
    return { events: goldEventsFor(world, byExhibit.get(documentOf(request)!)!) }
  }
}

// ---------------------------------------------------------------------------
// One scripted client for all three case-intelligence features and the readings,
// built from the answer key. Used by the screen tests and the browser journey.

const expertTopics: Record<string, string[]> = {
  castellane: ['future knee replacement', 'capacity to work'],
  lindqvist: ['Future knee replacement', 'Work capacity'],
  marchetti: ['economic loss'],
}

export function intelligenceRouter(world: CivilWorld): Router {
  const gold = chronologyRouter(world)
  const byExhibit = new Map([...world.byFile].map(([file, item]) => [item.exhibitId, file]))
  const src = (file: string, quote: string) => ({ evidenceId: world.exhibit(file), paragraph: 1, quote })
  return (request) => {
    if (request.task === 'chronology_extraction') return gold(request)
    if (request.task === 'chronology_readings') {
      return { readings: [
        { lens: 'plain_language', text: 'A person fell on ice outside the plaza.' },
        { lens: 'likely_question', text: 'Was the walkway salted before the fall?' },
        { lens: 'which_way_it_cuts', text: 'Depends on the salting records.', cutsToward: 'unclear' },
      ] }
    }
    const file = byExhibit.get(documentOf(request)!)!
    if (request.task === 'evidence_index_extraction') {
      const entries: unknown[] = []
      const suggestions: unknown[] = []
      if (file === '05-incident-report.txt') {
        suggestions.push({ issueId: 'issue-greyvale', elementId: 'el-salt', stance: 'supporting', evidenceId: world.exhibit(file), paragraph: 1, quote: 'Walkway at east entrance: glare ice, no visible salt.', note: 'Guard saw no salt.' })
        suggestions.push({ issueId: 'issue-greyvale', elementId: 'el-cause', stance: 'supporting', evidenceId: world.exhibit(file), paragraph: 1, quote: 'Person involved: Jordan Ellery, a visitor to the Plaza', note: '' })
      }
      if (file === '01-statement-of-claim.txt') entries.push({ type: 'allegation', summary: 'Tamarack breached its duty as occupier.', sources: [src(file, 'Tamarack breached its duty as occupier under the Occupiers\' Liability Act')], issueIds: ['issue-occupier'] })
      if (file === '15-discovery-excerpt-plaintiff.txt') entries.push({ type: 'testimony', speaker: 'Jordan Ellery', examinationType: 'discovery', summary: 'Time of the fall.', sources: [src(file, 'A. About 7:40 in the morning.')], issueIds: [] })
      return { entries, suggestions, gaps: file === '06-winter-service-log.txt' ? [{ description: 'No independent weather record.', sources: [src(file, 'Weather note: freezing drizzle overnight.')] }] : [] }
    }
    const expert = answerKey.experts.find((candidate) => candidate.file === file)
    if (request.task === 'expert_record_extraction') {
      if (!expert) throw new Error(`No expert in ${file}`)
      const text = civilText.get(file)!
      const line = (start: string) => text.split('\n').find((entry) => entry.startsWith(start))
      const retained = line('Retained by')
      const assumptions = text.split('\n').filter((entry) => /assum/i.test(entry) && !entry.startsWith('Assumptions'))
      return { experts: [{
        name: expert.name, field: expert.field,
        ...(retained ? { retainedBy: { text: retained, sources: [src(file, retained)] } } : {}),
        identity: [src(file, text.split('\n')[0].slice(0, 60))],
        qualifications: expert.qualificationsStated ? [{ text: 'A practising orthopaedic surgeon', sources: [src(file, 'I am a practising orthopaedic surgeon.')] }] : [],
        compensation: [],
        dataRelied: file.startsWith('12-') ? [{ text: 'Hospital and physiotherapy records', sources: [src(file, 'I reviewed the Port Alder General Hospital emergency record and the physiotherapy records received to date.')] }] : [],
        assumptions: assumptions.map((entry) => ({ text: entry, sources: [src(file, entry)] })),
        opinions: expert.opinions.map((opinion, index) => ({ topic: expertTopics[expert.id][index] ?? 'economic loss', statement: opinion.summary, sources: [src(file, opinion.quote)] })),
      }] }
    }
    if (request.task === 'expert_assessment') {
      if (!expert) throw new Error(`No expert in ${file}`)
      const findings: unknown[] = []
      if (expert.id === 'castellane') {
        findings.push({
          dimension: 'assumptions', polarity: 'negative', statement: 'The report assumes no earlier left knee complaints, but the family physician chart records one in November 2023.',
          basis: [src('12-expert-report-plaintiff-orthopaedic.txt', 'I have assumed that the patient had no left knee complaints before January 14, 2025.'), src('10-family-physician-chart.txt', '2023-11-08: C/O left knee pain x 3 weeks after kneeling at work.')],
        }, { dimension: 'qualification_fit', polarity: 'positive', statement: 'The report states the expert is a practising orthopaedic surgeon, matching the knee opinions.', basis: [src(file, 'I am a practising orthopaedic surgeon.')] })
      }
      if (expert.id === 'lindqvist') {
        findings.push({ dimension: 'bias', polarity: 'negative', statement: 'The report itself says most retainers come from insurers or defence counsel.', basis: [src(file, 'In the past five years, 94 percent of my medico-legal retainers have come from insurers or defence counsel.')] })
      }
      if (expert.id === 'marchetti') {
        findings.push({ dimension: 'assumptions', polarity: 'negative', statement: 'The assumed income of $84,000 is higher than the employer\'s figure for 2024.', basis: [src(file, 'Annual income assumed: $84,000'), src('17-employer-earnings-letter.txt', 'Total gross earnings for 2024: $73,180')] })
      }
      return { findings }
    }
    throw new Error(`Unexpected task ${request.task}`)
  }
}

// The matter's admitted sources, so juror readings have something to read.
export function admitAll(world: CivilWorld): void {
  world.workflow.saveAdmissionLedger(world.matterId, {
    reason: 'Rulings',
    evidenceUses: world.store.listEvidence(world.matterId).map((item) => ({ evidenceId: item.id, status: 'admitted' as const, purposes: [], redactions: [], hiddenFrom: [], note: '' })),
  })
}
