import { useEffect, useRef } from 'react'
import { isActiveRun, type LinearIssue, type Run, type StepChoice } from '../../../shared/types'
import Composer from './Composer'
import LogText from './LogText'
import { duration, groupSteps, stepColor, stripAnsi } from '../util'

export interface RunDetailsProps {
  issue: LinearIssue | null
  run: Run | null
  log: string
  sets: StepChoice[] // the sets of steps for the ticket's state
  onStart(issueId: string, setName: string): void
  onStop(runId: string): void
  onOpenLog(runId: string): void
}

// The Run tab of the ticket panel: the latest run's steps, live log and reply box, and the actions
// that can be started for the ticket's state.
export default function RunDetails({ issue, run, log, sets, onStart, onStop, onOpenLog }: RunDetailsProps): JSX.Element {
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const title = issue?.title ?? run?.title ?? ''
  const active = run && isActiveRun(run.status)

  return (
    <div className="panel run-body" role="tabpanel" aria-label="Run">
      <h2>{title}</h2>
      {issue && <span className="mono">In Linear: {issue.stateName}</span>}
      {run && (
        <span className="mono">
          {run.stepsName} · {run.branch} · {run.worktreeMode === 'agent' ? 'worktree set up by the agent' : run.worktree}
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
            {stripAnsi(log) ? <LogText text={stripAnsi(log)} /> : 'No output yet.'}
          </pre>
          <Composer run={run} compact />
        </>
      )}

      <div className="actions">
        {issue && !active && sets.length > 0 && <span className="listlabel actions-label">Actions</span>}
        {issue &&
          !active &&
          sets.map((s, i) => (
            <button key={s.name} className={`btn${i === 0 ? ' primary' : ''}`} type="button" title={`Run "${s.name}"`} onClick={() => onStart(issue.id, s.name)}>
              {s.label}
            </button>
          ))}
        {issue && !active && !sets.length && <span className="note">No actions for {issue.stateName}. Add one on the Actions page.</span>}
        {run && active && (
          <button className="btn danger" type="button" onClick={() => onStop(run.id)}>
            Stop run
          </button>
        )}
        {run && (
          <button className="btn" type="button" title="Open the live log full screen" onClick={() => onOpenLog(run.id)}>
            Open log
          </button>
        )}
      </div>
    </div>
  )
}
