import { app } from 'electron'
import { spawn } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PlanLimits, PlanWindow } from '../shared/types'

// Plan limits (the percentages /usage shows). `claude -p --output-format stream-json` reports
// them in "rate_limit_event" messages, so we keep the latest one seen in any Night Shift run,
// and can ask for a fresh one with a tiny Claude call.

const file = (): string => join(app.getPath('userData'), 'limits.json')
let latest: PlanLimits | null = null
let onChange: ((l: PlanLimits) => void) | null = null

export function onLimitsChange(cb: (l: PlanLimits) => void): void {
  onChange = cb
}

function toWindow(w: unknown): PlanWindow | undefined {
  const o = w as { utilization?: unknown; resetsAt?: unknown; status?: unknown } | null
  if (!o || typeof o.utilization !== 'number') return undefined
  return {
    utilization: o.utilization,
    resetsAt: typeof o.resetsAt === 'number' ? o.resetsAt * 1000 : undefined,
    status: typeof o.status === 'string' ? o.status : undefined
  }
}

function fromEvent(ev: unknown, seenAt: number, source: PlanLimits['source']): PlanLimits | null {
  const info = (ev as { type?: string; rate_limit_info?: Record<string, unknown> })?.rate_limit_info
  if ((ev as { type?: string })?.type !== 'rate_limit_event' || !info) return null
  const windows = (info.unifiedWindows ?? {}) as Record<string, unknown>
  const out: PlanLimits = { seenAt, source, windows: {} }
  for (const [k, v] of Object.entries(windows)) {
    const w = toWindow(v)
    if (w) out.windows[k] = w
  }
  // Older shapes only describe the window that applies right now.
  if (!Object.keys(out.windows).length && typeof info.rateLimitType === 'string') {
    const w = toWindow({ utilization: info.utilization, resetsAt: info.resetsAt, status: info.status })
    if (w) out.windows[info.rateLimitType] = w
  }
  return Object.keys(out.windows).length ? out : null
}

function store(l: PlanLimits): void {
  if (latest && latest.seenAt > l.seenAt) return
  latest = l
  try {
    writeFileSync(file(), JSON.stringify(l))
  } catch {
    /* best effort */
  }
  onChange?.(l)
}

// Called with raw stream-json output from Claude steps.
export function noteStreamOutput(text: string): void {
  if (!text.includes('rate_limit_event')) return
  for (const line of text.split('\n')) {
    if (!line.includes('rate_limit_event')) continue
    try {
      const l = fromEvent(JSON.parse(line), Date.now(), 'run')
      if (l) store(l)
    } catch {
      /* line split across chunks; the next event will do */
    }
  }
}

// On start: the saved value, or else the newest event in recent run logs.
export function loadLimits(runLogDir: string): void {
  try {
    latest = JSON.parse(readFileSync(file(), 'utf8')) as PlanLimits
  } catch {
    latest = null
  }
  if (!existsSync(runLogDir)) return
  try {
    const files = readdirSync(runLogDir)
      .filter((f) => f.endsWith('.events.jsonl'))
      .map((f) => ({ f: join(runLogDir, f), t: statSync(join(runLogDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 5)
    for (const { f, t } of files) {
      if (latest && latest.seenAt >= t) break
      const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('rate_limit_event'))
      const last = lines.at(-1)
      if (!last) continue
      try {
        const l = fromEvent(JSON.parse(last), t, 'run')
        if (l) {
          store(l)
          break
        }
      } catch {
        /* try the next file */
      }
    }
  } catch {
    /* no history */
  }
}

export function getLimits(): PlanLimits | null {
  return latest
}

// Ask Claude for fresh numbers: one very short Haiku reply, which uses a sliver of the plan.
let checking: Promise<PlanLimits | { error: string }> | null = null
export function checkLimits(cwd: string): Promise<PlanLimits | { error: string }> {
  if (checking) return checking
  checking = new Promise<PlanLimits | { error: string }>((resolve) => {
    const env = { ...process.env }
    delete env.ANTHROPIC_API_KEY // limits only exist for plan logins
    const child = spawn('claude -p --model haiku --output-format stream-json --verbose --max-turns 1 "Reply with just: ok"', {
      cwd: existsSync(cwd) ? cwd : app.getPath('home'),
      env,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let buf = ''
    let err = ''
    let done = false
    const finish = (r: PlanLimits | { error: string }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      finish({ error: 'Claude did not answer within 60 seconds.' })
      child.kill()
    }, 60_000)
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.includes('rate_limit_event')) continue
        try {
          const l = fromEvent(JSON.parse(line), Date.now(), 'check')
          if (l) {
            store(l)
            finish(l)
          }
        } catch {
          /* ignore */
        }
      }
    })
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => finish({ error: e.message }))
    child.on('close', () =>
      finish({ error: err.trim().split('\n').at(-1) || "Claude finished without reporting plan limits. They're only reported when you're signed in with a Claude plan, not an API key." })
    )
  }).finally(() => (checking = null))
  return checking
}
