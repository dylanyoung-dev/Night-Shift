import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray } from 'electron'
import { hostname } from 'os'
import { basename, join } from 'path'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'fs'
import type { BoardData, HostMachineSettings, ImportGroupKey, IssueUpdate, LinearIssue, LinearState, RemoteTarget, Run, SaveConflict, Settings, SettingsUpdate, SharedSettings, StepSet, StepsFile } from '../shared/types'
import { globalRunKey } from '../shared/types'
import { getLinearKey, getSettings, updateSettings } from './settings'
import { addComment, addLabelByName, fetchIssue, fetchIssues, fetchStates, fetchTeamMeta, moveIssue, removeLabelByName, updateIssue, fetchIssueDetail, fetchIssueRelations, fetchLinearImage } from './linear'
import { globalSet, loadSteps, parseSteps, saveSteps, setForState, setsForState, starterSteps, stringifySteps, STEPS_RELATIVE_PATH } from './steps'
import { Runner } from './runner'
import { getUsage, usageProgress } from './usage'
import { getTicketStats } from './ticketStats'
import { checkLimits, getLimits, loadLimits, onLimitsChange } from './limits'
import { installUpdateNow, checkForUpdatesNow, startUpdater, updateState } from './updater'
import { log } from './log'
import { HostServer, HOST_API_VERSION, type HostOps } from './hostServer'
import { RemoteClient, hostRequest } from './remoteClient'
import { actionRevs, conflictMessage, mergeActions, mergeSettings, noteEdits, settingsRevs } from './shared'
import { listBranches } from './git'
import { combineGroups, exportSettings, readImportGroups } from './configFile'
import { AutomationScheduler } from './automations'
import appIcon from '../../resources/icon.png?asset'

// Pin the data folder so dev runs and an installed copy share settings and run history,
// whatever product name the installer uses. NIGHTSHIFT_USER_DATA points a copy elsewhere (testing).
app.setPath('userData', process.env.NIGHTSHIFT_USER_DATA || join(app.getPath('appData'), 'night-shift'))

// --headless: start with no window (the sign-in task on a host). Opening Night Shift again shows a
// window in this same process: only one copy runs per data folder, so agents never run twice.
const HEADLESS = process.argv.includes('--headless')
const GOT_LOCK = app.requestSingleInstanceLock()
if (!GOT_LOCK) {
  app.quit() // another copy has this data folder: it shows its window instead (second-instance)
} else {
  app.on('second-instance', () => app.isReady() && showWindow())
}

let win: BrowserWindow | null = null
let board: BoardData = { states: [], issues: [], fetchedAt: null }

// The board is kept for this machine's board refresh interval (Settings › Linear) before Linear is asked
// again; the refresh button skips the wait. It's saved to disk too, so a restart shows the last board
// straight away instead of an empty one.
const boardCacheMs = (): number => Math.max(1, getSettings().boardRefreshMinutes || 5) * 60_000
const boardCacheFile = (): string => join(app.getPath('userData'), 'board-cache.json')
// What the board was fetched for. A cached board for another team, project or set of hidden states is ignored.
function boardCacheKey(): string {
  const s = getSettings()
  const project = s.projects.find((p) => p.id === s.activeProjectId)
  return JSON.stringify([s.linearTeamKey, project?.id ?? null, project?.linearProjectIds ?? null, s.hiddenStateTypes])
}
function saveBoardCache(): void {
  if (!board.fetchedAt) return
  try {
    writeFileSync(boardCacheFile(), JSON.stringify({ key: boardCacheKey(), board }))
  } catch (err) {
    console.warn(`Board cache: ${(err as Error).message}`)
  }
}
// Loads the saved board if it belongs to the current settings. Returns whether it's still fresh.
function loadBoardCache(): boolean {
  try {
    const saved = JSON.parse(readFileSync(boardCacheFile(), 'utf8')) as { key: string; board: BoardData }
    if (saved.key !== boardCacheKey() || !saved.board?.fetchedAt) return false
    board = { ...saved.board, error: undefined }
    allStates = board.allStates ?? board.states
    return Date.now() - saved.board.fetchedAt < boardCacheMs()
  } catch {
    return false
  }
}
let allStates: LinearState[] = [] // every team state, hidden ones too, for moves by name
let pollTimer: NodeJS.Timeout | null = null

// Remote mode: this machine uses another machine's Night Shift for actions, runs and shared settings.
const remoteMode = (): boolean => getSettings().mode === 'remote'

// To this window, and (on a host) to every connected remote.
let runsBroadcast: NodeJS.Timeout | undefined
function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  if (remoteMode()) return
  if (channel === 'runs') {
    // Runs change often while a step runs; remotes get the list at most a few times a second.
    if (!runsBroadcast) runsBroadcast = setTimeout(() => ((runsBroadcast = undefined), host.broadcast('runs', runsForRemote())), 300)
  } else if (channel === 'run-output') host.broadcast('run-output', args)
  else if (channel === 'automations' || channel === 'limits') host.broadcast(channel, args[0])
  else if (channel === 'settings') host.broadcast('shared-changed', {})
  else if (channel === 'steps-changed') host.broadcast('steps-changed', {})
}

