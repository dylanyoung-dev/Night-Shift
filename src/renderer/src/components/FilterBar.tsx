import { useEffect, useRef, useState } from 'react'
import type { TeamMeta } from '../../../shared/types'
import { DEFAULT_CONFIG, isDefault, sameConfig, SORTS, type SavedView, type SortKey, type ViewConfig, type ViewState } from '../boardViews'
import { activeFilters, AGENT_FILTERS, isFiltering, shortLabel, type AgentFilter, type Filters } from '../filters'
import { PRIORITY_LABEL } from './LinearIcons'
import { Icon } from './Icons'

// The bar above the board: search, the View menu (saved views), the Filters panel (what to show, the
// card order and swimlanes, as one setup) and Reset. The setup in use stays until Reset, saved or not;
// Reset goes back to all tickets and leaves saved views alone.

interface Props {
  state: ViewState
  views: SavedView[]
  team: TeamMeta | null | undefined
  shown: number
  total: number
  onChange(config: ViewConfig): void
  onPickView(id: string): void
  onSaveView(name: string): void
  onUpdateView(): void
  onDeleteView(id: string): void
  onReset(): void
}

// Closes on a click outside or on Esc (before Esc can close the ticket panel).
function usePopover(): { open: boolean; setOpen(v: boolean): void; ref: React.RefObject<HTMLDivElement> } {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return { open, setOpen, ref }
}

function SaveAs({ onSave, onDone }: { onSave(name: string): void; onDone(): void }): JSX.Element {
  const [name, setName] = useState('')
  return (
    <form
      className="view-save"
      onSubmit={(e) => {
        e.preventDefault()
        if (!name.trim()) return
        onSave(name.trim())
        onDone()
      }}
    >
      <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="View name, e.g. My agents" aria-label="View name" maxLength={60} />
      <button type="submit" className="btn small primary" disabled={!name.trim()}>
        Save
      </button>
    </form>
  )
}

