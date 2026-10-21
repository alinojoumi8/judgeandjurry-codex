import { createHash } from 'node:crypto'
import type { EvidenceItem } from './types'
import type { EvidenceUse, SourceSegmentRef, TrialEvent, TrialRole, IssueBallot } from './trialEngineTypes'
import type { ParticipantMemory } from './courtroomTypes'
import { projectRestrictedEvidence, permittedReference, type EvidenceUseScope } from './evidenceRestrictions'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}
export const contextHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export interface MemoryInput {
  runId: string; actorId: string; roles: TrialRole[]; throughSequence: number
  events: TrialEvent[]; evidence: EvidenceItem[]; uses: EvidenceUse[]
  approvedStatementRefs: SourceSegmentRef[]; protocol: boolean
  ballots?: IssueBallot[]
  useScope?: EvidenceUseScope
}
export function authorisedRecord(input: MemoryInput): { events: TrialEvent[]; heard: TrialEvent[]; invalidated: string[]; evidence: EvidenceItem[] } {
  const jury = input.roles.some(r => r === 'juror' || r === 'foreperson')
  const witness = input.roles.includes('witness')
  let juryPresent = true
  const boundedEvents = input.events.filter(e => e.trialRunId === input.runId && e.sequence <= input.throughSequence).sort((a, b) => a.sequence - b.sequence)
  const heard = boundedEvents.filter(e => {
    if (e.type === 'jury_departed') juryPresent = false
    if (e.type === 'jury_returned') juryPresent = true
    const visible = e.visibleTo.includes('public') || e.visibleTo.includes(input.actorId) || input.roles.some(r => e.visibleTo.includes(`role:${r}`))
    const queuedInstructionDelivered = e.type === 'limiting_instruction' && boundedEvents.some(later => later.type === 'jury_returned' && later.sequence > e.sequence)
    if (!visible || (jury && !juryPresent && !queuedInstructionDelivered)) return false
    if (witness) return (e.type === 'witness_question' || e.type === 'witness_answer') && e.payload.witnessId === input.actorId || ['judicial_instruction', 'limiting_instruction'].includes(e.type)
    return true
  })
  const uses = new Map(input.uses.map(u => [u.evidenceId, u]))
  const presented = new Set(heard.filter(e => ['exhibit_presented', 'agreed_fact', 'witness_answer'].includes(e.type)).flatMap(e => e.sourceRefs.map(r => r.evidenceId)))
  const permitted = input.evidence.filter(e => {
    const use = uses.get(e.id)
    if (input.uses.length && !use) return false
    if (use && (['excluded', 'reserved'].includes(use.status) || input.roles.some(r => use.hiddenFrom.includes(r)))) return false
    if (witness) return input.approvedStatementRefs.some(r => r.evidenceId === e.id)
    return !input.protocol || !jury || presented.has(e.id)
  }).flatMap(original => {
    const e = projectRestrictedEvidence(original, uses.get(original.id), input.useScope ?? {})
    if (!e) return []
    const redactions = uses.get(e.id)?.redactions ?? []
    const safeText = witness ? input.approvedStatementRefs.filter(r => r.evidenceId === e.id).map(r => r.quote ?? e.text).filter(q => e.text.includes(q)).join('\n') : e.text
    // Do not pass derivative summaries or metadata that can reintroduce redacted text.
    return [{ ...e, text: redact(safeText, redactions), authorizedPassages: witness ? undefined : e.authorizedPassages, summary: witness ? '' : redact(e.summary, redactions), name: redact(e.name, redactions) }]
  }).filter(e => !witness || Boolean(e.text))
  const ids = new Set(permitted.map(e => e.id))
  const struck = new Set(input.events.filter(e => e.trialRunId === input.runId && e.sequence <= input.throughSequence && (['answer_struck', 'question_struck', 'ruling_effects', 'motion_ruling'].includes(e.type) || e.type === 'objection_ruling' && e.payload.outcome === 'sustained')).flatMap(e => [e.payload.answerEventId, ...(e.type === 'objection_ruling' || e.type === 'question_struck' ? [e.payload.questionEventId] : []), ...(Array.isArray(e.payload.targetEventIds) ? e.payload.targetEventIds : [])]).filter((id): id is string => typeof id === 'string'))
  const invalidated: string[] = []
  const events = heard.flatMap(e => {
    if (struck.has(e.id) || e.sourceRefs.some(r => r.evidenceId && (!ids.has(r.evidenceId) || !permittedReference(r, input.evidence.find(s => s.id === r.evidenceId)!, uses.get(r.evidenceId), input.useScope ?? {})))) {
      invalidated.push(e.id)
      return [{ ...e, payload: { withheld: 'Content is unavailable for current use under the controlling ruling.' }, sourceRefs: [], modelAudit: undefined }]
    }
    const redactions = e.sourceRefs.flatMap(r => r.evidenceId ? uses.get(r.evidenceId)?.redactions ?? [] : [])
    // Audit contains owner-only material and is deliberately omitted from actor input.
    const { modelAudit: _audit, ...safe } = e
    const { courtroomState: _state, effects: _effects, evidence: _evidence, ...payload } = e.payload
    return [{ ...safe, payload: JSON.parse(redact(JSON.stringify(payload), redactions)), sourceRefs: e.sourceRefs.map(r => ({ ...r, quote: r.quote ? redact(r.quote, redactions) : undefined })) }]
  })
  return { events, heard, invalidated, evidence: permitted }
}
function redact(text: string, redactions: string[]): string { return redactions.reduce((s, r) => s.replaceAll(r, '[REDACTED]'), text) }
export function projectParticipantMemory(input: MemoryInput): ParticipantMemory {
  const record = authorisedRecord(input)
  const records = record.events.map(e => ({ eventId: e.id, sequence: e.sequence, kind: recordKind(e.type), payload: e.payload, sourceRefs: e.sourceRefs }))
  const memory = {
    schemaVersion: 1 as const, runId: input.runId, actorId: input.actorId, roles: input.roles,
    throughSequence: input.throughSequence, heardEventIds: record.heard.map(e => e.id), invalidatedEventIds: record.invalidated,
    records, usableSources: record.evidence.map(e => ({ evidenceId: e.id, exhibitId: e.exhibitId, status: input.uses.find(u => u.evidenceId === e.id)?.status ?? 'admitted', purposes: input.uses.find(u => u.evidenceId === e.id)?.purposes ?? [] })),
    instructionEventIds: records.filter(r => r.kind === 'instruction').map(r => r.eventId),
    unresolvedQuestions: records.filter(r => r.kind === 'question' && !records.some(a => a.kind === 'testimony' && a.sequence > r.sequence && a.payload.witnessId === r.payload.witnessId)).map(r => String(r.payload.question ?? r.payload.text ?? '')).filter(Boolean),
    issueAssessments: (input.ballots ?? []).filter(b => b.actorId === input.actorId).map(b => {
      const usable = b.valid && b.sourceRefs.every(ref => record.evidence.some(e => e.id === ref.evidenceId && permittedReference(ref, input.evidence.find(s => s.id === e.id)!, input.uses.find(u => u.evidenceId === e.id), input.useScope ?? {}))) && (!b.changedByEventId || !record.invalidated.includes(b.changedByEventId))
      return { issueId: b.issueId, round: b.round, choice: usable ? b.choice : 'requires_reassessment', confidence: usable ? b.confidence : 0, rationale: usable ? b.rationale : 'This earlier position depends on material no longer available for use.', sourceRefs: usable ? b.sourceRefs : [], usable, attribution: 'simulated_position' as const }
    }),
  }
  return { ...memory, projectionHash: contextHash(memory) }
}
function recordKind(type: string): ParticipantMemory['records'][number]['kind'] {
  if (type === 'witness_answer' || type === 'agreed_fact') return 'testimony'
  if (type === 'public_submission' || type === 'motion_submission') return 'submission'
  if (type === 'witness_question') return 'question'
  if (type.includes('instruction')) return 'instruction'
  if (type.includes('ruling')) return 'ruling'
  if (type.includes('deliberation') || type.includes('ballot')) return 'assessment'
  return 'procedure'
}