// The run list for remotes: the log tail trimmed (they fetch the whole log when they open one).
function runsForRemote(): Run[] {
  return runner.list().map((r) => ({ ...r, logTail: r.logTail.slice(-2000) }))
}

// Tickets a run changed in Linear, synced together a moment later so a burst of calls is one update.
const ticketsToSync = new Set<string>()
let wholeBoardToSync = false
let ticketSyncTimer: NodeJS.Timeout | undefined
function queueTicketSync(ticket: string | null): void {
  if (ticket === null) wholeBoardToSync = true
  else ticketsToSync.add(ticket)
  if (ticketSyncTimer) return
  ticketSyncTimer = setTimeout(async () => {
    ticketSyncTimer = undefined
    const whole = wholeBoardToSync
    const tickets = [...ticketsToSync]
    wholeBoardToSync = false
    ticketsToSync.clear()
    if (whole) return void refreshBoard()
    const key = getLinearKey()
    if (!key) return
    for (const t of tickets) await syncIssue(key, t).catch((err: Error) => console.warn(`Linear sync of ${t}: ${err.message}`))
  }, 1500)
}

const runner = new Runner({
  getRepoPath: () => getSettings().repoPath,
  getBaseBranch: () => getSettings().baseBranch,
  getWorktreeMode: () => getSettings().worktreeMode,
  getWorktreePath: () => getSettings().worktreePath,
  getMaxConcurrent: () => Math.max(1, getSettings().maxConcurrent),
  moveIssue: async (issueId, stateName) => {
    const key = getLinearKey()
    if (!key) throw new Error('No Linear API key set')
    const state = allStates.find((s) => s.name.toLowerCase() === stateName.toLowerCase())
    if (!state) throw new Error(`No Linear state named "${stateName}"`)
    await moveIssue(key, issueId, state.id)
    await syncIssue(key, issueId)
  },
  onRuns: (runs) => send('runs', runs),
  onTicketsChanged: (run, ticket) => queueTicketSync(ticket !== undefined ? ticket : run.global ? null : run.issueId),
  onOutput: (runId, chunk) => send('run-output', runId, chunk),
  onWaiting: (run) => notifyWaiting(run.id, run.identifier, run.waiting?.reason ?? 'Claude needs you'),
  getSet: (name) => loadSteps(getSettings().repoPath).sets.find((x) => x.name.toLowerCase() === name.toLowerCase()),
  applyFailurePlan: async (issueId, plan) => {
    const key = getLinearKey()
    if (!key) throw new Error('No Linear API key set')
    let removedLabel = false
    if (plan.removeLabel) removedLabel = await removeLabelByName(key, issueId, plan.removeLabel)
    if (plan.addLabel) await addLabelByName(key, issueId, plan.addLabel)
    if (plan.comment) await addComment(key, issueId, plan.comment)
    if (plan.moveTo) {
      const state = allStates.find((s) => s.name.toLowerCase() === plan.moveTo!.toLowerCase())
      if (!state) throw new Error(`No Linear state named "${plan.moveTo}"`)
      await moveIssue(key, issueId, state.id)
    }
    if (removedLabel || plan.addLabel || plan.moveTo) await syncIssue(key, issueId)
    return { removedLabel }
  }
})

// A desktop notification and a flashing taskbar icon when a run needs the person.
function notifyWaiting(runId: string, identifier: string, reason: string): void {
  win?.flashFrame(true)
  if (!Notification.isSupported()) return
  const n = new Notification({ title: `${identifier} needs you`, body: reason, silent: false })
  n.on('click', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    send('open-run', runId)
  })
  n.show()
}

const scheduler = new AutomationScheduler({
  getSettings,
  disable: (id) => {
    updateSettings({ automations: getSettings().automations.map((a) => (a.id === id ? { ...a, enabled: false } : a)) })
    send('settings', effectiveSettings())
  },
  getKey: getLinearKey,
  getAllStates: () => allStates,
  fetchIssues: (stateIds, projectIds) => {
    const key = getLinearKey()
    if (!key) throw new Error('No Linear API key set')
    return fetchIssues(key, getSettings().linearTeamKey, stateIds, projectIds)
  },
  loadSteps: () => loadSteps(getSettings().repoPath),
  setForState,
  globalSet,
  startGlobal: (set, by) => void runner.startGlobal(set, by),
  isBusy: (id) => runner.isBusy(id),
  runs: () => runner.list(),
  start: (issue, set, by) => void runner.start(issue, set, by),
  onStatus: (status) => send('automations', status)
})


// Automations are only ever evaluated on the machine that runs agents, never on a remote.
function tickAutomations(): void {
  if (!remoteMode()) void scheduler.tick()
}

const SHARED_KEYS = ['linearTeamKey', 'baseBranch', 'worktreeMode', 'pollSeconds', 'projects', 'automations'] as const
const HOST_MACHINE_KEYS = ['repoPath', 'worktreePath', 'maxConcurrent'] as const

function sharedOf(s: Settings): SharedSettings {
  return { linearTeamKey: s.linearTeamKey, baseBranch: s.baseBranch, worktreeMode: s.worktreeMode, pollSeconds: s.pollSeconds, projects: s.projects, automations: s.automations }
}
function hostMachineOf(s: Settings): HostMachineSettings {
  return { repoPath: s.repoPath, worktreePath: s.worktreePath, maxConcurrent: s.maxConcurrent }
}
// The name shown to others for edits made in this window.
const thisMachine = (): string => host.view().name || getSettings().host.name || hostname()

