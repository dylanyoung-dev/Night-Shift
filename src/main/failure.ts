// What Night Shift does to a ticket in Linear when a run ends: on failure, label it, comment and
// send it back (so an automation on that state gives it another run); on success, clear the label.
import { DEFAULT_FAILURE_LABEL, DEFAULT_FAILURE_RETRIES, type Run, type StepSet } from '../shared/types'

export interface FailurePlan {
  addLabel?: string
  removeLabel?: string
  moveTo?: string // undefined: leave the ticket where it is
  comment?: string // markdown
  note: string // one line for the run log
}

const COMMENT_LOG_LINES = 25
const COMMENT_LOG_CHARS = 3000

// Failed runs of this set for this ticket in a row, newest first, counting this one.
// Runs you stopped don't count either way; a run that finished breaks the streak.
export function failuresInARow(run: Run, history: Run[]): number {
  let n = 0
  for (const r of history) {
    if (r.issueId !== run.issueId || r.stepsName !== run.stepsName) continue
    if (r.status === 'failed') n++
    else if (r.status === 'done') break
  }
  return n
}

export function planAfterRun(run: Run, def: StepSet, history: Run[]): FailurePlan | null {
  const f = def.onFailure
  if (!f) return null
  const label = f.label ?? DEFAULT_FAILURE_LABEL
  if (run.status === 'done') return { removeLabel: label, note: '' }
  if (run.status !== 'failed') return null

  const retries = f.retries ?? DEFAULT_FAILURE_RETRIES
  const failures = Math.max(1, failuresInARow(run, history))
  const sendBack = Boolean(f.moveTo) && failures <= retries
  const failed = run.steps.find((s) => s.status === 'failed')
  const where = failed ? ` at step "${failed.name}"` : ''
  const outcome = !f.moveTo
    ? `Left where it is.`
    : sendBack
      ? `Sent back to ${f.moveTo} for another run (failure ${failures} of ${retries + 1} allowed).`
      : `It has failed ${failures} times in a row, so it stays here for someone to look at.`

  let comment: string | undefined
  if (f.comment !== false) {
    const tail = logTail(run.logTail)
    comment = [`**Night Shift: ${run.stepsName} failed**${where}.`, '', outcome, ...(tail ? ['', '```', tail, '```'] : [])].join('\n')
  }
  return {
    addLabel: label,
    ...(sendBack ? { moveTo: f.moveTo } : {}),
    ...(comment ? { comment } : {}),
    note: `Marked ${run.identifier} "${label}" in Linear. ${outcome}`
  }
}

// The end of the log, without Night Shift's own closing lines, short enough for a comment.
function logTail(text: string): string {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim() && !/^(Run (failed|done|stopped)\.|Step failed: )/.test(l.trim()))
  let out = lines.slice(-COMMENT_LOG_LINES).join('\n')
  if (out.length > COMMENT_LOG_CHARS) out = '…' + out.slice(-COMMENT_LOG_CHARS)
  return out.replace(/```/g, "'''")
}
