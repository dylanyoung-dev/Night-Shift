import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { globalRunKey, isActiveRun } from '../shared/types'
import type { Automation, AutomationStatus, LinearIssue, LinearState, Run, Settings, StepSet, StepsFile } from '../shared/types'

export interface SchedulerDeps {
  getSettings(): Settings
  disable(id: string): void // switch an automation off (it finished its runs)
  getKey(): string | null
  getAllStates(): LinearState[]
  fetchIssues(stateIds: string[], projectIds: string[] | undefined): Promise<LinearIssue[]>
  loadSteps(): StepsFile
  setForState(file: StepsFile, state: string, setName?: string | null): StepSet | undefined
  globalSet(file: StepsFile, name: string | null | undefined): StepSet | undefined
  startGlobal(set: StepSet, by: { id: string; name: string }): void
  isBusy(issueId: string): boolean
  runs(): Run[]
  start(issue: LinearIssue, set: StepSet, by: { id: string; name: string }): void
  onStatus(status: Record<string, AutomationStatus>): void
}

interface Stored extends AutomationStatus {
  retryAt?: number // schedule + onlyIfTickets: an empty check retries at this time
}

const WAIT_RETRY_MS = 60_000

// Priority order Linear uses on boards: Urgent, High, Medium, Low, then No priority.
const rank = (p: number): number => (p === 0 ? 5 : p)

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// Inside the automation's days and hours. A window whose start is after its end crosses midnight.
export function inWindow(a: Pick<Automation, 'days' | 'window'>, now: Date): boolean {
  if (a.days.length && !a.days.includes(now.getDay())) return false
  if (!a.window) return true
  const m = now.getHours() * 60 + now.getMinutes()
  const s = minutes(a.window.start)
  const e = minutes(a.window.end)
  return s < e ? m >= s && m < e : m >= s || m < e
}

export class AutomationScheduler {
  private file = join(app.getPath('userData'), 'automations.json')
  private status: Record<string, Stored> = {}
  private checking = new Set<string>()

  constructor(private deps: SchedulerDeps) {
    try {
      this.status = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Stored>
    } catch {
      this.status = {}
    }
  }

  // What the renderer shows; nextRunAt is worked out from the current settings so edits apply at once.
  view(): Record<string, AutomationStatus> {
    const out: Record<string, AutomationStatus> = {}
    for (const a of this.deps.getSettings().automations) {
      const st = this.status[a.id] ?? {}
      const { retryAt: _r, seen, ...rest } = st
      out[a.id] = { ...rest, nextRunAt: a.mode === 'schedule' ? this.nextRunAt(a, st) : undefined, seen }
    }
    return out
  }

  private nextRunAt(a: Automation, st: Stored): number | null {
    const afterLast = st.lastRunAt ? st.lastRunAt + a.everyMinutes * 60_000 : 0
    const t = Math.max(afterLast, st.retryAt ?? 0)
    return t > 0 ? t : null
  }

  private save(): void {
    // Forget automations that were deleted.
    const ids = new Set(this.deps.getSettings().automations.map((a) => a.id))
    for (const id of Object.keys(this.status)) if (!ids.has(id)) delete this.status[id]
    try {
      writeFileSync(this.file, JSON.stringify(this.status))
    } catch {
      /* best effort */
    }
    this.deps.onStatus(this.view())
  }

  private set(id: string, patch: Partial<Stored>): void {
    this.status[id] = { ...this.status[id], ...patch }
  }

  // Called on a timer and after each Linear sync.
  async tick(now = Date.now()): Promise<void> {
    for (const a of this.deps.getSettings().automations) {
      if (!a.enabled || this.checking.has(a.id)) continue
      const st = this.status[a.id] ?? {}
      const date = new Date(now)
      if (a.mode === 'schedule') {
        const next = this.nextRunAt(a, st)
        if (!inWindow(a, date) || (next !== null && now < next)) continue
      } else {
        const poll = Math.max(15, this.deps.getSettings().pollSeconds) * 1000
        if (st.lastCheckedAt && now - st.lastCheckedAt < poll - 1000) continue
        if (!inWindow(a, date)) {
          if (st.lastResult !== 'Outside its hours') {
            this.set(a.id, { lastResult: 'Outside its hours', lastCheckedAt: now })
            this.save()
          }
          continue
        }
      }
      await this.check(a, now, false)
    }
  }

