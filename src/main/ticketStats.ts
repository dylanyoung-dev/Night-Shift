import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Run, TicketBucket, TicketDone, TicketStats } from '../shared/types'
import { fetchCompleted } from './linear'
import { sessionTotals } from './usage'

const DAY = 86_400_000
const dayKey = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const midnight = (t: number): number => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime()
// Monday 00:00 of the week t falls in.
const mondayOf = (t: number): number => {
  const d = new Date(midnight(t))
  return midnight(d.getTime() - ((d.getDay() + 6) % 7) * DAY + 3600_000)
}

// Tickets the team completed in Linear, joined with Night Shift's runs on them and the tokens
// those runs' Claude sessions used. Runs on a ticket before it was completed count toward it.
export async function getTicketStats(
  days: number,
  ctx: { apiKey: string; teamKey: string; projectIds?: string[]; runs: Run[] }
): Promise<TicketStats> {
  const now = Date.now()
  const today = midnight(now)
  const rangeStart = midnight(today - (days - 1) * DAY + 3600_000)
  const weekCount = Math.max(4, Math.ceil(days / 7))
  const thisMonday = mondayOf(now)
  const weeksStart = mondayOf(thisMonday - (weekCount - 1) * 7 * DAY + 3600_000)
  const lastMonday = mondayOf(thisMonday - 3 * DAY)
  const since = Math.min(rangeStart, weeksStart, lastMonday)

  const empty: TicketStats = {
    generatedAt: now,
    days,
    today: 0,
    thisWeek: 0,
    lastWeek: 0,
    daily: [],
    weekly: [],
    tickets: [],
    withAgents: 0,
    avgTokens: 0,
    avgOutput: 0,
    avgRuns: 0,
    avgSessions: 0,
    avgAgentMs: 0,
    tokensPerPoint: null
  }
  if (!ctx.apiKey || !ctx.teamKey) return { ...empty, error: 'Add your Linear API key and team key in Settings to see completed tickets.' }

  let done
  try {
    done = await fetchCompleted(ctx.apiKey, ctx.teamKey, new Date(since), ctx.projectIds)
  } catch (e) {
    return { ...empty, error: `Linear: ${(e as Error).message}` }
  }

  const runsByIssue = new Map<string, Run[]>()
  for (const r of ctx.runs) {
    if (r.global) continue
    const list = runsByIssue.get(r.issueId) ?? []
    list.push(r)
    runsByIssue.set(r.issueId, list)
  }
  const ids = new Set<string>()
  for (const d of done) for (const r of runsByIssue.get(d.id) ?? []) for (const st of r.steps) if (st.sessionId) ids.add(st.sessionId)
  const totals = await sessionTotals(ids)

  const tickets: TicketDone[] = done.map((d) => {
    const completedAt = Date.parse(d.completedAt)
    const runs = runsByIssue.get(d.id) ?? []
    const sessions = new Set<string>()
    let agentMs = 0
    for (const r of runs) {
      for (const st of r.steps) if (st.sessionId) sessions.add(st.sessionId)
      if (r.startedAt) agentMs += Math.max(0, (r.endedAt ?? now) - r.startedAt)
    }
    let tokens = 0
    let output = 0
    for (const s of sessions) {
      const t = totals.get(s)
      if (t) {
        tokens += t.tokens
        output += t.output
      }
    }
    return { identifier: d.identifier, title: d.title, completedAt, estimate: d.estimate, runs: runs.length, sessions: sessions.size, tokens, output, agentMs }
  })
  tickets.sort((a, b) => b.completedAt - a.completedAt)

  const blank = (): TicketBucket => ({ count: 0, points: 0, agented: 0, tokens: 0, runs: 0, sessions: 0 })
  const put = (b: TicketBucket, t: TicketDone): void => {
    b.count++
    b.points += t.estimate ?? 0
    if (t.runs) {
      b.agented++
      b.tokens += t.tokens
      b.runs += t.runs
      b.sessions += t.sessions
    }
  }
  const daily = new Map<string, TicketBucket & { date: string }>()
  for (let i = 0; i < days; i++) {
    const k = dayKey(rangeStart + i * DAY + 3600_000)
    daily.set(k, { date: k, ...blank() })
  }
  const weekly: (TicketBucket & { start: string; t: number })[] = []
  for (let i = 0; i < weekCount; i++) {
    const t = mondayOf(weeksStart + i * 7 * DAY + 3600_000)
    weekly.push({ start: dayKey(t), ...blank(), t })
  }

  const stats = { ...empty }
  const inRange: TicketDone[] = []
  for (const t of tickets) {
    if (t.completedAt >= today) stats.today++
    if (t.completedAt >= thisMonday) stats.thisWeek++
    else if (t.completedAt >= lastMonday) stats.lastWeek++
    const d = daily.get(dayKey(t.completedAt))
    if (d && t.completedAt >= rangeStart) {
      put(d, t)
    }
    for (let i = weekly.length - 1; i >= 0; i--) {
      if (t.completedAt >= weekly[i].t) {
        put(weekly[i], t)
        break
      }
    }
    if (t.completedAt >= rangeStart) inRange.push(t)
  }

  const agented = inRange.filter((t) => t.runs > 0)
  const avg = (f: (t: TicketDone) => number): number => (agented.length ? agented.reduce((s, t) => s + f(t), 0) / agented.length : 0)
  const points = agented.reduce((s, t) => s + (t.estimate ?? 0), 0)
  return {
    ...stats,
    daily: [...daily.values()],
    weekly: weekly.map(({ t: _t, ...w }) => w),
    tickets: inRange,
    withAgents: agented.length,
    avgTokens: avg((t) => t.tokens),
    avgOutput: avg((t) => t.output),
    avgRuns: avg((t) => t.runs),
    avgSessions: avg((t) => t.sessions),
    avgAgentMs: avg((t) => t.agentMs),
    tokensPerPoint: points ? agented.reduce((s, t) => s + t.tokens, 0) / points : null
  }
}

