import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { fetchOriginalSource } from '../api'

export function PreservedPdfViewer({ evidenceId, initialPage }: { evidenceId: string; initialPage?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(initialPage ?? 1)
  const [zoom, setZoom] = useState(1.25)
  const [error, setError] = useState('')
  const [rendering, setRendering] = useState(true)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    let task: PDFDocumentLoadingTask | undefined
    setDocument(null); setError(''); setRendering(true)
    void (async () => {
      const [blob, pdf] = await Promise.all([fetchOriginalSource(evidenceId), import('pdfjs-dist')])
      const data = new Uint8Array(await blob.arrayBuffer())
      if (cancelled) return
      pdf.GlobalWorkerOptions.workerSrc = workerUrl
      task = pdf.getDocument({ data, isEvalSupported: false, enableXfa: false })
      const loaded = await task.promise
      if (cancelled) return
      const requested = initialPage ?? 1
      if (!Number.isInteger(requested) || requested < 1 || requested > loaded.numPages) throw new Error('The saved PDF page is outside this original document.')
      setPage(requested); setDocument(loaded)
    })().catch(caught => { if (!cancelled) { setError(caught instanceof Error ? caught.message : 'Unable to open this PDF.'); setRendering(false) } })
    return () => { cancelled = true; void task?.destroy().catch(() => {}) }
  }, [evidenceId, initialPage, retry])

  useEffect(() => {
    if (!document) return
    let cancelled = false
    let task: RenderTask | undefined
    setRendering(true); setError('')
    void document.getPage(page).then(async original => {
      if (cancelled || !canvas.current) return
      const viewport = original.getViewport({ scale: zoom })
      canvas.current.width = Math.ceil(viewport.width)
      canvas.current.height = Math.ceil(viewport.height)
      task = original.render({ canvas: canvas.current, viewport })
      await task.promise
      if (!cancelled) setRendering(false)
    }).catch(caught => {
      if (!cancelled) { setError(caught instanceof Error ? caught.message : 'Unable to render this page.'); setRendering(false) }
    })
    return () => { cancelled = true; task?.cancel() }
  }, [document, page, zoom])

  return <section aria-label="Preserved original PDF" className="preserved-pdf">
    {error ? <div role="alert"><p>{error}</p><p>The preserved original can still be downloaded below.</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry PDF</button></div> : <>
      {document && <div className="preserved-pdf-controls">
        <button type="button" disabled={page <= 1} onClick={() => { setRendering(true); setPage(value => value - 1) }}>Previous page</button>
        <span aria-live="polite">Page {page} of {document.numPages}</span>
        <button type="button" disabled={page >= document.numPages} onClick={() => { setRendering(true); setPage(value => value + 1) }}>Next page</button>
        <label>PDF zoom <select aria-label="PDF zoom" value={zoom} onChange={event => { setRendering(true); setZoom(Number(event.target.value)) }}>
          <option value={1}>100%</option><option value={1.25}>125%</option><option value={1.5}>150%</option><option value={2}>200%</option>
        </select></label>
      </div>}
      {rendering && <p role="status">Rendering original PDF…</p>}
      <div className="preserved-pdf-page"><canvas key={evidenceId + ':' + page + ':' + zoom} ref={canvas} role="img" aria-label={'Preserved PDF page ' + page + (document ? ' of ' + document.numPages : '')} hidden={rendering} /></div>
      <p className="case-muted">Original page image. Use Extracted text for accessible text and extraction warnings.</p>
    </>}
  </section>
}
