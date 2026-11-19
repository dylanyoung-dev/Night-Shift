import { app } from 'electron'
import http from 'http'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import type { HostMachineSettings, HostSettings, HostStatus, Run, SaveConflict, SharedSettings, StepSet, StepsFile } from '../shared/types'
import { log } from './log'

// The host's HTTP API for remote Night Shifts. It listens on this machine's Tailscale addresses only
// (never 0.0.0.0, :: or localhost) and lets a request through only when Tailscale says it comes from
// a device signed in as an allowed Tailscale user (by default, the same user as this machine).

export const HOST_API_VERSION = 1
const MAX_BODY = 2 * 1024 * 1024
const PING_MS = 20_000

type Result<T = unknown> = T | { error: string }

// What the host does for a remote. Implemented in index.ts with the same code the host's own window uses.
export interface HostOps {
  shared(): { shared: SharedSettings; hostMachine: HostMachineSettings; revs: Record<string, string> }
  saveShared(update: Partial<SharedSettings>, revs: Record<string, string>, by: string): { ok: true } | { conflict: SaveConflict }
  steps(): StepsFile
  saveSteps(sets: StepSet[], revs: Record<string, string>, by: string): Result<StepsFile> | { error: string; conflict: SaveConflict }
  automationStatus(): unknown
  runAutomationNow(id: string): Promise<unknown>
  runs(): Run[]
  readLog(runId: string): string | null
  readEvents(runId: string): string | null
  startRun(issueId: string, setName: string | undefined, by: string): Promise<Result<Run>>
  startGlobal(name: string, by: string): Result<Run>
  stop(runId: string): void
  reply(runId: string, text: string): Result<{ ok: true }>
  finishStep(runId: string): Result<{ ok: true }>
  continueRun(runId: string, text: string): Result<{ ok: true }>
  usage(days: number, refresh: boolean): Promise<unknown>
  usageProgress(): unknown
  ticketStats(days: number, projectId: string | null): Promise<unknown>
  limits(): unknown
  checkLimits(): Promise<unknown>
}
const ADDRESS_CHECK_MS = 60_000 // Tailscale addresses are stable, but rebind if they change
const RETRY_MS = 15_000 // Tailscale not up yet (e.g. just after sign-in)
const WHOIS_TTL_MS = 5 * 60_000
const CLI_TIMEOUT_MS = 10_000

interface TsSelf {
  ips: string[] // IPv4 100.x and IPv6 fd7a:…
  dnsName: string // dylandesktop.tail1a8202.ts.net
  hostName: string
  login: string // this machine's Tailscale user
}

interface Caller {
  device: string
  login: string
}

const TS_PATHS = ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']

// Runs the Tailscale CLI, trying PATH first, then the installer's folder.
function tailscale(args: string[]): Promise<string> {
  const tryAt = (i: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const bin = TS_PATHS[i]
      if (i > 0 && !existsSync(bin)) return reject(new Error('Tailscale is not installed'))
      execFile(bin, args, { windowsHide: true, timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        if (!err) return resolve(out)
        if ((err as NodeJS.ErrnoException).code === 'ENOENT' && i + 1 < TS_PATHS.length) return resolve(tryAt(i + 1))
        reject(new Error(String((err as Error).message).split('\n')[0]))
      })
    })
  return tryAt(0)
}

async function readSelf(): Promise<TsSelf> {
  const st = JSON.parse(await tailscale(['status', '--json'])) as {
    BackendState?: string
    Self?: { TailscaleIPs?: string[]; DNSName?: string; HostName?: string; UserID?: number }
    User?: Record<string, { LoginName?: string }>
  }
  if (st.BackendState !== 'Running') throw new Error(`Tailscale is ${st.BackendState ? st.BackendState.toLowerCase() : 'not running'}`)
  const self = st.Self
  const ips = (self?.TailscaleIPs ?? []).filter((ip) => /^100\./.test(ip) || /^fd7a:115c:a1e0:/i.test(ip))
  if (!ips.length) throw new Error('Tailscale has no address for this machine yet')
  const login = st.User?.[String(self?.UserID)]?.LoginName ?? ''
  if (!login) throw new Error("Couldn't tell which Tailscale user this machine is signed in as")
  return { ips, dnsName: (self?.DNSName ?? '').replace(/\.$/, ''), hostName: self?.HostName ?? '', login }
}

