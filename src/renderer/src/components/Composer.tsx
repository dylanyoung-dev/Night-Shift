import { useEffect, useRef, useState, type ReactNode } from 'react'
import { isActiveRun, resumableStep, type Run } from '../../../shared/types'

interface Props {
  run: Run
  compact?: boolean // the ticket panel's footer
  leading?: ReactNode // other buttons for the same row (the ticket panel's actions), before Send
}

// Ended, with a Claude session to resume (and a preload new enough to do it).
const resumable = (run: Run): boolean => !isActiveRun(run.status) && resumableStep(run) >= 0 && Boolean(window.nightShift.continueRun)

// Whether the box shows at all: a Claude step that takes messages, one waiting on you, or one to resume.
export function composerShown(run: Run): boolean {
  return Boolean(run.interactive) || run.status === 'waiting' || resumable(run)
}

// Talk to a running Claude step: send a message, or finish the step so the run carries on.
// After a run ends, a reply picks its Claude session back up (e.g. answering a planner's questions).
export default function Composer({ run, compact, leading }: Props): JSX.Element | null {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const waiting = run.status === 'waiting'

  // Jump to the box when Claude starts waiting, so the person can just type.
  useEffect(() => {
    if (waiting) ref.current?.focus()
  }, [waiting])

  const ended = resumable(run)
  if (!composerShown(run)) return null

  async function send(): Promise<void> {
    if (!text.trim() || sending) return
    setSending(true)
    setError(null)
    const res = ended && window.nightShift.continueRun ? await window.nightShift.continueRun(run.id, text) : await window.nightShift.replyToRun(run.id, text)
    setSending(false)
    if ('error' in res) setError(res.error)
    else setText('')
  }

  async function finish(): Promise<void> {
    setError(null)
    const res = await window.nightShift.finishRunStep(run.id)
    if ('error' in res) setError(res.error)
  }

  return (
    <div className={`composer${waiting ? ' waiting' : ''}${ended ? ' ended' : ''}${compact ? ' compact' : ''}`}>
      {waiting && run.waiting && (
        <div className="composer-alert" role="status">
          <strong>Needs you</strong>
          <span>{run.waiting.reason}</span>
        </div>
      )}
      <label className="sr-only" htmlFor={`composer-${run.id}`}>
        Message to Claude
      </label>
      <textarea
        id={`composer-${run.id}`}
        ref={ref}
        className="composer-input"
        rows={compact ? 2 : 3}
        placeholder={
          ended
            ? 'Reply to pick this agent back up: "Go", or answers and feedback on its questions…'
            : waiting
              ? 'Reply to Claude…'
              : "Message Claude. It reads this when it finishes what it's doing…"
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter makes a new line.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
          }
        }}
      />
      {compact && error && <div className="note warn">{error}</div>}
      <div className="composer-actions">
        {leading}
        {compact ? <span className="spacer" /> : <span className="note">{error ?? 'Enter to send · Shift+Enter for a new line'}</span>}
        {!ended && (
          <button className="btn" type="button" title="End Claude's session and carry on with the next step" onClick={() => void finish()}>
            Finish step
          </button>
        )}
        <button
          className="btn primary"
          type="button"
          disabled={!text.trim() || sending}
          title={ended ? 'Resume the Claude session with your reply. It runs as a new step on this run.' : undefined}
          onClick={() => void send()}
        >
          {ended ? 'Send & continue' : 'Send'}
          {compact && (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
