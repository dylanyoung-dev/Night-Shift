import { NO_FILTERS, type Filters } from './filters'

// Board views: the filters, the card order and the swimlanes, as one setup.
//  - The setup in use stays (across restarts) until Reset, whether or not it's saved.
//  - It can be saved under a name, then picked again from the View menu. Changing a saved view's
//    setup marks it modified until it's updated or saved as a new view.
//  - Reset goes back to all tickets in the default order; saved views are kept.
// Kept per project (labels and people differ between projects), on this machine.

export type SortKey = 'activity' | 'linear' | 'priority' | 'newest' | 'oldest' | 'estimate'
export const SORTS: { key: SortKey; label: string }[] = [
  { key: 'activity', label: 'Agent activity, then Linear order' },
  { key: 'linear', label: 'Linear order' },
  { key: 'priority', label: 'Priority' },
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'estimate', label: 'Biggest estimate first' }
]

export interface ViewConfig {
  filters: Filters // the search text is kept here too, but isn't part of a saved view
  sort: SortKey
  groupBy: string | null // label group name (names survive a reload; ids are looked up)
}
export interface SavedView {
  id: string
  name: string
  config: ViewConfig
}
export interface ViewState {
  config: ViewConfig
  viewId: string | null // the saved view it started from, if any
}

export const DEFAULT_CONFIG: ViewConfig = { filters: NO_FILTERS, sort: 'activity', groupBy: null }
export const DEFAULT_STATE: ViewState = { config: DEFAULT_CONFIG, viewId: null }

const stateKey = (project: string): string => `nightshift.boardView.${project}`
const viewsKey = (project: string): string => `nightshift.savedViews.${project}`

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : null
  } catch {
    return null
  }
}
function write(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* per-viewer convenience only */
  }
}

const SORT_KEYS = new Set(SORTS.map((s) => s.key))
function cleanConfig(c: Partial<ViewConfig> | null | undefined): ViewConfig {
  const f = { ...NO_FILTERS, ...(c?.filters ?? {}) }
  return {
    filters: { ...f, groups: { ...(f.groups ?? {}) } },
    sort: c?.sort && SORT_KEYS.has(c.sort) ? c.sort : 'activity',
    groupBy: typeof c?.groupBy === 'string' && c.groupBy ? c.groupBy : null
  }
}

export function loadState(project: string): ViewState {
  const s = read<ViewState>(stateKey(project))
  if (s) return { config: cleanConfig(s.config), viewId: typeof s.viewId === 'string' ? s.viewId : null }
  // Older builds kept only the swimlanes, for every project.
  let groupBy: string | null = null
  try {
    groupBy = localStorage.getItem('nightshift.groupBy')
  } catch {
    /* none */
  }
  return { config: { ...DEFAULT_CONFIG, groupBy }, viewId: null }
}
export const saveState = (project: string, s: ViewState): void => write(stateKey(project), s)

export function loadViews(project: string): SavedView[] {
  const v = read<SavedView[]>(viewsKey(project))
  return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string').map((x) => ({ ...x, config: cleanConfig(x.config) })) : []
}
export const saveViews = (project: string, v: SavedView[]): void => write(viewsKey(project), v)

// A saved view leaves out the search text.
export const forSaving = (c: ViewConfig): ViewConfig => ({ ...c, filters: { ...c.filters, q: '' } })
export const sameConfig = (a: ViewConfig, b: ViewConfig): boolean => JSON.stringify(norm(a)) === JSON.stringify(norm(b))
function norm(c: ViewConfig): unknown {
  const f = c.filters
  const groups = Object.keys(f.groups ?? {})
    .sort()
    .map((k) => [k, f.groups[k]])
  return [f.assignee, f.label, String(f.priority), f.agents ?? 'all', groups, c.sort, c.groupBy ?? '']
}
export const isDefault = (c: ViewConfig): boolean => sameConfig(c, DEFAULT_CONFIG) && !c.filters.q.trim()