// The usage page's ticket numbers, kept on disk and rebuilt in the background, so opening the page
// doesn't query Linear and read every session log each time. One entry per range and project.
// The timer keeps them within 15 minutes; while the page is open (it asks every minute) they're kept
// within OPEN_FRESH, and a rebuild that finishes is pushed to the page straight away.
export const TICKET_STATS_EVERY = 15 * 60_000
const OPEN_FRESH = 2 * 60_000
type Listener = (days: number, projectId: string | null, stats: TicketStats) => void
let listener: Listener | null = null
export function onTicketStatsUpdated(cb: Listener): void {
  listener = cb
}
type Ctx = Parameters<typeof getTicketStats>[1]
interface Entry {
  stats: TicketStats
  lastAsked: number
}
let store: Record<string, Entry> | null = null
const building = new Map<string, Promise<TicketStats>>()
const storeFile = (): string => {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'ticket-stats.json')
}
function loadStore(): Record<string, Entry> {
  if (store) return store
  try {
    store = JSON.parse(readFileSync(storeFile(), 'utf8')) as Record<string, Entry>
  } catch {
    store = {}
  }
  return store
}
function saveStore(): void {
  try {
    writeFileSync(storeFile(), JSON.stringify(store ?? {}))
  } catch {
    // the numbers are rebuilt anyway; a failed save only costs a slower first load
  }
}

function rebuild(key: string, days: number, ctx: Ctx): Promise<TicketStats> {
  const running = building.get(key)
  if (running) return running
  const job = getTicketStats(days, ctx)
    .then((fresh) => {
      const all = loadStore()
      const old = all[key]
      // A failed rebuild keeps the last good numbers and says why they're old.
      const stats = fresh.error && old && !old.stats.error ? { ...old.stats, error: fresh.error } : fresh
      all[key] = { stats, lastAsked: old?.lastAsked ?? Date.now() }
      saveStore()
      const [d, p] = key.split('|')
      listener?.(Number(d) || days, p || null, stats)
      return stats
    })
    .finally(() => building.delete(key))
  building.set(key, job)
  return job
}

// Returns the saved numbers straight away (rebuilding them in the background when they're a couple
// of minutes old), or builds them and waits: the first time, after midnight (yesterday's "today" would
// be wrong), and when the page's Refresh asks for it.
export async function cachedTicketStats(days: number, projectId: string | null, ctx: Ctx, force = false): Promise<TicketStats> {
  const key = `${days}|${projectId ?? ''}`
  const all = loadStore()
  const hit = all[key]
  if (!hit || force || hit.stats.generatedAt < midnight(Date.now())) {
    const stats = await rebuild(key, days, ctx)
    all[key] = { stats, lastAsked: Date.now() }
    saveStore()
    return stats
  }
  hit.lastAsked = Date.now()
  if (Date.now() - hit.stats.generatedAt >= OPEN_FRESH || hit.stats.error) void rebuild(key, days, ctx).catch(() => undefined)
  return hit.stats
}

// Called on a timer: rebuilds the ranges looked at in the last week so they're current when the page
// opens, and forgets the rest.
export function refreshTicketStats(ctxFor: (projectId: string | null) => Ctx): void {
  const all = loadStore()
  const weekAgo = Date.now() - 7 * 86_400_000
  let dropped = false
  for (const [key, e] of Object.entries(all)) {
    if (e.lastAsked < weekAgo) {
      delete all[key]
      dropped = true
      continue
    }
    if (Date.now() - e.stats.generatedAt < TICKET_STATS_EVERY - 60_000) continue
    const [d, p] = key.split('|')
    void rebuild(key, Number(d) || 30, ctxFor(p || null)).catch(() => undefined)
  }
  if (dropped) saveStore()
}
