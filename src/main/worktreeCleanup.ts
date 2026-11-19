import { execFile } from 'child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { rm } from 'fs/promises'
import { basename, dirname, join, normalize, resolve } from 'path'

// The "Clean up worktrees" step: removes the worktrees of tickets that are done or canceled in Linear.
//
// `git worktree remove` fails on Windows when node_modules goes past the 260-character path limit
// ("Filename too long"), and it may unregister the worktree before failing, leaving the folder behind.
// So this asks git with core.longpaths on, then deletes whatever is left with Node (whose fs calls use
// \\?\ long paths on Windows), then prunes. Folders git no longer knows about, but that sit where
// worktrees live and are named after a ticket, are cleaned up too.
//
// It never touches: the main checkout, a ticket with a run going, a worktree with uncommitted
// changes, or a ticket Linear doesn't know. A branch is deleted only when its commits are on the
// remote; otherwise it's kept and listed.

export interface CleanupDeps {
  repo: string
  worktreeParents: string[] // extra folders where worktrees are created (from the worktree path setting)
  teamKeys: string[] // Linear team keys (IGN): only folders and branches named after one of their tickets count
  ticketStates(identifiers: string[]): Promise<Map<string, { name: string; type: string }>>
  isBusy(identifier: string): boolean
  log(text: string): void
}

const DONE_TYPES = new Set(['completed', 'canceled'])

function git(cwd: string, args: string[], timeout = 60000): Promise<string> {
  return new Promise((res, rej) => {
    execFile('git', ['-c', 'core.longpaths=true', ...args], { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) rej(new Error((stderr || err.message).trim()))
      else res(stdout)
    })
  })
}

// Compares real paths: Windows can name one folder two ways (C:\Users\DYLANY~1 and C:\Users\DylanYoung),
// and git prints forward slashes.
function canon(p: string): string {
  try {
    return realpathSync.native(p).toLowerCase()
  } catch {
    return normalize(resolve(p)).toLowerCase()
  }
}
const same = (a: string, b: string): boolean => canon(a) === canon(b)

// A folder whose .git file points at worktree metadata that still exists is a live worktree, whatever
// git's list said. Leftovers are only folders with no .git, or one pointing at metadata that's gone.
function liveWorktree(path: string): boolean {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(path, '.git'), 'utf8'))
    return !!m && existsSync(resolve(path, m[1].trim()))
  } catch {
    return false
  }
}

interface Candidate {
  path: string
  branch?: string
  registered: boolean
  ticket: string
}

