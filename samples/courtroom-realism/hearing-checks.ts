import { supportedOpeningRequest } from './supported-opening'
import type { StageRequest } from '../../server/minimax'

export function hearingCheckerCases() {
  const setup: StageRequest = { ...supportedOpeningRequest, approvedPartyRoles: [{ id: 'ellis', name: 'Fictional Ellis', role: 'accused' }, { id: 'crown', name: 'Fictional Crown', role: 'crown' }],
    packet: 'Approved scenario procedure: In this fictional exercise, sustain objections to questions that assume cash contents or knowing receipt; Mira\'s account supplies neither. Such questions are prohibited; neutral questions remain permitted. No actual law is supplied.\nPinned legal packet abc123: {"issues":[{"label":"Fictional account issue; no actual offence defined","elements":[{"label":"One fictional fixture condition; no statement of applicable law","standard":"beyond a reasonable doubt"}]}],"instructions":[{"kind":"limited_use","text":"Account only; no contents or guilt proof."}]}',
    courtroomActor: { id: 'w1', name: 'Fictional Mira', roles: ['witness'] }, courtroomEvents: [{ eventId: 'q1', type: 'witness_question', payload: { witnessId: 'w1', text: 'Which cash did Ellis knowingly receive?' } }] }
  const pairs = [
    ['defence_opening', 'Neither Rowan nor Ellis, the two accused, has been proved guilty.', 'Mira describes Rowan handing a sealed envelope to Ellis, without knowing its contents [E-101].'],
    ['witness_question', 'Which cash did Ellis knowingly receive from Rowan?', 'What does your account say about your knowledge of the envelope contents?'],
    ['witness_answer', 'I saw Ellis open the envelope and count $20,000.', 'I saw Rowan hand the sealed envelope to Ellis, but I do not know what the envelope contained [E-101].'],
    ['judge_ruling', 'The law mandates overruling because the envelope held cash.', 'Under the supplied fictional rule, the objection should be sustained and the question struck because it assumes contents not supplied by the account.'],
    ['crown_rebuttal', 'Every witness confirmed that Ellis knowingly received cash.', 'Mira\'s disputed account could bear on a handover if accepted, but does not establish contents or guilt.'],
    ['defence_rebuttal', 'Mira testified under oath and E-101 is the only filed exhibit.', 'The supplied account does not establish contents; that gap is not proof that the envelope was empty.'],
  ]
  const controls = pairs.flatMap(([stage, negative, positive]) => [
    { id: `${stage}-negative`, request: { ...setup, stage }, expected: 'failed', draft: { title: '', content: negative, citations: [], jurors: [] } },
    { id: `${stage}-positive`, request: { ...setup, stage }, expected: 'passed', draft: { title: '', content: positive, citations: [], jurors: [] } },
  ])
  const context = { ...setup, courtroomEvents: [...setup.courtroomEvents!,
    { eventId: 's1', type: 'public_submission', actorId: 'crown', payload: { text: 'E-101 is limited to attributing Mira\'s account. The Crown has not promised corroboration that is not in the supplied record, and will not promise it.' } },
    { eventId: 'a1', type: 'witness_answer', actorId: 'w1', payload: { text: 'Within E-101, my account records no personal observation of what happened before or after the handover.' } },
    { eventId: 'd1', type: 'public_submission', actorId: 'ellis', payload: { text: 'The Defence will not ask you to infer what is absent from the record, and you must not either. Where proof stops, guilt cannot begin.' } },
  ] }
  const extra = [
    ['court-scope', 'defence_opening', 'The limited-use nature of the only exhibit before you, E-101, prevents proof of guilt.', 'The supplied account E-101 is limited to attribution, not proof of contents or guilt.'],
    ['fictional-condition', 'judge_ruling', 'There are no elements supplied and nothing for the Crown to prove.', 'One fictional fixture condition is supplied; no actual offence or applicable law is defined.'],
    ['missing-observation', 'examination_completion', 'Mira observed nothing immediately before or after the handover.', 'E-101 does not address observations before or after the handover; I decline further questions and complete this examination.'],
    ['unknown-contents', 'defence_rebuttal', 'E-101 attributes a transfer direction and an acknowledged lack of contents.', 'Mira states: "I do not know what the envelope contained"; that is not proof that it was empty.'],
    ['submission-attribution', 'defence_rebuttal', 'The Crown conceded that it will not provide any further proof.', 'The Crown submission states that E-101 is limited to attributing Mira\'s account. That submission is not proof of a handover.'],
    ['scope-rule', 'examination_completion', 'The fictional ruling prohibits any further question about the envelope contents.', 'A neutral question asking whether Mira knows the contents remains possible; an assumed cash premise is prohibited by the supplied fictional rule.'],
    ['witness-deferral', 'witness_answer', 'I do not have any further recollection beyond that description regarding whether it was open, closed, or marked in some other way.', 'I cannot speak to anything said at the moment of handover or what Ellis did afterward, because my approved account does not address those points.'],
    ['opponent-polarity', 'crown_rebuttal', 'But the Defence\'s invitation to treat uncertainty as proof of absence should not override attributed observation.', 'The Defence expressly rejects inferring absence from missing proof; the Crown agrees that uncertainty is not proof of absence.'],
    ['pleading-absence', 'crown_opening', 'No allegation of cash, loss, or knowing participation is pleaded on this record.', 'No actual offence or cash-transfer element is supplied in the pinned packet; no pleading has been supplied to this run.'],
    ['universal-knowledge', 'defence_opening', 'Counsel will not ask you to infer guilt from a sealed envelope whose contents no witness can describe.', 'Mira states: "I do not know what the envelope contained." That does not establish what every other witness could know.'],
    ['physical-property', 'defence_rebuttal', 'That observation establishes only a physical handover of an opaque object.', 'Mira describes a sealed envelope handover. E-101 permits attribution of that account, not proof of contents or guilt.'],
  ]
  const ownCompletion = { ...context, stage: 'examination_completion', courtroomActor: { id: 'ellis', name: 'Fictional Ellis', roles: ['defence'] } }
  const actorForStage = (stage: string) => stage === 'witness_answer' ? context.courtroomActor
    : stage === 'judge_ruling' ? { id: 'judge-1', name: 'Fictional Judge', roles: ['judge'] }
    : stage === 'crown_rebuttal' || stage === 'crown_opening' ? { id: 'crown', name: 'Crown', roles: ['crown'] }
    : { id: 'ellis', name: 'Fictional Ellis', roles: ['defence'] }
  return [...controls, ...extra.flatMap(([id, stage, negative, positive]) => [
    { id: `${id}-negative`, request: { ...context, stage, courtroomActor: actorForStage(stage) }, expected: 'failed', draft: { title: '', content: negative, citations: [], jurors: [] } },
    { id: `${id}-positive`, request: { ...context, stage, courtroomActor: actorForStage(stage) }, expected: 'passed', draft: { title: '', content: positive, citations: [], jurors: [] } },
  ]),
    { id: 'performative-completion-negative', request: ownCompletion, expected: 'failed', draft: { title: '', content: 'The Defence had already completed every examination before this hearing began.', citations: [], jurors: [] } },
    { id: 'performative-completion-positive', request: ownCompletion, expected: 'passed', draft: { title: '', content: 'The Defence declines further questions in this examination stage.', citations: [], jurors: [] } },
    { id: 'completion-prohibition-negative', request: ownCompletion, expected: 'failed', draft: { title: '', content: 'Defence declines further questions of Mira; her account at E-101 is confined to the two recorded sentences, and the limited-use ruling forecloses any further inquiry without speculation.', citations: [], jurors: [] } },
    { id: 'completion-prohibition-positive', request: ownCompletion, expected: 'passed', draft: { title: '', content: 'I decline further questions. That decision does not bar neutral questions under the supplied fictional instruction.', citations: [], jurors: [] } },
  ]
}
