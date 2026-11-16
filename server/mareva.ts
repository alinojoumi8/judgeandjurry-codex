import type { CaseModelV1, DecisionIssue, MarevaHearing, SourceSegmentRef, TrialRunConfig } from './trialEngineTypes'
import type { EvidenceItem } from './types'

export function marevaOutcomes(kind: MarevaHearing['kind']): string[] {
  return kind === 'initial' ? ['grant', 'refuse', 'reserved'] : ['maintain', 'vary', 'discharge', 'reserved']
}

// A review checklist, not a substitute for selecting the governing authorities.
export const marevaFrameworkChecklist = 'Identify the governing procedural basis and issue-specific burdens from the supplied authorities. Address the strength of the underlying case, evidence of dissipation risk, full and frank disclosure where applicable, the undertaking in damages, and the necessity and scope of the requested order. On a set-aside motion, distinguish challenges to the original record from later evidence and changes in circumstances. Do not treat a fraud allegation as a finding, infer dissipation from debt alone, decide final liability, or decide a separate Anton Piller or contempt motion. Explain disputed and missing evidence and any narrower alternative. The specific legal test and burden must be reviewed for this hearing.'

export function marevaDecisionIssue(hearing: MarevaHearing): DecisionIssue {
  return {
    id: 'mareva-disposition', kind: 'special_question',
    label: hearing.kind === 'initial' ? 'Should the requested Mareva injunction be granted?' : 'Should the existing Mareva injunction be maintained, varied or discharged?',
    claimantPartyId: hearing.movingPartyId, respondingPartyIds: [hearing.respondingPartyId],
    elements: [{ id: 'mareva-framework', label: hearing.legalFramework, burden: 'Apply the issue-specific burdens in the reviewed hearing framework; do not assume the moving party bears every burden.', sourceRefs: hearing.legalAuthorityRefs }],
    permittedOutcomes: marevaOutcomes(hearing.kind), sourceRefs: [...hearing.movingRecordRefs, ...hearing.responseRecordRefs],
  }
}

export function marevaRecordRefs(hearing: MarevaHearing): SourceSegmentRef[] {
  return [...hearing.existingOrderRefs, ...hearing.movingRecordRefs, ...hearing.responseRecordRefs, ...hearing.replyRecordRefs, ...hearing.legalAuthorityRefs]
}

export function validateMarevaModel(model: CaseModelV1, evidence: EvidenceItem[]): void {
  const hearing = model.marevaHearing
  if (!hearing) return
  if (model.procedureAdapter !== 'ontario_civil_v1') throw new Error('Mareva hearings require the Ontario civil adapter.')
  if (!hearing.reviewedForRehearsal) throw new Error('Review the Mareva hearing framework, parties and source record before approval.')
  const ids = model.parties.map(party => party.id)
  if (new Set(ids).size !== ids.length || ids.some(id => /^(?:system|user|judge-\d+|adjudicator-\d+|juror-\d+)$/.test(id))) throw new Error('Mareva parties need distinct identities that do not impersonate court actors.')
  const moving = model.parties.find(party => party.id === hearing.movingPartyId)
  const responding = model.parties.find(party => party.id === hearing.respondingPartyId)
  if (!moving || !responding || moving.id === responding.id || [moving, responding].some(party => !['plaintiff', 'defendant', 'respondent'].includes(party.role))) throw new Error('Choose distinct civil moving and responding parties for this hearing.')
  if (!hearing.movingRecordRefs.length || !hearing.responseRecordRefs.length || !hearing.legalAuthorityRefs.length) throw new Error('A contested Mareva hearing requires moving, responding and legal-authority sources.')
  if (hearing.kind === 'set_aside' && (!hearing.existingOrderRefs.length || !hearing.orderSummary.trim())) throw new Error('A set-aside hearing requires the existing order and a description of the terms challenged.')
  for (const ref of marevaRecordRefs(hearing)) {
    const source = evidence.find(item => item.id === ref.evidenceId)
    if (!source || ref.attribution !== 'source' || (ref.exhibitId && ref.exhibitId !== source.exhibitId)) throw new Error('Each Mareva record reference must identify a source in this matter.')
  }
  const issue = model.decisionIssues[0]
  const outcomes = marevaOutcomes(hearing.kind)
  if (model.decisionIssues.length !== 1 || !issue || issue.kind !== 'special_question' || issue.claimantPartyId !== moving.id || issue.respondingPartyIds.length !== 1 || issue.respondingPartyIds[0] !== responding.id || issue.permittedOutcomes.length !== outcomes.length || new Set(issue.permittedOutcomes).size !== outcomes.length || outcomes.some(value => !issue.permittedOutcomes.includes(value))) throw new Error('A Mareva hearing needs one disposition question for the selected parties and exact hearing outcomes.')
  if (!issue.elements.length || issue.elements.some(element => !element.label.trim() || !element.burden.trim())) throw new Error('Mareva issues require a legal framework and explicit burdens.')
}

