import type { LinearIssue, TeamMeta } from '../../../shared/types'
import { PRIORITY_LABEL } from './LinearIcons'

export interface Filters {
  q: string
  assignee: 'any' | 'none' | string // member id
  label: 'any' | string // label id
  priority: 'any' | number
}

export const NO_FILTERS: Filters = { q: '', assignee: 'any', label: 'any', priority: 'any' }

export function isFiltering(f: Filters): boolean {
  return Boolean(f.q.trim()) || f.assignee !== 'any' || f.label !== 'any' || f.priority !== 'any'
}

export function applyFilters(issues: LinearIssue[], f: Filters): LinearIssue[] {
  const q = f.q.trim().toLowerCase()
  return issues.filter(
    (i) =>
      (!q || i.identifier.toLowerCase().includes(q) || i.title.toLowerCase().includes(q) || i.parent?.title.toLowerCase().includes(q)) &&
      (f.assignee === 'any' || (f.assignee === 'none' ? !i.assignee : i.assignee?.id === f.assignee)) &&
      (f.label === 'any' || i.labels.some((l) => l.id === f.label)) &&
      (f.priority === 'any' || i.priority === f.priority)
  )
}

interface Props {
  filters: Filters
  team: TeamMeta | null | undefined
  shown: number
  total: number
  onChange(f: Filters): void
}

export default function FilterBar({ filters, team, shown, total, onChange }: Props): JSX.Element {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]): void => onChange({ ...filters, [k]: v })
  return (
    <div className="filterbar" role="search" aria-label="Filter tickets">
      <input
        className="input filter-q"
        type="search"
        placeholder="Filter by ID or title…"
        aria-label="Filter by ID or title"
        value={filters.q}
        onChange={(e) => set('q', e.target.value)}
      />
      <select className="input filter-sel" aria-label="Assignee" value={filters.assignee} onChange={(e) => set('assignee', e.target.value)}>
        <option value="any">Any assignee</option>
        <option value="none">Unassigned</option>
        {team?.members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <select className="input filter-sel" aria-label="Label" value={filters.label} onChange={(e) => set('label', e.target.value)}>
        <option value="any">Any label</option>
        {team?.labels.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <select
        className="input filter-sel"
        aria-label="Priority"
        value={String(filters.priority)}
        onChange={(e) => set('priority', e.target.value === 'any' ? 'any' : Number(e.target.value))}
      >
        <option value="any">Any priority</option>
        {[1, 2, 3, 4, 0].map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABEL[p]}
          </option>
        ))}
      </select>
      {isFiltering(filters) && (
        <>
          <span className="note">
            {shown} of {total} tickets
          </span>
          <button className="btn small" type="button" onClick={() => onChange(NO_FILTERS)}>
            Clear filters
          </button>
        </>
      )}
    </div>
  )
}
