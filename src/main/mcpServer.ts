import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import { rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { Run } from '../shared/types'
import { log } from './log'

// A read-only MCP server for Claude Desktop: the agent runs, their steps and logs, for audits.
// Claude Desktop starts local MCP servers as a command over stdio, so it runs the small bridge in
// resources/mcp-bridge.cjs, which passes each message to this endpoint. The endpoint:
//  - listens on 127.0.0.1 only, on a random port, with a token made at each start;
//  - refuses requests with an Origin header (a web page in a browser), or without the token;
//  - writes { port, token, pid } to mcp.json in the app's data folder for the bridge, and removes it on stop.
// Nothing here starts, stops or changes anything.

export interface McpOps {
  runs(): Promise<Run[]> // newest first; from the host when connected to one
  log(runId: string): Promise<string | null> // the whole log (capped), or null when unknown
  tokens?(sessionIds: string[]): Promise<{ tokens: number; output: number } | null> // this machine's transcripts only
  version: string
}

const PROTOCOL = '2025-06-18'
const MAX_BODY = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000

type Args = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const num = (v: unknown, def: number, min: number, max: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def
}
const iso = (t?: number): string | null => (t ? new Date(t).toISOString() : null)
const secs = (a?: number, b?: number): number | null => (a && b ? Math.round((b - a) / 1000) : null)

const TOOLS = [
  {
    name: 'list_runs',
    description:
      'List Night Shift agent runs, newest first. Filter by action (the run type, e.g. "Planner", "Build steps", "Review"), status, ticket or start date. Use list_actions to see the action names.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many runs (1-200). Default 10.' },
        action: { type: 'string', description: 'Action name, or part of it (case-insensitive).' },
        status: { type: 'string', enum: ['queued', 'running', 'waiting', 'done', 'failed', 'stopped'] },
        ticket: { type: 'string', description: 'Ticket identifier, e.g. IGN-811.' },
        since: { type: 'string', description: 'Only runs started on or after this date (ISO, e.g. 2026-11-20).' }
      }
    }
  },
  {
    name: 'get_run',
    description: "One run in full: every step with its type, status, times, duration and command, the branch and worktree, why it's waiting, the end of its log, and token totals when known.",
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] }
  },
  {
    name: 'get_run_log',
    description: "A slice of a run's full log. Starts from the end by default; page with offset (characters from the start) using the nextOffset/prevOffset returned.",
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        offset: { type: 'number', description: 'Start at this character. Leave out to read the end.' },
        maxChars: { type: 'number', description: 'Up to this many characters (1000-200000). Default 40000.' }
      },
      required: ['runId']
    }
  },
  {
    name: 'search_run_logs',
    description: 'Search the logs of recent runs for text (case-insensitive), with lines of context. Narrow by action or status.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        action: { type: 'string' },
        status: { type: 'string', enum: ['queued', 'running', 'waiting', 'done', 'failed', 'stopped'] },
        limit: { type: 'number', description: 'How many of the newest matching runs to search (1-100). Default 20.' },
        context: { type: 'number', description: 'Lines of context around each match (0-10). Default 2.' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_actions',
    description: 'The actions (run types) in the run history, with how many runs each has, how they ended, and when each last ran.',
    inputSchema: { type: 'object', properties: {} }
  }
]

function summary(r: Run): Record<string, unknown> {
  const failed = r.steps.find((s) => s.status === 'failed')
  return {
    id: r.id,
    ticket: r.global ? null : r.identifier,
    title: r.title,
    action: r.stepsName,
    status: r.status,
    started: iso(r.startedAt ?? r.createdAt),
    ended: iso(r.endedAt),
    durationSec: secs(r.startedAt ?? r.createdAt, r.endedAt),
    steps: `${r.steps.filter((s) => s.status === 'done').length}/${r.steps.length} done`,
    ...(failed ? { failedStep: failed.name } : {}),
    ...(r.startedBy ? { startedBy: r.startedBy } : {}),
    ...(r.waiting ? { waiting: r.waiting.reason } : {})
  }
}

function filterRuns(runs: Run[], a: Args): Run[] {
  const action = str(a.action).toLowerCase()
  const status = str(a.status).toLowerCase()
  const ticket = str(a.ticket).toUpperCase()
  const since = str(a.since) ? Date.parse(str(a.since)) : NaN
  return runs.filter(
    (r) =>
      (!action || r.stepsName.toLowerCase().includes(action)) &&
      (!status || r.status === status) &&
      (!ticket || r.identifier.toUpperCase() === ticket) &&
      (Number.isNaN(since) || (r.startedAt ?? r.createdAt) >= since)
  )
}

export class McpServer {
  private server: Server | null = null
  private token = ''
  constructor(
    private ops: McpOps,
    private infoFile: string
  ) {}

  get running(): boolean {
    return !!this.server
  }

  async start(): Promise<void> {
    if (this.server) return
    this.token = randomBytes(24).toString('hex')
    const server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    this.server = server
    writeFileSync(this.infoFile, JSON.stringify({ port, token: this.token, pid: process.pid }), { mode: 0o600 })
    // The tool list, kept after quitting, so the bridge can list the tools while the app is closed.
    writeFileSync(join(dirname(this.infoFile), 'mcp-tools.json'), JSON.stringify({ tools: TOOLS }))
    log.info(`mcp: listening on 127.0.0.1:${port} (local only, for Claude Desktop)`)
  }

  stop(): void {
    this.server?.close()
    this.server = null
    try {
      rmSync(this.infoFile, { force: true })
    } catch {
      /* gone already */
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(body === undefined ? '' : JSON.stringify(body))
    }
    if (req.headers.origin) return send(403, { error: 'Not for browsers.' })
    const auth = String(req.headers.authorization ?? '')
    const given = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '')
    const want = Buffer.from(this.token)
    if (given.length !== want.length || !timingSafeEqual(given, want)) return send(401, { error: 'Bad token.' })
    if (req.method !== 'POST' || req.url !== '/mcp') return send(404, { error: 'Not found.' })

