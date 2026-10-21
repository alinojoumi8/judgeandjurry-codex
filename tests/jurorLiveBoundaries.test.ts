import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const sources = [
  { ...supportedOpeningSource, exhibitId: 'E-001', text: 'Avery described a promised return. The report records $345.15 spent on research.' },
  { ...supportedOpeningSource, exhibitId: 'E-002', text: 'There were no withdrawals of cash sent back to ExampleCo. All withdrawals covered fees.' },
]
const instruction = { eventId: 'instruction-one', type: 'judicial_instruction', actorId: 'judge', payload: { text: 'The Crown must prove each element beyond a reasonable doubt.', issueInstructions: [{ elements: [{ label: 'The value of the subject matter exceeds $5,000', burden: 'Crown must prove beyond a reasonable doubt' }] }] } }
function check(text: string, instructions = true) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', supportTypes: ['source', 'analysis'], explanation: 'Each source clause is independently checked; the first clause states the present assessment under the supplied instruction.', citations: sources.map(source => ({ exhibitId: source.exhibitId, paragraph: 1 })), recordCitations: [] }] }), [{ id: 'content:1', text }], sources, '', undefined,
    { packet: '', actorRoles: ['juror'], partyRoles: [], actor: { id: 'juror-01' }, stage: 'juror_ballot', ballotRound: 'initial', currentJuror: { actorId: 'juror-01', stage: 'juror_ballot', proceedingPhase: 'instructions', ballotRound: 'initial', choice: 'not_guilty', leaning: 'defence', confidence: 70 }, events: instructions ? [instruction] : [] })
}

describe('saved live quotation and threshold boundaries', () => {
  it.each(['email', 'letter'])('binds a later %s quotation to its own trailing exhibit', sourceKind => {
    const text = `The recorded interview attributes a promised return to Avery (E-001), and Avery's ${sourceKind} states only that “There were no withdrawals of cash sent back to ExampleCo” (E-002).`
    expect(check(text).errors).toEqual([])
    expect(check(text.replace('(E-002)', '(E-001)')).status).toBe('failed')
    expect(check(text.replace('no withdrawals', 'several withdrawals')).status).toBe('failed')
    expect(check(text.replace(`Avery's ${sourceKind}`, `E-002's ${sourceKind}`).replace(' (E-002)', '')).errors).toEqual([])
    expect(check(text.replace(`Avery's ${sourceKind}`, `E-001's ${sourceKind}`)).status).toBe('failed')
  })
  it('keeps a negated Crown burden threshold separate from a quoted factual amount', () => {
    const text = 'I find the Crown has not proved beyond a reasonable doubt that Avery knowingly used a prohibited dishonest act causing deprivation exceeding $5,000: E-001 states “The report records $345.15 spent on research” (E-001).'
    expect(check(text).errors).toEqual([])
    for (const changed of [text.replace('$5,000', '$6,000'), text.replace('exceeding', 'at least'), text.replace('has not proved', 'has proved'), text.replace('$345.15', '$346.15'), `${text} Avery received $5,000.`]) expect(check(changed).status).toBe('failed')
    expect(check(text, false).status).toBe('failed')
  })
})