// Saves shared settings here, refusing items someone else changed since the editor loaded them.
function saveSharedHere(update: Partial<SharedSettings>, revs: Record<string, string>, by: string): { ok: true } | { conflict: SaveConflict } {
  const before = getSettings()
  const { next, conflicts, changed } = mergeSettings(sharedOf(before), update, revs)
  if (conflicts.length) {
    log.warn(`shared: refused a save from ${by}: ${conflicts.map((c) => c.key).join(', ')}`)
    return { conflict: { message: conflictMessage(conflicts), items: conflicts } }
  }
  if (!changed.length) return { ok: true }
  const s = updateSettings(next)
  noteEdits(changed, by)
  // Switching an automation back on, or changing its run limit, starts its count over.
  for (const a of s.automations) {
    const old = before.automations.find((b) => b.id === a.id)
    if (old && ((a.enabled && !old.enabled) || a.maxRuns !== old.maxRuns)) scheduler.resetCount(a.id)
  }
  schedulePolling()
  if (changed.some((k) => k === 'setting:linearTeamKey' || k.startsWith('project:'))) void refreshBoard()
  send('automations', scheduler.view())
  send('settings', effectiveSettings())
  return { ok: true }
}

function stepsHere(): StepsFile {
  const f = loadSteps(getSettings().repoPath)
  return { ...f, revs: actionRevs(f.sets) }
}

// Saves actions here, changing only the ones the editor changed, and refusing any changed meanwhile.
function saveStepsHere(sets: StepSet[], revs: Record<string, string> | undefined, by: string): StepsFile | { error: string; conflict?: SaveConflict } {
  const repo = getSettings().repoPath
  if (!repo) return { error: 'Set the repo path in Settings first.' }
  const current = loadSteps(repo)
  let incoming: StepSet[]
  try {
    incoming = parseSteps(stringifySteps(sets)) // the same shape as a file read, so untouched actions match
  } catch (err) {
    return { error: `Those actions couldn't be read: ${(err as Error).message}` }
  }
  const m = mergeActions(current.sets, incoming, revs ?? actionRevs(current.sets))
  if (m.conflicts.length) {
    log.warn(`shared: refused an actions save from ${by}: ${m.conflicts.map((c) => c.name).join(', ')}`)
    const conflict = { message: conflictMessage(m.conflicts), items: m.conflicts }
    return { error: conflict.message, conflict }
  }
  const res = saveSteps(repo, m.items)
  if ('error' in res) return res
  noteEdits(m.changed, by)
  send('steps-changed')
  return { ...res, revs: actionRevs(res.sets) }
}

async function startRunHere(issueId: string, setName?: string): Promise<Run | { error: string }> {
  const s = getSettings()
  if (!s.repoPath) return { error: 'Set the repo path in Settings first.' }
  let issue: LinearIssue | undefined = board.issues.find((i) => i.id === issueId)
  if (!issue) {
    // Started from a remote whose board shows a different project: ask Linear.
    const key = getLinearKey()
    if (key) issue = await fetchIssue(key, issueId).catch(() => undefined)
  }
  if (!issue) return { error: 'That ticket was not found in Linear.' }
  if (runner.isBusy(issue.id)) return { error: `${issue.identifier} already has a run going.` }
  const sets = setsForState(loadSteps(s.repoPath), issue.stateName)
  if (!sets.length) return { error: `No action is set up for "${issue.stateName}".` }
  const set = setName ? sets.find((x) => x.name === setName) : sets.length === 1 ? sets[0] : undefined
  if (!set) return { error: setName ? `"${setName}" doesn't cover "${issue.stateName}" any more.` : `Pick which action to run: ${sets.map((x) => x.label || x.name).join(' or ')}.` }
  return runner.start(issue, set)
}

function startGlobalHere(name: string): Run | { error: string } {
  const s = getSettings()
  if (!s.repoPath) return { error: 'Set the repo path in Settings first.' }
  if (!s.baseBranch) return { error: 'Pick a base branch first.' }
  const set = globalSet(loadSteps(s.repoPath), String(name ?? ''))
  if (!set) return { error: `"${name}" isn't a global action any more. Check the Actions page.` }
  if (runner.isBusy(globalRunKey(set.name))) return { error: `${set.name} is already running.` }
  return runner.startGlobal(set)
}

function usageHere(days: number, refresh: boolean): ReturnType<typeof getUsage> {
  const sessions = new Set<string>()
  for (const r of runner.list()) for (const st of r.steps) if (st.sessionId) sessions.add(st.sessionId)
  return getUsage(Math.min(365, Math.max(1, Math.round(Number(days) || 30))), sessions, refresh)
}

function ticketStatsHere(days: number, projectId: string | null): ReturnType<typeof getTicketStats> {
  const s = getSettings()
  const project = s.projects.find((p) => p.id === projectId) ?? null
  return getTicketStats(Math.min(365, Math.max(1, Math.round(Number(days) || 30))), {
    apiKey: getLinearKey() ?? '',
    teamKey: s.linearTeamKey,
    projectIds: project?.linearProjectIds,
    runs: runner.list()
  })
}

