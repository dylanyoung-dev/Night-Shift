// Small inline icons in the style of Linear's board. All decorative unless labelled.
import type { LinearPullRequest, LinearState } from '../../../shared/types'

// Status circle: dashed for backlog, empty for unstarted, a filling pie for started
// (fuller the later the state), a check for completed, a cross for canceled.
export function StatusIcon({ state, progress = 0.5, size = 14 }: { state: LinearState; progress?: number; size?: number }): JSX.Element {
  const c = state.color
  const common = { width: size, height: size, viewBox: '0 0 14 14', 'aria-hidden': true as const, className: 'status-icon' }
  switch (state.type) {
    case 'backlog':
    case 'triage':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray="1.6 1.6" />
        </svg>
      )
    case 'unstarted':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6" fill="none" stroke={c} strokeWidth="1.5" />
        </svg>
      )
    case 'started': {
      const p = Math.min(0.95, Math.max(0.1, progress))
      const a = p * 2 * Math.PI
      const x = 7 + 3.5 * Math.sin(a)
      const y = 7 - 3.5 * Math.cos(a)
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6" fill="none" stroke={c} strokeWidth="1.5" />
          <path d={`M7 7 L7 3.5 A3.5 3.5 0 ${p > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`} fill={c} />
        </svg>
      )
    }
    case 'completed':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="7" fill={c} />
          <path d="M4.2 7.2 L6.2 9.1 L9.9 5.2" fill="none" stroke="#0f1115" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="7" fill={c} />
          <path d="M4.8 4.8 L9.2 9.2 M9.2 4.8 L4.8 9.2" stroke="#0f1115" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )
  }
}

export const PRIORITY_LABEL = ['No priority', 'Urgent', 'High', 'Medium', 'Low']

export function PriorityIcon({ priority }: { priority: number }): JSX.Element {
  const label = PRIORITY_LABEL[priority] ?? 'No priority'
  if (priority === 1) {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={label}>
        <title>{label}</title>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="#f2994a" />
        <rect x="6.25" y="3.5" width="1.5" height="4.6" rx=".75" fill="#0f1115" />
        <circle cx="7" cy="10.1" r=".9" fill="#0f1115" />
      </svg>
    )
  }
  if (!priority) {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={label}>
        <title>{label}</title>
        {[3, 7, 11].map((x) => (
          <rect key={x} x={x - 1} y="6.25" width="2" height="1.5" rx=".5" fill="currentColor" />
        ))}
      </svg>
    )
  }
  // High = 3 bars lit, Medium = 2, Low = 1.
  const lit = 5 - priority
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={label}>
      <title>{label}</title>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 4}
          y={8 - i * 3}
          width="3"
          height={4 + i * 3}
          rx="1"
          fill="currentColor"
          opacity={i < lit ? 1 : 0.3}
        />
      ))}
    </svg>
  )
}

export function EstimateIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.5 L10.8 10 H1.2 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6 4.5 L8.3 8.6 H3.7 Z" fill="currentColor" />
    </svg>
  )
}

export function BlockedIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label="Blocked">
      <title>Blocked by another issue</title>
      <circle cx="7" cy="7" r="6" fill="#eb5757" />
      <rect x="3.5" y="6.1" width="7" height="1.8" rx=".9" fill="#fff" />
    </svg>
  )
}

const PR_COLOR: Record<LinearPullRequest['status'], string> = {
  open: '#3fb950',
  draft: '#9ba1ad',
  merged: '#a371f7',
  closed: '#f85149',
  unknown: '#9ba1ad'
}

export function PullRequestIcon({ status }: { status: LinearPullRequest['status'] }): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ color: PR_COLOR[status] }}>
      <circle cx="3" cy="2.5" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="3" cy="9.5" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="9" cy="9.5" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3 4 V8 M9 8 V5 Q9 3 7 3 H5.5 M6.8 1.8 L5.5 3 L6.8 4.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function PreviewIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="1" y="2" width="10" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.5 4.6 L7.5 6 L4.5 7.4 Z" fill="currentColor" />
    </svg>
  )
}

export function SubIssuesIcon({ done, total }: { done: number; total: number }): JSX.Element {
  const p = total ? done / total : 0
  const r = 4.5
  const len = 2 * Math.PI * r
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".35" />
      <circle
        cx="6"
        cy="6"
        r={r}
        fill="none"
        stroke="#5e6ad2"
        strokeWidth="1.5"
        strokeDasharray={`${len * p} ${len}`}
        transform="rotate(-90 6 6)"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Avatar({ person }: { person: { name: string; avatarUrl: string | null } | null }): JSX.Element {
  if (!person) {
    return (
      <span className="avatar unassigned" title="Unassigned">
        <svg width="16" height="16" viewBox="0 0 16 16" role="img" aria-label="Unassigned">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.6" />
          <circle cx="8" cy="6.4" r="2.1" fill="currentColor" />
          <path d="M4.4 11.8 Q8 8.6 11.6 11.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  const initials = person.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <span className="avatar" title={person.name}>
      {person.avatarUrl ? <img src={person.avatarUrl} alt={person.name} /> : <span aria-label={person.name}>{initials}</span>}
    </span>
  )
}
