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
    coverage: z.enum(['whole_document', 'selected_extracts', 'unknown']), note: z.string().max(20_000),
  })).max(20_000),
  missingMaterials: z.array(z.object({
    label: text, status: z.enum(['not_supplied', 'not_located_in_disclosure', 'not_applicable']), note: z.string().max(20_000),
  })).max(500),
})
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
  })).max(200).optional(),
  witnesses: z.array(z.object({ id: text, name: text, calledByPartyId: text.optional(), sourceRefs: refs, approvedStatementRefs: refs })).max(500).optional(),
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
    purposes: z.array(z.string().trim().max(20_000)), redactions: z.array(z.string().min(1).max(20_000)),
    hiddenFrom: z.array(z.enum(['system', 'judge', 'adjudicator', 'crown', 'staff', 'plaintiff', 'defence', 'respondent', 'witness', 'juror', 'foreperson', 'user'])),
    note: z.string().max(20_000),
    scope: z.object({
      paragraphs: z.array(z.number().int().positive()).min(1).max(20_000).optional(),
      issueIds: z.array(text).min(1).max(200).optional(), partyIds: z.array(text).min(1).max(100).optional(),
      prohibitedPurposes: z.array(text).max(100).optional(), purpose: text.optional(),
    }).optional(),
  })).max(20_000),
})
