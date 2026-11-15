import { useMemo, useRef, useState, type KeyboardEvent } from 'react'

import type { EvidenceItem, ProviderStatus } from '../../types'
import { CaseTimeline } from './CaseTimeline'
import { EvidenceIndex } from './EvidenceIndex'
import { ExpertAnalysis } from './ExpertAnalysis'

// The Facts & Evidence area of the guided workspace: three screens as tabs. A tab
// is mounted the first time it is opened and then kept (hidden), so a running
// job and its preview are not lost when the user looks at another tab.
const tabs = [
  { id: 'timeline', label: 'Timeline and key facts' },
  { id: 'index', label: 'Evidence and testimony index' },
  { id: 'experts', label: 'Expert witnesses' },
] as const
type TabId = (typeof tabs)[number]['id']

const storageKey = (matterId: string) => `judge-jury:facts-tab:${matterId}`
function readTab(matterId: string): TabId {
  try { return tabs.find((tab) => tab.id === localStorage.getItem(storageKey(matterId)))?.id ?? 'timeline' } catch { return 'timeline' }
}

export function FactsEvidenceArea({ matterId, matterTitle, provider, evidence }: { matterId: string; matterTitle: string; provider: ProviderStatus | null; evidence: EvidenceItem[] }) {
  const [active, setActive] = useState<TabId>(() => readTab(matterId))
  const [opened, setOpened] = useState<ReadonlySet<TabId>>(() => new Set([readTab(matterId)]))
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const exhibits = useMemo(() => new Map(evidence.map((item) => [item.id, item.exhibitId])), [evidence])

  const select = (id: TabId) => {
    setActive(id)
    setOpened((current) => new Set([...current, id]))
    try { localStorage.setItem(storageKey(matterId), id) } catch { /* The analysis itself is saved on the server. */ }
  }
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    select(tabs[next].id)
    buttons.current[next]?.focus()
  }

  return <section className="guided-workflow" data-area="Facts & Evidence">
    <div className="workflow-panel">
      <header className="case-view-heading"><div><h1>Facts &amp; Evidence</h1><p className="case-muted">{matterTitle}</p></div></header>
      <div className="analysis-tabs" role="tablist" aria-label="Facts and evidence screens">
        {tabs.map((tab, index) => <button key={tab.id} ref={(element) => { buttons.current[index] = element }} type="button" role="tab" id={`facts-tab-${tab.id}`}
          aria-selected={active === tab.id} aria-controls={`facts-panel-${tab.id}`} tabIndex={active === tab.id ? 0 : -1}
          onClick={() => select(tab.id)} onKeyDown={(event) => onKeyDown(event, index)}>{tab.label}</button>)}
      </div>
      {tabs.map((tab) => <div key={tab.id} role="tabpanel" id={`facts-panel-${tab.id}`} aria-labelledby={`facts-tab-${tab.id}`} hidden={active !== tab.id}>
        {opened.has(tab.id) && (tab.id === 'timeline' ? <CaseTimeline matterId={matterId} provider={provider} exhibits={exhibits} />
          : tab.id === 'index' ? <EvidenceIndex matterId={matterId} provider={provider} exhibits={exhibits} />
            : <ExpertAnalysis matterId={matterId} provider={provider} exhibits={exhibits} />)}
      </div>)}
    </div>
  </section>
}
