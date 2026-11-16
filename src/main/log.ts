import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

// The app log: %APPDATA%\night-shift\logs\main.log, rolled over to main.old.log at 5 MB.
// Shaped like electron-updater's logger so the updater can write to it directly.

const MAX = 5 * 1024 * 1024
let file: string | null = null

function path(): string {
  if (!file) {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'main.log')
  }
  return file
}

function write(level: string, args: unknown[]): void {
  const text = args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  const line = `${new Date().toISOString()} [${level}] ${text}\n`
  if (!app.isPackaged) process.stdout.write(line)
  try {
    const p = path()
    try {
      if (statSync(p).size > MAX) renameSync(p, p.replace(/\.log$/, '.old.log'))
    } catch {
      /* no file yet */
    }
    appendFileSync(p, line)
  } catch {
    /* logging must never break the app */
  }
}

export const log = {
  info: (...a: unknown[]): void => write('info', a),
  warn: (...a: unknown[]): void => write('warn', a),
  error: (...a: unknown[]): void => write('error', a),
  debug: (...a: unknown[]): void => write('debug', a)
}

export const logFile = (): string => path()
