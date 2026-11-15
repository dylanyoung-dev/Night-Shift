import { app } from 'electron'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { createInterface } from 'readline'
import type { TokenCounts, UsageDay, UsageReport, UsageSlice } from '../shared/types'

// Claude Code usage, read from the session transcripts Claude Code writes on this machine
// (~/.claude/projects/**/<session>.jsonl). Every assistant message carries its token usage.
// Files are append-only, so each scan only reads the bytes added since the last one.

// One message: [time ms, model index, input, output, cache write, cache read, dedupe key]
type Rec = [number, number, number, number, number, number, string]
interface FileEntry {
  size: number
  mtimeMs: number
  offset: number // bytes parsed so far (up to the last complete line)
  cwd: string
  models: string[]
  recs: Rec[]
}
interface Cache {
  version: number
  files: Record<string, FileEntry>
}

const VERSION = 1
const BLOCK_MS = 5 * 3600_000 // Claude plans meter usage in 5-hour windows
const cacheFile = (): string => join(app.getPath('userData'), 'usage-cache.json')

function projectDirs(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR
  const roots = env ? env.split(',').map((s) => s.trim()).filter(Boolean) : [join(homedir(), '.claude'), join(homedir(), '.config', 'claude')]
  return [...new Set(roots.map((r) => join(r, 'projects')))].filter((d) => existsSync(d))
}

function listTranscripts(): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory() && depth < 4) walk(p, depth + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  for (const d of projectDirs()) walk(d, 0)
  return out
}

let cache: Cache | null = null
function loadCache(): Cache {
  if (cache) return cache
  try {
    const c = JSON.parse(readFileSync(cacheFile(), 'utf8')) as Cache
    if (c.version === VERSION && c.files) return (cache = c)
  } catch {
    /* first scan */
  }
  return (cache = { version: VERSION, files: {} })
}

function parseLine(line: string, entry: FileEntry): void {
  if (!entry.cwd && line.includes('"cwd"')) {
    try {
      const o = JSON.parse(line)
      if (typeof o.cwd === 'string') entry.cwd = o.cwd
    } catch {
      /* ignore */
    }
  }
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return
  try {
    const o = JSON.parse(line)
    const msg = o.message
    const u = msg?.usage
    if (o.type !== 'assistant' || !u || !msg.model || msg.model === '<synthetic>') return
    const t = Date.parse(o.timestamp)
    if (!Number.isFinite(t)) return
    const nums = [u.input_tokens || 0, u.output_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0]
    if (nums.every((n) => n === 0)) return
    let mi = entry.models.indexOf(msg.model)
    if (mi < 0) mi = entry.models.push(msg.model) - 1
    entry.recs.push([t, mi, nums[0], nums[1], nums[2], nums[3], `${msg.id ?? ''}:${o.requestId ?? ''}`])
  } catch {
    /* odd line */
  }
}

// Reads lines added since entry.offset. Each line is handled once the next one shows up, and the
// final line only if the file ends with a newline, so a line still being written is read next time.
async function readNewLines(path: string, entry: FileEntry, size: number): Promise<void> {
  if (size <= entry.offset) return
  const stream = createReadStream(path, { start: entry.offset, end: size - 1, encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let pending: string | null = null
  for await (const line of rl) {
    if (pending !== null) {
      parseLine(pending, entry)
      entry.offset += Buffer.byteLength(pending, 'utf8') + 1
    }
    pending = line
  }
  if (pending !== null && (await endsWithNewline(path, size))) {
    parseLine(pending, entry)
    entry.offset += Buffer.byteLength(pending, 'utf8') + 1
  }
}

function endsWithNewline(path: string, size: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createReadStream(path, { start: size - 1, end: size - 1 })
    s.on('data', (b) => resolve((b as Buffer)[0] === 10))
    s.on('error', () => resolve(false))
    s.on('end', () => resolve(false))
  })
}

let scanning: Promise<void> | null = null
let progress = { done: 0, total: 0 }
let lastScan = 0

async function scan(): Promise<void> {
  const c = loadCache()
  const files = listTranscripts()
  progress = { done: 0, total: files.length }
  const seen = new Set<string>()
  let changed = false
  for (const path of files) {
    seen.add(path)
    try {
      const st = statSync(path)
      let entry = c.files[path]
      if (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs) {
        progress.done++
        continue
      }
      // A file that shrank was rewritten; start over.
      if (!entry || st.size < entry.offset) entry = { size: 0, mtimeMs: 0, offset: 0, cwd: '', models: [], recs: [] }
      await readNewLines(path, entry, st.size)
      entry.size = st.size
      entry.mtimeMs = st.mtimeMs
      c.files[path] = entry
      changed = true
    } catch {
      /* unreadable; skip */
    }
    progress.done++
    await new Promise((r) => setImmediate(r)) // let IPC breathe during the first, long scan
  }
  for (const p of Object.keys(c.files)) {
    if (!seen.has(p)) {
      delete c.files[p]
      changed = true
    }
  }
  if (changed) {
    try {
      writeFileSync(cacheFile(), JSON.stringify(c))
    } catch {
      /* cache is only an optimisation */
    }
  }
  lastScan = Date.now()
}

