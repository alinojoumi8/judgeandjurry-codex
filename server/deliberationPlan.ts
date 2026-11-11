import { createHash } from 'node:crypto'

// Deliberation forecast (F9): who speaks, in what order, and how many turns.
// Pure and deterministic. It runs only for a run that opted in with
// `deliberationForecast: true`; every other run keeps the fixed order it has
// always had. Nothing here calls a model.
//
// Two weights come from the derived jury roles (server/jurorCognition.ts):
//   - speakingOrderWeight (the role's airtime times the juror's assertiveness)
//     decides WHEN a juror speaks, by a seeded weighted draw.
//   - airtimeWeight (the role alone) decides HOW MANY of a round's speaking
//     turns the juror takes.
// The total number of turns in a round is always one per juror, exactly as
// before, so the cost of a deliberation does not depend on the roles. The
// foreperson has no say over any vote: `forepersonControlsVote` stays false.

export const deliberationPlanVersion = 'deliberation-plan-v1'

export interface PlanJuror {
  jurorId: string
  speakingOrderWeight: number
  airtimeWeight: number
}

export interface PlannedTurn {
  // 1-based position within the round.
  slot: number
  jurorId: string
  // The seeded sort key behind the position, kept so the order can be audited.
  key: number
  speakingOrderWeight: number
  airtimeWeight: number
}

export interface RoundPlan {
  algorithmVersion: typeof deliberationPlanVersion
  phase: string
  round: number
  // False for the inventory and review rounds, where every juror speaks once.
  shareAirtime: boolean
  turnsPerJuror: Record<string, number>
  order: PlannedTurn[]
}

const positive = (value: number) => (Number.isFinite(value) && value > 0 ? value : 1)

// A uniform number in (0, 1), the same for the same text on every machine.
function unit(text: string): number {
  const digest = createHash('sha256').update(text).digest()
  return (digest.readUInt32BE(0) + 1) / (0xffffffff + 2)
}

// Divides `seats` among jurors in proportion to their airtime weight by the
// highest-averages (d'Hondt) method: each seat goes to the juror with the
// largest weight / (seats already held + 1). A tie goes to the lower juror id.
// A heavier juror takes more seats and a lighter one may take none.
export function allocateTurns(jurors: readonly Pick<PlanJuror, 'jurorId' | 'airtimeWeight'>[], seats: number): Record<string, number> {
  const held: Record<string, number> = Object.fromEntries(jurors.map((juror) => [juror.jurorId, 0]))
  const ordered = [...jurors].sort((a, b) => a.jurorId.localeCompare(b.jurorId))
  for (let seat = 0; seat < seats; seat += 1) {
    let best: (typeof ordered)[number] | undefined
    let bestAverage = -1
    for (const juror of ordered) {
      const average = positive(juror.airtimeWeight) / (held[juror.jurorId]! + 1)
      if (average > bestAverage + 1e-9) { best = juror; bestAverage = average }
    }
    if (best) held[best.jurorId]! += 1
  }
  return held
}

// The speaking order for one round. Each speaking turn gets a key
// ln(u) / weight, with u drawn from the run seed, the phase, the round, the
// juror and the turn number; the turns are sorted from the largest key. This is
// a weighted random order: a heavier weight tends to speak earlier, and the
// same seed always gives the same order. A different seed can give another.
export function planRound(input: { seed: string; phase: string; round: number; jurors: readonly PlanJuror[]; shareAirtime: boolean }): RoundPlan {
  const { seed, phase, round, jurors, shareAirtime } = input
  const turnsPerJuror = shareAirtime
    ? allocateTurns(jurors, jurors.length)
    : Object.fromEntries(jurors.map((juror) => [juror.jurorId, 1]))
  const entries = jurors.flatMap((juror) => Array.from({ length: turnsPerJuror[juror.jurorId] ?? 0 }, (_, copy) => ({
    juror,
    copy,
    key: Math.log(unit(`${seed}:deliberation-order:${phase}:${round}:${juror.jurorId}:${copy}`)) / positive(juror.speakingOrderWeight),
  })))
  entries.sort((a, b) => b.key - a.key || a.juror.jurorId.localeCompare(b.juror.jurorId) || a.copy - b.copy)
  return {
    algorithmVersion: deliberationPlanVersion, phase, round, shareAirtime, turnsPerJuror,
    order: entries.map((entry, index) => ({
      slot: index + 1, jurorId: entry.juror.jurorId, key: Math.round(entry.key * 1e6) / 1e6,
      speakingOrderWeight: entry.juror.speakingOrderWeight, airtimeWeight: entry.juror.airtimeWeight,
    })),
  }
}
