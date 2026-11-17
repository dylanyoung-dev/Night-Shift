import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, screen, shell } from 'electron'
import { basename, join } from 'path'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'fs'
import type { BoardData, ImportGroupKey, IssueUpdate, LinearState, SettingsUpdate, StepSet } from '../shared/types'
import { globalRunKey } from '../shared/types'
import { getLinearKey, getSettings, updateSettings } from './settings'
import { addComment, addLabelByName, fetchIssue, fetchIssues, fetchStates, fetchTeamMeta, moveIssue, removeLabelByName, updateIssue, fetchIssueDetail, fetchLinearImage } from './linear'
import { globalSet, loadSteps, saveSteps, setForState, setsForState, starterSteps, STEPS_RELATIVE_PATH } from './steps'
import { Runner } from './runner'
import { getUsage, usageProgress } from './usage'
import { getTicketStats } from './ticketStats'
import { checkLimits, getLimits, loadLimits, onLimitsChange } from './limits'
import { installUpdateNow, startUpdater, updateState } from './updater'
import { log } from './log'
import { listBranches } from './git'
import { combineGroups, exportSettings, readImportGroups } from './configFile'
import { AutomationScheduler } from './automations'
import appIcon from '../../resources/icon.png?asset'

// Pin the data folder so dev runs and an installed copy share settings and run history,
// whatever product name the installer uses. NIGHTSHIFT_USER_DATA points a copy elsewhere (testing).
app.setPath('userData', process.env.NIGHTSHIFT_USER_DATA || join(app.getPath('appData'), 'night-shift'))

let win: BrowserWindow | null = null
let board: BoardData = { states: [], issues: [], fetchedAt: null }
let allStates: LinearState[] = [] // every team state, hidden ones too, for moves by name
let pollTimer: NodeJS.Timeout | null = null

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
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
    const s = updateSettings({ automations: getSettings().automations.map((a) => (a.id === id ? { ...a, enabled: false } : a)) })
    send('settings', s)
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
    void scheduler.tick()
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
  const others = board.issues.filter((i) => i.id !== issueId)
  board = { ...board, issues: visible ? [...others, fresh] : others }
  send('board', board)
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

function pollMs(): number {
  return Math.max(15, getSettings().pollSeconds) * 1000
}

// Linear syncs only while Night Shift is the focused window; automations keep their own checks.
function schedulePolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => {
    if (win && !win.isDestroyed() && win.isFocused()) void refreshBoard()
  }, pollMs())
}

// System, dark or light. Electron passes it on to the page (prefers-color-scheme) and the title bar.
function applyTheme(): void {
  nativeTheme.themeSource = getSettings().theme
  win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0F1115' : '#F6F7F9')
}

