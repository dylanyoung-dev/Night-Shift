// Turns `claude -p --output-format stream-json --verbose` events into a readable live log:
// Claude's messages, every tool call (subagents indented under the task that started them),
// tool output (trimmed), and a summary at the end. Lines that aren't JSON pass straight through,
// so plain-text Claude output still works.

const MAX_OUTPUT_LINES = 40
const MAX_LINE = 400

type Json = Record<string, any>

interface ToolCall {
  name: string
  depth: number
}

function clip(s: string, n = MAX_LINE): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : '')).join('\n')
  return ''
}

// "mcp__claude_ai_Linear__get_issue" -> "Linear: get_issue"
function toolLabel(name: string): string {
  const m = /^mcp__(?:claude_ai_)?(.+?)__(.+)$/.exec(name)
  return m ? `${m[1].replace(/_/g, ' ')}: ${m[2]}` : name
}

export class ClaudeStreamFormatter {
  private buffer = ''
  private calls = new Map<string, ToolCall>()
  private lastText = ''
  private started = false
  private results: Json[] = [] // turn ends seen since the last drain

  // Turn-end events, collected so the caller can act on them after logging the turn summary.
  drainResults(): Json[] {
    const r = this.results
    this.results = []
    return r
  }

  // onResult fires when Claude ends a turn, with the raw result event.
  constructor(
    private cwd: string,
    private onResult?: (ev: Json) => void
  ) {}

  // Feed raw stdout; returns formatted text to show (may be empty while a line is incomplete).
  feed(chunk: string): string {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    return lines.map((l) => this.line(l)).join('')
  }

  flush(): string {
    const rest = this.buffer
    this.buffer = ''
    return rest ? this.line(rest) : ''
  }

  private rel(p: unknown): string {
    if (typeof p !== 'string') return ''
    const norm = (x: string): string => x.replace(/\\/g, '/').toLowerCase()
    const base = norm(this.cwd).replace(/\/$/, '')
    return norm(p).startsWith(base + '/') ? p.slice(base.length + 1).replace(/\\/g, '/') : p
  }

  private summarize(name: string, input: Json): string {
    const i = input ?? {}
    switch (name) {
      case 'Bash':
        return `Bash: ${clip(String(i.command ?? ''), 200)}`
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit':
        return `${name} ${this.rel(i.file_path ?? i.notebook_path)}`
      case 'Grep':
        return `Grep "${clip(String(i.pattern ?? ''), 80)}"${i.path ? ` in ${this.rel(i.path)}` : ''}`
      case 'Glob':
        return `Glob ${i.pattern ?? ''}`
      case 'Task':
      case 'Agent':
        return `Subagent${i.subagent_type ? ` (${i.subagent_type})` : ''}: ${clip(String(i.description ?? i.prompt ?? ''), 160)}`
      case 'Skill':
        return `Skill: ${i.skill ?? i.name ?? ''}`
      case 'WebFetch':
        return `WebFetch ${i.url ?? ''}`
      case 'WebSearch':
        return `WebSearch "${clip(String(i.query ?? ''), 120)}"`
      case 'TodoWrite':
        return `Updated its plan (${Array.isArray(i.todos) ? i.todos.length : 0} items)`
      default: {
        // MCP and anything else: the tool plus its most telling argument.
        const arg = i.id ?? i.issueId ?? i.query ?? i.title ?? Object.values(i).find((v) => typeof v === 'string')
        return `${toolLabel(name)}${arg ? ` ${clip(String(arg), 120)}` : ''}`
      }
    }
  }

  // Tool output worth showing; file reads and edit confirmations are noise.
  private output(call: ToolCall | undefined, content: unknown, isError: boolean, pad: string): string {
    const text = textOf(content).replace(/\r/g, '').trimEnd()
    if (!text) return ''
    const name = call?.name ?? ''
    if (!isError && ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite', 'Glob'].includes(name)) {
      if (name === 'Read') return `${pad}  (read ${text.split('\n').length} lines)\n`
      return ''
    }
    // Claude Code notes after shell commands that it reset its own working folder; not worth showing.
    const lines = text.split('\n').filter((l) => !/^Shell cwd was reset to /.test(l))
    if (!lines.length) return ''
    const shown = lines.slice(0, MAX_OUTPUT_LINES).map((l) => `${pad}  ${isError ? '✗' : '│'} ${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '…' : l}`)
    if (lines.length > MAX_OUTPUT_LINES) shown.push(`${pad}  │ … ${lines.length - MAX_OUTPUT_LINES} more lines`)
    return shown.join('\n') + '\n'
  }

