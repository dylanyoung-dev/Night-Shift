import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { DEFAULT_HOST_PORT, DEFAULT_WORKTREE_PATH, type Automation, type HostSettings, type NightShiftProject, type Settings, type SettingsUpdate } from '../shared/types'

interface Stored extends Omit<Settings, 'hasLinearKey' | 'hasGithubToken'> {
  linearApiKeyEnc?: string // encrypted with the OS keychain (safeStorage), base64
  linearApiKeyPlain?: string // only used when the OS can't encrypt
  githubTokenEnc?: string // same, for the GitHub token
  githubTokenPlain?: string
}

const defaults: Stored = {
  linearTeamKey: 'IGN',
  repoPath: '',
  baseBranch: 'main',
  worktreeMode: 'nightshift',
  worktreePath: DEFAULT_WORKTREE_PATH,
  pollSeconds: 60,
  maxConcurrent: 3,
  hiddenStateTypes: ['backlog', 'completed', 'canceled'],
  columnOrder: [],
  projects: [],
  activeProjectId: null,
  automations: [],
  theme: 'system',
  host: { enabled: false, name: '', port: DEFAULT_HOST_PORT, allowedLogins: [] },
  mode: 'local',
  remote: { host: '', port: DEFAULT_HOST_PORT },
  boardRefreshMinutes: 5
}

let cache: Stored | null = null

function file(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'settings.json')
}

function load(): Stored {
  if (cache) return cache
  try {
    cache = { ...defaults, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch {
    cache = { ...defaults }
  }
  return cache!
}

function save(s: Stored): void {
  cache = s
  writeFileSync(file(), JSON.stringify(s, null, 2))
}

export function getSettings(): Settings {
  const s = load()
  const { linearApiKeyEnc, linearApiKeyPlain, githubTokenEnc, githubTokenPlain, ...rest } = s
  return { ...rest, hasLinearKey: Boolean(linearApiKeyEnc || linearApiKeyPlain), hasGithubToken: Boolean(githubTokenEnc || githubTokenPlain) }
}

function decrypt(enc: string | undefined, plain: string | undefined): string | null {
  if (enc) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      return null
    }
  }
  return plain || null
}

// This machine's GitHub token (pull request status and merging). Never exported or shared.
export function getGithubToken(): string | null {
  const s = load()
  return decrypt(s.githubTokenEnc, s.githubTokenPlain)
}

export function getLinearKey(): string | null {
  const s = load()
  if (s.linearApiKeyEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(s.linearApiKeyEnc, 'base64'))
    } catch {
      return null
    }
  }
  return s.linearApiKeyPlain || null
}

function cleanProjects(raw: unknown): NightShiftProject[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: NightShiftProject[] = []
  for (const p of raw as Partial<NightShiftProject>[]) {
    const id = typeof p?.id === 'string' && p.id ? p.id : randomUUID()
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: String(p?.name ?? '').trim() || 'Untitled project',
      linearProjectIds: Array.isArray(p?.linearProjectIds) ? [...new Set(p.linearProjectIds.map(String))] : []
    })
  }
  return out
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const clamp = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback

