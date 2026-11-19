import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'
import { log } from './log'

// Auto-update from the Cloudflare R2 feed baked into the build (app-update.yml, generic provider).
// Packaged builds only: checks on launch and every 6 hours, downloads in the background, and
// installs when the app quits unless the person restarts sooner from the banner.

const EVERY = 6 * 3600_000
let state: UpdateState = { status: 'idle', version: app.getVersion() }
let notify: (s: UpdateState) => void = () => undefined

function set(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  notify(state)
}

export function updateState(): UpdateState {
  return state
}

function check(): void {
  // Offline or the feed is down: log it and try again next time. Never a dialog.
  autoUpdater.checkForUpdates().catch((err: Error) => log.warn(`updater: check failed: ${err.message}`))
}

export function startUpdater(onChange: (s: UpdateState) => void): void {
  notify = onChange
  if (!app.isPackaged) {
    set({ status: 'dev' })
    log.info('updater: development build, not checking for updates')
    return
  }
  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true // ignored banner: install on the next quit
  autoUpdater.disableWebInstaller = true // only full NSIS installers are published
  // Testing only: point an installed build at another feed (see docs/releasing.md).
  const testFeed = process.env.NIGHTSHIFT_UPDATE_URL
  if (testFeed) {
    log.warn(`updater: using test feed ${testFeed}`)
    autoUpdater.setFeedURL({ provider: 'generic', url: testFeed, useMultipleRangeRequest: false })
  }

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }))
  autoUpdater.on('update-not-available', () => set({ status: 'idle', checkedAt: Date.now() }))
  autoUpdater.on('update-available', (info) => {
    log.info(`updater: ${info.version} available, downloading`)
    set({ status: 'downloading', available: info.version, percent: 0 })
  })
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`updater: ${info.version} downloaded, ready to install`)
    set({ status: 'ready', available: info.version, percent: 100 })
  })
  autoUpdater.on('error', (err) => {
    log.warn(`updater: ${err?.message ?? err}`)
    // Keep a finished download installable even if a later check fails.
    if (state.status !== 'ready') set({ status: 'error', error: err?.message ?? String(err) })
  })

  log.info(`updater: Night Shift ${app.getVersion()}, checking now and every 6 hours`)
  check()
  setInterval(check, EVERY)
}

// The About page's "Check for updates" button. Returns at once; progress comes through the state.
export function checkForUpdatesNow(): UpdateState {
  if (!app.isPackaged) return state // development builds don't update
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return state
  log.info('updater: checking now (asked from About)')
  set({ status: 'checking', error: undefined })
  check()
  return state
}

export function installUpdateNow(): void {
  if (state.status !== 'ready') return
  log.info(`updater: restarting to install ${state.available}`)
  // Silent install (one-click NSIS), then start the new version.
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
}
