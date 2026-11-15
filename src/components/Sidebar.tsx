import { BarChart3, FileText, FolderOpen, LayoutList, Play, Plus, Settings, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { BrandMark } from './BrandMark'
import type { Matter } from '../types'
import { caseAreas, type CaseArea } from '../caseWorkspace'

interface SidebarProps {
  matters: Matter[]; activeMatterId: string; area: CaseArea; mode: 'decision' | 'trialforge' | 'workflow'
  onSelectMatter: (id: string) => void; onCreateMatter: () => void; onDeleteMatter: (id: string) => void
  onAreaChange: (area: CaseArea) => void; onModeChange: (mode: 'decision' | 'trialforge' | 'workflow') => void; onSettings: () => void; onImport: () => void
}

const icons = { Overview: LayoutList, Documents: FileText, Simulation: Play, Results: BarChart3 }

export function Sidebar({ matters, activeMatterId, area, mode, onSelectMatter, onCreateMatter, onDeleteMatter, onAreaChange, onModeChange, onSettings, onImport }: SidebarProps) {
  const [casesOpen, setCasesOpen] = useState(false)
  const active = matters.find(matter => matter.id === activeMatterId)
  return <aside className="case-sidebar" aria-label="Case workspace">
    <BrandMark />
    <button className="new-matter" type="button" onClick={onCreateMatter}><Plus size={18} />New case</button>
    <button className="all-cases-button" type="button" aria-expanded={casesOpen} onClick={() => setCasesOpen(!casesOpen)}><FolderOpen size={18} />All cases <span>{matters.length}</span></button>
    {casesOpen && <div className="case-switcher" aria-label="Saved cases">{matters.map(matter => <div className="matter-row" key={matter.id}>
      <button className="matter-item" type="button" aria-current={matter.id === activeMatterId ? 'true' : undefined} onClick={() => { onSelectMatter(matter.id); setCasesOpen(false) }}><span>{matter.title}</span><small>{new Date(matter.updatedAt).toLocaleDateString()}</small></button>
      <button className="matter-remove" type="button" aria-label={`Remove ${matter.title}`} onClick={() => onDeleteMatter(matter.id)}><Trash2 size={14} /></button>
    </div>)}<button type="button" className="case-import" onClick={onImport}>Import saved case</button></div>}
    <div className="case-sidebar-context"><strong>{active?.title}</strong><span>Case workspace</span></div>
    <nav className="case-primary-nav" aria-label="Case navigation">{caseAreas.map(label => {
      const Icon = icons[label]
      return <button type="button" key={label} aria-current={mode === 'workflow' && area === label ? 'page' : undefined} onClick={() => { onModeChange('workflow'); onAreaChange(label) }}><Icon size={19} />{label}</button>
    })}</nav>
    <details className="case-advanced-tools"><summary>Advanced tools</summary><p>Additional rehearsal workspaces</p>
      <button type="button" onClick={() => onModeChange('decision')} aria-pressed={mode === 'decision'}>Decision</button>
      <button type="button" onClick={() => onModeChange('trialforge')} aria-pressed={mode === 'trialforge'}>TrialForge</button>
      <button type="button" onClick={() => { onModeChange('workflow'); onAreaChange('Simulation') }}>Full Proceeding</button>
    </details>
    <div className="case-sidebar-footer">{mode === 'workflow' && <button type="button" onClick={onSettings}><Settings size={18} />Run settings</button>}<p>Local research and rehearsal</p></div>
  </aside>
}
