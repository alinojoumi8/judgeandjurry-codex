import { useCallback, useEffect, useRef, useState } from 'react'

import type { CaseMapCostPreview } from '../../../server/analysis/caseMapTypes'
import type { AnalysisJob } from '../../../server/analysis/jobTypes'
import { fetchAnalysisJob } from '../../api'
import type { ProviderStatus } from '../../types'

// Non-component parts the case-intelligence screens share: text helpers and the
// hook that previews a job's cost, starts it and follows it.

export const messageOf = (caught: unknown, fallback: string) => (caught instanceof Error ? caught.message : fallback)
// evidence id -> exhibit label (E-001). The server's passage references carry the
// evidence id only, so the label comes from the matter's document list.
export type ExhibitLookup = ReadonlyMap<string, string>

export const terminalJobStatuses = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'stopped_at_cap'])


export function shorten(text: string, length = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat
}


export interface GenerateState {
  preview: CaseMapCostPreview | null
  job: AnalysisJob | null
  needsExternalConfirmation: boolean
  externalConfirmed: boolean
  onPreview: () => void
  onCancelPreview: () => void
  onStart: () => void
  onExternalConfirmed: (confirmed: boolean) => void
  // Present only on a screen that offers the optional model check.
  modelCheck?: { checked: boolean; onChange: (checked: boolean) => void }
}

export interface GenerateCopy {
  subject: string
  idleLabel: string
  againLabel: string
  startLabel: string
  // The sentence that says what is read and where it goes. Ends before the estimate.
  reads: string
  noWork: string
  confirm: string
  working: string
  finished: string
  hasResult: boolean
}

type JobBody = { providerMode?: 'local' | 'external'; externalDisclosureConfirmed?: boolean } & Record<string, unknown>

// Previews the cost, starts the job the user confirmed, and follows it until it
// ends. `onFinished` reloads whatever the job saved.
export function useGenerateJob(options: {
  matterId: string
  provider: ProviderStatus | null
  preview: (body: JobBody) => Promise<CaseMapCostPreview>
  start: (body: JobBody & { estimateHash: string }) => Promise<AnalysisJob>
  onFinished: () => void | Promise<void>
  onError: (message: string) => void
  extraBody?: Record<string, unknown>
  // Offer the optional model check (off until the user ticks it).
  offerModelCheck?: boolean
}): { state: GenerateState; busy: boolean; running: boolean } {
  const { matterId, provider } = options
  const latest = useRef(options)
  useEffect(() => { latest.current = options })
  const [preview, setPreview] = useState<CaseMapCostPreview | null>(null)
  const [job, setJob] = useState<AnalysisJob | null>(null)
  const [externalConfirmed, setExternalConfirmed] = useState(false)
  const [modelCheck, setModelCheck] = useState(false)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setPreview(null); setJob(null) }, [matterId])

  // Follow a running job until it ends, then show what it saved.
  useEffect(() => {
    if (!job || terminalJobStatuses.has(job.status)) return
    const timer = window.setTimeout(() => {
      void fetchAnalysisJob(matterId, job.id).then((next) => {
        if (!alive.current) return
        setJob(next)
        if (terminalJobStatuses.has(next.status)) void latest.current.onFinished()
      }).catch((caught) => { if (alive.current) latest.current.onError(messageOf(caught, 'Could not check the run.')) })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [job, matterId])

  const disclosure = provider?.mode === 'external'
  const body = useCallback((checked = modelCheck): JobBody => ({
    ...(latest.current.extraBody ?? {}),
    ...(latest.current.offerModelCheck && checked ? { modelCheck: true } : {}),
    ...(disclosure ? { providerMode: 'external' as const, externalDisclosureConfirmed: externalConfirmed } : {}),
  }), [disclosure, externalConfirmed, modelCheck])

  const act = async (work: () => Promise<void>, failure: string) => {
    setBusy(true); latest.current.onError('')
    try { await work() } catch (caught) { if (alive.current) latest.current.onError(messageOf(caught, failure)) }
    finally { if (alive.current) setBusy(false) }
  }
  const running = job !== null && !terminalJobStatuses.has(job.status)
  return {
    busy, running,
    state: {
      preview, job, needsExternalConfirmation: disclosure, externalConfirmed,
      onPreview: () => void act(async () => { setPreview(await latest.current.preview(body())) }, 'Could not estimate the cost.'),
      onCancelPreview: () => setPreview(null),
      onStart: () => preview && void act(async () => {
        const started = await latest.current.start({ ...body(), estimateHash: preview.estimate.hash })
        setPreview(null); setJob(started)
      }, 'Could not start the run.'),
      onExternalConfirmed: setExternalConfirmed,
      ...(options.offerModelCheck ? {
        modelCheck: {
          checked: modelCheck,
          // A cost preview that is open is shown again with the checker calls added or taken away.
          onChange: (checked: boolean) => {
            setModelCheck(checked)
            if (preview) void act(async () => { setPreview(await latest.current.preview(body(checked))) }, 'Could not estimate the cost.')
          },
        },
      } : {}),
    },
  }
}