  // Run now from the page: ignores the schedule and hours, but still respects the other limits.
  async runNow(id: string): Promise<{ ok: true; message: string } | { error: string }> {
    const a = this.deps.getSettings().automations.find((x) => x.id === id)
    if (!a) return { error: 'That automation no longer exists. Save first if it is new.' }
    if (this.checking.has(id)) return { error: 'It is already checking for tickets.' }
    await this.check(a, Date.now(), true)
    return { ok: true, message: this.status[id]?.lastResult ?? 'Done' }
  }

  private async check(a: Automation, now: number, manual: boolean): Promise<void> {
    this.checking.add(a.id)
    try {
      const result = await this.pick(a, now, manual)
      this.set(a.id, { ...result, lastCheckedAt: now })
    } catch (err) {
      this.set(a.id, { lastCheckedAt: now, lastResult: `Couldn't check Linear: ${(err as Error).message}`, retryAt: now + WAIT_RETRY_MS })
    } finally {
      this.checking.delete(a.id)
      this.save()
    }
  }

  // Finds tickets, starts runs, and returns the status to store.
  private async pick(a: Automation, now: number, manual: boolean): Promise<Partial<Stored>> {
    const s = this.deps.getSettings()
    const st = this.status[a.id] ?? {}
    if (a.kind === 'global') return this.pickGlobal(a, now, st)
    if (!this.deps.getKey()) return { lastResult: 'Add your Linear API key in Settings.', retryAt: now + WAIT_RETRY_MS }
    if (!s.repoPath) return { lastResult: 'Set the repo path in Settings.', retryAt: now + WAIT_RETRY_MS }
    if (!a.states.length) return { lastResult: 'Pick at least one state.', retryAt: now + WAIT_RETRY_MS }

    const all = this.deps.getAllStates()
    if (!all.length) return { lastResult: 'Waiting for Linear to load.', retryAt: now + WAIT_RETRY_MS }
    const steps = this.deps.loadSteps()
    const targets = a.states
      .map((name) => ({ name, state: all.find((x) => x.name.toLowerCase() === name.toLowerCase()), set: this.deps.setForState(steps, name, a.stepSet) ?? this.deps.setForState(steps, name) }))
      .filter((t) => t.state && t.set) as { name: string; state: LinearState; set: StepSet }[]
    if (!targets.length) return { lastResult: 'None of its states has an action.', retryAt: now + WAIT_RETRY_MS }

    const project = a.projectId ? s.projects.find((p) => p.id === a.projectId) : undefined
    if (a.projectId && !project) return { lastResult: 'Its project was deleted.', retryAt: now + WAIT_RETRY_MS }
    const issues = await this.deps.fetchIssues(
      targets.map((t) => t.state.id),
      project?.linearProjectIds
    )
    const runs = this.deps.runs()
    const lastRun = (issueId: string): number => runs.find((r) => r.issueId === issueId)?.createdAt ?? 0
    const cooldown = a.cooldownHours * 3600_000
    const setFor = (issue: LinearIssue): StepSet => targets.find((t) => t.state.id === issue.stateId)!.set
    const sorted = [...issues].sort((x, y) => rank(x.priority) - rank(y.priority) || x.sortOrder - y.sortOrder)
    const by = { id: a.id, name: a.name }

    if (a.mode === 'watch') {
      // Forget tickets that left the states (or moved between them), so they count as new arrivals.
      const seen = { ...(st.seen ?? {}) }
      for (const id of Object.keys(seen)) {
        const issue = issues.find((i) => i.id === id)
        if (!issue || issue.stateName !== seen[id]) delete seen[id]
      }
      const active = runs.filter((r) => r.automationId === a.id && isActiveRun(r.status)).length
      const room = Math.max(0, a.maxActive - active)
      const eligible = sorted.filter(
        (i) =>
          !this.deps.isBusy(i.id) &&
          (a.perTicket === 'perArrival' ? !seen[i.id] : now - lastRun(i.id) >= cooldown)
      )
      const picked = eligible.slice(0, room)
      for (const issue of picked) {
        this.deps.start(issue, setFor(issue), by)
        seen[issue.id] = issue.stateName
      }
      const waiting = eligible.length - picked.length
      return {
        seen,
        ...(picked.length ? { lastRunAt: now } : {}),
        lastResult: picked.length
          ? `Picked up ${picked.map((i) => i.identifier).join(', ')}${waiting ? `; ${waiting} more waiting` : ''}.`
          : !issues.length
            ? `No tickets in ${a.states.join(', ')}.`
            : waiting
              ? `${waiting} waiting; ${active} of ${a.maxActive} already running.`
              : 'Nothing new to pick up.'
      }
    }

    // Schedule
    const eligible = sorted.filter((i) => !this.deps.isBusy(i.id) && now - lastRun(i.id) >= cooldown)
    if (!eligible.length && a.onlyIfTickets && !manual) {
      return {
        retryAt: now + Math.max(WAIT_RETRY_MS, s.pollSeconds * 1000),
        lastResult: issues.length ? 'Waiting: every ticket ran recently or is running.' : `Waiting for tickets in ${a.states.join(', ')}.`
      }
    }
    const picked = eligible.slice(0, a.ticketsPerRun)
    for (const issue of picked) this.deps.start(issue, setFor(issue), by)
    const runsDone = (st.runsDone ?? 0) + 1
    const finished = a.maxRuns !== null && runsDone >= a.maxRuns
    if (finished) this.deps.disable(a.id)
    return {
      lastRunAt: now,
      retryAt: undefined,
      runsDone,
      lastResult:
        (picked.length ? `Started ${picked.map((i) => i.identifier).join(', ')}.` : 'No tickets to run.') +
        (finished ? ` Finished its ${a.maxRuns} runs and switched off.` : '')
    }
  }

