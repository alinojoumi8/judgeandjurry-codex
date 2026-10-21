import { randomUUID } from 'node:crypto'
import type { CaseStore } from './db'
import { contextHash } from './actorMemory'
import { courtroomCommandSchema, effectsFor, initialCourtroomState, reduceCourtroomCommand, type CourtroomCommand } from './courtroomState'
import type { TrialRole, SourceSegmentRef, ModelAudit } from './trialEngineTypes'
import type { CourtroomState } from './courtroomTypes'
import { validateEvidenceScope, permittedReference } from './evidenceRestrictions'

export function courtroomState(store: CaseStore, runId: string): CourtroomState {
  const run = store.workflow.getTrialRun(runId)
  const events = store.workflow.listTrialEvents(runId)
  // Events are the recovery authority if the disposable state projection is missing.
  const last = events.filter(e => e.payload.courtroomState).at(-1)?.payload.courtroomState as CourtroomState | undefined
  return { ...(last ?? initialCourtroomState(runId)), lastSequence: events.at(-1)?.sequence ?? 0, admissionLedgerId: run.admissionLedgerId }
}
export function commitCourtroomCommand(store: CaseStore, runId: string, raw: CourtroomCommand, role: TrialRole, modelAudit?: ModelAudit): CourtroomState {
  const command = courtroomCommandSchema.parse(raw)
  const inputHash = contextHash(command)
  return store.workflow.atomic(() => {
    const receipt = store.workflow.courtroomReceipt(runId, command.commandId)
    if (receipt) {
      if (receipt.inputHash !== inputHash) throw new Error('Command identity was reused with different input.')
      return receipt.result
    }
    const run = store.workflow.getTrialRun(runId)
    if (run.config.courtroomProtocol !== 'courtroom_v1') throw new Error('This run does not use the courtroom protocol.')
    if (['completed', 'failed', 'cancelled'].includes(run.status)) throw new Error('Courtroom run is terminal.')
    const action = command.action
    if (!['evidence', 'motions', 'instructions'].includes(run.phase) && !(run.phase.startsWith('deliberation_') && ['jury_question', 'instruct'].includes(action.type))) throw new Error('Courtroom commands require a hearing or instruction phase.')
    if (['call_witness', 'question', 'answer', 'object', 'finish_examination'].includes(action.type) && run.phase !== 'evidence') throw new Error('Examination commands require the evidence phase.')
    const before = courtroomState(store, runId)
    if (command.expectedSequence !== before.lastSequence) throw new Error('Stale courtroom sequence; refresh before issuing this command.')
    const model = store.workflow.getCaseModel(run.caseModelId)
    if (action.type === 'call_witness' && (!model.witnesses.some(w => w.id === action.witnessId) || !model.parties.some(p => p.id === action.calledByPartyId))) throw new Error('Witness or calling party is outside the pinned case model.')
    const id = randomUUID()
    let state = reduceCourtroomCommand(before, action, command.actorId, role, id)
    const effects = effectsFor(action)
    const events = store.workflow.listTrialEvents(runId)
    if (effects?.targetEventIds.some(target => !events.some(e => e.id === target))) throw new Error('Ruling target is outside this run.')
    if (effects?.targetEventIds.some(target => !['witness_question', 'witness_answer', 'exhibit_presented'].includes(events.find(e => e.id === target)!.type))) throw new Error('Ruling targets must be questions, answers or presentations.')
    const sources = store.listEvidence(run.matterId)
    if (effects?.evidence.some(effect => !sources.some(e => e.id === effect.evidenceId))) throw new Error('Ruling evidence is outside this matter.')
    for (const effect of effects?.evidence ?? []) validateEvidenceScope(effect, sources.find(s => s.id === effect.evidenceId)!, model.decisionIssues.map(i => i.id), model.parties.map(p => p.id))
    if (effects?.evidence.some(e => e.status === 'limited' && !e.purposes.length)) throw new Error('Limited admission requires an explicit permitted purpose.')
    if (effects?.evidence.some(e => e.status === 'redacted' && !e.redactions.length)) throw new Error('Redacted admission requires exact text to redact.')
    if (effects?.authorityIds.some(id => !model.legalPacket?.authorities.some(a => a.id === id && a.reviewed))) throw new Error('Ruling authority is outside the pinned reviewed packet.')
    if (action.type === 'apply_effects' && action.motionId) {
      const motion = store.workflow.getMotion(action.motionId)
      if (motion.matterId !== run.matterId || motion.caseModelId !== run.caseModelId || !action.disposition) throw new Error('The motion and disposition must match this pinned proceeding.')
      if (['reserved', 'dismissed'].includes(action.disposition) && (action.effects.evidence.length || action.effects.targetEventIds.length)) throw new Error('Reserved or dismissed rulings cannot grant substantive effects.')
      store.workflow.updateMotion({ ...motion, status: 'decided', ruling: { outcome: action.disposition, reasons: action.effects.reasons, effects: action.effects.evidence,
        authorityRefs: (model.legalPacket?.authorities ?? []).filter(a => action.effects.authorityIds.includes(a.id)).map(a => ({ registryId: a.id, sourceUrl: a.url })), decidedAt: new Date().toISOString() } })
    }
    if (effects?.evidence.length) {
      const prior = run.admissionLedgerId ? store.workflow.getAdmissionLedger(run.admissionLedgerId) : undefined
      const ledger = store.workflow.createAdmissionLedger({ matterId: run.matterId, trialRunId: run.id, parentVersionId: prior?.id, reason: effects.reasons,
        evidenceUses: (prior?.evidenceUses ?? []).map(use => ({ ...use, ...(effects.evidence.find(e => e.evidenceId === use.evidenceId) ?? {}) })),
      })
      store.workflow.updateTrialRun(runId, { admissionLedgerId: ledger.id })
      state.admissionLedgerId = ledger.id
    }
    let refs: SourceSegmentRef[] = []
    if (action.type === 'present') {
      const source = sources.find(e => e.id === action.evidenceId)
      const use = state.admissionLedgerId ? store.workflow.getAdmissionLedger(state.admissionLedgerId).evidenceUses.find(e => e.evidenceId === action.evidenceId) : undefined
      if (!source || !use || ['excluded', 'reserved'].includes(use.status)) throw new Error('This source is unavailable for presentation.')
      refs = [{ evidenceId: source.id, exhibitId: source.exhibitId, attribution: 'source' }]
    }
    if (action.type === 'answer') {
      const witness = model.witnesses.find(w => w.id === action.witnessId)!
      if (action.sourceRefs.some(ref => !witness.approvedStatementRefs.some(r => r.evidenceId === ref.evidenceId && (!ref.quote || r.quote === ref.quote)))) throw new Error('Answer reference is outside the approved witness account.')
      const uses = state.admissionLedgerId ? store.workflow.getAdmissionLedger(state.admissionLedgerId).evidenceUses : []
      if (action.sourceRefs.some(ref => {
        const use = uses.find(u => u.evidenceId === ref.evidenceId)
        return !use || ['excluded', 'reserved'].includes(use.status) || use.hiddenFrom.includes('witness') || use.redactions.some(text => ref.quote?.includes(text)) || !permittedReference(ref, sources.find(s => s.id === ref.evidenceId)!, use, {})
      })) throw new Error('The witness answer relies on a source currently unavailable for use.')
      refs = action.sourceRefs
    }
    const type = action.type === 'apply_effects' && action.motionId ? 'motion_ruling' : action.type === 'finish_examination' && state.examination === 'complete' ? 'witness_examination_completed' : ({ call_witness: 'witness_called', question: 'witness_question', answer: 'witness_answer', object: 'objection', rule: 'objection_ruling', finish_examination: 'examination_stage_completed', jury_depart: 'jury_departed', jury_return: 'jury_returned', present: 'exhibit_presented', instruct: 'limiting_instruction', apply_effects: 'ruling_effects', propose_correction: 'charge_correction_proposed', respond_correction: 'charge_correction_response', jury_question: 'jury_question' } as const)[action.type]
    state = { ...state, lastSequence: before.lastSequence + 1 }
    const visibility = before.juryPresent || ['jury_return', 'instruct'].includes(action.type) ? ['public'] : ['role:judge', 'role:crown', 'role:defence', 'user']
    store.workflow.appendTrialEvent({ id, trialRunId: runId, phase: run.phase, type, actorId: command.actorId,
      visibleTo: visibility, sourceRefs: refs, modelAudit, payload: { ...action, ...(effects ?? {}), questionEventId: before.questionEventId, examination: before.examination,
        ...(action.type === 'rule' && action.outcome === 'sustained' ? { targetEventIds: [...(effects?.targetEventIds ?? []), before.questionEventId].filter(Boolean) } : {}),
        witnessId: before.witnessId ?? ('witnessId' in action ? action.witnessId : undefined), courtroomState: state },
    })
    store.workflow.saveCourtroomState(state)
    store.workflow.saveCourtroomReceipt(runId, command.commandId, inputHash, state, command)
    return state
  })
}