// Keeps only well-formed automations; numbers are clamped so a typo can't flood the queue.
export function cleanAutomations(raw: unknown, projects: NightShiftProject[]): Automation[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Automation[] = []
  for (const a of raw as Partial<Automation>[]) {
    if (!a || typeof a !== 'object') continue
    const id = typeof a.id === 'string' && a.id ? a.id : randomUUID()
    if (seen.has(id)) continue
    seen.add(id)
    const window =
      a.window && TIME.test(String(a.window.start)) && TIME.test(String(a.window.end)) && a.window.start !== a.window.end
        ? { start: a.window.start, end: a.window.end }
        : null
    out.push({
      id,
      name: String(a.name ?? '').trim() || 'Untitled automation',
      enabled: a.enabled === true,
      kind: a.kind === 'global' ? 'global' : 'tickets',
      globalAction: a.kind === 'global' && typeof a.globalAction === 'string' && a.globalAction.trim() ? a.globalAction.trim() : null,
      mode: a.kind === 'global' ? 'schedule' : a.mode === 'watch' ? 'watch' : 'schedule', // global actions only run on a schedule
      projectId: a.projectId && projects.some((p) => p.id === a.projectId) ? a.projectId : null,
      states: Array.isArray(a.states) ? [...new Set(a.states.map(String).filter(Boolean))] : [],
      stepSet: typeof a.stepSet === 'string' && a.stepSet.trim() ? a.stepSet.trim() : null,
      runner: 'local',
      days: Array.isArray(a.days) ? [...new Set(a.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [],
      window,
      everyMinutes: clamp(a.everyMinutes, 5, 7 * 24 * 60, 60),
      ticketsPerRun: clamp(a.ticketsPerRun, 1, 20, 1),
      onlyIfTickets: a.onlyIfTickets !== false,
      maxRuns: a.maxRuns == null ? null : clamp(a.maxRuns, 1, 10000, 1),
      perTicket: a.perTicket === 'repeat' ? 'repeat' : 'perArrival',
      cooldownHours: clamp(a.cooldownHours, 0, 24 * 30, 12),
      maxActive: clamp(a.maxActive, 1, 20, 1)
    })
  }
  return out
}

function cleanHost(raw: unknown): HostSettings {
  const h = (raw && typeof raw === 'object' ? raw : {}) as Partial<HostSettings>
  const port = Number(h.port)
  return {
    enabled: h.enabled === true,
    name: String(h.name ?? '').trim().slice(0, 60),
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_HOST_PORT,
    allowedLogins: Array.isArray(h.allowedLogins)
      ? [...new Set(h.allowedLogins.map((l) => String(l).trim().toLowerCase()).filter((l) => /^[^\s@]+@[^\s@]+$/.test(l)))]
      : []
  }
}

export function updateSettings(update: SettingsUpdate): Settings {
  const s = { ...load() }
  const { linearApiKey, githubToken, ...rest } = update
  Object.assign(s, rest)
  delete (s as Partial<Settings>).hasLinearKey // read-only flags, never stored
  delete (s as Partial<Settings>).hasGithubToken
  if (!s.worktreePath?.trim()) s.worktreePath = DEFAULT_WORKTREE_PATH
  s.projects = cleanProjects(s.projects)
  if (s.activeProjectId && !s.projects.some((p) => p.id === s.activeProjectId)) s.activeProjectId = null
  s.automations = cleanAutomations(s.automations, s.projects)
  if (s.theme !== 'dark' && s.theme !== 'light') s.theme = 'system'
  s.host = cleanHost(s.host)
  s.mode = s.mode === 'remote' ? 'remote' : 'local'
  const rport = Number(s.remote?.port)
  s.remote = {
    host: String(s.remote?.host ?? '').trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, ''),
    port: Number.isInteger(rport) && rport >= 1 && rport <= 65535 ? rport : DEFAULT_HOST_PORT
  }
  s.boardRefreshMinutes = clamp(s.boardRefreshMinutes, 1, 120, 5)
  delete (s as Partial<Settings>).sharedRevs
  delete (s as Partial<Settings>).saveError
  s.columnOrder = Array.isArray(s.columnOrder) ? [...new Set(s.columnOrder.map(String).filter(Boolean))] : []
  if (linearApiKey !== undefined) {
    delete s.linearApiKeyEnc
    delete s.linearApiKeyPlain
    if (linearApiKey) {
      if (safeStorage.isEncryptionAvailable()) {
        s.linearApiKeyEnc = safeStorage.encryptString(linearApiKey).toString('base64')
      } else {
        s.linearApiKeyPlain = linearApiKey
      }
    }
  }
  if (githubToken !== undefined) {
    delete s.githubTokenEnc
    delete s.githubTokenPlain
    const t = githubToken.trim()
    if (t) {
      if (safeStorage.isEncryptionAvailable()) s.githubTokenEnc = safeStorage.encryptString(t).toString('base64')
      else s.githubTokenPlain = t
    }
  }
  save(s)
  return getSettings()
}