  // A global action on a schedule: one run each time, skipped while the last one is still going.
  private pickGlobal(a: Automation, now: number, st: Stored): Partial<Stored> {
    const s = this.deps.getSettings()
    if (!s.repoPath) return { lastResult: 'Set the repo path in Settings.', retryAt: now + WAIT_RETRY_MS }
    if (!a.globalAction) return { lastResult: 'Pick a global action to run.', retryAt: now + WAIT_RETRY_MS }
    const set = this.deps.globalSet(this.deps.loadSteps(), a.globalAction)
    if (!set) return { lastResult: `"${a.globalAction}" isn't a global action any more. Check the Actions page.`, retryAt: now + WAIT_RETRY_MS }
    const by = { id: a.id, name: a.name }
    if (this.deps.isBusy(globalRunKey(set.name))) {
      return { lastRunAt: now, retryAt: undefined, lastResult: `Skipped: the last run of ${set.name} is still going.` }
    }
    this.deps.startGlobal(set, by)
    const runsDone = (st.runsDone ?? 0) + 1
    const finished = a.maxRuns !== null && runsDone >= a.maxRuns
    if (finished) this.deps.disable(a.id)
    return {
      lastRunAt: now,
      retryAt: undefined,
      runsDone,
      lastResult: `Started ${set.name}.` + (finished ? ` Finished its ${a.maxRuns} runs and switched off.` : '')
    }
  }

  // Lets "run N times" start over after the person changes the limit or switches it back on.
  resetCount(id: string): void {
    this.set(id, { runsDone: 0 })
    this.save()
  }
}
