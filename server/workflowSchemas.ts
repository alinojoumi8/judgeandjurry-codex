import { z } from 'zod'
import { legalPacketSchema } from './legalPacketSchema'

const text = z.string().trim().min(1).max(20_000)
export const sourceRefSchema = z.object({
  purpose: z.string().trim().min(1).max(20_000).optional(),
  artifactId: z.string().optional(), evidenceId: z.string().optional(), exhibitId: z.string().optional(),
  locator: z.record(z.string(), z.union([z.string(), z.number()])).optional(), quote: z.string().optional(),
  attribution: z.enum(['source', 'manual', 'inferred', 'unresolved']),
})
const refs = z.array(sourceRefSchema).max(500)
export const recordScopeSchema = z.object({
  description: z.string().max(20_000),
  documents: z.array(z.object({
    evidenceId: text,
    kind: z.enum(['primary', 'summary', 'advocacy', 'legal_authority', 'unclassified']),
    documentType: z.enum(['pleading', 'medical', 'expert_report', 'transcript', 'correspondence', 'financial', 'other']).optional(),
    coverage: z.enum(['whole_document', 'selected_extracts', 'unknown']), note: z.string().max(20_000),
  })).max(20_000),
  missingMaterials: z.array(z.object({
    label: text, status: z.enum(['not_supplied', 'not_located_in_disclosure', 'not_applicable']), note: z.string().max(20_000),
  })).max(500),
})
// A question may depend only on other questions in the same model, never on
// itself, twice on the same one, or in a cycle.
function issueDependencyErrors(issues: ReadonlyArray<{ id: string; dependsOn?: string[] }>): string[] {
  const errors: string[] = []
  const ids = new Set(issues.map((issue) => issue.id))
  for (const issue of issues) {
    const dependsOn = issue.dependsOn ?? []
    if (new Set(dependsOn).size !== dependsOn.length) errors.push(`Decision issue "${issue.id}" lists the same dependency twice.`)
    for (const id of dependsOn) {
      if (id === issue.id) errors.push(`Decision issue "${issue.id}" cannot depend on itself.`)
      else if (!ids.has(id)) errors.push(`Decision issue "${issue.id}" depends on "${id}", which is not a decision issue in this model.`)
    }
  }
  if (errors.length) return errors
  const state = new Map<string, 'visiting' | 'done'>()
  const byId = new Map(issues.map((issue) => [issue.id, issue.dependsOn ?? []]))
  const visit = (id: string): boolean => {
    if (state.get(id) === 'done') return false
    if (state.get(id) === 'visiting') return true
    state.set(id, 'visiting')
    const cyclic = (byId.get(id) ?? []).some(visit)
    state.set(id, 'done')
    return cyclic
  }
  return issues.some((issue) => visit(issue.id)) ? ['Decision issue dependencies cannot form a cycle.'] : []
}

export const editableCaseModelSchema = z.object({
  legalPacket: legalPacketSchema.optional(),
  title: text.optional(),
  parties: z.array(z.object({
    id: text, name: text, role: z.enum(['crown', 'staff', 'plaintiff', 'accused', 'respondent', 'defendant']),
    representedBy: z.string().optional(), sourceRefs: refs,
  })).max(100).optional(),
  decisionIssues: z.array(z.object({
    id: text, kind: z.enum(['criminal_count', 'osc_allegation', 'civil_claim', 'civil_defence', 'damages', 'special_question']),
    label: text, claimantPartyId: text.optional(), respondingPartyIds: z.array(text).max(100),
    elements: z.array(z.object({ id: text, label: text, burden: text, sourceRefs: refs })).max(100),
    permittedOutcomes: z.array(text).max(20), sourceRefs: refs,
    questionText: text.optional(), decider: z.enum(['jury', 'judge']).optional(),
    answerType: z.enum(['choice', 'amount', 'apportionment']).optional(),
    dependsOn: z.array(text).max(200).optional(), order: z.number().int().min(0).max(10_000).optional(),
  })).max(200).superRefine((issues, context) => {
    for (const message of issueDependencyErrors(issues)) context.addIssue({ code: 'custom', message })
  }).optional(),
  witnesses: z.array(z.object({ id: text, name: text, kind: z.enum(['fact', 'party', 'expert']).optional(), calledByPartyId: text.optional(), sourceRefs: refs, approvedStatementRefs: refs })).max(500).optional(),
  disputedFacts: z.array(z.object({ id: text, proposition: text, issueIds: z.array(text), supporting: refs, contradicting: refs, attribution: z.enum(['source', 'manual', 'inferred', 'unresolved']) })).max(1000).optional(),
  remedies: z.array(z.object({ label: text, sourceRefs: refs })).optional(),
  juryNotice: z.object({ valid: z.boolean(), note: z.string(), sourceRefs: refs }).optional(),
  unresolved: z.array(z.string().max(20_000)).max(500).optional(),
  recordScope: recordScopeSchema.optional(),
  evidenceMatrix: z.array(z.object({
    issueId: text, elementId: text,
    links: z.array(z.object({
      evidenceId: text, paragraph: z.number().int().positive(),
      stance: z.enum(['supporting', 'contrary', 'disputed']), note: z.string().max(20_000),
      quote: z.string().max(1_000_000).optional(),
    })).max(500),
    questions: z.array(z.string().max(20_000)).max(100),
  })).max(2000).optional(),
})
export const admissionInputSchema = z.object({
  parentVersionId: z.string().optional(), reason: text,
  evidenceUses: z.array(z.object({
    evidenceId: text, status: z.enum(['admitted', 'excluded', 'limited', 'redacted', 'reserved']),
    purposes: z.array(z.string().max(20_000)), redactions: z.array(z.string().min(1).max(20_000)),
    hiddenFrom: z.array(z.enum(['system', 'judge', 'adjudicator', 'crown', 'staff', 'plaintiff', 'defence', 'respondent', 'witness', 'juror', 'foreperson', 'user'])),
    note: z.string().max(20_000),
    scope: z.object({
      paragraphs: z.array(z.number().int().positive()).min(1).max(20_000).optional(),
      issueIds: z.array(text).min(1).max(200).optional(), partyIds: z.array(text).min(1).max(100).optional(),
      prohibitedPurposes: z.array(text).max(100).optional(),
    }).optional(),
  })).max(20_000),
})
