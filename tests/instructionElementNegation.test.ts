import { describe, expect, it } from 'vitest'
import { instructionElementDriftError } from '../server/instructionElementDrift'

const approved = [{ issueId: 'fictional-count', elements: [{ label: 'A dishonest act' }, { label: 'Economic prejudice caused by the act' }] }]

describe('local reliance requirement negation', () => {
  it.each([
    'The Crown must prove deception and deprivation, and investor reliance is not a listed element.',
    'The Crown must prove deception and deprivation and reliance is not required.',
    'The Crown must prove deception and deprivation; investor reliance is not a listed element.',
    'The Crown must prove deception, while reliance is never necessary.',
    'Reliance is not a required element.',
    'Reliance remains not a separate element.',
    'The Crown need not prove reliance, but must prove the listed conditions.',
    'It is incorrect to say the Crown must prove reliance.',
  ])('keeps an explicit local denial usable: %s', text => {
    expect(instructionElementDriftError(text, approved, [])).toBeUndefined()
  })

  it.each([
    'The Crown must prove investor reliance.',
    'Reliance is a required element.',
    'The Crown must prove reliance, and investor reliance is not a listed element.',
    'The Crown must prove reliance and reliance is not required.',
    'Reliance is not a listed element, but the Crown must prove reliance.',
    'Reliance is not a separate element, but reliance is a necessary element.',
    'The Crown need not prove identity, but the Crown must prove reliance.',
    'Reliance is not required to establish deception, yet reliance is a required element.',
    'The Crown need not prove identity, and the Crown must prove reliance.',
    'It is incorrect to say reliance is necessary, but the Crown must prove reliance.',
  ])('retains a separate positive requirement despite a neighboring denial: %s', text => {
    expect(instructionElementDriftError(text, approved, [])).toContain('adds investor reliance')
  })

  it('accepts a positive requirement when the controlling supplied model actually includes it', () => {
    expect(instructionElementDriftError('The Crown must prove reliance, and reliance is not a separate element.', [{ ...approved[0], elements: [{ label: 'Investor reliance' }] }], [])).toBeUndefined()
  })
})
