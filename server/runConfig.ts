import type { ModelProviderConfig } from './minimax'
import { simulationStages } from './stages'
import type {
  DeliberationMode,
  JuryLeaning,
  LegalTemplate,
  LegalTemplateId,
  Matter,
  PanelDecision,
  PanelRules,
  ProviderMode,
  ProviderStatus,
  RunConfig,
} from './types'

const maxJurors = 12
const defaultRetrievalDepth = 6
const allStageIds = simulationStages.map((stage) => stage.id)

export const legalTemplates: LegalTemplate[] = [
  {
    id: 'osc_securities',
    label: 'OSC / Securities',
    description:
      'Regulatory-criminal overlap, investor reliance, disclosure gaps, source-of-funds, trading-platform records, and Crown proof risk.',
    burdenLabel: 'Crown/regulator must prove the pleaded allegations on the applicable standard.',
    defenceLabel: 'Defence',
    crownLabel: 'Crown / OSC',
    judgeLabel: 'Judge',
    juryLabel: 'Tribunal Panel',
    defaultJurorCount: 3,
    outcomeLabels: [
      'Allegations proven',
      'Allegations not proven',
      'Partly proven',
      'No decision - panel did not reach a majority',
    ],
    packetGuidance: [
      'Separate regulatory allegations, complainant assertions, trading records, and defence rebuttal evidence.',
      'Track whether each allegation is supported by source documents, interview evidence, or inference.',
      'Flag proof gaps around knowledge, control, reliance, dishonesty, causation, and loss.',
    ],
    stagePrompts: {
      issue_spotting:
        'fraud elements regulatory allegations complainant reliance source of funds trading platform knowledge control causation loss',
      crown_opening:
        'crown osc allegations complainant statements investor reliance deprivation dishonesty transaction chronology',
      defence_opening:
        'defence rebuttal disclosure gaps alternate explanation lack of knowledge source documents expert assumptions',
      crown_rebuttal:
        'crown reply corroboration pattern evidence investor loss regulatory findings',
      defence_rebuttal:
        'defence closing credibility inconsistencies missing records weak inference reasonable doubt',
      jury_instructions:
        'panel instructions applicable standard elements reliance dishonesty causation circumstantial evidence adverse inference limits',
      jury_deliberation:
        'jury reasonable doubt credibility complainant reliance document consistency competing inferences',
      judge_ruling:
        'judge synthesis charge screening proof gaps reasonable prospect conviction unresolved disclosure issues',
    },
  },
  {
    id: 'criminal_defence',
    label: 'Criminal Defence',
    description:
      'Charge-screening and trial-risk simulation focused on burden of proof, credibility, disclosure, mens rea, and reasonable doubt.',
    burdenLabel: 'Crown must prove every element beyond a reasonable doubt.',
    defenceLabel: 'Defence',
    crownLabel: 'Crown',
    judgeLabel: 'Judge',
    juryLabel: 'Jury Panel',
    defaultJurorCount: 12,
    outcomeLabels: [
      'Guilty (elements proven beyond a reasonable doubt)',
      'Not guilty (reasonable doubt remains)',
      'Hung jury - no verdict',
    ],
    packetGuidance: [
      'Keep actus reus, mens rea, identity, credibility, and admissibility separate.',
      'Do not treat complainant allegations as proven unless exhibit support is identified.',
      'Flag missing disclosure and Charter or evidentiary issues without inventing facts.',
    ],
    stagePrompts: {
      issue_spotting:
        'criminal elements actus reus mens rea identity credibility disclosure admissibility reasonable doubt',
      crown_opening:
        'crown proof elements witness reliability corroboration timeline motive opportunity',
      defence_opening:
        'defence reasonable doubt missing proof credibility inconsistency alternate innocent explanation',
      crown_rebuttal:
        'crown reply corroboration circumstantial proof witness reliability inference',
      defence_rebuttal:
        'defence closing inconsistencies disclosure gaps burden admissibility credibility',
      jury_instructions:
        'jury charge burden reasonable doubt elements credibility WD framework circumstantial evidence unanimity',
      jury_deliberation:
        'jury reasonable doubt credibility burden competing explanations reliability',
      judge_ruling:
        'judge charge screen elements proof reasonable doubt unresolved disclosure next steps',
    },
  },
  {
    id: 'civil_dispute',
    label: 'Civil Dispute',
    description:
      'Civil litigation simulation focused on liability, causation, damages, credibility, documentary proof, and settlement risk.',
    burdenLabel: 'Plaintiff must prove the claim on a balance of probabilities.',
    defenceLabel: 'Defence',
    crownLabel: 'Plaintiff',
    judgeLabel: 'Judge',
    juryLabel: 'Jury Panel',
    defaultJurorCount: 6,
    outcomeLabels: [
      'Liable (claim proven on a balance of probabilities)',
      'Not liable (claim not proven)',
      'Split liability / partial recovery',
      'No verdict - jury did not reach the required majority',
    ],
    packetGuidance: [
      'Separate liability, causation, damages, credibility, and mitigation evidence.',
      'Cite exhibits for factual findings and flag assumptions that require counsel review.',
      'Treat the result as settlement and litigation-risk support only.',
    ],
    stagePrompts: {
      issue_spotting:
        'civil liability causation damages credibility mitigation documentary proof settlement risk',
      crown_opening:
        'plaintiff proof liability causation damages notice chronology harm',
      defence_opening:
        'defence liability gaps causation damages mitigation alternate explanation',
      crown_rebuttal:
        'plaintiff reply corroboration reasonable inference damages proof',
      defence_rebuttal:
        'defence closing unsupported assumptions contributory fault damages gaps',
      jury_instructions:
        'jury charge balance of probabilities liability elements causation damages assessment majority rule',
      jury_deliberation:
        'jury credibility balance probabilities competing evidence uncertainty',
      judge_ruling:
        'judge civil synthesis liability causation damages unresolved issues next steps',
    },
  },
]

