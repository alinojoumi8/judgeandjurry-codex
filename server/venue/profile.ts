import { canonicalJson } from '../analysis/hash'
import type { AnalysisRejectedItem } from '../analysis/types'
import { summariseAttitudes } from './attitudes'
import {
  JURY_PROFILE_ALGORITHM_VERSION, NO_CALIBRATION, NO_PROTECTED_CHARACTERISTICS, POPULATION_NOT_JURY_POOL, PROFILE_LABEL, SELECTION_WARNING,
} from './constants'
import { traitMapping } from './panelSampler'
import { adjustPopulation } from './poolAdjustment'
import { protectedTermIn, protectedTermMessage } from './protectedTerms'
import {
  type AcceptedCultureNote, type AttitudeRow, type CultureNoteCitation, type CultureNoteInput, type DatasetKind, type DatasetRef, type DatasetRowMap,
  type EligibilityRuleSnapshot, type JuryProfileContent, type PopulationRow, type ProfileAssumptions, type VerdictRow,
} from './types'
import { summariseVerdicts, validateReportingAssumptions } from './verdictObservations'

export interface ProfileDatasetInput<K extends DatasetKind = DatasetKind> {
  datasetHash: string
  kind: K
  name: string
  source: string
  retrievedAt: string
  licence: string
  rows: readonly DatasetRowMap[K][]
}

export interface ProfileBuildInputs {
  datasets: readonly ProfileDatasetInput[]
  assumptions: ProfileAssumptions
  seed: string
  eligibilityRule: EligibilityRuleSnapshot
  cultureNotes: readonly CultureNoteInput[]
  // SHA-256 of the matter's current evidence, for document citations.
  evidenceHashes: ReadonlySet<string>
}

export interface ProfileBuildResult {
  content: JuryProfileContent
  rejected: AnalysisRejectedItem[]
}

const only = <K extends DatasetKind>(datasets: readonly ProfileDatasetInput[], kind: K) =>
  datasets.filter((dataset): dataset is ProfileDatasetInput<K> => dataset.kind === kind)

