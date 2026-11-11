import { describe, expect, it } from 'vitest'

import { allocateTurns, planRound, type PlanJuror } from '../server/deliberationPlan'

const jurors = (weights: Array<[number, number]>): PlanJuror[] => weights.map(([airtimeWeight, speakingOrderWeight], index) => ({ jurorId: `juror-0${index + 1}`, airtimeWeight, speakingOrderWeight }))

// The weights the derived roles give: driver 1.5, facilitator 1.2, mediator 1,
// two participants 1, one quiet juror 0.5 (see server/jurorCognition.ts).
const panel = jurors([[1.5, 1.5], [1.2, 1.2], [1, 1], [1, 1], [1, 1], [0.5, 0.5]])

describe('deliberation plan: airtime', () => {
  it('shares a round of six turns by airtime weight with the highest-averages method', () => {
    // Quotients: 1.5, 1.2, 1, 1, 1, 0.5 take the first five seats; the sixth is
    // the driver's second (1.5 / 2 = 0.75, ahead of 0.6 and 0.5). The quiet juror gets none.
    expect(allocateTurns(panel, 6)).toEqual({ 'juror-01': 2, 'juror-02': 1, 'juror-03': 1, 'juror-04': 1, 'juror-05': 1, 'juror-06': 0 })
  })

  it('always hands out exactly the seats it was given, so the number of turns never depends on the roles', () => {
    for (const weights of [panel, jurors([[0.5, 1], [0.5, 1], [0.5, 1]]), jurors([[1.5, 1], [0.5, 1]]), jurors(Array.from({ length: 12 }, (_, index) => [0.5 + (index % 3) * 0.5, 1] as [number, number]))]) {
      for (const seats of [1, weights.length, weights.length + 3]) {
        expect(Object.values(allocateTurns(weights, seats)).reduce((a, b) => a + b, 0)).toBe(seats)
      }
    }
  })

  it('breaks a tie by juror id and treats a weight that is not a positive number as 1', () => {
    expect(allocateTurns(jurors([[1, 1], [1, 1], [1, 1]]), 2)).toEqual({ 'juror-01': 1, 'juror-02': 1, 'juror-03': 0 })
    expect(allocateTurns([{ jurorId: 'a', airtimeWeight: Number.NaN }, { jurorId: 'b', airtimeWeight: -4 }], 2)).toEqual({ a: 1, b: 1 })
  })

  it('gives every juror one turn when airtime is not shared', () => {
    const plan = planRound({ seed: 's', phase: 'deliberation_inventory', round: 1, jurors: panel, shareAirtime: false })
    expect(plan.turnsPerJuror).toEqual(Object.fromEntries(panel.map((juror) => [juror.jurorId, 1])))
    expect(plan.order.map((turn) => turn.jurorId).sort()).toEqual(panel.map((juror) => juror.jurorId))
  })
})

describe('deliberation plan: speaking order', () => {
  const order = (seed: string, round = 1, phase = 'deliberation_challenges', share = true) => planRound({ seed, phase, round, jurors: panel, shareAirtime: share }).order

  it('is the same for the same seed and different for another', () => {
    expect(order('seed-a')).toEqual(order('seed-a'))
    expect(order('seed-a').map((turn) => turn.jurorId)).not.toEqual(order('seed-b').map((turn) => turn.jurorId))
    expect(order('seed-a', 2).map((turn) => turn.jurorId)).not.toEqual(order('seed-a', 1).map((turn) => turn.jurorId))
  })

  it('numbers slots from 1, gives each seated turn its juror, and holds exactly one turn per juror per round', () => {
    const plan = planRound({ seed: 'seed-a', phase: 'deliberation_challenges', round: 1, jurors: panel, shareAirtime: true })
    expect(plan.order.map((turn) => turn.slot)).toEqual([1, 2, 3, 4, 5, 6])
    expect(plan.order.filter((turn) => turn.jurorId === 'juror-01')).toHaveLength(2)
    expect(plan.order.filter((turn) => turn.jurorId === 'juror-06')).toHaveLength(0)
    expect(plan.algorithmVersion).toBe('deliberation-plan-v1')
  })

  it('lets a heavier speaking-order weight speak earlier more often, across many seeds', () => {
    const heavy = jurors([[1, 8], [1, 1]])
    let heavyFirst = 0
    for (let index = 0; index < 400; index += 1) {
      if (planRound({ seed: `s-${index}`, phase: 'deliberation_inventory', round: 1, jurors: heavy, shareAirtime: false }).order[0]!.jurorId === 'juror-01') heavyFirst += 1
    }
    // P(first) = 8 / (8 + 1) = 0.889 in expectation; allow a wide band.
    expect(heavyFirst / 400).toBeGreaterThan(0.8)
    expect(heavyFirst / 400).toBeLessThan(0.96)
  })

  // A regression pin, recorded from this implementation (a hash cannot be worked
  // out by hand). A change to the order for a given seed is a new algorithm
  // version: saved runs keep the order they recorded.
  it('pins the order for a recorded seed', () => {
    expect(order('golden-seed', 1, 'deliberation_inventory', false).map((turn) => turn.jurorId)).toEqual(['juror-04', 'juror-01', 'juror-02', 'juror-05', 'juror-06', 'juror-03'])
  })
})
