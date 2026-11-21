import { useEffect, useMemo, useState } from 'react'
import { isActiveRun, type Run, type RunStatus } from '../../../shared/types'
import { duration, runColor, runLabel } from '../util'
import { useWide } from '../useWide'
import { Icon } from './Icons'

interface Props {
  runs: Run[]
  onOpen(run: Run): void // opens the run's log
  title?: string
  note?: string
  empty?: string
  live?: boolean // the Running agents page: only runs going now
  allRuns?: Run[] // every run, for "Runs on this ticket" in the details panel
  issueUrl?(issueId: string): string | undefined // the ticket in Linear, when it's on the board
  onOpenLinear?(url: string): void
  onOpenBoard?(issueId: string): void // show the ticket on the board
}

type Tab = 'all' | 'active' | 'needs' | 'queued' | 'running' | 'done' | 'failed' | 'stopped'
const TAB_LABEL: Record<Tab, string> = {
  all: 'All',
  active: 'Running',
  running: 'Running',
  needs: 'Needs you',
  queued: 'Queued',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped'
}
const inTab = (t: Tab, s: RunStatus): boolean =>
  t === 'all' ||
  (t === 'active' && isActiveRun(s)) ||
  (t === 'running' && s === 'running') ||
  (t === 'needs' && s === 'waiting') ||
  (t === 'queued' && s === 'queued') ||
  t === s