    let raw = ''
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) return send(413, { error: 'Too large.' })
      raw += chunk
    }
    let msg: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Args }
    try {
      msg = JSON.parse(raw)
    } catch {
      return send(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }
    if (msg.id === undefined) return send(202) // a notification: nothing to answer
    const reply = (result: unknown): void => send(200, { jsonrpc: '2.0', id: msg.id, result })
    const fail = (code: number, message: string): void => send(200, { jsonrpc: '2.0', id: msg.id, error: { code, message } })

    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: str(msg.params?.protocolVersion) || PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'night-shift', version: this.ops.version },
          instructions:
            'Read-only access to Night Shift agent runs (steps, logs, outcomes) for audits. Start with list_runs or list_actions, then get_run and get_run_log for detail.'
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: TOOLS })
      case 'tools/call': {
        const name = str(msg.params?.name)
        const args = (msg.params?.arguments ?? {}) as Args
        try {
          const text = await this.call(name, args)
          return reply({ content: [{ type: 'text', text }] })
        } catch (err) {
          return reply({ content: [{ type: 'text', text: (err as Error).message }], isError: true })
        }
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`)
    }
  }

  private async call(name: string, a: Args): Promise<string> {
    const runs = await this.ops.runs()
    const find = (): Run => {
      const id = str(a.runId)
      const r = runs.find((x) => x.id === id)
      if (!r) throw new Error(`No run "${id}" in the history (it keeps the last 200). Use list_runs to find ids.`)
      return r
    }
    switch (name) {
      case 'list_runs': {
        const all = filterRuns(runs, a)
        const shown = all.slice(0, num(a.limit, 10, 1, 200))
        return JSON.stringify({ matching: all.length, shown: shown.length, runs: shown.map(summary) }, null, 1)
      }
      case 'get_run': {
        const r = find()
        const sessions = r.steps.map((s) => s.sessionId).filter((x): x is string => !!x)
        const tokens = sessions.length && this.ops.tokens ? await this.ops.tokens(sessions).catch(() => null) : null
        return JSON.stringify(
          {
            ...summary(r),
            branch: r.branch || null,
            worktree: r.worktree || null,
            worktreeMode: r.worktreeMode ?? null,
            created: iso(r.createdAt),
            steps: r.steps.map((s) => ({
              name: s.name,
              type: s.type,
              status: s.status,
              started: iso(s.startedAt),
              ended: iso(s.endedAt),
              durationSec: secs(s.startedAt, s.endedAt),
              ...(s.command ? { command: s.command } : {}),
              ...(s.sessionId ? { claudeSession: s.sessionId } : {})
            })),
            ...(tokens ? { tokens: tokens.tokens, outputTokens: tokens.output } : {}),
            logTail: r.logTail.slice(-4000)
          },
          null,
          1
        )
      }
      case 'get_run_log': {
        const r = find()
        const text = (await this.ops.log(r.id)) ?? r.logTail
        const max = num(a.maxChars, 40_000, 1000, 200_000)
        const start = a.offset === undefined || a.offset === null ? Math.max(0, text.length - max) : num(a.offset, 0, 0, text.length)
        const end = Math.min(text.length, start + max)
        const head = { runId: r.id, totalChars: text.length, from: start, to: end, ...(start > 0 ? { prevOffset: Math.max(0, start - max) } : {}), ...(end < text.length ? { nextOffset: end } : {}) }
        return `${JSON.stringify(head)}\n---\n${text.slice(start, end)}`
      }
      case 'search_run_logs': {
        const q = str(a.query).toLowerCase()
        if (!q) throw new Error('Give a query.')
        const ctx = num(a.context, 2, 0, 10)
        const picked = filterRuns(runs, a).slice(0, num(a.limit, 20, 1, 100))
        const out: Record<string, unknown>[] = []
        for (const r of picked) {
          const lines = ((await this.ops.log(r.id)) ?? r.logTail).split('\n')
          const hits: string[] = []
          for (let i = 0; i < lines.length && hits.length < 20; i++) {
            if (!lines[i].toLowerCase().includes(q)) continue
            hits.push(lines.slice(Math.max(0, i - ctx), i + ctx + 1).map((l, k) => `${Math.max(0, i - ctx) + k + 1}: ${l.slice(0, 500)}`).join('\n'))
          }
          if (hits.length) out.push({ ...summary(r), matches: hits })
        }
        return JSON.stringify({ searched: picked.length, runsWithMatches: out.length, results: out }, null, 1)
      }
      case 'list_actions': {
        const by = new Map<string, { runs: number; statuses: Record<string, number>; lastRun: number; last7Days: number }>()
        const weekAgo = Date.now() - 7 * DAY
        for (const r of runs) {
          const at = r.startedAt ?? r.createdAt
          const e = by.get(r.stepsName) ?? { runs: 0, statuses: {}, lastRun: 0, last7Days: 0 }
          e.runs++
          e.statuses[r.status] = (e.statuses[r.status] ?? 0) + 1
          e.lastRun = Math.max(e.lastRun, at)
          if (at >= weekAgo) e.last7Days++
          by.set(r.stepsName, e)
        }
        const list = [...by.entries()].sort((x, y) => y[1].lastRun - x[1].lastRun).map(([action, e]) => ({ action, ...e, lastRun: iso(e.lastRun) }))
        return JSON.stringify({ historyRuns: runs.length, actions: list }, null, 1)
      }
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  }
}
