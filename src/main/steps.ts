import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import YAML from 'yaml'
import { DEFAULT_CLAUDE_COMMAND, setLabel, type OnFailure, type StepDef, type StepSet, type StepsFile, type WorktreeConfig } from '../shared/types'

// Steps live in the repo the agents work in, so cloud runs and changes via PR use the same file.
export const STEPS_RELATIVE_PATH = join('.nightshift', 'steps.yml')

export const DEFAULT_SETS: StepSet[] = [
  {
    name: 'Build steps',
    states: ['Ready to Build'],
    steps: [
      { name: 'Create worktree', type: 'script', cwd: 'repo', run: 'git fetch origin $BASE && git worktree add $WORKTREE -b $BRANCH origin/$BASE', onFail: 'stop' },
      { name: 'Install packages', type: 'script', run: 'npm ci', onFail: 'stop', only: 'nightshift' },
      { name: 'Move to Building', type: 'linear', moveTo: 'Building', onFail: 'continue' },
      { name: 'Build', type: 'claude', run: DEFAULT_CLAUDE_COMMAND, onFail: 'stop' }
    ],
    onFailure: { moveTo: 'Ready to Build' }
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

function normalizeOnFailure(raw: unknown): OnFailure | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Raw
  const out: OnFailure = {}
  if (typeof r.moveTo === 'string' && r.moveTo.trim()) out.moveTo = r.moveTo.trim()
  if (typeof r.label === 'string' && r.label.trim()) out.label = r.label.trim()
  if (r.comment === false) out.comment = false
  const retries = Number(r.retries)
  if (r.retries !== undefined && r.retries !== null && Number.isFinite(retries) && retries >= 0) out.retries = Math.floor(retries)
  return out.moveTo || out.label || out.comment === false || out.retries !== undefined ? out : undefined
}

function normalizeSet(raw: Raw, fallbackName: string, states: string[]): StepSet {
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined
  const onFailure = normalizeOnFailure(raw.onFailure)
  return {
    name: String(raw.name ?? fallbackName).trim() || fallbackName,
    ...(label ? { label } : {}),
    states,
    worktree: normalizeWorktree(raw.worktree),
    steps: (Array.isArray(raw.steps) ? (raw.steps as Raw[]) : []).map(normalizeStep),
    ...(onFailure ? { onFailure } : {})
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
    if (!set.name.trim()) problems.push('Every action needs a name.')
    else if (names.has(set.name.trim().toLowerCase())) problems.push(`Two actions are named "${set.name}".`)
    names.add(set.name.trim().toLowerCase())
    // A state can have several sets, but their buttons must read differently.
    for (const state of set.states) {
      const key = `${state.toLowerCase()}|${setLabel(set).toLowerCase()}`
      const other = owner.get(key)
      if (other) problems.push(`"${other}" and "${set.name}" both show a "${setLabel(set)}" button on ${state}. Give one a different button label.`)
      else owner.set(key, set.name)
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
    const text = readFileSync(path, 'utf8')
    const sets = parseSteps(text)
    const problems = checkSets(sets)
    // Older files could start runs on their own; that moved to Automations and is ignored now.
    if (/^\s*trigger:\s*auto\b/m.test(text)) {
      problems.push('An action is marked "trigger: auto". Actions no longer start runs on their own; set that up on the Automations page. Saving here removes it.')
    }
    return { path, sets, ...(problems.length ? { problems } : {}) }
  } catch (err) {
    return { path, sets: DEFAULT_SETS, error: `Could not read ${path}: ${(err as Error).message}` }
  }
}

// Every set of steps for a ticket in this state, in file order (one button each).
export function setsForState(file: StepsFile, stateName: string): StepSet[] {
  const s = stateName.toLowerCase()
  return file.sets.filter((set) => set.states.some((st) => st.toLowerCase() === s))
}

// One set for a state: the named one if given (and it covers the state), else the first.
export function setForState(file: StepsFile, stateName: string, setName?: string | null): StepSet | undefined {
  const sets = setsForState(file, stateName)
  if (setName) return sets.find((x) => x.name.toLowerCase() === setName.toLowerCase())
  return sets[0]
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

const HEADER = `# Night Shift actions. Edited from the Actions page or by hand; either way it changes through PRs.
# Each entry under "sets:" is an action: a named list of steps for tickets in any of its states,
# shown in their cards' Actions menu (label). A state can have several actions, each with its own label.
#
# Variables: $TICKET (IGN-644) $ID (ign-644) $BRANCH $BASE $WORKTREE $REPO $WORKTREE_MODE
#   (also set as environment variables NS_TICKET, NS_ID, ...)
# Actions only say what runs. To start runs on their own, use the Automations page.
# worktree (optional, per action): mode: nightshift | agent, path: "D:/worktrees/$ID"  (overrides Settings)
# step type: script | claude | linear     onFail: stop | continue
# cwd: repo | worktree     only: nightshift | agent  (run the step only in that worktree mode)
# In agent mode, steps that use $WORKTREE or cwd: worktree are skipped.
# onFailure (optional, per action): when a run fails, label the ticket, comment, and send it back.
#   moveTo: "Ready to Build"  label: "Agent failed"  comment: true|false  retries: 2
#   After \`retries\` failures in a row the ticket is left where it is, still labelled.
`

export function stringifySteps(sets: StepSet[]): string {
  const doc = {
    sets: sets.map((set) => {
      const out: Raw = { name: set.name.trim() }
      if (set.label?.trim() && set.label.trim() !== set.name.trim()) out.label = set.label.trim()
      out.states = set.states
      if (set.worktree?.mode || set.worktree?.path) {
        const wt: Raw = {}
        if (set.worktree.mode) wt.mode = set.worktree.mode
        if (set.worktree.path) wt.path = set.worktree.path
        out.worktree = wt
      }
      out.steps = set.steps.map(stepToYaml)
      const f = set.onFailure
      if (f && (f.moveTo || f.label || f.comment === false || f.retries !== undefined)) {
        const of: Raw = {}
        if (f.moveTo) of.moveTo = f.moveTo
        if (f.label) of.label = f.label
        if (f.comment === false) of.comment = false
        if (f.retries !== undefined) of.retries = f.retries
        out.onFailure = of
      }
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