export function validateMarevaRun(model: CaseModelV1, config: TrialRunConfig, evidence: EvidenceItem[]): void {
  validateMarevaModel(model, evidence)
  if (!model.marevaHearing) return
  if (model.status !== 'approved') throw new Error('Approve the Mareva case model before starting.')
  if (config.mode !== 'full' || config.civilDecisionMaker !== 'judge_alone' || config.courtroomProtocol || config.witnessPlan.length) throw new Error('Mareva hearings use a full civil judge-alone documentary hearing, without jury or witness-examination stages.')
}

export function marevaPrompt(model: CaseModelV1, visibleEvidence: EvidenceItem[]): string {
  const hearing = model.marevaHearing!
  const label = (id: string) => model.parties.find(party => party.id === id)?.name ?? id
  const refs = (items: SourceSegmentRef[]) => items.flatMap(ref => {
    const source = visibleEvidence.find(item => item.id === ref.evidenceId)
    return source ? [source.exhibitId] : []
  }).join(', ') || 'No source in this category is visible to this actor; do not invent its contents.'
  return [
    `CIVIL MAREVA DOCUMENTARY HEARING: ${hearing.kind === 'initial' ? 'contested initial application' : 'contested set-aside or variation'}. This is not a criminal trial or a final merits judgment.`,
    `Moving party: ${label(hearing.movingPartyId)} (${hearing.movingPartyId}). Responding party: ${label(hearing.respondingPartyId)} (${hearing.respondingPartyId}).`,
    `Record cutoff: ${hearing.recordAsOf}. Do not assume this record describes the current court docket.`,
    `Requested relief (a party request, not an established entitlement): ${hearing.requestedRelief}`,
    `User description of order terms (verify against the visible order): ${hearing.orderSummary || 'Initial application; no existing order identified.'}`,
    `Existing orders: ${refs(hearing.existingOrderRefs)}. Moving record: ${refs(hearing.movingRecordRefs)}. Responding record: ${refs(hearing.responseRecordRefs)}. Reply record: ${refs(hearing.replyRecordRefs)}. Legal authorities: ${refs(hearing.legalAuthorityRefs)}.`,
    `Reviewed framework for this rehearsal: ${hearing.legalFramework}`,
    `Approved question and burdens: ${JSON.stringify(model.decisionIssues.map(({ id, label, elements, permittedOutcomes }) => ({ id, label, elements: elements.map(({ label, burden }) => ({ label, burden })), permittedOutcomes })))}`,
    'Read affidavit statements as attributed evidence, factums and submissions as advocacy, and orders as findings or directions only within their actual scope. Generated submissions are not independent evidence. Address the strongest contrary evidence. Cite the supplied exhibit and exact paragraph for factual claims and quotations. Do not invent authorities, quotations, missing documents or probabilities of success.',
    'For any proposed variation, specify its scope, conditions, duration and exceptions only as supported by the record. A reserved ruling must explain what is missing. This simulation never changes an actual court order.',
  ].join('\n')
}

export function exactMarevaOutcome(outcome: string | undefined, permitted: string[]): string {
  if (!outcome || !permitted.includes(outcome)) throw new Error('The judge did not return an exact permitted Mareva disposition; no outcome was inferred.')
  return outcome
}