// Back in focus: catch up straight away if the last sync is older than the interval.
function syncIfStale(): void {
  if (!board.fetchedAt || Date.now() - board.fetchedAt >= pollMs()) void refreshBoard()
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', (_e, update: SettingsUpdate) => {
    const before = getSettings().automations
    const s = updateSettings(update)
    applyTheme()
    // Switching an automation back on, or changing its run limit, starts its count over.
    for (const a of s.automations) {
      const old = before.find((b) => b.id === a.id)
      if (old && ((a.enabled && !old.enabled) || a.maxRuns !== old.maxRuns)) scheduler.resetCount(a.id)
    }
    schedulePolling()
    void refreshBoard()
    send('automations', scheduler.view())
    return s
  })
  ipcMain.handle('automations:status', () => scheduler.view())
  ipcMain.handle('automations:runNow', (_e, id: string) => scheduler.runNow(id))
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
      return { settings, notes }
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
  ipcMain.handle('linear:image', async (_e, url: string) => {
    const key = getLinearKey()
    if (!key || typeof url !== 'string') return null
    return fetchLinearImage(key, url).catch(() => null)
  })
  ipcMain.handle('steps:get', () => loadSteps(getSettings().repoPath))
  ipcMain.handle('steps:save', (_e, sets: StepSet[]) => {
    if (!Array.isArray(sets)) return { error: 'Nothing to save.' }
    return saveSteps(getSettings().repoPath, sets)
  })
  ipcMain.handle('steps:open', async () => {
    const repo = getSettings().repoPath
    if (!repo) return
    const path = join(repo, STEPS_RELATIVE_PATH)
    if (!existsSync(path)) {
      mkdirSync(join(repo, '.nightshift'), { recursive: true })
      writeFileSync(path, starterSteps())
    }
    await shell.openPath(path)
  })
  ipcMain.handle('usage:get', (_e, days: number, refresh?: boolean) => {
    const sessions = new Set<string>()
    for (const r of runner.list()) for (const st of r.steps) if (st.sessionId) sessions.add(st.sessionId)
    return getUsage(Math.min(365, Math.max(1, Math.round(Number(days) || 30))), sessions, Boolean(refresh))
  })
  ipcMain.handle('usage:tickets', (_e, days: number) => {
    const s = getSettings()
    const project = s.projects.find((p) => p.id === s.activeProjectId) ?? null
    return getTicketStats(Math.min(365, Math.max(1, Math.round(Number(days) || 30))), {
      apiKey: getLinearKey() ?? '',
      teamKey: s.linearTeamKey,
      projectIds: project?.linearProjectIds,
      runs: runner.list()
    })
  })
  ipcMain.handle('usage:progress', () => usageProgress())
  ipcMain.handle('limits:get', () => getLimits())
  ipcMain.handle('update:state', () => updateState())
  ipcMain.handle('update:install', () => installUpdateNow())
  ipcMain.handle('limits:check', () => checkLimits(getSettings().repoPath))
  ipcMain.handle('runs:get', () => runner.list())
  ipcMain.handle('runs:start', (_e, issueId: string, setName?: string) => {
    const s = getSettings()
    if (!s.repoPath) return { error: 'Set the repo path in Settings first.' }
    const issue = board.issues.find((i) => i.id === issueId)
    if (!issue) return { error: 'Ticket not found on the board. Try Sync Linear.' }
    if (runner.isBusy(issue.id)) return { error: `${issue.identifier} already has a run going.` }
    const sets = setsForState(loadSteps(s.repoPath), issue.stateName)
    if (!sets.length) return { error: `No action is set up for "${issue.stateName}".` }
    const set = setName ? sets.find((x) => x.name === setName) : sets.length === 1 ? sets[0] : undefined
    if (!set) return { error: setName ? `"${setName}" doesn't cover "${issue.stateName}" any more.` : `Pick which action to run: ${sets.map((x) => x.label || x.name).join(' or ')}.` }
    return runner.start(issue, set)
  })
  // A global action from the Run menu: no ticket, runs from the base branch.
  ipcMain.handle('runs:startGlobal', (_e, name: string) => {
    const s = getSettings()
    if (!s.repoPath) return { error: 'Set the repo path in Settings first.' }
    if (!s.baseBranch) return { error: 'Pick a base branch first.' }
    const set = globalSet(loadSteps(s.repoPath), String(name ?? ''))
    if (!set) return { error: `"${name}" isn't a global action any more. Check the Actions page.` }
    if (runner.isBusy(globalRunKey(set.name))) return { error: `${set.name} is already running.` }
    return runner.startGlobal(set)
  })
  ipcMain.handle('runs:stop', (_e, runId: string) => runner.stop(runId))
  ipcMain.handle('runs:reply', (_e, runId: string, text: string) => runner.reply(runId, String(text ?? '')))
  ipcMain.handle('runs:finishStep', (_e, runId: string) => runner.finishStep(runId))
  ipcMain.handle('runs:continue', (_e, runId: string, text: string) => runner.continueRun(runId, String(text ?? '')))
  ipcMain.handle('runs:openLog', async (_e, runId: string) => {
    const run = runner.get(runId)
    if (run) await shell.openPath(run.logFile)
  })
  // Read synchronously: the runner appends to the file before it sends each chunk, so
  // chunks the renderer gets after this reply are exactly the ones not in the file yet.
  ipcMain.handle('runs:readLog', (_e, runId: string) => {
    const run = runner.get(runId)
    if (!run) return ''
    try {
      const size = statSync(run.logFile).size
      const max = 4 * 1024 * 1024
      if (size <= max) return readFileSync(run.logFile, 'utf8')
      const fd = openSync(run.logFile, 'r')
      try {
        const buf = Buffer.alloc(max)
        readSync(fd, buf, 0, max, size - max)
        return `[Showing the last 4 MB of ${(size / 1024 / 1024).toFixed(1)} MB. Open the file for the rest.]\n` + buf.toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return run.logTail // file missing: fall back to what's kept in memory
    }
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0F1115' : '#F6F7F9',
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
  // Windows only shows notifications for apps with an ID (matches the installer's appId).
  if (process.platform === 'win32') app.setAppUserModelId('dev.dylanyoung.nightshift')
  loadLimits(join(app.getPath('userData'), 'runs', 'logs'))
  onLimitsChange((l) => send('limits', l))
  registerIpc()
  nativeTheme.themeSource = getSettings().theme
  createWindow()
  log.info(`Night Shift ${app.getVersion()} started${app.isPackaged ? '' : ' (development)'}`)
  startUpdater((st) => send('update', st))
  nativeTheme.on('updated', () => win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0F1115' : '#F6F7F9'))
  void refreshBoard()
  schedulePolling()
  // Schedules are checked every 30s; watch automations also check after each Linear sync.
  setInterval(() => void scheduler.tick(), 30_000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

