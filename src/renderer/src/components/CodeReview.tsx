import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react'
import type { LinearPullRequest, PrDraftComment, PrFile, PrFiles, PrLineComment, PrReviewEvent } from '../../../shared/types'
import { refreshPrs } from '../prStatus'
import { Icon } from './Icons'
import Markdown from './Markdown'

// The Code review tab: the pull request's changed files from GitHub, each with its diff (unified or
// side by side), a list to jump between them, "Viewed" marks that clear when a file changes again,
// comments on a line or a range of lines (like GitHub's diff view), and a footer to comment, approve
// or request changes, so a review never needs GitHub's site.
//
// Line comments: click the + beside a line to comment on it; shift-click another line on the same side
// of the same file to comment on the range. Comments wait as drafts (kept if the panel closes) and go
// to GitHub together with the review.

const filesCache = new Map<string, PrFiles>()
const BIG = 600 // diff lines; bigger files start folded

type Side = 'LEFT' | 'RIGHT'
type Draft = PrDraftComment & { id: string }
type Sel = { side: Side; start: number; end: number }

const VIEW_KEY = 'nightshift.reviewView'
const savedView = (): 'unified' | 'split' => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}
function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* per-viewer nicety only */
  }
}

// Viewed marks: per pull request, the file path and a hash of its diff, so a new push un-marks it.
const viewedKey = (url: string): string => `nightshift.viewed.${url}`
const draftsKey = (url: string): string => `nightshift.reviewDrafts.${url}`
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
const fileSig = (f: PrFile): string => hash(`${f.status}|${f.patch ?? ''}|${f.additions}|${f.deletions}`)

// ---- diff parsing ----
type Line = { kind: 'ctx' | 'add' | 'del' | 'hunk' | 'note'; text: string; old?: number; new?: number }
function parsePatch(patch: string): Line[] {
  const out: Line[] = []
  let o = 0
  let n = 0
  for (const raw of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      out.push({ kind: 'hunk', text: raw })
      continue
    }
    const c = raw[0]
    const text = raw.slice(1)
    if (c === '+') out.push({ kind: 'add', text, new: n++ })
    else if (c === '-') out.push({ kind: 'del', text, old: o++ })
    else if (c === '\\') out.push({ kind: 'note', text: raw.slice(2) })
    else out.push({ kind: 'ctx', text, old: o++, new: n++ })
  }
  return out
}
// Side by side: removed and added lines in a run are paired row by row.
type Row = { left?: Line; right?: Line; hunk?: Line }
function toRows(lines: Line[]): Row[] {
  const rows: Row[] = []
  let dels: Line[] = []
  let adds: Line[] = []
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i], right: adds[i] })
    dels = []
    adds = []
  }
  for (const l of lines) {
    if (l.kind === 'del') dels.push(l)
    else if (l.kind === 'add') adds.push(l)
    else {
      flush()
      if (l.kind === 'hunk' || l.kind === 'note') rows.push({ hunk: l })
      else rows.push({ left: l, right: l })
    }
  }
  flush()
  return rows
}
// The line a diff line is commented on: removed lines on the old side, the rest on the new side.
const anchorOf = (l: Line): { side: Side; line: number } | null =>
  l.kind === 'del' && l.old ? { side: 'LEFT', line: l.old } : (l.kind === 'add' || l.kind === 'ctx') && l.new ? { side: 'RIGHT', line: l.new } : null
const key = (side: Side, line: number): string => `${side}:${line}`

const STATUS: Record<PrFile['status'], { letter: string; tone: string; label: string }> = {
  added: { letter: 'A', tone: 'add', label: 'Added' },
  removed: { letter: 'D', tone: 'del', label: 'Deleted' },
  modified: { letter: 'M', tone: 'mod', label: 'Modified' },
  changed: { letter: 'M', tone: 'mod', label: 'Changed' },
  renamed: { letter: 'R', tone: 'ren', label: 'Renamed' },
  copied: { letter: 'C', tone: 'ren', label: 'Copied' },
  unchanged: { letter: '·', tone: 'mod', label: 'Unchanged' }
}

