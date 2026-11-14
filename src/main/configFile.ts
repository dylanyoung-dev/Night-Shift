import { readFileSync, writeFileSync, existsSync } from 'fs'
import YAML from 'yaml'
import type { ImportGroupKey, NightShiftProject, Settings, SettingsUpdate, WorktreeMode } from '../shared/types'
import { cleanAutomations } from './settings'

// A shareable settings file: general settings, projects and automations. Never the Linear API key,
// the active project, automation progress or run history.
const VERSION = 1

const HEADER = `# Night Shift settings, exported to share with another machine.
# Import it from Settings › Import settings. It has your projects, automations and general settings.
# It does not contain your Linear API key: add that on each machine.
# Automations arrive switched off, so two machines don't run the same agents by accident.
`

export function exportSettings(s: Settings, path: string): void {
  const doc = {
    version: VERSION,
    linear: { teamKey: s.linearTeamKey, pollSeconds: s.pollSeconds, hiddenStateTypes: s.hiddenStateTypes },
    repo: { path: s.repoPath, baseBranch: s.baseBranch },
    worktrees: { mode: s.worktreeMode, path: s.worktreePath },
    runs: { maxConcurrent: s.maxConcurrent },
    projects: s.projects.map((p) => ({ id: p.id, name: p.name, linearProjectIds: p.linearProjectIds })),
    // Everything but the on/off switch, which stays per machine.
    automations: s.automations.map(({ enabled: _on, ...a }) => a)
  }
  writeFileSync(path, `${HEADER}\n${YAML.stringify(doc, { lineWidth: 0 })}`)
}

export interface ImportResult {
  update: SettingsUpdate
  notes: string[] // what the person should know, e.g. a repo path kept from this machine
}

// One part of the file that can be imported or left out.
export interface ImportGroupData {
  key: ImportGroupKey
  label: string
  summary: string
  update: SettingsUpdate
  notes: string[]
}

