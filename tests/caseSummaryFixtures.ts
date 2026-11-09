import { CaseSummaryService, type CaseSummaryReply } from '../server/analysis/caseSummary'
import type { ChronologyEvent } from '../server/analysis/chronology'
import type { ExtractedEntry } from '../server/analysis/evidenceIndex'
import { ScriptedStructuredClient, type StructuredRequest } from '../server/analysis/structured'
import type { CaseStore } from '../server/db'
import { caseMapWorld, scripted, type CaseMapWorld } from './caseMapFixtures'

// A fictional civil matter with everything F6 needs already approved: the case
// map (made by the real service from a scripted model), a timeline and an
// evidence index (seeded as approved artifacts built from the fixture's own
// text), and a private theory for each side that carries a canary phrase.
// Fixtures show software behaviour only. A scripted model proves the code
// around the model, never the quality of a live one.

export const canaries = {
  ellery: 'PLAINTIFF_PRIVATE_CANARY_71c3e5',
  tamarack: 'TAMARACK_PRIVATE_CANARY_9d22a8',
  greyvale: 'GREYVALE_PRIVATE_CANARY_4b07f1',
}

export const incidentQuote = 'Walkway at east entrance: glare ice, no visible salt.'
export const claimQuote = 'Tamarack breached its duty as occupier under the Occupiers\' Liability Act'
export const dischargeQuote = 'I never had any problem with that knee before the fall.'

export interface SummaryWorld extends CaseMapWorld {
  summaries: CaseSummaryService
  evidenceId: (file: string) => string
}

export interface SummaryWorldOptions {
  store?: CaseStore
  // Leave these out to test a missing prerequisite.
  chronology?: boolean
  evidenceIndex?: boolean
  caseMap?: boolean
  theories?: boolean
  // Choose the Ontario civil court rules (unreviewed) before the case map is made.
  rules?: boolean
}

export async function summaryWorld(options: SummaryWorldOptions = {}): Promise<SummaryWorld> {
  const world = caseMapWorld({}, options.store)
  const evidenceId = (file: string) => world.byFile.get(file)!.id
  const hashes = [...world.byFile.values()].flatMap((item) => (item.sha256 ? [item.sha256] : []))
  const manifest = { evidenceHashes: hashes }

  if (options.theories !== false) {
    world.workflow.saveTheoryBrief({ caseModelId: world.model.id, partyId: 'ellery', side: 'plaintiff', narrative: `Plaintiff theory: the walkway was left unsalted. ${canaries.ellery}` })
    world.workflow.saveTheoryBrief({ caseModelId: world.model.id, partyId: 'tamarack', side: 'defendant', narrative: `Tamarack theory: the plaintiff was not careful. ${canaries.tamarack}` })
    world.workflow.saveTheoryBrief({ caseModelId: world.model.id, partyId: 'greyvale', side: 'defendant', narrative: `Greyvale theory: salting was done. ${canaries.greyvale}` })
  }

  if (options.rules) world.frameworks.setForMatter(world.matterId, { packId: 'ontario_civil_2026_11', changedBy: 'Fictional Paralegal', overrides: [] })

  if (options.chronology !== false) {
    const event = (id: string, description: string, file: string, quote: string, assertion: ChronologyEvent['assertion'] = 'record'): ChronologyEvent => ({
      id, when: { precision: 'day', start: '2025-01-14', original: 'January 14, 2025' }, description, type: 'incident', assertion, sources: [{ evidenceId: evidenceId(file), paragraph: 1, quote }],
      issueIds: [], conflictsWith: [], review: 'accepted', warnings: [],
    })
    const draft = world.service.saveSourcedDraft<ChronologyEvent>({
      matterId: world.matterId, kind: 'chronology', inputManifest: manifest,
      items: [
        event('ev-1', 'The guard recorded glare ice and no visible salt at the east entrance', '05-incident-report.txt', incidentQuote),
        event('ev-2', 'The plaintiff says nothing was wrong with the left knee before the fall', '15-discovery-excerpt-plaintiff.txt', dischargeQuote, 'testimony'),
        { ...event('ev-3', 'The statement of claim alleges a breach of the occupier\'s duty', '01-statement-of-claim.txt', claimQuote, 'allegation'), review: 'proposed' as const },
      ],
      extraContent: { conflicts: [], candidateDates: [], documents: { processed: [], failed: [] }, reviewLog: [] },
    })
    world.service.approve(world.matterId, draft.id)
  }

  if (options.evidenceIndex !== false) {
    const entry = (id: string, type: ExtractedEntry['type'], summary: string, file: string, quote: string): ExtractedEntry => ({
      id, type, summary, speaker: type === 'testimony' ? 'Jordan Ellery' : undefined, examinationType: type === 'testimony' ? 'discovery' : undefined,
      sources: [{ evidenceId: evidenceId(file), paragraph: 1, quote }], issueIds: [], warnings: [],
    })
    const draft = world.service.saveSourcedDraft<ExtractedEntry>({
      matterId: world.matterId, kind: 'evidence_index', inputManifest: manifest,
      items: [
        entry('ix-001', 'testimony', 'The plaintiff says the left knee was sound before the fall', '15-discovery-excerpt-plaintiff.txt', dischargeQuote),
        entry('ix-002', 'allegation', 'The plaintiff pleads that Tamarack breached its duty', '01-statement-of-claim.txt', claimQuote),
      ],
      extraContent: { suggestions: [], gaps: [], documents: { processed: [], failed: [] }, reviewLog: [] },
    })
    world.service.approve(world.matterId, draft.id)
  }

  if (options.caseMap !== false) {
    await world.caseMap.generate(world.matterId, { client: scripted(world) })
    world.caseMap.approve(world.matterId)
  }

  return { ...world, summaries: new CaseSummaryService(world.store, world.service, world.workflow, world.frameworks), evidenceId }
}

