import { app } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { isAbsolute, join, normalize } from 'path'
import { DEFAULT_WORKTREE_PATH } from '../shared/types'
import type { LinearIssue, Run, RunStep, StepDef, StepSet, WorktreeMode } from '../shared/types'

const TAIL_CHARS = 20000
const AUTO_RERUN_HOURS = 12

export interface RunnerDeps {
  getRepoPath(): string
  getBaseBranch(): string
  getWorktreeMode(): WorktreeMode
  getWorktreePath(): string
  getMaxConcurrent(): number
  moveIssue(issueId: string, stateName: string): Promise<void>
  onRuns(runs: Run[]): void
  onOutput(runId: string, chunk: string): void
}

interface Active {
  run: Run
  def: StepSet
  child?: ChildProcess
  stopRequested?: boolean
}

export class Runner {
  private runs: Run[] = []
  private active = new Map<string, Active>()
  private queue: Active[] = []
  private dir = join(app.getPath('userData'), 'runs')

  constructor(private deps: RunnerDeps) {
    mkdirSync(join(this.dir, 'logs'), { recursive: true })
    this.runs = this.loadHistory()
  }

  list(): Run[] {
    return this.runs
  }

  get(runId: string): Run | undefined {
    return this.runs.find((r) => r.id === runId)
  }

  isBusy(issueId: string): boolean {
    return this.runs.some((r) => r.issueId === issueId && (r.status === 'queued' || r.status === 'running'))
  }

  // True when auto steps already ran for this ticket recently, so polling doesn't loop on it.
  ranRecently(issueId: string, stepsName: string): boolean {
    const cutoff = Date.now() - AUTO_RERUN_HOURS * 3600_000
    return this.runs.some((r) => r.issueId === issueId && r.stepsName === stepsName && r.createdAt > cutoff)
  }

  start(issue: LinearIssue, def: StepSet): Run {
    const repo = this.deps.getRepoPath()
    const id = issue.identifier.toLowerCase()
    const runId = `${id}-${Date.now().toString(36)}`
    const branch = issue.branchName || `chore/${id}`
    const mode = def.worktree?.mode ?? this.deps.getWorktreeMode()
    const template = def.worktree?.path ?? this.deps.getWorktreePath()
    const run: Run = {
      id: runId,
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      stepsName: def.name,
      runner: 'local',
      status: 'queued',
      branch,
      worktreeMode: mode,
      worktree: mode === 'agent' ? '' : resolveWorktreePath(template, { repo, id, ticket: issue.identifier, branch }),
      steps: def.steps.map((s) => ({ name: s.name, type: s.type, status: 'pending' as const })),
      currentStep: -1,
      createdAt: Date.now(),
      logFile: join(this.dir, 'logs', `${runId}.log`),
      logTail: ''
    }
    this.runs.unshift(run)
    this.queue.push({ run, def })
    this.changed()
    this.pump()
    return run
  }

  stop(runId: string): void {
    const queued = this.queue.findIndex((a) => a.run.id === runId)
    if (queued >= 0) {
      const [a] = this.queue.splice(queued, 1)
      a.run.status = 'stopped'
      a.run.endedAt = Date.now()
      this.changed()
      return
    }
    const a = this.active.get(runId)
    if (!a) return
    a.stopRequested = true
    if (a.child?.pid) killTree(a.child.pid)
  }

  private pump(): void {
    while (this.active.size < this.deps.getMaxConcurrent() && this.queue.length) {
      const a = this.queue.shift()!
      this.active.set(a.run.id, a)
      void this.execute(a).finally(() => {
        this.active.delete(a.run.id)
        this.changed()
        this.pump()
      })
    }
  }

  private async execute(a: Active): Promise<void> {
    const { run, def } = a
    run.status = 'running'
    run.startedAt = Date.now()
    this.log(run, `Night Shift: ${run.stepsName} for ${run.identifier} (${run.title})\n`)
    const agentWorktree = run.worktreeMode === 'agent'
    this.log(run, agentWorktree ? 'Worktree: the agent sets it up\n' : `Worktree: ${run.worktree}\n`)
    let worktreeReady = !agentWorktree && existsSync(run.worktree)

    for (let i = 0; i < def.steps.length; i++) {
      const step = def.steps[i]
      const rs = run.steps[i]
      run.currentStep = i

      const skip = this.skipReason(step, run)
      if (skip) {
        rs.status = 'skipped'
        this.log(run, `\n▸ ${step.name}: skipped (${skip})\n`)
        this.changed()
        continue
      }

      rs.status = 'running'
      rs.startedAt = Date.now()
      this.changed()

      let ok = false
      try {
        if (step.type === 'linear') {
          this.log(run, `\n▸ ${step.name}: move ${run.identifier} to "${step.moveTo}"\n`)
          await this.deps.moveIssue(run.issueId, step.moveTo ?? '')
          ok = true
        } else {
          const cmd = this.expand(step.run ?? '', run)
          rs.command = cmd
          const cwd = this.cwdFor(step, run, worktreeReady)
          this.log(run, `\n▸ ${step.name}\n$ ${cmd}\n  (in ${cwd})\n`)
          ok = (await this.shell(a, cmd, cwd)) === 0
        }
      } catch (err) {
        this.log(run, `Error: ${(err as Error).message}\n`)
      }

      if (!worktreeReady && !agentWorktree && existsSync(run.worktree)) worktreeReady = true
      rs.endedAt = Date.now()

      if (a.stopRequested) {
        rs.status = 'failed'
        run.steps.slice(i + 1).forEach((s) => (s.status = 'skipped'))
        run.status = 'stopped'
        this.log(run, '\nStopped by you.\n')
        break
      }
      rs.status = ok ? 'done' : 'failed'
      if (!ok && step.onFail !== 'continue') {
        run.steps.slice(i + 1).forEach((s) => (s.status = 'skipped'))
        run.status = 'failed'
        this.log(run, `\nStep failed: ${step.name}. Run stopped.\n`)
        break
      }
      this.changed()
    }

    if (run.status === 'running') run.status = 'done'
    run.endedAt = Date.now()
    this.log(run, `\nRun ${run.status}.\n`)
  }

