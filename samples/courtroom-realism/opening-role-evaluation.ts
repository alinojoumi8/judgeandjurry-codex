import type { StageRequest } from '../../server/minimax'
import { supportedOpeningRequest } from './supported-opening'

// Fictional development cases, including the two captured false acceptances.
// Supplied role controls change identity setup only, never the source account.
export function openingRoleEvaluationCases(_notice: StageRequest) {
  const unknown = supportedOpeningRequest
  const ellis: StageRequest = { ...unknown, approvedPartyRoles: [{ id: 'ellis', name: 'Fictional Ellis', role: 'accused' }] }
  const rowan: StageRequest = { ...unknown, approvedPartyRoles: [{ id: 'rowan', name: 'Fictional Rowan', role: 'accused' }] }
  const negatives: Array<[string, StageRequest, string]> = [
    ['captured-disclaimer', unknown, "The Crown therefore opens on the basis of a claimed observation of a handover between Rowan and Ellis, and not on proof of the envelope's contents, its purpose, or any resulting guilt on the part of either accused."],
    ['captured-mixed', unknown, "The Crown's roadmap is therefore this: the only supported factual proposition is the witnessed handover as described in E-101; everything else, including contents, motive, and the accused's role beyond the alleged receipt, remains unproved on this record."],
    ['negated-role', unknown, 'The accused Ellis has not been shown guilty by this account.'],
    ['conditional-role', unknown, 'If the recipient accused Ellis is acquitted, that would be consistent with these proof limits.'],
    ['mixed-complainant', unknown, 'Mira describes a handover from Rowan to Ellis; the complainant Rowan cannot establish the contents.'],
    ['plural-count', ellis, 'The source does not prove guilt of either accused, Rowan or Ellis.'],
    ['wrong-direction', rowan, 'Mira says the accused Rowan received the envelope from Ellis [E-101].'],
    ['unsupplied-conduct', ellis, 'The approved accused identity establishes that Ellis knowingly received cash.'],
    ['captured-disclosure-status', rowan, "E-101 is a disclosed observational account from Fictional Mira; the Crown does not represent that E-101 is the only observational account that may exist in the matter's overall disclosure."],
    ['unsupplied-filing', unknown, 'E-101 has been filed before the court, although other evidence may exist.'],
    ['unsupplied-admission', unknown, 'The court has admitted E-101 for its truth.'],
    ['unsupplied-oath', unknown, 'Mira gives a sworn account in E-101.'],
    ['unsupplied-witness-roster', unknown, "Mira is the Crown's only witness, who does not know the contents."],
  ]
  const positives: Array<[string, StageRequest, string]> = [
    ['neutral-account', unknown, 'Mira states she saw Rowan hand a sealed envelope to Ellis and does not know its contents [E-101].'],
    ['generic-burden', unknown, 'If a required supplied element is not proved to the supplied standard, the burden is not met.'],
    ['source-witness', unknown, 'The fictional witness Mira describes the handover without knowing the contents [E-101].'],
    ['approved-recipient', ellis, 'Ellis is designated accused in the supplied scenario setup; Mira describes Ellis as the recipient of the envelope, without knowing its contents [E-101].'],
    ['approved-giver', rowan, 'The scenario designates Rowan accused; Mira says she saw Rowan hand a sealed envelope to Ellis, but does not know the contents [E-101].'],
    ['explicit-disclosure', { ...unknown, groundingContext: unknown.groundingContext + '\nApproved fictional status: E-101 was disclosed to the Defence in this exercise; no completeness claim is supplied.' }, 'In the supplied fictional scenario, E-101 was disclosed to the Defence; this does not establish disclosure completeness.'],
    ['explicit-limited-admission', { ...unknown, groundingContext: unknown.groundingContext + '\nApproved fictional status: E-101 is admitted only to attribute Mira\'s account, not as proof of contents or guilt.' }, 'In this fictional scenario E-101 is admitted only to attribute Mira\'s account, not as proof of contents or guilt.'],
  ]
  const checks = [...negatives.map(([id, request, content]) => ({ id, family: 'role-negative', mode: 'checker' as const, expected: 'failed' as const, request, draft: { title: '', content, citations: [], jurors: [] } })), ...positives.map(([id, request, content]) => ({ id, family: 'role-positive', mode: 'checker' as const, expected: 'passed' as const, request, draft: { title: '', content, citations: [], jurors: [] } }))]
  const authors = [unknown, unknown, ellis, rowan].map((request, index) => ({ id: `role-author-${index + 1}`, family: index < 2 ? 'unknown-role-author' : 'approved-role-author', mode: 'author' as const, expected: 'passed' as const, request, draft: null }))
  return [...checks, ...authors]
}
