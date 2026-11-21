import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isActiveRun, type LinearIssue, type Run, type RunStep, type StepChoice } from '../../../shared/types'
import Composer from './Composer'
import LogText from './LogText'
import { parseLog, ToolCall, toolTone, type LogEvent } from './LogEvents'
import { Icon } from './Icons'
import { duration, runColor, runLabel, stripAnsi } from '../util'
import { useWide } from '../useWide'

interface Props {
  run: Run
  issue: LinearIssue | null
  onClose(): void
  onStop(runId: string): void
  onOpenLinear(url: string): void
  actions: StepChoice[] // the ticket's actions (sets of steps for its current state)
  onAction(setName: string): void
}

const MAX_CHARS = 8_000_000 // keep the view responsive on runaway output
const STRUCTURED_MAX = 2_000_000 // above this the steps view would be slow; show the plain log instead

const TONE: Record<Run['status'], string> = { queued: 'queued', running: 'running', waiting: 'needs', done: 'done', failed: 'failed', stopped: 'idle' }
const STEP_LABEL: Record<RunStep['status'], string> = { pending: 'Not started', running: 'Running', waiting: 'Needs you', done: 'Done', failed: 'Failed', skipped: 'Skipped' }
const STEP_TONE: Record<RunStep['status'], string> = { pending: 'idle', running: 'running', waiting: 'needs', done: 'done', failed: 'failed', skipped: 'idle' }

