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
        <svg viewBox="0 0 200 200" width="22" height="22" aria-hidden="true">
          <defs>
            <mask id="brand-cut">
              <rect width="200" height="200" fill="#fff" />
              <circle cx="124" cy="80" r="58" fill="#000" />
            </mask>
          </defs>
          <rect width="200" height="200" rx="40" fill="#141821" />
          <circle cx="96" cy="104" r="66" fill="#e3b341" mask="url(#brand-cut)" />
          <path d="M106 76 L126 94 L106 112" stroke="#8fb0ff" strokeWidth="16" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="134" y="100" width="28" height="14" rx="4" fill="#8fb0ff" />
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