function checkCitation(citation: CultureNoteInput['citation'], evidenceHashes: ReadonlySet<string>): { ok: true; citation: CultureNoteCitation } | { ok: false; reason: string } {
  if (!citation || (citation.url === undefined && citation.evidenceSha256 === undefined)) {
    return { ok: false, reason: 'This note has no citation. A culture note needs a web address or a reference to one of this case\'s documents.' }
  }
  if (citation.url !== undefined && citation.evidenceSha256 !== undefined) {
    return { ok: false, reason: 'Give one citation: either a web address or a document reference, not both.' }
  }
  if (citation.url !== undefined) {
    try {
      const parsed = new URL(citation.url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol')
    } catch {
      return { ok: false, reason: 'The citation web address is not a valid http or https address.' }
    }
    return { ok: true, citation: { url: citation.url } }
  }
  const hash = String(citation.evidenceSha256)
  if (!/^[a-f0-9]{64}$/.test(hash)) return { ok: false, reason: 'The document reference is not a SHA-256 hash.' }
  if (!evidenceHashes.has(hash)) return { ok: false, reason: 'The cited document is not in this case.' }
  if (citation.paragraph !== undefined && (!Number.isInteger(citation.paragraph) || citation.paragraph < 1)) {
    return { ok: false, reason: 'The cited paragraph must be a positive whole number.' }
  }
  return { ok: true, citation: citation.paragraph === undefined ? { evidenceSha256: hash } : { evidenceSha256: hash, paragraph: citation.paragraph } }
}

// Builds the whole profile from datasets, stated assumptions and a seed. It is
// pure and deterministic, it calls no model, and every figure it returns is a
// sum, ratio or resampling of imported rows (named in `provenance`) or of the
// assumptions the user stated. Approval rebuilds the profile with this same
// function and refuses a profile that does not reproduce.
export function buildProfileContent(inputs: ProfileBuildInputs): ProfileBuildResult {
  const datasets = [...inputs.datasets].sort((a, b) => (a.datasetHash < b.datasetHash ? -1 : a.datasetHash > b.datasetHash ? 1 : 0))
  if (new Set(datasets.map((dataset) => dataset.datasetHash)).size !== datasets.length) throw new Error('The same dataset was chosen twice.')
  const populations = only(datasets, 'population_table')
  if (populations.length > 1) throw new Error('Choose at most one population table: two would count the same people twice.')
  const { assumptions } = inputs
  validateReportingAssumptions(assumptions)

  const flags: string[] = []
  const population = populations[0]
  const pool = adjustPopulation({
    datasetHash: population?.datasetHash ?? null,
    rows: (population?.rows ?? []) as readonly PopulationRow[],
    rule: inputs.eligibilityRule,
    responseRate: assumptions.responseRate,
  })
  if (pool.status === 'not_adjusted') flags.push(pool.reasonCode)
  else if (pool.population.unclassified > 0) flags.push('unclassified_population_rows')

  const attitudeSets = only(datasets, 'attitude_survey')
  const attitudes = summariseAttitudes(attitudeSets.map((dataset) => ({ datasetHash: dataset.datasetHash, rows: dataset.rows as readonly AttitudeRow[] })))
  for (const distribution of attitudes.distributions) if (distribution.status === 'insufficient_data') flags.push(`attitude_insufficient_data:${distribution.dimension}`)

  const verdictSets = only(datasets, 'verdict_observations')
  const verdicts = summariseVerdicts({
    datasets: verdictSets.map((dataset) => ({ datasetHash: dataset.datasetHash, rows: dataset.rows as readonly VerdictRow[] })),
    assumptions, seed: inputs.seed,
  })
  if (verdictSets.length === 0) flags.push('no_verdict_observations')
  else if (verdicts.status === 'insufficient_data') flags.push('verdict_data_insufficient')

  const rejected: AnalysisRejectedItem[] = []
  const cultureNotes: AcceptedCultureNote[] = []
  for (const input of inputs.cultureNotes) {
    const note = typeof input?.note === 'string' ? input.note.trim() : ''
    if (!note) { rejected.push({ item: input, reason: 'This culture note is empty.' }); continue }
    const term = protectedTermIn(note)
    if (term) { rejected.push({ item: input, reason: `This culture note ${protectedTermMessage(term)}` }); continue }
    const checked = checkCitation(input.citation, inputs.evidenceHashes)
    if (!checked.ok) { rejected.push({ item: input, reason: checked.reason }); continue }
    cultureNotes.push({ note, citation: checked.citation })
  }

  const refs: DatasetRef[] = datasets.map((dataset) => ({
    datasetHash: dataset.datasetHash, kind: dataset.kind, name: dataset.name, source: dataset.source,
    retrievedAt: dataset.retrievedAt, licence: dataset.licence, rowCount: dataset.rows.length,
  }))

  const content: JuryProfileContent = {
    algorithmVersion: JURY_PROFILE_ALGORITHM_VERSION,
    label: PROFILE_LABEL,
    populationIsNotJuryPool: POPULATION_NOT_JURY_POOL,
    selectionWarning: SELECTION_WARNING,
    noCalibration: `${NO_CALIBRATION} ${NO_PROTECTED_CHARACTERISTICS}`,
    // `JSON.parse(JSON.stringify(...))` drops undefined and makes the stored and rebuilt content comparable.
    build: JSON.parse(JSON.stringify({
      seed: inputs.seed,
      datasetHashes: datasets.map((dataset) => dataset.datasetHash),
      assumptions,
      eligibilityRule: inputs.eligibilityRule,
      cultureNoteInputs: inputs.cultureNotes,
    })),
    datasets: refs,
    pool,
    attitudes: attitudes.distributions,
    cultureNotes,
    verdicts,
    strata: attitudes.strata,
    traitMapping: traitMapping.map((entry) => ({ ...entry })),
    lenses: attitudes.lenses,
    flags,
  }
  // Content is stored as JSON; keep it JSON-safe (no undefined, no NaN).
  return { content: JSON.parse(JSON.stringify(content)) as JuryProfileContent, rejected: JSON.parse(JSON.stringify(rejected)) as AnalysisRejectedItem[] }
}

// True when rebuilding from the recorded inputs gives exactly the stored content
// and the same refused notes. Used to refuse approval of any profile whose
// numbers were not produced by `buildProfileContent`.
export function profileReproduces(stored: { content: unknown; rejected: unknown }, rebuilt: ProfileBuildResult): boolean {
  return canonicalJson(stored.content) === canonicalJson(rebuilt.content) && canonicalJson(stored.rejected) === canonicalJson(rebuilt.rejected)
}
