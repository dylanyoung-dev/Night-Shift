// Types shared by the main process, preload and renderer.

// nightshift: Night Shift creates the worktree at worktreePath before the steps run.
// agent: Night Shift creates nothing; the agent sets up its own worktree (or none).
export type WorktreeMode = 'nightshift' | 'agent'

export const DEFAULT_WORKTREE_PATH = '$REPO/.claude/worktrees/$ID'

// Headless `claude -p` can't show permission prompts, so anything not pre-allowed is refused.
// Auto mode approves safe actions without asking; the Linear connector is allowed outright.
export const CLAUDE_RUN_FLAGS = '--permission-mode auto --allowedTools mcp__claude_ai_Linear'
export const DEFAULT_CLAUDE_COMMAND = `claude -p "/build $TICKET" ${CLAUDE_RUN_FLAGS}`

export interface WorktreeConfig {
  mode?: WorktreeMode
  path?: string // template, e.g. "D:/worktrees/$ID"; relative paths are inside the repo
}

// A Night Shift project: a named slice of the team's tickets, linked to Linear projects.
export interface NightShiftProject {
  id: string
  name: string
  linearProjectIds: string[] // tickets in any of these Linear projects are shown
}

export interface Settings {
  linearTeamKey: string // e.g. "IGN"
  repoPath: string // local checkout of the repo agents work in
  baseBranch: string // branch new worktrees start from, e.g. "releases/nov-2026"
  worktreeMode: WorktreeMode
  worktreePath: string // template; $REPO $ID $TICKET $BRANCH are filled in
  pollSeconds: number // how often to check Linear
  maxConcurrent: number // local runs at once, across all states
  hiddenStateTypes: string[] // Linear state types left off the board
  projects: NightShiftProject[]
  activeProjectId: string | null // null = every ticket in the team
  hasLinearKey: boolean // the key itself never leaves the main process
}

export interface SettingsUpdate extends Partial<Omit<Settings, 'hasLinearKey'>> {
  linearApiKey?: string
}

export interface LinearState {
  id: string
  name: string
  type: string // backlog | unstarted | started | completed | canceled | triage
  position: number
  color: string
}

export interface LinearIssue {
  id: string
  identifier: string // IGN-644
  title: string
  url: string
  branchName: string
  stateId: string
  stateName: string
  labels: LinearLabel[]
  priority: number // 0 none, 1 urgent, 2 high, 3 medium, 4 low
  estimate: number | null
  createdAt: string
  sortOrder: number // manual order on the Linear board
  assignee: LinearPerson | null
  parent: { identifier: string; title: string } | null
  projectId: string | null // Linear project, if any
  blocked: boolean // another issue blocks this one
  subIssues: { done: number; total: number } | null
  pullRequests: LinearPullRequest[]
  previewUrl: string | null // deploy preview link attached to the issue
}

export interface LinearLabel {
  id: string
  name: string
  color: string
}

export interface LinearPerson {
  id: string
  name: string
  avatarUrl: string | null
}

// What the card menus can offer, loaded with the board.
export interface TeamMeta {
  id: string
  estimates: { value: number; label: string }[] // empty when the team doesn't use estimates
  members: LinearPerson[]
  labels: LinearLabel[]
  projects: LinearProject[] // the team's Linear projects, for linking Night Shift projects
}

export interface LinearProject {
  id: string
  name: string
  color: string
  state: string // planned | started | paused | completed | canceled | backlog
}

// Fields the board can change. Sent to Linear as-is; null clears a field.
export interface IssueUpdate {
  stateId?: string
  priority?: number
  assigneeId?: string | null
  labelIds?: string[]
  estimate?: number | null
}

export interface LinearPullRequest {
  number: string
  url: string
  status: 'open' | 'draft' | 'merged' | 'closed' | 'unknown'
}

export type StepType = 'script' | 'claude' | 'linear'
export type OnFail = 'stop' | 'continue'

export interface StepDef {
  name: string
  type: StepType
  run?: string // shell command (script, claude)
  moveTo?: string // Linear state name (linear)
  cwd?: 'repo' | 'worktree' // default: worktree once it exists, else repo
  onFail?: OnFail
  only?: WorktreeMode // run this step only in that worktree mode
}

// One set of steps, used by every Linear state listed in `states`.
// A state belongs to at most one set.
export interface StepSet {
  name: string
  states: string[] // Linear state names
  trigger: 'manual' | 'auto'
  worktree?: WorktreeConfig // overrides the Settings for runs of this set
  steps: StepDef[]
}

export interface StepsFile {
  path: string | null // where it was loaded from, null = built-in defaults
  sets: StepSet[]
  error?: string // the file couldn't be read; built-in defaults are in use
  problems?: string[] // the file loaded but has mistakes, e.g. a state in two sets
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped'

export interface RunStep {
  name: string
  type: StepType
  status: StepStatus
  startedAt?: number
  endedAt?: number
  command?: string
}

export interface Run {
  id: string
  issueId: string
  identifier: string
  title: string
  stepsName: string
  runner: 'local'
  status: RunStatus
  branch: string
  worktreeMode?: WorktreeMode // missing on runs from before this setting existed
  worktree: string // empty when the agent sets up the worktree
  steps: RunStep[]
  currentStep: number
  createdAt: number
  startedAt?: number
  endedAt?: number
  logFile: string
  logTail: string // last part of the output, for the UI
}

export interface RepoBranches {
  isRepo: boolean
  root?: string // top of the checkout, when the picked folder is inside one
  current?: string // branch checked out there
  branches: { name: string; remote: boolean }[] // remote = exists on origin
  error?: string
}

export interface BoardData {
  states: LinearState[]
  issues: LinearIssue[]
  allStates?: LinearState[] // every team state, for the status menu; states holds the visible columns
  team?: TeamMeta | null
  project?: NightShiftProject | null // the active project the issues were filtered by
  fetchedAt: number | null
  error?: string
}

export interface NightShiftApi {
  getSettings(): Promise<Settings>
  saveSettings(update: SettingsUpdate): Promise<Settings>
  exportSettings(): Promise<{ path: string } | { error: string } | null> // null = cancelled
  importSettings(): Promise<{ settings: Settings; notes: string[] } | { error: string } | null>
  getBoard(): Promise<BoardData>
  refreshBoard(): Promise<BoardData>
  getSteps(): Promise<StepsFile>
  saveSteps(sets: StepSet[]): Promise<StepsFile | { error: string }>
  openStepsFile(): Promise<void>
  getRuns(): Promise<Run[]>
  startRun(issueId: string): Promise<Run | { error: string }>
  stopRun(runId: string): Promise<void>
  openLog(runId: string): Promise<void>
  updateIssue(issueId: string, update: IssueUpdate): Promise<{ ok: true } | { error: string }>
  readLog(runId: string): Promise<string> // whole log file (last 4 MB if bigger)
  openInBrowser(url: string): Promise<void>
  pickFolder(startAt?: string): Promise<string | null>
  listBranches(repoPath: string, fetch?: boolean): Promise<RepoBranches>
  onBoard(cb: (board: BoardData) => void): () => void
  onRuns(cb: (runs: Run[]) => void): () => void
  onRunOutput(cb: (runId: string, chunk: string) => void): () => void
}
