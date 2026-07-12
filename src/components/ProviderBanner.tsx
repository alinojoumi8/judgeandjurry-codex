import { AlertTriangle, CheckCircle2, SlidersHorizontal } from 'lucide-react'

import type { ProviderStatus, RunConfig } from '../types'

interface ProviderBannerProps {
  provider: ProviderStatus | null
  runConfig: RunConfig
  onOpenSettings: () => void
}

export function ProviderBanner({
  provider,
  runConfig,
  onOpenSettings,
}: ProviderBannerProps) {
  const isExternal = runConfig.providerMode === 'external'
  const confirmed = runConfig.externalDisclosureConfirmed
  const unavailable =
    provider && !provider.availableModes.includes(runConfig.providerMode)

  return (
    <section
      className={`provider-banner provider-banner--${runConfig.providerMode}`}
      aria-label="Provider and privacy status"
    >
      <div className="provider-banner__status">
        {isExternal ? (
          <AlertTriangle size={18} />
        ) : (
          <CheckCircle2 size={18} />
        )}
        <div>
          <strong>{labelForMode(runConfig.providerMode)}</strong>
          <span>
            {provider ? providerDescription(runConfig.providerMode, provider) : 'Loading provider details'}
          </span>
        </div>
      </div>

      <div className="provider-banner__meta">
        <span>{runConfig.jurorCount} jurors</span>
        <span>{runConfig.retrievalDepth} chunks</span>
        <span>{runConfig.stages.length} stages</span>
        {isExternal && (
          <span className={confirmed ? 'safe' : 'risk'}>
            {confirmed ? 'Disclosure confirmed' : 'Needs confirmation'}
          </span>
        )}
        {unavailable && <span className="risk">Mode unavailable</span>}
      </div>

      <button type="button" onClick={onOpenSettings}>
        <SlidersHorizontal size={15} />
        Configure
      </button>
    </section>
  )
}

function providerDescription(mode: RunConfig['providerMode'], provider: ProviderStatus): string {
  if (mode === 'local') {
    return `${provider.model} at ${provider.baseUrl}`
  }
  return `${provider.model} via ${provider.name}`
}

function labelForMode(mode: RunConfig['providerMode']): string {
  if (mode === 'external') {
    return 'External provider mode'
  }
  return 'Local provider mode'
}