// The whole log file; the window shows the last 4 MB of a bigger one.
function readLogHere(runId: string, max?: number): string | null {
  const run = runner.get(runId)
  if (!run) return null
  try {
    const size = statSync(run.logFile).size
    if (!max || size <= max) return readFileSync(run.logFile, 'utf8')
    const fd = openSync(run.logFile, 'r')
    try {
      const buf = Buffer.alloc(max)
      readSync(fd, buf, 0, max, size - max)
      return `[Showing the last ${Math.round(max / 1024 / 1024)} MB of ${(size / 1024 / 1024).toFixed(1)} MB. Open the file for the rest.]\n` + buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return run.logTail // file missing: fall back to what's kept in memory
  }
}

// What a remote can ask this machine (as host) to do: the same code this window uses.
const ops: HostOps = {
  shared: () => {
    const s = getSettings()
    const shared = sharedOf(s)
    return { shared, hostMachine: hostMachineOf(s), revs: settingsRevs(shared) }
  },
  saveShared: saveSharedHere,
  steps: stepsHere,
  saveSteps: (sets, revs, by) => saveStepsHere(sets, revs, by),
  automationStatus: () => scheduler.view(),
  runAutomationNow: (id) => scheduler.runNow(id),
  runs: runsForRemote,
  readLog: (id) => readLogHere(id),
  readEvents: (id) => {
    const run = runner.get(id)
    if (!run) return null
    try {
      return readFileSync(run.logFile.replace(/\.log$/, '.events.jsonl'), 'utf8')
    } catch {
      return ''
    }
  },
  startRun: (issueId, setName) => startRunHere(issueId, setName),
  startGlobal: (name) => startGlobalHere(name),
  stop: (id) => runner.stop(id),
  reply: (id, text) => runner.reply(id, text),
  finishStep: (id) => runner.finishStep(id),
  continueRun: (id, text) => runner.continueRun(id, text),
  usage: (days, refresh) => usageHere(days, refresh),
  usageProgress: () => usageProgress(),
  ticketStats: (days, projectId) => ticketStatsHere(days, projectId),
  limits: () => getLimits(),
  checkLimits: () => checkLimits(getSettings().repoPath)
}

// Serves remote Night Shifts over Tailscale when Settings › Host is on (never in remote mode).
const host = new HostServer(
  () => ({ ...getSettings().host, enabled: getSettings().host.enabled && !remoteMode() }),
  (st) => {
    send('host', st)
    updateTray()
  },
  ops
)

// ---- Remote mode ----
type HostShared = ReturnType<HostOps['shared']>
let remoteShared: HostShared | null = null // in memory only
const waitingSeen = new Set<string>()

const remote = new RemoteClient(
  (st) => send('remote', st),
  (event, data) => onHostEvent(event, data),
  () => void loadFromHost()
)

// Settings as the window sees them: in remote mode, the host's shared and machine settings over ours.
function effectiveSettings(): Settings {
  const s = getSettings()
  if (!remoteMode()) return { ...s, sharedRevs: settingsRevs(sharedOf(s)) }
  if (!remoteShared) return { ...s, automations: [], sharedRevs: undefined }
  return { ...s, ...remoteShared.shared, ...remoteShared.hostMachine, sharedRevs: remoteShared.revs }
}

async function refreshShared(): Promise<void> {
  const r = await remote.call<HostShared>('GET', '/shared')
  if ('error' in r) return
  remoteShared = r
  // Keep the team and projects here too, so the board still loads while the host is off.
  const s = getSettings()
  if (s.linearTeamKey !== r.shared.linearTeamKey || JSON.stringify(s.projects) !== JSON.stringify(r.shared.projects)) {
    updateSettings({ linearTeamKey: r.shared.linearTeamKey, projects: r.shared.projects })
    void refreshBoard()
  }
  send('settings', effectiveSettings())
}

async function loadFromHost(): Promise<void> {
  await refreshShared()
  const runs = await remote.call<Run[]>('GET', '/runs')
  if (Array.isArray(runs)) {
    noteWaiting(runs, true)
    send('runs', runs)
  }
  const st = await remote.call<Record<string, unknown>>('GET', '/automations/status')
  if (!('error' in st)) send('automations', st)
  const lim = await remote.call<unknown>('GET', '/limits')
  if (lim && !(typeof lim === 'object' && 'error' in (lim as object))) send('limits', lim)
  send('steps-changed')
}

function onHostEvent(event: string, data: unknown): void {
  if (event === 'runs' && Array.isArray(data)) {
    noteWaiting(data as Run[])
    send('runs', data)
  } else if (event === 'run-output' && Array.isArray(data)) send('run-output', ...data)
  else if (event === 'automations' || event === 'limits') send(event, data)
  else if (event === 'shared-changed') void refreshShared()
  else if (event === 'steps-changed') send('steps-changed')
  else if (event === 'tickets-changed') queueTicketSync((data as { ticket?: string | null })?.ticket ?? null)
}

// "Needs you" notifications on a remote too.
function noteWaiting(runs: Run[], initial = false): void {
  for (const r of runs) {
    if (r.status !== 'waiting') waitingSeen.delete(r.id)
    else if (!waitingSeen.has(r.id)) {
      waitingSeen.add(r.id)
      if (!initial) notifyWaiting(r.id, r.identifier, r.waiting?.reason ?? 'Claude needs you')
    }
  }
}

// A host call from the window; errors become { error } like local calls, or a thrown Error for the
// screens that expect one (usage, limits).
async function viaHost<T>(method: string, path: string, body?: unknown): Promise<T | { error: string }> {
  return remote.call<T>(method, path, body)
}
async function viaHostOrThrow<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await remote.call<T>(method, path, body)
  if (r && typeof r === 'object' && 'error' in (r as object)) throw new Error((r as { error: string }).error)
  return r as T
}