const splitPath = (p: string): [string, string] => {
  const i = p.lastIndexOf('/')
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)]
}
const ago = (iso: string): string => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (!Number.isFinite(s)) return ''
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function CodeReview({ prs, onOpen }: { prs: LinearPullRequest[]; onOpen(url: string): void }): JSX.Element {
  const usable = prs.filter((p) => /github\.com\/.+\/pull\/\d+/.test(p.url))
  const pick = (): string => (usable.find((p) => p.status === 'open' || p.status === 'draft') ?? usable[usable.length - 1])?.url ?? ''
  const [url, setUrl] = useState(pick)
  useEffect(() => {
    if (!usable.some((p) => p.url === url)) setUrl(pick())
  }, [usable.map((p) => p.url).join(' ')]) // eslint-disable-line react-hooks/exhaustive-deps

  const [data, setData] = useState<PrFiles | null>(() => filesCache.get(url) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  async function load(force = false): Promise<void> {
    if (!url) return
    if (!force && filesCache.has(url)) {
      setData(filesCache.get(url) ?? null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const r = (await window.nightShift.getPrFiles?.(url)) ?? { error: 'Code review needs a newer build of Night Shift.' }
      if ('error' in r) setError(r.error)
      else {
        filesCache.set(url, r)
        setData(r)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    setData(filesCache.get(url) ?? null)
    void load()
  }, [url]) // eslint-disable-line react-hooks/exhaustive-deps

  const [view, setViewState] = useState(savedView)
  const setView = (v: 'unified' | 'split'): void => {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* per-viewer nicety only */
    }
  }

  const [viewed, setViewed] = useState<Record<string, string>>(() => readJson(viewedKey(url), {}))
  useEffect(() => setViewed(readJson(viewedKey(url), {})), [url])
  const isViewed = (f: PrFile): boolean => viewed[f.path] === fileSig(f)
  function toggleViewed(f: PrFile): void {
    const next = { ...viewed }
    if (isViewed(f)) delete next[f.path]
    else next[f.path] = fileSig(f)
    setViewed(next)
    writeJson(viewedKey(url), next)
  }

  // Draft line comments, kept per pull request until the review is sent.
  const [drafts, setDraftsState] = useState<Draft[]>(() => readJson(draftsKey(url), []))
  useEffect(() => setDraftsState(readJson(draftsKey(url), [])), [url])
  function setDrafts(next: Draft[]): void {
    setDraftsState(next)
    writeJson(draftsKey(url), next)
  }
  const addDraft = (d: PrDraftComment): void => setDrafts([...drafts, { ...d, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }])
  const removeDraft = (id: string): void => setDrafts(drafts.filter((d) => d.id !== id))

  const [filter, setFilter] = useState('')
  const files = useMemo(() => [...(data?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path)), [data])
  const shown = filter.trim() ? files.filter((f) => f.path.toLowerCase().includes(filter.trim().toLowerCase())) : files
  const viewedCount = files.filter(isViewed).length
  const commentsByPath = useMemo(() => {
    const m = new Map<string, PrLineComment[]>()
    for (const c of data?.comments ?? []) m.set(c.path, [...(m.get(c.path) ?? []), c])
    return m
  }, [data])

  const [current, setCurrent] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  function jump(path: string): void {
    setCurrent(path)
    const box = bodyRef.current
    const el = box?.querySelector<HTMLElement>(`[data-file="${CSS.escape(path)}"]`)
    if (box && el) box.scrollTo({ top: el.offsetTop - box.offsetTop - 8, behavior: 'smooth' })
  }

  if (!usable.length) return <div className="empty">No pull request is linked to this ticket yet, so there&apos;s nothing to review.</div>

  return (
    <div className="cr">
      <div className="cr-top">
        {usable.length > 1 && (
          <div className="seg-tabs cr-prs" role="tablist" aria-label="Pull request">
            {usable.map((p) => (
              <button key={p.url} type="button" role="tab" aria-selected={p.url === url} className={p.url === url ? 'on' : ''} onClick={() => setUrl(p.url)}>
                #{p.number}
              </button>
            ))}
          </div>
        )}
        {data && (
          <span className="cr-sum">
            <span className="mono">{data.headRef}</span> → <span className="mono">{data.baseRef}</span>
            <span className="cr-dot">·</span>
            {data.changedFiles} {data.changedFiles === 1 ? 'file' : 'files'}
            <span className="cr-add">+{data.additions}</span>
            <span className="cr-del">−{data.deletions}</span>
            <span className="cr-dot">·</span>
            {viewedCount}/{files.length} viewed
          </span>
        )}
        <span className="spacer" />
        <div className="seg-tabs" role="radiogroup" aria-label="Diff layout">
          <button type="button" role="radio" aria-checked={view === 'unified'} className={view === 'unified' ? 'on' : ''} onClick={() => setView('unified')}>
            Unified
          </button>
          <button type="button" role="radio" aria-checked={view === 'split'} className={view === 'split' ? 'on' : ''} onClick={() => setView('split')}>
            Split
          </button>
        </div>
        <button className={`icon-btn bordered${loading ? ' spinning' : ''}`} type="button" onClick={() => void load(true)} disabled={loading} title="Reload the changes and comments from GitHub" aria-label="Reload changes">
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {error && <div className="note warn cr-msg">{error}</div>}
      {!data && !error && <div className="empty cr-msg">Loading the changes from GitHub…</div>}

      {data && (
        <div className="cr-body">
          <div className="cr-list">
            <input className="cr-filter" type="search" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter files" />
            <ul>
              {shown.map((f) => {
                const [dir, base] = splitPath(f.path)
                const st = STATUS[f.status]
                const notes = drafts.filter((d) => d.path === f.path).length + (commentsByPath.get(f.path)?.length ?? 0)
                return (
                  <li key={f.path} className={`${current === f.path ? 'on' : ''}${isViewed(f) ? ' viewed' : ''}`}>
                    <button type="button" onClick={() => jump(f.path)} title={f.path}>
                      <span className={`cr-st ${st.tone}`} title={st.label}>
                        {st.letter}
                      </span>
                      <span className="cr-name">
                        <span className="cr-base">{base}</span>
                        {dir && <span className="cr-dir">{dir}</span>}
                      </span>
                      {notes > 0 && (
                        <span className="cr-notes" title={`${notes} comment${notes === 1 ? '' : 's'}`}>
                          {notes}
                        </span>
                      )}
                      <span className="cr-n">
                        {f.additions > 0 && <span className="cr-add">+{f.additions}</span>}
                        {f.deletions > 0 && <span className="cr-del">−{f.deletions}</span>}
                      </span>
                    </button>
                  </li>
                )
              })}
              {!shown.length && <li className="note">No files match.</li>}
            </ul>
          </div>

          <div className="cr-files" ref={bodyRef}>
            {shown.map((f) => (
              <FileDiff
                key={`${url}|${f.path}`}
                file={f}
                view={view}
                viewed={isViewed(f)}
                onViewed={() => toggleViewed(f)}
                comments={commentsByPath.get(f.path)}
                drafts={drafts}
                onAddDraft={addDraft}
                onRemoveDraft={removeDraft}
              />
            ))}
          </div>
        </div>
      )}

      {data && (
        <ReviewBox
          key={url}
          url={url}
          commitId={data.headSha}
          drafts={drafts}
          onSent={() => {
            setDrafts([])
            void load(true)
          }}
          onOpen={onOpen}
        />
      )}
    </div>
  )
}

interface FileDiffProps {
  file: PrFile
  view: 'unified' | 'split'
  viewed: boolean
  onViewed(): void
  comments?: PrLineComment[]
  drafts: Draft[]
  onAddDraft(d: PrDraftComment): void
  onRemoveDraft(id: string): void
}

const FileDiff = memo(function FileDiff({ file, view, viewed, onViewed, comments, drafts: allDrafts, onAddDraft, onRemoveDraft }: FileDiffProps): JSX.Element {
  const lines = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch])
  const [open, setOpen] = useState(!viewed && lines.length <= BIG)
  useEffect(() => {
    if (viewed) setOpen(false)
  }, [viewed])
  const drafts = useMemo(() => allDrafts.filter((d) => d.path === file.path), [allDrafts, file.path])

  // The line or range being commented on; the editor opens under its last line.
  const [sel, setSel] = useState<Sel | null>(null)
  function pickLine(side: Side, line: number, extend: boolean): void {
    if (extend && sel && sel.side === side) setSel({ side, start: Math.min(sel.start, line), end: Math.max(sel.end, line) })
    else setSel({ side, start: line, end: line })
  }
  const inSel = (side: Side, line?: number): boolean => !!sel && !!line && sel.side === side && line >= sel.start && line <= sel.end

  // Threads (existing comments and replies) and drafts, by the line they end on.
  const threads = useMemo(() => {
    const m = new Map<string, PrLineComment[][]>()
    const all = comments ?? []
    for (const c of all) {
      if (c.replyTo || c.line === null) continue
      const thread = [c, ...all.filter((r) => r.replyTo === c.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))]
      const k = key(c.side, c.line)
      m.set(k, [...(m.get(k) ?? []), thread])
    }
    return m
  }, [comments])
  const outdated = (comments ?? []).filter((c) => !c.replyTo && c.line === null).length
  const draftsAt = (k: string): Draft[] => drafts.filter((d) => key(d.side, d.line) === k)

  // What goes under a row: threads, drafts and the editor, for each anchor the row has.
  function extras(keys: string[]): JSX.Element | null {
    const items: JSX.Element[] = []
    for (const k of keys) {
      for (const t of threads.get(k) ?? []) items.push(<Thread key={`t${t[0].id}`} thread={t} />)
      for (const d of draftsAt(k)) items.push(<DraftCard key={`d${d.id}`} draft={d} onRemove={() => onRemoveDraft(d.id)} />)
      if (sel && key(sel.side, sel.end) === k) {
        items.push(
          <Editor
            key="editor"
            sel={sel}
            onCancel={() => setSel(null)}
            onAdd={(body) => {
              onAddDraft({ path: file.path, side: sel.side, line: sel.end, ...(sel.start < sel.end ? { startLine: sel.start, startSide: sel.side } : {}), body })
              setSel(null)
            }}
          />
        )
      }
    }
    return items.length ? <div className="cr-extras">{items}</div> : null
  }

  const st = STATUS[file.status]
  const noteCount = drafts.length + (comments?.length ?? 0)
  return (
    <section className={`cr-file${viewed ? ' viewed' : ''}`} data-file={file.path}>
      <header className="cr-file-head">
        <button type="button" className="cr-fold" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Fold diff' : 'Show diff'}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : undefined }}>
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
        <span className={`cr-st ${st.tone}`} title={st.label}>
          {st.letter}
        </span>
        <span className="cr-path mono" title={file.path}>
          {file.previousPath ? (
            <>
              <span className="cr-dir">{file.previousPath} → </span>
              {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        {noteCount > 0 && (
          <span className="cr-notes" title={`${noteCount} comment${noteCount === 1 ? '' : 's'}${outdated ? `, ${outdated} outdated` : ''}`}>
            {noteCount}
          </span>
        )}
        <span className="cr-n">
          {file.additions > 0 && <span className="cr-add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="cr-del">−{file.deletions}</span>}
        </span>
        <label className="cr-viewed">
          <input type="checkbox" checked={viewed} onChange={onViewed} />
          Viewed
        </label>
      </header>
      {open &&
        (file.patch ? (
          <div className="cr-diff-wrap">
            {view === 'split' ? (
              <SplitDiff lines={lines} inSel={inSel} pick={pickLine} extras={extras} />
            ) : (
              <UnifiedDiff lines={lines} inSel={inSel} pick={pickLine} extras={extras} />
            )}
          </div>
        ) : (
          <div className="cr-nodiff note">{file.status === 'removed' ? 'File deleted.' : file.additions + file.deletions === 0 ? 'No text changes (binary file, or only renamed).' : "GitHub didn't send this diff because it's too big."}</div>
        ))}
      {open && outdated > 0 && <div className="cr-nodiff note">{outdated === 1 ? '1 comment is' : `${outdated} comments are`} on code that has changed since, so not shown here.</div>}
      {!open && file.patch && lines.length > BIG && !viewed && (
        <button type="button" className="cr-nodiff cr-load" onClick={() => setOpen(true)}>
          Large diff ({lines.length} lines). Show it
        </button>
      )}
    </section>
  )
})

interface DiffProps {
  lines: Line[]
  inSel(side: Side, line?: number): boolean
  pick(side: Side, line: number, extend: boolean): void
  extras(keys: string[]): JSX.Element | null
}

// The + that starts a comment; shift-click extends the selection to a range.
function AddBtn({ side, line, pick }: { side: Side; line: number; pick: DiffProps['pick'] }): JSX.Element {
  return (
    <button
      type="button"
      className="cr-add-btn"
      onClick={(e) => pick(side, line, e.shiftKey)}
      title="Comment on this line (shift-click another line for a range)"
      aria-label={`Comment on line ${line}`}
    >
      +
    </button>
  )
}

function UnifiedDiff({ lines, inSel, pick, extras }: DiffProps): JSX.Element {
  return (
    <table className="cr-diff unified">
      <tbody>
        {lines.map((l, i) => {
          if (l.kind === 'hunk' || l.kind === 'note')
            return (
              <tr key={i} className={l.kind}>
                <td className="ln" />
                <td className="ln" />
                <td className="cr-code">{l.text}</td>
              </tr>
            )
          const a = anchorOf(l)
          const keys = a ? [key(a.side, a.line), ...(l.kind === 'ctx' && l.old ? [key('LEFT', l.old)] : [])] : []
          const more = extras(keys)
          return (
            <Fragment key={i}>
              <tr className={`${l.kind}${a && inSel(a.side, a.line) ? ' sel' : ''}`}>
                <td className="ln">{l.old ?? ''}</td>
                <td className="ln">{l.new ?? ''}</td>
                <td className="cr-code">
                  {a && <AddBtn side={a.side} line={a.line} pick={pick} />}
                  <span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                  {l.text}
                </td>
              </tr>
              {more && (
                <tr className="cr-extra-row">
                  <td colSpan={3}>{more}</td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function SplitDiff({ lines, inSel, pick, extras }: DiffProps): JSX.Element {
  const rows = useMemo(() => toRows(lines), [lines])
  const side = (l: Line | undefined, which: Side): JSX.Element[] => {
    const tone = !l ? 'empty' : l.kind === 'ctx' ? 'ctx' : l.kind
    const num = l ? (which === 'LEFT' ? l.old : l.new) : undefined
    const sel = inSel(which, num) ? ' sel' : ''
    return [
      <td key={`${which}n`} className={`ln ${tone}${sel}`}>
        {num ?? ''}
      </td>,
      <td key={`${which}c`} className={`cr-code ${tone}${sel}`}>
        {l && num ? <AddBtn side={which} line={num} pick={pick} /> : null}
        {l?.text ?? ''}
      </td>
    ]
  }
  return (
    <table className="cr-diff split">
      <colgroup>
        <col className="lnc" />
        <col />
        <col className="lnc" />
        <col />
      </colgroup>
      <tbody>
        {rows.map((r, i) => {
          if (r.hunk)
            return (
              <tr key={i} className={r.hunk.kind}>
                <td className="ln" />
                <td className="cr-code" colSpan={3}>
                  {r.hunk.text}
                </td>
              </tr>
            )
          const keys = [...(r.left?.old ? [key('LEFT', r.left.old)] : []), ...(r.right?.new ? [key('RIGHT', r.right.new)] : [])]
          const more = extras(keys)
          return (
            <Fragment key={i}>
              <tr>
                {side(r.left, 'LEFT')}
                {side(r.right, 'RIGHT')}
              </tr>
              {more && (
                <tr className="cr-extra-row">
                  <td colSpan={4}>{more}</td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

const rangeLabel = (side: Side, start: number | undefined, end: number): string =>
  `${start && start < end ? `Lines ${start}–${end}` : `Line ${end}`}${side === 'LEFT' ? ' (old)' : ''}`

function Thread({ thread }: { thread: PrLineComment[] }): JSX.Element {
  const root = thread[0]
  return (
    <div className="cr-thread">
      <div className="cr-thread-range">{rangeLabel(root.side, root.startLine ?? undefined, root.line ?? 0)}</div>
      {thread.map((c) => (
        <div key={c.id} className="cr-comment">
          <div className="cr-comment-head">
            <strong>{c.author || 'Someone'}</strong>
            <span className="note">{ago(c.createdAt)}</span>
          </div>
          <div className="cr-comment-body">
            <Markdown text={c.body} />
          </div>
        </div>
      ))}
    </div>
  )
}

function DraftCard({ draft, onRemove }: { draft: Draft; onRemove(): void }): JSX.Element {
  return (
    <div className="cr-thread draft">
      <div className="cr-thread-range">
        <span className="cr-pending">Pending</span>
        {rangeLabel(draft.side, draft.startLine, draft.line)}
        <span className="spacer" />
        <button type="button" className="cr-link" onClick={onRemove}>
          Delete
        </button>
      </div>
      <div className="cr-comment-body">
        <Markdown text={draft.body} />
      </div>
    </div>
  )
}

function Editor({ sel, onCancel, onAdd }: { sel: Sel; onCancel(): void; onAdd(body: string): void }): JSX.Element {
  const [body, setBody] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <div className="cr-thread editor">
      <div className="cr-thread-range">
        {rangeLabel(sel.side, sel.start, sel.end)}
        <span className="note"> · shift-click another line to change the range</span>
      </div>
      <textarea
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Comment on this code (Markdown)…"
        rows={3}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && body.trim()) onAdd(body.trim())
        }}
      />
      <div className="cr-review-row">
        <span className="note">Ctrl+Enter to add</span>
        <span className="spacer" />
        <button type="button" className="btn small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn small primary" disabled={!body.trim()} onClick={() => onAdd(body.trim())}>
          Add to review
        </button>
      </div>
    </div>
  )
}

function ReviewBox({ url, commitId, drafts, onSent, onOpen }: { url: string; commitId: string; drafts: Draft[]; onSent(): void; onOpen(url: string): void }): JSX.Element {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState<PrReviewEvent | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const hasSomething = !!body.trim() || drafts.length > 0
  async function send(event: PrReviewEvent): Promise<void> {
    setBusy(event)
    setNote(null)
    try {
      const comments: PrDraftComment[] = drafts.map(({ id: _id, ...d }) => d)
      const r = (await window.nightShift.reviewPr?.(url, event, body, comments, commitId)) ?? { error: 'Reviewing needs a newer build of Night Shift.' }
      if ('error' in r) setNote({ ok: false, text: r.error })
      else {
        const n = comments.length ? ` with ${comments.length} line comment${comments.length === 1 ? '' : 's'}` : ''
        setNote({ ok: true, text: `${event === 'APPROVE' ? 'Approved' : event === 'REQUEST_CHANGES' ? 'Changes requested' : 'Review posted'}${n}.` })
        setBody('')
        onSent()
        void refreshPrs([url], true)
      }
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }
  return (
    <footer className="cr-review">
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Overall review comment (Markdown)…" rows={2} aria-label="Review comment" />
      <div className="cr-review-row">
        {drafts.length > 0 && (
          <span className="cr-pending">
            {drafts.length} pending line comment{drafts.length === 1 ? '' : 's'}
          </span>
        )}
        {note && <span className={`note${note.ok ? '' : ' warn'}`}>{note.text}</span>}
        <button type="button" className="cr-link" onClick={() => onOpen(`${url}/files`)}>
          Open on GitHub
        </button>
        <span className="spacer" />
        <button type="button" className="btn small" disabled={!!busy || !hasSomething} onClick={() => void send('COMMENT')}>
          {busy === 'COMMENT' ? 'Posting…' : 'Comment'}
        </button>
        <button type="button" className="btn small danger" disabled={!!busy || !hasSomething} onClick={() => void send('REQUEST_CHANGES')} title="Needs a comment saying what to change">
          {busy === 'REQUEST_CHANGES' ? 'Sending…' : 'Request changes'}
        </button>
        <button type="button" className="btn small primary" disabled={!!busy} onClick={() => void send('APPROVE')}>
          {busy === 'APPROVE' ? 'Approving…' : 'Approve'}
        </button>
      </div>
    </footer>
  )
}