const STATE_TYPES = new Set(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'])

// Reads and checks a settings file, split into parts that can be picked separately.
// Only known fields are taken; anything else is ignored.
export function readImportGroups(path: string, current: Settings): ImportGroupData[] {
  const raw = YAML.parse(readFileSync(path, 'utf8')) as Record<string, any> | null
  if (!raw || typeof raw !== 'object') throw new Error("That file isn't a Night Shift settings file.")
  if (typeof raw.version !== 'number' || raw.version > VERSION) {
    throw new Error(raw.version > VERSION ? 'That file is from a newer Night Shift. Update this copy first.' : "That file isn't a Night Shift settings file.")
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const num = (v: unknown, min: number, max: number): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined
  const groups: ImportGroupData[] = []
  const add = (key: ImportGroupKey, label: string, update: SettingsUpdate, summary: string, notes: string[] = []): void => {
    if (Object.keys(update).length || notes.length) groups.push({ key, label, summary, update, notes })
  }
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

  {
    const u: SettingsUpdate = {}
    const teamKey = str(raw.linear?.teamKey)
    if (teamKey) u.linearTeamKey = teamKey
    const poll = num(raw.linear?.pollSeconds, 15, 3600)
    if (poll) u.pollSeconds = poll
    if (Array.isArray(raw.linear?.hiddenStateTypes)) {
      u.hiddenStateTypes = raw.linear.hiddenStateTypes.map(String).filter((t: string) => STATE_TYPES.has(t))
    }
    const bits = [
      u.linearTeamKey ? `team ${u.linearTeamKey}` : '',
      u.pollSeconds ? `checks every ${u.pollSeconds}s` : '',
      u.hiddenStateTypes ? `hides ${u.hiddenStateTypes.join(', ') || 'nothing'}` : ''
    ]
    add('linear', 'Linear', u, bits.filter(Boolean).join(' · '))
  }
  {
    const u: SettingsUpdate = {}
    const notes: string[] = []
    const repoPath = str(raw.repo?.path)
    if (repoPath) {
      if (existsSync(repoPath)) u.repoPath = repoPath
      else notes.push(`Repo path ${repoPath} doesn't exist on this machine, so ${current.repoPath ? `${current.repoPath} is kept` : 'it stays empty'}. Set it in Settings.`)
    }
    const base = str(raw.repo?.baseBranch)
    if (base) u.baseBranch = base
    const where = u.repoPath ?? (repoPath ? `${repoPath} (not on this machine)` : '')
    add('repo', 'Repository', u, [where, u.baseBranch ? `base ${u.baseBranch}` : ''].filter(Boolean).join(' · '), notes)
  }
  {
    const u: SettingsUpdate = {}
    const mode = raw.worktrees?.mode as WorktreeMode | undefined
    if (mode === 'nightshift' || mode === 'agent') u.worktreeMode = mode
    const wtPath = str(raw.worktrees?.path)
    if (wtPath) u.worktreePath = wtPath
    const how = u.worktreeMode ? (u.worktreeMode === 'agent' ? 'agent decides' : 'Night Shift creates them') : ''
    add('worktrees', 'Worktrees', u, [how, u.worktreePath ?? ''].filter(Boolean).join(' · '))
  }
  {
    const u: SettingsUpdate = {}
    const max = num(raw.runs?.maxConcurrent, 1, 10)
    if (max) u.maxConcurrent = max
    add('runs', 'Runs', u, max ? `${max} local runs at once` : '')
  }
  let fileProjects: NightShiftProject[] = []
  if (Array.isArray(raw.projects)) {
    fileProjects = raw.projects
      .filter((p: any) => p && typeof p === 'object')
      .map(
        (p: any): NightShiftProject => ({
          id: str(p.id) ?? '',
          name: str(p.name) ?? 'Untitled project',
          linearProjectIds: Array.isArray(p.linearProjectIds) ? p.linearProjectIds.map(String) : []
        })
      )
    const names = fileProjects.map((p) => p.name).join(', ')
    add('projects', 'Projects', { projects: fileProjects }, `${plural(fileProjects.length, 'project')}${names ? `: ${names}` : ''}. Replaces the ones here.`)
  }
  if (Array.isArray(raw.automations)) {
    // Keep project links that match this machine's projects or the file's; the rest are
    // checked again when the groups are combined.
    const automations = cleanAutomations(
      raw.automations.map((a: any) => ({ ...a, enabled: false })),
      [...current.projects, ...fileProjects]
    )
    const names = automations.map((a) => a.name).join(', ')
    add('automations', 'Automations', { automations }, `${plural(automations.length, 'automation')}${names ? `: ${names}` : ''}. Replaces the ones here; all arrive switched off.`)
  }
  return groups
}

// Combines the chosen groups into one settings update. An automation whose project won't
// exist after import is pointed at all of the team instead.
export function combineGroups(groups: ImportGroupData[], keys: ImportGroupKey[], current: Settings): ImportResult {
  const chosen = groups.filter((g) => keys.includes(g.key))
  const update: SettingsUpdate = Object.assign({}, ...chosen.map((g) => g.update))
  const notes = chosen.flatMap((g) => g.notes)
  if (update.projects) notes.push(`${update.projects.length} ${update.projects.length === 1 ? 'project' : 'projects'} imported, replacing the ones here.`)
  if (update.automations) {
    const projectIds = new Set((update.projects ?? current.projects).map((p) => p.id))
    update.automations = update.automations.map((a) => (a.projectId && !projectIds.has(a.projectId) ? { ...a, projectId: null } : a))
    notes.push(`${update.automations.length} ${update.automations.length === 1 ? 'automation' : 'automations'} imported, all switched off. Turn on the ones this machine should run.`)
  }
  return { update, notes }
}

// Everything in the file at once.
export function readSettingsFile(path: string, current: Settings): ImportResult {
  const groups = readImportGroups(path, current)
  return combineGroups(groups, groups.map((g) => g.key), current)
}
