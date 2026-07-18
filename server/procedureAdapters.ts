import type {
  CaseModelV1,
  DecisionIssue,
  IssueBallot,
  IssueDecision,
  MotionRelief,
  ProcedureAdapterId,
  TrialPhase,
  TrialRunConfig,
} from './trialEngineTypes'

export interface ProcedureSource {
  title: string
  sourceKind: 'official' | 'research'
  sourceUrl: string
  jurisdiction: string
  revisionDate: string
  checkedAt: string
  legalReviewStatus: 'requires-lawyer-review' | 'lawyer-reviewed'
  note: string
}

export interface ProcedureAdapter {
  id: ProcedureAdapterId
  label: string
  roles: string[]
  phases: TrialPhase[]
  panel: { kind: 'criminal_jury' | 'adjudicator_panel' | 'civil'; size: number | 'configured' }
  decisionRule: string
  burdens: string[]
  permittedRelief: MotionRelief[]
  legalSources: ProcedureSource[]
  instructionSections: Array<{ id: string; title: string; text: string; sourceUrl: string }>
  defaultIssue(kind?: DecisionIssue['kind']): Omit<DecisionIssue, 'id' | 'respondingPartyIds' | 'sourceRefs'>
  validateRun(model: CaseModelV1, config: TrialRunConfig): string[]
  decide(model: CaseModelV1, ballots: IssueBallot[], config: TrialRunConfig): IssueDecision[]
}

const checkedAt = '2026-07-18T00:00:00.000Z'

