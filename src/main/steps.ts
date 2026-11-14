import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import YAML from 'yaml'
import { DEFAULT_CLAUDE_COMMAND, type StepDef, type StepSet, type StepsFile, type WorktreeConfig } from '../shared/types'

// Steps live in the repo the agents work in, so cloud runs and changes via PR use the same file.
export const STEPS_RELATIVE_PATH = join('.nightshift', 'steps.yml')

export const DEFAULT_SETS: StepSet[] = [
  {
    name: 'Build steps',
    states: ['Ready to Build'],
    trigger: 'manual',
    steps: [
      { name: 'Create worktree', type: 'script', cwd: 'repo', run: 'git fetch origin $BASE && git worktree add $WORKTREE -b $BRANCH origin/$BASE', onFail: 'stop' },
      { name: 'Install packages', type: 'script', run: 'npm ci', onFail: 'stop', only: 'nightshift' },
      { name: 'Move to Building', type: 'linear', moveTo: 'Building', onFail: 'continue' },
      { name: 'Build', type: 'claude', run: DEFAULT_CLAUDE_COMMAND, onFail: 'stop' }
    ]
  }
]

type Raw = Record<string, unknown>

function normalizeStep(raw: Raw, i: number): StepDef {
  const type: StepDef['type'] =
    raw.type === 'claude' || raw.type === 'linear' || raw.type === 'script' ? raw.type : raw.moveTo ? 'linear' : 'script'
  return {
    name: String(raw.name ?? `Step ${i + 1}`),
    type,
    run: raw.run !== undefined && raw.run !== null ? String(raw.run) : undefined,
    moveTo: raw.moveTo !== undefined && raw.moveTo !== null ? String(raw.moveTo) : undefined,
    cwd: raw.cwd === 'repo' || raw.cwd === 'worktree' ? raw.cwd : undefined,
    onFail: raw.onFail === 'continue' ? 'continue' : 'stop',
    only: raw.only === 'nightshift' || raw.only === 'agent' ? raw.only : undefined
  }
}

function normalizeWorktree(raw: unknown): WorktreeConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Raw
  const out: WorktreeConfig = {}
  if (r.mode === 'nightshift' || r.mode === 'agent') out.mode = r.mode
  if (typeof r.path === 'string' && r.path.trim()) out.path = r.path.trim()
  return out.mode || out.path ? out : undefined
}

function normalizeSet(raw: Raw, fallbackName: string, states: string[]): StepSet {
  return {
    name: String(raw.name ?? fallbackName).trim() || fallbackName,
    states,
    trigger: raw.trigger === 'auto' ? 'auto' : 'manual',
    worktree: normalizeWorktree(raw.worktree),
    steps: (Array.isArray(raw.steps) ? (raw.steps as Raw[]) : []).map(normalizeStep)
  }
}

// Reads both layouts: `sets:` (a list, each with `states:`) and the older `states:` map
// with one block per state.
export function parseSteps(text: string): StepSet[] {
  const doc = (YAML.parse(text) ?? {}) as Raw
  if (Array.isArray(doc.sets)) {
    return (doc.sets as Raw[]).map((raw, i) => {
      const states = Array.isArray(raw.states) ? (raw.states as unknown[]).map(String) : raw.state ? [String(raw.state)] : []
      return normalizeSet(raw, `Steps ${i + 1}`, states)
    })
  }
  if (doc.states && typeof doc.states === 'object') {
    return Object.entries(doc.states as Record<string, Raw>).map(([state, raw]) => normalizeSet(raw ?? {}, `${state} steps`, [state]))
  }
  return []
}

// Mistakes that would make runs ambiguous or fail outright.
export function checkSets(sets: StepSet[]): string[] {
  const problems: string[] = []
  const owner = new Map<string, string>()
  const names = new Set<string>()
  for (const set of sets) {
    if (!set.name.trim()) problems.push('Every set of steps needs a name.')
    else if (names.has(set.name.trim().toLowerCase())) problems.push(`Two sets are named "${set.name}".`)
    names.add(set.name.trim().toLowerCase())
    for (const state of set.states) {
      const other = owner.get(state.toLowerCase())
      if (other) problems.push(`"${state}" is in both "${other}" and "${set.name}". A state can only have one set of steps.`)
      else owner.set(state.toLowerCase(), set.name)
    }
    set.steps.forEach((st, i) => {
      const where = `"${set.name}" step ${i + 1}`
      if (!st.name.trim()) problems.push(`${where} needs a name.`)
      if (st.type === 'linear' && !st.moveTo?.trim()) problems.push(`${where} needs a Linear state to move to.`)
      if (st.type !== 'linear' && !st.run?.trim()) problems.push(`${where} needs a command.`)
    })
  }
  return problems
}

