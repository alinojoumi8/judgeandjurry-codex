import { Check, ChevronRight, FileArchive, FolderOpen, Gavel, Loader2, Play, RefreshCw, Scale, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ProviderStatus } from '../types'
import { AdmissionEditor, CaseModelEditor, RecordCoverage } from './WorkflowEditors'
import { GroundingAudit } from './GroundingAudit'
import { ParticipantMemoryPanel } from './ParticipantMemoryPanel'
import { LegalReadinessPanel } from './LegalReadinessPanel'
import { CourtroomPanel } from './CourtroomPanel'
import { DecisionTracePanel, ScenarioComparisonPanel } from './EvidenceDecisionWorkspace'
import { PartialTrialResults } from './PartialTrialResults'
import { canResumeTrial, trialRunStatus } from '../trialRunStatus'

import {
  analyzeDisclosure,
  approveCaseModel,
  approveMotion,
  approveTrialCheckpoint,
  confirmCorpusPreview,
  createRobustnessVariants,
  createTrialRun,
  preflightTrialRun,
  draftCaseModel,
  draftMotionDocket,
  fetchAdmissionLedgers,
  fetchCorpusJob,
  fetchRobustnessReport,
  fetchTrialRun,
  fetchWorkflowState,
  fetchTheoryBriefs,
  saveCaseModelVersion,
  saveAdmissionLedger,
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
  TrialRun,
  WorkflowSource,
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
  provider: ProviderStatus | null
}

