import { useRef, useState } from 'react'
import { ArrowRight, FileText, Upload } from 'lucide-react'
import type { EvidenceItem } from '../types'
import { SourceReferenceButton } from './EvidenceDecisionWorkspace'

export function CaseDocuments({ matterId, evidence, onUpload, onReview }: { matterId: string; evidence: EvidenceItem[]; onUpload: (file: File) => Promise<void>; onReview: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const uploading = useRef(false)
  const upload = async (files: File[]) => {
    if (!files.length || uploading.current) return
    uploading.current = true; setError('')
    try {
      for (let index = 0; index < files.length; index++) {
        setProgress(`Preserving document ${index + 1} of ${files.length}: ${files[index].name}`)
        await onUpload(files[index])
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Upload failed. The remaining documents were not uploaded.') }
    finally { uploading.current = false; setProgress(''); if (input.current) input.current.value = '' }
  }
  return <section className="case-documents" aria-label="Case documents">
    <div className={`case-upload ${dragging ? 'is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void upload(Array.from(event.dataTransfer.files)) }}>
      <Upload size={26} /><h2>Add your source documents</h2><p>Drop files here or choose them from your computer.</p>
      <p className="case-muted">PDF, DOCX, images, text and Markdown. Originals are preserved; extracted text may need review.</p>
      <button className="primary-action" type="button" disabled={Boolean(progress)} onClick={() => input.current?.click()}>Upload documents</button>
      <input ref={input} type="file" multiple aria-label="Upload case documents" className="visually-hidden" onChange={event => void upload(Array.from(event.target.files ?? []))} />
    </div>
    {progress && <p role="status">{progress}</p>}
    {error && <p role="alert" className="case-warning">{error} Already saved documents remain in this case. Select the remaining files to retry.</p>}
    <div className="case-section-heading"><h2>Documents ({evidence.length})</h2>{evidence.length > 0 && <button type="button" onClick={onReview}>Review case <ArrowRight size={16} /></button>}</div>
    <div className="case-document-list">{evidence.map(item => <article key={item.id}>
      <FileText size={22} /><div><h3>{item.name}</h3><p className="case-muted">{item.exhibitId} · {Math.max(1, Math.round(item.size / 1024))} KB · {item.ingestionStatus ?? 'Saved'}</p>
        {item.extractionWarning && <p className="case-warning">Needs review: {item.extractionWarning}</p>}
      </div><SourceReferenceButton matterId={matterId} source={{ evidenceId: item.id, exhibitId: item.exhibitId, name: item.name, attribution: 'source', status: 'located' }} />
    </article>)}</div>
    {!evidence.length && <p className="case-muted">Uploaded documents will appear here with their source identifiers and any extraction warnings.</p>}
  </section>
}
