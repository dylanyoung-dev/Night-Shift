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
  kind?: 'tickets' | 'global' // global: runs a global action (no tickets) on a schedule; missing = tickets
  globalAction?: string | null // kind global: the global action's name
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

// Board columns in the saved order. States not in the order (new in Linear, or never moved) keep
// their place next to the state that comes before them in Linear.
export function orderStates<T extends { name: string }>(states: T[], order: string[]): T[] {
  if (!order.length) return states
  const key = (n: string): string => n.toLowerCase()
  const byName = new Map(states.map((s) => [key(s.name), s]))
  const out: T[] = []
  for (const n of order) {
    const s = byName.get(key(n))
    if (s && !out.includes(s)) out.push(s)
  }
  states.forEach((s, i) => {
    if (out.includes(s)) return
    const before = states.slice(0, i).reverse().find((p) => out.includes(p))
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, s)
  })
  return out
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
  columnOrder: string[] // board columns by state name, as arranged by dragging; empty = Linear's order
  projects: NightShiftProject[]
  activeProjectId: string | null // null = every ticket in the team
  automations: Automation[]
  theme: 'system' | 'dark' | 'light' // this machine only; not in the exported file
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
  milestone: { id: string; name: string } | null // the project milestone it belongs to
  blocked: boolean // another issue blocks this one
  subIssues: { done: number; total: number } | null
  pullRequests: LinearPullRequest[]
  previewUrl: string | null // deploy preview link attached to the issue
}

export interface LinearLabel {
  id: string
  name: string
  color: string
  groupId?: string | null // the label group it belongs to (e.g. Initiative, Area), if any
}

// A Linear label group, such as Initiative or Area. The board filters and groups by these.
export interface LabelGroup {
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
  labelGroups?: LabelGroup[] // groups that have labels, sorted by name
  projects: LinearProject[] // the team's Linear projects, for linking Night Shift projects
}

export interface LinearProject {
  id: string
  name: string
  color: string
  state: string // planned | started | paused | completed | canceled | backlog
  milestones: LinearMilestone[]
}

export interface LinearMilestone {
  id: string
  name: string
  targetDate: string | null
  sortOrder: number
}

// Fields the board can change. Sent to Linear as-is; null clears a field.
export interface IssueUpdate {
  stateId?: string
  priority?: number
  assigneeId?: string | null
  labelIds?: string[]
  estimate?: number | null
  projectMilestoneId?: string | null
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
  global?: boolean // not tied to a ticket: runs from the base branch, from the Run menu or an automation
  states: string[] // Linear state names (empty for a global action)
  worktree?: WorktreeConfig // overrides the Settings for runs of this set
  steps: StepDef[]
  onFailure?: OnFailure // what happens to the ticket in Linear when a run of this set fails
}

// When a run fails (not when you stop it): mark the ticket and send it back so it gets another run.
export interface OnFailure {
  moveTo?: string // Linear state to send the ticket back to, e.g. "Ready to Build"
  label?: string // label added while it's failing; removed when a run of this set succeeds
  comment?: boolean // post a comment with the failed step and the end of the log (default true)
  retries?: number // send it back at most this many times in a row; then leave it where it is (default 2)
}

export const DEFAULT_FAILURE_LABEL = 'Agent failed'
export const DEFAULT_FAILURE_RETRIES = 2

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

// What a global action's runs use in place of a ticket id, so one runs at a time per action.
export function globalRunKey(actionName: string): string {
  return `global:${actionName.trim().toLowerCase()}`
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
  sessionId?: string // Claude steps: the Claude Code session, so a finished run can be continued
  cwd?: string // where the step ran; a session can only be resumed from the same folder
}

// A finished run can be picked up again if one of its Claude steps has a session to resume.
export function resumableStep(run: Run): number {
  for (let i = run.steps.length - 1; i >= 0; i--) if (run.steps[i].sessionId && run.steps[i].cwd) return i
  return -1
}

