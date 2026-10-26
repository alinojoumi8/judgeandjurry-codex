import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const approved = [{ issueId: 'fictional-fraud', elements: [{ label: 'The value of the subject matter of the alleged fraud exceeds $1,500' }] }]
const captured = 'Members of the Jury Panel, the Crown bears the burden on every element of the proposed fraud over $1,500 count and must prove each beyond a reasonable doubt.'
const delivered: GroundingRecordEvent = { eventId: 'current-instruction', type: 'judicial_instruction', payload: { text: 'Apply these exercise elements.', issueInstructions: approved } }
function check(text = captured, options: { approved?: typeof approved; events?: GroundingRecordEvent[]; source?: string; status?: string } = {}) {
  const evidence = options.source ? [{ ...supportedOpeningSource, exhibitId: 'E-001', text: options.source }] : []
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'analysis', supportTypes: evidence.length ? ['source', 'instruction', 'analysis'] : ['instruction'], explanation: 'The reference identifies the supplied exercise, without asserting a source transaction or completed proof.', citations: evidence.map(source => ({ exhibitId: source.exhibitId, paragraph: 1 })), recordCitations: [] }] }), [{ id: 'content:1', text }], evidence, '', undefined, { packet: '', events: options.events ?? [], actorRoles: [], partyRoles: [], approvedIssueInstructions: options.approved ?? approved })
}

describe('approved count references in normative burden context', () => {
  it.each([
    captured,
    captured.replace('bears the burden on', 'has the burden on'),
    captured.replace('bears the burden on', 'carries the onus on'),
    'On the proposed fraud over $1,500 count, the Crown must establish each element beyond a reasonable doubt.',
    'For the proposed fraud over $1,500 count, the burden of proof remains with the Crown.',
    'The burden of proof on the proposed fraud over $1,500 count rests with the Crown.',
    'The Crown is required to establish every element of the proposed fraud over $1,500 count.',
    'The Crown has to prove the elements of the proposed fraud over $1,500 count.',
    'Every element of this proposed fraud over $1,500 count must be proved beyond a reasonable doubt.',
    'The proposed fraud over $1,500 count has elements that must each be proved beyond a reasonable doubt.',
    'Under the supplied exercise, every element of the proposed fraud over $1,500 count must be established beyond a reasonable doubt.',
    'The Crown must prove every element of the proposed fraud over $1,500 count, without asserting a payment.',
    captured.replace('fraud over', 'fraud greater than'),
  ])('binds the reference independently of the position or form of the burden: %s', text => {
    expect(check(text).errors).toEqual([])
  })

  it('requires the unique current approval, amount and currency even beside matching source money', () => {
    const source = 'The report records $1,500, $1,600 and USD $1,500.'
    for (const options of [{ approved: [] }, { approved: [...approved, { ...approved[0], issueId: 'other' }] }, { approved: [{ ...approved[0], elements: [...approved[0].elements, ...approved[0].elements] }] }, { events: [{ ...delivered, payload: { ...delivered.payload, withheld: true } }] }, { events: [delivered, delivered] }]) {
      expect(check(captured, { ...options, source }).status).toBe('failed')
    }
    expect(check(captured.replace('$1,500', '$1,600'), { source }).status).toBe('failed')
    expect(check(captured.replace('$1,500', 'USD $1,500'), { source }).status).toBe('failed')
    expect(check(captured, { events: [delivered], approved: [] }).errors).toEqual([])
    expect(check(captured, { events: [delivered, { ...delivered, eventId: 'later', payload: { ...delivered.payload, issueInstructions: [{ ...approved[0], elements: [{ label: 'The value exceeds $1,600' }] }] } }], source }).status).toBe('failed')
  })
  it('preserves an existing proposed-count caption for another supplied exercise', () => {
    expect(check('For this proposed theft over $1,500 count, each supplied element remains a Crown question.', { approved: [{ ...approved[0], elements: [{ label: 'The value of the subject matter of the alleged theft exceeds $1,500' }] }] }).errors).toEqual([])
  })

  it.each([
    `The report states ${captured}`,
    `The report states the following; ${captured}`,
    `The report states “${captured}” (E-001).`,
    `“${captured}”`,
    `'${captured}'`,
    `‘${captured}’`,
    `‘${captured.slice(0, -1)}, preserving the Crown’s burden.’`,
    captured.replace('proposed', 'operative'),
    captured.replace('proposed', 'filed'),
    captured.replace('bears the burden on', 'does not bear the burden on').replace('and must prove', 'and need not prove'),
    'The Crown has already proved every element of the proposed fraud over $1,500 count.',
    'The Crown must prove the amount paid under the proposed fraud over $1,500 count.',
    'The Crown must prove each element of the proposed fraud over $1,500 count for the actual criminal count.',
    'The Crown must prove the payment of $1,500 under the proposed fraud over $1,500 count.',
    'The Crown must prove each element of the proposed fraud over $1,500 count that was filed yesterday.',
    `In the prior trial, ${captured}`,
    `Mira said ${captured}`,
    'The burden of proof on the proposed fraud over $1,500 count does not rest with the Crown.',
    'The burden of proof on the proposed fraud over $1,500 count never lies with the Crown.',
    "The burden of proof on the proposed fraud over $1,500 count doesn't remain with the Crown.",
    'The burden of proof on the proposed fraud over $1,500 count rests not with the Crown.',
  ])('retains source, charge, factual and denial boundaries: %s', text => {
    expect(check(text).status).toBe('failed')
  })

  it('preserves a genuinely source-backed report of the words', () => {
    expect(check(`The report states “${captured}” (E-001).`, { source: `The report states “${captured}”.` }).errors).toEqual([])
  })
  it('does not borrow normative scope from a separate, source-backed quotation', () => {
    expect(check('“The Crown must prove every element” precedes the proposed fraud over $1,500 count (E-001).', { source: 'The source states “The Crown must prove every element”.' }).status).toBe('failed')
  })

  it('checks every neighboring amount occurrence independently', () => {
    const source = 'The report records a blue token.'
    for (const text of [`${captured} Arin received $1,500 (E-001).`, captured.replace('.', ', and Arin received $1,500 (E-001).'), `Arin received $1,500 (E-001); ${captured}`]) {
      expect(check(text, { source }).status).toBe('failed')
    }
    expect(check(`${captured} Arin received $1,500 (E-001).`, { source: 'Arin received $1,500.' }).errors).toEqual([])
    expect(check(`The report records $1,500.50 (E-001); ${captured}`, { source: 'The report records $1,500.50.' }).errors).toEqual([])
    expect(check(captured, { status: 'unsupported' }).status).toBe('failed')
  })
})
