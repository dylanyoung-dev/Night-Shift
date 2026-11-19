import http from 'http'
import type { RemoteStatus, RemoteTarget } from '../shared/types'
import { log } from './log'
import { HOST_API_VERSION } from './hostServer'

// Remote mode: talks to the host's API over Tailscale. JSON calls for actions, plus one long-lived
// event stream (server-sent events) for runs, live log output and changes to shared settings.
// Nothing it receives is written to disk.

const CALL_TIMEOUT_MS = 20_000
const RETRY_MS = 10_000

export class HostUnreachable extends Error {}

function fmtHost(h: string): string {
  return h.includes(':') ? `[${h}]` : h
}

// One JSON request to a host. Resolves with the parsed body and status; throws HostUnreachable
// when the host can't be reached at all.
export function hostRequest<T>(t: RemoteTarget, method: string, path: string, body?: unknown, timeout = CALL_TIMEOUT_MS): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = http.request(
      {
        host: t.host,
        port: t.port,
        method,
        path: `/v1${path}`,
        timeout,
        headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          const type = String(res.headers['content-type'] ?? '')
          let parsed: unknown = text
          if (type.includes('json')) {
            try {
              parsed = JSON.parse(text)
            } catch {
              parsed = { error: 'The host sent something that isn’t JSON.' }
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed as T })
        })
      }
    )
    req.on('timeout', () => req.destroy(new HostUnreachable(`${t.host} didn't answer in time`)))
    req.on('error', (err) => reject(err instanceof HostUnreachable ? err : new HostUnreachable(`Can't reach ${t.host}: ${(err as NodeJS.ErrnoException).code ?? err.message}`)))
    if (data) req.write(data)
    req.end()
  })
}

export class RemoteClient {
  private status: RemoteStatus = { state: 'off', host: '', port: 0 }
  private stream: http.ClientRequest | null = null
  private retry: NodeJS.Timeout | undefined
  private target: RemoteTarget | null = null
  private generation = 0

  constructor(
    private onStatus: (s: RemoteStatus) => void,
    private onEvent: (event: string, data: unknown) => void,
    private onConnected: () => void // (re)connected: reload everything from the host
  ) {}

  view(): RemoteStatus {
    return this.status
  }

  connected(): boolean {
    return this.status.state === 'connected'
  }

  start(t: RemoteTarget): void {
    this.stop()
    this.target = t
    this.set({ state: 'connecting', host: t.host, port: t.port, since: Date.now() })
    void this.connect(++this.generation)
  }

  stop(): void {
    this.generation++
    clearTimeout(this.retry)
    this.stream?.destroy()
    this.stream = null
    this.target = null
    this.set({ state: 'off', host: '', port: 0 })
  }

  // A JSON call to the host. Errors come back as { error } so callers can pass them straight on.
  async call<T>(method: string, path: string, body?: unknown): Promise<T | { error: string; status?: number }> {
    if (!this.target) return { error: 'Not connected to a host.' }
    try {
      const r = await hostRequest<T>(this.target, method, path, body)
      if (r.status >= 400 && !(r.status === 409 && typeof r.body === 'object')) {
        const msg = (r.body as { error?: string })?.error ?? `The host answered ${r.status}.`
        return { error: msg, status: r.status }
      }
      return r.body
    } catch (err) {
      this.lost((err as Error).message)
      return { error: `${(err as Error).message}. Is Night Shift running on ${this.status.name ?? this.target.host}?` }
    }
  }

  // Raw text, for log files.
  async text(path: string): Promise<string | { error: string }> {
    const r = await this.call<string>('GET', path)
    return typeof r === 'string' ? r : 'error' in r ? r : JSON.stringify(r)
  }

  private set(next: RemoteStatus): void {
    this.status = next
    this.onStatus(next)
  }

  private lost(error: string): void {
    if (!this.target || this.status.state === 'offline') return
    log.warn(`remote: lost ${this.target.host}: ${error}`)
    this.set({ ...this.status, state: 'offline', since: Date.now(), error })
    this.stream?.destroy()
    this.stream = null
    clearTimeout(this.retry)
    const gen = this.generation
    this.retry = setTimeout(() => void this.connect(gen), RETRY_MS)
  }

  private async connect(gen: number): Promise<void> {
    const t = this.target
    if (!t || gen !== this.generation || this.status.state === 'connected') return
    clearTimeout(this.retry) // a call that failed may have queued another attempt
    try {
      const r = await hostRequest<{ name: string; apiVersion: number; appVersion: string; error?: string }>(t, 'GET', '/host', undefined, 8000)
      if (gen !== this.generation) return
      if (r.status !== 200) throw new Error(r.body?.error ?? `The host answered ${r.status}`)
      if (r.body.apiVersion !== HOST_API_VERSION) {
        this.set({ ...this.status, state: 'incompatible', name: r.body.name, appVersion: r.body.appVersion, error: `${r.body.name} runs Night Shift ${r.body.appVersion}, which doesn't match this version. Update both to the same version.` })
        this.retry = setTimeout(() => void this.connect(gen), RETRY_MS * 6)
        return
      }
      this.openStream(t, gen, r.body.name, r.body.appVersion)
    } catch (err) {
      if (gen !== this.generation) return
      const msg = (err as Error).message
      if (this.status.state !== 'offline') log.warn(`remote: can't reach ${t.host}: ${msg}`)
      this.set({ ...this.status, state: 'offline', since: this.status.since ?? Date.now(), error: msg })
      this.retry = setTimeout(() => void this.connect(gen), RETRY_MS)
    }
  }

  // The event stream. Each event is "event: <name>\ndata: <json>\n\n".
  private openStream(t: RemoteTarget, gen: number, name: string, appVersion: string): void {
    this.stream?.destroy() // never two streams at once
    // Only the current stream may report trouble; an old one being torn down must not.
    const live = (): boolean => gen === this.generation && this.stream === req
    const req: http.ClientRequest = http.get({ host: t.host, port: t.port, path: '/v1/events', headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        if (!live()) return
        return this.lost(`the host refused the event stream (${res.statusCode})`)
      }
      log.info(`remote: connected to ${name} (${fmtHost(t.host)}:${t.port}, Night Shift ${appVersion})`)
      this.set({ state: 'connected', host: t.host, port: t.port, name, appVersion })
      this.onConnected()
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buf += chunk
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          let event = 'message'
          const data: string[] = []
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
          }
          if (event === 'ping' || !data.length || !live()) continue
          try {
            this.onEvent(event, JSON.parse(data.join('\n')))
          } catch {
            /* a malformed event: skip it */
          }
        }
      })
      res.on('end', () => live() && this.lost('the host closed the connection'))
      res.on('error', (err) => live() && this.lost(err.message))
    })
    // No timeout on the stream itself: the host sends a ping every 20 s; 45 s of silence means it's gone.
    let silent: NodeJS.Timeout | undefined
    const watchdog = (): void => {
      clearTimeout(silent)
      silent = setTimeout(() => live() && this.lost('no word from the host for 45 seconds'), 45_000)
    }
    req.on('response', (res) => res.on('data', watchdog))
    watchdog()
    req.on('error', (err) => live() && this.lost(err.message))
    req.on('close', () => clearTimeout(silent))
    this.stream = req
  }
}