function ensureScan(force: boolean): Promise<void> {
  if (!scanning && (force || Date.now() - lastScan > 60_000)) {
    scanning = scan().finally(() => (scanning = null))
  }
  return scanning ?? Promise.resolve()
}

export function usageProgress(): { done: number; total: number; scanning: boolean } {
  return { ...progress, scanning: Boolean(scanning) }
}

const zero = (): TokenCounts => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 })
function add(t: TokenCounts, r: Rec): void {
  t.input += r[2]
  t.output += r[3]
  t.cacheWrite += r[4]
  t.cacheRead += r[5]
  t.messages++
}
const dayKey = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function projectName(cwd: string, path: string): string {
  if (cwd) return basename(cwd.replace(/[\\/]+$/, '')) || cwd
  return basename(join(path, '..'))
}

// nightShiftSessions: Claude session ids started by Night Shift runs, to show their share.
export async function getUsage(days: number, nightShiftSessions: Set<string>, refresh = false): Promise<UsageReport> {
  await ensureScan(refresh)
  const c = loadCache()
  const now = Date.now()
  const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).getTime()
  const since = startOfToday - (days - 1) * 86_400_000

  const dedupe = new Set<string>()
  const all: { r: Rec; model: string; project: string; ns: boolean }[] = []
  for (const [path, f] of Object.entries(c.files)) {
    const project = projectName(f.cwd, path)
    const ns = nightShiftSessions.has(basename(path, '.jsonl'))
    for (const r of f.recs) {
      if (r[6] !== ':' && dedupe.has(r[6])) continue // resumed sessions repeat earlier messages
      dedupe.add(r[6])
      all.push({ r, model: f.models[r[1]] ?? 'unknown', project, ns })
    }
  }
  all.sort((a, b) => a.r[0] - b.r[0])

  const today = zero()
  const week = zero()
  const period = zero()
  const nightShift = zero()
  const byDay = new Map<string, UsageDay>()
  for (let i = 0; i < days; i++) {
    const k = dayKey(since + i * 86_400_000 + 3600_000) // +1h keeps DST days on the right date
    byDay.set(k, { date: k, ...zero(), nightShift: 0 })
  }
  const byModel = new Map<string, TokenCounts>()
  const byProject = new Map<string, TokenCounts>()

  // 5-hour windows, the way plan limits count: a window opens at the hour of the first
  // message after the previous one closed.
  let blockStart = 0
  let block = zero()
  let blockFirst = 0
  let blockLast = 0

  for (const { r, model, project, ns } of all) {
    const t = r[0]
    if (!blockStart || t >= blockStart + BLOCK_MS) {
      blockStart = Math.floor(t / 3600_000) * 3600_000
      block = zero()
      blockFirst = t
    }
    add(block, r)
    blockLast = t
    if (t >= startOfToday) add(today, r)
    if (t >= startOfToday - 6 * 86_400_000) add(week, r)
    if (t < since) continue
    add(period, r)
    if (ns) add(nightShift, r)
    const d = byDay.get(dayKey(t))
    if (d) {
      add(d, r)
      if (ns) d.nightShift += r[2] + r[3] + r[4] + r[5]
    }
    const m = byModel.get(model) ?? zero()
    add(m, r)
    byModel.set(model, m)
    const p = byProject.get(project) ?? zero()
    add(p, r)
    byProject.set(project, p)
  }

  const total = (t: TokenCounts): number => t.input + t.output + t.cacheWrite + t.cacheRead
  const slices = (m: Map<string, TokenCounts>): UsageSlice[] =>
    [...m.entries()].map(([name, t]) => ({ name, ...t })).sort((a, b) => total(b) - total(a))

  const active = blockStart > 0 && now < blockStart + BLOCK_MS
  const minutes = Math.max(1, (blockLast - blockFirst) / 60_000)
  return {
    generatedAt: now,
    days,
    files: Object.keys(c.files).length,
    sources: projectDirs(),
    today,
    week,
    period,
    nightShift,
    window: active
      ? { start: blockStart, end: blockStart + BLOCK_MS, ...block, perMinute: Math.round(total(block) / minutes) }
      : null,
    daily: [...byDay.values()],
    byModel: slices(byModel),
    byProject: slices(byProject).slice(0, 12)
  }
}
