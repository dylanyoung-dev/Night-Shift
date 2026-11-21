import { useEffect, useRef } from 'react'
import { isActiveRun, type LinearIssue, type Run, type StepChoice } from '../../../shared/types'
import Composer, { composerShown } from './Composer'
import LogText from './LogText'
import { duration, groupSteps, runColor, runLabel, stepColor, stripAnsi } from '../util'

export interface RunDetailsProps {
  issue: LinearIssue | null
  run: Run | null
  history?: Run[] // every run on this ticket, newest first (the latest is `run`)
  log: string
  sets: StepChoice[] // the sets of steps for the ticket's state
  onStart(issueId: string, setName: string): void
  onStop(runId: string): void
  onOpenLog(runId: string): void
}

// "5m ago", "3h ago", "2d ago"
function ago(t: number): string {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

const lastPart = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

// The Run tab of the ticket panel: facts about the latest run, every run on the ticket, the steps,
// the live log, and a footer with the reply box and the actions that can be started for the ticket's state.
export default function RunDetails({ issue, run, history, log, sets, onStart, onStop, onOpenLog }: RunDetailsProps): JSX.Element {
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const active = run && isActiveRun(run.status)
  const step = run && run.currentStep >= 0 ? run.steps[run.currentStep] : undefined
  const runs = history?.length ? history : run ? [run] : []
  const worktree = !run ? 'Not started' : run.worktreeMode === 'agent' ? 'Set up by the agent' : run.worktree ? lastPart(run.worktree) : 'Not set up yet'

  const buttons = (
    <>
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
    </>
  )

  return (
    <div className="run-tab" role="tabpanel" aria-label="Run">
      <div className="run-scroll">
        <div className="facts">
          <div className="fact">
            <div className="fact-k">In Linear</div>
            <div className="fact-v">{issue?.stateName ?? 'Not on the board'}</div>
          </div>
          <div className="fact">
            <div className="fact-k">Current step</div>
            <div className="fact-v" title={step?.name}>
              {!run ? 'No runs yet' : step ? `${step.name} · ${run.currentStep + 1}/${run.steps.length}` : run.stepsName}
            </div>
          </div>
          <div className="fact">
            <div className="fact-k">Worktree</div>
            <div className="fact-v" title={run?.worktree || undefined}>
              {worktree}
            </div>
          </div>
        </div>
        {run?.branch && <div className="run-branch mono">{run.branch}</div>}

        {runs.length > 0 && (
          <section className="run-sec" aria-label="Runs">
            <div className="sec-label">Runs</div>
            <ul className="run-list">
              {runs.map((r, i) => (
                <li key={r.id}>
                  <button type="button" className={`run-item${i === 0 ? ' latest' : ''}`} title={`Open the log of ${r.stepsName} (${runLabel[r.status]})`} onClick={() => onOpenLog(r.id)}>
                    <span className="dot" style={{ background: runColor[r.status] }} aria-hidden="true" />
                    <span className="run-item-name">
                      {r.stepsName}
                      {r.status !== 'done' && <span className="run-item-state"> · {runLabel[r.status]}</span>}
                    </span>
                    <span className="run-item-dur">{r.startedAt ? duration(r.startedAt, r.endedAt) : ''}</span>
                    <span className="run-item-ago">{i === 0 && isActiveRun(r.status) ? 'now' : ago(r.endedAt ?? r.startedAt ?? r.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {run &&
          groupSteps(run.steps).map((g) => (
            <section key={g.label} className="run-sec" aria-label={g.label}>
              <div className="sec-label">{g.label}</div>
              <ul className="step-list">
                {g.items.map(({ step: s, index }) => (
                  <li key={index} className={`step ${s.status}`}>
                    <span className="dot" style={{ background: stepColor[s.status] }} aria-hidden="true" />
                    <span className="body">
                      <span className="step-name">{s.name}</span>
                      {s.command && <span className="step-cmd">{s.command}</span>}
                      {s.type === 'claude' && run.worktree && <span className="mono">cwd {run.worktree}</span>}
                    </span>
                    <span className="time">{duration(s.startedAt, s.endedAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

        {run && (
          <section className="run-sec live" aria-label="Live log">
            <div className="sec-row">
              <div className="sec-label">Live log</div>
              <span className="spacer" />
              <button type="button" className="link-btn" onClick={() => onOpenLog(run.id)}>
                Open full log
              </button>
            </div>
            <pre className="log live-log" ref={logRef} tabIndex={0} aria-label="Live log output">
              {stripAnsi(log) ? <LogText text={stripAnsi(log)} /> : 'No output yet.'}
            </pre>
          </section>
        )}
        {!run && <div className="empty">No runs yet for this ticket.</div>}
      </div>

      <div className="run-foot">
        {run && composerShown(run) ? <Composer run={run} compact leading={buttons} /> : <div className="run-foot-actions">{buttons}</div>}
      </div>
    </div>
  )
}
