import { useCallback, useEffect, useId, useState } from 'react'
import { AlertTriangle, Users } from 'lucide-react'

import {
  approveJuryProfile, buildJuryProfile, deleteVenueDataset, fetchJuryProfileState, importVenueDataset, sampleJuryPanel,
} from '../../api'
import type { JuryProfileAssumptions, JuryProfileState, JuryProfileView, SamplePanelResult, VenueDatasetSummary } from '../../trialEngineTypes'
import {
  NO_PROTECTED_CHARACTERISTICS, POPULATION_NOT_JURY_POOL, PROFILE_LABEL, SELECTION_WARNING,
} from '../../../server/venue/constants'
import { attitudeLabels, verdictSourceTypes, type AttitudeDimension, type Interval, type Triple, type VerdictScenarioResult } from '../../../server/venue/types'
import { changeEvent } from './courtRules'

const percent = (value: number | null | undefined): string => (value === null || value === undefined || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(0)}%`)
const count = (value: number): string => Math.round(value).toLocaleString('en-CA')
const dollars = (cents: number): string => `$${(cents / 100).toLocaleString('en-CA', { maximumFractionDigits: 0 })}`
const interval = (range: Interval, format: (value: number) => string): string =>
  (range.lower === null || range.upper === null ? '' : `95% interval ${format(range.lower)} to ${format(range.upper)}`)
const kindLabel = (kind: string): string => kind.replaceAll('_', ' ')

function Bar({ share }: { share: number }) {
  // Decorative. The percentage next to it is the text equivalent.
  return <span className="jury-profile__bar" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, share * 100))}%` }} /></span>
}

// The selection warning is always on screen, with or without a profile.
export function SelectionWarning({ id }: { id?: string }) {
  return <div className="jury-profile__warning" role="note" aria-labelledby={id}>
    <p id={id}><AlertTriangle size={16} aria-hidden="true" /> <strong>Read this before using any figure here.</strong></p>
    <p>{SELECTION_WARNING}</p>
    <p>{PROFILE_LABEL}</p>
    <p>{NO_PROTECTED_CHARACTERISTICS}</p>
  </div>
}

function ScenarioRow({ label, raw, adjusted, pick, format }: {
  label: string
  raw: VerdictScenarioResult
  adjusted: { low: VerdictScenarioResult; central: VerdictScenarioResult; high: VerdictScenarioResult }
  pick: (result: VerdictScenarioResult) => { value: number; range?: Interval } | null
  format: (value: number) => string
}) {
  const cell = (result: VerdictScenarioResult) => {
    const picked = pick(result)
    if (!picked) return <td className="num">insufficient data</td>
    return <td className="num">{format(picked.value)}{picked.range && <small className="jury-profile__small">{interval(picked.range, format)}</small>}</td>
  }
  return <tr>
    <th scope="row">{label}</th>
    {cell(raw)}{cell(adjusted.low)}{cell(adjusted.central)}{cell(adjusted.high)}
  </tr>
}

