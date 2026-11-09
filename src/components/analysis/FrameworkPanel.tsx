import { useCallback, useEffect, useId, useState } from 'react'
import { AlertTriangle, Scale } from 'lucide-react'

import { fetchMatterFramework, saveMatterFramework } from '../../api'
import type { FrameworkRule, FrameworkRuleKey, MatterFrameworkView } from '../../trialEngineTypes'
import { changeEvent, describeRuleValue, labels } from './courtRules'

interface CourtRulesViewProps {
  view: MatterFrameworkView | null
  error: string
  busy: boolean
  packId: string
  changedBy: string
  headingId: string
  onPackId: (id: string) => void
  onChangedBy: (name: string) => void
  onSave: (overrides: NonNullable<MatterFrameworkView['selection']>['overrides']) => void
}

// The screen itself, separate from loading and saving so it can be checked on its own.
export function CourtRulesView({ view, error, busy, packId, changedBy, headingId, onPackId, onChangedBy, onSave }: CourtRulesViewProps) {
  const pack = view?.pack
  const framework = view?.framework
  return <section className="court-rules" aria-labelledby={headingId}>
    <div className="case-section-heading"><h2 id={headingId}><Scale size={18} aria-hidden="true" /> Court rules</h2></div>
    {error && <p role="alert" className="case-warning">{error}</p>}
    {!view && !error && <p className="case-muted" role="status">Loading court rules…</p>}
    {view?.unreviewed && <div className="court-rules__banner case-warning" role="note">
      <AlertTriangle size={16} aria-hidden="true" /> <strong>{view.reviewNotice}</strong> Treat them as a starting point to check, not as legal advice. Each rule shows the authority it comes from.
    </div>}
    {view && !view.unreviewed && <p className="case-muted" role="note">{view.reviewNotice}</p>}
    {view && !view.selected && <p className="case-muted">No court rules are chosen for this case. A civil jury run uses the built-in rule of six jurors with five deciding. Choose a rule pack to pin its panel size and decision rule to each new civil run.</p>}
    {pack && <div className="court-rules__summary">
      <p><strong>{pack.title}</strong> · {pack.jurisdiction}</p>
      <p className="case-muted">Pack version <code title={pack.packHash}>{pack.packHash.slice(0, 12)}</code> · rules last confirmed {pack.staleness.oldestAsOf}</p>
      {pack.staleness.warning && <p role="status" className="case-warning">{pack.staleness.warning}</p>}
      {view?.packChangedSinceSaved && <p role="status" className="case-warning">The rule pack has changed since you chose it. Save again to use the current version.</p>}
      {framework && <ul className="court-rules__facts" aria-label="Rules a new civil run will use">
        <li>Panel size: <strong>{framework.panelSize === null ? 'not stated (blocks a jury run)' : `${framework.panelSize} jurors`}</strong></li>
        <li>Decision rule: <strong>{framework.threshold === null ? 'not stated (blocks a jury run)' : `${framework.threshold} of ${framework.panelSize ?? '?'} must agree`}</strong></li>
        <li>Reduced panel: <strong>{framework.reducedPanelRule ? `${framework.reducedPanelRule.minimumJurors} jurors, ${framework.reducedPanelRule.requiredAgreement === 'unanimous' ? 'unanimous' : `${framework.reducedPanelRule.requiredAgreement} must agree`}` : 'not stated'}</strong></li>
      </ul>}
      <table className="court-rules__table">
        <caption>Every rule in this pack, whether it is known, where it comes from and whether it has been reviewed.</caption>
        <thead><tr><th scope="col">Rule</th><th scope="col">Status</th><th scope="col">What it says</th><th scope="col">Authority</th><th scope="col">As of</th><th scope="col">Review</th></tr></thead>
        <tbody>{(Object.keys(labels) as FrameworkRuleKey[]).map((key) => {
          const rule = pack.rules[key] as FrameworkRule
          return <tr key={key}>
            <th scope="row">{labels[key]}</th>
            <td>{rule.status === 'known' ? 'Known' : 'Unknown'}{rule.status === 'unknown' && <span className="court-rules__blocks"> · blocks anything that depends on it</span>}{rule.toBeConfirmed && <span className="court-rules__confirm"> · to be confirmed</span>}</td>
            <td>{describeRuleValue(key, rule)}{rule.note && <small className="court-rules__note">{rule.note}</small>}</td>
            <td>{rule.authorities.length ? rule.authorities.map((authority) => <span key={`${authority.title}${authority.pinpoint}`} className="court-rules__authority">{authority.title}, {authority.pinpoint}</span>) : 'None entered'}</td>
            <td>{rule.asOf}</td>
            <td>{rule.reviewStatus === 'reviewed' ? `Reviewed by ${rule.reviewer ?? 'a named reviewer'}` : 'Unreviewed'}</td>
          </tr>
        })}</tbody>
      </table>
      {view?.selection && view.selection.overrides.length > 0 && <div className="court-rules__overrides">
        <h3>Changes made for this case</h3>
        <ul>{view.selection.overrides.map((override) => <li key={override.field}>{labels[override.field]}: set to {override.status} by {override.changedBy} on {override.changedAt.slice(0, 10)}{override.reason ? ` (${override.reason})` : ''}</li>)}</ul>
      </div>}
    </div>}
    {view && <form className="court-rules__form" onSubmit={(event) => { event.preventDefault(); onSave(view.selection?.overrides ?? []) }}>
      <label>Rule pack<select value={packId} onChange={(event) => onPackId(event.target.value)}>{view.packs.map((item) => <option key={item.id} value={item.id}>{item.title}{item.unreviewed ? ' (unreviewed)' : ''}</option>)}</select></label>
      <label>Your name, recorded with any change<input value={changedBy} onChange={(event) => onChangedBy(event.target.value)} autoComplete="name" /></label>
      <button type="submit" disabled={busy || !packId || !changedBy.trim()}>{view.selected ? 'Save court rules' : 'Use these court rules'}</button>
      {view.selection && view.selection.overrides.length > 0 && <button type="button" disabled={busy || !changedBy.trim()} onClick={() => onSave([])}>Remove changes made for this case</button>}
    </form>}
  </section>
}

export function FrameworkPanel({ matterId }: { matterId: string }) {
  const headingId = useId()
  const [view, setView] = useState<MatterFrameworkView | null>(null)
  const [packId, setPackId] = useState('')
  const [changedBy, setChangedBy] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setError('')
    return fetchMatterFramework(matterId).then((next) => { setView(next); setPackId((current) => current || next.selection?.packId || next.packs[0]?.id || '') })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not load the court rules.'))
  }, [matterId])
  useEffect(() => { setView(null); setPackId(''); void load() }, [load])

  const save = async (overrides: NonNullable<MatterFrameworkView['selection']>['overrides']) => {
    setBusy(true); setError('')
    try {
      const next = await saveMatterFramework(matterId, {
        packId, changedBy: changedBy.trim(),
        overrides: overrides.map(({ field, status, value, reason, authorities }) => ({ field, status, value, reason, authorities })),
      })
      setView(next)
      window.dispatchEvent(new CustomEvent(changeEvent, { detail: matterId }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the court rules.')
    } finally { setBusy(false) }
  }

  return <CourtRulesView view={view} error={error} busy={busy} packId={packId} changedBy={changedBy} headingId={headingId}
    onPackId={setPackId} onChangedBy={setChangedBy} onSave={(overrides) => void save(overrides)} />
}
