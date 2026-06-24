import { FileUp, RotateCcw, Save, UploadCloud } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { EvidenceItem, Matter } from '../types'

interface CaseIntakeProps {
  matter: Matter
  evidence: EvidenceItem[]
  selectedEvidenceId?: string
  onSelectEvidence: (evidenceId: string) => void
  onSaveMatter: (input: { narrative: string; jurisdiction: string }) => Promise<void>
  onUploadEvidence: (file: File) => Promise<void>
}

export function CaseIntake({
  matter,
  evidence,
  selectedEvidenceId,
  onSelectEvidence,
  onSaveMatter,
  onUploadEvidence,
}: CaseIntakeProps) {
  const [narrative, setNarrative] = useState(matter.narrative)
  const [jurisdiction, setJurisdiction] = useState(matter.jurisdiction)
  const [isSaving, setIsSaving] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setNarrative(matter.narrative)
    setJurisdiction(matter.jurisdiction)
  }, [matter.id, matter.jurisdiction, matter.narrative])

  const save = async () => {
    setIsSaving(true)
    try {
      await onSaveMatter({ narrative, jurisdiction })
    } finally {
      setIsSaving(false)
    }
  }

  const upload = async (file: File | undefined) => {
    if (!file) {
      return
    }

    setIsUploading(true)
    try {
      await onUploadEvidence(file)
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  return (
    <section className="intake-panel" aria-label="Case intake">
      <div className="panel-header">
        <span>Case Intake</span>
        <button className="text-button danger" type="button" onClick={() => setNarrative('')}>
          Reset
        </button>
      </div>

      <div className="intake-block">
        <div className="field-label">1. Case Narrative</div>
        <div className="segmented-control" aria-label="Narrative mode">
          <button className="selected" type="button">
            Paste Text
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            Upload File
          </button>
        </div>
        <textarea
          className="case-textarea"
          value={narrative}
          onChange={(event) => setNarrative(event.target.value)}
          placeholder="Paste the core facts, procedural posture, allegations, and legal context."
        />
        <div className="textarea-footer">
          <span>{narrative.length} / 5000</span>
          <button className="mini-action" type="button" onClick={save} disabled={isSaving}>
            <Save size={14} />
            {isSaving ? 'Saving' : 'Save'}
          </button>
        </div>
      </div>

      <div className="intake-block">
        <div className="field-label">2. Add Documents & Evidence</div>
        <button
          className="upload-dropzone"
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
        >
          <UploadCloud size={26} />
          <span>{isUploading ? 'Extracting file...' : 'Drag and drop files here'}</span>
          <small>PDF, DOCX, PNG, JPG, MD, TXT up to 250MB</small>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="visually-hidden"
          onChange={(event) => void upload(event.target.files?.[0])}
        />

        <div className="evidence-list">
          {evidence.map((item) => (
            <button
              key={item.id}
              className={
                item.id === selectedEvidenceId
                  ? 'evidence-row selected'
                  : 'evidence-row'
              }
              type="button"
              onClick={() => onSelectEvidence(item.id)}
            >
              <FileUp size={16} />
              <span>
                {item.name}
                <small>{formatBytes(item.size)}</small>
              </span>
              <strong>{item.exhibitId}</strong>
            </button>
          ))}
        </div>
      </div>

      <div className="intake-block">
        <div className="field-label">3. Jurisdiction & Rule Set</div>
        <input
          className="jurisdiction-input"
          value={jurisdiction}
          onChange={(event) => setJurisdiction(event.target.value)}
          onBlur={() => void save()}
        />
        <button className="text-button" type="button" onClick={() => setJurisdiction('Ontario, Canada')}>
          <RotateCcw size={13} />
          Ontario default
        </button>
      </div>
    </section>
  )
}

function formatBytes(size: number): string {
  if (size >= 1_000_000) {
    return `${(size / 1_000_000).toFixed(1)} MB`
  }

  return `${Math.max(1, Math.round(size / 1_000))} KB`
}