function VerdictSection({ profile }: { profile: JuryProfileView }) {
  const verdicts = profile.content.verdicts
  if (verdicts.status === 'insufficient_data') {
    return <div className="jury-profile__card" role="status">
      <strong>Insufficient data</strong>
      <p>{verdicts.sampleSize} decided verdict observation{verdicts.sampleSize === 1 ? '' : 's'}; at least {verdicts.minimumSample} are needed before any share or adjusted figure is shown.</p>
      <p className="jury-profile__small">Observations by outcome: plaintiff {verdicts.counts.plaintiff}, defence {verdicts.counts.defence}, no verdict {verdicts.counts.no_verdict}. No adjusted figure is shown.</p>
    </div>
  }
  const { raw, adjusted, range } = verdicts
  const share = (result: VerdictScenarioResult) => (result.plaintiffShare ? { value: result.plaintiffShare.value, range: result.plaintiffShare.interval } : null)
  const award = (key: 'p25' | 'median' | 'p75') => (result: VerdictScenarioResult) =>
    (result.awards.status === 'ok' ? { value: result.awards.cents[key], range: key === 'median' ? result.awards.cents.medianInterval : undefined } : null)
  return <>
    <table className="jury-profile__table">
      <caption>Verdict observations: what the imported rows say (raw) next to the same rows re-weighted for the reporting assumptions you stated. {verdicts.sampleSize} decided observations from {verdicts.provenance.length} dataset{verdicts.provenance.length === 1 ? '' : 's'}.</caption>
      <thead><tr><th scope="col">Measure</th><th scope="col">Raw</th><th scope="col">Adjusted, low</th><th scope="col">Adjusted, central</th><th scope="col">Adjusted, high</th></tr></thead>
      <tbody>
        <ScenarioRow label="Plaintiff share of decided verdicts" raw={raw} adjusted={adjusted} pick={share} format={percent} />
        <ScenarioRow label="Median award" raw={raw} adjusted={adjusted} pick={award('median')} format={dollars} />
        <ScenarioRow label="25th percentile award" raw={raw} adjusted={adjusted} pick={award('p25')} format={dollars} />
        <ScenarioRow label="75th percentile award" raw={raw} adjusted={adjusted} pick={award('p75')} format={dollars} />
      </tbody>
    </table>
    <p className="jury-profile__status">Range of the adjusted plaintiff share across the low, central and high assumptions: {percent(range.plaintiffShare.min)} to {percent(range.plaintiffShare.max)}. {range.medianAwardCents ? `Range of the adjusted median award: ${dollars(range.medianAwardCents.min)} to ${dollars(range.medianAwardCents.max)}.` : 'Too few awards for an award range.'} Awards are in the currency of the source data. Intervals are seeded resamples of the observations, not guarantees.</p>
    <p className="jury-profile__small">Observations by source: {verdictSourceTypes.map((type) => `${kindLabel(type)} ${verdicts.bySourceType[type]}`).join(', ')}. By outcome: plaintiff {verdicts.counts.plaintiff}, defence {verdicts.counts.defence}, no verdict {verdicts.counts.no_verdict}.</p>
  </>
}

function PoolSection({ profile }: { profile: JuryProfileView }) {
  const pool = profile.content.pool
  if (pool.status === 'not_adjusted') {
    return <div className="jury-profile__card" role="status">
      <strong>No pool adjustment</strong>
      <p>{pool.reason}</p>
      {pool.population && <p className="jury-profile__small">Population as imported: {count(pool.population.total)} (not a jury pool).</p>}
    </div>
  }
  const row = (label: string, triple: Triple, format: (value: number) => string) => <tr>
    <th scope="row">{label}</th><td className="num">{format(triple.low)}</td><td className="num">{format(triple.central)}</td><td className="num">{format(triple.high)}</td>
  </tr>
  return <>
    <table className="jury-profile__table">
      <caption>From population to likely jury pool. Eligibility comes from the court rules; response rates are your stated assumptions.</caption>
      <thead><tr><th scope="col">Measure</th><th scope="col">Low</th><th scope="col">Central</th><th scope="col">High</th></tr></thead>
      <tbody>
        {row('Response rate (your assumption)', pool.responseRate, percent)}
        {row('Likely jury pool', pool.pool.count, count)}
        {row('Likely jury pool, share of population', pool.pool.shareOfPopulation, percent)}
      </tbody>
    </table>
    <p className="jury-profile__status">Population imported: {count(pool.population.total)}. Eligible under the court rules: {count(pool.eligible.count)} ({percent(pool.eligible.shareOfPopulation)}).{pool.population.unclassified > 0 && ` ${count(pool.population.unclassified)} people are in groups the table could not classify and are not counted as eligible.`}</p>
    <table className="jury-profile__table">
      <caption>People who fail each eligibility criterion (a person can fail more than one).</caption>
      <thead><tr><th scope="col">Criterion</th><th scope="col">People who fail it</th></tr></thead>
      <tbody>{pool.byCriterion.map((item) => <tr key={item.criterionId}><th scope="row">{item.label}</th><td className="num">{count(item.failing)}</td></tr>)}</tbody>
    </table>
  </>
}

function AttitudeSection({ profile }: { profile: JuryProfileView }) {
  const { attitudes } = profile.content
  if (!attitudes.length) return <p className="case-muted">No attitude survey was used.</p>
  return <table className="jury-profile__table">
    <caption>Attitude and experience distributions from the imported surveys. Synthetic jurors are sampled from these and from nothing else.</caption>
    <thead><tr><th scope="col">Attitude</th><th scope="col">Respondents</th><th scope="col">Low</th><th scope="col">Medium</th><th scope="col">High</th></tr></thead>
    <tbody>{attitudes.map((item) => <tr key={item.dimension}>
      <th scope="row">{item.label}</th>
      <td className="num">{item.respondents}</td>
      {item.levels === null
        ? <td colSpan={3}>Insufficient data: not sampled</td>
        : item.levels.map((level) => <td key={level.level} className="num"><Bar share={level.share} />{percent(level.share)}</td>)}
    </tr>)}</tbody>
  </table>
}

