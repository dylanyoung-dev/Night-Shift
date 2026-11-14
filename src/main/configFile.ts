import { readFileSync, writeFileSync, existsSync } from 'fs'
import YAML from 'yaml'
import type { NightShiftProject, Settings, SettingsUpdate, WorktreeMode } from '../shared/types'

// A shareable settings file: general settings and projects only. Never the Linear API key,
// the active project or run history.
const VERSION = 1

const HEADER = `# Night Shift settings, exported to share with another machine.
# Import it from Settings › Import settings. It has your projects and general settings.
# It does not contain your Linear API key: add that on each machine.
`

export function exportSettings(s: Settings, path: string): void {
  const doc = {
    version: VERSION,
    linear: { teamKey: s.linearTeamKey, pollSeconds: s.pollSeconds, hiddenStateTypes: s.hiddenStateTypes },
    repo: { path: s.repoPath, baseBranch: s.baseBranch },
    worktrees: { mode: s.worktreeMode, path: s.worktreePath },
    runs: { maxConcurrent: s.maxConcurrent },
    projects: s.projects.map((p) => ({ id: p.id, name: p.name, linearProjectIds: p.linearProjectIds }))
  }
  writeFileSync(path, `${HEADER}\n${YAML.stringify(doc, { lineWidth: 0 })}`)
}

export interface ImportResult {
  update: SettingsUpdate
  notes: string[] // what the person should know, e.g. a repo path kept from this machine
}

const STATE_TYPES = new Set(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'])

// Reads and checks a settings file. Only known fields are taken; anything else is ignored.
export function readSettingsFile(path: string, current: Settings): ImportResult {
  const raw = YAML.parse(readFileSync(path, 'utf8')) as Record<string, any> | null
  if (!raw || typeof raw !== 'object') throw new Error("That file isn't a Night Shift settings file.")
  if (typeof raw.version !== 'number' || raw.version > VERSION) {
    throw new Error(raw.version > VERSION ? 'That file is from a newer Night Shift. Update this copy first.' : "That file isn't a Night Shift settings file.")
  }
  const update: SettingsUpdate = {}
  const notes: string[] = []
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const num = (v: unknown, min: number, max: number): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined

  const teamKey = str(raw.linear?.teamKey)
  if (teamKey) update.linearTeamKey = teamKey
  const poll = num(raw.linear?.pollSeconds, 15, 3600)
  if (poll) update.pollSeconds = poll
  if (Array.isArray(raw.linear?.hiddenStateTypes)) {
    update.hiddenStateTypes = raw.linear.hiddenStateTypes.map(String).filter((t: string) => STATE_TYPES.has(t))
  }

  const repoPath = str(raw.repo?.path)
  if (repoPath) {
    if (existsSync(repoPath)) update.repoPath = repoPath
    else notes.push(`Repo path ${repoPath} doesn't exist on this machine, so ${current.repoPath ? `${current.repoPath} was kept` : 'it was left empty'}. Set it in Settings.`)
  }
  const base = str(raw.repo?.baseBranch)
  if (base) update.baseBranch = base

  const mode = raw.worktrees?.mode as WorktreeMode | undefined
  if (mode === 'nightshift' || mode === 'agent') update.worktreeMode = mode
  const wtPath = str(raw.worktrees?.path)
  if (wtPath) update.worktreePath = wtPath

  const max = num(raw.runs?.maxConcurrent, 1, 10)
  if (max) update.maxConcurrent = max

  if (Array.isArray(raw.projects)) {
    update.projects = raw.projects
      .filter((p: any) => p && typeof p === 'object')
      .map(
        (p: any): NightShiftProject => ({
          id: str(p.id) ?? '',
          name: str(p.name) ?? 'Untitled project',
          linearProjectIds: Array.isArray(p.linearProjectIds) ? p.linearProjectIds.map(String) : []
        })
      )
    notes.push(`${update.projects.length} ${update.projects.length === 1 ? 'project' : 'projects'} imported, replacing the ones here.`)
  }
  return { update, notes }
}
