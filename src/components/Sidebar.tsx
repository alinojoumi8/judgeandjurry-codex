import {
  Archive,
  BarChart3,
  BookOpen,
  CircleHelp,
  FileText,
  Library,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { Matter, SimulationSession } from '../types'
import { BrandMark } from './BrandMark'

interface SidebarProps {
  matters: Matter[]
  activeMatterId?: string
  activeSession: SimulationSession | null
  onSelectMatter: (matterId: string) => void
  onCreateMatter: () => void
  onDeleteMatter: (matterId: string) => void
}

export function Sidebar({
  matters,
  activeMatterId,
  activeSession,
  onSelectMatter,
  onCreateMatter,
  onDeleteMatter,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <BrandMark />
      </div>

      <button className="new-matter" type="button" onClick={onCreateMatter}>
        <Plus size={16} />
        New Matter
      </button>

      <div className="sidebar-section">
        <div className="sidebar-section__title">
          <span>Matters</span>
          <span className="sidebar-section__tools">
            <Search size={15} />
            <SlidersHorizontal size={15} />
          </span>
        </div>
        <div className="matter-list">
          {matters.map((matter) => (
            <div
              key={matter.id}
              className={
                matter.id === activeMatterId ? 'matter-row active' : 'matter-row'
              }
            >
              <button
                className="matter-item"
                type="button"
                onClick={() => onSelectMatter(matter.id)}
              >
                <span>{matter.title}</span>
                <small>{formatDate(matter.updatedAt)}</small>
              </button>
              <button
                className="matter-remove"
                type="button"
                aria-label={`Remove ${matter.title}`}
                title="Remove matter"
                onClick={() => onDeleteMatter(matter.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section__title">
          <span>Sessions</span>
          <Plus size={15} />
        </div>
        <div className="session-list">
          <button className="session-item active" type="button">
            <span className="session-dot" />
            <span>
              Simulation {activeSession?.status === 'running' ? 'Running' : 'Latest'}
            </span>
            <small>{activeSession ? formatTime(activeSession.createdAt) : 'No run'}</small>
          </button>
          <button className="session-item" type="button">
            <span className="session-dot muted" />
            <span>Draft Workspace</span>
            <small>Current</small>
          </button>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="Workspace navigation">
        <NavItem icon={<Library size={16} />} label="Library" />
        <NavItem icon={<FileText size={16} />} label="Templates" />
        <NavItem icon={<BarChart3 size={16} />} label="Analytics" />
        <NavItem icon={<Archive size={16} />} label="Archive" />
        <NavItem icon={<Trash2 size={16} />} label="Trash" />
      </nav>

      <div className="sidebar-footer">
        <NavItem icon={<CircleHelp size={16} />} label="Help & Support" />
        <NavItem icon={<Settings size={16} />} label="Settings" />
      </div>

      <div className="sidebar__library-note">
        <BookOpen size={14} />
        Local decision-support workspace
      </div>
    </aside>
  )
}

function NavItem({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <button className="nav-item" type="button">
      {icon}
      {label}
    </button>
  )
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}