export interface JuryProfileViewProps {
  state: JuryProfileState | null
  error: string
  busy: boolean
  panel: SamplePanelResult | null
  onImport: (json: string) => void
  onDelete: (dataset: VenueDatasetSummary) => void
  onBuild: (assumptions: JuryProfileAssumptions, seed: string) => void
  onApprove: (artifactId: string) => void
  onSample: (seed: string, count: number) => void
}

const numberOrUndefined = (text: string): number | undefined => (text.trim() === '' ? undefined : Number(text))
interface TripleText { low: string; central: string; high: string }
const blankTriple = (): TripleText => ({ low: '', central: '', high: '' })
const toTriple = (text: TripleText): Triple | undefined => {
  const low = numberOrUndefined(text.low)
  const central = numberOrUndefined(text.central)
  const high = numberOrUndefined(text.high)
  return low === undefined && central === undefined && high === undefined ? undefined : { low: low ?? Number.NaN, central: central ?? Number.NaN, high: high ?? Number.NaN }
}

function TripleInputs({ legend, value, onChange, hint }: { legend: string; value: TripleText; onChange: (next: TripleText) => void; hint?: string }) {
  return <fieldset className="jury-profile__fieldset">
    <legend>{legend}</legend>
    <div className="jury-profile__row">
      {(['low', 'central', 'high'] as const).map((key) => <label key={key}>{key[0]?.toUpperCase()}{key.slice(1)}
        <input type="number" inputMode="decimal" min={0} max={1} step={0.01} value={value[key]} onChange={(event) => onChange({ ...value, [key]: event.target.value })} />
      </label>)}
    </div>
    {hint && <span className="jury-profile__small">{hint}</span>}
  </fieldset>
}

