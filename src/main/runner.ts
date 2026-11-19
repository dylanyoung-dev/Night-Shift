import { app } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import type { Writable } from 'stream'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'fs'
import { isAbsolute, join, normalize } from 'path'
import { homedir, hostname } from 'os'
import { CLAUDE_RUN_FLAGS, DEFAULT_WORKTREE_PATH, globalRunKey, isActiveRun, resumableStep, setLabel } from '../shared/types'
import type { LinearIssue, Run, RunStep, StepDef, StepSet, WorktreeMode } from '../shared/types'
import { ClaudeStreamFormatter, needsYou, parseClaudeCommand } from './claudeStream'
import { planAfterRun, type FailurePlan } from './failure'
import { noteStreamOutput } from './limits'
import { prepareBaseCheckout } from './git'

const TAIL_CHARS = 20000
const AUTO_RERUN_HOURS = 12
const RECOVER_SESSIONS = 60 // recent runs checked on start for a Claude session to continue

export interface RunnerDeps {
  getRepoPath(): string
  getBaseBranch(): string
  getWorktreeMode(): WorktreeMode
  getWorktreePath(): string
  getMaxConcurrent(): number
  moveIssue(issueId: string, stateName: string): Promise<void>
  onRuns(runs: Run[]): void
  onOutput(runId: string, chunk: string): void
  onWaiting(run: Run): void // a Claude step needs the person
  applyFailurePlan(issueId: string, plan: FailurePlan): Promise<{ removedLabel: boolean }>
  // A run may have changed tickets in Linear: ticket names the one (id or identifier), null means reload
  // the whole board, undefined means the run's own ticket (or the whole board for a global run).
  onTicketsChanged?(run: Run, ticket?: string | null): void
  getSet(name: string): StepSet | undefined // the action a run came from, by name (for continuing a run)
}

interface Active {
  run: Run
  def: StepSet
  child?: ChildProcess
  stdin?: Writable // open while a Claude step runs as a session
  stopRequested?: boolean
}