// The run details view, in the main area beside the sidebar: a step tracker, the log as steps,
// commands and folded tool calls (or the plain log), the reply box, and a details panel.
// Loads the whole log file, then appends output as it streams in.
export default function LogView({ run, issue, onClose, onStop, onOpenLinear, actions, onAction }: Props): JSX.Element {
  const wide = useWide()
  const [text, setText] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [plain, setPlain] = useState(false)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [details, setDetails] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let loaded = false
    let live = true
    setOpen(new Set())
    // Subscribe before reading. Chunks that arrive before the read reply are already in the
    // file, so they are dropped; everything after is appended.
    const off = window.nightShift.onRunOutput((runId, chunk) => {
      if (!loaded || runId !== run.id) return
      setText((t) => ((t ?? '') + stripAnsi(chunk)).slice(-MAX_CHARS))
    })
    void window.nightShift.readLog(run.id).then((full) => {
      if (!live) return
      loaded = true
      setText(stripAnsi(full).slice(-MAX_CHARS))
    })
    return () => {
      live = false
      off()
    }
  }, [run.id])

  // The parent re-renders every second (run timers), handing over a new onClose each time. Keep the
  // latest in a ref so focus and the Esc handler are set up once per run, not on every render,
  // which used to pull focus out of the reply box.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Focus Back when a log opens, unless the person is already typing somewhere.
  useEffect(() => {
    const el = document.activeElement
    if (!el || el === document.body) closeRef.current?.focus()
  }, [run.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Esc in the reply box clears focus instead of leaving the page mid-sentence.
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) {
        t.blur()
        return
      }
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tooBig = (text?.length ?? 0) > STRUCTURED_MAX
  const showPlain = plain || tooBig
  const events = useMemo<LogEvent[]>(() => (text && !showPlain ? parseLog(text) : []), [text, showPlain])

  // Step dividers in the log, matched in order to the run's steps (for the tracker and status chips).
  const stepAnchor = useMemo(() => {
    const byEvent = new Map<number, number>()
    let from = 0
    events.forEach((e, i) => {
      if (e.k !== 'step') return
      const idx = run.steps.findIndex((s, j) => j >= from && s.name === e.name)
      if (idx >= 0) {
        byEvent.set(i, idx)
        from = idx + 1
      }
    })
    return byEvent
  }, [events, run.steps])

  // Stick to the bottom while following.
  useLayoutEffect(() => {
    const el = logRef.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [text, follow, wrap, showPlain])

  function onScroll(): void {
    const el = logRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (atBottom !== follow) setFollow(atBottom)
  }

  const [copied, setCopied] = useState<string | null>(null)
  const copyTimer = useRef<number>()
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  async function copyLog(): Promise<void> {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied('Copied')
    } catch {
      setCopied('Copy failed')
    }
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(null), 1500)
  }

  const toolIds = events.filter((e): e is Extract<LogEvent, { k: 'tool' }> => e.k === 'tool' && e.out.length > 0).map((e) => e.id)
  const allOpen = toolIds.length > 0 && toolIds.every((id) => open.has(id))
  const toggle = (id: number): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  function jumpToStep(i: number): void {
    if (showPlain) return
    const el = logRef.current?.querySelector<HTMLElement>(`[data-step="${i}"]`)
    if (!el) return
    setFollow(false)
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const active = isActiveRun(run.status)
  const step = run.currentStep >= 0 ? run.steps[run.currentStep] : undefined
  const lastClaude = [...events].reverse().find((e): e is Extract<LogEvent, { k: 'claude' }> => e.k === 'claude' && e.text === 'Claude started')
  const lastCwd = [...events].reverse().find((e): e is Extract<LogEvent, { k: 'cmd' }> => e.k === 'cmd' && !!e.cwd)?.cwd
  const toolCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of events) if (e.k === 'tool') m.set(e.tool.startsWith('Subagent') ? 'Subagent' : e.tool, (m.get(e.tool.startsWith('Subagent') ? 'Subagent' : e.tool) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  }, [events])
  const toolMax = Math.max(1, ...toolCounts.map(([, n]) => n))
  const showPanel = wide || details

  // Claude started · model · mode permissions · Claude Code version
  const tagFact = (re: RegExp): string | undefined => lastClaude?.tags.find((t) => re.test(t))
  const model = lastClaude?.tags[0]
  const perms = tagFact(/permissions$/)?.replace(/ permissions$/, '')
  const ccVersion = tagFact(/^Claude Code /)?.replace(/^Claude Code /, '')

  return (
    <section className="lv" aria-label={`Run details for ${run.identifier}`}>
      <header className="lv-head">
        <button ref={closeRef} className="icon-btn bordered lv-back" type="button" onClick={onClose} aria-label="Back" title="Back (Esc)">
          <Icon name="back" size={16} />
        </button>
        <div className="lv-title">
          <div className="lv-sub">
            <span className="mono-path">{run.identifier}</span>
            <span aria-hidden="true">·</span>
            <span className="lv-action">
              <span className="dot" style={{ background: 'var(--accent)' }} aria-hidden="true" />
              {run.stepsName}
            </span>
            {run.startedBy && <span>· by {run.startedBy}</span>}
          </div>
          <h1 title={run.title}>{run.title}</h1>
        </div>
        <span className={`lv-state tone-${TONE[run.status]}`}>
          <span className="dot" style={{ background: runColor[run.status] }} aria-hidden="true" />
          {runLabel[run.status]}
          {run.startedAt && <span className="lv-state-time">{duration(run.startedAt, run.endedAt)}</span>}
        </span>
        {!wide && (
          <button className="btn" type="button" aria-pressed={details} onClick={() => setDetails((d) => !d)}>
            Details
          </button>
        )}
        {issue && (
          <button className="btn" type="button" onClick={() => onOpenLinear(issue.url)}>
            Open in Linear
            <Icon name="external" size={12} width={2.2} />
          </button>
        )}
        {active && (
          <button className="btn danger lv-stop" type="button" onClick={() => onStop(run.id)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            Stop run
          </button>
        )}
      </header>

      {run.steps.length > 0 && (
        <nav className="lv-stepper" aria-label="Steps">
          <ol>
            {run.steps.map((s, i) => (
              <li key={i} className={i < run.steps.length - 1 ? 'grow' : undefined}>
                <button
                  type="button"
                  className={`lv-step ${s.status}${i === run.currentStep && active ? ' current' : ''}`}
                  title={s.command ?? s.name}
                  aria-current={i === run.currentStep && active ? 'step' : undefined}
                  disabled={showPlain}
                  onClick={() => jumpToStep(i)}
                >
                  <span className="lv-step-badge" aria-hidden="true">
                    {s.status === 'done' ? <Icon name="check" size={12} width={3} /> : s.status === 'skipped' ? <Icon name="minus" size={12} width={2.6} /> : s.status === 'failed' ? <Icon name="close" size={12} width={3} /> : i + 1}
                  </span>
                  <span className="lv-step-name">{s.name}</span>
                  <span className="lv-step-note">
                    {s.status === 'skipped' ? 'skipped' : s.startedAt ? duration(s.startedAt, s.endedAt) : s.status === 'pending' ? '' : STEP_LABEL[s.status].toLowerCase()}
                    <span className="sr-only">, {STEP_LABEL[s.status]}</span>
                  </span>
                </button>
                {i < run.steps.length - 1 && <span className={`lv-step-line${s.status === 'done' ? ' done' : ''}`} aria-hidden="true" />}
              </li>
            ))}
          </ol>
        </nav>
      )}

      {/* On a laptop the details panel is folded away, so finished runs keep their actions in view here. */}
      {!wide && !active && issue && actions.length > 0 && (
        <div className="lv-actions" role="group" aria-label={`Actions for ${issue.identifier}`}>
          <span className="sec-label">Actions</span>
          {actions.map((a, i) => (
            <button key={a.name} className={`btn small${i === 0 ? ' primary' : ''}`} type="button" title={`Run "${a.name}" for ${issue.identifier}`} onClick={() => onAction(a.name)}>
              {a.label}
            </button>
          ))}
          <span className="note">
            for {issue.identifier} in {issue.stateName}
          </span>
        </div>
      )}

      <div className="lv-main">
        <div className="lv-col">
          <div ref={logRef} className={`lv-scroll${wrap ? ' wrap' : ''}`} onScroll={onScroll} tabIndex={0} aria-label="Run log" aria-live="off">
            <div className="lv-inner">
              {text === null && <p className="note">Loading log…</p>}
              {text === '' && <p className="note">No output yet.</p>}
              {text && showPlain && (
                <pre className={`logview-log lv-plain${wrap ? ' wrap' : ''}`}>
                  <LogText text={text} />
                </pre>
              )}
              {text &&
                !showPlain &&
                events.map((e, i) => {
                  if (e.k === 'head')
                    return (
                      <div key={i} className="lv-banner">
                        <span className="brand-tile small" aria-hidden="true">
                          <Icon name="moon" size={14} />
                        </span>
                        <span className="lv-banner-text">Night Shift: {e.text}</span>
                        {e.sub && <span className="note">{e.sub}</span>}
                      </div>
                    )
                  if (e.k === 'step') {
                    const idx = stepAnchor.get(i)
                    const s = idx !== undefined ? run.steps[idx] : undefined
                    return (
                      <div key={i} className="lv-divider" data-step={idx}>
                        <span className="lv-divider-title">
                          {idx !== undefined ? `${idx + 1} · ` : ''}
                          {e.name}
                        </span>
                        {s && (
                          <span className={`status-pill ${STEP_TONE[s.status]}`}>
                            {STEP_LABEL[s.status]}
                            {s.startedAt ? ` · ${duration(s.startedAt, s.endedAt)}` : ''}
                          </span>
                        )}
                        <span className="lv-divider-line" aria-hidden="true" />
                        {e.detail && <p className="lv-divider-text">{e.detail}</p>}
                      </div>
                    )
                  }
                  if (e.k === 'cmd')
                    return (
                      <div key={i} className="lv-cmd live-log">
                        <div className="lv-cmd-text">
                          <LogText text={`$ ${e.text}`} />
                        </div>
                        {e.cwd && <div className="lv-cmd-cwd">in {e.cwd}</div>}
                      </div>
                    )
                  if (e.k === 'claude')
                    return (
                      <div key={i} className={`lv-meta${/error/i.test(e.text) ? ' bad' : ''}`}>
                        <span className="dot" aria-hidden="true" />
                        <span className="lv-meta-text">{e.text}</span>
                        {e.tags.map((t) => (
                          <span key={t} className="lv-tag">
                            {t}
                          </span>
                        ))}
                      </div>
                    )
                  if (e.k === 'tool') return <ToolCall key={i} ev={e} open={open.has(e.id)} onToggle={toggle} />
                  return (
                    <pre key={i} className="lv-pre lv-text">
                      <LogText text={e.lines.join('\n')} />
                    </pre>
                  )
                })}
              {active && run.status === 'running' && step && (
                <div className="lv-working" role="status">
                  <span className="lv-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  {step.type === 'claude' ? `Claude is working on ${step.name}` : `Running ${step.name}`}
                </div>
              )}
              {run.status === 'queued' && <p className="note">Waiting for a free slot to start.</p>}
            </div>
          </div>

          <div className="lv-composer">
            <div className="lv-composer-inner">
              <Composer run={run} />
            </div>
          </div>

          <div className="lv-tools">
            <span className="lv-branch" title={run.branch}>
              <Icon name="branch" size={12} width={2.2} />
              {run.branch || 'No branch'}
            </span>
            <span className="spacer" />
            <label className="u-check">
              <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
              Wrap lines
            </label>
            <label className="u-check" title={tooBig ? 'This log is too long for the steps view' : undefined}>
              <input type="checkbox" checked={showPlain} disabled={tooBig} onChange={(e) => setPlain(e.target.checked)} />
              Plain log
            </label>
            <button className="btn small" type="button" onClick={() => void copyLog()} disabled={!text} title="Copy the whole log to the clipboard">
              {copied ?? 'Copy log'}
            </button>
            {!showPlain && toolIds.length > 0 && (
              <button className="btn small" type="button" onClick={() => setOpen(allOpen ? new Set() : new Set(toolIds))}>
                {allOpen ? 'Collapse all' : 'Expand all'}
              </button>
            )}
            {!follow && (
              <button className="btn small dark" type="button" onClick={() => setFollow(true)}>
                Jump to latest ↓
              </button>
            )}
          </div>
        </div>

        {showPanel && !wide && <button type="button" className="drawer-scrim light" aria-label="Close details" tabIndex={-1} onClick={() => setDetails(false)} />}
        {showPanel && (
          <aside className={`lv-panel${wide ? '' : ' drawer'}`} aria-label="Run details">
            <section className="lv-panel-sec" aria-labelledby="lv-run">
              <h2 id="lv-run" className="sec-label">
                Run
              </h2>
              <dl className="rh-facts lv-facts">
                {!run.global && (
                  <>
                    <dt>Ticket</dt>
                    <dd>
                      {run.identifier}
                      {issue ? ` · ${issue.stateName}` : ''}
                    </dd>
                  </>
                )}
                <dt>Action</dt>
                <dd>
                  {run.stepsName}
                  {step ? ` · step ${run.currentStep + 1} of ${run.steps.length}` : ''}
                </dd>
                <dt>Status</dt>
                <dd>
                  {runLabel[run.status]}
                  {run.startedAt ? ` · ${duration(run.startedAt, run.endedAt)}` : ''}
                </dd>
                {run.startedAt && (
                  <>
                    <dt>Started</dt>
                    <dd>{new Date(run.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</dd>
                  </>
                )}
                {run.startedBy && (
                  <>
                    <dt>Started by</dt>
                    <dd>{run.startedBy}</dd>
                  </>
                )}
                {model && (
                  <>
                    <dt>Model</dt>
                    <dd className="mono-v">{model}</dd>
                  </>
                )}
                {perms && (
                  <>
                    <dt>Permissions</dt>
                    <dd>{perms}</dd>
                  </>
                )}
                {ccVersion && (
                  <>
                    <dt>Claude Code</dt>
                    <dd>{ccVersion}</dd>
                  </>
                )}
                {run.branch && (
                  <>
                    <dt>Branch</dt>
                    <dd className="mono-v">{run.branch}</dd>
                  </>
                )}
                <dt>Worktree</dt>
                <dd className={run.worktreeMode === 'agent' || !run.worktree ? undefined : 'mono-v'}>
                  {run.worktreeMode === 'agent' ? 'Set up by the agent' : run.worktree || 'None'}
                </dd>
                {lastCwd && (
                  <>
                    <dt>Folder</dt>
                    <dd className="mono-v">{lastCwd}</dd>
                  </>
                )}
              </dl>
            </section>

            {toolCounts.length > 0 && (
              <section className="lv-panel-sec" aria-labelledby="lv-tools">
                <h2 id="lv-tools" className="sec-label">
                  {active ? 'Tool calls so far' : 'Tool calls'}
                </h2>
                <ul className="lv-counts">
                  {toolCounts.map(([name, n]) => (
                    <li key={name}>
                      <span className="lv-count-name">{name}</span>
                      <span className="lv-count-bar" aria-hidden="true">
                        <span className={toolTone(name)} style={{ width: `${(n / toolMax) * 100}%` }} />
                      </span>
                      <span className="lv-count-n">{n}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {issue && actions.length > 0 && (
              <section className="lv-panel-sec" aria-labelledby="lv-actions">
                <h2 id="lv-actions" className="sec-label">
                  Actions
                </h2>
                <p className="note">{active ? 'Available when this run finishes.' : `For ${issue.identifier} in ${issue.stateName}.`}</p>
                <div className="row-actions">
                  {actions.map((a, i) => (
                    <button
                      key={a.name}
                      className={`btn small${i === 0 && !active ? ' primary' : ''}`}
                      type="button"
                      disabled={active}
                      title={`Run "${a.name}" for ${issue.identifier}`}
                      onClick={() => onAction(a.name)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </aside>
        )}
      </div>
    </section>
  )
}
