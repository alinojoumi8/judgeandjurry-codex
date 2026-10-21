import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const peer = { eventId: 'peer-six', actorId: 'juror-06', type: 'juror_deliberation_turn', payload: { contribution: 'I credit the figures, but investor-specific knowledge and matched deprivation remain unresolved.' } }
const history = { actorId: 'juror-01', assessments: [{ round: 'initial', usable: true, choice: 'not_guilty' }] }
const setup = { packet: '', stage: 'jury_deliberation', actor: { id: 'juror-01' }, actorRoles: ['juror'], partyRoles: [], events: [peer], currentJuror: { actorId: 'juror-01', stage: 'jury_deliberation', proceedingPhase: 'deliberation_review', ballotRound: null, leaning: 'defence' as const, choice: 'not_guilty', confidence: 60 } }
function check(text: string, sourceText = '', options: { history?: typeof history; setup?: typeof setup; records?: string[]; status?: string; cite?: boolean } = {}) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'supported', explanation: 'The selected source and peer support the attributed statement.', recordCitations: options.records ?? ['peer-six'], citations: options.cite === false ? [] : [{ exhibitId: 'E-001', paragraph: 1 }] }] }), [{ id: 'content:1', text }], [{ ...supportedOpeningSource, exhibitId: 'E-001', text: sourceText }], '', options.history ?? history, options.setup ?? setup)
}

describe('monetary suffix boundaries', () => {
  it.each(['\nb) New section', '\nB. New section', '\n\nbillion balances', ' b) New section', ' B. New section', '\nm New section'])('does not multiply an amount by the following section: %s', suffix => {
    const result = check('E-001 records $420,700.', `The fictional report records $420,700${suffix}`)
    expect(result.errors).toEqual([])
    expect(check('E-001 records $420,700 billion.', `The fictional report records $420,700${suffix}`).status).toBe('failed')
  })
  it.each(['$2b', '$2 b', '$2B.', '$2 billion', '$2.0billion', 'CAD 2 billion', 'USD 2 billion', 'CDN 2 billion'])('retains a genuine billion suffix: %s', amount => {
    expect(check('E-001 records $2,000,000,000.', `The amount is ${amount}`).errors).toEqual([])
    expect(check('E-001 records $2.', `The amount is ${amount}`).status).toBe('failed')
  })
  it.each([['$3m', '$3,000,000'], ['$3 million', '$3,000,000'], ['$3 k', '$3,000'], ['$3 thousand', '$3,000']])('retains %s', (source, claim) => {
    expect(check(`E-001 records ${claim}.`, `The amount is ${source}.`).errors).toEqual([])
  })
})

describe('continued transcript pages', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `${i + 1} \t${i === 19 ? 'after that, Avery has control' : i === 20 ? 'of that money, including 24 dollars.' : 'The fictional answer continues.'}`).join('\n')
  const page = `CONFIDENTIAL\nVOLUNTARY INTERVIEW OF FICTIONAL AVERY\nPage 11\n${lines}`
  const quote = 'E-001 records “after that, Avery has control of that money, including 24 dollars.”'
  it('ignores printed line labels on a structurally identified continuation page', () => {
    const result = check(quote, page)
    expect(result.errors).toEqual([])
    expect(result.findings[0].citations[0]).toMatchObject({ quote: page, startOffset: 0, endOffset: page.length })
  })
  it.each([lines, page.replace('VOLUNTARY INTERVIEW OF FICTIONAL AVERY', 'Fictional sales list'), page.replace('Page 11', 'Items'), page.replace('21 \t', '23 \t')])('does not remove numbers without a complete transcript layout', text => {
    expect(check(quote, text).status).toBe('failed')
  })
  it.each(['control that money', 'including 25 dollars', 'control ... including 25 dollars'])('rejects changed spoken words: %s', replacement => {
    expect(check(`E-001 records “after that, Avery has ${replacement}.”`, page).status).toBe('failed')
  })
  it('keeps intervening questions and marks omissions explicitly', () => {
    const interrupted = page.replace('21 \tof that money, including 24 dollars.', '21 \tQ. Of the account?').replace('22 \tThe fictional answer continues.', '22 \tA. of that money, including 24 dollars.')
    expect(check(quote, interrupted).status).toBe('failed')
    expect(check(quote.replace('control of', 'control ... of'), interrupted).errors).toEqual([])
  })
})

describe('bounded peer assessments and source speaker', () => {
  const state = 'My initial Defence position remains stable because juror-06’s concrete figures do not establish investor-specific knowledge or matched deprivation.'
  it.each([state, state.replace('or matched', 'and matched'), 'I agree with juror-06’s concrete review.'])('accepts checked complete peer assessment: %s', text => {
    expect(check(text, '', { cite: false }).errors).toEqual([])
    expect(check(text, '', { cite: false, status: 'unsupported' }).status).toBe('failed')
    expect(check(text, '', { cite: false, records: [] }).status).toBe('failed')
    expect(check(text.replace('juror-06', 'juror-08'), '', { cite: false }).status).toBe('failed')
  })
  it.each([[], [{ ...history.assessments[0], usable: false }], [{ ...history.assessments[0], choice: 'guilty' }], [...history.assessments, ...history.assessments]].map(assessments => ({ assessments })))('requires unambiguous usable own history: %j', ({ assessments }) => {
    expect(check(state, '', { cite: false, history: { ...history, assessments } }).status).toBe('failed')
  })
  it.each([state.replace('do not establish', 'establish'), state.replace('.', ', and Avery stole the funds.'), 'I agree with juror-06’s review that Avery received the money.'])('requires evidence for added facts: %s', text => {
    expect(check(text, '', { cite: false }).status).toBe('failed')
  })
  const categories = 'Confirmed Subscribers and Suspected Subscribers are separate categories.'
  const sourceReply = 'I agree with juror-06’s concern about linkage: E-001 reports aggregate categories, including “Confirmed Subscribers” and “Suspected Subscribers,” but does not match individual loss [E-001].'
  it('checks source headings after agreement against the selected document', () => {
    expect(check(sourceReply, categories).errors).toEqual([])
    expect(check(sourceReply, categories, { records: [] }).status).toBe('failed')
    expect(check(sourceReply, categories, { cite: false }).status).toBe('failed')
    expect(check(sourceReply.replace('Suspected Subscribers,”', 'Verified Subscribers,”'), categories).status).toBe('failed')
  })
  it.each(['Juror-06 reports categories including “Confirmed Subscribers” [E-001].', 'E-001 was discussed, but juror-06 reports categories including “Confirmed Subscribers” [E-001].', 'Juror-06 reports that E-001 includes “Confirmed Subscribers” [E-001].', 'Juror-06 reports the report: “Confirmed Subscribers” [E-001].'])('does not lend source words to the peer: %s', text => {
    expect(check(text, categories).status).toBe('failed')
  })
})
