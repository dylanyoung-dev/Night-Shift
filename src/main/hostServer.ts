import { app } from 'electron'
import http from 'http'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import type { HostSettings, HostStatus } from '../shared/types'
import { log } from './log'

// The host's HTTP API for remote Night Shifts. It listens on this machine's Tailscale addresses only
// (never 0.0.0.0, :: or localhost) and lets a request through only when Tailscale says it comes from
// a device signed in as an allowed Tailscale user (by default, the same user as this machine).

export const HOST_API_VERSION = 1
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

  constructor(
    private getSettings: () => HostSettings,
    private onStatus: (s: HostStatus) => void
  ) {}

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
    this.set({ ...this.status, lastCaller: { device: caller!.device, at: Date.now() } })
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && path === '/v1/host') {
      const s = this.getSettings()
      return send(200, {
        name: s.name.trim() || this.self?.hostName,
        dnsName: this.self?.dnsName,
        port: s.port,
        apiVersion: HOST_API_VERSION,
        appVersion: app.getVersion(),
        time: new Date().toISOString(),
        caller: { device: caller!.device, login: caller!.login }
      })
    }
    send(404, { error: `No such route: ${req.method} ${path}` })
  }
}

function fmtAddr(ip: string, port: number): string {
  return ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`
}