export function getLegalTemplate(templateId: LegalTemplateId): LegalTemplate {
  return (
    legalTemplates.find((template) => template.id === templateId) ??
    legalTemplates.find((template) => template.id === 'civil_dispute') ??
    legalTemplates[0]
  )
}

export function inferTemplateId(matter: Pick<Matter, 'title' | 'narrative'>): LegalTemplateId {
  const source = `${matter.title} ${matter.narrative}`.toLowerCase()
  if (/\b(osc|securities|investor|investment|trading|forex|mt4|smart prime|regulator)\b/.test(source)) {
    return 'osc_securities'
  }
  if (/\b(criminal|crown|charge|accused|complainant|reasonable doubt|fraud|theft|ito)\b/.test(source)) {
    return 'criminal_defence'
  }
  return 'civil_dispute'
}

// Decision rules modelled on the real forums: a Canadian criminal jury must
// be unanimous, an Ontario civil jury needs agreement of at least 5 of 6
// (s. 108(6) Courts of Justice Act, generalized as a 5/6 fraction), and a
// Capital Markets Tribunal style panel decides by simple majority.
export function panelRulesFor(templateId: LegalTemplateId, jurorCount: number): PanelRules {
  const panelSize = Math.max(1, Math.round(jurorCount))
  if (templateId === 'criminal_defence') {
    return {
      requiredVotes: panelSize,
      ruleLabel: `unanimous verdict of all ${panelSize} jurors required; anything less is a hung jury`,
    }
  }
  if (templateId === 'osc_securities') {
    const required = Math.floor(panelSize / 2) + 1
    return {
      requiredVotes: Math.min(panelSize, required),
      ruleLabel: `majority of the ${panelSize}-member tribunal panel required (${Math.min(panelSize, required)} of ${panelSize})`,
    }
  }
  const required = Math.min(panelSize, Math.max(1, Math.ceil((panelSize * 5) / 6)))
  return {
    requiredVotes: required,
    ruleLabel: `agreement of at least ${required} of ${panelSize} jurors required (Ontario civil jury majority)`,
  }
}

export function panelDecisionFor(
  templateId: LegalTemplateId,
  jurorCount: number,
  votes: Array<{ leaning: JuryLeaning }>,
): PanelDecision {
  const rules = panelRulesFor(templateId, jurorCount)
  const counts = votes.reduce(
    (accumulator, vote) => {
      accumulator[vote.leaning] += 1
      return accumulator
    },
    { defence: 0, crown: 0, mixed: 0 },
  )
  const leadingVotes = Math.max(counts.defence, counts.crown)
  const leadingSide: PanelDecision['leadingSide'] =
    counts.crown > counts.defence
      ? 'crown'
      : counts.defence > counts.crown
        ? 'defence'
        : 'none'

  return {
    ...rules,
    panelSize: Math.max(1, Math.round(jurorCount)),
    votesRecorded: votes.length,
    leadingSide,
    leadingVotes,
    undecided: counts.mixed,
    reached: leadingSide !== 'none' && leadingVotes >= rules.requiredVotes,
  }
}

