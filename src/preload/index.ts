import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type { BoardData, NightShiftApi, Run, SettingsUpdate } from '../shared/types'

function listen<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: NightShiftApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (update: SettingsUpdate) => ipcRenderer.invoke('settings:save', update),
  exportSettings: () => ipcRenderer.invoke('settings:export'),
  importSettings: () => ipcRenderer.invoke('settings:import'),
  getBoard: () => ipcRenderer.invoke('board:get'),
  refreshBoard: () => ipcRenderer.invoke('board:refresh'),
  getSteps: () => ipcRenderer.invoke('steps:get'),
  saveSteps: (sets) => ipcRenderer.invoke('steps:save', sets),
  openStepsFile: () => ipcRenderer.invoke('steps:open'),
  getRuns: () => ipcRenderer.invoke('runs:get'),
  startRun: (issueId: string) => ipcRenderer.invoke('runs:start', issueId),
  stopRun: (runId: string) => ipcRenderer.invoke('runs:stop', runId),
  openLog: (runId: string) => ipcRenderer.invoke('runs:openLog', runId),
  readLog: (runId: string) => ipcRenderer.invoke('runs:readLog', runId),
  updateIssue: (issueId, update) => ipcRenderer.invoke('issue:update', issueId, update),
  openInBrowser: (url: string) => ipcRenderer.invoke('open:url', url),
  pickFolder: (startAt?: string) => ipcRenderer.invoke('dialog:pickFolder', startAt),
  listBranches: (repoPath: string, fetch?: boolean) => ipcRenderer.invoke('git:branches', repoPath, fetch),
  onBoard: (cb) => listen<[BoardData]>('board', cb),
  onRuns: (cb) => listen<[Run[]]>('runs', cb),
  onRunOutput: (cb) => listen<[string, string]>('run-output', cb)
}

contextBridge.exposeInMainWorld('nightShift', api)
