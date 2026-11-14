import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { DEFAULT_WORKTREE_PATH, type NightShiftProject, type Settings, type SettingsUpdate } from '../shared/types'

interface Stored extends Omit<Settings, 'hasLinearKey'> {
  linearApiKeyEnc?: string // encrypted with the OS keychain (safeStorage), base64
  linearApiKeyPlain?: string // only used when the OS can't encrypt
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
  projects: [],
  activeProjectId: null
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
  const { linearApiKeyEnc, linearApiKeyPlain, ...rest } = s
  return { ...rest, hasLinearKey: Boolean(linearApiKeyEnc || linearApiKeyPlain) }
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

export function updateSettings(update: SettingsUpdate): Settings {
  const s = { ...load() }
  const { linearApiKey, ...rest } = update
  Object.assign(s, rest)
  if (!s.worktreePath?.trim()) s.worktreePath = DEFAULT_WORKTREE_PATH
  s.projects = cleanProjects(s.projects)
  if (s.activeProjectId && !s.projects.some((p) => p.id === s.activeProjectId)) s.activeProjectId = null
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
  save(s)
  return getSettings()
}
