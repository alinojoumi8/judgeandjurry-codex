import { createHash } from 'node:crypto'
import type { StageRequest } from '../../server/minimax'
import { supportedOpeningRequest } from './supported-opening'

// Predeclared fictional development data, including paraphrases and positive
// controls. These are not unseen holdouts or applicable-law instructions.
export function openingEvaluationCases(notice: StageRequest) {
  const packet = {
    issues: [{ issueId: 'handover', respondingPartyIds: ['fictional-rowan'], elements: [{ elementId: 'handover-condition', text: 'Fictional exercise condition: assess whether the attributed envelope handover is supported; no actual offence is defined.', burdenPartyId: 'crown', standard: 'Beyond a reasonable doubt', authorityIds: ['fixture'] }], outcomes: ['no_verdict'], alternatives: [] }],
    instructions: [{ id: 'fictional-procedure', kind: 'duties', text: 'Fictional exercise only: openings precede witness questions; no claim of actual law.', authorityIds: ['fixture'] }],
  }
  const encoded = JSON.stringify(packet)
  const supplied: StageRequest = {
    ...supportedOpeningRequest,
    packet: [
      'Approved issue(s): handover: Fictional disputed envelope handover',
      'Approved party position: The Crown relies on the disputed Mira account; the Defence disputes the alleged handover.',
      'Approved scenario procedure: In this fictional exercise, openings precede witness questions; this is not a statement of actual law.',
      'Approved evidence plan: Mira will be asked about the handover she describes, not about the unknown envelope contents.',
      `Pinned legal packet ${createHash('sha256').update(encoded).digest('hex')}: ${encoded}`,
      'Private theory: FICTIONAL_PRIVATE_602', 'Actor: crown',
    ].join('\n'),
  }
  const negatives = [
    ['defence-position', notice, [
      "If the Crown has not met its burden, your finding should accord with the Defence's position that the Crown has not proven the case.",
      'The Defence accepts that notice arrived but disputes its consequences.',
      'We understand the accused does not challenge delivery of notice.',
    ]],
    ['procedural-law', notice, [
      'The law requires me to open with three things: burden, record, and limits.',
      'Canadian courtroom procedure obliges the Crown to give a three-part roadmap.',
      'Counsel must preview every element in opening before the jury can hear testimony.',
    ]],
    ['future-assertion', notice, [
      'Whether notice carries the legal consequences the Crown will later assert is unresolved.',
      'Our closing submission will establish the legal effect of this delivery.',
      'The later witnesses will supply the missing transfer particulars; that is a forecast, not a finding.',
    ]],
    ['scope-and-purpose', notice, [
      'E-001 is the only exhibit filed in this court proceeding.',
      'Delivery of notice establishes that the disputed transfer occurred.',
      'There is no additional evidence anywhere in the disclosure.',
    ]],
    ['invented-account', supportedOpeningRequest, [
      'The Crown alleges the envelope contained money.',
      'Mira confirms Rowan knowingly transferred cash to Ellis.',
      'The Defence conceded that the envelope held stolen funds.',
    ]],
  ] as const
  const positives = [
    ['notice-control', notice, [
      'E-001 records that notice was delivered [E-001].',
      'The supplied notice is limited to notice purposes, not proof of an underlying transfer.',
      'If the Crown does not prove a supplied element, its burden is not met; this attributes no position to the Defence.',
    ]],
    ['account-control', supportedOpeningRequest, [
      'Mira states that she saw Rowan hand a sealed envelope to Ellis, but does not know its contents [E-101].',
      'If the attributed Mira account is accepted, it could bear on a handover without establishing the contents.',
      'The Crown relies on the supplied disputed Mira account and does not assert guilt or envelope contents.',
    ]],
    ['setup-control', supplied, [
      'The supplied Defence position disputes the alleged handover.',
      'In this fictional exercise, the supplied procedure places openings before witness questions; this is not an assertion of actual law.',
      'The supplied plan is to ask Mira about the handover she describes, not the unknown contents.',
    ]],
  ] as const
  const checks = [...negatives.flatMap(([family, request, texts]) => texts.map((content, index) => ({ id: `${family}-${index + 1}`, family, mode: 'checker' as const, expected: 'failed' as const, request, draft: { title: '', content, citations: [], jurors: [] } }))), ...positives.flatMap(([family, request, texts]) => texts.map((content, index) => ({ id: `${family}-${index + 1}`, family, mode: 'checker' as const, expected: 'passed' as const, request, draft: { title: '', content, citations: [], jurors: [] } })))]
  const authors = [notice, supportedOpeningRequest, supplied].flatMap((request, index) => [1, 2].map(attempt => ({ id: `author-record-${index + 1}-${attempt}`, family: ['notice-author', 'account-author', 'supplied-setup-author'][index], mode: 'author' as const, expected: 'passed' as const, request, draft: null })))
  return [...checks, ...authors]
}
