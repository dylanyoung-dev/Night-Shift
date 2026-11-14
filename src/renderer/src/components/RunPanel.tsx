import { useEffect, useRef } from 'react'
import { isActiveRun, type LinearIssue, type Run, type StepChoice } from '../../../shared/types'
import Composer from './Composer'
import { duration, groupSteps, runColor, runLabel, stepColor, stripAnsi } from '../util'

interface Props {
  issue: LinearIssue | null
  run: Run | null
  log: string
  sets: StepChoice[] // the sets of steps for the ticket's state
  onStart(issueId: string, setName: string): void
  onStop(runId: string): void
  onOpenLog(runId: string): void
  onOpenLinear(url: string): void
  onClose(): void
}

export default function RunPanel({ issue, run, log, sets, onStart, onStop, onOpenLog, onOpenLinear, onClose }: Props): JSX.Element {
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const identifier = issue?.identifier ?? run?.identifier ?? ''
  const title = issue?.title ?? run?.title ?? ''
  const active = run && isActiveRun(run.status)

  return (
    <aside className="panel" aria-label="Run detail">
      <div className="head">
        <span className="mono">{identifier}</span>
        {run && <span className="chip">{run.stepsName}</span>}
        {run && <span className="chip">Local</span>}
        {run && (
          <span className="state">
            <span className="dot" style={{ background: runColor[run.status] }} />
            {runLabel[run.status]}
          </span>
        )}
        <button className="icon-btn" type="button" aria-label="Close panel" title="Close (Esc)" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <h2>{title}</h2>
      {issue && <span className="mono">In Linear: {issue.stateName}</span>}
      {run && (
        <span className="mono">
          {run.branch} · {run.worktreeMode === 'agent' ? 'worktree set up by the agent' : run.worktree}
        </span>
      )}

      {!run && <div className="empty">No runs yet for this ticket.</div>}

      {run && (
        <>
          {groupSteps(run.steps).map((g) => (
            <div key={g.label}>
              <div className="grouplabel">{g.label}</div>
              {g.items.map(({ step: s, index }) => (
                <div key={index} className={`step ${s.status}`}>
                  <span className="dot" style={{ background: stepColor[s.status] }} />
                  <span className="body">
                    <span>{s.name}</span>
                    {s.command && <span className="mono">{s.command}</span>}
                    {s.type === 'claude' && run.worktree && <span className="mono">cwd {run.worktree}</span>}
                  </span>
                  <span className="time">{duration(s.startedAt, s.endedAt)}</span>
                </div>
              ))}
            </div>
          ))}

          <div className="grouplabel">Live log</div>
          <pre className="log" ref={logRef}>
            {stripAnsi(log) || 'No output yet.'}
          </pre>
          <Composer run={run} compact />
        </>
      )}

      <div className="actions">
        {issue &&
          !active &&
          sets.map((s, i) => (
            <button key={s.name} className={`btn${i === 0 ? ' primary' : ''}`} type="button" title={`Run "${s.name}"`} onClick={() => onStart(issue.id, s.name)}>
              {s.label}
            </button>
          ))}
        {issue && !active && !sets.length && <span className="note">No steps for {issue.stateName}. Add some on the Steps page.</span>}
        {run && active && (
          <button className="btn danger" type="button" onClick={() => onStop(run.id)}>
            Stop run
          </button>
        )}
        {run && (
          <button className="btn" type="button" title="Open the live log full screen" onClick={() => onOpenLog(run.id)}>
            Open
          </button>
        )}
        {issue && (
          <button className="btn" type="button" onClick={() => onOpenLinear(issue.url)}>
            Open in Linear
          </button>
        )}
      </div>
    </aside>
  )
}
