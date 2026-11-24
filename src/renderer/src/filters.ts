import type { LabelGroup, LinearIssue, LinearLabel, Run, TeamMeta } from '../../shared/types'

// The board's filters and how they pick tickets. The bar that edits them is components/FilterBar.tsx;
// saving them as views is boardViews.ts.

export interface Filters {
  q: string
  assignee: 'any' | 'none' | string // member id
  label: 'any' | string // label id
  priority: 'any' | number
  groups: Record<string, string> // label group id (Initiative, Area…) -> label id or 'none'; missing means any
  agents?: AgentFilter // missing means all
}
// Agent activity: 'active' = a run going now (running, waiting on you, or queued); 'ran' = any run in the history.
export type AgentFilter = 'all' | 'active' | 'ran'
export const AGENT_FILTERS: { key: AgentFilter; label: string }[] = [
  { key: 'all', label: 'All tickets' },
  { key: 'active', label: 'Agent running now' },
  { key: 'ran', label: 'Has had agent runs' }
]

export const NO_FILTERS: Filters = { q: '', assignee: 'any', label: 'any', priority: 'any', groups: {}, agents: 'all' }

// The filters that are on, by name (not the search text).
export function activeFilters(f: Filters, groups: LabelGroup[]): string[] {
  return [
    (f.agents ?? 'all') !== 'all' ? 'Agents' : null,
    f.assignee !== 'any' ? 'Assignee' : null,
    ...groups.filter((g) => f.groups?.[g.id] !== undefined).map((g) => g.name),
    f.label !== 'any' ? 'Label' : null,
    f.priority !== 'any' ? 'Priority' : null
  ].filter((x): x is string => Boolean(x))
}

export function isFiltering(f: Filters): boolean {
  return Boolean(f.q.trim()) || activeFilters(f, []).length > 0 || Object.keys(f.groups ?? {}).length > 0
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

const ACTIVE = new Set(['queued', 'running', 'waiting'])

export function applyFilters(issues: LinearIssue[], f: Filters, team?: TeamMeta | null, runs: Run[] = []): LinearIssue[] {
  const q = f.q.trim().toLowerCase()
  const groups = Object.entries(f.groups ?? {})
  const agents = f.agents ?? 'all'
  const withRuns = agents === 'all' ? null : new Set(runs.filter((r) => !r.global && (agents === 'ran' || ACTIVE.has(r.status))).map((r) => r.issueId))
  return issues.filter(
    (i) =>
      (!withRuns || withRuns.has(i.id)) &&
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
