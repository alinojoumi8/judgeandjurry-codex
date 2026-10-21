import { z } from 'zod'

const text = z.string().trim().min(1).max(20_000)
export const legalPacketSchema = z.object({
  schemaVersion: z.literal(1), jurisdiction: z.literal('Ontario'), proceeding: z.literal('ontario_criminal_jury_v1'),
  issues: z.array(z.object({ issueId: text, respondingPartyIds: z.array(text), elements: z.array(z.object({ elementId: text, text, burdenPartyId: text, standard: text, authorityIds: z.array(text) })), outcomes: z.array(text), alternatives: z.array(text) })),
  instructions: z.array(z.object({ id: text, kind: z.enum(['duties', 'burden', 'elements', 'limited_use', 'deliberation']), text, authorityIds: z.array(text) })),
  authorities: z.array(z.object({ id: text, title: text, jurisdiction: text, type: z.enum(['legislation', 'binding_decision', 'persuasive_decision', 'guidance', 'model_instruction']), url: z.string().url(), pinpoint: text, asOf: text, retrievedAt: text, reviewed: z.boolean() })),
  contentHash: z.string(), review: z.object({ kind: z.enum(['qualified_legal', 'fictional_fixture']), reviewer: text, reviewedAt: text, packetHash: text, attestation: text }).optional(),
})

