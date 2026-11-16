import type { LabelGroup, LinearIssue, LinearLabel, TeamMeta } from '../../../shared/types'
import { PRIORITY_LABEL } from './LinearIcons'

export interface Filters {
  q: string
  assignee: 'any' | 'none' | string // member id
  label: 'any' | string // label id
  priority: 'any' | number
  groups: Record<string, string> // label group id (Initiative, Area…) -> label id or 'none'; missing means any
}

export const NO_FILTERS: Filters = { q: '', assignee: 'any', label: 'any', priority: 'any', groups: {} }

export function isFiltering(f: Filters): boolean {
  return Boolean(f.q.trim()) || f.assignee !== 'any' || f.label !== 'any' || f.priority !== 'any' || Object.keys(f.groups ?? {}).length > 0
}

// "Initiative: pricing-v1" in the Initiative group reads as "pricing-v1".
export function shortLabel(label: LinearLabel, group: LabelGroup | undefined): string {
  if (!group) return label.name
  const name = label.name
  if (name.toLowerCase().startsWith(group.name.toLowerCase())) {
    const rest = name.slice(group.name.length).replace(/^\s*[:/›>-]\s*/, '')
    if (rest && rest !== name.slice(group.name.length)) return rest
  }
  return name
}

// The issue's label in a group (groups in Linear allow one label each), looked up via the team's labels.
export function groupLabel(issue: LinearIssue, groupId: string, team: TeamMeta | null | undefined): LinearLabel | undefined {
  return issue.labels.find((l) => (l.groupId ?? team?.labels.find((t) => t.id === l.id)?.groupId) === groupId)
}

export function applyFilters(issues: LinearIssue[], f: Filters, team?: TeamMeta | null): LinearIssue[] {
  const q = f.q.trim().toLowerCase()
  const groups = Object.entries(f.groups ?? {})
  return issues.filter(
    (i) =>
      (!q || i.identifier.toLowerCase().includes(q) || i.title.toLowerCase().includes(q) || i.parent?.title.toLowerCase().includes(q)) &&
      (f.assignee === 'any' || (f.assignee === 'none' ? !i.assignee : i.assignee?.id === f.assignee)) &&
      (f.label === 'any' || i.labels.some((l) => l.id === f.label)) &&
      (f.priority === 'any' || i.priority === f.priority) &&
      groups.every(([gid, want]) => {
        const has = groupLabel(i, gid, team)
        return want === 'none' ? !has : has?.id === want
      })
  )
}

interface Props {
  filters: Filters
  team: TeamMeta | null | undefined
  shown: number
  total: number
  onChange(f: Filters): void
  groupBy: string | null // label group id the board is split by
  onGroupBy(groupId: string | null): void
}

export default function FilterBar({ filters, team, shown, total, onChange, groupBy, onGroupBy }: Props): JSX.Element {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]): void => onChange({ ...filters, [k]: v })
  const groups = team?.labelGroups ?? []
  const setGroup = (gid: string, v: string): void => {
    const next = { ...(filters.groups ?? {}) }
    if (v === 'any') delete next[gid]
    else next[gid] = v
    onChange({ ...filters, groups: next })
  }
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
      {groups.map((g) => {
        const noun = g.name.toLowerCase()
        return (
          <select
            key={g.id}
            className="input filter-sel"
            aria-label={g.name}
            value={filters.groups?.[g.id] ?? 'any'}
            onChange={(e) => setGroup(g.id, e.target.value)}
          >
            <option value="any">Any {noun}</option>
            <option value="none">No {noun}</option>
            {team?.labels
              .filter((l) => l.groupId === g.id)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {shortLabel(l, g)}
                </option>
              ))}
          </select>
        )
      })}
      <select className="input filter-sel" aria-label="Label" value={filters.label} onChange={(e) => set('label', e.target.value)}>
        <option value="any">Any label</option>
        {team?.labels.filter((l) => !l.groupId).map((l) => (
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
      {groups.length > 0 && (
        <label className="filter-group">
          <span>Group by</span>
          <select className="input filter-sel" aria-label="Group by" value={groupBy ?? ''} onChange={(e) => onGroupBy(e.target.value || null)}>
            <option value="">None</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      )}
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