// Starts or stops remote mode and the host server to match the settings.
function applyMode(): void {
  const s = getSettings()
  if (s.mode === 'remote' && s.remote.host) remote.start(s.remote)
  else {
    remote.stop()
    remoteShared = null
  }
  void host.apply()
}

async function refreshBoard(): Promise<BoardData> {
  const s = getSettings()
  const key = getLinearKey()
  if (!key || !s.linearTeamKey) {
    board = { states: [], issues: [], fetchedAt: null, error: 'Add your Linear API key and team key in Settings.' }
    send('board', board)
    return board
  }
  try {
    const [states, team] = await Promise.all([
      fetchStates(key, s.linearTeamKey),
      // Menus only, so a failure here never blocks the board.
      fetchTeamMeta(key, s.linearTeamKey).catch((err: Error) => {
        console.warn(`Linear team details: ${err.message}`)
        return board.team ?? null
      })
    ])
    allStates = states
    // Linear files duplicates under their own state type; they go with canceled.
    const hidden = (type: string): boolean => s.hiddenStateTypes.includes(type === 'duplicate' ? 'canceled' : type)
    const visible = states.filter((st) => !hidden(st.type))
    const project = s.projects.find((p) => p.id === s.activeProjectId) ?? null
    const issues = await fetchIssues(key, s.linearTeamKey, visible.map((st) => st.id), project?.linearProjectIds)
    board = {
      states: visible,
      allStates: states,
      issues,
      team,
      project,
      fetchedAt: Date.now(),
      ...(project && !project.linearProjectIds.length
        ? { error: `"${project.name}" isn't linked to a Linear project yet. Link one in Settings › Projects.` }
        : {})
    }
    saveBoardCache()
    tickAutomations()
  } catch (err) {
    board = { ...board, error: `Linear: ${(err as Error).message}` }
  }
  send('board', board)
  return board
}

// Replaces one issue with Linear's copy, dropping it if it moved to a hidden state.
async function syncIssue(key: string, issueId: string): Promise<void> {
  const fresh = await fetchIssue(key, issueId)
  const inProject = !board.project || (fresh.projectId !== null && board.project.linearProjectIds.includes(fresh.projectId))
  const visible = inProject && board.states.some((st) => st.id === fresh.stateId)
  const others = board.issues.filter((i) => i.id !== fresh.id)
  board = { ...board, issues: visible ? [...others, fresh] : others }
  saveBoardCache()
  send('board', board)
  host.broadcast('tickets-changed', { ticket: fresh.id })
}

const PRIORITIES = new Set([0, 1, 2, 3, 4])

// Only the fields the board edits, checked before anything is sent to Linear.
function cleanUpdate(u: IssueUpdate): IssueUpdate | string {
  const out: IssueUpdate = {}
  if (u.stateId !== undefined) {
    if (!allStates.some((s) => s.id === u.stateId)) return 'Unknown status'
    out.stateId = u.stateId
  }
  if (u.priority !== undefined) {
    if (!PRIORITIES.has(u.priority)) return 'Unknown priority'
    out.priority = u.priority
  }
  if (u.assigneeId !== undefined) {
    if (u.assigneeId !== null && !board.team?.members.some((m) => m.id === u.assigneeId)) return 'Unknown assignee'
    out.assigneeId = u.assigneeId
  }
  if (u.labelIds !== undefined) {
    const known = new Set(board.team?.labels.map((l) => l.id))
    if (!Array.isArray(u.labelIds) || u.labelIds.some((id) => !known.has(id))) return 'Unknown label'
    out.labelIds = u.labelIds
  }
  if (u.estimate !== undefined) {
    if (u.estimate !== null && !board.team?.estimates.some((e) => e.value === u.estimate)) return "Estimate isn't on this team's scale"
    out.estimate = u.estimate
  }
  if (u.projectMilestoneId !== undefined) {
    const known = new Set(board.team?.projects.flatMap((p) => p.milestones.map((m) => m.id)))
    if (u.projectMilestoneId !== null && !known.has(u.projectMilestoneId)) return 'Unknown milestone'
    out.projectMilestoneId = u.projectMilestoneId
  }
  return Object.keys(out).length ? out : 'Nothing to change'
}

// The board reloads from Linear once its cache is older than the board refresh interval, and only while Night Shift is the
// focused window. Automations check Linear on their own, every pollSeconds.
function schedulePolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    if (win && !win.isDestroyed() && win.isFocused()) syncIfStale()
  }, 30_000)
}

