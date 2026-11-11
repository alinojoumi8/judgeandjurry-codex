import { describe, expect, it } from 'vitest'
import type { PanelOutcome } from '../server/forecast/panelMath'
import { aggregateWinRates, formatPercent, formatWinRate, NOT_YET_TESTED_SENTENCE, type CalibrationEvidence, type ElementObservation, type FormatOptions, type RunLiabilityRecord } from '../server/forecast/winRates'

const outcomes = (claimant: number, defence: number, hung: number, extra: Partial<RunLiabilityRecord> = {}): RunLiabilityRecord[] => {
  const list: PanelOutcome[] = [...Array<PanelOutcome>(claimant).fill('claimant'), ...Array<PanelOutcome>(defence).fill('defence'), ...Array<PanelOutcome>(hung).fill('hung')]
  return list.map((outcome, i) => ({ runId: `run-${i}`, defendantId: 'd1', claimId: 'negligence', outcome, ...extra }))
}

const calibration: CalibrationEvidence = { passed: true, population: 'Ontario civil jury verdicts 2015-2025', realOutcomes: 120, reference: 'cal-2027-01' }

describe('aggregateWinRates', () => {
  it('counts completed runs and gives a Wilson interval over runs', () => {
    const [result] = aggregateWinRates(outcomes(40, 15, 5), { seed: 1 })
    expect(result).toBeDefined()
    expect(result!.completedRuns).toBe(60)
    expect(result!.claimantWins).toBe(40)
    expect(result!.defenceWins).toBe(15)
    expect(result!.hung).toBe(5)
    expect(result!.claimantWin.estimate).toBeCloseTo(2 / 3, 12)
    expect(result!.claimantWin.lower).toBeCloseTo(0.5406, 3)
    expect(result!.claimantWin.upper).toBeCloseTo(0.7727, 3)
    expect(result!.hungShare.estimate).toBeCloseTo(5 / 60, 12)
    expect(result!.exploratory).toBe(false)
  })

  it('reports each defendant and claim separately', () => {
    const records = [
      ...outcomes(3, 1, 0),
      ...outcomes(0, 4, 0, { defendantId: 'd2' }),
      ...outcomes(2, 2, 0, { claimId: 'nuisance' }),
    ]
    const results = aggregateWinRates(records, { seed: 1 })
    expect(results.map(r => `${r.defendantId}/${r.claimId}`).sort()).toEqual(['d1/negligence', 'd1/nuisance', 'd2/negligence'])
    expect(results.find(r => r.defendantId === 'd2')!.claimantWins).toBe(0)
  })

  it('excludes runs that did not complete and counts them', () => {
    const records = [...outcomes(5, 5, 0), { runId: 'failed', defendantId: 'd1', claimId: 'negligence', outcome: 'claimant' as const, completed: false }]
    const [r] = aggregateWinRates(records, { seed: 1 })
    expect(r!.completedRuns).toBe(10)
    expect(r!.excludedRuns).toBe(1)
    expect(r!.claimantWins).toBe(5)
  })

  it('labels fewer than 20 completed runs exploratory and 20 or more not', () => {
    expect(aggregateWinRates(outcomes(10, 9, 0), { seed: 1 })[0]!.exploratory).toBe(true)
    expect(aggregateWinRates(outcomes(10, 10, 0), { seed: 1 })[0]!.exploratory).toBe(false)
  })

  it('uses runs, not jurors, as the sample size: juror counts never enter the claim interval', () => {
    const withJurors = outcomes(6, 4, 0, { elements: [{ elementId: 'duty', jurorsMet: 30, jurorsTotal: 60 }] })
    const without = outcomes(6, 4, 0)
    const a = aggregateWinRates(withJurors, { seed: 1 })[0]!
    const b = aggregateWinRates(without, { seed: 1 })[0]!
    expect(a.claimantWin).toEqual(b.claimantWin)
    expect(a.claimantWin.trials).toBe(10)
  })

  it('rejects a repeated run, impossible juror counts and unknown outcomes', () => {
    const dup = [...outcomes(1, 0, 0), ...outcomes(1, 0, 0)]
    expect(() => aggregateWinRates(dup, { seed: 1 })).toThrow(/appears twice/)
    expect(() => aggregateWinRates(outcomes(1, 0, 0, { elements: [{ elementId: 'e', jurorsMet: 7, jurorsTotal: 6 }] }), { seed: 1 })).toThrow(/invalid juror counts/)
    expect(() => aggregateWinRates([{ runId: 'r', defendantId: 'd', claimId: 'c', outcome: 'settled' as PanelOutcome }], { seed: 1 })).toThrow(/unknown outcome/)
  })

  it('returns an empty list for no records', () => {
    expect(aggregateWinRates([], { seed: 1 })).toEqual([])
  })
})

