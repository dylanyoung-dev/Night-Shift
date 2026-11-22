import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isActiveRun, type LinearIssue, type Run, type RunStep, type StepChoice } from '../../../shared/types'
import Composer, { composerShown } from './Composer'
import LogText from './LogText'
import { parseLog, TimelineText, TimelineTool, type LogEvent } from './LogEvents'
import { Icon } from './Icons'
import { duration, runColor, runLabel, stripAnsi } from '../util'
import { useWide } from '../useWide'

interface Props {
  run: Run
  issue: LinearIssue | null
  onClose(): void
  onStop(runId: string): void
  onOpenLinear(url: string): void
  onOpenBoard?(issueId: string): void // show the ticket on the board, with its panel open
  actions: StepChoice[] // the ticket's actions (sets of steps for its current state)
  onAction(setName: string): void
}

const MAX_CHARS = 8_000_000 // keep the view responsive on runaway output
const STRUCTURED_MAX = 2_000_000 // above this the steps view would be slow; show the plain log instead

const TONE: Record<Run['status'], string> = { queued: 'queued', running: 'running', waiting: 'needs', done: 'done', failed: 'failed', stopped: 'idle' }
const STEP_LABEL: Record<RunStep['status'], string> = { pending: 'Not started', running: 'Running', waiting: 'Needs you', done: 'Done', failed: 'Failed', skipped: 'Skipped' }
const STEP_TONE: Record<RunStep['status'], string> = { pending: 'idle', running: 'running', waiting: 'needs', done: 'done', failed: 'failed', skipped: 'idle' }