  private line(raw: string): string {
    const trimmed = raw.trim()
    if (!trimmed) return ''
    let ev: Json
    try {
      ev = JSON.parse(trimmed)
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return raw + '\n'
    } catch {
      return raw + '\n'
    }
    const parent = typeof ev.parent_tool_use_id === 'string' ? this.calls.get(ev.parent_tool_use_id) : undefined
    const depth = parent ? parent.depth + 1 : 0
    const pad = '    '.repeat(depth)

    switch (ev.type) {
      case 'system':
        // A session sends init again on every turn; announce it once.
        if (ev.subtype === 'init' && !this.started) {
          this.started = true
          return `● Claude started · ${ev.model ?? 'model unknown'} · ${ev.permissionMode ?? 'default'} permissions${ev.claude_code_version ? ` · Claude Code ${ev.claude_code_version}` : ''}\n`
        }
        return ''
      case 'assistant': {
        let out = ''
        for (const part of (ev.message?.content ?? []) as Json[]) {
          if (part.type === 'text' && part.text?.trim()) {
            this.lastText = part.text.trim()
            out += `\n${pad}${part.text.trim().split('\n').join(`\n${pad}`)}\n`
          } else if (part.type === 'tool_use') {
            this.calls.set(part.id, { name: part.name, depth })
            out += `${pad}→ ${this.summarize(part.name, part.input)}\n`
          }
        }
        return out
      }
      case 'user': {
        let out = ''
        const content = ev.message?.content
        if (!Array.isArray(content)) return ''
        for (const part of content as Json[]) {
          if (part.type !== 'tool_result') continue
          const call = this.calls.get(part.tool_use_id)
          const callPad = '    '.repeat(call?.depth ?? depth)
          out += this.output(call, part.content, part.is_error === true, callPad)
        }
        return out
      }
      case 'result': {
        const secs = typeof ev.duration_ms === 'number' ? `${Math.round(ev.duration_ms / 1000)}s` : ''
        const cost = typeof ev.total_cost_usd === 'number' ? `$${ev.total_cost_usd.toFixed(2)}` : ''
        const turns = typeof ev.num_turns === 'number' ? `${ev.num_turns} turns` : ''
        let out = `\n● Claude ${ev.is_error ? `stopped with an error (${ev.subtype ?? 'error'})` : 'finished its turn'}${[turns, secs, cost].filter(Boolean).length ? ` · ${[turns, secs, cost].filter(Boolean).join(' · ')}` : ''}\n`
        const denials = Array.isArray(ev.permission_denials) ? (ev.permission_denials as Json[]) : []
        if (denials.length) {
          const names = [...new Set(denials.map((d) => toolLabel(String(d.tool_name ?? d.tool ?? 'unknown'))))]
          out += `  ✗ Permission denied ${denials.length}× for: ${names.join(', ')}\n`
          out += `    Allow them with --allowedTools on the Claude step, or in the repo's .claude/settings.json.\n`
        }
        const result = typeof ev.result === 'string' ? ev.result.trim() : ''
        if (result && result !== this.lastText) out += `\n${result}\n`
        this.results.push(ev)
        this.onResult?.(ev)
        return out
      }
      default:
        return '' // rate limits, hooks and other housekeeping
    }
  }
}

// `claude -p "<prompt>" <flags>` -> the prompt and the other flags, so Night Shift can run the
// step as an open session (prompt sent over stdin, more messages later). Null for anything else.
export function parseClaudeCommand(cmd: string): { prompt: string; flags: string } | null {
  const m = /^\s*claude(?:\.exe|\.cmd)?\s+(?:-p|--print)\s+"((?:[^"\\]|\\.)*)"(.*)$/s.exec(cmd)
  if (!m) return null
  const prompt = m[1].replace(/\\(["\\])/g, '$1').trim()
  if (!prompt) return null
  // Night Shift sets these itself for sessions.
  const flags = m[2]
    .replace(/--(?:output|input)-format[ =]\S+/g, '')
    .replace(/--verbose\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return { prompt, flags }
}

const ASKS_YOU =
  /\b(should I|shall I|do you want|would you like|let me know|please (confirm|approve|provide|choose|decide|reply|advise)|can you (confirm|provide|check|clarify)|could you|need(s)? (you|your|input|approval|a decision|confirmation)|waiting (for|on) you|your call|which (one|option|approach) (do|would|should)|before I (proceed|continue|go ahead)|how would you like)\b/i

// After Claude ends a turn: a reason if it needs the person, null if the step is done.
export function needsYou(result: Record<string, any>): string | null {
  const denials = Array.isArray(result.permission_denials) ? (result.permission_denials as Record<string, any>[]) : []
  if (denials.length) {
    const names = [...new Set(denials.map((d) => toolLabel(String(d.tool_name ?? d.tool ?? 'a tool'))))]
    return `Permission denied for ${names.join(', ')}`
  }
  if (result.is_error) return null // let the step fail on its own exit code
  const text = typeof result.result === 'string' ? result.result.trim() : ''
  if (!text) return null
  const tail = text.slice(-600)
  if (/\?\s*\**\s*$/.test(text) || ASKS_YOU.test(tail)) {
    const questions = tail.split(/(?<=[.!?])\s+/).filter((s) => s.includes('?'))
    return `Claude asked: ${clip(questions[questions.length - 1] ?? tail.slice(-160), 180)}`
  }
  return null
}