export function loadSteps(repoPath: string): StepsFile {
  if (!repoPath) return { path: null, sets: DEFAULT_SETS }
  const path = join(repoPath, STEPS_RELATIVE_PATH)
  if (!existsSync(path)) return { path: null, sets: DEFAULT_SETS }
  try {
    const sets = parseSteps(readFileSync(path, 'utf8'))
    const problems = checkSets(sets)
    return { path, sets, ...(problems.length ? { problems } : {}) }
  } catch (err) {
    return { path, sets: DEFAULT_SETS, error: `Could not read ${path}: ${(err as Error).message}` }
  }
}

// The set that runs for a ticket in this state. If a hand-edited file lists a state twice,
// the first set wins (and the Steps page shows the problem).
export function setForState(file: StepsFile, stateName: string): StepSet | undefined {
  const s = stateName.toLowerCase()
  return file.sets.find((set) => set.states.some((st) => st.toLowerCase() === s))
}

function stepToYaml(st: StepDef): Raw {
  const out: Raw = { name: st.name.trim(), type: st.type }
  if (st.type === 'linear') out.moveTo = st.moveTo?.trim()
  else out.run = st.run?.trim()
  if (st.cwd) out.cwd = st.cwd
  if (st.only) out.only = st.only
  if (st.onFail === 'continue') out.onFail = 'continue'
  return out
}

const HEADER = `# Night Shift steps. Edited from the Steps page or by hand; either way it changes through PRs.
# Each set runs for tickets in any of its states. A state can be in only one set.
#
# Variables: $TICKET (IGN-644) $ID (ign-644) $BRANCH $BASE $WORKTREE $REPO $WORKTREE_MODE
#   (also set as environment variables NS_TICKET, NS_ID, ...)
# trigger: manual (Run steps button) | auto (starts when a ticket is in one of the states)
# worktree (optional): mode: nightshift | agent, path: "D:/worktrees/$ID"  (overrides Settings)
# step type: script | claude | linear     onFail: stop | continue
# cwd: repo | worktree     only: nightshift | agent  (run the step only in that worktree mode)
# In agent mode, steps that use $WORKTREE or cwd: worktree are skipped.
`

export function stringifySteps(sets: StepSet[]): string {
  const doc = {
    sets: sets.map((set) => {
      const out: Raw = { name: set.name.trim(), states: set.states, trigger: set.trigger }
      if (set.worktree?.mode || set.worktree?.path) {
        const wt: Raw = {}
        if (set.worktree.mode) wt.mode = set.worktree.mode
        if (set.worktree.path) wt.path = set.worktree.path
        out.worktree = wt
      }
      out.steps = set.steps.map(stepToYaml)
      return out
    })
  }
  return `${HEADER}\n${YAML.stringify(doc, { lineWidth: 0 })}`
}

// Writes the file after checking it. Comments other than the header are not kept.
export function saveSteps(repoPath: string, sets: StepSet[]): StepsFile | { error: string } {
  if (!repoPath) return { error: 'Set the repo path in Settings first.' }
  if (!existsSync(repoPath)) return { error: "The repo path in Settings doesn't exist." }
  const clean = sets.map((set, i) => normalizeSet(set as unknown as Raw, `Steps ${i + 1}`, [...new Set(set.states.map((s) => s.trim()).filter(Boolean))]))
  const problems = checkSets(clean)
  if (problems.length) return { error: problems.join(' ') }
  const path = join(repoPath, STEPS_RELATIVE_PATH)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, stringifySteps(clean))
  } catch (err) {
    return { error: `Could not write ${path}: ${(err as Error).message}` }
  }
  return loadSteps(repoPath)
}

export function starterSteps(): string {
  return stringifySteps(DEFAULT_SETS)
}
