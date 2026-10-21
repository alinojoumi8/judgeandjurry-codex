import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import type { EvidenceItem } from '../server/types'

const units = (content: string) => groundingUnits({ title: 'Source review', content, citations: ['E-001', 'E-006'] }).filter(unit => unit.id.startsWith('content:'))

describe('citation sentence boundaries', () => {
  it.each(['para. 3', 'paras. 3–10', 'p. 8', 'pp. 21–22', 'sec. 4'])('keeps %s and its locator attached to the assertion', citation => {
    const statement = `The witness describes the payment (E-001, ${citation}).`
    expect(units(`${statement} The account remains disputed.`).map(unit => unit.text)).toEqual([statement, 'The account remains disputed.'])
  })

  it('preserves the complete multi-source citation from the captured failure pattern', () => {
    const statement = 'The recipient describes an internal calculation (E-001, paras. 21–22; E-006, para. 1).'
    expect(units(statement)).toEqual([{ id: 'content:1', text: statement }])
  })

  it('preserves quotes and titles while keeping independent sentences separate', () => {
    const statement = 'Dr. Rowan says “the payment was recorded” (E-001, para. 3).'
    expect(units(`${statement} The second source disagrees.`).map(unit => unit.text)).toEqual([statement, 'The second source disagrees.'])
    expect(units('The label ends with para. Another assertion follows.').map(unit => unit.text)).toEqual(['The label ends with para.', 'Another assertion follows.'])
  })

  it('still rejects an unsupported amount in a complete cited assertion', () => {
    const evidence = [{ id: 'ev1', exhibitId: 'E-001', text: 'The recipient received $300.' }] as EvidenceItem[]
    for (const [amount, status] of [[300, 'passed'], [900, 'failed']] as const) {
      const draftUnits = units(`The recipient received $${amount} (E-001, para. 1).`)
      const review = parseGroundingReview(JSON.stringify({ findings: draftUnits.map(unit => ({ unitId: unit.id, status: 'supported', citations: [{ exhibitId: 'E-001', paragraph: 1 }] })) }), draftUnits, evidence)
      expect(review.status).toBe(status)
    }
  })
})