export async function cleanupWorktrees(d: CleanupDeps): Promise<boolean> {
  const { repo, log } = d
  if (!repo || !existsSync(repo)) {
    log('No repo folder set in Settings.\n')
    return false
  }

  // Registered worktrees (the first entry is the main checkout).
  const porcelain = await git(repo, ['worktree', 'list', '--porcelain'])
  const registered: { path: string; branch?: string }[] = []
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (!path) continue
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
    registered.push({ path: normalize(path), branch })
  }
  const main = registered[0]?.path ?? repo
  const others = registered.filter((w) => !same(w.path, main))

  // Folders where worktrees live: next to registered ones, the configured location, and Claude's own.
  const parents = new Set<string>()
  for (const w of others) parents.add(dirname(w.path))
  for (const p of d.worktreeParents) parents.add(normalize(p))
  parents.add(join(repo, '.claude', 'worktrees'))

  const keys = d.teamKeys.map((k) => k.trim()).filter((k) => /^[A-Za-z0-9]+$/.test(k))
  if (!keys.length) {
    log('No Linear team key set in Settings.\n')
    return false
  }
  // ign-706, aup-ign-706, feature/ign-706: the key and number as a whole word.
  const ticketRe = new RegExp(`(?:^|[^A-Za-z0-9])(${keys.join('|')})-([0-9]+)(?![0-9])`, 'i')
  const candidates: Candidate[] = []
  const ticketOf = (...names: (string | undefined)[]): string | undefined => {
    for (const n of names) {
      const m = n ? ticketRe.exec(n) : null
      if (m) return `${m[1]}-${m[2]}`.toUpperCase()
    }
    return undefined
  }
  for (const w of others) {
    const ticket = ticketOf(basename(w.path), w.branch)
    if (ticket) candidates.push({ path: w.path, branch: w.branch, registered: true, ticket })
  }
  for (const parent of parents) {
    if (!existsSync(parent) || same(parent, repo)) continue
    let names: string[] = []
    try {
      names = readdirSync(parent)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(parent, name)
      if (same(path, main) || candidates.some((c) => same(c.path, path))) continue
      // Only folders that look like a worktree's leftovers: named after a ticket, with a .git file or nothing git-like at all.
      const ticket = ticketOf(name)
      try {
        if (!ticket || !statSync(path).isDirectory()) continue
      } catch {
        continue
      }
      if (existsSync(join(path, '.git')) && statSync(join(path, '.git')).isDirectory()) continue // a real clone, not a worktree
      if (liveWorktree(path)) continue // registered after all (git listed it under another spelling)
      candidates.push({ path, registered: false, ticket })
    }
  }

  if (!candidates.length) {
    log('No ticket worktrees found.\n')
    return true
  }
  log(`Found ${candidates.length} ticket ${candidates.length === 1 ? 'worktree' : 'worktrees'}. Checking their tickets in Linear…\n`)
  const states = await d.ticketStates([...new Set(candidates.map((c) => c.ticket))])

  let removed = 0
  let failed = 0
  const keptBranches: string[] = []
  for (const c of candidates) {
    const st = states.get(c.ticket)
    const label = `${c.ticket} (${c.path})`
    if (!st) {
      log(`  · ${label}: not found in Linear, kept\n`)
      continue
    }
    if (!DONE_TYPES.has(st.type)) continue // still open: nothing to say
    if (d.isBusy(c.ticket)) {
      log(`  · ${label}: ${st.name}, but a run is going, kept\n`)
      continue
    }
    if (c.registered && existsSync(c.path)) {
      const dirty = (await git(c.path, ['status', '--porcelain']).catch(() => '')).trim()
      if (dirty) {
        log(`  · ${label}: ${st.name}, but it has uncommitted changes, kept\n`)
        continue
      }
    }

    log(`  ✓ ${label}: ${st.name}, removing…\n`)
    if (c.registered) await git(repo, ['worktree', 'remove', '--force', c.path]).catch((err: Error) => log(`    git couldn't remove it all (${err.message.split('\n')[0]}); deleting the rest directly\n`))
    if (existsSync(c.path)) {
      try {
        await rm(c.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
      } catch (err) {
        failed++
        log(`    ✗ couldn't delete the folder: ${(err as Error).message}. Close any editor or terminal open in it and run this again.\n`)
        continue
      }
    }
    removed++

    if (c.branch) {
      const onRemote = (await git(repo, ['branch', '-r', '--contains', c.branch]).catch(() => '')).trim()
      if (onRemote) {
        await git(repo, ['branch', '-D', c.branch])
          .then(() => log(`    deleted branch ${c.branch} (its commits are on the remote)\n`))
          .catch((err: Error) => log(`    kept branch ${c.branch}: ${err.message.split('\n')[0]}\n`))
      } else keptBranches.push(c.branch)
    }
  }
  await git(repo, ['worktree', 'prune']).catch(() => undefined)

  log(`\nRemoved ${removed} ${removed === 1 ? 'worktree' : 'worktrees'}${failed ? `, ${failed} couldn't be deleted` : ''}.\n`)
  if (keptBranches.length) {
    log(`Kept ${keptBranches.length} local ${keptBranches.length === 1 ? 'branch' : 'branches'} whose commits aren't on the remote (squash-merged or never pushed): ${keptBranches.join(', ')}. Delete them with git branch -D when you're sure.\n`)
  }
  return failed === 0
}
