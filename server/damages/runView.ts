import type { CaseStore } from '../db'
import { isJudgeDecided } from '../procedureAdapters'
import { jurorAmounts, panelAward } from './awards'
import { isAmountQuestion } from './categories'
import { damagesLabel, panelAwardRule, type RunDamagesView } from './types'

// The panel award of one run, before and after deliberation, computed from its saved
// ballots on read. Nothing is stored: the figures are a function of the ballots and
// the pinned categories, so they can never drift from them. A run that did not opt in
// to damages amounts has nothing to show.
export function runDamagesView(store: CaseStore, runId: string): RunDamagesView {
  const run = store.workflow.getTrialRun(runId)
  const base = { runId, label: damagesLabel, rule: panelAwardRule }
  if (run.config.damagesAmounts !== true || !run.config.damagesCategories || !run.config.damagesCurrency) {
    return { ...base, enabled: false, currency: null, questions: [] }
  }
  const model = store.workflow.getCaseModel(run.caseModelId)
  const ballots = store.workflow.listBallots(runId)
  const categories = run.config.damagesCategories
  const ids = categories.map((category) => category.id)
  const currency = run.config.damagesCurrency
  const panelSize = run.config.framework?.panelSize ?? 6
  const questions = model.decisionIssues.filter((issue) => isAmountQuestion(issue) && !isJudgeDecided(issue, run.config.framework)).map((issue) => {
    const initial = jurorAmounts(ballots, issue.id, 'initial', ids, currency)
    const final = jurorAmounts(ballots, issue.id, 'final', ids, currency)
    const pre = panelAward(initial.counted, ids, panelSize)
    const post = panelAward(final.counted, ids, panelSize)
    return {
      issueId: issue.id, label: issue.label, jurors: { initial: initial.counted.length, final: final.counted.length },
      categories: categories.map((category) => {
        const preMedian = 'reason' in pre ? null : pre.awards.find((line) => line.categoryId === category.id)!.cents
        const panelAwardCents = 'reason' in post ? null : post.awards.find((line) => line.categoryId === category.id)!.cents
        return { categoryId: category.id, label: category.label, preMedianCents: preMedian, panelAwardCents, shiftCents: preMedian !== null && panelAwardCents !== null ? panelAwardCents - preMedian : null }
      }),
    }
  })
  return { ...base, enabled: true, currency, questions }
}
