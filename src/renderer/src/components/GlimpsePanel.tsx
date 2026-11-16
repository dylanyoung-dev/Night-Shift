import { useEffect, useState } from 'react'
import type { IssueComment, IssueDetail, LinearIssue } from '../../../shared/types'
import { Avatar, DocIcon, MilestoneIcon, PRIORITY_LABEL, PriorityIcon, StatusIcon } from './LinearIcons'
import Markdown from './Markdown'

interface Props {
  issue: LinearIssue
  tab: 'ticket' | 'spec' // what to show when opened
  tabRequest: number // changes each time it's asked for, so asking again switches back
  onClose(): void
}

const MIN_W = 480
const DEFAULT_W = 760
const WIDTH_KEY = 'nightshift.glimpseWidth'

function savedWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return n >= MIN_W ? n : DEFAULT_W
  } catch {
    return DEFAULT_W
  }
}

const when = (iso: string): string =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const day = (iso: string): string => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
const stateOf = (s: { name: string; type: string; color: string }) => ({ id: s.name, name: s.name, type: s.type, color: s.color, position: 0 })

// The ticket as Linear has it, read through the API: no browser, sign-in or desktop app involved.
export default function GlimpsePanel({ issue, tab: askedTab, tabRequest, onClose }: Props): JSX.Element {
  const [width, setWidth] = useState(savedWidth)
  const [detail, setDetail] = useState<IssueDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // 'ticket', 'spec' (the spec document, once known) or a document id
  const [tab, setTab] = useState<string>(askedTab)
  useEffect(() => setTab(askedTab), [askedTab, tabRequest, issue.id])

  async function load(): Promise<void> {
    if (!window.nightShift.getIssueDetail) {
      setError('Restart Night Shift to load ticket details.')
      return
    }
    setLoading(true)
    const r = await window.nightShift.getIssueDetail(issue.id)
    setLoading(false)
    if ('error' in r) setError(r.error)
    else {
      setError(null)
      setDetail(r)
    }
  }

  // New ticket: start fresh. Same ticket after a board sync: refresh quietly.
  useEffect(() => {
    setDetail(null)
    setError(null)
  }, [issue.id])
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue])

  function startResize(e: React.PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing')
    let w = startW
    const move = (ev: PointerEvent): void => {
      w = Math.max(MIN_W, Math.min(window.innerWidth - 520, startW + (startX - ev.clientX)))
      setWidth(w)
    }
    const up = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(w)))
      } catch {
        /* per-viewer nicety only */
      }
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  const d = detail
  const docs = d?.documents ?? []
  const spec = docs.find((x) => /spec/i.test(x.title)) ?? docs[0]
  const doc = tab === 'ticket' ? null : tab === 'spec' ? spec : docs.find((x) => x.id === tab)
  const showingDoc = tab !== 'ticket'
  const openUrl = (url: string) => () => void window.nightShift.openInBrowser(url)
  const roots = d ? d.comments.filter((c) => !c.parentId || !d.comments.some((p) => p.id === c.parentId)) : []
  const replies = (id: string): IssueComment[] => (d ? d.comments.filter((c) => c.parentId === id) : [])

  return (
    <aside className="glimpse" style={{ flexBasis: width, width }} aria-label={`${issue.identifier} details from Linear`}>
      <div className="glimpse-resize" role="separator" aria-orientation="vertical" aria-label="Resize" onPointerDown={startResize} />
      <header className="glimpse-head">
        <span className="mono">{issue.identifier}</span>
        {d?.parent && (
          <button type="button" className="glimpse-crumb" onClick={openUrl(d.parent.url)} title={`${d.parent.identifier} ${d.parent.title}`}>
            › {d.parent.title}
          </button>
        )}
        <span className="spacer" />
        {loading && <span className="note">Updating…</span>}
        <button className="btn small" type="button" onClick={() => void load()} title="Reload from Linear" aria-label="Reload">
          ↻
        </button>
        <button className="btn small" type="button" onClick={openUrl(issue.url)} title="Open in your browser">
          Open in browser
        </button>
        <button className="btn small" type="button" onClick={onClose} title="Close" aria-label="Close details">
          ✕
        </button>
      </header>

      {d && (docs.length > 0 || showingDoc) && (
        <div className="glimpse-tabs" role="tablist" aria-label="Ticket and documents">
          <button type="button" role="tab" aria-selected={tab === 'ticket'} className={tab === 'ticket' ? 'on' : ''} onClick={() => setTab('ticket')}>
            Ticket
          </button>
          {docs.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={doc?.id === x.id} className={doc?.id === x.id ? 'on' : ''} onClick={() => setTab(x.id)}>
              <DocIcon /> {x.title}
            </button>
          ))}
        </div>
      )}

      <div className="glimpse-body">
        {error && <div className="note warn">{error}</div>}
        {!d && !error && <div className="empty">Loading {issue.identifier} from Linear…</div>}
        {d && showingDoc && (
          <article className="glimpse-doc">
            {doc ? (
              <>
                <div className="glimpse-doc-head">
                  <h2 className="glimpse-title">{doc.title}</h2>
                  <button className="btn small" type="button" onClick={openUrl(doc.url)} title="Open this document in your browser">
                    Open document
                  </button>
                </div>
                <div className="note">
                  Updated {when(doc.updatedAt)}
                  {doc.updatedBy ? ` by ${doc.updatedBy}` : ''}
                </div>
                {doc.content.trim() ? <Markdown text={doc.content} /> : <p className="note">This document is empty.</p>}
              </>
            ) : (
              <div className="empty">
                {d.documentsError ? `Couldn't read documents from Linear: ${d.documentsError}` : `No spec is attached to ${issue.identifier} yet.`}
              </div>
            )}
          </article>
        )}
        {d && !showingDoc && (
          <div className="glimpse-grid">
            <article className="glimpse-main">
              <h2 className="glimpse-title">{d.title}</h2>
              {d.description.trim() ? <Markdown text={d.description} /> : <p className="note">No description.</p>}

              {d.children.length > 0 && (
                <section className="glimpse-section">
                  <h3>
                    Sub-issues <span className="note">{d.children.filter((c) => c.state.type === 'completed' || c.state.type === 'canceled').length}/{d.children.length}</span>
                  </h3>
                  <ul className="glimpse-list">
                    {d.children.map((c) => (
                      <li key={c.identifier}>
                        <button type="button" onClick={openUrl(c.url)}>
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
                        <button type="button" onClick={() => setTab(x.id)}>
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
        )}
      </div>
    </aside>
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