export interface Run {
  id: string
  issueId: string // a global action's runs use globalRunKey(name) instead of a ticket id
  global?: boolean // a global action: no ticket, runs from the base branch
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

// Claude Code token usage, read from the transcripts on this machine.
export interface TokenCounts {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  messages: number
}
export interface UsageDay extends TokenCounts {
  date: string // YYYY-MM-DD, local time
  nightShift: number // tokens from sessions Night Shift started
}
export interface UsageSlice extends TokenCounts {
  name: string
}
export interface UsageReport {
  generatedAt: number
  days: number
  files: number
  sources: string[]
  today: TokenCounts
  week: TokenCounts // last 7 days including today
  period: TokenCounts // the chosen range
  nightShift: TokenCounts // the part of the range from Night Shift runs
  window: (TokenCounts & { start: number; end: number; perMinute: number }) | null // current 5-hour window
  daily: UsageDay[]
  byModel: UsageSlice[]
  byProject: UsageSlice[]
}

// Plan limits as /usage shows them, taken from Claude's own rate-limit reports.
export interface PlanWindow {
  utilization: number // 0..1
  resetsAt?: number // ms
  status?: string
}
export interface PlanLimits {
  seenAt: number // when Claude reported these
  source: 'run' | 'check'
  windows: Record<string, PlanWindow> // five_hour, seven_day, seven_day_opus, …
}

// Everything the Linear detail panel shows for one ticket.
export interface IssueDetail {
  id: string
  identifier: string
  title: string
  url: string
  description: string // markdown
  state: { name: string; type: string; color: string }
  priority: number
  estimate: number | null
  dueDate: string | null
  createdAt: string
  updatedAt: string
  assignee: LinearPerson | null
  creator: LinearPerson | null
  labels: LinearLabel[]
  project: { name: string; color: string } | null
  milestone: { name: string } | null
  cycle: { number: number; name: string | null } | null
  parent: { identifier: string; title: string; url: string } | null
  children: { identifier: string; title: string; url: string; state: { name: string; type: string; color: string } }[]
  attachments: { title: string; subtitle: string | null; url: string }[]
  comments: IssueComment[]
  documents: IssueDocument[] // Linear documents attached to the ticket, such as the Spec
  documentsError?: string // why documents couldn't be read
}
export interface IssueDocument {
  id: string
  title: string
  url: string
  content: string // markdown
  updatedAt: string
  updatedBy: string | null
}
export interface IssueComment {
  id: string
  body: string
  createdAt: string
  author: string
  avatarUrl: string | null
  parentId: string | null
}

// Auto-update progress, from the main process.
export interface UpdateState {
  status: 'dev' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  version: string // the version running now
  available?: string // the version being downloaded or ready to install
  percent?: number
  checkedAt?: number
  error?: string
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
  startGlobalRun?(name: string): Promise<Run | { error: string }> // a global action, from the base branch
  stopRun(runId: string): Promise<void>
  openLog(runId: string): Promise<void>
  updateIssue(issueId: string, update: IssueUpdate): Promise<{ ok: true } | { error: string }>
  readLog(runId: string): Promise<string>
  replyToRun(runId: string, text: string): Promise<{ ok: true } | { error: string }>
  finishRunStep(runId: string): Promise<{ ok: true } | { error: string }> // end the Claude session, carry on
  getUpdateState?(): Promise<UpdateState>
  onUpdateState?(cb: (s: UpdateState) => void): () => void
  installUpdate?(): Promise<void> // restart now and install the downloaded update
  getIssueDetail?(issueId: string): Promise<IssueDetail | { error: string }>
  linearImage?(url: string): Promise<string | null> // data: URL for an image uploaded to Linear
  getUsage?(days: number, refresh?: boolean): Promise<UsageReport>
  getLimits?(): Promise<PlanLimits | null>
  checkLimits?(): Promise<PlanLimits | { error: string }>
  onLimits?(cb: (l: PlanLimits) => void): () => void
  usageProgress?(): Promise<{ done: number; total: number; scanning: boolean }>
  continueRun?(runId: string, text: string): Promise<{ ok: true } | { error: string }> // reply to a finished run: resume its Claude session (optional: older preloads lack it)
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
