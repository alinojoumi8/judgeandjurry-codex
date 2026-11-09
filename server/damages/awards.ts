import { roundHalfEven, sumCents } from '../forecast/money'
import { median } from '../forecast/stats'

// Juror amounts to a panel award. Pure: no database and no model.
//
// The rule (documented in damagesTypes `panelAwardRule` and covered by tests): the
// panel award in a category is the MEDIAN of the amounts of the jurors who count.
// A juror counts when their ballot on the question is valid, the amounts name every
// category exactly once, are whole non-negative cents, and are in the pinned
// currency. More than half the panel must count, or no panel award is given. The
// median of an even number of amounts is the average of the middle two, rounded
// half to even to a cent.

export interface AwardBallot {
  issueId: string
  actorId: string
  round: 'initial' | 'final'
  valid: boolean
  amounts?: ReadonlyArray<{ categoryId: string; amount: number; currency: string; basis: string }>
}

// Judges and adjudicators are not jurors.
const isJuror = (actorId: string) => !/^(?:judge|adjudicator)/i.test(actorId)

export interface JurorAmounts { actorId: string; byCategory: ReadonlyMap<string, number> }

export interface JurorAmountsResult {
  counted: JurorAmounts[]
  // Jurors who cast a ballot in this round but did not count, with the reason.
  left: Array<{ actorId: string; reason: string }>
}

// The jurors whose amounts count for one question in one round. A later ballot
// from the same juror in the same round replaces an earlier one.
export function jurorAmounts(ballots: readonly AwardBallot[], issueId: string, round: 'initial' | 'final', categoryIds: readonly string[], currency: string): JurorAmountsResult {
  const latest = new Map<string, AwardBallot>()
  for (const ballot of ballots) {
    if (ballot.issueId !== issueId || ballot.round !== round || !isJuror(ballot.actorId)) continue
    latest.set(ballot.actorId, ballot)
  }
  const counted: JurorAmounts[] = []
  const left: JurorAmountsResult['left'] = []
  for (const [actorId, ballot] of latest) {
    if (!ballot.valid) { left.push({ actorId, reason: 'The ballot is not valid.' }); continue }
    const amounts = ballot.amounts ?? []
    const byCategory = new Map<string, number>()
    let problem = ''
    for (const line of amounts) {
      if (!categoryIds.includes(line.categoryId)) problem = `The amounts name "${line.categoryId}", which is not a category asked.`
      else if (byCategory.has(line.categoryId)) problem = `Category "${line.categoryId}" is given more than once.`
      else if (!Number.isSafeInteger(line.amount) || line.amount < 0) problem = `The amount for "${line.categoryId}" is not whole non-negative cents.`
      else if (line.currency !== currency) problem = `The amount for "${line.categoryId}" is in ${line.currency}, not ${currency}.`
      else byCategory.set(line.categoryId, line.amount)
      if (problem) break
    }
    if (!problem) {
      const missing = categoryIds.filter((id) => !byCategory.has(id))
      if (missing.length) problem = `No amount for ${missing.map((id) => `"${id}"`).join(', ')}.`
    }
    if (problem) left.push({ actorId, reason: problem })
    else counted.push({ actorId, byCategory })
  }
  return { counted: counted.sort((a, b) => (a.actorId < b.actorId ? -1 : 1)), left }
}

export function medianCents(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('a median needs at least one amount')
  return roundHalfEven(median(values))
}

export interface PanelAward {
  jurors: number
  awards: Array<{ categoryId: string; cents: number }>
}

// The panel award, or a reason there is none.
export function panelAward(counted: readonly JurorAmounts[], categoryIds: readonly string[], panelSize: number): PanelAward | { reason: string } {
  if (counted.length * 2 <= panelSize) return { reason: `${counted.length} of ${panelSize} jurors gave usable amounts; more than half the panel is needed.` }
  return {
    jurors: counted.length,
    awards: categoryIds.map((categoryId) => ({ categoryId, cents: medianCents(counted.map((juror) => juror.byCategory.get(categoryId) as number)) })),
  }
}

export const sumOfAwards = (awards: ReadonlyArray<{ cents: number }>): number => sumCents(awards.map((line) => line.cents))
