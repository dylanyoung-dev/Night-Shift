import type { LinearProject, NightShiftProject } from '../../../shared/types'

export type View = 'board' | 'agents' | 'steps' | 'runs' | 'settings'

interface Props {
  view: View
  onView(v: View): void
  running: number
  teamKey?: string
  projects: NightShiftProject[]
  linearProjects: LinearProject[] // for each project's color
  activeProjectId: string | null
  onProject(id: string | null): void
  onManageProjects(): void
}

const items: { id: View; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'agents', label: 'Running agents' },
  { id: 'steps', label: 'Steps per state' },
  { id: 'runs', label: 'Run history' },
  { id: 'settings', label: 'Settings' }
]

function ProjectIcon({ color }: { color: string }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: '0 0 auto' }}>
      <rect x="1.5" y="1.5" width="11" height="11" rx="3" fill="none" stroke={color} strokeWidth="1.5" />
      <rect x="4.5" y="4.5" width="5" height="5" rx="1.2" fill={color} />
    </svg>
  )
}

export default function Sidebar({
  view,
  onView,
  running,
  teamKey,
  projects,
  linearProjects,
  activeProjectId,
  onProject,
  onManageProjects
}: Props): JSX.Element {
  const colorOf = (p: NightShiftProject): string => linearProjects.find((lp) => lp.id === p.linearProjectIds[0])?.color ?? '#9ba1ad'
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">Night Shift</div>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={`nav${view === it.id ? ' active' : ''}`}
          onClick={() => onView(it.id)}
        >
          {it.label}
          {it.id === 'agents' && running > 0 && <span className="count">{running}</span>}
        </button>
      ))}
      {teamKey && (
        <>
          <div className="grouplabel side">Linear</div>
          <button
            type="button"
            className={`nav project${activeProjectId === null ? ' current' : ''}`}
            aria-pressed={activeProjectId === null}
            onClick={() => onProject(null)}
          >
            <ProjectIcon color="#9ba1ad" />
            All of team {teamKey}
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`nav project${activeProjectId === p.id ? ' current' : ''}`}
              aria-pressed={activeProjectId === p.id}
              title={p.linearProjectIds.length ? undefined : 'Not linked to a Linear project yet'}
              onClick={() => onProject(p.id)}
            >
              <ProjectIcon color={colorOf(p)} />
              <span className="project-name">{p.name}</span>
              {!p.linearProjectIds.length && <span className="count">unlinked</span>}
            </button>
          ))}
          <button type="button" className="nav subtle" onClick={onManageProjects}>
            {projects.length ? 'Manage projects' : '+ Add a project'}
          </button>
        </>
      )}
    </nav>
  )
}
