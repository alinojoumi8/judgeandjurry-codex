import { useCallback, useEffect, useRef, useState } from 'react'

import type { AnalysisJob } from '../../../server/analysis/jobTypes'
import { formatCents } from '../../../server/damages/format'
import type { ConditionEffect, NumeracyInteraction } from '../../../server/forecast/damagesPsychology'
import { fetchAnalysisJob } from '../../api'
import type { ExportReport } from '../../types'
import { messageOf, terminalJobStatuses } from './analysisHelpers'

// Non-component parts the two damages screens share (kept apart from the components so fast refresh keeps working).

// Dollars from whole cents. The currency is stated once in each table's caption, so cells stay short.
export const money = (cents: number | null | undefined, _currency?: string): string => formatCents(cents)

// Percentile columns (10, 25, 50, 75, 90), in dollars.
export const percentileColumns = [10, 25, 50, 75, 90] as const

export function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function downloadReport(report: ExportReport, format: 'markdown' | 'html'): void {
  if (format === 'markdown') downloadText(report.filename, report.markdown, 'text/markdown;charset=utf-8')
  else downloadText(report.filename.replace(/\.md$/, '.html'), report.html, 'text/html;charset=utf-8')
}

export function jobProgressText(job: AnalysisJob, unit: string, total: number, perRun: number): string {
  const done = perRun > 0 ? Math.min(total, Math.floor(job.usage.calls / perRun)) : 0
  if (job.status === 'queued') return 'Waiting to start…'
  if (job.status === 'running') return `Running simulated panels one at a time: ${done} of ${total} ${unit} finished (${job.usage.calls} of about ${job.estimate.calls} model calls counted).`
  if (job.status === 'succeeded') return `Finished: ${total} ${unit}, ${job.usage.calls} model calls counted. The result below is a new draft.`
  if (job.status === 'stopped_at_cap') return `Stopped at the cap of ${job.cap.maxCalls} calls. What finished is kept in the draft below. Nothing runs past the cap.`
  return `The study ${job.status.replace('_', ' ')}${job.error ? `: ${job.error}` : '.'} Runs that finished are kept and are not repeated if the study is started again with the same seed.`
}

// Loads, follows a running job and runs the actions of a study screen. `load` reloads whatever the job saved.
export function useStudyJob(options: { matterId: string; load: () => Promise<void> }) {
  const { matterId } = options
  const [job, setJob] = useState<AnalysisJob | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const latest = useRef(options.load)
  useEffect(() => { latest.current = options.load })
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setJob(null); setNotice('') }, [matterId])

  useEffect(() => {
    if (!job || terminalJobStatuses.has(job.status)) return
    const timer = window.setTimeout(() => {
      void fetchAnalysisJob(matterId, job.id).then((next) => {
        if (!alive.current) return
        setJob(next)
        if (terminalJobStatuses.has(next.status)) void latest.current()
      }).catch((caught) => { if (alive.current) setError(messageOf(caught, 'Could not check the study.')) })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [job, matterId])

  const act = useCallback(async (work: () => Promise<void>, failure: string) => {
    setBusy(true); setError('')
    try { await work() } catch (caught) { if (alive.current) setError(messageOf(caught, failure)) }
    finally { if (alive.current) setBusy(false) }
  }, [])
  const running = job !== null && !terminalJobStatuses.has(job.status)
  return { job, setJob, error, setError, notice, setNotice, busy, act, running }
}

export const effectText = (effect: ConditionEffect, currency: string): string => {
  if (effect.classification === 'insufficient data') return `Insufficient data (${effect.pairs} paired seed${effect.pairs === 1 ? '' : 's'})`
  if (effect.classification === 'no reliable effect') return 'No reliable effect'
  return `A reliable ${effect.direction === 'increase' ? 'increase' : 'decrease'} of ${money(Math.round(Math.abs(effect.meanDifferenceCents ?? 0)), currency)} on average`
}

export const numeracyText = (numeracy: NumeracyInteraction): string => {
  if (numeracy.classification === 'insufficient data') return 'Insufficient data'
  if (numeracy.classification === 'no reliable effect') return 'No reliable difference'
  return (numeracy.interactionCents ?? 0) > 0 ? 'The effect is larger for higher-numeracy jurors' : 'The effect is larger for lower-numeracy jurors'
}