export const procedureAdapters: Record<ProcedureAdapterId, ProcedureAdapter> = {
  ontario_criminal_jury_v1: {
    id: 'ontario_criminal_jury_v1',
    label: 'Ontario criminal jury trial',
    roles: ['crown', 'defence', 'judge', 'witness', 'juror', 'foreperson'],
    phases: ['setup', 'motions', 'jury_selection', 'openings', 'evidence', 'closings', 'instructions', 'deliberation_inventory', 'deliberation_challenges', 'deliberation_review', 'decision', 'complete'],
    panel: { kind: 'criminal_jury', size: 12 },
    decisionRule: 'Every accused/count verdict-sheet item requires 12 valid, unanimous final ballots.',
    burdens: ['Crown must prove every essential element beyond a reasonable doubt.'],
    permittedRelief: ['exclude', 'limited_use', 'redact', 'further_production', 'adjourn', 'voir_dire', 'curative_instruction', 'reserve'],
    legalSources: [
      source('National Judicial Institute model jury instructions', 'https://www.nji-inm.ca/index.cfm/publications/model-jury-instructions/?langSwitch=en', '2026-07-18', 'Tailored instructions must be selected from the curated registry; the model must not invent the governing charge.'),
      source('NJI Requirements for a Verdict', 'https://www.nji-inm.ca/index.cfm/publications/model-jury-instructions/final-instructions/deliberations/requirements-for-a-verdict/?langSwitch=en', '2026-07-18', 'Used for the per-item unanimity rule.'),
    ],
    instructionSections: [
      instruction('criminal-presumption', 'Presumption and burden', 'Begin with the accused presumed innocent. The Crown bears the burden throughout and must prove every essential element beyond a reasonable doubt; the accused has no burden to prove innocence.', 'https://www.nji-inm.ca/index.cfm/publications/model-jury-instructions/?langSwitch=en'),
      instruction('criminal-evidence', 'Evidence and permitted use', 'Decide from admitted evidence and the law in the charge. Do not use excluded, struck, jury-out, private-strategy, or limited-purpose material for any other purpose.', 'https://www.nji-inm.ca/index.cfm/publications/model-jury-instructions/?langSwitch=en'),
      instruction('criminal-separate-items', 'Separate accused and counts', 'Consider each accused and each count separately. Evidence admitted against one accused or for one count must not be transferred to another verdict-sheet item unless the admission ledger permits that use.', 'https://www.nji-inm.ca/index.cfm/publications/model-jury-instructions/?langSwitch=en'),
      instruction('criminal-unanimity', 'Unanimous verdicts', 'A verdict on each accused/count item must be unanimous. Jurors must decide individually after fair discussion and must not surrender an honestly held view merely to reach agreement.', 'https://www.nji-inm.ca/index.cfm/publications/model-jury-instructions/final-instructions/deliberations/requirements-for-a-verdict/?langSwitch=en'),
    ],
    defaultIssue: () => ({
      kind: 'criminal_count', label: 'Criminal count requiring definition', claimantPartyId: 'crown',
      elements: [{ id: 'element-1', label: 'Essential elements require user/legal review', burden: 'Beyond a reasonable doubt', sourceRefs: [{ attribution: 'unresolved' }] }],
      permittedOutcomes: ['guilty', 'not_guilty', 'no_verdict'],
    }),
    validateRun: (model, config) => {
      const warnings: string[] = []
      if (config.mode === 'full' && model.decisionIssues.some((issue) => issue.kind !== 'criminal_count')) warnings.push('Criminal adapter accepts criminal-count decision issues only.')
      return warnings
    },
    decide: (model, ballots) => model.decisionIssues.map((issue) => unanimousDecision(issue, ballots, 12)),
  },
  ontario_capital_markets_v1: {
    id: 'ontario_capital_markets_v1',
    label: 'Ontario Capital Markets Tribunal proceeding',
    roles: ['staff', 'respondent', 'adjudicator', 'witness'],
    phases: ['setup', 'case_management', 'motions', 'openings', 'evidence', 'closings', 'decision', 'sanctions', 'complete'],
    panel: { kind: 'adjudicator_panel', size: 'configured' },
    decisionRule: 'The adjudicator panel records a merits finding for each allegation; sanctions/costs remain blocked until merits findings exist.',
    burdens: ['Apply the burden and standard recorded in the approved case model and current tribunal authorities.'],
    permittedRelief: ['exclude', 'limited_use', 'redact', 'further_production', 'adjourn', 'preliminary_hearing', 'curative_instruction', 'reserve'],
    legalSources: [
      source('Capital Markets Tribunal Rules of Procedure', 'https://www.capitalmarketstribunal.ca/en/resources/capital-markets-tribunal-rules-of-procedure', '2026-07-18', 'Rules are curated and link-checked; counsel must confirm current application and authorities.'),
    ],
    instructionSections: [
      instruction('osc-record', 'Merits record', 'Determine each allegation separately from the admitted merits record, the approved elements, and the standard recorded in the case model.', 'https://www.capitalmarketstribunal.ca/en/resources/capital-markets-tribunal-rules-of-procedure'),
      instruction('osc-sanctions-gate', 'Merits before sanctions', 'Do not open or determine sanctions and costs until a complete merits finding exists for the applicable allegations.', 'https://www.capitalmarketstribunal.ca/en/resources/capital-markets-tribunal-rules-of-procedure'),
    ],
    defaultIssue: () => ({
      kind: 'osc_allegation', label: 'Capital-markets allegation requiring definition', claimantPartyId: 'staff',
      elements: [{ id: 'element-1', label: 'Elements require user/legal review', burden: 'As approved in the case model', sourceRefs: [{ attribution: 'unresolved' }] }],
      permittedOutcomes: ['proved', 'not_proved', 'no_finding'],
    }),
    validateRun: (model) => model.decisionIssues.some((issue) => issue.kind !== 'osc_allegation')
      ? ['Capital-markets adapter accepts OSC allegation decision issues only.'] : [],
    decide: (model, ballots) => model.decisionIssues.map((issue) => majorityDecision(issue, ballots, 3, 'no_finding')),
  },
  ontario_civil_v1: {
    id: 'ontario_civil_v1',
    label: 'Ontario civil trial',
    roles: ['plaintiff', 'defence', 'judge', 'witness', 'juror', 'foreperson'],
    phases: ['setup', 'case_management', 'motions', 'jury_selection', 'openings', 'evidence', 'closings', 'instructions', 'deliberation_inventory', 'deliberation_challenges', 'deliberation_review', 'decision', 'complete'],
    panel: { kind: 'civil', size: 6 },
    decisionRule: 'Judge-alone is available; a valid jury notice is required for jury mode, where five of six may answer each question.',
    burdens: ['Apply the civil standard and issue-specific burdens recorded in the approved case model.'],
    permittedRelief: ['exclude', 'limited_use', 'redact', 'further_production', 'adjourn', 'voir_dire', 'curative_instruction', 'reserve'],
    legalSources: [
      source('Ontario Rules of Civil Procedure, Rules 47, 52, and 53', 'https://www.ontario.ca/laws/regulation/900194', '2026-07-18', 'The adapter stores the source and revision checkpoint; legal review remains required.'),
      source('Ontario Superior Court civil jury guidance', 'https://www.ontariocourts.ca/scj/guides-and-service-resources/representing-yourself-guides-to-help-you/', '2026-07-18', 'Procedural orientation only; not a substitute for the Rules or legal advice.'),
    ],
    instructionSections: [
      instruction('civil-burden', 'Issue-specific burden', 'Apply the burden and standard assigned to each approved civil issue. Decide only from admitted evidence and the tailored issue questions.', 'https://www.ontario.ca/laws/regulation/900194'),
      instruction('civil-separate-questions', 'Separate questions and parties', 'Answer each claim, defence, damages issue, or special question separately for the parties identified on the decision sheet.', 'https://www.ontario.ca/laws/regulation/900194'),
      instruction('civil-jury-rule', 'Civil jury decision rule', 'In six-person jury mode, a decision on an issue requires five valid jurors to agree. A missing or invalid ballot leaves that issue incomplete rather than being inferred from the group.', 'https://www.ontario.ca/laws/regulation/900194'),
    ],
    defaultIssue: (kind = 'civil_claim') => ({
      kind, label: 'Civil issue requiring definition', claimantPartyId: 'plaintiff',
      elements: [{ id: 'element-1', label: 'Elements require user/legal review', burden: 'Balance of probabilities unless otherwise specified', sourceRefs: [{ attribution: 'unresolved' }] }],
      permittedOutcomes: kind === 'special_question' ? ['yes', 'no', 'no_decision'] : ['proved', 'not_proved', 'no_decision'],
    }),
    validateRun: (model, config) => {
      if (config.civilDecisionMaker === 'jury' && model.juryNotice?.valid !== true) return ['Civil jury mode requires an approved case model confirming a valid jury notice.']
      return []
    },
    decide: (model, ballots, config) => model.decisionIssues.map((issue) =>
      config.civilDecisionMaker === 'judge_alone'
        ? judgeAloneDecision(issue, ballots)
        : thresholdDecision(issue, ballots, 6, 5, 'no_decision'),
    ),
  },
}