// The screen itself, separate from loading so it can be checked on its own.
export function JuryProfileScreen({ state, error, busy, panel, onImport, onDelete, onBuild, onApprove, onSample }: JuryProfileViewProps) {
  const headingId = useId()
  const warningId = useId()
  const [json, setJson] = useState('')
  const [response, setResponse] = useState<TripleText>(blankTriple)
  const [reporting, setReporting] = useState<TripleText>(blankTriple)
  const [perSource, setPerSource] = useState<Record<string, TripleText>>({})
  const [seed, setSeed] = useState('jury-profile')
  const [panelSeed, setPanelSeed] = useState('preview')
  const [panelSize, setPanelSize] = useState(6)
  const profile = state?.profile ?? null

  const submitBuild = () => {
    const rules: JuryProfileAssumptions['reporting'] = []
    const fallback = toTriple(reporting)
    if (fallback) rules.push({ probability: fallback })
    for (const [type, text] of Object.entries(perSource)) {
      const triple = toTriple(text)
      if (triple) rules.push({ sourceType: type as (typeof verdictSourceTypes)[number], probability: triple })
    }
    const responseRate = toTriple(response)
    onBuild({ ...(responseRate ? { responseRate } : {}), reporting: rules, awardBandEdgesCents: [] }, seed.trim() || 'jury-profile')
  }

  return <section className="jury-profile" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><Users size={18} aria-hidden="true" /> Local jury profile</h2></div>
    <SelectionWarning id={warningId} />
    {error && <p role="alert" className="case-warning">{error}</p>}
    {!state && !error && <p className="case-muted" role="status">Loading the jury profile…</p>}
    {state && <>
      <p className="case-muted">{POPULATION_NOT_JURY_POOL}</p>
      <h3>Datasets you imported</h3>
      <p className="case-muted">Nothing is looked up on the web. Every figure below comes from these datasets and from the assumptions you state. The app never asks a model for a statistic.</p>
      {state.datasets.length === 0
        ? <p className="case-muted">No datasets yet. Import a population table, an attitude survey, focus-group findings or verdict observations, each with its source, licence and retrieval date.</p>
        : <table className="jury-profile__table">
          <caption>Imported datasets. A dataset used by an approved profile cannot be deleted.</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Source</th><th scope="col">Licence</th><th scope="col" className="nowrap">Retrieved</th><th scope="col" className="nowrap">Rows</th><th scope="col" className="nowrap"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{state.datasets.map((dataset) => <tr key={dataset.id}>
            <th scope="row">{dataset.name}<small className="jury-profile__small">Fingerprint {dataset.datasetHash.slice(0, 12)}</small></th>
            <td>{kindLabel(dataset.kind)}</td><td>{dataset.source}</td><td>{dataset.licence}</td><td className="nowrap">{dataset.retrievedAt}</td><td className="num">{dataset.rowCount}</td>
            <td className="nowrap"><button type="button" disabled={busy || dataset.usedByApprovedProfile} title={dataset.usedByApprovedProfile ? 'An approved profile was built from this dataset' : undefined} onClick={() => onDelete(dataset)}>Delete<span className="sr-only"> {dataset.name}</span></button></td>
          </tr>)}</tbody>
        </table>}
      <form className="jury-profile__form" onSubmit={(event) => { event.preventDefault(); onImport(json) }}>
        <label>Dataset JSON (name, kind, source, retrievedAt, licence, rows)
          <textarea value={json} onChange={(event) => setJson(event.target.value)} spellCheck={false} />
        </label>
        <label>Or choose a .json file
          <input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(setJson) }} />
        </label>
        <button type="submit" disabled={busy || !json.trim()}>Import dataset</button>
      </form>

      <h3>Build a profile</h3>
      <p className="case-muted">{state.eligibilityNow.status === 'known'
        ? `Who may serve comes from the court rules (${state.eligibilityNow.criteria.length} criteria; ${state.eligibilityNow.source === 'matter_override' ? 'entered for this case' : 'from the rule pack'}).`
        : `${state.eligibilityNow.reason} A population table will not be narrowed to a pool.`}</p>
      <form className="jury-profile__form" onSubmit={(event) => { event.preventDefault(); submitBuild() }}>
        <TripleInputs legend="Response rate: share of eligible people who would be available and willing to serve" value={response} onChange={setResponse} hint="Your assumption, from 0 to 1. Needed only when the court rules state who is eligible." />
        <TripleInputs legend="Chance a verdict is reported, for every source" value={reporting} onChange={setReporting} hint="Your assumption, from 0 to 1. Needed only when there are enough verdict observations." />
        <details>
          <summary>Different reporting chances for particular sources</summary>
          {verdictSourceTypes.map((type) => <TripleInputs key={type} legend={kindLabel(type)} value={perSource[type] ?? blankTriple()} onChange={(next) => setPerSource({ ...perSource, [type]: next })} />)}
        </details>
        <label>Seed for the resampled intervals<input value={seed} onChange={(event) => setSeed(event.target.value)} /></label>
        <button type="submit" disabled={busy || state.datasets.length === 0}>Build profile</button>
      </form>

      {profile && <div>
        <h3>Profile version {profile.version}</h3>
        <p className="jury-profile__status" role="status">
          {profile.status === 'approved' ? 'Approved' : profile.status === 'draft' ? 'Draft: not yet approved' : profile.status} · fingerprint <code title={profile.contentHash}>{profile.contentHash.slice(0, 12)}</code> · built from {profile.content.datasets.length} dataset{profile.content.datasets.length === 1 ? '' : 's'}.
          {profile.freshness.status === 'out_of_date' && <span className="jury-profile__stale"> Out of date: {profile.freshness.reasons.join(' ')}</span>}
        </p>
        {profile.status === 'draft' && <button type="button" disabled={busy || profile.freshness.status === 'out_of_date'} onClick={() => onApprove(profile.id)}>Approve this profile</button>}
        {profile.content.flags.length > 0 && <p className="jury-profile__small">Flags: {profile.content.flags.map((flag) => flag.replaceAll('_', ' ').replace(':', ': ')).join('; ')}.</p>}

        <h3>Pool adjustment</h3>
        <PoolSection profile={profile} />
        <h3>Attitudes and experience</h3>
        <AttitudeSection profile={profile} />
        <h3>Verdict observations</h3>
        <VerdictSection profile={profile} />

        {profile.content.cultureNotes.length > 0 && <>
          <h3>Culture notes</h3>
          <ul className="jury-profile__list">{profile.content.cultureNotes.map((note) => <li key={note.note}>{note.note} <span className="jury-profile__small">{'url' in note.citation ? `Source: ${note.citation.url}` : `Source: a document in this case (fingerprint ${note.citation.evidenceSha256.slice(0, 12)}${note.citation.paragraph ? `, paragraph ${note.citation.paragraph}` : ''})`}</span></li>)}</ul>
        </>}
        {profile.rejected.length > 0 && <>
          <h3>Notes not accepted</h3>
          <ul className="jury-profile__list">{profile.rejected.map((item, index) => <li key={index}>{String((item.item as { note?: string } | null)?.note ?? 'A note')}: {item.reason}</li>)}</ul>
        </>}

        <h3>Preview a synthetic panel</h3>
        <p className="case-muted">Jurors are sampled from the attitude strata above. This is a preview: nothing is saved, and the jurors are described only by attitudes and experience.</p>
        <form className="jury-profile__form" onSubmit={(event) => { event.preventDefault(); onSample(panelSeed, panelSize) }}>
          <label>Seed<input value={panelSeed} onChange={(event) => setPanelSeed(event.target.value)} /></label>
          <label>Jurors<input type="number" min={1} max={24} value={panelSize} onChange={(event) => setPanelSize(Number(event.target.value) || 1)} /></label>
          <button type="submit" disabled={busy || !panelSeed.trim() || profile.status === 'superseded' || profile.status === 'failed'}>Preview panel</button>
        </form>
        {panel && <table className="jury-profile__table">
          <caption>{panel.jurors.length} synthetic jurors, seed {panel.seed}. {panel.label}{panel.unsampledDimensions.length > 0 && ` Not sampled for lack of data: ${panel.unsampledDimensions.map((dimension) => attitudeLabels[dimension as AttitudeDimension]).join(', ')}.`}</caption>
          <thead><tr><th scope="col">Juror</th>{profile.content.strata.map((stratum) => <th scope="col" key={stratum.dimension}>{attitudeLabels[stratum.dimension]}</th>)}</tr></thead>
          <tbody>{panel.jurors.map((juror) => <tr key={juror.key}>
            <th scope="row">{juror.key}</th>
            {profile.content.strata.map((stratum) => <td key={stratum.dimension}>{juror.strata[stratum.dimension] ?? 'n/a'}</td>)}
          </tr>)}</tbody>
        </table>}
      </div>}
    </>}
  </section>
}

