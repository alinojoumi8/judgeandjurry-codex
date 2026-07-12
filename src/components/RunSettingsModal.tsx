import {
  AlertTriangle,
  Eye,
  FileSearch,
  Loader2,
  MonitorCheck,
  Server,
  Users,
  Vote,
  X,
} from 'lucide-react'

import { panelRuleHint } from '../panelRules'
import type {
  DeliberationMode,
  PacketPreview,
  ProviderMode,
  RunConfig,
  RunOptions,
} from '../types'

interface RunSettingsModalProps {
  open: boolean
  options: RunOptions | null
  value: RunConfig
  preview: PacketPreview | null
  isPreviewLoading: boolean
  onChange: (runConfig: RunConfig) => void
  onClose: () => void
  onPreview: () => void
  onApply: () => void
}

export function RunSettingsModal({
  open,
  options,
  value,
  preview,
  isPreviewLoading,
  onChange,
  onClose,
  onPreview,
  onApply,
}: RunSettingsModalProps) {
  if (!open) {
    return null
  }

  const provider = options?.provider ?? null
  const templates = options?.templates ?? []
  const stages = options?.stages ?? []
  const selectedTemplate =
    templates.find((template) => template.id === value.templateId) ?? templates[0]

  const update = (patch: Partial<RunConfig>) => {
    onChange({ ...value, ...patch })
  }

  const toggleStage = (stageId: string) => {
    const next = value.stages.includes(stageId)
      ? value.stages.filter((id) => id !== stageId)
      : [...value.stages, stageId]
    update({ stages: next.length > 0 ? next : value.stages })
  }

  const providerModes: ProviderMode[] = ['local', 'external']

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="run-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Run Settings"
      >
        <header className="modal-header">
          <div>
            <span>Run Settings</span>
            <strong>Legal-grade simulation controls</strong>
          </div>
          <button type="button" aria-label="Close run settings" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="settings-grid">
          <div className="settings-column">
            <div className="settings-block">
              <label htmlFor="template-select">Legal template</label>
              <select
                id="template-select"
                value={value.templateId}
                onChange={(event) => {
                  const templateId = event.target.value as RunConfig['templateId']
                  const template = templates.find((item) => item.id === templateId)
                  update({
                    templateId,
                    jurorCount: template?.defaultJurorCount ?? value.jurorCount,
                  })
                }}
              >
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.label}
                  </option>
                ))}
              </select>
              {selectedTemplate && <p>{selectedTemplate.description}</p>}
              {selectedTemplate && <small>{selectedTemplate.burdenLabel}</small>}
            </div>

            <div className="settings-block">
              <label>Provider mode</label>
              <div className="provider-mode-grid">
                {providerModes.map((mode) => {
                  const available = provider?.availableModes.includes(mode) ?? false
                  return (
                    <button
                      key={mode}
                      className={value.providerMode === mode ? 'selected' : ''}
                      type="button"
                      disabled={!available}
                      onClick={() =>
                        update({
                          providerMode: mode,
                          externalDisclosureConfirmed:
                            mode === 'external'
                              ? value.externalDisclosureConfirmed
                              : false,
                        })
                      }
                    >
                      {iconForProviderMode(mode)}
                      <span>{providerModeLabel(mode)}</span>
                    </button>
                  )
                })}
              </div>
              <small>
                {provider ? providerModeHelp(value.providerMode, provider) : 'Provider details are loading.'}
              </small>
              {value.providerMode === 'external' && (
                <label className="disclosure-check">
                  <input
                    type="checkbox"
                    checked={value.externalDisclosureConfirmed}
                    onChange={(event) =>
                      update({ externalDisclosureConfirmed: event.target.checked })
                    }
                  />
                  I confirm sensitive case material may be sent to the configured
                  external model provider for this run.
                </label>
              )}
            </div>

            <div className="settings-row">
              <div className="settings-block">
                <label htmlFor="juror-count">Jurors</label>
                <input
                  id="juror-count"
                  type="number"
                  min={1}
                  max={12}
                  value={value.jurorCount}
                  onChange={(event) =>
                    update({ jurorCount: Number(event.target.value) || 1 })
                  }
                />
              </div>
              <div className="settings-block">
                <label htmlFor="retrieval-depth">Retrieval depth</label>
                <input
                  id="retrieval-depth"
                  type="number"
                  min={1}
                  max={20}
                  value={value.retrievalDepth}
                  onChange={(event) =>
                    update({ retrievalDepth: Number(event.target.value) || 1 })
                  }
                />
              </div>
            </div>
            <small className="panel-rule-hint">
              {panelRuleHint(value.templateId, value.jurorCount)}
            </small>

            <div className="settings-block">
              <label>Jury deliberation</label>
              <div className="provider-mode-grid">
                {(['independent', 'grouped'] as DeliberationMode[]).map((mode) => (
                  <button
                    key={mode}
                    className={value.deliberationMode === mode ? 'selected' : ''}
                    type="button"
                    onClick={() => update({ deliberationMode: mode })}
                  >
                    {mode === 'independent' ? <Vote size={16} /> : <Users size={16} />}
                    <span>{mode === 'independent' ? 'Secret ballots' : 'Single pass'}</span>
                  </button>
                ))}
              </div>
              <small>
                {value.deliberationMode === 'independent'
                  ? `Each juror casts an independent secret ballot (one model call per juror, ${value.jurorCount} extra calls) before the panel deliberates. Closest to a real jury.`
                  : 'The whole panel is generated in a single model call. Faster, but juror opinions are less independent.'}
              </small>
            </div>

            <div className="settings-block">
              <label>Stages</label>
              <div className="stage-checklist">
                {stages.map((stage) => (
                  <label key={stage.id}>
                    <input
                      type="checkbox"
                      checked={value.stages.includes(stage.id)}
                      onChange={() => toggleStage(stage.id)}
                    />
                    <span>{stage.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="settings-column preview-column">
            <div className="preview-header">
              <div>
                <span>Packet Preview</span>
                <strong>Evidence the agents will see</strong>
              </div>
              <button type="button" onClick={onPreview} disabled={isPreviewLoading}>
                {isPreviewLoading ? <Loader2 className="spin" size={15} /> : <Eye size={15} />}
                Preview
              </button>
            </div>

            {preview?.warnings.length ? (
              <div className="preview-warnings">
                {preview.warnings.map((warning) => (
                  <span key={warning}>
                    <AlertTriangle size={14} />
                    {warning}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="packet-preview">
              {preview ? (
                <>
                  <div className="packet-stats">
                    <span>{preview.evidenceCount} exhibits</span>
                    <span>{preview.chunkCount} chunks</span>
                    <span>{preview.template.label}</span>
                  </div>
                  <div className="chunk-list">
                    {preview.chunks.length === 0 ? (
                      <p>No targeted chunks were retrieved for this preview.</p>
                    ) : (
                      preview.chunks.map((chunk) => (
                        <article key={`${chunk.evidenceId}-${chunk.chunkIndex}`}>
                          <strong>
                            {chunk.exhibitId}
                            <span>{chunk.label}</span>
                          </strong>
                          <p>{chunk.text.slice(0, 260)}</p>
                        </article>
                      ))
                    )}
                  </div>
                  <details>
                    <summary>Case packet text</summary>
                    <pre>{preview.packet.slice(0, 2200)}</pre>
                  </details>
                </>
              ) : (
                <div className="empty-preview">
                  <FileSearch size={26} />
                  <span>Preview the packet before running.</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <footer className="modal-footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="button" onClick={onApply}>
            Apply Settings
          </button>
        </footer>
      </section>
    </div>
  )
}

function iconForProviderMode(mode: ProviderMode) {
  if (mode === 'external') {
    return <Server size={16} />
  }
  return <MonitorCheck size={16} />
}

function providerModeLabel(mode: ProviderMode): string {
  if (mode === 'external') {
    return 'External'
  }
  return 'Local'
}

function providerModeHelp(
  mode: ProviderMode,
  provider: NonNullable<RunSettingsModalProps['options']>['provider'],
): string {
  if (mode === 'local') {
    return `Local mode sends prompts only to ${provider.baseUrl}. Model: ${provider.model}.`
  }
  return `${provider.label}. Model: ${provider.model}. External disclosure confirmation is required before running.`
}
