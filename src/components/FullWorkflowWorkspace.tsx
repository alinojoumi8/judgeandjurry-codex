import { Check, ChevronRight, FileArchive, FolderOpen, Gavel, Loader2, Play, RefreshCw, Scale, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  analyzeDisclosure,
  approveCaseModel,
  approveMotion,
  approveTrialCheckpoint,
  confirmCorpusPreview,
  createRobustnessVariants,
  createTrialRun,
  draftCaseModel,
  draftMotionDocket,
  fetchAdmissionLedgers,
  fetchCorpusJob,
  fetchRobustnessReport,
  fetchTrialRun,
  previewCorpusFolder,
  previewCorpusZip,
  saveTheoryBrief,
  startAutonomousTrial,
} from '../api'
import type {
  AdmissionLedger,
  CaseModel,
  CorpusJob,
  CorpusPreview,
  DisclosureFinding,
  ManifestEntry,
  Motion,
  ProcedureAdapterId,
  RobustnessReport,
  TheoryBrief,
  TrialRunConfig,
  TrialRunView,
} from '../trialEngineTypes'

const steps = [
  'Source Intake', 'Extraction Review', 'Neutral Case Model', 'Side Theories',
  'Disclosure Issues', 'Motion Docket', 'Admitted Record', 'Full Proceeding',
  'Decision Sheet', 'Post-run Audit', 'Robustness Lab',
] as const

interface Props {
  matterId: string
  matterTitle: string
  onEvidenceImported: () => Promise<void>
}

