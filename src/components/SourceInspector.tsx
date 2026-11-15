import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Copy, Download, X } from 'lucide-react'
import { downloadEvidenceSource, fetchOriginalSource, fetchSourcePassages } from '../api'
import type { SourceDocument, TraceReference } from '../../server/trialEngineTypes'

import { SourceContext } from '../sourceInspectorContext'

export function SourceInspectorProvider({ matterId, scope, children }: { matterId: string; scope: string; children: ReactNode }) {
  const [selection, setSelection] = useState<{ source: TraceReference; trigger: HTMLButtonElement } | null>(null)
  const returnFocus = useRef<HTMLButtonElement | null>(null)
  const close = () => {
    returnFocus.current = selection?.trigger ?? null
    setSelection(null)
  }
  useEffect(() => {
    if (selection || !returnFocus.current) return
    if (returnFocus.current.isConnected) returnFocus.current.focus()
    returnFocus.current = null
  }, [selection])
  useEffect(() => { setSelection(null) }, [matterId, scope])
  return <SourceContext.Provider value={(source, trigger) => setSelection({ source, trigger })}>
    <div className={`case-content-layout${selection ? ' has-source' : ''}`}>
      <div className="case-content-main">{children}</div>
      {selection && <SourceInspector key={`${selection.source.evidenceId}:${JSON.stringify(selection.source.locator)}`} matterId={matterId} source={selection.source} onClose={close} />}
    </div>
  </SourceContext.Provider>
}

