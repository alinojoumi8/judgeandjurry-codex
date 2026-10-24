import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: "Blake's affidavit states: The financing contract was unsigned." }]
type Event = NonNullable<Parameters<typeof parseGroundingReview>[5]>['events'][number]
const event: Event = { eventId: 'actual-defence', type: 'public_submission', actorId: 'accused', payload: { text: 'The Defence points to the unsigned financing contract.' } }
function audit(text: string, events: Event[] = [], records: string[] = [], status = 'supported') {
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': { status, supportTypes: ['source', 'record'], explanation: status === 'unsupported' ? 'The cited party statement does not support that attribution.' : 'The supplied account and selected statement support the attributed words.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: records.map(eventId => ({ eventId })) } } }),
    [{ id: 'content:1', text }], evidence, '', undefined,
    { packet: '', events, actorRoles: ['crown'], actor: { id: 'crown' }, partyRoles: [{ id: 'crown', role: 'crown' }, { id: 'accused', role: 'accused' }], stage: 'crown_rebuttal' })
}

describe('party attribution requires a usable public statement rather than an exhibit alone', () => {
  it.each(['points to', 'relies on', 'argues for'])('rejects an affidavit-only Defence attribution using %s', verb => {
    const text = `The Defence ${verb} the unsigned financing contract (E-001).`
    for (const events of [[], [{ ...event, payload: { text: '', withheld: true } }], [{ ...event, payload: { text: '' } }], [{ ...event, payload: { text: 'No valid model contribution was available for this turn.' } }]]) {
      const review = audit(text, events)
      expect(review.status).toBe('failed')
      expect(review.findings[0].status).toBe('unsupported')
    }
  })

  it('holds an otherwise usable public attribution until its exact record selector is supplied', () => {
    const text = 'The Defence points to the unsigned financing contract (E-001).'
    const missing = audit(text, [event])
    expect(missing.status).toBe('failed')
    expect(missing.errors.join(' ')).toContain('a record citation is required')
    expect(audit(text, [event], ['actual-defence']).status).toBe('passed')
    expect(audit(text, [event], ['record:1']).status).toBe('passed')
  })

  it('rejects wrong-party, withheld, duplicate and private record selectors', () => {
    const text = 'The Defence relies on the unsigned financing contract (E-001).'
    for (const events of [
      [{ ...event, actorId: 'crown' }],
      [{ ...event, payload: { ...event.payload, withheld: true } }],
      [event, { ...event }],
      [{ ...event, type: 'private_submission' }],
    ]) expect(audit(text, events, ['actual-defence']).status).toBe('failed')
  })

  it('preserves an accurate public-position paraphrase without treating that statement as evidence truth', () => {
    expect(audit('The Defence relies on the unsigned financing contract (E-001).', [event], ['actual-defence']).status).toBe('passed')
    const wrong = { ...event, payload: { text: 'The Defence points to the deposit date.' } }
    expect(audit('The Defence relies on the unsigned financing contract (E-001).', [wrong], ['actual-defence'], 'unsupported').status).toBe('failed')
  })

  it('does not infer the named opposing submission from an unrelated event or an unselected record', () => {
    const text = "The Defence addresses the Crown's submission directly."
    const crown: Event = { eventId: 'crown-submission', type: 'public_submission', actorId: 'crown', payload: { text: 'The supplied accounts remain disputed.' } }
    const check = (events: Event[], partyRoles: Array<{ id: string; role: string }>, selected: string[] = []) => parseGroundingReview(
      JSON.stringify({ findings: { 'content:1': { status: 'analysis', supportTypes: ['record', 'analysis'], explanation: 'The current author addresses the selected opposing submission.', citations: [], recordCitations: selected.map(eventId => ({ eventId })) } } }),
      [{ id: 'content:1', text }], [], '', undefined, { packet: '', events, actorRoles: ['defence'], partyRoles })
    expect(check([crown], [{ id: 'crown', role: 'crown' }], ['crown-submission']).status).toBe('passed')
    for (const [events, roles, selected] of [
      [[{ ...crown, actorId: 'unknown' }], [], []],
      [[{ ...crown, actorId: 'accused' }], [{ id: 'accused', role: 'accused' }], []],
      [[crown], [{ id: 'crown', role: 'crown' }], []],
      [[{ ...crown, payload: { ...crown.payload, withheld: true } }], [{ id: 'crown', role: 'crown' }], ['crown-submission']],
    ] as Array<[Event[], Array<{ id: string; role: string }>, string[]]>) expect(check(events, roles, selected).status).toBe('failed')
  })

  it.each([
    'The Defence could argue from the unsigned financing contract (E-001).',
    'I question the weight of the unsigned financing contract (E-001).',
    "Blake's affidavit states that the financing contract was unsigned (E-001).",
    'The Crown argues from the unsigned financing contract (E-001).',
  ])('preserves conditional challenges, source reporting and the current author own assessment: %s', text => {
    expect(audit(text).status).toBe('passed')
  })
})