export function getProcedureAdapter(id: ProcedureAdapterId): ProcedureAdapter {
  return procedureAdapters[id]
}

export function assertPermittedRelief(adapterId: ProcedureAdapterId, relief: MotionRelief[]): void {
  const adapter = getProcedureAdapter(adapterId)
  const invalid = relief.filter((item) => !adapter.permittedRelief.includes(item))
  if (invalid.length) throw new Error(`Relief is not permitted by ${adapter.label}: ${invalid.join(', ')}`)
}

function unanimousDecision(issue: DecisionIssue, ballots: IssueBallot[], expected: number): IssueDecision {
  return thresholdDecision(issue, ballots, expected, expected, 'no_verdict')
}

function thresholdDecision(issue: DecisionIssue, ballots: IssueBallot[], expected: number, threshold: number, fallback: string): IssueDecision {
  const relevant = validFinalBallots(issue, ballots)
  const counts = countChoices(relevant)
  const winner = Object.entries(counts).find(([, count]) => count >= threshold)?.[0]
  const complete = relevant.length === expected && Boolean(winner)
  const warnings: string[] = []
  if (relevant.length !== expected) warnings.push(`Expected ${expected} valid final ballots; received ${relevant.length}.`)
  if (!winner) warnings.push(`No outcome met the ${threshold}-of-${expected} decision rule.`)
  return { issueId: issue.id, outcome: complete ? winner! : fallback, complete, rule: `${threshold} of ${expected}`, voteCounts: counts, warnings }
}

function majorityDecision(issue: DecisionIssue, ballots: IssueBallot[], expected: number, fallback: string): IssueDecision {
  const relevant = validFinalBallots(issue, ballots)
  const counts = countChoices(relevant)
  const ordered = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const winner = ordered[0]
  const tied = !winner || (ordered[1]?.[1] ?? -1) === winner[1]
  const complete = relevant.length === expected && !tied
  const warnings: string[] = []
  if (relevant.length !== expected) warnings.push(`Expected ${expected} valid adjudicator findings; received ${relevant.length}.`)
  if (tied) warnings.push('Adjudicator findings are missing or tied.')
  return {
    issueId: issue.id, outcome: complete ? winner[0] : fallback, complete,
    rule: `Panel majority (${expected} adjudicators)`, voteCounts: counts, warnings,
  }
}

function judgeAloneDecision(issue: DecisionIssue, ballots: IssueBallot[]): IssueDecision {
  const relevant = validFinalBallots(issue, ballots).filter((ballot) => ballot.actorId.startsWith('judge'))
  const ballot = relevant[0]
  return {
    issueId: issue.id, outcome: ballot?.choice ?? 'no_decision', complete: Boolean(ballot),
    rule: 'Judge alone', voteCounts: ballot ? { [ballot.choice]: 1 } : {},
    warnings: ballot ? [] : ['No valid judge-alone finding was recorded.'],
  }
}

function validFinalBallots(issue: DecisionIssue, ballots: IssueBallot[]): IssueBallot[] {
  return ballots.filter((ballot) => ballot.issueId === issue.id && ballot.round === 'final' && ballot.valid && issue.permittedOutcomes.includes(ballot.choice))
}

function countChoices(ballots: IssueBallot[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const ballot of ballots) counts[ballot.choice] = (counts[ballot.choice] ?? 0) + 1
  return counts
}

function source(title: string, sourceUrl: string, revisionDate: string, note: string): ProcedureSource {
  return {
    title, sourceKind: 'official', sourceUrl, jurisdiction: 'Ontario, Canada',
    revisionDate, checkedAt, legalReviewStatus: 'requires-lawyer-review', note,
  }
}

function instruction(id: string, title: string, text: string, sourceUrl: string): ProcedureAdapter['instructionSections'][number] {
  return { id, title, text, sourceUrl }
}
