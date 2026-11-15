import type { CaseStore } from '../db'
import type { FrameworkService } from '../frameworks/service'
import type { CaseParty, DecisionIssue } from '../trialEngineTypes'
import { formatPercent, NOT_YET_TESTED_SENTENCE } from '../forecast/winRates'
import { DamagesService } from './damages'
import { PsychologyService } from './damagesPsychology'
import { ForecastService } from './forecast'
import { issueKindWeight, type OptionalSignal, type OptionalSignalSource } from './improvementPlanSignals'
import { latestCaseModel } from './revision'
import type { AnalysisService } from './service'
import { StyleStudyService } from './styleStudy'
import type { AnalysisArtifact, AnalysisFreshness } from './types'

// Read-only signal sources for the case improvement plan (F14): the approved forecast, damages study, damages psychology
// study and style study. They sit behind the register's optional-source interface, so the plan can cite them.
//
// Rules every source follows:
//  - Only an APPROVED artifact that is still current is read (through the feature's own `view().approved`). A draft, an
//    unapproved artifact and a stale one (out of date against the evidence, case model, rules or catalogue) give nothing.
//  - Nothing is invented. A signal restates figures the stored artifact already holds, in words composed by code, and cites
//    the artifact and the item inside it. A simulated figure is never evidence, so a signal carries no source passage.
//  - A signal that carries a win probability carries the D1 sentence (NOT_YET_TESTED_SENTENCE): the figure comes from
//    simulated panels and has not been tested against real outcomes.
//  - A signal is about the party whose plan it is. The forecast gives only questions that party bears or answers. The damages
//    study and the damages psychology study give only the party that claims the damages. A style study is about the one
//    party whose advocacy it styled and never appears in another party's plan, because it is that party's private strategy.

type Collect = (input: { matterId: string; partyId: string }) => OptionalSignal[]

const current = (freshness: AnalysisFreshness): boolean => freshness.status === 'current'

// The party and the questions of the newest case model.
function partyAndIssues(store: CaseStore, matterId: string, partyId: string): { party: CaseParty; issues: DecisionIssue[] } | undefined {
  const model = latestCaseModel(store, matterId)
  const party = model?.parties.find((candidate) => candidate.id === partyId)
  return model && party ? { party, issues: model.decisionIssues } : undefined
}

const claimsDamages = (issues: readonly DecisionIssue[], partyId: string): DecisionIssue[] =>
  issues.filter((issue) => issue.kind === 'damages' && issue.claimantPartyId === partyId)

const ref = (artifact: Pick<AnalysisArtifact, 'id' | 'version'>, sourceKind: string, itemId: string, statement: string): OptionalSignal['signal'] =>
  ({ origin: 'optional_source', sourceId: artifact.id, sourceKind, sourceVersion: artifact.version, itemId, statement, passages: [] })

export function forecastSignalSource(store: CaseStore, forecast: ForecastService): OptionalSignalSource {
  const collect: Collect = ({ matterId, partyId }) => {
    const approved = forecast.view(matterId).approved
    const scope = partyAndIssues(store, matterId, partyId)
    if (!approved || !current(approved.freshness) || !scope) return []
    const signals: OptionalSignal[] = []
    for (const row of approved.content.liability) {
      const issue = scope.issues.find((candidate) => candidate.id === row.issueId)
      const estimate = row.claimantWin.estimate
      if (!issue || estimate === null || row.completedRuns < 1) continue
      const claimant = issue.claimantPartyId === partyId
      const answering = issue.respondingPartyIds.includes(partyId) && row.defendantId === partyId
      if (!claimant && !answering) continue
      // Against the party: the claimant prevailed in less than half the panels (the claimant's plan), or in at least half (a respondent's).
      if (claimant ? estimate >= 0.5 : estimate < 0.5) continue
      const lackOfSupport = Math.min(1, Math.max(0.05, claimant ? 1 - estimate : estimate))
      const result = `${row.claimantWins} of ${row.claimantWin.trials} simulated panels`
      // The frozen sentence from the library already ends with the D1 sentence; it is added only if it ever did not.
      const sentence = row.statement.includes(NOT_YET_TESTED_SENTENCE) ? row.statement : `${row.statement} ${NOT_YET_TESTED_SENTENCE}`
      const statement = claimant
        ? `On "${row.label}", ${scope.party.name} has the burden and prevailed in ${result} (${formatPercent(estimate)}). ${sentence}`
        : `On "${row.label}", the claimant prevailed against ${scope.party.name} in ${result} (${formatPercent(estimate)}). ${sentence}`
      signals.push({
        kind: 'forecast_signal', key: `forecast:${row.issueId}:${row.defendantId}`, title: `Simulated panels went against ${scope.party.name} on "${row.label}"`, statement,
        issueId: row.issueId,
        factors: { weight: issueKindWeight[issue.kind] ?? 0.6, lackOfSupport, dispute: row.exploratory ? 0.4 : 0.7 },
        signal: ref(approved.artifact, 'forecast', `liability:${row.issueId}:${row.defendantId}`, statement),
      })
    }
    return signals
  }
  return { id: 'approved-forecast', label: 'Approved forecast', collect }
}