describe('element results', () => {
  const withElements = (jurorsMetPerRun: number[], panelResults?: ('met' | 'not met' | 'hung')[]): RunLiabilityRecord[] =>
    jurorsMetPerRun.map((met, i) => {
      const obs: ElementObservation = { elementId: 'duty', jurorsMet: met, jurorsTotal: 6 }
      if (panelResults) obs.panelResult = panelResults[i]
      return { runId: `run-${i}`, defendantId: 'd1', claimId: 'negligence', outcome: 'claimant', elements: [obs] }
    })

  it('reports the pooled share of jurors who found the element met, with a seeded bootstrap over runs', () => {
    const [r] = aggregateWinRates(withElements([6, 5, 4, 3, 6, 5, 2, 4]), { seed: 11 })
    const duty = r!.elements.find(e => e.elementId === 'duty')!
    expect(duty.runsObserved).toBe(8)
    expect(duty.jurorShare).toBeCloseTo(35 / 48, 12)
    expect(duty.jurorShareInterval!.lower).toBeLessThan(duty.jurorShare!)
    expect(duty.jurorShareInterval!.upper).toBeGreaterThan(duty.jurorShare!)
    expect(duty.jurorShareInterval!.units).toBe(8)
    const again = aggregateWinRates(withElements([6, 5, 4, 3, 6, 5, 2, 4]), { seed: 11 })[0]!.elements[0]!
    expect(again).toEqual(duty)
  })

  it('gives no panel result when the element is not its own verdict question', () => {
    const [r] = aggregateWinRates(withElements([6, 5, 4, 3]), { seed: 1 })
    expect(r!.elements[0]!.panelMet).toBeNull()
  })

  it('gives a panel result with a Wilson interval over runs when the element is its own verdict question', () => {
    const [r] = aggregateWinRates(withElements([6, 6, 2, 6, 1], ['met', 'met', 'not met', 'met', 'hung']), { seed: 1 })
    const panel = r!.elements[0]!.panelMet!
    expect(panel.trials).toBe(4) // the hung run does not decide the element
    expect(panel.successes).toBe(3)
    expect(panel.estimate).toBeCloseTo(0.75, 12)
  })

  it('does not report a panel result if only some observations carry one', () => {
    const records = withElements([6, 5], ['met', 'met'])
    records.push(...withElements([4]).map(r => ({ ...r, runId: 'extra' })))
    expect(aggregateWinRates(records, { seed: 1 })[0]!.elements[0]!.panelMet).toBeNull()
  })

  it('never combines element shares into one probability', () => {
    // Elements are perfectly correlated here: every juror finds both or neither.
    const records: RunLiabilityRecord[] = Array.from({ length: 10 }, (_, i) => ({
      runId: `run-${i}`,
      defendantId: 'd1',
      claimId: 'negligence',
      outcome: (i < 5 ? 'claimant' : 'defence') as PanelOutcome,
      elements: [
        { elementId: 'duty', jurorsMet: i < 5 ? 6 : 0, jurorsTotal: 6 },
        { elementId: 'breach', jurorsMet: i < 5 ? 6 : 0, jurorsTotal: 6 },
      ],
    }))
    const [r] = aggregateWinRates(records, { seed: 1 })
    const shares = r!.elements.map(e => e.jurorShare!)
    expect(shares).toEqual([0.5, 0.5])
    // The claim result comes from panel outcomes (0.5), not from 0.5 * 0.5 = 0.25.
    expect(r!.claimantWin.estimate).toBe(0.5)
    expect(Object.keys(r!).sort()).not.toContain('combinedElementProbability')
    for (const e of r!.elements) expect(Object.keys(e)).not.toContain('combined')
  })
})