export function defaultRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return normalizeRunConfig(overrides)
}

export function normalizeRunConfig(
  input: unknown,
  options: {
    defaultTemplateId?: LegalTemplateId
    defaultProviderMode?: ProviderMode
  } = {},
): RunConfig {
  const candidate = isRecord(input) ? input : {}
  const providerMode = normalizeProviderMode(
    candidate.providerMode,
    options.defaultProviderMode ?? 'local',
  )
  const templateId = normalizeTemplateId(
    candidate.templateId,
    options.defaultTemplateId ?? 'civil_dispute',
  )
  const jurorCount = clampInteger(
    candidate.jurorCount,
    1,
    maxJurors,
    getLegalTemplate(templateId).defaultJurorCount,
  )
  const deliberationMode = normalizeDeliberationMode(candidate.deliberationMode)
  const stages = normalizeStages(candidate.stages)
  const retrievalDepth = clampInteger(
    candidate.retrievalDepth,
    1,
    20,
    defaultRetrievalDepth,
  )
  const externalDisclosureConfirmed =
    typeof candidate.externalDisclosureConfirmed === 'boolean'
      ? candidate.externalDisclosureConfirmed
      : false

  return {
    providerMode,
    templateId,
    jurorCount,
    deliberationMode,
    stages,
    retrievalDepth,
    externalDisclosureConfirmed,
  }
}

export function providerStatusFromConfig(config: ModelProviderConfig): ProviderStatus {
  const isLocal = config.provider === 'openai-compatible' && isLocalBaseUrl(config.baseUrl)
  const mode: ProviderMode = isLocal ? 'local' : 'external'
  const configured =
    config.provider === 'minimax'
      ? Boolean(config.apiKey)
      : Boolean(config.model && config.baseUrl && (isLocal || config.apiKey))
  const availableModes: ProviderMode[] = []
  if (isLocal && configured) {
    availableModes.push('local')
  }
  if (!isLocal && configured) {
    availableModes.push('external')
  }

  return {
    mode,
    name: config.provider,
    label: providerLabel(config.provider, mode),
    model: config.model,
    baseUrl: config.baseUrl,
    hasKey: Boolean(config.apiKey),
    disclosureRequired: mode === 'external',
    availableModes,
  }
}

export function assertRunConfigAllowed(
  runConfig: RunConfig,
  provider: ProviderStatus,
): void {
  if (!provider.availableModes.includes(runConfig.providerMode)) {
    if (runConfig.providerMode === 'local') {
      throw new Error(
        'Local provider mode requires MODEL_PROVIDER=openai-compatible with a localhost base URL and configured model.',
      )
    }
    if (runConfig.providerMode === 'external') {
      throw new Error(
        'External provider mode requires a configured external model provider and API key.',
      )
    }
  }

  if (runConfig.providerMode === 'external' && !runConfig.externalDisclosureConfirmed) {
    throw new Error(
      'External provider runs require confirmation that sensitive case material may leave this machine.',
    )
  }
}

export function stageDefinitionsFor(runConfig: RunConfig): typeof simulationStages {
  const selected = new Set(runConfig.stages)
  return simulationStages.filter((stage) => selected.has(stage.id))
}

export function isLocalBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(url.hostname)
  } catch {
    return false
  }
}

function normalizeProviderMode(value: unknown, fallback: ProviderMode): ProviderMode {
  return value === 'local' || value === 'external' ? value : fallback
}

function normalizeDeliberationMode(value: unknown): DeliberationMode {
  return value === 'grouped' ? 'grouped' : 'independent'
}

function normalizeTemplateId(value: unknown, fallback: LegalTemplateId): LegalTemplateId {
  return legalTemplates.some((template) => template.id === value)
    ? (value as LegalTemplateId)
    : fallback
}

function normalizeStages(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return allStageIds
  }

  const selected = value.filter((stage): stage is string => {
    return typeof stage === 'string' && allStageIds.includes(stage)
  })

  return selected.length > 0 ? Array.from(new Set(selected)) : allStageIds
}

function clampInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function providerLabel(provider: string, mode: ProviderMode): string {
  if (mode === 'local') {
    return 'Local OpenAI-compatible provider'
  }
  return provider === 'minimax' ? 'External MiniMax provider' : 'External OpenAI-compatible provider'
}
