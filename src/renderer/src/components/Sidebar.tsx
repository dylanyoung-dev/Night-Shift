import type { LinearProject, NightShiftProject } from '../../../shared/types'

export type View = 'board' | 'agents' | 'automations' | 'steps' | 'runs' | 'usage' | 'settings' | 'projects'

interface Props {
  view: View
  onView(v: View): void
  running: number
  needsYou: number
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
  { id: 'automations', label: 'Automations' },
  { id: 'steps', label: 'Actions' },
  { id: 'runs', label: 'Run history' },
  { id: 'usage', label: 'Usage' },
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
  needsYou,
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
      <div className="brand">
        <svg viewBox="0 0 100 100" width="22" height="22" aria-hidden="true">
          <defs>
            <mask id="brand-hub">
              <rect width="100" height="100" fill="#fff" />
              <circle cx="50" cy="50" r="17" fill="#000" />
            </mask>
            <mask id="brand-moon">
              <rect width="100" height="100" fill="#fff" />
              <circle cx="56" cy="45" r="9" fill="#000" />
            </mask>
          </defs>
          <rect width="100" height="100" rx="22" fill="#121833" />
          <g mask="url(#brand-hub)">
            {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
              <rect key={a} x="44" y="12" width="12" height="16" rx="2" fill="#F2E6C9" transform={`rotate(${a} 50 50)`} />
            ))}
            <circle cx="50" cy="50" r="30" fill="#F2E6C9" />
          </g>
          <circle cx="50" cy="50" r="11" fill="#FFB547" mask="url(#brand-moon)" />
        </svg>
        Night Shift
      </div>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={`nav${view === it.id ? ' active' : ''}`}
          onClick={() => onView(it.id)}
        >
          {it.label}
          {it.id === 'agents' && needsYou > 0 && (
            <span className="count attention" title={`${needsYou} need you`}>
              {needsYou} need you
            </span>
          )}
          {it.id === 'agents' && running > 0 && needsYou === 0 && <span className="count">{running}</span>}
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
          <button type="button" className={`nav subtle${view === 'projects' ? ' active' : ''}`} onClick={onManageProjects}>
            {projects.length ? 'Manage projects' : '+ Add a project'}
          </button>
        </>
      )}
    </nav>
  )
}
