import { authorisedRecord, contextHash, projectParticipantMemory, type MemoryInput } from './actorMemory'
import type { ActorContextManifest } from './courtroomTypes'
import type { EvidenceItem } from './types'

export const actorContextCharacterBudget = 240_000
export const actorContextCharacters = (evidence: EvidenceItem[], previousTurns = '') => previousTurns.length + JSON.stringify(evidence).length

// Filter before serialisation. Rebuild from the pinned record; cached summaries
// are never an authority for access or for the current permitted use of evidence.
export function assembleActorContext(input: MemoryInput, characterBudget = actorContextCharacterBudget) {
  const record = authorisedRecord(input)
  const memory = projectParticipantMemory(input)
  const previousTurns = memory.records.map(r => `${r.eventId} ${r.kind}: ${JSON.stringify(r.payload)}`).join('\n')
  const size = actorContextCharacters(record.evidence, previousTurns)
  if (size > characterBudget) throw new Error(`Actor context exceeds its ${characterBudget} character budget (${size} characters); no material was silently omitted. Select documents or permitted paragraphs in Admitted Record, save a new version, and start a new proceeding. Existing runs retain their saved record.`)
  const manifest: ActorContextManifest = {
    schemaVersion: 1, runId: input.runId, actorId: input.actorId, throughSequence: input.throughSequence,
    projectionHash: memory.projectionHash, contextHash: contextHash({ previousTurns, evidence: record.evidence }), inputHash: '',
    eventRefs: record.events.map(e => ({ id: e.id, hash: contextHash(e) })), sourceRefs: record.evidence.map(e => ({ evidenceId: e.id, hash: contextHash(e) })),
    retrieval: 'all-authorised-records-v1', characterBudget, omittedEventIds: [],
  }
  return { events: record.events, evidence: record.evidence, memory, manifest, previousTurns }
}
