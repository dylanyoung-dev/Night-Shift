import { useEffect, useRef, useState } from 'react'
import type { IssueComment, IssueDetail, LinearIssue } from '../../../shared/types'
import { cachedIssueDetail, useIssueDetail } from '../issueDetailCache'
import { runColor, runLabel } from '../util'
import { Icon } from './Icons'
import { Avatar, DocIcon, MilestoneIcon, PRIORITY_LABEL, PriorityIcon, StatusIcon } from './LinearIcons'
import Markdown from './Markdown'
import RunDetails, { type RunDetailsProps } from './RunPanel'
import PrStrip from './PrStrip'
import CodeReview from './CodeReview'
import { refreshPrs } from '../prStatus'

// 'run', 'ticket', 'review' (code review), 'spec' (the spec document, whichever it turns out to be) or a document id
export type PanelTab = string

interface Props extends RunDetailsProps {
  wide: boolean // docked beside the board; otherwise a drawer over it
  tabRequest: { tab: PanelTab; at: number } | null // set from the card menu ("Glimpse in Linear", "View spec")
  onOpenLinear(url: string): void
  onShowIssue?(identifier: string): boolean // select another ticket on the board; false when it isn't there
  onClose(): void
}

// One width for every tab, so opening the ticket or spec doesn't resize the panel. It is a share of
// the window (it grows on a wide screen), can be dragged by its left edge, or switched to the expanded
// width with the button in the header. Min and max are in pixels; the board keeps at least BOARD_MIN.
const WIDTH = { key: 'nightshift.panelShare', min: 380, max: 1100, def: 0.3125 } // about 600px on a 1920px screen
const EXPANDED_KEY = 'nightshift.panelExpanded'
const EXPANDED_MAX = 1800
const BOARD_MIN = 520
function savedShare(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH.key))
    return n > 0.05 && n < 0.95 ? n : WIDTH.def
  } catch {
    return WIDTH.def
  }
}
function savedExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}
function toPx(share: number, windowW: number): number {
  return Math.round(Math.max(WIDTH.min, Math.min(WIDTH.max, windowW - BOARD_MIN, share * windowW)))
}
function useWindowWidth(): number {
  const [w, setW] = useState(window.innerWidth)
  useEffect(() => {
    const on = (): void => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

const STATUS_TONE: Record<NonNullable<Props['run']>['status'], string> = {
  queued: 'queued',
  running: 'running',
  waiting: 'needs',
  done: 'done',
  failed: 'failed',
  stopped: 'idle'
}

const when = (iso: string): string => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const day = (iso: string): string => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
const stateOf = (s: { name: string; type: string; color: string }) => ({ id: s.name, name: s.name, type: s.type, color: s.color, position: 0 })

// One side panel for the selected card: Run (steps, live log, actions), Ticket (Linear's description,
// sub-issues, comments, properties) and the ticket's documents (the spec). Linear is only asked for
// the ticket's details once the Ticket or a document tab is opened; after that they're cached.
export default function TicketPanel(props: Props): JSX.Element {
  const { issue, run, tabRequest, onOpenLinear, onClose, wide } = props
  const [tab, setTab] = useState<PanelTab>(tabRequest?.tab ?? 'run')
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab)
  }, [tabRequest])
  // Another card: stay on the same kind of tab, but a document of the last ticket means "its spec".
  useEffect(() => {
    setTab((t) => (t === 'run' || t === 'ticket' || t === 'review' ? t : 'spec'))
  }, [issue?.id])
  // A ticket is "in a PR" while one of its pull requests is open (or a draft); merged or closed ones
  // have nothing left to review.
  const openPrs = (issue?.pullRequests ?? []).filter((p) => p.status === 'open' || p.status === 'draft')
  const inPr = openPrs.length > 0
  useEffect(() => {
    if (!inPr) setTab((t) => (t === 'review' ? 'run' : t))
  }, [inPr])
  const reviewing = !!issue && inPr && tab === 'review'
  const linear = !!issue && tab !== 'run' && !reviewing

  const sig = issue ? JSON.stringify(issue) : ''
  const { detail, error, loading, reload } = useIssueDetail(issue?.id ?? null, sig, linear)
  const d = linear ? detail : cachedIssueDetail(issue?.id ?? null)

  // Refresh: the ticket from Linear (card and details) and its pull requests from GitHub, all at once.
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  useEffect(() => setRefreshError(null), [issue?.id])
  async function refreshAll(): Promise<void> {
    if (!issue) return
    setRefreshing(true)
    setRefreshError(null)
    try {
      const [synced] = await Promise.all([
        window.nightShift.syncIssue?.(issue.id) ?? Promise.resolve({ ok: true as const }),
        refreshPrs(issue.pullRequests.map((p) => p.url), true)
      ])
      if (synced && 'error' in synced) setRefreshError(synced.error)
      if (linear || d) reload()
    } catch (err) {
      setRefreshError((err as Error).message)
    } finally {
      setRefreshing(false)
    }
  }
  const busy = refreshing || (linear && loading)

  const windowW = useWindowWidth()
  const [share, setShare] = useState(savedShare)
  const [expanded, setExpandedState] = useState(savedExpanded)
  function setExpanded(on: boolean): void {
    setExpandedState(on)
    try {
      localStorage.setItem(EXPANDED_KEY, on ? '1' : '0')
    } catch {
      /* per-viewer nicety only */
    }
  }
  const width = expanded ? Math.max(WIDTH.min, Math.min(EXPANDED_MAX, windowW - BOARD_MIN)) : toPx(share, windowW)
  function startResize(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    const startX = e.clientX
    const startW = Math.min(width, WIDTH.max)
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing')
    // Dragging goes back to a normal width, starting from where the panel is now.
    setExpanded(false)
    let next = share
    const move = (ev: PointerEvent): void => {
      const w = Math.max(WIDTH.min, Math.min(WIDTH.max, window.innerWidth - BOARD_MIN, startW + (startX - ev.clientX)))
      next = w / window.innerWidth
      setShare(next)
    }
    const up = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
      try {
        localStorage.setItem(WIDTH.key, next.toFixed(4))
      } catch {
        /* per-viewer nicety only */
      }
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  const docs = d?.documents ?? []
  const spec = docs.find((x) => /spec/i.test(x.title)) ?? docs[0]
  // Until the details are loaded the documents aren't known: offer "Spec" when the board says there is one.
  const docTabs = d ? docs.map((x) => ({ id: x.id, title: x.title })) : issue?.hasSpec !== false || tab === 'spec' ? [{ id: 'spec', title: 'Spec' }] : []
  const doc = tab === 'spec' ? spec : docs.find((x) => x.id === tab)
  const tabOn = (id: string): boolean => tab === id || (id !== 'run' && id !== 'ticket' && id !== 'review' && doc?.id === id) || (id === 'spec' && tab === 'spec')
  const identifier = issue?.identifier ?? run?.identifier ?? ''
  const onFile = docTabs.some((x) => tabOn(x.id))
  const fileName = onFile ? (docTabs.find((x) => tabOn(x.id))?.title ?? '') : ''

  // Files: the ticket's documents (spec, plan, …) in one dropdown instead of a tab each.
  const filesBtn = useRef<HTMLButtonElement>(null)
  const [filesAt, setFilesAt] = useState<{ top: number; right: number } | null>(null)
  useEffect(() => {
    if (!filesAt) return
    const close = (e: Event): void => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e instanceof MouseEvent && (e.target as Element | null)?.closest?.('.files-menu, .files-tab')) return
      setFilesAt(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close, true)
      window.removeEventListener('resize', close)
    }
  }, [filesAt])
  useEffect(() => setFilesAt(null), [issue?.id])
  function toggleFiles(): void {
    if (filesAt) return setFilesAt(null)
    const r = filesBtn.current?.getBoundingClientRect()
    if (r) setFilesAt({ top: r.bottom + 6, right: window.innerWidth - r.right })
  }

  const title = d?.title ?? issue?.title ?? run?.title ?? ''
  const tone = run ? STATUS_TONE[run.status] : 'idle'

  return (
    <aside
      className={`glimpse ticket-panel${wide ? '' : ' drawer'}${expanded ? ' expanded' : ''}`}
      style={wide ? { flexBasis: width, width, minWidth: Math.min(WIDTH.min, width) } : undefined}
      aria-label={`${identifier} details`}
    >
      {wide && <div className="glimpse-resize" role="separator" aria-orientation="vertical" aria-label="Resize" onPointerDown={startResize} />}
      {/* One header row: close on the left (away from the window buttons), the ticket and its status,
          then the tabs and refresh. */}
      <header className="glimpse-head panel-head">
        <button className="icon-btn panel-close" type="button" onClick={onClose} title="Close panel (Esc)" aria-label="Close panel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 7 5 5-5 5M13 7l5 5-5 5" />
          </svg>
        </button>
        <span className="panel-head-sep" aria-hidden="true" />
        <span className="mono panel-id">{identifier}</span>
        {(run || issue) && (
          <span className={`status-pill ${tone}`}>
            <span className="dot" style={{ background: run ? runColor[run.status] : 'currentColor' }} aria-hidden="true" />
            {run ? runLabel[run.status] : issue?.stateName}
          </span>
        )}
        <span className="spacer" />
        {issue && (
          <div className="seg-tabs" role="tablist" aria-label="Run, ticket and documents">
            <button type="button" role="tab" aria-selected={tab === 'run'} className={tab === 'run' ? 'on' : ''} onClick={() => setTab('run')}>
              Run
            </button>
            <button type="button" role="tab" aria-selected={tab === 'ticket'} className={tab === 'ticket' ? 'on' : ''} onClick={() => setTab('ticket')}>
              Ticket
            </button>
            {docTabs.length > 0 && (
              <button
                ref={filesBtn}
                type="button"
                role="tab"
                aria-selected={onFile}
                aria-haspopup="menu"
                aria-expanded={!!filesAt}
                className={`files-tab${onFile ? ' on' : ''}`}
                onClick={toggleFiles}
                title={onFile ? `Files: ${fileName}` : "The ticket's files (spec, plan, …)"}
              >
                Files
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            )}
            {/* Code review: last, set off by a thin divider, only while a pull request is open. */}
            {inPr && (
              <button type="button" role="tab" aria-selected={tab === 'review'} className={`cr-tab${tab === 'review' ? ' on' : ''}`} onClick={() => setTab('review')} title="Code review" aria-label="Code review">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="6" cy="6" r="2.5" />
                  <circle cx="18" cy="18" r="2.5" />
                  <path d="M6 8.5V21M13 6h3a2 2 0 0 1 2 2v7.5" />
                  <path d="m15.5 3.5-2.5 2.5 2.5 2.5" />
                </svg>
              </button>
            )}
          </div>
        )}
        {filesAt && (
          <div className="files-menu" role="menu" style={{ top: filesAt.top, right: filesAt.right }}>
            {docTabs.map((x) => (
              <button
                key={x.id}
                type="button"
                role="menuitemradio"
                aria-checked={tabOn(x.id)}
                className={tabOn(x.id) ? 'on' : ''}
                onClick={() => {
                  setTab(x.id)
                  setFilesAt(null)
                }}
                title={x.title}
              >
                <DocIcon />
                <span className="t">{x.title}</span>
                {tabOn(x.id) && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m5 12 5 5 9-10" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
        <button
          className={`icon-btn bordered${expanded ? ' on' : ''}`}
          type="button"
          onClick={() => setExpanded(!expanded)}
          title={expanded ? 'Back to the normal width' : 'Make the panel wider'}
          aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
          aria-pressed={expanded}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {expanded ? <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /> : <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />}
          </svg>
        </button>
        {issue && (
          <button
            className={`icon-btn bordered${busy ? ' spinning' : ''}`}
            type="button"
            onClick={() => void refreshAll()}
            disabled={busy}
            title={busy ? 'Refreshing…' : 'Refresh this ticket from Linear and its pull request from GitHub'}
            aria-label="Refresh ticket and pull request"
          >
            <Icon name="refresh" size={14} />
          </button>
        )}
      </header>

      <div className="panel-titleblock">
        {refreshError && <div className="note warn">{refreshError}</div>}
        {title && <h2 className="panel-title">{title}</h2>}
        {issue && <PrStrip prs={issue.pullRequests} openUrl={onOpenLinear} />}
      </div>

      {!linear && !reviewing && <RunDetails {...props} />}

      {reviewing && issue && (
        <div className="glimpse-body cr-panel" role="tabpanel">
          <CodeReview prs={openPrs} onOpen={onOpenLinear} />
        </div>
      )}

      {linear && issue && (
        <div className="glimpse-body" role="tabpanel">
          {error && <div className="note warn">{d ? `Couldn't refresh from Linear: ${error}` : error}</div>}
          {!d && !error && <div className="empty">Loading {issue.identifier} from Linear…</div>}
          {d && tab === 'ticket' && <TicketDetails d={d} onOpen={onOpenLinear} onShow={props.onShowIssue} onOpenDoc={setTab} />}
          {d && tab !== 'ticket' && (
            <article className="glimpse-doc">
              {doc ? (
                <>
                  <h2 className="glimpse-title">{doc.title}</h2>
                  <div className="note">
                    Updated {when(doc.updatedAt)}
                    {doc.updatedBy ? ` by ${doc.updatedBy}` : ''}
                  </div>
                  {doc.content.trim() ? <Markdown text={doc.content} /> : <p className="note">This document is empty.</p>}
                </>
              ) : (
                <div className="empty">{d.documentsError ? `Couldn't read documents from Linear: ${d.documentsError}` : `No spec is attached to ${issue.identifier} yet.`}</div>
              )}
            </article>
          )}
        </div>
      )}
    </aside>
  )
}

function TicketDetails({ d, onOpen, onShow, onOpenDoc }: { d: IssueDetail; onOpen(url: string): void; onShow?(identifier: string): boolean; onOpenDoc(id: string): void }): JSX.Element {
  const openUrl = (url: string) => () => onOpen(url)
  // A ticket on the board opens here; only one that isn't (done, hidden, filtered out) opens in Linear.
  const showTicket = (identifier: string, url: string) => () => onShow?.(identifier) || onOpen(url)
  const docs = d.documents ?? []
  const roots = d.comments.filter((c) => !c.parentId || !d.comments.some((p) => p.id === c.parentId))
  const replies = (id: string): IssueComment[] => d.comments.filter((c) => c.parentId === id)
  return (
    <div className="glimpse-grid">
      <article className="glimpse-main">
        {d.description.trim() ? <Markdown text={d.description} /> : <p className="note">No description.</p>}

        {d.children.length > 0 && (
          <section className="glimpse-section">
            <h3>
              Sub-issues <span className="note">{d.children.filter((c) => c.state.type === 'completed' || c.state.type === 'canceled').length}/{d.children.length}</span>
            </h3>
            <ul className="glimpse-list">
              {d.children.map((c) => (
                <li key={c.identifier}>
                  <button type="button" onClick={showTicket(c.identifier, c.url)}>
                    <StatusIcon state={stateOf(c.state)} />
                    <span className="mono">{c.identifier}</span>
                    <span className="t">{c.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {docs.length > 0 && (
          <section className="glimpse-section">
            <h3>Documents</h3>
            <ul className="glimpse-list">
              {docs.map((x) => (
                <li key={x.id}>
                  <button type="button" onClick={() => onOpenDoc(x.id)}>
                    <DocIcon />
                    <span className="t">{x.title}</span>
                    <span className="note">updated {when(x.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {d.attachments.length > 0 && (
          <section className="glimpse-section">
            <h3>Links</h3>
            <ul className="glimpse-list">
              {d.attachments.map((a) => (
                <li key={a.url}>
                  <button type="button" onClick={openUrl(a.url)} title={a.url}>
                    <span className="t">{a.title || a.url}</span>
                    {a.subtitle && <span className="note">{a.subtitle}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="glimpse-section">
          <h3>Activity</h3>
          <div className="note">
            Created {when(d.createdAt)}
            {d.creator ? ` by ${d.creator.name}` : ''} · updated {when(d.updatedAt)}
          </div>
          {roots.map((c) => (
            <div key={c.id} className="comment">
              <CommentView c={c} />
              {replies(c.id).map((r) => (
                <div key={r.id} className="comment reply">
                  <CommentView c={r} />
                </div>
              ))}
            </div>
          ))}
          {!roots.length && <div className="note">No comments.</div>}
        </section>
      </article>

      <aside className="glimpse-props" aria-label="Properties">
        <Prop label="Status">
          <StatusIcon state={stateOf(d.state)} /> {d.state.name}
        </Prop>
        <Prop label="Priority">
          <PriorityIcon priority={d.priority} /> {PRIORITY_LABEL[d.priority] ?? 'No priority'}
        </Prop>
        <Prop label="Assignee">
          <Avatar person={d.assignee} /> {d.assignee?.name ?? 'Unassigned'}
        </Prop>
        {d.estimate != null && <Prop label="Estimate">{d.estimate} points</Prop>}
        {d.labels.length > 0 && (
          <Prop label="Labels">
            <span className="glimpse-labels">
              {d.labels.map((l) => (
                <span key={l.id} className="chip">
                  <span className="dot" style={{ background: l.color }} /> {l.name}
                </span>
              ))}
            </span>
          </Prop>
        )}
        {d.project && (
          <Prop label="Project">
            <span className="dot" style={{ background: d.project.color }} /> {d.project.name}
          </Prop>
        )}
        {d.milestone && (
          <Prop label="Milestone">
            <MilestoneIcon /> {d.milestone.name}
          </Prop>
        )}
        {d.cycle && <Prop label="Cycle">{d.cycle.name || `Cycle ${d.cycle.number}`}</Prop>}
        {d.dueDate && <Prop label="Due">{day(d.dueDate)}</Prop>}
      </aside>
    </div>
  )
}

function Prop({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="glimpse-prop">
      <div className="k">{label}</div>
      <div className="v">{children}</div>
    </div>
  )
}

function CommentView({ c }: { c: IssueComment }): JSX.Element {
  return (
    <>
      <div className="comment-head">
        <Avatar person={{ name: c.author, avatarUrl: c.avatarUrl }} />
        <b>{c.author}</b>
        <span className="note">{when(c.createdAt)}</span>
      </div>
      <Markdown text={c.body} />
    </>
  )
}
