import type { StageRequest } from '../../server/minimax'
import type { EvidenceItem } from '../../server/types'

// Separate fictional development control. It does not modify the limited-notice
// fixture or establish a transaction as true, criminal, or proved.
export const supportedOpeningSource: EvidenceItem = {
  id: 'positive-witness-account', exhibitId: 'E-101', name: 'fictional-account.txt',
  text: 'Fictional witness Mira states: I saw Fictional Rowan hand the sealed envelope to Fictional Ellis. I do not know what the envelope contained.',
  summary: 'Fictional disputed eyewitness account.', tags: [], type: 'text',
  mimeType: 'text/plain', size: 147, ingestionStatus: 'stored',
  matterId: 'fictional-positive-control', uploadedAt: '2026-10-03T00:00:00Z',
  sha256: null, sourceAvailable: false, extractionWarning: null, archivedAt: null,
}

export const supportedOpeningRequest: StageRequest = {
  stage: 'crown_opening', courtroomProtocol: true, groundingRequired: true,
  packet: 'Approved party position: the Crown relies on Mira\'s disputed account of an envelope handover, not proof of its contents or guilt. Issue label: fictional envelope allegation. Actor: crown',
  evidence: [supportedOpeningSource], previousTurns: '',
  groundingContext: 'E-101: permitted for accurately attributing Mira\'s account and previewing that account; not proof of envelope contents or guilt. The account is disputed. No assertion of complete disclosure is authorized.',
}

// Test oracle only: replay control, never an actor substitution in a live run.
export const supportedOpeningControl = {
  title: 'Opening roadmap',
  content: 'The Crown relies on a disputed account, not a finding of guilt. Mira states: "I saw Fictional Rowan hand the sealed envelope to Fictional Ellis. I do not know what the envelope contained" [E-101]. That account could bear on a handover if accepted; it does not establish what was inside or prove guilt.',
  citations: ['E-101'], jurors: [],
}