// The run details view, in the main area beside the sidebar: a progress track of the steps, the log as
// one card per step (quiet script steps share a card; Claude steps get a timeline of tool calls), one bar
// for the reply box and the log tools, and a details panel (ticket, run facts, tool counts, actions).
// Loads the whole log file, then appends output as it streams in.
export default function LogView({ run, issue, onClose, onStop, onOpenBoard, actions, onAction }: Props): JSX.Element {
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

  // Esc, the keyboard's or mouse's Back button, or Alt+Left goes back to wherever the log was opened from.
  useEffect(() => {
    // One press can arrive twice (a key or mouse event and an app command); go back once.
    let last = 0
    const back = (): void => {
      if (Date.now() - last < 400) return
      last = Date.now()
      onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      const isBack = e.key === 'BrowserBack' || (e.altKey && e.key === 'ArrowLeft')
      if (e.key !== 'Escape' && !isBack) return
      // Esc in the reply box clears focus instead of leaving the page mid-sentence.
      const t = e.target as HTMLElement | null
      if (e.key === 'Escape' && t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) {
        t.blur()
        return
      }
      e.preventDefault()
      back()
    }
    const onMouse = (e: MouseEvent): void => {
      if (e.button !== 3) return // the side "back" button
      e.preventDefault()
      back()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    const offNav = window.nightShift.onNavBack?.(back) // the same press can also come as an app command
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
      offNav?.()
    }
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
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  }, [events])
  const showPanel = wide || details

  // Claude started · model · mode permissions · Claude Code version
  const tagFact = (re: RegExp): string | undefined => lastClaude?.tags.find((t) => re.test(t))
  const model = lastClaude?.tags[0]
  const perms = tagFact(/permissions$/)?.replace(/ permissions$/, '')
  const ccVersion = tagFact(/^Claude Code /)?.replace(/^Claude Code /, '')

  // The log split by step divider. Events before the first divider (Night Shift's own header) are dropped:
  // the header and the details panel say the same.
  const groups = useMemo(() => {
    const out: { idx: number | undefined; name: string; detail?: string; events: { e: LogEvent; i: number }[] }[] = []
    events.forEach((e, i) => {
      if (e.k === 'step') out.push({ idx: stepAnchor.get(i), name: e.name, detail: e.detail, events: [] })
      else if (e.k === 'head') return
      else if (out.length) out[out.length - 1].events.push({ e, i })
      else out.push({ idx: undefined, name: '', events: [{ e, i }] })
    })
    return out
  }, [events, stepAnchor])
  type Group = (typeof groups)[number]
  // A script step that finished (or was skipped) without much to show folds into a quiet row.
  const quiet = (g: Group): boolean => {
    const st = g.idx !== undefined ? run.steps[g.idx] : undefined
    if (!st || st.type === 'claude' || (st.status !== 'done' && st.status !== 'skipped')) return false
    return !g.events.some(({ e }) => e.k === 'tool' || (e.k === 'text' && e.lines.length > 3))
  }
  const [openQuiet, setOpenQuiet] = useState<Set<number>>(new Set())
  const stepNote = (st: RunStep): string =>
    st.status === 'skipped' ? 'skipped' : st.startedAt ? duration(st.startedAt, st.endedAt) : st.status === 'pending' ? '' : STEP_LABEL[st.status].toLowerCase()
  const badge = (status: RunStep['status'], n: number): JSX.Element => (
    <span className={`rd-badge ${status}`} aria-hidden="true">
      {status === 'done' ? (
        <Icon name="check" size={11} width={3} />
      ) : status === 'skipped' ? (
        <Icon name="minus" size={11} width={2.6} />
      ) : status === 'failed' ? (
        <Icon name="close" size={11} width={3} />
      ) : (
        n
      )}
    </span>
  )
  const command = (e: Extract<LogEvent, { k: 'cmd' }>, key: number): JSX.Element => (
    <div key={key} className="rd-cmd">
      <span className="rd-cmd-prompt" aria-hidden="true">
        $
      </span>
      <div className="rd-cmd-body">
        <code>{e.text}</code>
        {e.cwd && <span className="rd-cmd-cwd">in {e.cwd}</span>}
      </div>
    </div>
  )

  // Consecutive quiet steps share one card; every other step gets its own.
  const blocks: ({ kind: 'quiet'; items: Group[] } | { kind: 'step'; g: Group })[] = []
  for (const g of groups) {
    const last = blocks[blocks.length - 1]
    if (quiet(g)) {
      if (last?.kind === 'quiet') last.items.push(g)
      else blocks.push({ kind: 'quiet', items: [g] })
    } else blocks.push({ kind: 'step', g })
  }

  const logTools = (
    <>
      <button type="button" className="rd-tool" aria-pressed={wrap} onClick={() => setWrap((w) => !w)} title="Wrap long lines">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4M3 18h7M16 16l-2 2 2 2" />
        </svg>
        Wrap
      </button>
      {!showPlain && toolIds.length > 0 && (
        <button type="button" className="rd-tool" onClick={() => setOpen(allOpen ? new Set() : new Set(toolIds))}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {allOpen ? <path d="m7 15 5-5 5 5M7 9l5-5 5 5" /> : <path d="m7 9 5 5 5-5M7 15l5 5 5-5" />}
          </svg>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      )}
      <button type="button" className="rd-tool" onClick={() => void copyLog()} disabled={!text} title="Copy the whole log to the clipboard">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
        {copied ?? 'Copy log'}
      </button>
      <button
        type="button"
        className="rd-tool"
        aria-pressed={showPlain}
        disabled={tooBig}
        onClick={() => setPlain((x) => !x)}
        title={tooBig ? 'This log is too long for the steps view' : 'Show the log as plain text'}
      >
        Plain
      </button>
      <button type="button" className={`rd-tool${follow ? '' : ' strong'}`} onClick={() => setFollow(true)} title="Jump to the latest output and keep following it">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 5v14M6 13l6 6 6-6" />
        </svg>
        Latest
      </button>
    </>
  )

  const facts: [string, string, string][] = [
    ['Action', `${run.stepsName}${step ? ` · step ${run.currentStep + 1} of ${run.steps.length}` : ''}`, ''],
    ['Started', run.startedAt ? new Date(run.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '', ''],
    ['Started by', run.startedBy ?? '', ''],
    ['Model', model ?? '', 'mono-v'],
    ['Permissions', perms ?? '', ''],
    ['Claude Code', ccVersion ?? '', ''],
    ['Branch', run.branch ?? '', 'mono-v'],
    ['Worktree', run.worktreeMode === 'agent' ? 'Set up by the agent' : run.worktree || 'None', run.worktreeMode === 'agent' || !run.worktree ? '' : 'mono-v'],
    ['Folder', lastCwd ?? '', 'mono-v']
  ]

  return (
    <section className="lv rd" aria-label={`Run details for ${run.identifier}`}>
      <header className="rd-head">
        <div className="rd-head-row">
          <button ref={closeRef} className="rd-back" type="button" onClick={onClose} aria-label="Back" title="Back (Esc or your Back button)">
            <Icon name="back" size={16} />
          </button>
          <div className="rd-title">
            <div className="rd-crumbs">
              <span className="mono-path">{run.identifier}</span>
              <span aria-hidden="true">/</span>
              <span className="rd-crumb-action">
                <span className="dot" style={{ background: 'var(--accent)' }} aria-hidden="true" />
                {run.stepsName}
              </span>
              {run.startedBy && <span>· by {run.startedBy}</span>}
            </div>
            <h1 title={run.title}>{run.title}</h1>
          </div>
          <span className={`rd-state tone-${TONE[run.status]}`}>
            <span className="rd-state-dot" aria-hidden="true" />
            {runLabel[run.status]}
            {run.startedAt && <span className="rd-state-time">{duration(run.startedAt, run.endedAt)}</span>}
          </span>
          {!wide && (
            <button className="btn" type="button" aria-pressed={details} onClick={() => setDetails((d) => !d)}>
              Details
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
        </div>

        {run.steps.length > 0 && (
          <ol className="rd-track" aria-label="Steps" style={{ gridTemplateColumns: `repeat(${run.steps.length}, minmax(0, 1fr))` }}>
            {run.steps.map((st, i) => {
              const current = i === run.currentStep && active
              const state: RunStep['status'] = current && st.status === 'pending' ? 'running' : st.status
              return (
                <li key={i}>
                  <button
                    type="button"
                    className={`rd-track-step ${state}`}
                    title={st.command ?? st.name}
                    aria-current={current ? 'step' : undefined}
                    disabled={showPlain}
                    onClick={() => jumpToStep(i)}
                  >
                    <span className="rd-track-bar" aria-hidden="true">
                      <span />
                    </span>
                    <span className="rd-track-label">
                      {badge(state, i + 1)}
                      <span className="rd-track-name">{st.name}</span>
                      <span className="rd-track-note">
                        {stepNote(st)}
                        <span className="sr-only">, {STEP_LABEL[st.status]}</span>
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </header>

      <div className="lv-main">
        <div className="lv-col">
          <div ref={logRef} className={`rd-scroll${wrap ? ' wrap' : ''}`} onScroll={onScroll} tabIndex={0} aria-label="Run log" aria-live="off">
            <div className="rd-inner">
              {text === null && <p className="note">Loading log…</p>}
              {text === '' && <p className="note">No output yet.</p>}
              {run.status === 'queued' && <p className="note">Waiting for a free slot to start.</p>}
              {text && showPlain && (
                <pre className={`logview-log lv-plain rd-plain${wrap ? ' wrap' : ''}`}>
                  <LogText text={text} />
                </pre>
              )}
              {text &&
                !showPlain &&
                blocks.map((b, bi) => {
                  if (b.kind === 'quiet')
                    return (
                      <section key={bi} className="rd-card rd-quiet" aria-label="Setup steps">
                        {b.items.map((g) => {
                          const idx = g.idx as number
                          const st = run.steps[idx]
                          const isOpen = openQuiet.has(idx)
                          const firstText = g.events.find(({ e }) => e.k === 'text')?.e
                          const summary = g.detail ?? (firstText?.k === 'text' ? firstText.lines[0] : st.command ?? '')
                          return (
                            <div key={idx} className="rd-quiet-step" data-step={idx}>
                              <button
                                type="button"
                                className={`rd-quiet-row ${st.status}`}
                                aria-expanded={g.events.length ? isOpen : undefined}
                                disabled={!g.events.length}
                                onClick={() =>
                                  setOpenQuiet((prev) => {
                                    const next = new Set(prev)
                                    if (next.has(idx)) next.delete(idx)
                                    else next.add(idx)
                                    return next
                                  })
                                }
                              >
                                {badge(st.status, idx + 1)}
                                <span className="rd-quiet-name">
                                  {idx + 1}. {st.name}
                                </span>
                                <span className="rd-quiet-text">{summary}</span>
                                <span className={`rd-chip ${st.status}`}>
                                  {STEP_LABEL[st.status]}
                                  {st.status === 'done' && st.startedAt ? ` · ${duration(st.startedAt, st.endedAt)}` : ''}
                                </span>
                              </button>
                              {isOpen && (
                                <div className="rd-quiet-out">
                                  {g.events.map(({ e, i }) =>
                                    e.k === 'cmd' ? (
                                      command(e, i)
                                    ) : e.k === 'text' ? (
                                      <pre key={i} className="tl-pre">
                                        <LogText text={e.lines.join('\n')} />
                                      </pre>
                                    ) : null
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </section>
                    )
                  const g = b.g
                  const st = g.idx !== undefined ? run.steps[g.idx] : undefined
                  const current = g.idx === run.currentStep && active
                  const started = g.events.find(({ e }) => e.k === 'claude' && e.text === 'Claude started')?.e
                  const tags = started?.k === 'claude' ? started.tags : []
                  const rest = g.events.filter(({ e }) => e.k !== 'cmd' && !(e.k === 'claude' && e.text === 'Claude started'))
                  const status: RunStep['status'] | undefined = st && current && st.status === 'pending' ? 'running' : st?.status
                  return (
                    <section key={bi} className={`rd-card rd-step${current ? ' current' : ''}${st?.status === 'failed' ? ' failed' : ''}`} data-step={g.idx}>
                      {st && status && (
                        <div className="rd-step-head">
                          {badge(status, (g.idx as number) + 1)}
                          <h2>{st.name}</h2>
                          <span className={`rd-chip ${current ? 'running' : st.status}`}>
                            {current ? runLabel[run.status] : STEP_LABEL[st.status]}
                            {st.startedAt ? ` · ${duration(st.startedAt, st.endedAt)}` : ''}
                          </span>
                          <span className="spacer" />
                          {tags.map((t) => (
                            <span key={t} className="rd-tag">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                      {g.detail && <p className="rd-step-detail">{g.detail}</p>}
                      {g.events.some(({ e }) => e.k === 'cmd') && (
                        <div className="rd-cmds">{g.events.map(({ e, i }) => (e.k === 'cmd' ? command(e, i) : null))}</div>
                      )}
                      {(rest.length > 0 || (current && run.status === 'running')) && (
                        <ol className="tl">
                          {rest.map(({ e, i }) => {
                            if (e.k === 'tool') return <TimelineTool key={i} ev={e} open={open.has(e.id)} onToggle={toggle} />
                            if (e.k === 'text') return <TimelineText key={i} lines={e.lines} />
                            if (e.k === 'claude') return <TimelineText key={i} lines={[[e.text, ...e.tags].join(' · ')]} meta />
                            return null
                          })}
                          {current && run.status === 'running' && (
                            <li className="tl-item live" role="status">
                              <span className="tl-rail" aria-hidden="true">
                                <span className="tl-live-dot">
                                  <span />
                                </span>
                              </span>
                              <div className="tl-body tl-live">
                                <strong>{st?.type === 'claude' ? 'Claude is working' : `Running ${st?.name ?? 'this step'}`}</strong>
                              </div>
                            </li>
                          )}
                        </ol>
                      )}
                    </section>
                  )
                })}
            </div>
          </div>

          {/* The reply box and the log tools share one bar. */}
          <div className="rd-bar-wrap">
            <div className="rd-bar">{composerShown(run) ? <Composer run={run} bar leading={logTools} /> : <div className="rd-bar-tools">{logTools}</div>}</div>
          </div>
        </div>

        {showPanel && !wide && <button type="button" className="drawer-scrim light" aria-label="Close details" tabIndex={-1} onClick={() => setDetails(false)} />}
        {showPanel && (
          <aside className={`lv-panel rd-panel${wide ? '' : ' drawer'}`} aria-label="Run details">
            {!run.global && (
              <section className="rd-panel-sec" aria-labelledby="rd-ticket">
                <h2 id="rd-ticket" className="sec-label">
                  Ticket
                </h2>
                <button type="button" className="rd-ticket" disabled={!issue || !onOpenBoard} onClick={() => issue && onOpenBoard?.(issue.id)}>
                  <span className="rd-ticket-top">
                    <span className="mono-path">{run.identifier}</span>
                    {issue && <span className="rd-ticket-state">· {issue.stateName}</span>}
                  </span>
                  <span className="rd-ticket-title">{run.title}</span>
                  {issue && onOpenBoard ? <span className="rd-ticket-go">Open on board →</span> : <span className="note">Not on the board right now.</span>}
                </button>
              </section>
            )}

            <section className="rd-panel-sec" aria-labelledby="rd-run">
              <h2 id="rd-run" className="sec-label">
                Run
              </h2>
              <dl className="rd-facts">
                {facts
                  .filter(([, v]) => v)
                  .map(([k, v, cls]) => (
                    <div key={k} className="rd-fact">
                      <dt>{k}</dt>
                      <dd className={cls || undefined}>{v}</dd>
                    </div>
                  ))}
              </dl>
            </section>

            {toolCounts.length > 0 && (
              <section className="rd-panel-sec" aria-labelledby="rd-tools">
                <h2 id="rd-tools" className="sec-label">
                  {active ? 'Tool calls so far' : 'Tool calls'}
                </h2>
                <div className="rd-counts">
                  {toolCounts.map(([name, n]) => (
                    <div key={name} className="rd-count">
                      <span className="rd-count-n">{n}</span>
                      <span className="rd-count-name">{name}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {issue && (
              <section className="rd-panel-sec" aria-labelledby="rd-next">
                <h2 id="rd-next" className="sec-label">
                  {active ? 'When this run finishes' : 'Actions'}
                </h2>
                {actions.length === 0 ? (
                  <p className="note">No actions for {issue.stateName}.</p>
                ) : active ? (
                  <p className="note">Actions for the ticket&apos;s state show up here once the run is done.</p>
                ) : (
                  <>
                    <p className="note">
                      For {issue.identifier} in {issue.stateName}.
                    </p>
                    <div className="row-actions">
                      {actions.map((a, i) => (
                        <button key={a.name} className={`btn small${i === 0 ? ' primary' : ''}`} type="button" title={`Run "${a.name}" for ${issue.identifier}`} onClick={() => onAction(a.name)}>
                          {a.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </section>
            )}
          </aside>
        )}
      </div>
    </section>
  )
}