type Section = CaseSummaryReply['sentences'][number]['section']
export type ReplySentence = CaseSummaryReply['sentences'][number]
type Json = { events: Array<{ id: string; description: string; sources: Array<{ evidenceId: string; exhibit: string; paragraph: number; quote: string }> }>; evidence: Array<{ id: string; kind: string; sources: Array<{ evidenceId: string; paragraph: number; quote: string }> }> }
type MapJson = { party: { id: string; name: string; role: string }; questions: Array<{ key: string; order: number; elements: Array<{ id: string }> }> }
type AuthorityJson = Array<{ id: string; kind: string }>

export const inputOf = (request: StructuredRequest<unknown>, id: string): string | undefined => request.inputs.find((input) => input.id === id)?.text

export interface SummaryRouterOptions {
  // Changes the sentences a faithful model would write for one side.
  sentences?: (partyId: string, faithful: ReplySentence[], request: StructuredRequest<unknown>) => ReplySentence[]
  needsResearch?: CaseSummaryReply['needsResearch']
  error?: Error
}

// What a faithful model would return for one side, built only from the inputs
// it was given (so a test also shows what the inputs carried).
export function faithfulSentences(request: StructuredRequest<unknown>): ReplySentence[] {
  const record = JSON.parse(inputOf(request, 'neutral-record')!) as Json
  const map = JSON.parse(inputOf(request, 'case-map')!) as MapJson
  const authorities = JSON.parse(inputOf(request, 'approved-authorities')!) as AuthorityJson
  const first = record.events[0].sources[0]
  const src = (ref: { evidenceId: string; paragraph: number; quote: string }) => ({ evidenceId: ref.evidenceId, paragraph: ref.paragraph, quote: ref.quote })
  const out: ReplySentence[] = []
  const add = (section: Section, text: string, sources = [src(first)], extra: Partial<ReplySentence> = {}) => out.push({ section, text, sources, ...extra })
  add('theory', `${map.party.name} says the walkway was left in an unsafe state.`)
  for (const event of record.events) add('facts', event.description, [src(event.sources[0])])
  const question = map.questions[0]
  add('claims_elements', `${map.party.name} points to the guard's note about the east entrance.`, [src(first)], { questionKey: question.key, elementId: question.elements[0]?.id })
  const instruction = authorities.find((authority) => authority.kind === 'instruction')
  if (instruction) add('expected_instructions', 'The jury is told to decide from the admitted evidence, and the guard\'s note is such evidence.', [src(first)], { authorityIds: [instruction.id] })
  const precedent = authorities.find((authority) => authority.kind === 'case')
  if (precedent) add('precedent', 'This side would apply this decision to the guard\'s note.', [src(first)], { authorityIds: [precedent.id] })
  const testimony = record.evidence.find((entry) => entry.kind === 'testimony')
  if (testimony) add('witness_credibility', 'The plaintiff\'s account of the knee is given under examination for discovery.', [src(testimony.sources[0])])
  add('weaknesses', 'The incident report is the guard\'s note and says nothing about when the walkway was last salted.')
  for (const q of map.questions) add('verdict_walk', `For this question ${map.party.name} relies on the guard's note.`, [src(first)], { questionKey: q.key })
  return out
}

export function summaryRouter(options: SummaryRouterOptions = {}) {
  return (request: StructuredRequest<unknown>) => {
    if (options.error) throw options.error
    if (request.task !== 'case_summary') throw new Error(`Unexpected task ${request.task}`)
    const faithful = faithfulSentences(request)
    const party = (JSON.parse(inputOf(request, 'case-map')!) as MapJson).party.id
    return { sentences: options.sentences ? options.sentences(party, faithful, request) : faithful, needsResearch: options.needsResearch ?? [] }
  }
}

export const summaryClient = (options: SummaryRouterOptions = {}, calls = 12) =>
  new ScriptedStructuredClient(Array.from({ length: calls }, () => summaryRouter(options)))
