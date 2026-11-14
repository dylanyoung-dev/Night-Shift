// Types shared by the main process, preload and renderer.

// nightshift: Night Shift creates the worktree at worktreePath before the steps run.
// agent: Night Shift creates nothing; the agent sets up its own worktree (or none).
export type WorktreeMode = 'nightshift' | 'agent'

export const DEFAULT_WORKTREE_PATH = '$REPO/.claude/worktrees/$ID'

// Headless `claude -p` can't show permission prompts, so anything not pre-allowed is refused.
// Auto mode approves safe actions without asking; the Linear connector is allowed outright.
// stream-json + verbose make Claude report each step as it happens, so the live log shows its work.
export const CLAUDE_RUN_FLAGS = '--permission-mode auto --allowedTools mcp__claude_ai_Linear --output-format stream-json --verbose'
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

// An automation starts runs for tickets in its states, using each state's set of steps.
//   schedule: fires every N minutes (optionally on set days / hours), up to N tickets each time,
//             optionally stopping after a set number of runs.
//   watch:    checks on every Linear sync and picks tickets up as they arrive, at any time or
//             within set hours; once per arrival, or any number of times with a cooldown.
export type AutomationMode = 'schedule' | 'watch'

export interface Automation {
  id: string
  name: string
  enabled: boolean
  mode: AutomationMode
  projectId: string | null // Night Shift project to take tickets from; null = all of the team
  states: string[] // Linear state names
  stepSet: string | null // which set to run when a state has several; null = the state's first set
  runner: 'local' // 'cloud' later
  days: number[] // 0 = Sunday ... 6 = Saturday; empty = every day
  window: { start: string; end: string } | null // 'HH:MM' local time; start > end crosses midnight
  // schedule
  everyMinutes: number
  ticketsPerRun: number
  onlyIfTickets: boolean // an empty state doesn't use up the schedule; check again soon instead
  maxRuns: number | null // stop (switch off) after this many runs; null = no limit
  // watch
  perTicket: 'perArrival' | 'repeat' // once each time a ticket arrives, or any number of times
  cooldownHours: number // repeat: wait this long after a ticket's last run
  maxActive: number // watch: at most this many of its runs going at once
}

export interface AutomationStatus {
  lastRunAt?: number // schedule: last time it fired; watch: last time it picked a ticket up
  lastCheckedAt?: number
  nextRunAt?: number | null // schedule: null = as soon as it's allowed
  lastResult?: string
  runsDone?: number // schedule: times it has fired, for maxRuns
  seen?: Record<string, string> // watch: issue id -> state it was picked up in (cleared when it leaves)
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
  automations: Automation[]
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

// One set of steps, used by every Linear state listed in `states`. A state can have several
// sets; each shows as its own button (label) on the ticket's card.
export interface StepSet {
  name: string
  label?: string // button text; defaults to the name
  states: string[] // Linear state names
  worktree?: WorktreeConfig // overrides the Settings for runs of this set
  steps: StepDef[]
}

export interface StepsFile {
  path: string | null // where it was loaded from, null = built-in defaults
  sets: StepSet[]
  error?: string // the file couldn't be read; built-in defaults are in use
  problems?: string[] // the file loaded but has mistakes, e.g. a state in two sets
}

export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped'
// waiting: a Claude step ended its turn needing you (a question, approval or a denied tool).
export type RunStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

// Still going: counts toward run limits and blocks another run of the same ticket.
// A set of steps as a button: its name (to start it) and the text shown.
export interface StepChoice {
  name: string
  label: string
}

// The text on a set's button.
export function setLabel(set: { name: string; label?: string }): string {
  return set.label?.trim() || set.name
}

export function isActiveRun(status: RunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting'
}

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
  startedBy?: string // automation name, when one started it
  automationId?: string
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
  logTail: string
  interactive?: boolean // the current Claude step accepts messages
  waiting?: { reason: string; since: number } | null // last part of the output, for the UI
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

export type ImportGroupKey = 'linear' | 'repo' | 'worktrees' | 'runs' | 'projects' | 'automations'

export interface ImportPreview {
  fileName: string
  // empty: the file's list is empty, so importing it would clear this machine's list
  groups: { key: ImportGroupKey; label: string; summary: string; notes: string[]; empty: boolean }[]
}

export interface NightShiftApi {
  getSettings(): Promise<Settings>
  saveSettings(update: SettingsUpdate): Promise<Settings>
  exportSettings(): Promise<{ path: string } | { error: string } | null> // null = cancelled
  // Import in two steps: pick a file and see its parts, then apply the parts you keep.
  previewImport(): Promise<ImportPreview | { error: string } | null> // null = cancelled
  applyImport(keys: ImportGroupKey[]): Promise<{ settings: Settings; notes: string[] } | { error: string }>
  getBoard(): Promise<BoardData>
  refreshBoard(): Promise<BoardData>
  getSteps(): Promise<StepsFile>
  saveSteps(sets: StepSet[]): Promise<StepsFile | { error: string }>
  openStepsFile(): Promise<void>
  getRuns(): Promise<Run[]>
  startRun(issueId: string, setName?: string): Promise<Run | { error: string }> // setName picks one of the state's sets
  stopRun(runId: string): Promise<void>
  openLog(runId: string): Promise<void>
  updateIssue(issueId: string, update: IssueUpdate): Promise<{ ok: true } | { error: string }>
  readLog(runId: string): Promise<string>
  replyToRun(runId: string, text: string): Promise<{ ok: true } | { error: string }>
  finishRunStep(runId: string): Promise<{ ok: true } | { error: string }> // end the Claude session, carry on
  onOpenRun(cb: (runId: string) => void): () => void // a notification was clicked
  getAutomationStatus(): Promise<Record<string, AutomationStatus>>
  runAutomationNow(id: string): Promise<{ ok: true; message: string } | { error: string }>
  onAutomationStatus(cb: (status: Record<string, AutomationStatus>) => void): () => void
  onSettings(cb: (settings: Settings) => void): () => void // whole log file (last 4 MB if bigger)
  openInBrowser(url: string): Promise<void>
  pickFolder(startAt?: string): Promise<string | null>
  listBranches(repoPath: string, fetch?: boolean): Promise<RepoBranches>
  onBoard(cb: (board: BoardData) => void): () => void
  onRuns(cb: (runs: Run[]) => void): () => void
  onRunOutput(cb: (runId: string, chunk: string) => void): () => void
}