const TONE: Record<RunStatus, string> = { queued: 'queued', running: 'running', waiting: 'needs', done: 'done', failed: 'failed', stopped: 'idle' }
const secs = (r: Run): number => (r.startedAt ? Math.max(1, ((r.endedAt ?? Date.now()) - r.startedAt) / 1000) : 0)
const when = (t: number): string => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default function RunsView({
  runs,
  onOpen,
  title = 'Run history',
  note = 'Last 200 runs on this machine',
  empty = 'No runs yet.',
  live = false,
  allRuns,
  issueUrl,
  onOpenLinear,
  onOpenBoard
}: Props): JSX.Element {
  const wide = useWide()
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<Tab>('all')
  const [action, setAction] = useState<string | null>(null)
  const [grouped, setGrouped] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Each action (set of steps) gets a colour, in name order, so it stays the same between pages.
  const actions = useMemo(() => [...new Set((allRuns ?? runs).map((r) => r.stepsName))].sort((a, b) => a.localeCompare(b)), [allRuns, runs])
  const colorOf = (name: string): string => `var(--cat-${(Math.max(0, actions.indexOf(name)) % 6) + 1})`
  const shownActions = useMemo(() => [...new Set(runs.map((r) => r.stepsName))].sort((a, b) => a.localeCompare(b)), [runs])

  const tabs: Tab[] = live ? ['all', 'running', 'needs', 'queued'] : ['all', 'active', 'done', 'failed', 'stopped']
  const count = (t: Tab): number => runs.filter((r) => inTab(t, r.status)).length

  const q = query.trim().toLowerCase()
  const filtered = runs.filter(
    (r) =>
      inTab(tab, r.status) &&
      (!action || r.stepsName === action) &&
      (!q || `${r.identifier} ${r.title} ${r.stepsName} ${r.startedBy ?? ''}`.toLowerCase().includes(q))
  )
  // History: runs going now sit on top as cards; the table lists the rest. Live: everything is a card.
  const going = live ? filtered : filtered.filter((r) => isActiveRun(r.status))
  const listed = live ? [] : filtered.filter((r) => !isActiveRun(r.status))
  const lmax = Math.log(Math.max(2, ...listed.map(secs)))

  const selected = selectedId ? (allRuns ?? runs).find((r) => r.id === selectedId) ?? null : null
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const el = document.activeElement as HTMLElement | null
      if (el && el.matches('input, textarea, select')) return
      setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  // Grouped by ticket: newest ticket first, its runs oldest to newest.
  const groups = useMemo(() => {
    const order: string[] = []
    const by = new Map<string, Run[]>()
    for (const r of filtered) {
      if (!by.has(r.issueId)) {
        by.set(r.issueId, [])
        order.push(r.issueId)
      }
      by.get(r.issueId)!.push(r)
    }
    return order.map((id) => ({ id, runs: [...by.get(id)!].reverse() }))
  }, [filtered])

  const dot = (r: Run): JSX.Element => <span className="dot" style={{ background: runColor[r.status] }} aria-hidden="true" />
  const actionTag = (r: Run): JSX.Element => (
    <span className="rh-action">
      <span className="dot" style={{ background: colorOf(r.stepsName) }} aria-hidden="true" />
      <span className="rh-action-name">{r.stepsName}</span>
    </span>
  )

  const card = (r: Run): JSX.Element => {
    const step = r.currentStep >= 0 ? r.steps[r.currentStep] : undefined
    return (
      <div key={r.id} className={`rh-live tone-${TONE[r.status]}${selectedId === r.id ? ' selected' : ''}`}>
        <span className={`rh-status tone-${TONE[r.status]}`}>
          <span className="rh-pulse" aria-hidden="true" />
          {runLabel[r.status]}
        </span>
        <span className="rh-id">{r.identifier}</span>
        <button type="button" className="rh-title-btn" onClick={() => setSelectedId(r.id)} title="Show details">
          {r.title}
        </button>
        {actionTag(r)}
        {step && (
          <span className="note" title={step.name}>
            Step {r.currentStep + 1} of {r.steps.length}
          </span>
        )}
        {r.startedBy && <span className="note">by {r.startedBy}</span>}
        <span className="rh-dur">{r.startedAt ? duration(r.startedAt, r.endedAt) : 'Not started'}</span>
        <button type="button" className="btn small dark" onClick={() => onOpen(r)} aria-label={`Open the log of ${r.identifier} ${r.stepsName}`}>
          Open
        </button>
        {r.status === 'waiting' && r.waiting?.reason && <p className="rh-reason">{r.waiting.reason}</p>}
      </div>
    )
  }

  const ticketRuns = selected ? (allRuns ?? runs).filter((r) => r.issueId === selected.issueId) : []
  const linearUrl = selected && !selected.global ? issueUrl?.(selected.issueId) : undefined

  return (
    <div className="rh-page">
      <header className="rh-head">
        <h1>{title}</h1>
        <span className="note">{note}</span>
      </header>

      {runs.length > 0 && (
        <div className="rh-filters" role="search" aria-label={`Filter ${title.toLowerCase()}`}>
          <label className="filter-search">
            <span className="sr-only">Filter by ticket or title</span>
            <Icon name="search" size={14} />
            <input className="rh-q" type="search" placeholder="Filter by ticket or title" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="u-seg" role="group" aria-label="Status">
            {tabs.map((t) => (
              <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}>
                {TAB_LABEL[t]}
                <span className="seg-count">{count(t)}</span>
              </button>
            ))}
          </div>
          {shownActions.length > 1 && (
            <div className="rh-chips" role="group" aria-label="Action">
              <button type="button" className="rh-chip" aria-pressed={action === null} onClick={() => setAction(null)}>
                <span className="dot" style={{ background: 'var(--muted)' }} aria-hidden="true" />
                Any action
              </button>
              {shownActions.map((a) => (
                <button key={a} type="button" className="rh-chip" aria-pressed={action === a} onClick={() => setAction(action === a ? null : a)}>
                  <span className="dot" style={{ background: colorOf(a) }} aria-hidden="true" />
                  {a}
                </button>
              ))}
            </div>
          )}
          <span className="spacer" />
          {!live && (
            <label className="u-check">
              <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
              Group by ticket
            </label>
          )}
        </div>
      )}

      <div className="rh-main">
        <div className="rh-scroll">
          <div className="rh-body">
            {!runs.length && <div className="empty">{empty}</div>}
            {runs.length > 0 && !filtered.length && <div className="empty">No runs match these filters.</div>}

            {going.length > 0 && !grouped && (
              <section className="rh-sec" aria-labelledby="rh-now">
                <h2 id="rh-now" className="sec-label">
                  {live ? `Going now · ${going.length}` : 'Running now'}
                </h2>
                {going.map(card)}
              </section>
            )}

            {!grouped && listed.length > 0 && (
              <section className="rh-sec" aria-labelledby="rh-runs">
                <h2 id="rh-runs" className="sec-label">
                  Runs · {listed.length}
                </h2>
                <div className={`rh-table${wide ? ' wide' : ''}`} role="table" aria-label="Runs">
                  <div className="rh-row head" role="row">
                    <span role="columnheader">Status</span>
                    <span role="columnheader">Ticket</span>
                    <span role="columnheader">Title</span>
                    <span role="columnheader">Action</span>
                    <span role="columnheader">Duration</span>
                    <span role="columnheader" className="sr-only">
                      Open
                    </span>
                  </div>
                  {listed.map((r) => (
                    <div key={r.id} role="row" className={`rh-row${selectedId === r.id ? ' selected' : ''}`}>
                      <span role="cell" className={`rh-status tone-${TONE[r.status]}`}>
                        {dot(r)}
                        {runLabel[r.status]}
                      </span>
                      <span role="cell" className="rh-id">
                        {r.identifier}
                      </span>
                      <span role="cell" className="rh-title-cell">
                        <button type="button" className="rh-title-btn" title={`${r.title} · show details`} onClick={() => setSelectedId(r.id)}>
                          {r.title}
                        </button>
                        <span className="note">
                          {when(r.endedAt ?? r.startedAt ?? r.createdAt)}
                          {r.startedBy ? ` · by ${r.startedBy}` : ''}
                        </span>
                      </span>
                      <span role="cell">{actionTag(r)}</span>
                      <span role="cell" className="rh-dur-cell">
                        <span className="rh-bar" aria-hidden="true">
                          <span style={{ width: `${secs(r) ? Math.max(4, (Math.log(Math.max(2, secs(r))) / lmax) * 100) : 0}%` }} />
                        </span>
                        <span className="rh-dur">{r.startedAt ? duration(r.startedAt, r.endedAt) : '–'}</span>
                      </span>
                      <span role="cell" className="rh-open">
                        <button type="button" className="btn small" aria-label={`Open the log of ${r.identifier} ${r.stepsName}`} onClick={() => onOpen(r)}>
                          Open
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {grouped && groups.length > 0 && (
              <section className="rh-groups" aria-label="Runs grouped by ticket">
                {groups.map((g) => {
                  const first = g.runs[0]
                  const total = g.runs.reduce((sum, r) => sum + secs(r), 0)
                  return (
                    <article key={g.id} className="u-card rh-group">
                      <div className="rh-group-top">
                        <span className="rh-id">{first.identifier}</span>
                        <span className="spacer" />
                        <span className="note">
                          {g.runs.length === 1 ? '1 run' : `${g.runs.length} runs`}
                          {total ? ` · ${duration(Date.now() - total * 1000)} total` : ''}
                        </span>
                      </div>
                      <h3>{first.title}</h3>
                      <div className="rh-group-runs">
                        {g.runs.map((r, k) => (
                          <span key={r.id} className="rh-group-step">
                            <button
                              type="button"
                              className={`rh-chip run tone-${TONE[r.status]}${selectedId === r.id ? ' selected' : ''}`}
                              title={`${r.stepsName}: ${runLabel[r.status]} · show details`}
                              onClick={() => setSelectedId(r.id)}
                            >
                              <span className="dot" style={{ background: colorOf(r.stepsName) }} aria-hidden="true" />
                              {r.stepsName}
                              <span className="rh-chip-dur">{r.startedAt ? duration(r.startedAt, r.endedAt) : runLabel[r.status]}</span>
                              {r.status !== 'done' && <span className="sr-only">, {runLabel[r.status]}</span>}
                            </button>
                            {k < g.runs.length - 1 && <Icon name="arrow" size={12} width={2.2} className="rh-arrow" />}
                          </span>
                        ))}
                      </div>
                    </article>
                  )
                })}
              </section>
            )}
          </div>
        </div>

        {selected && !wide && <button type="button" className="drawer-scrim" aria-label="Close run details" tabIndex={-1} onClick={() => setSelectedId(null)} />}
        {selected && (
          <aside className={`rh-panel${wide ? '' : ' drawer'}`} aria-label="Run details">
            <header className="rh-panel-head">
              <span className="mono panel-id">{selected.identifier}</span>
              <span className={`status-pill ${TONE[selected.status]}`}>{runLabel[selected.status]}</span>
              <span className="spacer" />
              {linearUrl && onOpenLinear && (
                <button className="btn small open-linear" type="button" onClick={() => onOpenLinear(linearUrl)}>
                  Open in Linear
                  <Icon name="external" size={12} width={2.2} />
                </button>
              )}
              <button className="icon-btn" type="button" aria-label="Close run details" title="Close (Esc)" onClick={() => setSelectedId(null)}>
                <Icon name="close" size={16} />
              </button>
            </header>
            <div className="rh-panel-body">
              <h2 className="panel-title">{selected.title}</h2>
              <div className="facts">
                <div className="fact">
                  <div className="fact-k">Action</div>
                  <div className="fact-v">
                    <span className="dot" style={{ background: colorOf(selected.stepsName) }} aria-hidden="true" /> {selected.stepsName}
                  </div>
                </div>
                <div className="fact">
                  <div className="fact-k">Status</div>
                  <div className="fact-v">{runLabel[selected.status]}</div>
                </div>
                <div className="fact">
                  <div className="fact-k">Duration</div>
                  <div className="fact-v mono-v">{selected.startedAt ? duration(selected.startedAt, selected.endedAt) : 'Not started'}</div>
                </div>
              </div>
              {selected.status === 'waiting' && selected.waiting?.reason && <p className="rh-reason">{selected.waiting.reason}</p>}
              <dl className="rh-facts">
                <dt>Started</dt>
                <dd>{selected.startedAt ? when(selected.startedAt) : `Queued ${when(selected.createdAt)}`}</dd>
                {selected.endedAt && (
                  <>
                    <dt>Ended</dt>
                    <dd>{when(selected.endedAt)}</dd>
                  </>
                )}
                {selected.startedBy && (
                  <>
                    <dt>Started by</dt>
                    <dd>{selected.startedBy}</dd>
                  </>
                )}
                {selected.currentStep >= 0 && selected.steps[selected.currentStep] && (
                  <>
                    <dt>{isActiveRun(selected.status) ? 'Current step' : 'Last step'}</dt>
                    <dd>
                      {selected.steps[selected.currentStep].name} · {selected.currentStep + 1} of {selected.steps.length}
                    </dd>
                  </>
                )}
                {selected.branch && (
                  <>
                    <dt>Branch</dt>
                    <dd className="mono-v">{selected.branch}</dd>
                  </>
                )}
              </dl>
              {ticketRuns.length > 0 && (
                <section className="run-sec" aria-labelledby="rh-ticket-runs">
                  <div id="rh-ticket-runs" className="sec-label">
                    {selected.global ? 'Runs of this action' : 'Runs on this ticket'} · {ticketRuns.length}
                  </div>
                  <ul className="run-list">
                    {ticketRuns.map((r) => (
                      <li key={r.id}>
                        <button type="button" className={`run-item${r.id === selected.id ? ' latest' : ''}`} aria-current={r.id === selected.id ? 'true' : undefined} onClick={() => setSelectedId(r.id)}>
                          <span className="dot" style={{ background: runColor[r.status] }} aria-hidden="true" />
                          <span className="run-item-name">{r.stepsName}</span>
                          <span className="run-item-state">{runLabel[r.status]}</span>
                          <span className="run-item-dur">{r.startedAt ? duration(r.startedAt, r.endedAt) : ''}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
            <div className="run-foot run-foot-actions">
              <button className="btn primary" type="button" onClick={() => onOpen(selected)}>
                Open log
              </button>
              {!selected.global && onOpenBoard && issueUrl?.(selected.issueId) && (
                <button className="btn" type="button" onClick={() => onOpenBoard(selected.issueId)}>
                  Open on board
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