// System, dark or light. Electron passes it on to the page (prefers-color-scheme) and the title bar.
function applyTheme(): void {
  nativeTheme.themeSource = getSettings().theme
  win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0C1024' : '#F5F0E3')
}

// Reloads the board if its cache has run out (also on coming back into focus).
function syncIfStale(): void {
  if (!board.fetchedAt || Date.now() - board.fetchedAt >= boardCacheMs()) void refreshBoard()
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => effectiveSettings())
  // Shared items go to the host (or are saved here with a conflict check); the rest stays on this machine.
  ipcMain.handle('settings:save', async (_e, update: SettingsUpdate) => {
    const { sharedRevs, saveError: _ignored, ...u } = update as SettingsUpdate & Pick<Settings, 'sharedRevs' | 'saveError'>
    const before = getSettings()
    const current = effectiveSettings()
    const sharedPart: Partial<SharedSettings> = {}
    for (const k of SHARED_KEYS) {
      if (!(k in u)) continue
      const v = (u as Record<string, unknown>)[k]
      delete (u as Record<string, unknown>)[k]
      if (JSON.stringify(v) !== JSON.stringify((current as unknown as Record<string, unknown>)[k])) (sharedPart as Record<string, unknown>)[k] = v
    }
    if (before.mode === 'remote') for (const k of HOST_MACHINE_KEYS) delete (u as Record<string, unknown>)[k] // set on the host only
    let saveError: Settings['saveError']
    if (Object.keys(sharedPart).length) {
      const revs = sharedRevs ?? current.sharedRevs ?? {}
      const r =
        before.mode === 'remote'
          ? await viaHost<{ ok: true } | { conflict: SaveConflict }>('POST', '/shared', { update: sharedPart, revs })
          : saveSharedHere(sharedPart, revs, thisMachine())
      if ('conflict' in r) saveError = { message: r.conflict.message, conflict: r.conflict }
      else if ('error' in r) saveError = { message: r.error }
      else if (before.mode === 'remote') await refreshShared()
    }
    const s = updateSettings(u)
    applyTheme()
    const modeChanged = s.mode !== before.mode || s.remote.host !== before.remote.host || s.remote.port !== before.remote.port
    if (modeChanged) {
      log.info(s.mode === 'remote' ? `remote mode: using ${s.remote.host}:${s.remote.port}` : 'remote mode off: this machine runs its own agents')
      applyMode()
      // Everything on screen came from the old source: start the window over.
      setTimeout(() => win?.webContents.reload(), 200)
    } else void host.apply()
    updateTray()
    schedulePolling()
    void refreshBoard()
    return { ...effectiveSettings(), ...(saveError ? { saveError } : {}) }
  })
  ipcMain.handle('remote:status', () => remote.view())
  ipcMain.handle('remote:test', async (_e, t: RemoteTarget) => {
    const target = { host: String(t?.host ?? '').trim(), port: Number(t?.port) || 0 }
    if (!target.host || !target.port) return { error: 'Enter the host name and port.' }
    try {
      const r = await hostRequest<{ name: string; appVersion: string; apiVersion: number; error?: string }>(target, 'GET', '/host', undefined, 8000)
      if (r.status === 403) return { error: `${target.host} refused this device. Is it signed in to Tailscale as you?` }
      if (r.status !== 200) return { error: r.body?.error ?? `The host answered ${r.status}.` }
      if (r.body.apiVersion !== HOST_API_VERSION) return { error: `${r.body.name} runs Night Shift ${r.body.appVersion}, which doesn't match this version. Update both.` }
      return { ok: true, name: r.body.name, appVersion: r.body.appVersion, apiVersion: r.body.apiVersion }
    } catch (err) {
      return { error: `${(err as Error).message}. Check that Tailscale is on here, and that Night Shift is running on the host with Settings › Host turned on.` }
    }
  })
  ipcMain.handle('host:status', () => host.view())
  ipcMain.handle('automations:status', () => (remoteMode() ? viaHost('GET', '/automations/status').then((r) => ('error' in (r as object) ? {} : r)) : scheduler.view()))
  ipcMain.handle('automations:runNow', (_e, id: string) => (remoteMode() ? viaHost('POST', `/automations/${encodeURIComponent(id)}/run-now`) : scheduler.runNow(id)))
  ipcMain.handle('settings:export', async () => {
    const opts: Electron.SaveDialogOptions = {
      title: 'Export Night Shift settings',
      defaultPath: join(app.getPath('documents'), 'night-shift-settings.yml'),
      filters: [{ name: 'Night Shift settings', extensions: ['yml', 'yaml'] }]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    try {
      exportSettings(getSettings(), res.filePath)
      return { path: res.filePath }
    } catch (err) {
      return { error: `Couldn't write the file: ${(err as Error).message}` }
    }
  })
  let pendingImport: string | null = null
  ipcMain.handle('settings:importPreview', async () => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Import Night Shift settings',
      properties: ['openFile'],
      filters: [{ name: 'Night Shift settings', extensions: ['yml', 'yaml', 'json'] }]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const path = res.filePaths[0]
    if (res.canceled || !path) return null
    try {
      const groups = readImportGroups(path, getSettings())
      if (!groups.length) return { error: 'That file has nothing to import.' }
      pendingImport = path
      return {
        fileName: basename(path),
        groups: groups.map(({ key, label, summary, notes, update }) => ({
          key,
          label,
          summary,
          notes,
          empty: update.projects?.length === 0 || update.automations?.length === 0
        }))
      }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })
  ipcMain.handle('settings:importApply', (_e, keys: ImportGroupKey[]) => {
    if (!pendingImport) return { error: 'Pick the file again.' }
    if (!Array.isArray(keys) || !keys.length) return { error: 'Nothing selected to import.' }
    try {
      const current = getSettings()
      const { update, notes } = combineGroups(readImportGroups(pendingImport, current), keys, current)
      const settings = updateSettings(update)
      pendingImport = null
      schedulePolling()
      void refreshBoard()
      send('automations', scheduler.view())
      return { settings: { ...settings, ...effectiveSettings() }, notes }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })
  ipcMain.handle('board:get', () => board)
  ipcMain.handle('issue:update', async (_e, issueId: string, update: IssueUpdate) => {
    const key = getLinearKey()
    if (!key) return { error: 'Add your Linear API key in Settings.' }
    if (!board.issues.some((i) => i.id === issueId)) return { error: 'That ticket is no longer on the board.' }
    const input = cleanUpdate(update)
    if (typeof input === 'string') return { error: input }
    try {
      await updateIssue(key, issueId, input)
    } catch (err) {
      // Put Linear's version back on the board so the card doesn't show a change that didn't happen.
      await syncIssue(key, issueId).catch(() => send('board', board))
      return { error: `Linear: ${(err as Error).message}` }
    }
    try {
      await syncIssue(key, issueId)
    } catch {
      void refreshBoard()
    }
    return { ok: true }
  })
  ipcMain.handle('board:refresh', () => refreshBoard())
  ipcMain.handle('issue:detail', async (_e, issueId: string) => {
    const key = getLinearKey()
    if (!key) return { error: 'Add your Linear API key in Settings.' }
    if (!board.issues.some((i) => i.id === issueId)) return { error: 'That ticket is no longer on the board.' }
    try {
      return await fetchIssueDetail(key, issueId)
    } catch (err) {
      return { error: `Linear: ${(err as Error).message}` }
    }
  })
  ipcMain.handle('issue:relations', async (_e, issueId: string) => {
    const key = getLinearKey()
    if (!key) return { error: 'Add your Linear API key in Settings.' }
    if (!board.issues.some((i) => i.id === issueId)) return { error: 'That ticket is no longer on the board.' }
    try {
      return await fetchIssueRelations(key, issueId)
    } catch (err) {
      return { error: `Linear: ${(err as Error).message}` }
    }
  })
  ipcMain.handle('linear:image', async (_e, url: string) => {
    const key = getLinearKey()
    if (!key || typeof url !== 'string') return null
    return fetchLinearImage(key, url).catch(() => null)
  })
  ipcMain.handle('steps:get', async () => {
    if (!remoteMode()) return stepsHere()
    const r = await viaHost<StepsFile>('GET', '/actions')
    return 'error' in r ? { path: null, sets: [], error: r.error } : r
  })
  ipcMain.handle('steps:save', (_e, sets: StepSet[], revs?: Record<string, string>) => {
    if (!Array.isArray(sets)) return { error: 'Nothing to save.' }
    return remoteMode() ? viaHost('POST', '/actions', { sets, revs }) : saveStepsHere(sets, revs, thisMachine())
  })
  ipcMain.handle('steps:open', async () => {
    if (remoteMode()) return // the file is on the host
    const repo = getSettings().repoPath
    if (!repo) return
    const path = join(repo, STEPS_RELATIVE_PATH)
    if (!existsSync(path)) {
      mkdirSync(join(repo, '.nightshift'), { recursive: true })
      writeFileSync(path, starterSteps())
    }
    await shell.openPath(path)
  })
  ipcMain.handle('usage:get', (_e, days: number, refresh?: boolean) =>
    remoteMode() ? viaHostOrThrow('GET', `/usage?days=${Number(days) || 30}${refresh ? '&refresh=1' : ''}`) : usageHere(days, Boolean(refresh))
  )
  ipcMain.handle('usage:tickets', (_e, days: number) => {
    const projectId = getSettings().activeProjectId
    return remoteMode()
      ? viaHostOrThrow('GET', `/ticket-stats?days=${Number(days) || 30}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`)
      : ticketStatsHere(days, projectId)
  })
  ipcMain.handle('usage:progress', () => (remoteMode() ? viaHost('GET', '/usage/progress').then((r) => (r && 'error' in (r as object) ? null : r)) : usageProgress()))
  ipcMain.handle('limits:get', () => (remoteMode() ? viaHost('GET', '/limits').then((r) => (r && 'error' in (r as object) ? null : r)) : getLimits()))
  ipcMain.handle('update:state', () => updateState())
  ipcMain.handle('update:install', () => installUpdateNow())
  ipcMain.handle('update:check', () => checkForUpdatesNow())
  ipcMain.handle('limits:check', () => (remoteMode() ? viaHost('POST', '/limits/check') : checkLimits(getSettings().repoPath)))
  ipcMain.handle('runs:get', async () => {
    if (!remoteMode()) return runner.list()
    const r = await viaHost<Run[]>('GET', '/runs')
    return Array.isArray(r) ? r : []
  })
  ipcMain.handle('runs:start', (_e, issueId: string, setName?: string) =>
    remoteMode() ? viaHost('POST', '/runs', { issueId, setName }) : startRunHere(issueId, setName)
  )
  // A global action from the Run menu: no ticket, runs from the base branch.
  ipcMain.handle('runs:startGlobal', (_e, name: string) => (remoteMode() ? viaHost('POST', '/runs/global', { name }) : startGlobalHere(name)))
  const runPath = (id: string, what: string): string => `/runs/${encodeURIComponent(String(id))}/${what}`
  ipcMain.handle('runs:stop', (_e, runId: string) => (remoteMode() ? viaHost('POST', runPath(runId, 'stop')) : runner.stop(runId)))
  ipcMain.handle('runs:reply', (_e, runId: string, text: string) =>
    remoteMode() ? viaHost('POST', runPath(runId, 'reply'), { text: String(text ?? '') }) : runner.reply(runId, String(text ?? ''))
  )
  ipcMain.handle('runs:finishStep', (_e, runId: string) => (remoteMode() ? viaHost('POST', runPath(runId, 'finish-step')) : runner.finishStep(runId)))
  ipcMain.handle('runs:continue', (_e, runId: string, text: string) =>
    remoteMode() ? viaHost('POST', runPath(runId, 'continue'), { text: String(text ?? '') }) : runner.continueRun(runId, String(text ?? ''))
  )
  ipcMain.handle('runs:openLog', async (_e, runId: string) => {
    if (remoteMode()) return // the file is on the host; the log view shows all of it
    const run = runner.get(runId)
    if (run) await shell.openPath(run.logFile)
  })
  // Read synchronously: the runner appends to the file before it sends each chunk, so
  // chunks the renderer gets after this reply are exactly the ones not in the file yet.
  ipcMain.handle('runs:readLog', async (_e, runId: string) => {
    if (!remoteMode()) return readLogHere(runId, 4 * 1024 * 1024) ?? ''
    const r = await remote.text(runPath(runId, 'log'))
    return typeof r === 'string' ? r : `[${r.error}]`
  })
  ipcMain.handle('dialog:pickFolder', async (_e, startAt?: string) => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose the repo agents work in',
      properties: ['openDirectory'],
      defaultPath: startAt && existsSync(startAt) ? startAt : undefined
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : res.filePaths[0] ?? null
  })
  ipcMain.handle('git:branches', (_e, repoPath: string, fetch?: boolean) => listBranches(repoPath, Boolean(fetch)))
  ipcMain.handle('open:url', async (_e, url: string) => {
    if (/^https:\/\//.test(url)) await shell.openExternal(url)
  })
}

function createWindow(): void {
  // Open large: most of the screen, so the board and usage page have room.
  const area = screen.getPrimaryDisplay().workAreaSize
  win = new BrowserWindow({
    width: Math.max(960, Math.round(area.width * 0.94)),
    height: Math.max(600, Math.round(area.height * 0.92)),
    center: true,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0C1024' : '#F5F0E3',
    title: 'Night Shift',
    icon: appIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.on('focus', () => {
    win?.flashFrame(false)
    syncIfStale()
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  if (!GOT_LOCK) return
  // Windows only shows notifications for apps with an ID (matches the installer's appId).
  if (process.platform === 'win32') app.setAppUserModelId('dev.dylanyoung.nightshift')
  loadLimits(join(app.getPath('userData'), 'runs', 'logs'))
  onLimitsChange((l) => send('limits', l))
  registerIpc()
  nativeTheme.themeSource = getSettings().theme
  if (!HEADLESS) createWindow()
  updateTray()
  log.info(`Night Shift ${app.getVersion()} started${app.isPackaged ? '' : ' (development)'}`)
  startUpdater((st) => send('update', st))
  nativeTheme.on('updated', () => win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0C1024' : '#F5F0E3'))
  // A fresh board from the last session is used as is; an older one shows while the new one loads.
  if (!loadBoardCache()) void refreshBoard()
  applyMode()
  schedulePolling()
  // Schedules are checked every 30s; watch automations also check after each Linear sync.
  setInterval(tickAutomations, 30_000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// A host keeps running with no window (started headless at sign-in, or the window was closed);
// the tray icon opens it again or quits.
app.on('window-all-closed', () => {
  if (HEADLESS || (getSettings().host.enabled && !remoteMode())) return updateTray()
  if (process.platform !== 'darwin') app.quit()
})

let tray: Tray | null = null
function updateTray(): void {
  const wanted = HEADLESS || (getSettings().host.enabled && !remoteMode())
  if (!wanted) {
    tray?.destroy()
    tray = null
    return
  }
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(appIcon).resize({ width: 16, height: 16 }))
    tray.on('click', showWindow)
  }
  tray.setToolTip(`Night Shift${host.view().state === 'listening' ? ` · host for remotes on port ${host.view().port}` : ''}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Night Shift', click: showWindow },
      { type: 'separator' },
      { label: 'Quit Night Shift', click: () => app.exit(0) }
    ])
  )
}

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