export function FullWorkflowWorkspace({ matterId, matterTitle, onEvidenceImported }: Props) {
  const [step, setStep] = useState(0)
  const [folderPath, setFolderPath] = useState('')
  const [preview, setPreview] = useState<CorpusPreview | null>(null)
  const [job, setJob] = useState<CorpusJob | null>(null)
  const [manifest, setManifest] = useState<ManifestEntry[]>([])
  const [adapter, setAdapter] = useState<ProcedureAdapterId>('ontario_criminal_jury_v1')
  const [civilDecisionMaker, setCivilDecisionMaker] = useState<'judge_alone' | 'jury'>('judge_alone')
  const [civilJuryNoticeConfirmed, setCivilJuryNoticeConfirmed] = useState(false)
  const [caseModel, setCaseModel] = useState<CaseModel | null>(null)
  const [theoryText, setTheoryText] = useState<Record<string, string>>({})
  const [theories, setTheories] = useState<TheoryBrief[]>([])
  const [findings, setFindings] = useState<DisclosureFinding[]>([])
  const [motions, setMotions] = useState<Motion[]>([])
  const [ledgers, setLedgers] = useState<AdmissionLedger[]>([])
  const [trial, setTrial] = useState<TrialRunView | null>(null)
  const [robustness, setRobustness] = useState<RobustnessReport | null>(null)
  const [externalConfirmed, setExternalConfirmed] = useState(false)
  const [reviewMotions, setReviewMotions] = useState(false)
  const [reviewInstructions, setReviewInstructions] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return
    const interval = window.setInterval(() => {
      void fetchCorpusJob(job.id).then((result) => {
        setJob(result.job)
        setManifest(result.manifest)
        if (result.job.status === 'completed') void onEvidenceImported()
      }).catch((caught: unknown) => setError(message(caught)))
    }, 900)
    return () => window.clearInterval(interval)
  }, [job, onEvidenceImported])

  useEffect(() => {
    if (!trial || !['running', 'ready'].includes(trial.run.status)) return
    const interval = window.setInterval(() => {
      void fetchTrialRun(trial.run.id).then(setTrial).catch((caught: unknown) => setError(message(caught)))
    }, 1_000)
    return () => window.clearInterval(interval)
  }, [trial])

  useEffect(() => {
    if (step !== 6) return
    void fetchAdmissionLedgers(matterId).then(setLedgers).catch((caught: unknown) => setError(message(caught)))
  }, [matterId, step, motions])

  const estimate = useMemo(() => {
    const files = preview?.fileCount ?? manifest.length
    const issues = Math.max(1, caseModel?.decisionIssues.length ?? 1)
    const panel = adapter === 'ontario_criminal_jury_v1' ? 12 : adapter === 'ontario_capital_markets_v1' ? 3 : civilDecisionMaker === 'jury' ? 6 : 1
    const calls = caseModel
      ? panel * issues * 2 + panel * 3 + caseModel.parties.length * 2 + motions.filter((motion) => motion.status === 'approved').length * 3
      : 0
    return { files, calls, minutes: calls ? `${Math.max(2, Math.ceil(calls / 6))}–${Math.max(5, Math.ceil(calls / 2))}` : 'not yet available' }
  }, [adapter, caseModel, civilDecisionMaker, manifest.length, motions, preview?.fileCount])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try { await work() } catch (caught) { setError(message(caught)) } finally { setBusy(false) }
  }

  const inspectJob = async (jobId: string) => {
    const result = await fetchCorpusJob(jobId)
    setJob(result.job)
    setManifest(result.manifest)
  }

  const createAndStartTrial = async () => {
    if (!caseModel || caseModel.status !== 'approved') throw new Error('Approve the neutral case model first.')
    const config: TrialRunConfig = {
      mode: 'full', procedureAdapter: adapter, seed: crypto.randomUUID(),
      checkpointPolicy: {
        default: 'autonomous',
        approvalPhases: [reviewMotions ? 'motions' : '', reviewInstructions ? 'instructions' : ''].filter(Boolean),
        allowCounselTakeover: true,
      },

      witnessPlan: caseModel.witnesses.map((witness, index) => ({
        witnessId: witness.id, calledByPartyId: caseModel.parties[0]?.id ?? 'user', order: index,
      })),
      deliberation: { maxRounds: 3, concurrency: 4 },
      civilDecisionMaker: adapter === 'ontario_civil_v1' ? civilDecisionMaker : undefined,
      externalDisclosureConfirmed: externalConfirmed,
    }
    const created = await createTrialRun(matterId, caseModel.id, config)
    setTrial(await startAutonomousTrial(created.run.id))
  }

  return (
    <section className="full-workflow">
      <aside className="workflow-steps" aria-label="Full proceeding workflow">
        <div className="workflow-title">
          <Scale size={18} />
          <div><strong>Trial Engine v2</strong><span>{matterTitle}</span></div>
        </div>
        {steps.map((label, index) => (
          <button key={label} type="button" className={step === index ? 'active' : ''} onClick={() => setStep(index)}>
            <span>{index + 1}</span>{label}<ChevronRight size={14} />
          </button>
        ))}
      </aside>

      <div className="workflow-panel">
        <header>
          <div><span className="eyebrow">Step {step + 1} of {steps.length}</span><h2>{steps[step]}</h2></div>
          {busy && <Loader2 className="spin" size={20} />}
        </header>
        {error && <div className="error-banner">{error}</div>}

        {step === 0 && (
          <div className="workflow-stack">
            <p>Preview a loopback-only folder or a portable ZIP. Previewing reads and hashes sources but does not alter them or send content to a model.</p>
            <div className="workflow-row">
              <input value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="C:\Disclosure\Matter folder" />
              <button type="button" disabled={!folderPath || busy} onClick={() => void run(async () => setPreview(await previewCorpusFolder(matterId, folderPath)))}><FolderOpen size={16} /> Preview folder</button>
              <label className="file-action"><FileArchive size={16} /> Preview ZIP<input type="file" accept=".zip,application/zip" onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void run(async () => setPreview(await previewCorpusZip(matterId, file)))
              }} /></label>
            </div>
            {preview && <PreviewCard preview={preview} />}
            {preview && (
              <>
                <label className="workflow-check"><input type="checkbox" checked={externalConfirmed} onChange={(event) => setExternalConfirmed(event.target.checked)} /> I confirm this corpus may be disclosed to the configured external model during later approved workflow stages.</label>
                <button className="primary-action" type="button" onClick={() => void run(async () => {
                  const queued = await confirmCorpusPreview(matterId, preview.id, externalConfirmed)
                  await inspectJob(queued.id)
                  setStep(1)
                })}><Check size={16} /> Confirm and preserve corpus</button>
              </>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="workflow-stack">
            <SummaryGrid items={[
              ['Status', job?.status ?? 'No import job'], ['Files', `${job?.processedFiles ?? 0} / ${job?.totalFiles ?? 0}`],
              ['Bytes', `${formatBytes(job?.processedBytes ?? 0)} / ${formatBytes(job?.totalBytes ?? 0)}`],
              ['External disclosure', job?.externalDisclosureConfirmed ? 'Confirmed' : 'Not confirmed'],
            ]} />
            <div className="manifest-list">{manifest.map((entry) => <article key={entry.id}><div><strong>{entry.relativePath}</strong><span>{entry.mimeType} · {formatBytes(entry.size)}</span></div><span className={`status-pill status-${entry.status}`}>{entry.status}</span>{entry.warning && <p>{entry.warning}</p>}</article>)}</div>
            {job?.status === 'completed' && <button className="primary-action" type="button" onClick={() => setStep(2)}>Continue to neutral model <ChevronRight size={16} /></button>}
          </div>
        )}

        {step === 2 && (
          <div className="workflow-stack">
            <label>Procedure adapter<select value={adapter} onChange={(event) => setAdapter(event.target.value as ProcedureAdapterId)}><option value="ontario_criminal_jury_v1">Ontario criminal jury</option><option value="ontario_capital_markets_v1">Ontario Capital Markets Tribunal</option><option value="ontario_civil_v1">Ontario civil</option></select></label>
            {adapter === 'ontario_civil_v1' && <><label>Decision maker<select value={civilDecisionMaker} onChange={(event) => setCivilDecisionMaker(event.target.value as 'judge_alone' | 'jury')}><option value="judge_alone">Judge alone</option><option value="jury">Six-person civil jury</option></select></label>{civilDecisionMaker === 'jury' && <label className="workflow-check"><input type="checkbox" checked={civilJuryNoticeConfirmed} onChange={(event) => setCivilJuryNoticeConfirmed(event.target.checked)} /> The case model should record a manually confirmed valid jury notice. This remains subject to legal review.</label>}</>}
            <button type="button" onClick={() => void run(async () => setCaseModel(await draftCaseModel(
              matterId,
              adapter,
              adapter === 'ontario_civil_v1' && civilDecisionMaker === 'jury'
                ? { juryNotice: { valid: civilJuryNoticeConfirmed, note: civilJuryNoticeConfirmed ? 'User manually confirmed a valid jury notice for this simulation.' : 'A valid jury notice has not been confirmed.', sourceRefs: [{ attribution: civilJuryNoticeConfirmed ? 'manual' : 'unresolved' }] } }
                : undefined,
            )))}>Draft neutral case model</button>
            {caseModel && <CaseModelCard model={caseModel} />}
            {caseModel?.status === 'draft' && <button className="primary-action" type="button" onClick={() => void run(async () => setCaseModel(await approveCaseModel(caseModel.id)))}><Check size={16} /> Approve model version {caseModel.version}</button>}
          </div>
        )}

        {step === 3 && (
          <div className="workflow-stack">
            <p>Each brief stays private to its side and never becomes evidence. Public submissions become visible only after the advocate renders them.</p>
            {caseModel?.parties.map((party) => <article className="theory-editor" key={party.id}><strong>{party.name} · {party.role}</strong><textarea value={theoryText[party.id] ?? ''} onChange={(event) => setTheoryText((current) => ({ ...current, [party.id]: event.target.value }))} placeholder="Optional private scenario; leave blank to generate from the neutral ledger." /><button type="button" onClick={() => void run(async () => {
              const brief = await saveTheoryBrief(caseModel.id, { partyId: party.id, side: party.role, narrative: theoryText[party.id] ?? '' })
              setTheories((current) => [...current.filter((item) => item.partyId !== party.id), brief])
            })}>Save private theory</button></article>)}
            {theories.map((brief) => <div className="notice-card" key={brief.id}><strong>{brief.title}</strong><span>Private advocacy · {brief.claims.length} mapped claim(s)</span></div>)}
          </div>
        )}

        {step === 4 && (
          <div className="workflow-stack">
            <button type="button" disabled={!caseModel} onClick={() => caseModel && void run(async () => setFindings(await analyzeDisclosure(matterId, caseModel.id)))}><ShieldAlert size={16} /> Analyze disclosure</button>
            {findings.map((finding) => <article className="finding-card" key={finding.id}><div><span className={`severity severity-${finding.severity}`}>{finding.severity}</span><strong>{finding.title}</strong></div><p>{finding.description}</p><small>{finding.operational ? 'Operational extraction issue' : `Legal review · possible relief: ${finding.suggestedRelief.join(', ')}`}</small></article>)}
          </div>
        )}

        {step === 5 && (
          <div className="workflow-stack">
            <p>Only legal findings are proposed as motions. You must approve or edit a draft before it can be heard.</p>
            <button type="button" disabled={!caseModel} onClick={() => caseModel && void run(async () => setMotions(await draftMotionDocket(caseModel.id)))}><Gavel size={16} /> Draft ranked motion docket</button>
            {motions.map((motion) => <article className="motion-card" key={motion.id}><div><strong>{motion.title}</strong><span className="status-pill">{motion.status}</span></div>{motion.status === 'draft' ? <label>Requested relief<input value={motion.requestedRelief.join(', ')} onChange={(event) => setMotions((current) => current.map((item) => item.id === motion.id ? { ...item, requestedRelief: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) } : item))} /></label> : <p>{motion.requestedRelief.join(' · ')}</p>}{motion.status === 'draft' && <button type="button" onClick={() => void run(async () => {
              const approved = await approveMotion(motion.id, motion.requestedRelief)
              setMotions((current) => current.map((item) => item.id === approved.id ? approved : item))
            })}>Approve motion</button>}</article>)}
          </div>
        )}

        {step === 6 && (
          <div className="workflow-stack"><p>The admitted record is projected from versioned rulings. Excluded, reserved, and role-hidden material is filtered at actor query time.</p><SummaryGrid items={[["Preserved sources", String(manifest.length)], ["Approved motions", String(motions.filter((motion) => motion.status !== 'draft').length)], ["Decided rulings", String(motions.filter((motion) => motion.status === 'decided').length)], ["Ledger versions", String(ledgers.length)]]} />{ledgers[0] ? <><div className="notice-card"><strong>Admission ledger v{ledgers[0].version}</strong><span>{ledgers[0].reason}</span></div><div className="manifest-list">{ledgers[0].evidenceUses.map((use) => <article key={use.evidenceId}><div><strong>{use.evidenceId}</strong><span>{use.purposes.join(', ') || 'General use'}{use.note ? ` · ${use.note}` : ''}</span></div><span className={`status-pill status-${use.status}`}>{use.status}</span></article>)}</div></> : <p>No admission projection exists yet. The initial version is created with a trial, and every simulated ruling creates a new version.</p>}</div>
        )}

        {step === 7 && (
          <div className="workflow-stack">
            <SummaryGrid items={[["Files", String(estimate.files)], ["Expected model calls", String(estimate.calls)], ["Expected runtime", `${estimate.minutes} minutes`], ["External disclosure", externalConfirmed ? 'Confirmed' : 'Not confirmed']]} />
            <label className="workflow-check"><input type="checkbox" checked={reviewMotions} onChange={(event) => setReviewMotions(event.target.checked)} /> Pause for review after motion rulings.</label>
            {adapter !== 'ontario_capital_markets_v1' && <label className="workflow-check"><input type="checkbox" checked={reviewInstructions} onChange={(event) => setReviewInstructions(event.target.checked)} /> Pause for review after judicial instructions.</label>}
            <p className="disclaimer">Synthetic panels are not statistically representative and do not predict real verdicts. This workflow is for preparation and stress testing.</p>
            <button className="primary-action" type="button" disabled={!caseModel || caseModel.status !== 'approved'} onClick={() => void run(createAndStartTrial)}><Play size={16} /> Create and run full proceeding</button>
            {trial && <RunStatus trial={trial} />}
            {trial?.run.status === 'checkpoint' && <button type="button" onClick={() => void run(async () => {
              await approveTrialCheckpoint(trial.run.id, 'Approved in guided workspace.')
              setTrial(await startAutonomousTrial(trial.run.id))
            })}><Check size={16} /> Approve checkpoint and continue</button>}
          </div>
        )}

        {step === 8 && (
          <div className="workflow-stack">{trial?.decisionSheet ? trial.decisionSheet.decisions.map((decision) => <article className="decision-card" key={decision.issueId}><span>{decision.issueId}</span><strong>{decision.outcome.replaceAll('_', ' ')}</strong><p>{decision.rule}{decision.voteCounts ? ` · ${Object.entries(decision.voteCounts).map(([choice, count]) => `${choice}: ${count}`).join(', ')}` : ''}</p>{decision.warnings.map((warning) => <small key={warning}>{warning}</small>)}</article>) : <p>No decision sheet yet.</p>}</div>
        )}

        {step === 9 && (
          <div className="workflow-stack"><SummaryGrid items={[["Events", String(trial?.events.length ?? 0)], ["Juror profiles", String(trial?.jurorProfiles.length ?? 0)], ["Initial ballots", String(trial?.ballots.filter((ballot) => ballot.round === 'initial').length ?? 0)], ["Final ballots", String(trial?.ballots.filter((ballot) => ballot.round === 'final').length ?? 0)]]} /><div className="event-audit">{trial?.events.map((event) => <div key={event.id}><span>#{event.sequence}</span><strong>{event.type.replaceAll('_', ' ')}</strong><small>{event.actorId ?? 'system'} · {event.phase}</small></div>)}</div></div>
        )}

        {step === 10 && (
          <div className="workflow-stack">
            <p>Repeat the approved scenario across stored seeds. Results report scenario sensitivity and recurring proof gaps—not population probabilities.</p>
            <div className="workflow-row"><button type="button" disabled={!trial} onClick={() => trial && void run(async () => {
              const created = await createRobustnessVariants(trial.run.id, ['robust-a', 'robust-b', 'robust-c'])
              setRobustness(created.report)
            })}><RefreshCw size={16} /> Run three-seed lab</button><button type="button" disabled={!trial} onClick={() => trial && void run(async () => setRobustness(await fetchRobustnessReport(trial.run.id)))}>Refresh report</button></div>
            {robustness && <><p className="disclaimer">{robustness.disclaimer}</p>{robustness.scenarioSensitivity.map((item) => <article className="decision-card" key={item.issueId}><strong>{item.issueId}</strong><span>{item.sensitive ? 'Sensitive to scenario' : 'Stable across completed variants'}</span><p>{Object.entries(item.outcomes).map(([outcome, count]) => `${outcome}: ${count}`).join(' · ') || 'Variants still running'}</p></article>)}</>}
          </div>
        )}
      </div>
    </section>
  )
}

