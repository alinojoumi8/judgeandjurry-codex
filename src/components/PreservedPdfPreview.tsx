import { useEffect, useState } from 'react'
import { fetchOriginalPdfPage } from '../api'

export function PreservedPdfPreview({ evidenceId, initialPage = 1 }: { evidenceId: string; initialPage?: number }) {
  const [page, setPage] = useState(initialPage)
  const [image, setImage] = useState<Awaited<ReturnType<typeof fetchOriginalPdfPage>> | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(''); setImage(null)
    void fetchOriginalPdfPage(evidenceId, page).then(value => { if (!cancelled) setImage(value) })
      .catch(caught => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'Unable to render PDF page. Download the preserved original for review.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [evidenceId, page])
  return <section className="preserved-pdf-preview" aria-label="Preserved original PDF">
    <h4>Preserved original PDF</h4>
    <p>Page image rendered locally from the preserved source. PDF page numbers refer to this file; printed or original-record numbers may differ.</p>
    <div className="workflow-row"><button type="button" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>Previous PDF page</button>
      <span>PDF page {page}{image ? ` of ${image.totalPages}` : ''}</span>
      <button type="button" disabled={loading || !image || page >= image.totalPages} onClick={() => setPage(page + 1)}>Next PDF page</button></div>
    {loading && <p role="status">Rendering preserved PDF page…</p>}
    {error && <p role="alert">{error}</p>}
    {image && <><p className="source-hash">Source SHA-256: {image.sha256}</p><div className="preserved-pdf-page"><img src={image.dataUrl} alt={`Preserved original PDF page ${page} of ${image.totalPages}`} width={image.width} height={image.height} /></div></>}
  </section>
}
