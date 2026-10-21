import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import type { EvidenceItem } from '../server/types'

const context = 'E-001: admitted; permitted purposes: Assess the fictional condition using the attributed disputed account.'
const forbidden = "The limited-use rule states attributed accounts cannot satisfy the Crown's beyond-a-reasonable-doubt burden."
const check = (text: string, historical = false, permission = context) => parseGroundingReview(
  JSON.stringify({ findings: [{ unitId: 'juror-0:1', status: 'analysis', citations: [], recordCitations: historical ? [{ eventId: 'peer' }] : [] }] }),
  [{ id: 'juror-0:1', text }], [{ exhibitId: 'E-001', text: 'Mira states: I saw Rowan hand a blue token to Ellis.' } as EvidenceItem], permission,
  undefined, { packet: '', actorRoles: ['juror'], partyRoles: [], events: [{ eventId: 'peer', type: 'juror_deliberation_turn', actorId: 'juror-04', payload: { contribution: forbidden } }] },
)

describe('admitted account assessment and invented burden prohibitions', () => {
  it.each([
    forbidden,
    'The charge says disputed accounts can never meet the burden.',
    'Under the instruction, attributed material is incapable of satisfying the receipt condition.',
    'The rule requires independent corroboration before attributed accounts can establish receipt.',
    'The rule does not automatically establish guilt; attributed accounts cannot satisfy the burden under that rule.',
  ])('rejects an invented binding prohibition: %s', text => expect(check(text).status).toBe('failed'))
  it.each([
    'On this supplied record, the conflicting accounts do not satisfy the Crown burden.',
    'The accounts conflict; in my assessment these accounts cannot satisfy the burden on this record.',
    'Attribution does not automatically establish receipt.',
    'The instruction does not say attributed accounts cannot satisfy the burden.',
  ])('preserves assessments and denials of a blanket rule: %s', text => expect(check(text).status).toBe('passed'))
  it('preserves historically reporting the actual erroneous peer claim', () => expect(check(`Juror-04 argued that ${forbidden}`, true).status).toBe('passed'))
  it('rejects adopting the historically cited erroneous claim', () => expect(check(`Juror-04 argued that ${forbidden} I agree.`, true).status).toBe('failed'))
  it('keeps a separate agreement sentence attached to its reported premise for auditing', () => {
    const units = groundingUnits({ title: '', content: `Juror-04 argued that ${forbidden} I agree.`, citations: [] })
    expect(units).toHaveLength(1)
    expect(check(units[0].text, true).status).toBe('failed')
  })
  it('does not attach a disagreement or another juror field to the reported premise', () => {
    expect(groundingUnits({ title: '', content: `Juror-04 argued that ${forbidden} I disagree.`, citations: [] })).toHaveLength(2)
    expect(groundingUnits({ title: '', content: `Juror-04 argued that ${forbidden}`, citations: [], jurors: [{ juror: 'juror-01', leaning: 'defence', confidence: 60, rationale: 'I agree.', citations: [] }] })).toHaveLength(2)
  })
  it('preserves an actual attribution-only restriction', () => expect(check(forbidden, false, 'E-001: limited; permitted purposes: Accurately attribute Mira’s disputed account; not proof of contents or guilt.').status).toBe('passed'))
})