function PreviewCard({ preview }: { preview: CorpusPreview }) {
  return <article className="preview-card"><SummaryGrid items={[["Files", String(preview.fileCount)], ["Size", formatBytes(preview.totalSize)], ["Duplicates", String(preview.duplicateCount)], ["Unsupported / locked", `${preview.unsupportedCount} / ${preview.encryptedCount}`]]} />{preview.warnings.map((warning) => <p key={warning}>{warning}</p>)}{preview.proposedExclusions.length > 0 && <p>Proposed exclusions: {preview.proposedExclusions.join(', ')}</p>}</article>
}

function CaseModelCard({ model }: { model: CaseModel }) {
  return <article className="case-model-card"><div><strong>{model.title}</strong><span className="status-pill">{model.status} · v{model.version}</span></div><p>{model.parties.map((party) => `${party.name} (${party.role})`).join(' vs ')}</p>{model.decisionIssues.map((issue) => <div key={issue.id}><strong>{issue.label}</strong><small>{issue.elements.map((element) => `${element.label} — ${element.burden}`).join('; ')}</small></div>)}{model.unresolved.map((item) => <small key={item}>Needs review: {item}</small>)}</article>
}

function RunStatus({ trial }: { trial: TrialRunView }) {
  return <article className="run-status"><div><strong>{trial.run.phase.replaceAll('_', ' ')}</strong><span className="status-pill">{trial.run.status}</span></div><progress max={12} value={Math.min(12, new Set(trial.events.map((event) => event.phase)).size)} /><small>{trial.events.length} ordered events recorded</small></article>
}

function SummaryGrid({ items }: { items: Array<[string, string]> }) {
  return <div className="summary-grid">{items.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Workflow request failed.'
}
