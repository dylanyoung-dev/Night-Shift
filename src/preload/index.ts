import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type { AutomationStatus, BoardData, NightShiftApi, PlanLimits, UpdateState, Run, Settings, SettingsUpdate } from '../shared/types'

function listen<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: NightShiftApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (update: SettingsUpdate) => ipcRenderer.invoke('settings:save', update),
  exportSettings: () => ipcRenderer.invoke('settings:export'),
  previewImport: () => ipcRenderer.invoke('settings:importPreview'),
  applyImport: (keys) => ipcRenderer.invoke('settings:importApply', keys),
  getBoard: () => ipcRenderer.invoke('board:get'),
  refreshBoard: () => ipcRenderer.invoke('board:refresh'),
  getSteps: () => ipcRenderer.invoke('steps:get'),
  saveSteps: (sets) => ipcRenderer.invoke('steps:save', sets),
  openStepsFile: () => ipcRenderer.invoke('steps:open'),
  getRuns: () => ipcRenderer.invoke('runs:get'),
  startRun: (issueId: string, setName?: string) => ipcRenderer.invoke('runs:start', issueId, setName),
  startGlobalRun: (name: string) => ipcRenderer.invoke('runs:startGlobal', name),
  stopRun: (runId: string) => ipcRenderer.invoke('runs:stop', runId),
  openLog: (runId: string) => ipcRenderer.invoke('runs:openLog', runId),
  readLog: (runId: string) => ipcRenderer.invoke('runs:readLog', runId),
  replyToRun: (runId: string, text: string) => ipcRenderer.invoke('runs:reply', runId, text),
  finishRunStep: (runId: string) => ipcRenderer.invoke('runs:finishStep', runId),
  continueRun: (runId: string, text: string) => ipcRenderer.invoke('runs:continue', runId, text),
  getUsage: (days: number, refresh?: boolean) => ipcRenderer.invoke('usage:get', days, refresh),
  getTicketStats: (days: number) => ipcRenderer.invoke('usage:tickets', days),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  onUpdateState: (cb) => listen<[UpdateState]>('update', cb),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getIssueDetail: (issueId: string) => ipcRenderer.invoke('issue:detail', issueId),
  linearImage: (url: string) => ipcRenderer.invoke('linear:image', url),
  getLimits: () => ipcRenderer.invoke('limits:get'),
  checkLimits: () => ipcRenderer.invoke('limits:check'),
  onLimits: (cb) => listen<[PlanLimits]>('limits', cb),
  usageProgress: () => ipcRenderer.invoke('usage:progress'),
  onOpenRun: (cb) => listen<[string]>('open-run', cb),
  getAutomationStatus: () => ipcRenderer.invoke('automations:status'),
  runAutomationNow: (id: string) => ipcRenderer.invoke('automations:runNow', id),
  onAutomationStatus: (cb) => listen<[Record<string, AutomationStatus>]>('automations', cb),
  onSettings: (cb) => listen<[Settings]>('settings', cb),
  updateIssue: (issueId, update) => ipcRenderer.invoke('issue:update', issueId, update),
  openInBrowser: (url: string) => ipcRenderer.invoke('open:url', url),
  pickFolder: (startAt?: string) => ipcRenderer.invoke('dialog:pickFolder', startAt),
  listBranches: (repoPath: string, fetch?: boolean) => ipcRenderer.invoke('git:branches', repoPath, fetch),
  onBoard: (cb) => listen<[BoardData]>('board', cb),
  onRuns: (cb) => listen<[Run[]]>('runs', cb),
  onRunOutput: (cb) => listen<[string, string]>('run-output', cb)
}

contextBridge.exposeInMainWorld('nightShift', api)
