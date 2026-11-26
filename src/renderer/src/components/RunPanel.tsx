import { useEffect, useLayoutEffect, useRef } from 'react'
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

// The (i) on a run row: its steps, grouped, with how long each took. Shown on hover or focus.
function StepsInfo({ run }: { run: Run }): JSX.Element {
  const id = `steps-${run.id}`
  return (
    <span className="steps-info">
      <button type="button" className="steps-info-btn" aria-label={`Steps of ${run.stepsName}`} aria-describedby={id}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 7.2v3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="5" r=".9" fill="currentColor" />
        </svg>
      </button>
      <div className="steps-pop" role="tooltip" id={id}>
        {groupSteps(run.steps).map((g) => (
          <div key={g.label} className="steps-pop-group">
            <div className="sec-label">{g.label}</div>
            {g.items.map(({ step: s, index }) => (
              <div key={index} className={`steps-pop-step ${s.status}`}>
                <span className="dot" style={{ background: stepColor[s.status] }} aria-hidden="true" />
                <span className="steps-pop-body">
                  <span className="step-name">{s.name}</span>
                  {s.command && <span className="steps-pop-cmd">{s.command}</span>}
                </span>
                <span className="steps-pop-time">{duration(s.startedAt, s.endedAt)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </span>
  )
}

// The Run tab of the ticket panel: facts about the latest run, every run on the ticket, the steps,
// the live log, and a footer with the reply box and the actions that can be started for the ticket's state.
export default function RunDetails({ issue, run, history, log, sets, onStart, onStop, onOpenLog }: RunDetailsProps): JSX.Element {
  const logRef = useRef<HTMLPreElement>(null)
  // Follows new output only while you're at the bottom, so scrolling up to read isn't undone by the
  // next line. Another run (or ticket) starts at the bottom again.
  // Opening a ticket's run always lands at the bottom, also when the log or the panel changes size
  // after it opens (the full log arriving, fonts, the panel's sections filling in). Only your own
  // scrolling (wheel, keys, dragging the scrollbar) stops it following.
  const atBottom = useRef(true)
  const userAt = useRef(0) // when you last scrolled by hand
  const stick = (): void => {
    const el = logRef.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }
  useLayoutEffect(() => {
    atBottom.current = true
    stick()
  }, [run?.id, issue?.id])
  useLayoutEffect(stick, [log])
  useEffect(() => {
    const el = logRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(stick)
    ro.observe(el)
    return () => ro.disconnect()
  }, [run?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const byHand = (): void => {
    userAt.current = Date.now()
  }
  const onLogScroll = (): void => {
    const el = logRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (Date.now() - userAt.current < 1000) atBottom.current = bottom
    else if (!bottom) stick() // moved by a size change, not by you: stay at the bottom
  }

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
                <li key={r.id} className="run-li">
                  <button type="button" className={`run-item${i === 0 ? ' latest' : ''}`} title={`Open the log of ${r.stepsName} (${runLabel[r.status]})`} onClick={() => onOpenLog(r.id)}>
                    <span className="dot" style={{ background: runColor[r.status] }} aria-hidden="true" />
                    <span className="run-item-name">
                      {r.stepsName}
                      {r.status !== 'done' && <span className="run-item-state"> · {runLabel[r.status]}</span>}
                      {r.currentStep >= 0 && isActiveRun(r.status) && r.steps[r.currentStep] && (
                        <span className="run-item-state">
                          {' '}
                          · {r.steps[r.currentStep].name} {r.currentStep + 1}/{r.steps.length}
                        </span>
                      )}
                    </span>
                    <span className="run-item-dur">{r.startedAt ? duration(r.startedAt, r.endedAt) : ''}</span>
                    <span className="run-item-ago">{i === 0 && isActiveRun(r.status) ? 'now' : ago(r.endedAt ?? r.startedAt ?? r.createdAt)}</span>
                    <svg className="run-item-go" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </button>
                  {r.steps.length > 0 && <StepsInfo run={r} />}
                </li>
              ))}
            </ul>
          </section>
        )}

        {run && (
          <section className="run-sec live" aria-label="Live log">
            <div className="sec-row">
              <div className="sec-label">Live log</div>
            </div>
            <pre className="log live-log" ref={logRef} tabIndex={0} aria-label="Live log output" onScroll={onLogScroll} onWheel={byHand} onPointerDown={byHand} onKeyDown={byHand} onTouchMove={byHand}>
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
