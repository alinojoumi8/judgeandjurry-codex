// The cost preview for a full proceeding. It is a pure function so the screen and
// the tests use the same arithmetic.
//
// `stageCalls` is what the engine sends to the model for the proceeding itself:
// ballots, deliberation, advocacy and motion hearings. Each of those is followed
// by a source check, which is why the preview doubles it. Witness examinations
// are not counted here, as before.
//
// `cognitionCalls` is what juror cognition adds: one private appraisal per juror
// for each opening, direct examination, cross-examination and closing. Appraisals
// are checked in code against the admitted record, not by a second model call, so
// they are not doubled.
//
// `forecastCalls` is what the deliberation forecast adds, and it is present only
// when the forecast is on: one straw-poll vote per juror per question for each
// round of challenges (maxRounds minus the inventory and review rounds, at least
// one). A straw-poll vote is a source-checked ballot, so the preview counts it
// twice, like every other ballot. The forecast adds no deliberation turns: a
// round still has one turn per juror, and airtime only decides who takes them.
//
// `calls` is the preview figure: 2 x stageCalls + cognitionCalls + 2 x
// forecastCalls. With cognition and the forecast off it is the figure the screen
// has always shown.

export interface RunEstimateInput {
  // Jurors on the panel, or adjudicators.
  panel: number
  issues: number
  parties: number
  approvedMotions: number
  // The screen always asks for a full proceeding. A screen run has openings only.
  mode?: 'screen' | 'full'
  // Witnesses in the plan, for the appraisal segments only.
  witnesses?: number
  jurorCognition?: boolean
  deliberationForecast?: boolean
  // maxRounds of the run, for the number of straw polls. The screen always uses 3.
  deliberationRounds?: number
}

export interface RunEstimate {
  stageCalls: number
  cognitionCalls: number
  segments: number
  // Only when the deliberation forecast is on: the calls, and the straw polls they make up.
  forecastCalls?: number
  polls?: number
  calls: number
}

// Live providers retry and repair, so a live run can use more calls than a
// scripted one. A scripted run matches the estimate exactly; this is the margin
// the screen states for a live run. It has not been measured against a live model.
export const estimateMargin = 0.25

export function cognitionSegments(input: Pick<RunEstimateInput, 'parties' | 'mode' | 'witnesses'>): number {
  const parties = Math.max(0, input.parties)
  if (input.mode === 'screen') return parties
  const examinations = (input.witnesses ?? 0) * (parties > 1 ? 2 : 1)
  return parties + examinations + parties
}

export function estimateRunCalls(input: RunEstimateInput): RunEstimate {
  const issues = Math.max(1, input.issues)
  const stageCalls = input.panel * issues * 2 + input.panel * 3 + input.parties * 2 + input.approvedMotions * 3
  const segments = input.jurorCognition ? cognitionSegments(input) : 0
  const cognitionCalls = input.panel * segments
  if (!input.deliberationForecast) return { stageCalls, cognitionCalls, segments, calls: stageCalls * 2 + cognitionCalls }
  const polls = challengeRounds(input.deliberationRounds ?? 3)
  const forecastCalls = input.panel * issues * polls
  return { stageCalls, cognitionCalls, segments, forecastCalls, polls, calls: stageCalls * 2 + cognitionCalls + forecastCalls * 2 }
}

// The engine spends maxRounds as one inventory turn, one review turn and the rest on challenges.
export const challengeRounds = (maxRounds: number) => Math.max(1, Math.floor(maxRounds) - 2)