describe('formatPercent', () => {
  it('rounds half up to whole percents', () => {
    expect(formatPercent(2 / 3)).toBe('67%')
    expect(formatPercent(0.665)).toBe('67%')
    expect(formatPercent(0.285)).toBe('29%') // binary floating point stores 0.285 a hair low
    expect(formatPercent(0.125)).toBe('13%')
    expect(formatPercent(0.5405)).toBe('54%')
    expect(formatPercent(0.7727)).toBe('77%')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(1)).toBe('100%')
    expect(formatPercent(0.004)).toBe('0%')
    expect(() => formatPercent(1.1)).toThrow(RangeError)
    expect(() => formatPercent(Number.NaN)).toThrow(RangeError)
  })
})

describe('formatWinRate', () => {
  const sixty = () => aggregateWinRates(outcomes(40, 15, 5), { seed: 1 })[0]!

  it('produces the plan wording exactly', () => {
    expect(formatWinRate(sixty())).toBe(
      'Probability the plaintiff prevails: 67% (40 of 60 simulated panels; 95% interval 54% to 77%). Based on simulated panels and not yet tested against real outcomes.',
    )
  })

  it('takes the party label as a parameter', () => {
    expect(formatWinRate(sixty(), { partyLabel: 'claimant' })).toContain('Probability the claimant prevails: 67%')
  })

  it('prefixes exploratory results and uses singular wording for one run', () => {
    const few = aggregateWinRates(outcomes(3, 2, 0), { seed: 1 })[0]!
    expect(formatWinRate(few)).toMatch(/^Exploratory result: only 5 completed runs \(fewer than 20\)\. Probability the plaintiff prevails: 60% \(3 of 5 simulated panels;/)
    const one = aggregateWinRates(outcomes(1, 0, 0), { seed: 1 })[0]!
    expect(formatWinRate(one)).toContain('only 1 completed run (')
  })

  it('shows a "not yet tested" sentence whenever there is no valid calibration, whatever options are passed', () => {
    const variants: FormatOptions[] = [
      {},
      { partyLabel: '' },
      { calibration: undefined },
      { calibration: { passed: false, population: 'x', realOutcomes: 10, reference: 'r' } as unknown as CalibrationEvidence },
      { calibration: { passed: true, population: '', realOutcomes: 10, reference: 'r' } },
      { calibration: { passed: true, population: 'x', realOutcomes: 0, reference: 'r' } },
      { calibration: { passed: true, population: 'x', realOutcomes: 10, reference: ' ' } },
      { calibration: { population: 'x', realOutcomes: 10, reference: 'r' } as unknown as CalibrationEvidence },
      { calibration: 'passed' as unknown as CalibrationEvidence },
      { calibration: null as unknown as CalibrationEvidence },
      { omitDisclaimer: true, hideCaveat: true, calibrated: true } as unknown as FormatOptions,
    ]
    for (const options of variants) expect(formatWinRate(sixty(), options)).toContain(NOT_YET_TESTED_SENTENCE)
  })

  it('also states it when there are no completed runs', () => {
    const [none] = aggregateWinRates([{ runId: 'r', defendantId: 'd', claimId: 'c', outcome: 'claimant', completed: false }], { seed: 1 })
    expect(formatWinRate(none!)).toContain(NOT_YET_TESTED_SENTENCE)
    expect(formatWinRate(none!)).toContain('No completed simulated panels')
  })

  it('uses the calibrated wording only for complete, passed calibration evidence', () => {
    const text = formatWinRate(sixty(), { calibration })
    expect(text).toContain('Probability the plaintiff prevails: 67% (40 of 60 simulated panels; 95% interval 54% to 77%).')
    expect(text).toContain('calibrated against 120 real outcomes (Ontario civil jury verdicts 2015-2025; reference cal-2027-01)')
    expect(text).not.toContain(NOT_YET_TESTED_SENTENCE)
    expect(text).not.toContain('not yet tested')
  })

  it('does not hide the exploratory label even when calibrated', () => {
    const few = aggregateWinRates(outcomes(3, 2, 0), { seed: 1 })[0]!
    expect(formatWinRate(few, { calibration })).toMatch(/^Exploratory result/)
  })
})
