import { z } from 'zod'
import type { CourtroomState, RulingEffects } from './courtroomTypes'
import type { TrialRole } from './trialEngineTypes'
import { sourceRefSchema, admissionInputSchema } from './workflowSchemas'

const text = z.string().trim().min(1).max(20_000)
export const rulingEffectsSchema = z.object({ targetEventIds: z.array(text).max(100), evidence: admissionInputSchema.shape.evidenceUses, reasons: text, authorityIds: z.array(text), limitingInstruction: text.optional() })
export const courtroomActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('call_witness'), witnessId: text, calledByPartyId: text }),
  z.object({ type: z.literal('question'), witnessId: text, text }),
  z.object({ type: z.literal('answer'), witnessId: text, text, sourceRefs: z.array(sourceRefSchema).default([]) }),
  z.object({ type: z.literal('object'), ground: text }),
  z.object({ type: z.literal('rule'), outcome: z.enum(['sustained', 'overruled', 'reserved']), effects: rulingEffectsSchema }),
  z.object({ type: z.literal('finish_examination') }),
  z.object({ type: z.literal('jury_depart'), reason: text }),
  z.object({ type: z.literal('jury_return') }),
  z.object({ type: z.literal('present'), evidenceId: text }),
  z.object({ type: z.literal('instruct'), text }),
  z.object({ type: z.literal('apply_effects'), effects: rulingEffectsSchema, motionId: text.optional(), disposition: z.enum(['granted', 'partially_granted', 'dismissed', 'reserved']).optional() }),
  z.object({ type: z.literal('propose_correction'), text }),
  z.object({ type: z.literal('respond_correction'), correctionEventId: text, text, requiresNewPacket: z.boolean() }),
  z.object({ type: z.literal('jury_question'), text }),
])
export const courtroomCommandSchema = z.object({ commandId: text, expectedSequence: z.number().int().nonnegative(), actorId: text, action: courtroomActionSchema })
export type CourtroomAction = z.infer<typeof courtroomActionSchema>
export type CourtroomCommand = z.infer<typeof courtroomCommandSchema>
export const initialCourtroomState = (runId: string): CourtroomState => ({ schemaVersion: 1, runId, lastSequence: 0, juryPresent: true, examination: 'complete', questionBlocked: false })
export function reduceCourtroomCommand(state: CourtroomState, action: CourtroomAction, actorId: string, role: TrialRole, eventId: string): CourtroomState {
  const next = { ...state }
  const judge = role === 'judge' || role === 'adjudicator'
  const counsel = ['crown', 'defence', 'staff', 'respondent', 'plaintiff'].includes(role)
  const requireJudge = () => { if (!judge) throw new Error('Only the judge may perform this action.') }
  const requireExaminer = () => {
    if (!counsel || (state.examination === 'cross' ? actorId === state.calledByPartyId : actorId !== state.calledByPartyId)) throw new Error('This actor is not the permitted examiner.')
  }
  if (action.type === 'call_witness') {
    requireJudge()
    if (state.examination !== 'complete') throw new Error('Finish the current witness first.')
    Object.assign(next, { witnessId: action.witnessId, calledByPartyId: action.calledByPartyId, examination: 'direct' })
  } else if (action.type === 'question') {
    requireExaminer()
    if (state.examination === 'complete' || action.witnessId !== state.witnessId) throw new Error('No active matching witness.')
    if (state.pendingInstruction || state.objectionEventId || state.questionEventId) throw new Error('Resolve the pending question, objection or instruction first.')
    next.questionEventId = eventId
    next.questionBlocked = false
  } else if (action.type === 'answer') {
    if (role !== 'witness' || actorId !== state.witnessId || action.witnessId !== state.witnessId) throw new Error('Only the active witness may answer.')
    if (state.objectionEventId || state.questionBlocked) throw new Error('The question is suspended by an objection.')
    if (!state.questionEventId) throw new Error('There is no pending question.')
    next.questionEventId = undefined
  } else if (action.type === 'object') {
    if (!counsel || !state.questionEventId || state.objectionEventId) throw new Error('An objection requires a pending unanswered question and opposing counsel.')
    if (state.examination === 'cross' ? actorId !== state.calledByPartyId : actorId === state.calledByPartyId) throw new Error('The examiner cannot object to their own question.')
    next.objectionEventId = eventId
    next.questionBlocked = true
  } else if (action.type === 'rule') {
    requireJudge()
    if (!state.objectionEventId) throw new Error('There is no pending objection.')
    if (action.outcome === 'reserved' && (action.effects.evidence.length || action.effects.targetEventIds.length || action.effects.limitingInstruction)) throw new Error('Reserved rulings cannot imply substantive effects.')
    if (action.outcome !== 'reserved') {
      next.objectionEventId = undefined
      next.questionBlocked = action.outcome === 'sustained'
      if (action.outcome === 'sustained') next.questionEventId = undefined
      if (state.pendingInstruction && action.effects.limitingInstruction && action.effects.limitingInstruction !== state.pendingInstruction) throw new Error('Deliver the pending instruction before requiring another instruction.')
      next.pendingInstruction = action.effects.limitingInstruction ?? state.pendingInstruction
    }
  } else if (action.type === 'finish_examination') {
    requireExaminer()
    if (state.questionEventId || state.objectionEventId || state.pendingInstruction) throw new Error('Resolve the pending question, objection or instruction first.')
    next.examination = state.examination === 'direct' ? 'cross' : state.examination === 'cross' ? 'reexamination' : 'complete'
  } else if (action.type === 'jury_depart') {
    requireJudge()
    if (!state.juryPresent) throw new Error('Jury already absent.')
    next.juryPresent = false
  } else if (action.type === 'jury_return') {
    requireJudge()
    if (state.juryPresent) throw new Error('Jury already present.')
    if (state.pendingInstruction || state.objectionEventId) throw new Error('Resolve the objection and deliver the required instruction first.')
    next.juryPresent = true
  } else if (action.type === 'instruct') {
    requireJudge()
    if (state.pendingInstruction && action.text !== state.pendingInstruction) throw new Error('Deliver the exact pending instruction.')
    next.pendingInstruction = undefined
    next.pendingJuryQuestion = undefined
    next.instructionEventId = eventId
  } else if (action.type === 'present') {
    requireJudge()
    if (state.pendingInstruction || state.objectionEventId) throw new Error('Resolve pending obligations before presentation.')
  } else if (action.type === 'apply_effects') {
    requireJudge()
    if (state.pendingInstruction && action.effects.limitingInstruction && action.effects.limitingInstruction !== state.pendingInstruction) throw new Error('Deliver the pending instruction before requiring another instruction.')
    next.pendingInstruction = action.effects.limitingInstruction ?? state.pendingInstruction
  } else if (action.type === 'propose_correction') {
    if (!counsel) throw new Error('Only counsel may propose a charge correction.')
    next.pendingCorrections = [...(state.pendingCorrections ?? []), eventId]
  } else if (action.type === 'respond_correction') {
    requireJudge()
    if (!state.pendingCorrections?.includes(action.correctionEventId)) throw new Error('No matching pending correction.')
    if (action.requiresNewPacket) throw new Error('A material amendment requires a new immutable reviewed packet and a new run.')
    next.pendingCorrections = state.pendingCorrections.filter(id => id !== action.correctionEventId)
  } else if (action.type === 'jury_question') {
    if (!['juror', 'foreperson'].includes(role)) throw new Error('Only a juror may ask a jury question.')
    next.pendingJuryQuestion = eventId
  }
  return next
}
export function effectsFor(action: CourtroomAction): RulingEffects | undefined {
  return action.type === 'apply_effects' || action.type === 'rule' ? action.effects : undefined
}
