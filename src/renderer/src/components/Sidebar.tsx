import type { LinearProject, NightShiftProject } from '../../../shared/types'
import { Icon, type IconName } from './Icons'

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
  wide: boolean // full sidebar; otherwise the icon rail
  runner: { name: string; busy: number; slots: number } // "Local runner · 1 of 3 busy", or the host in remote mode
}

const items: { id: View; label: string; icon: IconName }[] = [
  { id: 'board', label: 'Board', icon: 'board' },
  { id: 'agents', label: 'Running agents', icon: 'agents' },
  { id: 'automations', label: 'Automations', icon: 'auto' },
  { id: 'steps', label: 'Actions', icon: 'actions' },
  { id: 'runs', label: 'Run history', icon: 'history' },
  { id: 'usage', label: 'Usage', icon: 'usage' }
]

function Brand({ wide }: { wide: boolean }): JSX.Element {
  return (
    <div className="brand">
      {/* The Night Shift gear-and-moon mark (it carries its own navy tile). */}
      <svg className="brand-logo" viewBox="0 0 100 100" {...(wide ? { 'aria-hidden': true } : { role: 'img', 'aria-label': 'Night Shift' })}>
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
      {wide && <span className="brand-name">Night Shift</span>}
    </div>
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
  onManageProjects,
  wide,
  runner
}: Props): JSX.Element {
  const colorOf = (p: NightShiftProject): string => linearProjects.find((lp) => lp.id === p.linearProjectIds[0])?.color ?? 'var(--muted)'
  const slots = Math.max(1, runner.slots)
  const runnerText = `${runner.busy} of ${runner.slots} busy`
  const segments = Array.from({ length: slots }, (_, i) => i < runner.busy)

  if (!wide) {
    return (
      <nav className="sidebar rail" aria-label="Main">
        <Brand wide={false} />
        {items.map((it) => {
          const badge = it.id === 'agents' && needsYou > 0
          const label = it.id === 'agents' && needsYou > 0 ? `${it.label}, ${needsYou} need you` : it.id === 'agents' && running > 0 ? `${it.label}, ${running} going` : it.label
          return (
            <button
              key={it.id}
              type="button"
              className={`rail-btn${view === it.id ? ' active' : ''}`}
              aria-label={label}
              aria-current={view === it.id ? 'page' : undefined}
              title={label}
              onClick={() => onView(it.id)}
            >
              <Icon name={it.icon} size={18} />
              {badge && <span className="rail-badge" aria-hidden="true" />}
            </button>
          )
        })}
        {teamKey && (
          <>
            <span className="rail-sep" aria-hidden="true" />
            <button
              type="button"
              className={`rail-btn${activeProjectId === null ? ' active' : ''}`}
              aria-pressed={activeProjectId === null}
              aria-label={`All of team ${teamKey}`}
              title={`All of team ${teamKey}`}
              onClick={() => onProject(null)}
            >
              <span className="proj-dot big" style={{ background: 'var(--muted)' }} aria-hidden="true" />
            </button>
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`rail-btn${activeProjectId === p.id ? ' active' : ''}`}
                aria-pressed={activeProjectId === p.id}
                aria-label={p.linearProjectIds.length ? p.name : `${p.name}, not linked to a Linear project yet`}
                title={p.linearProjectIds.length ? p.name : `${p.name} · not linked to a Linear project yet`}
                onClick={() => onProject(p.id)}
              >
                <span className="proj-dot big" style={{ background: colorOf(p) }} aria-hidden="true" />
              </button>
            ))}
            <button
              type="button"
              className={`rail-btn${view === 'projects' ? ' active' : ''}`}
              aria-label={projects.length ? 'Manage projects' : 'Add a project'}
              title={projects.length ? 'Manage projects' : 'Add a project'}
              onClick={onManageProjects}
            >
              <span className="proj-dot big dashed" aria-hidden="true" />
            </button>
          </>
        )}
        <span className="spacer" />
        <button
          type="button"
          className={`rail-btn${view === 'settings' ? ' active' : ''}`}
          aria-label="Settings"
          aria-current={view === 'settings' ? 'page' : undefined}
          title="Settings"
          onClick={() => onView('settings')}
        >
          <Icon name="settings" size={18} />
        </button>
      </nav>
    )
  }

  return (
    <nav className="sidebar" aria-label="Main">
      <Brand wide />
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={`nav${view === it.id ? ' active' : ''}`}
          aria-current={view === it.id ? 'page' : undefined}
          onClick={() => onView(it.id)}
        >
          <Icon name={it.icon} />
          <span className="nav-label">{it.label}</span>
          {it.id === 'agents' && needsYou > 0 && <span className="nav-badge">{needsYou} need{needsYou === 1 ? 's' : ''} you</span>}
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
            <span className="proj-dot" style={{ background: 'var(--muted)' }} aria-hidden="true" />
            <span className="project-name">All of team {teamKey}</span>
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
              <span className="proj-dot" style={{ background: colorOf(p) }} aria-hidden="true" />
              <span className="project-name">{p.name}</span>
              {!p.linearProjectIds.length && <span className="count">unlinked</span>}
            </button>
          ))}
          <button type="button" className={`nav project subtle${view === 'projects' ? ' active' : ''}`} onClick={onManageProjects}>
            <span className="proj-dot dashed" aria-hidden="true" />
            {projects.length ? 'Manage projects' : 'Add a project'}
          </button>
        </>
      )}
      <span className="spacer" />
      <button
        type="button"
        className={`nav${view === 'settings' ? ' active' : ''}`}
        aria-current={view === 'settings' ? 'page' : undefined}
        onClick={() => onView('settings')}
      >
        <Icon name="settings" />
        <span className="nav-label">Settings</span>
      </button>
      <div className="runner-card">
        <div className="runner-head">
          <span className="runner-name" title={runner.name}>
            {runner.name}
          </span>
          <span className="runner-count">{runnerText}</span>
        </div>
        <div className="runner-bars" style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))` }} aria-hidden="true">
          {segments.map((on, i) => (
            <span key={i} className={on ? 'on' : ''} />
          ))}
        </div>
      </div>
    </nav>
  )
}