export function SourceInspector({ matterId, source, onClose }: { matterId: string; source: TraceReference; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const target = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [record, setRecord] = useState<SourceDocument | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [tab, setTab] = useState<'original' | 'text'>('text')
  const [originalUrl, setOriginalUrl] = useState('')
  const [originalError, setOriginalError] = useState('')
  const [copied, setCopied] = useState(false)
  const selectedParagraph = Number(source.locator?.paragraph)
  const targetPage = record?.passages.find(part => part.paragraph === selectedParagraph)?.page

  useEffect(() => {
    const element = dialog.current!
    const media = window.matchMedia('(max-width: 900px)')
    const show = () => {
      if (element.open) element.close()
      if (media.matches) element.showModal()
      else element.show()
      element.querySelector<HTMLButtonElement>('.source-close')?.focus()
    }
    show()
    media.addEventListener('change', show)
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !media.matches && element.open) { event.preventDefault(); closeRef.current() }
    }
    element.addEventListener('keydown', escape)
    return () => { media.removeEventListener('change', show); element.removeEventListener('keydown', escape); element.close() }
  }, [])

  useEffect(() => {
    let cancelled = false
    setError(''); setRecord(null)
    if (!source.evidenceId) { setError('This reference has no preserved document identifier.'); return }
    void fetchSourcePassages(matterId, source.evidenceId).then(value => {
      if (!cancelled) setRecord(value)
    }).catch(caught => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'Unable to load this source.') })
    return () => { cancelled = true }
  }, [matterId, source.evidenceId, retry])

  useEffect(() => {
    if (tab === 'text') target.current?.scrollIntoView({ block: 'nearest' })
  }, [record, tab])

  useEffect(() => {
    if (tab !== 'original' || !record?.sourceAvailable || record.mimeType !== 'application/pdf') return
    let cancelled = false
    let url = ''
    setOriginalError(''); setOriginalUrl('')
    void fetchOriginalSource(record.evidenceId).then(blob => {
      if (cancelled) return
      url = URL.createObjectURL(blob)
      setOriginalUrl(url)
    }).catch(caught => { if (!cancelled) setOriginalError(caught instanceof Error ? caught.message : 'Unable to load the original.') })
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [record, tab])

  const citation = [record?.exhibitId ?? source.exhibitId, record?.name ?? source.name,
    targetPage ? `PDF page ${targetPage}` : '', Number.isInteger(selectedParagraph) && selectedParagraph > 0 ? `extracted paragraph ${selectedParagraph}` : '',
  ].filter(Boolean).join(' · ')

  return <dialog ref={dialog} className="case-source-inspector" aria-label="Source behind this reason" onCancel={event => { event.preventDefault(); onClose() }}>
    <header><h2>Source behind this reason</h2><button className="source-close" type="button" aria-label="Close source" onClick={onClose}><X size={20} /></button></header>
    <button className="source-back" type="button" onClick={onClose}><ArrowLeft size={16} /> Back to reason</button>
    {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry source</button></div> : !record ? <p role="status">Loading preserved source…</p> : <>
      <h3>{record.exhibitId} · {record.name}</h3>
      <p className="case-muted">{citation || 'No exact locator was saved.'}</p>
      {source.warning && <p className="case-warning">{source.warning}</p>}
      <div className="source-view-switch" aria-label="Source view">
        <button type="button" aria-pressed={tab === 'text'} onClick={() => setTab('text')}>Extracted text</button>
        <button type="button" aria-pressed={tab === 'original'} onClick={() => setTab('original')}>Original document</button>
      </div>
      {record.extractionWarning && <p className="case-warning">{record.extractionWarning}</p>}
      {tab === 'text' ? <div className="source-passages" aria-label="Extracted passages">
        {source.quote && <details><summary>Passage saved with this reference</summary><blockquote>{source.quote}</blockquote></details>}
        {record.passages.map(part => <article key={part.paragraph} ref={part.paragraph === selectedParagraph ? target : undefined} className={part.paragraph === selectedParagraph ? 'selected-passage' : ''}>
          <strong>Paragraph {part.paragraph}{part.page ? ` · PDF page ${part.page}` : ''}</strong><p>{part.text}</p>
        </article>)}
        {!record.passages.length && <p>No extracted text is available. Download the preserved original to review it.</p>}
      </div> : <div className="source-original">
        {record.mimeType === 'application/pdf' && record.sourceAvailable ? <>
          {!targetPage && <p>No verified PDF page mapping is available. The original opens at its beginning.</p>}
          {originalError ? <p role="alert">{originalError} You can download the original below.</p> : originalUrl ? <iframe title="Preserved original PDF" src={`${originalUrl}${targetPage ? `#page=${targetPage}` : ''}`} /> : <p role="status">Loading original…</p>}
        </> : <p>{record.sourceAvailable ? 'Download this document to open it in its original format.' : 'No preserved original is available for this reference.'}</p>}
      </div>}
      <section className="source-use-summary"><h3>How this is used</h3>
        <p>A source reference identifies material used in a recorded explanation. It does not establish that the document’s assertions are true.</p>
        {source.use && <p>Saved run use: {source.use.status}. {source.use.purposes.join('; ')} {source.use.note}{source.use.hiddenFrom.length ? ` Hidden from: ${source.use.hiddenFrom.join(', ')}.` : ''}</p>}
        {source.use?.status === 'redacted' && <p>You are inspecting the preserved original, before the saved run’s redactions.</p>}
      </section>
      <div className="source-actions">
        <button type="button" disabled={!record.sourceAvailable} onClick={() => void downloadEvidenceSource(record.evidenceId, record.name).catch(caught => setOriginalError(caught instanceof Error ? caught.message : 'Download failed.'))}><Download size={16} /> Download preserved original</button>
        <button type="button" disabled={!citation} onClick={() => void navigator.clipboard.writeText(citation).then(() => setCopied(true)).catch(() => setOriginalError('Could not copy the citation. Select and copy the citation text above.'))}><Copy size={16} /> {copied ? 'Copied citation' : 'Copy citation'}</button>
      </div>
      {originalError && tab !== 'original' && <p role="alert">{originalError}</p>}
      <details className="source-provenance"><summary>Source details</summary><p>Extraction: {record.ingestionStatus}</p><p className="source-hash">Original SHA-256: {record.sha256 ?? 'No preserved hash recorded'}</p></details>
    </>}
  </dialog>
}