// One message into a Claude session (stream-json input).
function userMessage(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
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
    return this.runs.some((r) => r.issueId === issueId && isActiveRun(r.status))
  }

  // Sends a message to the Claude step that's running. Claude reads it when its current turn ends.
  reply(runId: string, text: string): { ok: true } | { error: string } {
    const a = this.active.get(runId)
    const msg = text.trim()
    if (!msg) return { error: 'Type a message first.' }
    if (!a?.stdin || a.stdin.destroyed) return { error: "This step isn't taking messages. Only Claude steps can, while they run." }
    a.stdin.write(userMessage(msg))
    this.log(a.run, `\n▶ You: ${msg.split('\n').join('\n  ')}\n`)
    if (a.run.status === 'waiting') this.resume(a, 'Sent')
    return { ok: true }
  }

  // Ends the Claude session so the run moves on to its next step.
  finishStep(runId: string): { ok: true } | { error: string } {
    const a = this.active.get(runId)
    if (!a?.stdin || a.stdin.destroyed) return { error: "This step isn't a running Claude step." }
    this.log(a.run, '\nYou finished this step.\n')
    a.stdin.end()
    if (a.run.status === 'waiting') this.resume(a, 'Finished')
    return { ok: true }
  }

  // A reply to a run that has ended: resume its last Claude session with the message, as a new
  // "Reply" step on the same run, so the log and history carry on in one place.
  continueRun(runId: string, text: string): { ok: true } | { error: string } {
    const run = this.get(runId)
    const msg = text.trim()
    if (!run) return { error: 'That run is no longer in the history.' }
    if (!msg) return { error: 'Type a message first.' }
    if (this.active.has(runId)) return this.reply(runId, msg)
    if (isActiveRun(run.status)) return { error: 'This run is still queued.' }
    if (this.isBusy(run.issueId)) return { error: `${run.identifier} already has a run going. Reply once it ends.` }
    const from = resumableStep(run)
    if (from < 0) return { error: 'This run has no Claude session to pick up again.' }
    const src = run.steps[from]
    // No fallback: if the session or its folder is gone, say so plainly (here and on a remote).
    const gone = !src.sessionId || !claudeSessionExists(src.sessionId)
      ? "This run's Claude session no longer exists"
      : src.cwd && !existsSync(src.cwd)
        ? `This run's folder (${src.cwd}) no longer exists`
        : null
    if (gone) {
      const msg = `${gone} on ${hostname()}, so it can't be continued. Start the action again instead.`
      this.log(run, `
✗ Couldn't continue: ${msg}
`)
      return { error: msg }
    }
    const def = this.deps.getSet(run.stepsName) ?? { name: run.stepsName, states: [], steps: [] }
    const rs: RunStep = { name: 'Reply', type: 'claude', status: 'running', startedAt: Date.now(), sessionId: src.sessionId, cwd: src.cwd }
    run.steps.push(rs)
    run.currentStep = run.steps.length - 1
    run.status = 'running'
    run.endedAt = undefined
    run.waiting = null
    const a: Active = { run, def }
    this.active.set(run.id, a)
    this.changed()
    void this.continueSession(a, rs, src, msg).finally(() => {
      this.active.delete(run.id)
      this.changed()
      this.pump()
    })
    return { ok: true }
  }

  private async continueSession(a: Active, rs: RunStep, src: RunStep, msg: string): Promise<void> {
    const { run } = a
    rs.command = `claude -p --resume ${src.sessionId} (your reply)`
    this.log(run, `\n▸ Reply: picking up the Claude session from "${src.name}"\n▶ You: ${msg.split('\n').join('\n  ')}\n  (in ${src.cwd})\n`)
    let ok = false
    try {
      ok = (await this.shell(a, src.command ?? '', src.cwd!, true, { sessionId: src.sessionId!, prompt: msg })) === 0
    } catch (err) {
      this.log(run, `Error: ${(err as Error).message}\n`)
    }
    rs.endedAt = Date.now()
    if (a.stopRequested) {
      rs.status = 'failed'
      run.status = 'stopped'
      this.log(run, '\nStopped by you.\n')
    } else {
      rs.status = ok ? 'done' : 'failed'
      run.status = ok ? 'done' : 'failed'
    }
    run.endedAt = Date.now()
    this.log(run, `\nRun ${run.status}.\n`)
    await this.applyAfterRun(run, a.def)
  }

  private resume(a: Active, _why: string): void {
    a.run.status = 'running'
    a.run.waiting = null
    const rs = a.run.steps[a.run.currentStep]
    if (rs?.status === 'waiting') rs.status = 'running'
    this.changed()
  }

  // True when auto steps already ran for this ticket recently, so polling doesn't loop on it.
  ranRecently(issueId: string, stepsName: string): boolean {
    const cutoff = Date.now() - AUTO_RERUN_HOURS * 3600_000
    return this.runs.some((r) => r.issueId === issueId && r.stepsName === stepsName && r.createdAt > cutoff)
  }

  start(issue: LinearIssue, def: StepSet, by?: { id: string; name: string }): Run {
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
      ...(by ? { startedBy: by.name, automationId: by.id } : {}),
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

  // A global action: no ticket. Night Shift checks out the base branch in the action's own folder
  // (a fresh detached worktree each run), and every step runs there.
  startGlobal(def: StepSet, by?: { id: string; name: string }): Run {
    const repo = this.deps.getRepoPath()
    const base = this.deps.getBaseBranch()
    const slug = `global-${def.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'action'}`
    const runId = `${slug}-${Date.now().toString(36)}`
    const run: Run = {
      id: runId,
      issueId: globalRunKey(def.name),
      global: true,
      identifier: setLabel(def),
      title: `Global action, from ${base}`,
      stepsName: def.name,
      ...(by ? { startedBy: by.name, automationId: by.id } : {}),
      runner: 'local',
      status: 'queued',
      branch: base,
      worktreeMode: 'nightshift',
      worktree: resolveWorktreePath(this.deps.getWorktreePath(), { repo, id: slug, ticket: slug, branch: slug }),
      steps: [
        { name: `Check out ${base}`, type: 'script', status: 'pending' },
        ...def.steps.map((s) => ({ name: s.name, type: s.type, status: 'pending' as const }))
      ],
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
    a.stdin?.end()
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
    const agentWorktree = run.worktreeMode === 'agent'
    let worktreeReady = !agentWorktree && existsSync(run.worktree)
    // Global actions start with a fresh checkout of the base branch (run.steps[0]).
    const offset = run.global ? 1 : 0
    if (run.global) {
      this.log(run, `Night Shift: ${run.stepsName} (global action, from ${run.branch})\n`)
      const rs = run.steps[0]
      run.currentStep = 0
      rs.status = 'running'
      rs.startedAt = Date.now()
      rs.command = `git worktree add --detach ${run.worktree} origin/${run.branch}`
      this.changed()
      this.log(run, `\n▸ ${rs.name}\n`)
      try {
        this.log(run, (await prepareBaseCheckout(this.deps.getRepoPath(), run.branch, run.worktree)) + '\n')
        rs.status = 'done'
        worktreeReady = true
      } catch (err) {
        this.log(run, `Couldn't check out ${run.branch}: ${(err as Error).message}\n`)
        rs.status = 'failed'
        run.steps.slice(1).forEach((s) => (s.status = 'skipped'))
        run.status = a.stopRequested ? 'stopped' : 'failed'
      }
      rs.endedAt = Date.now()
      this.changed()
    } else {
      this.log(run, `Night Shift: ${run.stepsName} for ${run.identifier} (${run.title})\n`)
      this.log(run, agentWorktree ? 'Worktree: the agent sets it up\n' : `Worktree: ${run.worktree}\n`)
    }

    for (let i = 0; i < def.steps.length && run.status === 'running'; i++) {
      const step = def.steps[i]
      const rs = run.steps[i + offset]
      run.currentStep = i + offset

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
        if (step.type === 'linear' && run.global) {
          this.log(run, `\n▸ ${step.name}: a global action has no ticket to move\n`)
        } else if (step.type === 'linear') {
          this.log(run, `\n▸ ${step.name}: move ${run.identifier} to "${step.moveTo}"\n`)
          await this.deps.moveIssue(run.issueId, step.moveTo ?? '')
          ok = true
        } else {
          const cmd = this.expand(step.run ?? '', run)
          rs.command = cmd
          const cwd = this.cwdFor(step, run, worktreeReady)
          if (step.type === 'claude') rs.cwd = cwd
          this.log(run, `\n▸ ${step.name}\n$ ${cmd}\n  (in ${cwd})\n`)
          ok = (await this.shell(a, cmd, cwd, step.type === 'claude')) === 0
        }
      } catch (err) {
        this.log(run, `Error: ${(err as Error).message}\n`)
      }

      if (!worktreeReady && !agentWorktree && existsSync(run.worktree)) worktreeReady = true
      rs.endedAt = Date.now()

      if (a.stopRequested) {
        rs.status = 'failed'
        run.steps.slice(i + offset + 1).forEach((s) => (s.status = 'skipped'))
        run.status = 'stopped'
        this.log(run, '\nStopped by you.\n')
        break
      }
      rs.status = ok ? 'done' : 'failed'
      if (!ok && step.onFail !== 'continue') {
        run.steps.slice(i + offset + 1).forEach((s) => (s.status = 'skipped'))
        run.status = 'failed'
        this.log(run, `\nStep failed: ${step.name}. Run stopped.\n`)
        break
      }
      this.changed()
    }

    if (run.status === 'running') run.status = 'done'
    run.endedAt = Date.now()
    this.log(run, `\nRun ${run.status}.\n`)
    await this.applyAfterRun(run, def)
  }

  // Failed: label the ticket, comment and send it back, as the set's onFailure says. Done: clear the label.
  private async applyAfterRun(run: Run, def: StepSet): Promise<void> {
    if (run.global) return // no ticket to label or move
    const plan = planAfterRun(run, def, this.runs)
    if (!plan) return
    try {
      const done = await this.deps.applyFailurePlan(run.issueId, plan)
      if (plan.note) this.log(run, `${plan.note}\n`)
      else if (done.removedLabel) this.log(run, `Removed "${plan.removeLabel}" from ${run.identifier} in Linear.\n`)
    } catch (err) {
      this.log(run, `Could not update ${run.identifier} in Linear after the run: ${(err as Error).message}\n`)
    }
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
      TICKET: run.global ? '' : run.identifier,
      ID: run.global ? run.id.replace(/-[0-9a-z]+$/, '') : run.identifier.toLowerCase(),
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

  private shell(a: Active, cmd: string, cwd: string, claude = false, resume?: { sessionId: string; prompt: string }): Promise<number> {
    return new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env }
      for (const [k, val] of Object.entries(this.vars(a.run))) env[`NS_${k}`] = val
      // `claude -p` stops background agents 10 minutes after the main turn ends. A /build that hands
      // work to a background agent would be cut off mid-way, so wait for them (Stop still works).
      if (claude && env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS === undefined) env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0'
      let bgStopped = false
      const watchCutOff = (text: string): void => {
        if (claude && /Background tasks still running .* stopping them/.test(text)) bgStopped = true
      }
      // A `claude -p "<prompt>"` step runs as a session: the prompt goes in over stdin and stdin
      // stays open, so the person can reply. Everything else gets no stdin (it runs unattended).
      // A reply to a finished run resumes its session with the original step's flags.
      const session = resume
        ? { prompt: resume.prompt, flags: (parseClaudeCommand(cmd) ?? parseClaudeCommand(`claude -p "x" ${CLAUDE_RUN_FLAGS}`))!.flags }
        : claude
          ? parseClaudeCommand(cmd)
          : null
      const resumeFlag = resume ? ` --resume ${resume.sessionId}` : ''
      const command = session
        ? `claude -p${resumeFlag} --input-format stream-json --output-format stream-json --verbose ${session.flags}`.trim()
        : cmd
      const child = spawn(command, { cwd, env, shell: true, windowsHide: true, stdio: [session ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
      a.child = child
      if (session && child.stdin) {
        a.stdin = child.stdin
        child.stdin.on('error', () => {
          /* the process went away; close handles the rest */
        })
        child.stdin.write(userMessage(session.prompt))
        a.run.interactive = true
        this.changed()
      }
      // When Claude ends a turn: wait for the person if it needs them, otherwise end the session.
      const onResult = (ev: Record<string, any>): void => {
        if (!session || !a.stdin || a.stdin.destroyed || a.stopRequested) return
        const reason = needsYou(ev, fmt?.hookBlocked)
        if (!reason) {
          a.stdin.end()
          return
        }
        a.run.status = 'waiting'
        a.run.waiting = { reason, since: Date.now() }
        const rs = a.run.steps[a.run.currentStep]
        if (rs) rs.status = 'waiting'
        this.log(a.run, `\n⏸ Needs you: ${reason}\n  Reply below, or finish the step to carry on.\n`)
        this.changed()
        this.deps.onWaiting(a.run)
      }
      // Claude steps: turn stream-json events into readable lines, and keep the raw events too.
      const fmt = claude ? new ClaudeStreamFormatter(cwd, undefined, (t) => this.deps.onTicketsChanged?.(a.run, t)) : null
      const rawFile = a.run.logFile.replace(/\.log$/, '.events.jsonl')
      child.stdout?.on('data', (d: Buffer) => {
        const text = d.toString()
        watchCutOff(text)
        if (claude) noteStreamOutput(text) // plan limit percentages ride along in the stream
        // Keep the Claude session id so the run can be continued after it ends.
        const rs = a.run.steps[a.run.currentStep]
        if (claude && rs && !rs.sessionId) {
          const sid = /"session_id"\s*:\s*"([0-9a-f-]{36})"/.exec(text)?.[1]
          if (sid) rs.sessionId = sid
        }
        if (!fmt) return this.log(a.run, text)
        try {
          appendFileSync(rawFile, text)
        } catch {
          /* best effort */
        }
        const out = fmt.feed(text)
        if (out) this.log(a.run, out)
        // Act on turn ends only after their summary is in the log, so "Needs you" reads last.
        for (const ev of fmt.drainResults()) onResult(ev)
      })
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString()
        watchCutOff(text)
        this.log(a.run, text)
      })
      child.on('error', (err) => {
        this.log(a.run, `Could not start: ${err.message}\n`)
        resolve(1)
      })
      child.on('close', (code) => {
        const rest = fmt?.flush()
        if (rest) this.log(a.run, rest)
        // Whatever the step was, it may have moved the ticket (a script, or Linear calls not seen above).
        this.deps.onTicketsChanged?.(a.run)
        a.child = undefined
        a.stdin = undefined
        if (a.run.interactive || a.run.status === 'waiting') {
          a.run.interactive = false
          if (a.run.status === 'waiting') {
            a.run.status = 'running'
            a.run.waiting = null
          }
          this.changed()
        }
        if (bgStopped && !a.stopRequested) {
          // Claude exits 0 here, but its background agents were killed mid-task: don't call it done.
          this.log(a.run, '\n✗ Claude stopped its background agents before they finished, so this step is incomplete. Run it again to pick up where it left off.\n')
          return resolve(code || 1)
        }
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
        if (isActiveRun(r.status)) {
          r.status = 'stopped'
          r.interactive = false
          r.waiting = null
          r.steps.forEach((s) => (s.status === 'running' || s.status === 'waiting') && (s.status = 'failed'))
        }
      }
      for (const r of runs.slice(0, RECOVER_SESSIONS)) recoverSession(r)
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

// Runs saved before session ids were kept: find the last Claude step's session in the raw events
// and its folder in the log, so those runs can be continued too.
function recoverSession(run: Run): void {
  if (resumableStep(run) >= 0) return
  if (!run.steps.some((s) => s.type === 'claude')) return
  try {
    const events = readFileSync(run.logFile.replace(/\.log$/, '.events.jsonl'), 'utf8')
    const ids = [...events.matchAll(/"session_id"\s*:\s*"([0-9a-f-]{36})"/g)]
    const sid = ids[ids.length - 1]?.[1]
    if (!sid) return
    const lines = readFileSync(run.logFile, 'utf8').split(/\r?\n/)
    // The latest Claude step whose header is in the log: "▸ <name>", "$ <command>", "  (in <folder>)".
    for (let idx = run.steps.length - 1; idx >= 0; idx--) {
      const st = run.steps[idx]
      if (st.type !== 'claude' || st.status === 'pending' || st.status === 'skipped') continue
      let cwd: string | undefined
      for (let i = 0; i + 2 < lines.length; i++) {
        if (lines[i] === `▸ ${st.name}` && lines[i + 1].startsWith('$ ') && lines[i + 2].startsWith('  (in ') && lines[i + 2].endsWith(')')) {
          cwd = lines[i + 2].slice('  (in '.length, -1)
        }
      }
      if (cwd) {
        st.sessionId = sid
        st.cwd = cwd
        return
      }
    }
  } catch {
    /* no events or log: leave it */
  }
}

// Whether Claude Code still has this session's transcript (~/.claude/projects/<project>/<session>.jsonl).
// --resume needs it; without it Claude starts over with no memory of the run.
function claudeSessionExists(sessionId: string): boolean {
  const env = process.env.CLAUDE_CONFIG_DIR
  const roots = env ? env.split(',').map((x) => x.trim()).filter(Boolean) : [join(homedir(), '.claude'), join(homedir(), '.config', 'claude')]
  for (const root of roots) {
    const projects = join(root, 'projects')
    let dirs: string[] = []
    try {
      dirs = readdirSync(projects)
    } catch {
      continue
    }
    for (const d of dirs) if (existsSync(join(projects, d, `${sessionId}.jsonl`))) return true
  }
  return false
}
