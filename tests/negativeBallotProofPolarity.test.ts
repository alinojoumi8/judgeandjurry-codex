import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, parseGroundingReview } from '../server/grounding'
import type { StageResult } from '../server/types'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v136-ambiguous-receipt-conclusion-capture.json', import.meta.url), 'utf8'))
const ambiguous = 'These disputed accounts leave receipt beyond a reasonable doubt.'
function ballot(): StageResult { return structuredClone(capture.generated) }
function check(result = ballot(), status = 'analysis') {
  const units = ballotConsistencyUnits(result)
  const q = capture.request
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Captured whole-ballot assessment.', citations: [] })) }), units, q.evidence, q.groundingContext, undefined,
    { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('negative ballots state the polarity of their proof assessment', () => {
  it('withholds the actual accepted negative ballot with an ambiguous affirmative proof formula', () => expect(check()).toBe('failed'))
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'] as const)('does not cure the %s claim with a correct adjacent field', field => {
    const r = ballot(); r.content = 'I find the Crown has not proved receipt beyond a reasonable doubt.'
    if (field === 'title' || field === 'content') r[field] = ambiguous
    else r.jurors![0][field] = ambiguous
    expect(check(r)).toBe('failed')
  })
  it('does not depend on the actual fixture participant names', () => {
    const r = JSON.parse(JSON.stringify(ballot()).replaceAll('Rowan', 'Avery').replaceAll('Ellis', 'Nox'))
    expect(check(r)).toBe('failed')
  })
  it.each([
    'These disputed accounts leave receipt unproved beyond a reasonable doubt.',
    'These disputed accounts leave me unconvinced beyond a reasonable doubt.',
    'I retain reasonable doubt about receipt.',
    'Do these disputed accounts leave receipt beyond a reasonable doubt?',
    'It is incorrect to say these disputed accounts leave receipt beyond a reasonable doubt.',
    'The Crown stated, "These disputed accounts leave receipt beyond a reasonable doubt." I do not adopt that claim.',
  ])('preserves clear negative proof, neutral inquiry, correction or unadopted report: %s', content => {
    const r = ballot(); r.content = content
    expect(check(r)).toBe('passed')
  })
  it('preserves a positive assessment when the actual chosen ballot and reason are positive', () => {
    const r = ballot(); r.content = ambiguous; r.jurors![0].leaning = 'crown'
    r.jurors![0].rationale = 'I credit Mira and find the supplied condition proved beyond a reasonable doubt.'
    r.jurors![0].mindChangedBecause = 'This is my initial position.'
    expect(check(r)).toBe('passed')
  })
  it('does not promote an independently failed whole-ballot review', () => {
    const r = ballot(); r.content = 'I retain reasonable doubt about receipt.'
    expect(check(r, 'unsupported')).toBe('failed')
  })
  it('does not override a failed positive whole-ballot judgment with the polarity guard', () => {
    const r = ballot(); r.content = ambiguous; r.jurors![0].leaning = 'crown'
    r.jurors![0].rationale = 'I credit Mira and find the supplied condition proved beyond a reasonable doubt.'
    r.jurors![0].mindChangedBecause = 'This is my initial position.'
    expect(check(r, 'contradicted')).toBe('failed')
  })
})
