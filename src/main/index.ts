import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'fs'
import type { BoardData, IssueUpdate, LinearState, SettingsUpdate, StepSet } from '../shared/types'
import { getLinearKey, getSettings, updateSettings } from './settings'
import { fetchIssue, fetchIssues, fetchStates, fetchTeamMeta, moveIssue, updateIssue } from './linear'
import { loadSteps, saveSteps, setForState, starterSteps, STEPS_RELATIVE_PATH } from './steps'
import { Runner } from './runner'
import { listBranches } from './git'
import { exportSettings, readSettingsFile } from './configFile'

// Pin the data folder so dev runs and an installed copy share settings and run history,
// whatever product name the installer uses.
app.setPath('userData', join(app.getPath('appData'), 'night-shift'))

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
  onOutput: (runId, chunk) => send('run-output', runId, chunk)
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
    autoStart()
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
  return Object.keys(out).length ? out : 'Nothing to change'
}

// Starts runs for tickets whose state's set of steps triggers automatically.
function autoStart(): void {
  const s = getSettings()
  if (!s.repoPath) return
  const file = loadSteps(s.repoPath)
  for (const issue of board.issues) {
    const set = setForState(file, issue.stateName)
    if (!set || set.trigger !== 'auto') continue
    if (runner.isBusy(issue.id) || runner.ranRecently(issue.id, set.name)) continue
    runner.start(issue, set)
  }
}

function schedulePolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  const seconds = Math.max(15, getSettings().pollSeconds)
  pollTimer = setInterval(() => void refreshBoard(), seconds * 1000)
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', (_e, update: SettingsUpdate) => {
    const s = updateSettings(update)
    schedulePolling()
    void refreshBoard()
    return s
  })
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
  ipcMain.handle('settings:import', async () => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Import Night Shift settings',
      properties: ['openFile'],
      filters: [{ name: 'Night Shift settings', extensions: ['yml', 'yaml', 'json'] }]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const path = res.filePaths[0]
    if (res.canceled || !path) return null
    try {
      const { update, notes } = readSettingsFile(path, getSettings())
      const settings = updateSettings(update)
      schedulePolling()
      void refreshBoard()
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
  ipcMain.handle('runs:get', () => runner.list())
  ipcMain.handle('runs:start', (_e, issueId: string) => {
    const s = getSettings()
    if (!s.repoPath) return { error: 'Set the repo path in Settings first.' }
    const issue = board.issues.find((i) => i.id === issueId)
    if (!issue) return { error: 'Ticket not found on the board. Try Sync Linear.' }
    if (runner.isBusy(issue.id)) return { error: `${issue.identifier} already has a run going.` }
    const set = setForState(loadSteps(s.repoPath), issue.stateName)
    if (!set) return { error: `No set of steps includes "${issue.stateName}".` }
    return runner.start(issue, set)
  })
  ipcMain.handle('runs:stop', (_e, runId: string) => runner.stop(runId))
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
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0F1115',
    title: 'Night Shift',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  void refreshBoard()
  schedulePolling()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
