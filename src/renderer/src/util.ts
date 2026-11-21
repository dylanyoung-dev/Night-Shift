import type { RunStatus, StepStatus } from '../../shared/types'

export const runColor: Record<RunStatus, string> = {
  queued: 'var(--queued)',
  running: 'var(--running)',
  waiting: 'var(--attn)',
  done: 'var(--done)',
  failed: 'var(--failed)',
  stopped: 'var(--stopped)'
}

export const stepColor: Record<StepStatus, string> = {
  pending: 'var(--seg-off)',
  running: 'var(--running)',
  waiting: 'var(--attn)',
  done: 'var(--done)',
  failed: 'var(--failed)',
  skipped: 'var(--seg-off)'
}

export const runLabel: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped'
}

export function duration(start?: number, end?: number): string {
  if (!start) return ''
  const secs = Math.max(0, Math.round(((end ?? Date.now()) - start) / 1000))
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  if (m < 60) return `${m}m ${secs % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export interface StepGroup<T> {
  label: string
  items: { step: T; index: number }[]
}

// Splits steps the way the design shows them: scripts before Claude, the Claude steps, scripts after.
export function groupSteps<T extends { type: string }>(steps: T[]): StepGroup<T>[] {
  const first = steps.findIndex((s) => s.type === 'claude')
  if (first < 0) return [{ label: 'Scripts', items: steps.map((step, index) => ({ step, index })) }]
  let last = first
  steps.forEach((s, i) => s.type === 'claude' && (last = i))
  const groups: StepGroup<T>[] = [
    { label: 'Before Claude · scripts', items: [] },
    { label: 'Claude', items: [] },
    { label: 'After Claude · scripts', items: [] }
  ]
  steps.forEach((step, index) => {
    const g = index < first ? 0 : index <= last ? 1 : 2
    groups[g].items.push({ step, index })
  })
  return groups.filter((g) => g.items.length)
}

// Removes terminal color and cursor codes so tool output reads cleanly in the UI.
// CSI sequences (colors, cursor moves), OSC sequences (titles, links), and bare carriage returns.
const ESC = '\u001b'
const BEL = '\u0007'
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)|\\r(?!\\n)`, 'g')

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}