export function JuryProfilePanel({ matterId }: { matterId: string }) {
  const [state, setState] = useState<JuryProfileState | null>(null)
  const [panel, setPanel] = useState<SamplePanelResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void fetchJuryProfileState(matterId).then((next) => { setState(next); setError('') })
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not load the jury profile.'))
  }, [matterId])
  useEffect(() => { setState(null); setPanel(null); load() }, [load])
  // A change to the court rules can change who is eligible to serve.
  useEffect(() => {
    const onChange = (event: Event) => { if ((event as CustomEvent<string>).detail === matterId) load() }
    window.addEventListener(changeEvent, onChange)
    return () => window.removeEventListener(changeEvent, onChange)
  }, [matterId, load])

  const run = (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    void action().then(load).catch((caught) => setError(caught instanceof Error ? caught.message : 'That did not work.')).finally(() => setBusy(false))
  }

  return <JuryProfileScreen
    state={state} error={error} busy={busy} panel={panel}
    onImport={(text) => {
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { setError('That is not valid JSON, so nothing was imported.'); return }
      run(() => importVenueDataset(matterId, parsed))
    }}
    onDelete={(dataset) => { if (window.confirm(`Delete the dataset "${dataset.name}"? This cannot be undone.`)) run(() => deleteVenueDataset(matterId, dataset.id)) }}
    onBuild={(assumptions, seed) => run(() => buildJuryProfile(matterId, { assumptions, seed }))}
    onApprove={(artifactId) => run(() => approveJuryProfile(matterId, artifactId))}
    onSample={(seed, count) => {
      setBusy(true); setError('')
      void sampleJuryPanel(matterId, { artifactId: state?.profile?.id, seed, count }).then(setPanel)
        .catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not sample a panel.')).finally(() => setBusy(false))
    }}
  />
}
