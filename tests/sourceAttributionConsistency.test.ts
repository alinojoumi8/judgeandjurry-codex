import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const evidence = [
  { ...supportedOpeningSource, exhibitId: 'E-001', text: 'Arin states: Cedar Markets was described as the liquidity provider. I received no confirmation.' },
  { ...supportedOpeningSource, exhibitId: 'E-002', text: "Blake's affidavit quotes Arin: Cedar Markets mattered so much that without that connection I would not have provided my investment funds. Blake disputes that account." },
  { ...supportedOpeningSource, exhibitId: 'E-003', text: 'Arin states: I never relied on the Cedar Markets connection.' },
  { ...supportedOpeningSource, exhibitId: 'E-004', text: 'Arin states: I relied on the Birch Markets connection.' },
]
function check(text: string, ids: string[]) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', supportTypes: ['source'], explanation: 'Review the selected account.', citations: ids.map(exhibitId => ({ exhibitId, paragraph: 1 })) }] }), [{ id: 'content:1', text }], evidence)
}
describe('reported reliance belongs to its actual source', () => {
  it.each(['E-001', 'E-003', 'E-004'])('does not infer reliance from an affiliation, a denial, or a different connection: %s', id => {
    const result = check(`Arin's recorded account describes the representations and Arin’s reliance on the Cedar Markets connection (${id}).`, [id])
    expect(result.status).toBe('failed')
    expect(result.errors.join(' ')).toContain('reliance')
  })
  it('does not borrow reliance from a separately cited document', () => {
    expect(check("Arin's recorded account describes Arin’s reliance on the Cedar Markets connection (E-001); a disputed affidavit is also supplied (E-002).", ['E-001', 'E-002']).status).toBe('failed')
  })
  it('permits an accurately attributed disputed reliance quotation', () => {
    expect(check("Blake's affidavit quotes Arin describing Arin’s reliance on the Cedar Markets connection, and Blake disputes that account (E-002).", ['E-002']).status).toBe('passed')
  })
  it.each(["Whether Arin relied on the Cedar Markets connection remains unresolved (E-001).", "Arin's account does not establish Arin’s reliance on the Cedar Markets connection (E-001).", 'The account describes the Cedar Markets connection (E-001).', 'My reliance on the supplied account remains cautious.'])('preserves bounded questions, negation and affiliation-only reporting: %s', text => {
    expect(check(text, ['E-001']).status).toBe('passed')
  })
})