  // In agent mode Night Shift has no worktree, so steps that need one are left out.
  private skipReason(step: StepDef, run: Run): string | null {
    const mode = run.worktreeMode ?? 'nightshift'
    if (step.only && step.only !== mode) {
      return step.only === 'agent' ? 'only when the agent sets up the worktree' : 'only when Night Shift creates the worktree'
    }
    if (mode === 'agent' && (step.cwd === 'worktree' || /\$WORKTREE\b/.test(step.run ?? ''))) {
      return 'the agent sets up the worktree'
    }
    return null
  }

  private cwdFor(step: StepDef, run: Run, worktreeReady: boolean): string {
    if (step.cwd === 'repo' || run.worktreeMode === 'agent') return this.deps.getRepoPath()
    if (step.cwd === 'worktree') return run.worktree
    return worktreeReady ? run.worktree : this.deps.getRepoPath()
  }

  private vars(run: Run): Record<string, string> {
    return {
      TICKET: run.identifier,
      ID: run.identifier.toLowerCase(),
      BRANCH: run.branch,
      BASE: this.deps.getBaseBranch(),
      WORKTREE: run.worktree,
      WORKTREE_MODE: run.worktreeMode ?? 'nightshift',
      REPO: this.deps.getRepoPath()
    }
  }

  // $VARS are filled in here (not by the shell) so the same steps work in cmd, PowerShell and bash.
  private expand(cmd: string, run: Run): string {
    const v = this.vars(run)
    return cmd.replace(/\$(TICKET|ID|BRANCH|BASE|WORKTREE_MODE|WORKTREE|REPO)\b/g, (_, k: string) => v[k])
  }

  private shell(a: Active, cmd: string, cwd: string): Promise<number> {
    return new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env }
      for (const [k, val] of Object.entries(this.vars(a.run))) env[`NS_${k}`] = val
      // No stdin: steps run unattended, and tools like claude -p otherwise wait for input.
      const child = spawn(cmd, { cwd, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      a.child = child
      child.stdout?.on('data', (d: Buffer) => this.log(a.run, d.toString()))
      child.stderr?.on('data', (d: Buffer) => this.log(a.run, d.toString()))
      child.on('error', (err) => {
        this.log(a.run, `Could not start: ${err.message}\n`)
        resolve(1)
      })
      child.on('close', (code) => {
        a.child = undefined
        resolve(code ?? 1)
      })
    })
  }

  private log(run: Run, chunk: string): void {
    try {
      appendFileSync(run.logFile, chunk)
    } catch {
      /* log file is best effort */
    }
    run.logTail = (run.logTail + chunk).slice(-TAIL_CHARS)
    this.deps.onOutput(run.id, chunk)
  }

  private changed(): void {
    this.saveHistory()
    this.deps.onRuns(this.runs)
  }

  private loadHistory(): Run[] {
    try {
      const runs = JSON.parse(readFileSync(join(this.dir, 'runs.json'), 'utf8')) as Run[]
      // Anything still marked active belonged to a previous session of the app.
      for (const r of runs) {
        if (r.status === 'queued' || r.status === 'running') {
          r.status = 'stopped'
          r.steps.forEach((s) => s.status === 'running' && (s.status = 'failed'))
        }
      }
      return runs
    } catch {
      return []
    }
  }

  private saveHistory(): void {
    const keep = this.runs.slice(0, 200).map((r) => ({ ...r, logTail: r.logTail.slice(-4000) }))
    try {
      writeFileSync(join(this.dir, 'runs.json'), JSON.stringify(keep))
    } catch {
      /* best effort */
    }
  }
}

// Fills in $REPO $ID $TICKET $BRANCH; a relative result is placed inside the repo.
export function resolveWorktreePath(
  template: string,
  v: { repo: string; id: string; ticket: string; branch: string }
): string {
  const vars: Record<string, string> = {
    REPO: v.repo,
    ID: v.id,
    TICKET: v.ticket,
    BRANCH: v.branch.replace(/[\\/:*?"<>|]+/g, '-') // one folder, not nested ones
  }
  const filled = (template.trim() || DEFAULT_WORKTREE_PATH).replace(/\$(REPO|ID|TICKET|BRANCH)\b/g, (_, k: string) => vars[k])
  return normalize(isAbsolute(filled) ? filled : join(v.repo, filled))
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
}

export type { RunStep }