export function damagesSignalSource(store: CaseStore, damages: DamagesService): OptionalSignalSource {
  const collect: Collect = ({ matterId, partyId }) => {
    const approved = damages.view(matterId).approved
    const scope = partyAndIssues(store, matterId, partyId)
    if (!approved || !current(approved.freshness) || !scope) return []
    const claimed = claimsDamages(scope.issues, partyId)
    if (claimed.length === 0) return []
    const { calculation } = approved.content
    const factorsFor = (where: 'court_rules' | 'your_input') => ({ weight: issueKindWeight.damages, lackOfSupport: where === 'your_input' ? 0.8 : 0.5, dispute: 0.6 })
    const signals: OptionalSignal[] = calculation.missing.map((note) => {
      const statement = `The damages calculation could not be completed. ${note.say}`
      return {
        kind: 'damages_proof', key: `damages:missing:${note.stepId}:${note.input}`, title: `Damages proof gap: ${note.input}`, statement, issueId: claimed[0].id,
        factors: factorsFor(note.where), signal: ref(approved.artifact, 'damages_model', `missing:${note.stepId}:${note.input}`, statement),
      }
    })
    // An unknown order of calculation names no input, so it is its own signal.
    if (calculation.status === 'order_unknown' && signals.length === 0) {
      signals.push({
        kind: 'damages_proof', key: 'damages:order_unknown', title: 'Damages proof gap: the order of calculation is not stated', statement: calculation.message, issueId: claimed[0].id,
        factors: factorsFor('court_rules'), signal: ref(approved.artifact, 'damages_model', 'calculation:order_unknown', calculation.message),
      })
    }
    return signals
  }
  return { id: 'approved-damages-study', label: 'Approved damages study', collect }
}

export function psychologySignalSource(store: CaseStore, psychology: PsychologyService): OptionalSignalSource {
  const collect: Collect = ({ matterId, partyId }) => {
    const approved = psychology.view(matterId).approved
    const scope = partyAndIssues(store, matterId, partyId)
    if (!approved || !current(approved.freshness) || !scope) return []
    const claimed = claimsDamages(scope.issues, partyId)
    const backfire = approved.content.backfire
    if (claimed.length === 0 || !backfire?.backfire) return []
    const statement = `In simulated panels, the highest damages anchor reliably produced lower awards than the anchor below it (${backfire.pairs} common seeds). This is how a model playing jurors responded; it has not been tested against real outcomes.`
    return [{
      kind: 'forecast_signal', key: 'psychology:anchor_backfire', title: 'Simulated panels: the highest damages anchor backfired', statement, issueId: claimed[0].id,
      factors: { weight: issueKindWeight.damages, lackOfSupport: 0.6, dispute: approved.content.exploratory ? 0.4 : 0.6 },
      signal: ref(approved.artifact, 'damages_psychology', 'backfire', statement),
    }]
  }
  return { id: 'approved-damages-psychology', label: 'Approved damages psychology study', collect }
}

export function styleStudySignalSource(store: CaseStore, styles: StyleStudyService): OptionalSignalSource {
  const collect: Collect = ({ matterId, partyId }) => {
    const approved = styles.view(matterId).approved
    if (!approved || !current(approved.freshness) || !partyAndIssues(store, matterId, partyId)) return []
    const { content } = approved
    // Another party's study is that party's private strategy: it never reaches this party's plan.
    if (content.partyId !== partyId) return []
    const winRate = content.baseline.winRate
    if (winRate === null || winRate >= 0.5) return []
    const recommended = content.recommendation.recommendedLabel ? ` The study's own recommendation is the "${content.recommendation.recommendedLabel}" style.` : ''
    const statement = `In the unstyled baseline, simulated panels carried the decision for ${content.partyName}'s side in ${formatPercent(winRate)} of ${content.baseline.runsCompleted} usable runs.${recommended} ${NOT_YET_TESTED_SENTENCE}`
    return [{
      kind: 'forecast_signal', key: 'style-study:baseline', title: `Simulated panels: ${content.partyName}'s baseline argument carried the decision less than half the time`, statement,
      factors: { weight: 0.8, lackOfSupport: Math.min(1, Math.max(0.05, 1 - winRate)), dispute: content.exploratory ? 0.4 : 0.7 },
      signal: ref(approved.artifact, 'style_study', 'baseline', statement),
    }]
  }
  return { id: 'approved-style-study', label: 'Approved style study', collect }
}

// The four sources for one store. The services are stateless readers over the store.
export function approvedArtifactSignalSources(store: CaseStore, analysis: AnalysisService, frameworks: FrameworkService): OptionalSignalSource[] {
  return [
    forecastSignalSource(store, new ForecastService(store, analysis, frameworks)),
    damagesSignalSource(store, new DamagesService(store, analysis, frameworks)),
    psychologySignalSource(store, new PsychologyService(store, analysis, frameworks)),
    styleStudySignalSource(store, new StyleStudyService(store, analysis, frameworks)),
  ]
}