export function FullWorkflowWorkspace({ matterId, matterTitle, onEvidenceImported, provider }: Props) {
  const [step, setStep] = useState(() => storedStep(matterId))
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
  const [runs, setRuns] = useState<TrialRun[]>([])
  const [sources, setSources] = useState<WorkflowSource[]>([])
  const [restoring, setRestoring] = useState(true)
  const [useWitnesses, setUseWitnesses] = useState(false)
  const [courtroomProtocol, setCourtroomProtocol] = useState(false)
  const [robustness, setRobustness] = useState<RobustnessReport | null>(null)
  const [variantLedgerId, setVariantLedgerId] = useState('')
  const [externalConfirmed, setExternalConfirmed] = useState(false)
  const [reviewMotions, setReviewMotions] = useState(false)
  const [reviewInstructions, setReviewInstructions] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sourceSize, setSourceSize] = useState<Awaited<ReturnType<typeof preflightTrialRun>> | null>(null)
  const settingsLedger = ledgers.find((ledger) => !ledger.trialRunId)
  const latestLedgerId = settingsLedger?.id

  useEffect(() => { setSourceSize(null) }, [caseModel?.id, latestLedgerId, adapter, civilDecisionMaker, useWitnesses, courtroomProtocol])

  useEffect(() => { localStorage.setItem(`workflow:${matterId}:step`, String(step)) }, [matterId, step])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const saved = await fetchWorkflowState(matterId)
      const selection = localStorage.getItem(`workflow:${matterId}:run`)
      const selected = selection === 'setup' ? undefined : saved.trials.find((item) => item.id === selection) ?? saved.trials[0]
      const restored = selected ? await fetchTrialRun(selected.id) : null
      const model = (selected ? saved.models.find((item) => item.id === selected.caseModelId) : saved.models[0]) ?? null
      const briefs = model ? await fetchTheoryBriefs(model.id) : []
      const latestJob = saved.jobs[0] ? await fetchCorpusJob(saved.jobs[0].id) : null
      if (cancelled) return
      setRuns(saved.trials); setTrial(restored); setSources(saved.evidence)
      setCaseModel(model); setTheories(briefs); setTheoryText(Object.fromEntries(briefs.map((brief) => [brief.partyId, brief.narrative])))
      setLedgers(saved.ledgers); setMotions(saved.motions); setFindings(saved.findings)
      setJob(latestJob?.job ?? null); setManifest(latestJob?.manifest ?? [])
      setExternalConfirmed(restored?.run.config.externalDisclosureConfirmed ?? saved.jobs[0]?.externalDisclosureConfirmed ?? false)
      setAdapter(restored?.run.procedureAdapter ?? model?.procedureAdapter ?? 'ontario_criminal_jury_v1')
      setCivilDecisionMaker(restored?.run.config.civilDecisionMaker ?? 'judge_alone')
      if (selected) localStorage.setItem(`workflow:${matterId}:run`, selected.id)
    })().catch((caught: unknown) => { if (!cancelled) setError(message(caught)) }).finally(() => { if (!cancelled) setRestoring(false) })
    return () => { cancelled = true }
  }, [matterId])

  useEffect(() => {
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return
    const interval = window.setInterval(() => {
      void fetchCorpusJob(job.id).then((result) => {
        setJob(result.job)
        setManifest(result.manifest)
          if (result.job.status === 'completed') {
            void onEvidenceImported()
            void fetchWorkflowState(matterId).then((saved) => setSources(saved.evidence))
          }
      }).catch((caught: unknown) => setError(message(caught)))
    }, 900)
    return () => window.clearInterval(interval)
    }, [job, onEvidenceImported, matterId])

  useEffect(() => {
    if (!trial || !['running', 'ready'].includes(trial.run.status)) return
    let cancelled = false
    const interval = window.setInterval(() => {
      void fetchTrialRun(trial.run.id).then((updated) => {
        if (cancelled) return
        setTrial(updated)
        setRuns((current) => current.map((item) => item.id === updated.run.id ? updated.run : item))
      }).catch((caught: unknown) => { if (!cancelled) setError(message(caught)) })
    }, 1_000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [trial])

  useEffect(() => {
    if (step !== 6) return
    void fetchAdmissionLedgers(matterId).then(setLedgers).catch((caught: unknown) => setError(message(caught)))
  }, [matterId, step, motions])

  useEffect(() => {
    setRobustness(null); setVariantLedgerId('')
  }, [trial?.run.id])

  useEffect(() => {
    if (step !== 10 || !trial?.run.id) return
    let cancelled = false
    void fetchRobustnessReport(trial.run.parentRunId ?? trial.run.id).then((report) => { if (!cancelled) setRobustness(report) }).catch((caught) => { if (!cancelled) setError(message(caught)) })
    return () => { cancelled = true }
  }, [step, trial?.run.id, trial?.run.parentRunId])

  const estimate = useMemo(() => {
    const files = preview?.fileCount ?? manifest.length
    const issues = Math.max(1, caseModel?.decisionIssues.length ?? 1)
    const panel = adapter === 'ontario_criminal_jury_v1' ? 12 : adapter === 'ontario_capital_markets_v1' ? 3 : civilDecisionMaker === 'jury' ? 6 : 1
    const calls = caseModel
      ? panel * issues * 2 + panel * 3 + caseModel.parties.length * 2 + motions.filter((motion) => motion.status === 'approved').length * 3
      : 0
      return { files, calls: calls * 2, minutes: calls ? `${Math.max(2, Math.ceil(calls / 3))}–${Math.max(5, Math.ceil(calls))}` : 'not yet available' }
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
    if (result.job.status === 'completed') {
      setSources((await fetchWorkflowState(matterId)).evidence)
      await onEvidenceImported()
    }
  }

  const openSavedRun = async (runId: string) => {
    const saved = await fetchWorkflowState(matterId)
    const restored = await fetchTrialRun(runId)
    const model = saved.models.find((item) => item.id === restored.run.caseModelId) ?? null
    const briefs = model ? await fetchTheoryBriefs(model.id) : []
    setTrial(restored); setCaseModel(model); setRuns(saved.trials); setLedgers(saved.ledgers); setSources(saved.evidence)
    setAdapter(restored.run.procedureAdapter); setExternalConfirmed(restored.run.config.externalDisclosureConfirmed)
    setCivilDecisionMaker(restored.run.config.civilDecisionMaker ?? 'judge_alone')
    setTheories(briefs); setTheoryText(Object.fromEntries(briefs.map((brief) => [brief.partyId, brief.narrative])))
    localStorage.setItem(`workflow:${matterId}:run`, runId)
    setStep(restored.decisionSheet ? 8 : 7)
  }

  const newTrialConfig = (): TrialRunConfig => ({
      courtroomProtocol: courtroomProtocol ? 'courtroom_v1' : undefined,
      mode: 'full', procedureAdapter: adapter, seed: crypto.randomUUID(),
      checkpointPolicy: {
        default: 'autonomous',
        approvalPhases: [reviewMotions ? 'motions' : '', reviewInstructions ? 'instructions' : ''].filter(Boolean),
        allowCounselTakeover: true,
      },

        witnessPlan: useWitnesses && caseModel ? caseModel.witnesses.map((witness, index) => ({
          witnessId: witness.id, calledByPartyId: witness.calledByPartyId ?? caseModel.parties[0]?.id ?? 'user', order: index,
        })) : [],
      deliberation: { maxRounds: 3, concurrency: 4 },
      civilDecisionMaker: adapter === 'ontario_civil_v1' ? civilDecisionMaker : undefined,
      externalDisclosureConfirmed: externalConfirmed,
    })
  const checkSourceSize = async (config = newTrialConfig()) => {
    if (!caseModel || !settingsLedger) throw new Error('Save the model and document-use settings first.')
    const result = await preflightTrialRun(matterId, caseModel.id, config, settingsLedger.id)
    setSourceSize(result)
    return result
  }
  const createAndStartTrial = async () => {
    if (!caseModel || caseModel.status !== 'approved') throw new Error('Approve the neutral case model first.')
    if (!settingsLedger) throw new Error('Save the document-use settings before starting a proceeding.')
    const config = newTrialConfig()
    const preflight = await checkSourceSize(config)
    if (!preflight.fits) throw new Error(preflight.message)
    const created = await createTrialRun(matterId, caseModel.id, config, settingsLedger.id)
    localStorage.setItem(`workflow:${matterId}:run`, created.run.id)
    setRuns((current) => [created.run, ...current])
    setTrial(await startAutonomousTrial(created.run.id))
  }

  const displayedConfig = trial?.run.config
  const displayedProvider = displayedConfig?.provider ?? provider
  const displayedAdapter = trial?.run.procedureAdapter ?? adapter
  const panel = displayedAdapter === 'ontario_criminal_jury_v1' ? '12 jurors' : displayedAdapter === 'ontario_capital_markets_v1' ? '3 adjudicators' : (displayedConfig?.civilDecisionMaker ?? civilDecisionMaker) === 'jury' ? '6 jurors' : 'Judge alone'
  const consent = displayedConfig?.externalDisclosureConfirmed ?? externalConfirmed
  const activeLedger = trial ? ledgers.find((ledger) => ledger.id === trial.run.admissionLedgerId) : settingsLedger

  if (restoring) return <section className="workflow-restoring" aria-live="polite">Restoring saved proceeding…</section>

  return (
    <>
      <section className={`provider-banner provider-banner--${displayedProvider?.mode ?? 'local'}`} aria-label="Provider and privacy status">
        <div className="provider-banner__status"><Scale size={18} /><div><strong>{displayedProvider?.mode === 'external' ? 'External provider mode' : 'Local provider mode'}</strong><span>{displayedProvider ? `${displayedProvider.model} via ${displayedProvider.name}` : 'Loading provider details'}</span></div></div>
        <div className="provider-banner__meta"><span>{panel}</span><span>Full proceeding</span><span>{trial ? trialRunStatus(trial).label : 'Setup'}</span>{displayedProvider?.mode === 'external' && <span className={consent ? 'safe' : 'risk'}>{consent ? 'Disclosure confirmed' : 'Needs confirmation'}</span>}</div>
        <button type="button" onClick={() => setStep(7)}>Run settings</button>
      </section>
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
          {runs.length > 0 && <label className="saved-proceeding">Saved proceeding<select aria-label="Saved proceeding" value={trial?.run.id ?? ''} disabled={busy} onChange={(event) => void run(() => openSavedRun(event.target.value))}><option value="" disabled>Select a proceeding</option>{runs.map((item) => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {trial?.run.id === item.id ? trialRunStatus(trial).label : item.status} · {item.id.slice(0, 8)}</option>)}</select></label>}

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
            <button type="button" onClick={() => void run(async () => {
              const drafted = await draftCaseModel(
              matterId,
              adapter,
              adapter === 'ontario_civil_v1' && civilDecisionMaker === 'jury'
                ? { juryNotice: { valid: civilJuryNoticeConfirmed, note: civilJuryNoticeConfirmed ? 'User manually confirmed a valid jury notice for this simulation.' : 'A valid jury notice has not been confirmed.', sourceRefs: [{ attribution: civilJuryNoticeConfirmed ? 'manual' : 'unresolved' }] } }
                : undefined,
              )
              setCaseModel(drafted); setTrial(null); setTheories([]); setTheoryText({})
              localStorage.setItem(`workflow:${matterId}:run`, 'setup')
            })}>Draft neutral case model</button>
            {caseModel && <CaseModelCard model={caseModel} />}
              {caseModel && <details className="workflow-edit-details"><summary>Edit parties, counts and source coverage</summary><CaseModelEditor key={caseModel.id} model={caseModel} sources={sources} busy={busy} onSave={(next) => run(async () => {
                const revised = await saveCaseModelVersion(caseModel.id, next)
                setCaseModel(revised); setTrial(null)
                localStorage.setItem(`workflow:${matterId}:run`, 'setup')
                const briefs = await fetchTheoryBriefs(revised.id)
                setTheories(briefs); setTheoryText(Object.fromEntries(briefs.map((brief) => [brief.partyId, brief.narrative])))
              })} /></details>}
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
            <div className="workflow-stack"><p>Excluded, reserved, and role-hidden material is filtered before each actor call. Saving new settings preserves earlier versions.</p>{activeLedger && <div className="notice-card"><strong>Admission ledger v{activeLedger.version}</strong><span>{activeLedger.reason}</span></div>}<RecordCoverage scope={trial?.recordCoverage?.scope ?? caseModel?.recordScope} sources={trial?.recordCoverage?.sources ?? sources} ledger={activeLedger} warnings={trial?.recordCoverage?.warnings} /><AdmissionEditor key={`${settingsLedger?.id ?? 'new'}:${sources.length}`} sources={sources} ledger={settingsLedger} busy={busy} onSave={(evidenceUses, reason) => run(async () => {
              const saved = await saveAdmissionLedger(matterId, { parentVersionId: settingsLedger?.id, reason, evidenceUses })
              setLedgers((current) => [saved, ...current])
            })} /></div>
        )}

        {step === 7 && (
          <div className="workflow-stack">
            {caseModel && adapter === 'ontario_criminal_jury_v1' && <><LegalReadinessPanel model={caseModel} onSaved={setCaseModel} /><label className="workflow-check"><input type="checkbox" checked={courtroomProtocol} onChange={e => setCourtroomProtocol(e.target.checked)} /> Use the reviewed courtroom protocol (requires packet readiness; review remains pending).</label></>}
            <SummaryGrid items={[["Files", String(estimate.files)], ["Estimated calls before retries", String(estimate.calls)], ["Estimated runtime", `${estimate.minutes} minutes`], ["External disclosure", externalConfirmed ? 'Confirmed' : 'Not confirmed']]} />
            <small>Repairs and provider retries add calls and time. A declared run limit can stop the proceeding before a complete decision.</small>
              <label className="workflow-check"><input type="checkbox" checked={externalConfirmed} onChange={(event) => setExternalConfirmed(event.target.checked)} /> I confirm the permitted sources may be disclosed to the configured external model for a new run.</label>
              <label className="workflow-check"><input type="checkbox" checked={useWitnesses} onChange={(event) => setUseWitnesses(event.target.checked)} /> Include source-bound witness examinations from the approved model.</label>
              <RecordCoverage scope={caseModel?.recordScope} sources={sources} ledger={settingsLedger} />
              {!settingsLedger && <p role="status">Save document-use settings in Admitted Record before starting.</p>}
            <label className="workflow-check"><input type="checkbox" checked={reviewMotions} onChange={(event) => setReviewMotions(event.target.checked)} /> Pause for review after motion rulings.</label>
            {adapter !== 'ontario_capital_markets_v1' && <label className="workflow-check"><input type="checkbox" checked={reviewInstructions} onChange={(event) => setReviewInstructions(event.target.checked)} /> Pause for review after judicial instructions.</label>}
            <p className="disclaimer">Synthetic panels are not statistically representative and do not predict real verdicts. This workflow is for preparation and stress testing.</p>
            <button type="button" disabled={busy || !caseModel || !settingsLedger} onClick={() => void run(async () => { await checkSourceSize() })}>Check source size</button>
            {sourceSize && <div className="notice-card" role="status"><strong>{sourceSize.historyReserveCharacters === undefined ? 'Selected source context' : 'Projected context'}: {sourceSize.characters.toLocaleString()} / {sourceSize.characterBudget.toLocaleString()} characters</strong><p>{sourceSize.message}</p>{sourceSize.sourceCharacters !== undefined && sourceSize.historyReserveCharacters !== undefined && sourceSize.headroomCharacters !== undefined ? <small>Sources: {sourceSize.sourceCharacters.toLocaleString()} · planned history reserve: {sourceSize.historyReserveCharacters.toLocaleString()} · estimated headroom: {sourceSize.headroomCharacters.toLocaleString()} characters. Actual actor context is checked before each request.</small> : <small>History projection is unavailable from this server response. Actual actor context is checked before each request.</small>}<small>Largest source contributions: {sourceSize.sources.slice(0, 5).map(source => `${source.exhibitId}: ${source.characters.toLocaleString()}`).join(' · ')}</small>{!sourceSize.fits && <button type="button" onClick={() => setStep(6)}>Choose documents and paragraphs</button>}</div>}
              <button className="primary-action" type="button" disabled={busy || !caseModel || caseModel.status !== 'approved' || !settingsLedger || trial?.run.status === 'running'} onClick={() => void run(createAndStartTrial)}><Play size={16} /> Create and run full proceeding</button>
            {trial && <RunStatus trial={trial} />}
            {trial?.run.config.courtroomProtocol && caseModel && <CourtroomPanel trial={trial} model={caseModel} sources={sources} motions={motions} onChanged={setTrial} />}
            {trial && canResumeTrial(trial) && <button type="button" disabled={busy} onClick={() => void run(async () => setTrial(await startAutonomousTrial(trial.run.id)))}><Play size={16} /> Resume saved proceeding</button>}
            {trial?.run.status === 'checkpoint' && <button type="button" onClick={() => void run(async () => {
              await approveTrialCheckpoint(trial.run.id, 'Approved in guided workspace.')
              setTrial(await startAutonomousTrial(trial.run.id))
            })}><Check size={16} /> Approve checkpoint and continue</button>}
          </div>
        )}

        {trial && [8, 9].includes(step) && <RunStatus trial={trial} />}
        {trial && [7, 8, 9].includes(step) && !['ready', 'running', 'checkpoint'].includes(trial.run.status) && <PartialTrialResults trial={trial} issueLabels={Object.fromEntries(caseModel?.decisionIssues.map(issue => [issue.id, issue.label]) ?? [])} />}

        {step === 8 && (
              <div className="workflow-stack">{trial && trialRunStatus(trial).message && <p role="status">{trialRunStatus(trial).message}</p>}{trial?.decisionSheet ? <>{trial.decisionSheet.decisions.map((decision) => <article className="decision-card" key={decision.issueId}><span>{caseModel?.decisionIssues.find((issue) => issue.id === decision.issueId)?.label ?? decision.issueId}</span><strong>{decision.outcome.replaceAll('_', ' ')}</strong><p>Required decision rule: {decision.rule}{decision.voteCounts ? ` · ${Object.entries(decision.voteCounts).map(([choice, count]) => `${choice}: ${count}`).join(', ')}` : ''}</p><p>Valid final ballots: {trial.ballots.filter(ballot => ballot.round === 'final' && ballot.valid && ballot.issueId === decision.issueId).length}</p>{decision.warnings.map((warning) => <small key={warning}>{warning}</small>)}<DecisionTracePanel matterId={matterId} trace={decision.trace} /></article>)}<RecordCoverage scope={trial?.recordCoverage?.scope ?? caseModel?.recordScope} sources={trial?.recordCoverage?.sources ?? sources} ledger={activeLedger} warnings={trial?.recordCoverage?.warnings} /></> : <p>No decision sheet yet.</p>}</div>
        )}

            {(step === 8 || step === 9) && <GroundingAudit trial={trial} matterId={matterId} />}
            {trial && (step === 7 || step === 9) && <ParticipantMemoryPanel runId={trial.run.id} actors={(trial.events.find(e => e.type === 'run_created')?.payload.actors ?? []) as Array<{ id: string; role: string }>} />}
          {step === 9 && (
          <div className="workflow-stack"><SummaryGrid items={[["Events", String(trial?.events.length ?? 0)], ["Juror profiles", String(trial?.jurorProfiles.length ?? 0)], ["Initial ballots", String(trial?.ballots.filter((ballot) => ballot.round === 'initial').length ?? 0)], ["Final ballots", String(trial?.ballots.filter((ballot) => ballot.round === 'final').length ?? 0)]]} /><div className="event-audit">{trial?.events.map((event) => <div key={event.id}><span>#{event.sequence}</span><strong>{event.type.replaceAll('_', ' ')}</strong><small>{event.actorId ?? 'system'} · {event.phase}</small></div>)}</div></div>
        )}

        {step === 10 && (
          <div className="workflow-stack">
              <p>Repeat the approved scenario across stored seeds and compare its document-use assumptions.</p>
              <label>Variant document-use settings<select value={variantLedgerId} onChange={(event) => setVariantLedgerId(event.target.value)}><option value="">Reuse baseline starting record</option>{ledgers.map((ledger) => <option key={ledger.id} value={ledger.id}>Version {ledger.version} · {ledger.reason}</option>)}</select></label>
            <div className="workflow-row"><button type="button" disabled={!trial} onClick={() => trial && void run(async () => {
                const created = await createRobustnessVariants(trial.run.id, ['robust-a', 'robust-b', 'robust-c'], variantLedgerId ? [variantLedgerId] : undefined)
              setRobustness(created.report)
              })}><RefreshCw size={16} /> Run three-seed lab</button><button type="button" disabled={!trial} onClick={() => trial && void run(async () => setRobustness(await fetchRobustnessReport(trial.run.parentRunId ?? trial.run.id)))}>Refresh report</button></div>
              {robustness && <><p className="disclaimer">{robustness.disclaimer}</p>{robustness.scenarioSensitivity.map((item) => <article className="decision-card" key={item.issueId}><strong>{caseModel?.decisionIssues.find((issue) => issue.id === item.issueId)?.label ?? item.issueId}</strong><span>{robustness.completeRuns < 2 ? 'More completed variants needed' : item.sensitive ? 'Sensitive to scenario' : 'Stable across completed variants'}</span><p>{Object.entries(item.outcomes).map(([outcome, count]) => `${outcome}: ${count}`).join(' · ') || 'Variants still running'}</p></article>)}<ScenarioComparisonPanel report={robustness} model={caseModel} onOpenRun={(id) => void run(() => openSavedRun(id))} />{robustness.recurringProofGaps.length > 0 && <div><h3>Recurring warnings</h3><ul>{robustness.recurringProofGaps.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}</>}
          </div>
        )}
      </div>
    </section>
    </>
  )
}

function storedStep(matterId: string): number {
  const value = Number(localStorage.getItem(`workflow:${matterId}:step`) ?? 0)
  return Number.isInteger(value) && value >= 0 && value < steps.length ? value : 0
}

function PreviewCard({ preview }: { preview: CorpusPreview }) {
  return <article className="preview-card"><SummaryGrid items={[["Files", String(preview.fileCount)], ["Size", formatBytes(preview.totalSize)], ["Duplicates", String(preview.duplicateCount)], ["Unsupported / locked", `${preview.unsupportedCount} / ${preview.encryptedCount}`]]} />{preview.warnings.map((warning) => <p key={warning}>{warning}</p>)}{preview.proposedExclusions.length > 0 && <p>Proposed exclusions: {preview.proposedExclusions.join(', ')}</p>}</article>
}

function CaseModelCard({ model }: { model: CaseModel }) {
  return <article className="case-model-card"><div><strong>{model.title}</strong><span className="status-pill">{model.status} · v{model.version}</span></div><p>{model.parties.map((party) => `${party.name} (${party.role})`).join(' vs ')}</p>{model.decisionIssues.map((issue) => <div key={issue.id}><strong>{issue.label}</strong><small>{issue.elements.map((element) => `${element.label} — ${element.burden}`).join('; ')}</small></div>)}{model.unresolved.map((item) => <small key={item}>Needs review: {item}</small>)}</article>
}

function RunStatus({ trial }: { trial: TrialRunView }) {
  const status = trialRunStatus(trial)
  return <article className="run-status"><div><strong>{trial.run.phase.replaceAll('_', ' ')}</strong><span className="status-pill">{status.label}</span></div>{status.message && <p role="status">{status.message}</p>}<progress aria-label="Recorded proceeding phases" max={12} value={Math.min(12, new Set(trial.events.map((event) => event.phase)).size)} /><small>{trial.events.length} ordered events recorded</small></article>
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