export default function FilterBar({ state, views, team, shown, total, onChange, onPickView, onSaveView, onUpdateView, onDeleteView, onReset }: Props): JSX.Element {
  const { config, viewId } = state
  const filters = config.filters
  const groups = team?.labelGroups ?? []
  const setF = <K extends keyof Filters>(k: K, v: Filters[K]): void => onChange({ ...config, filters: { ...filters, [k]: v } })
  const setGroup = (gid: string, v: string): void => {
    const next = { ...(filters.groups ?? {}) }
    if (v === 'any') delete next[gid]
    else next[gid] = v
    onChange({ ...config, filters: { ...filters, groups: next } })
  }

  const view = views.find((v) => v.id === viewId) ?? null
  const modified = !!view && !sameConfig(config, view.config)
  const on = activeFilters(filters, groups)
  const arranged = config.sort !== DEFAULT_CONFIG.sort || !!config.groupBy
  const count = on.length + (arranged ? 1 : 0)
  const canReset = !isDefault(config) || !!viewId
  const nothingToSave = isDefault(config)

  const viewMenu = usePopover()
  const panel = usePopover()
  const [saving, setSaving] = useState<'menu' | 'panel' | null>(null)
  useEffect(() => {
    if (!viewMenu.open && saving === 'menu') setSaving(null)
    if (!panel.open && saving === 'panel') setSaving(null)
  }, [viewMenu.open, panel.open]) // eslint-disable-line react-hooks/exhaustive-deps

  const groupName = (id: string): string => groups.find((g) => g.id === id)?.name ?? ''
  const groupIdOf = (name: string | null): string => groups.find((g) => g.name === name)?.id ?? ''

  return (
    <div className="filterbar" role="search" aria-label="Filter tickets">
      <label className="filter-search">
        <span className="sr-only">Filter by ID or title</span>
        <Icon name="search" size={14} />
        <input className="input filter-q" type="search" placeholder="Filter by ID or title" value={filters.q} onChange={(e) => setF('q', e.target.value)} />
      </label>

      {/* Saved views */}
      <div className="filter-pop-wrap" ref={viewMenu.ref}>
        <button type="button" className={`filters-btn view-btn${view ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={viewMenu.open} onClick={() => viewMenu.setOpen(!viewMenu.open)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18M9 9v11" />
          </svg>
          <span className="view-name">{view ? view.name : 'All tickets'}</span>
          {modified && (
            <span className="view-mod" title="Changed since it was saved">
              ●
            </span>
          )}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {viewMenu.open && (
          <div className="filter-pop view-menu" role="menu">
            <div className="view-menu-head">Saved views</div>
            {!views.length && <div className="note view-empty">None yet. Set up filters, sort and swimlanes, then save them here.</div>}
            {views.map((v) => (
              <div key={v.id} className={`view-item${v.id === viewId ? ' on' : ''}`}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={v.id === viewId}
                  onClick={() => {
                    onPickView(v.id)
                    viewMenu.setOpen(false)
                  }}
                >
                  <span className="t">{v.name}</span>
                  {v.id === viewId && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m5 12 5 5 9-10" />
                    </svg>
                  )}
                </button>
                <button type="button" className="view-del" title={`Delete "${v.name}"`} aria-label={`Delete view ${v.name}`} onClick={() => onDeleteView(v.id)}>
                  ×
                </button>
              </div>
            ))}
            <div className="view-menu-sep" />
            {view && modified && (
              <button
                type="button"
                className="view-action"
                onClick={() => {
                  onUpdateView()
                  viewMenu.setOpen(false)
                }}
              >
                Update “{view.name}” with the current setup
              </button>
            )}
            {saving === 'menu' ? (
              <SaveAs onSave={onSaveView} onDone={() => viewMenu.setOpen(false)} />
            ) : (
              <button type="button" className="view-action" onClick={() => setSaving('menu')} disabled={nothingToSave}>
                Save current setup as a view…
              </button>
            )}
          </div>
        )}
      </div>

      {/* Filters, sort and swimlanes */}
      <div className="filter-pop-wrap" ref={panel.ref}>
        <button type="button" className={`filters-btn${count ? ' on' : ''}`} aria-expanded={panel.open} aria-haspopup="dialog" onClick={() => panel.setOpen(!panel.open)}>
          <Icon name="filters" size={14} />
          Filters
          {count > 0 && <span className="filters-count">{count}</span>}
          {on.length > 0 && <span className="filters-summary">{on.join(', ')}</span>}
        </button>
        {panel.open && (
          <div className="filter-pop filter-panel" role="dialog" aria-label="Filters, sort and swimlanes">
            <section>
              <h4>Show</h4>
              <label className="fp-row">
                <span>Agent activity</span>
                <select className="input filter-sel" value={filters.agents ?? 'all'} onChange={(e) => setF('agents', e.target.value as AgentFilter)}>
                  {AGENT_FILTERS.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="fp-row">
                <span>Assignee</span>
                <select className="input filter-sel" value={filters.assignee} onChange={(e) => setF('assignee', e.target.value)}>
                  <option value="any">Anyone</option>
                  <option value="none">Unassigned</option>
                  {team?.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              {groups.map((g) => (
                <label key={g.id} className="fp-row">
                  <span>{g.name}</span>
                  <select className="input filter-sel" value={filters.groups?.[g.id] ?? 'any'} onChange={(e) => setGroup(g.id, e.target.value)}>
                    <option value="any">Any</option>
                    <option value="none">No {g.name.toLowerCase()}</option>
                    {team?.labels
                      .filter((l) => l.groupId === g.id)
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {shortLabel(l, g)}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
              <label className="fp-row">
                <span>Label</span>
                <select className="input filter-sel" value={filters.label} onChange={(e) => setF('label', e.target.value)}>
                  <option value="any">Any</option>
                  {team?.labels
                    .filter((l) => !l.groupId)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="fp-row">
                <span>Priority</span>
                <select className="input filter-sel" value={String(filters.priority)} onChange={(e) => setF('priority', e.target.value === 'any' ? 'any' : Number(e.target.value))}>
                  <option value="any">Any</option>
                  {[1, 2, 3, 4, 0].map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <section>
              <h4>Arrange</h4>
              <label className="fp-row">
                <span>Sort cards by</span>
                <select className="input filter-sel" value={config.sort} onChange={(e) => onChange({ ...config, sort: e.target.value as SortKey })}>
                  {SORTS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              {groups.length > 0 && (
                <label className="fp-row">
                  <span>Swimlanes by</span>
                  <select className="input filter-sel" value={groupIdOf(config.groupBy)} onChange={(e) => onChange({ ...config, groupBy: e.target.value ? groupName(e.target.value) : null })}>
                    <option value="">None</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </section>
            <footer className="fp-foot">
              {saving === 'panel' ? (
                <SaveAs onSave={onSaveView} onDone={() => setSaving(null)} />
              ) : (
                <>
                  <button type="button" className="btn small" onClick={onReset} disabled={!canReset} title="Back to all tickets in the default order. Saved views are kept.">
                    Reset
                  </button>
                  <span className="spacer" />
                  {view && modified && (
                    <button type="button" className="btn small" onClick={onUpdateView}>
                      Update “{view.name}”
                    </button>
                  )}
                  <button type="button" className="btn small primary" onClick={() => setSaving('panel')} disabled={nothingToSave}>
                    Save as view…
                  </button>
                </>
              )}
            </footer>
          </div>
        )}
      </div>

      {isFiltering(filters) && (
        <span className="note">
          {shown} of {total} tickets
        </span>
      )}
      {canReset && (
        <button className="btn small" type="button" onClick={onReset} title="Back to all tickets in the default order. Saved views are kept.">
          Reset
        </button>
      )}
      <span className="spacer" />
    </div>
  )
}
