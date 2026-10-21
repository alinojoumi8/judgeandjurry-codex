import { legalPacketSchema } from './legalPacketSchema'
import { contextHash } from './actorMemory'
import type { CaseModelV1 } from './trialEngineTypes'
import type { ReviewedLegalPacket } from './courtroomTypes'

export function packetContentHash(packet: ReviewedLegalPacket): string {
  const { contentHash: _hash, review: _review, ...content } = packet
  return contextHash(content)
}
export function legalPacketReadiness(model: CaseModelV1) {
  const errors: string[] = []
  const packet = model.legalPacket
  if (!packet) return { ready: false, legallyValidated: false, reviewKind: undefined, errors: ['A reviewed legal packet is required.'] }
  const parsed = legalPacketSchema.safeParse(packet)
  if (!parsed.success) return { ready: false, legallyValidated: false, reviewKind: packet.review?.kind, errors: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) }
  if (model.procedureAdapter !== packet.proceeding) errors.push('Packet proceeding does not match the pinned case model.')
  if (packet.contentHash !== packetContentHash(packet)) errors.push('Packet content hash does not match its content.')
  if (!packet.review || packet.review.packetHash !== packet.contentHash) errors.push('A review attestation against this exact packet hash is required.')
  const authorities = new Set(packet.authorities.map(a => a.id))
  if (authorities.size !== packet.authorities.length) errors.push('Authority IDs must be unique.')
  for (const a of packet.authorities) {
    if (!a.reviewed) errors.push(`Authority ${a.id} requires review.`)
    if (a.jurisdiction !== 'Ontario' && a.jurisdiction !== 'Canada') errors.push(`Authority ${a.id} has a mismatched jurisdiction.`)
    if (packet.review?.kind === 'qualified_legal' && new URL(a.url).hostname.endsWith('.invalid')) errors.push(`Authority ${a.id} uses a fictional URL.`)
  }
  const validateAuthorityIds = (ids: string[], label: string) => { if (!ids.length || ids.some(id => !authorities.has(id))) errors.push(`${label} requires located reviewed authority references.`) }
  if (new Set(packet.issues.map(i => i.issueId)).size !== packet.issues.length || packet.issues.length !== model.decisionIssues.length) errors.push('Packet issue identities must match the model exactly.')
  for (const issue of model.decisionIssues) {
    const charge = packet.issues.find(i => i.issueId === issue.id)
    if (!charge) { errors.push(`Missing issue ${issue.id}.`); continue }
    if (JSON.stringify([...charge.respondingPartyIds].sort()) !== JSON.stringify([...issue.respondingPartyIds].sort())) errors.push(`Issue ${issue.id} party identities do not match.`)
    if (JSON.stringify([...charge.outcomes].sort()) !== JSON.stringify([...issue.permittedOutcomes].sort())) errors.push(`Issue ${issue.id} outcomes do not match.`)
    if (charge.elements.length !== issue.elements.length || new Set(charge.elements.map(e => e.elementId)).size !== charge.elements.length) errors.push(`Issue ${issue.id} element identities do not match.`)
    for (const element of issue.elements) {
      const e = charge.elements.find(item => item.elementId === element.id)
      if (!e) { errors.push(`Missing element ${element.id}.`); continue }
      if (/placeholder|confirm the|to be reviewed|essential element/i.test(e.text)) errors.push(`Element ${element.id} contains placeholder law.`)
      if (!model.parties.some(p => p.id === e.burdenPartyId)) errors.push(`Element ${element.id} burden party is outside the model.`)
      validateAuthorityIds(e.authorityIds, `Element ${element.id}`)
    }
  }
  for (const kind of ['duties', 'burden', 'elements', 'limited_use', 'deliberation']) if (!packet.instructions.some(i => i.kind === kind)) errors.push(`Missing ${kind} instruction.`)
  if (new Set(packet.instructions.map(i => i.id)).size !== packet.instructions.length) errors.push('Instruction IDs must be unique.')
  for (const i of packet.instructions) validateAuthorityIds(i.authorityIds, `Instruction ${i.id}`)
  // An attestation is recorded provenance, never independent legal certification.
  return { ready: !errors.length, legallyValidated: false, reviewKind: packet.review?.kind, errors }
}
// Used only by explicit fictional fixtures and development tools, never a
// default packet or a substitute for legal review in the application.
export function fictionalLegalPacket(model: CaseModelV1): ReviewedLegalPacket {
  const packet: ReviewedLegalPacket = {
    schemaVersion: 1, jurisdiction: 'Ontario', proceeding: 'ontario_criminal_jury_v1',
    issues: model.decisionIssues.map(i => ({ issueId: i.id, respondingPartyIds: i.respondingPartyIds, outcomes: i.permittedOutcomes, alternatives: [], elements: i.elements.map(e => ({ elementId: e.id, text: `Fictional fixture condition for ${e.id}; no statement of applicable law.`, burdenPartyId: i.claimantPartyId ?? model.parties[0].id, standard: e.burden, authorityIds: ['fixture'] })) })),
    instructions: (['duties', 'burden', 'elements', 'limited_use', 'deliberation'] as const).map(kind => ({ id: kind, kind, text: `Fictional ${kind} instruction: use only presented, permitted sources; counsel allegations are submissions; no preferred verdict.`, authorityIds: ['fixture'] })),
    authorities: [{ id: 'fixture', title: 'Fictional scenario conditions', jurisdiction: 'Ontario', type: 'guidance', url: 'https://fixture.invalid/scenario', pinpoint: 'Scenario conditions', asOf: '2026-10-03', retrievedAt: '2026-10-03', reviewed: true }], contentHash: '',
  }
  packet.contentHash = packetContentHash(packet)
  packet.review = { kind: 'fictional_fixture', reviewer: 'Software fixture author', reviewedAt: '2026-10-03', packetHash: packet.contentHash, attestation: 'Fictional software fixture only. No lawyer certification or legal validation.' }
  return packet
}

