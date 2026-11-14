import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LinearIssue, Run } from '../../../shared/types'
import { duration, runColor, runLabel, stepColor, stripAnsi } from '../util'

interface Props {
  run: Run
  issue: LinearIssue | null
  onClose(): void
  onStop(runId: string): void
  onOpenLinear(url: string): void
}

const MAX_CHARS = 8_000_000 // keep the view responsive on runaway output

// Larger live log, shown in the main area next to the sidebar: loads the whole file, then appends output as it streams in.
export default function LogView({ run, issue, onClose, onStop, onOpenLinear }: Props): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(true)
  const logRef = useRef<HTMLPreElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let loaded = false
    let live = true
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

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Stick to the bottom while following.
  useLayoutEffect(() => {
    const el = logRef.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [text, follow, wrap])

  function onScroll(): void {
    const el = logRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (atBottom !== follow) setFollow(atBottom)
  }

  const active = run.status === 'running' || run.status === 'queued'
  const step = run.currentStep >= 0 ? run.steps[run.currentStep] : undefined

  return (
    <section className="logview" aria-label={`Live log for ${run.identifier}`}>
      <header className="logview-head">
        <button ref={closeRef} className="btn" type="button" onClick={onClose} title="Back (Esc)">
          ← Back
        </button>
        <span className="mono">{run.identifier}</span>
        <h1>{run.title}</h1>
        <span className="chip">{run.stepsName}</span>
        <span className="status">
          <span className="dot" style={{ background: runColor[run.status] }} />
          {runLabel[run.status]}
          {run.startedAt ? ` · ${duration(run.startedAt, run.endedAt)}` : ''}
        </span>
        <div className="right">
          {active && (
            <button className="btn danger" type="button" onClick={() => onStop(run.id)}>
              Stop run
            </button>
          )}
          {issue && (
            <button className="btn" type="button" onClick={() => onOpenLinear(issue.url)}>
              Open in Linear
            </button>
          )}
        </div>
      </header>

      <div className="logview-steps" aria-label="Steps">
        {run.steps.map((s, i) => (
          <span key={i} className={`logstep ${s.status}${i === run.currentStep && active ? ' current' : ''}`} title={s.command ?? s.name}>
            <span className="dot" style={{ background: stepColor[s.status] }} />
            {i + 1}. {s.name}
            {s.startedAt ? <span className="time">{duration(s.startedAt, s.endedAt)}</span> : null}
          </span>
        ))}
      </div>

      <div className="logview-body">
        <pre ref={logRef} className={`logview-log${wrap ? ' wrap' : ''}`} onScroll={onScroll} tabIndex={0} aria-live="off">
          {text === null ? 'Loading log…' : text || 'No output yet.'}
        </pre>
        <div className="logview-tools">
          <span className="mono">
            {run.branch} · {run.worktreeMode === 'agent' ? 'worktree set up by the agent' : run.worktree}
            {step && active ? ` · now: ${step.name}` : ''}
          </span>
          <label className="toggle">
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
            Wrap lines
          </label>
          {!follow && (
            <button className="btn small primary" type="button" onClick={() => setFollow(true)}>
              Jump to latest
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
