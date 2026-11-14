import { execFile } from 'child_process'
import { existsSync } from 'fs'
import type { RepoBranches } from '../shared/types'

function git(cwd: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout)
    })
  })
}

// Lists branches a worktree can start from. Remote branches come first because the
// default steps branch off origin/$BASE; local-only branches are listed after them.
export async function listBranches(repoPath: string, fetch = false): Promise<RepoBranches> {
  if (!repoPath.trim()) return { isRepo: false, branches: [], error: 'Pick the repo folder first.' }
  // Checked first: a missing cwd makes Windows report the same ENOENT as a missing git.
  if (!existsSync(repoPath)) return { isRepo: false, branches: [], error: "That folder doesn't exist." }
  try {
    const top = (await git(repoPath, ['rev-parse', '--show-toplevel'])).trim()
    if (fetch) await git(repoPath, ['fetch', '--prune', 'origin'], 60000)
    const refs = (await git(repoPath, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin', 'refs/heads']))
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)
    const remote: string[] = []
    const local: string[] = []
    for (const ref of refs) {
      if (ref.startsWith('refs/remotes/origin/')) {
        const name = ref.slice('refs/remotes/origin/'.length)
        if (name !== 'HEAD') remote.push(name)
      } else if (ref.startsWith('refs/heads/')) {
        local.push(ref.slice('refs/heads/'.length))
      }
    }
    const remoteSet = new Set(remote)
    const current = (await git(repoPath, ['branch', '--show-current']).catch(() => '')).trim() || undefined
    return {
      isRepo: true,
      root: top,
      current,
      branches: [
        ...remote.sort().map((name) => ({ name, remote: true })),
        ...local.filter((n) => !remoteSet.has(n)).sort().map((name) => ({ name, remote: false }))
      ]
    }
  } catch (err) {
    const msg = (err as Error).message
    if (/not a git repository/i.test(msg)) return { isRepo: false, branches: [], error: 'That folder is not a git repository.' }
    if (/ENOENT/.test(msg)) return { isRepo: false, branches: [], error: "Couldn't run git. Is it installed and on PATH?" }
    return { isRepo: false, branches: [], error: msg }
  }
}
