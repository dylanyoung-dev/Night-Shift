import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isActiveRun, type LinearIssue, type Run, type StepChoice } from '../../../shared/types'
import Composer from './Composer'
import LogText from './LogText'
import { duration, runColor, runLabel, stepColor, stripAnsi } from '../util'

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

// Larger live log, shown in the main area next to the sidebar: loads the whole file, then appends output as it streams in.
export default function LogView({ run, issue, onClose, onStop, onOpenLinear, actions, onAction }: Props): JSX.Element {
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

  const active = isActiveRun(run.status)
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

      {issue && actions.length > 0 && (
        <div className="logview-actions" role="group" aria-label={`Actions for ${issue.identifier}`}>
          <span className="listlabel">Actions</span>
          {active ? (
            <span className="note">Available when this run finishes.</span>
          ) : (
            <>
              {actions.map((a, i) => (
                <button key={a.name} className={`btn small${i === 0 ? ' primary' : ''}`} type="button" title={`Run "${a.name}" for ${issue.identifier}`} onClick={() => onAction(a.name)}>
                  {a.label}
                </button>
              ))}
              <span className="note">for {issue.identifier} in {issue.stateName}</span>
            </>
          )}
        </div>
      )}

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
          {text === null ? 'Loading log…' : text ? <LogText text={text} /> : 'No output yet.'}
        </pre>
        <div className="logview-composer">
          <Composer run={run} />
        </div>
        <div className="logview-tools">
          <span className="mono">
            {run.branch} · {run.worktreeMode === 'agent' ? 'worktree set up by the agent' : run.worktree}
            {step && active ? ` · now: ${step.name}` : ''}
          </span>
          <label className="toggle">
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
            Wrap lines
          </label>
          <button className="btn small" type="button" onClick={() => void copyLog()} disabled={!text} title="Copy the whole log to the clipboard">
            {copied ?? 'Copy log'}
          </button>
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