export class HostServer {
  private servers: http.Server[] = []
  private boundIps: string[] = []
  private self: TsSelf | null = null
  private timer: NodeJS.Timeout | undefined
  private whoisCache = new Map<string, { caller: Caller | null; at: number }>()
  private status: HostStatus = { state: 'off', addresses: [], port: 0 }

  private clients = new Set<http.ServerResponse>() // open event streams
  private ping: NodeJS.Timeout | undefined

  constructor(
    private getSettings: () => HostSettings,
    private onStatus: (s: HostStatus) => void,
    private ops: HostOps
  ) {}

  // Sends one event to every connected remote.
  broadcast(event: string, data: unknown): void {
    if (!this.clients.size) return
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of this.clients) res.write(msg)
  }

  remotesConnected(): number {
    return this.clients.size
  }

  view(): HostStatus {
    return this.status
  }

  // Applies the current host settings: starts, rebinds or stops. Calls run one at a time, so two
  // quick saves can't bind the same port twice.
  private chain: Promise<void> = Promise.resolve()
  apply(): Promise<void> {
    this.chain = this.chain.then(() => this.applyNow()).catch((err) => log.error('host:', err))
    return this.chain
  }

  private async applyNow(): Promise<void> {
    clearTimeout(this.timer)
    const s = this.getSettings()
    if (!s.enabled) {
      await this.close()
      this.whoisCache.clear()
      return this.set({ state: 'off', addresses: [], port: s.port })
    }
    try {
      this.self = await readSelf()
    } catch (err) {
      await this.close()
      this.set({ state: 'waiting', addresses: [], port: s.port, error: (err as Error).message })
      this.timer = setTimeout(() => void this.apply(), RETRY_MS)
      return
    }
    const same = this.servers.length && this.boundIps.join() === this.self.ips.join() && this.status.port === s.port
    if (!same) {
      await this.close()
      try {
        await this.listen(this.self.ips, s.port)
      } catch (err) {
        await this.close()
        this.set({ state: 'error', addresses: [], port: s.port, error: (err as Error).message })
        this.timer = setTimeout(() => void this.apply(), RETRY_MS)
        return
      }
      log.info(`host: listening on ${this.self.ips.map((ip) => fmtAddr(ip, s.port)).join(', ')}`)
    }
    this.set({
      ...this.status,
      state: 'listening',
      name: s.name.trim() || this.self.hostName,
      dnsName: this.self.dnsName,
      login: this.self.login,
      addresses: this.self.ips,
      port: s.port,
      error: undefined
    })
    this.timer = setTimeout(() => void this.apply(), ADDRESS_CHECK_MS)
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer)
    await this.close()
  }

  private set(s: HostStatus): void {
    this.status = s
    this.onStatus(s)
  }

  private listen(ips: string[], port: number): Promise<void> {
    return Promise.all(
      ips.map(
        (ip) =>
          new Promise<void>((resolve, reject) => {
            const server = http.createServer((req, res) => void this.handle(req, res))
            server.headersTimeout = 15_000
            server.requestTimeout = 30_000
            server.once('error', (err: NodeJS.ErrnoException) =>
              reject(new Error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use on ${ip}` : `Couldn't listen on ${fmtAddr(ip, port)}: ${err.message}`))
            )
            // Bound to this one Tailscale address only.
            server.listen({ host: ip, port, ipv6Only: ip.includes(':') }, () => {
              this.servers.push(server)
              resolve()
            })
          })
      )
    ).then(() => {
      this.boundIps = [...ips]
    })
  }

  private async close(): Promise<void> {
    for (const res of this.clients) res.end()
    this.clients.clear()
    clearInterval(this.ping)
    this.ping = undefined
    const all = this.servers
    this.servers = []
    this.boundIps = []
    await Promise.all(
      all.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.closeAllConnections?.()
            s.close(() => resolve())
          })
      )
    )
  }

  // Who is calling, according to Tailscale. Cached per caller address for a few minutes.
  private async whois(ip: string, port: number): Promise<Caller | null> {
    const hit = this.whoisCache.get(ip)
    if (hit && Date.now() - hit.at < WHOIS_TTL_MS) return hit.caller
    let caller: Caller | null = null
    try {
      const j = JSON.parse(await tailscale(['whois', '--json', fmtAddr(ip, port)])) as {
        Node?: { ComputedName?: string; Name?: string; Tags?: string[] }
        UserProfile?: { LoginName?: string }
      }
      const login = j.UserProfile?.LoginName ?? ''
      // Tagged devices belong to no person ("tagged-devices"), so they never match a login.
      if (login && !j.Node?.Tags?.length) caller = { device: j.Node?.ComputedName || (j.Node?.Name ?? '').split('.')[0], login }
    } catch {
      caller = null // can't tell who it is: refuse
    }
    if (this.whoisCache.size > 200) this.whoisCache.clear()
    this.whoisCache.set(ip, { caller, at: Date.now() })
    return caller
  }

  private allowed(caller: Caller | null): boolean {
    if (!caller || !this.self) return false
    const extra = this.getSettings().allowedLogins.map((l) => l.toLowerCase())
    const login = caller.login.toLowerCase()
    return login === this.self.login.toLowerCase() || extra.includes(login)
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    const port = req.socket.remotePort ?? 0
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const caller = await this.whois(ip, port)
    if (!this.allowed(caller)) {
      log.warn(`host: refused ${req.method} ${req.url} from ${ip}${caller ? ` (${caller.device}, ${caller.login})` : ' (unknown to Tailscale)'}`)
      return send(403, { error: 'This device is not allowed to use this Night Shift host.' })
    }
    const who = caller!
    const last = this.status.lastCaller
    if (!last || last.device !== who.device || Date.now() - last.at > 30_000) this.set({ ...this.status, lastCaller: { device: who.device, at: Date.now() } })
    try {
      await this.route(req, res, who, send)
    } catch (err) {
      log.error(`host: ${req.method} ${req.url} failed:`, err)
      if (!res.headersSent) send(500, { error: `The host hit an error: ${(err as Error).message}` })
      else res.end()
    }
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, who: Caller, send: (code: number, body: unknown) => void): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://host')
    const path = url.pathname
    const m = req.method ?? 'GET'
    const ops = this.ops
    // Errors from an operation are a 400 with its message; a missing run is a 404.
    const reply = (r: unknown, okCode = 200): void => {
      if (r && typeof r === 'object' && 'conflict' in r) return send(409, r)
      if (r && typeof r === 'object' && 'error' in r) return send(400, r)
      send(okCode, r ?? { ok: true })
    }
    const text = (code: number, body: string | null, type: string): void => {
      if (body === null) return send(404, { error: 'No such run, or its log is gone.' })
      res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' })
      res.end(body)
    }
    const runMatch = /^\/v1\/runs\/([A-Za-z0-9_.-]+)\/(log|events|stop|reply|finish-step|continue)$/.exec(path)
    const autoMatch = /^\/v1\/automations\/([A-Za-z0-9_-]+)\/run-now$/.exec(path)
    const days = Math.min(365, Math.max(1, Math.round(Number(url.searchParams.get('days')) || 30)))

    if (m === 'GET' && path === '/v1/host') {
      const s = this.getSettings()
      return send(200, {
        name: s.name.trim() || this.self?.hostName,
        dnsName: this.self?.dnsName,
        port: s.port,
        apiVersion: HOST_API_VERSION,
        appVersion: app.getVersion(),
        time: new Date().toISOString(),
        caller: { device: who.device, login: who.login }
      })
    }
    if (m === 'GET' && path === '/v1/events') return this.openEvents(req, res, who)
    if (m === 'GET' && path === '/v1/shared') return send(200, ops.shared())
    if (m === 'POST' && path === '/v1/shared') {
      const b = (await readJson(req)) as { update?: Partial<SharedSettings>; revs?: Record<string, string> }
      return reply(ops.saveShared(b.update ?? {}, b.revs ?? {}, who.device))
    }
    if (m === 'GET' && path === '/v1/actions') return send(200, ops.steps())
    if (m === 'POST' && path === '/v1/actions') {
      const b = (await readJson(req)) as { sets?: StepSet[]; revs?: Record<string, string> }
      if (!Array.isArray(b.sets)) return send(400, { error: 'Nothing to save.' })
      return reply(ops.saveSteps(b.sets, b.revs ?? {}, who.device))
    }
    if (m === 'GET' && path === '/v1/automations/status') return send(200, ops.automationStatus())
    if (m === 'POST' && autoMatch) return reply(await ops.runAutomationNow(autoMatch[1]))
    if (m === 'GET' && path === '/v1/runs') return send(200, ops.runs())
    if (m === 'POST' && path === '/v1/runs') {
      const b = (await readJson(req)) as { issueId?: string; setName?: string }
      return reply(await ops.startRun(String(b.issueId ?? ''), b.setName ? String(b.setName) : undefined, who.device))
    }
    if (m === 'POST' && path === '/v1/runs/global') {
      const b = (await readJson(req)) as { name?: string }
      return reply(ops.startGlobal(String(b.name ?? ''), who.device))
    }
    if (runMatch) {
      const [, id, what] = runMatch
      if (m === 'GET' && what === 'log') return text(200, ops.readLog(id), 'text/plain')
      if (m === 'GET' && what === 'events') return text(200, ops.readEvents(id), 'application/x-ndjson')
      if (m === 'POST') {
        const b = (await readJson(req)) as { text?: string }
        if (what === 'stop') return reply((ops.stop(id), { ok: true }))
        if (what === 'reply') return reply(ops.reply(id, String(b.text ?? '')))
        if (what === 'finish-step') return reply(ops.finishStep(id))
        if (what === 'continue') return reply(ops.continueRun(id, String(b.text ?? '')))
      }
    }
    if (m === 'GET' && path === '/v1/usage') return send(200, await ops.usage(days, url.searchParams.get('refresh') === '1'))
    if (m === 'GET' && path === '/v1/usage/progress') return send(200, ops.usageProgress() ?? null)
    if (m === 'GET' && path === '/v1/ticket-stats') return send(200, await ops.ticketStats(days, url.searchParams.get('projectId')))
    if (m === 'GET' && path === '/v1/limits') return send(200, ops.limits() ?? null)
    if (m === 'POST' && path === '/v1/limits/check') return send(200, (await ops.checkLimits()) ?? null)
    send(404, { error: `No such route: ${m} ${path}` })
  }

  // Server-sent events: the remote keeps this open and gets every change as it happens.
  private openEvents(req: http.IncomingMessage, res: http.ServerResponse, who: Caller): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    res.write(': connected\n\n')
    req.socket.setTimeout(0)
    this.clients.add(res)
    log.info(`host: ${who.device} connected (${this.clients.size} remote${this.clients.size === 1 ? '' : 's'})`)
    if (!this.ping) this.ping = setInterval(() => this.broadcast('ping', Date.now()), PING_MS)
    req.on('close', () => {
      this.clients.delete(res)
      log.info(`host: ${who.device} disconnected`)
      if (!this.clients.size) {
        clearInterval(this.ping)
        this.ping = undefined
      }
    })
  }
}

// Reads a JSON body (at most MAX_BODY bytes).
function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Request too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('The request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function fmtAddr(ip: string, port: number): string {
  return ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`
}
