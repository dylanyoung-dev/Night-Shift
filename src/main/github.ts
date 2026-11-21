import { execFile } from 'child_process'
import { tmpdir } from 'os'
import type { PrCheck, PrStatus } from '../shared/types'

// Pull request status and merging, through the GitHub CLI (`gh`) and this machine's own login, the
// same way each machine uses its own Linear key. Nothing here stores a GitHub token.

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/
const FRESH_MS = 30_000
const cache = new Map<string, { at: number; status: PrStatus }>()

function gh(args: string[], timeout = 30_000): Promise<string> {
  return new Promise((res, rej) => {
    // Run outside any repo, so gh acts on the PR URL only (and never touches a local checkout).
    execFile('gh', args, { cwd: tmpdir(), timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return res(stdout)
      const msg = (stderr || err.message).trim()
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') rej(new Error('GitHub CLI (gh) is not installed on this machine. Install it and run gh auth login.'))
      else if (/auth login|not logged in|authentication/i.test(msg)) rej(new Error('GitHub CLI is not signed in. Run gh auth login.'))
      else rej(new Error(msg.split('\n')[0]))
    })
  })
}

const FIELDS = `
  number url state isDraft mergeable mergeStateStatus reviewDecision headRefName baseRefName
  autoMergeRequest { enabledAt }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl }
    ... on StatusContext { context state targetUrl }
  } } } } } }`

interface RawPr {
  number: number
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  headRefName: string
  baseRefName: string
  autoMergeRequest: unknown
  commits: { nodes: { commit: { statusCheckRollup: { state: string; contexts: { nodes: Record<string, string | null>[] } } | null } }[] }
}
interface RawRepo {
  squashMergeAllowed: boolean
  mergeCommitAllowed: boolean
  rebaseMergeAllowed: boolean
  pullRequest: RawPr | null
}

function checkOf(n: Record<string, string | null>): PrCheck {
  if (n.__typename === 'CheckRun') {
    const c = (n.conclusion ?? '').toUpperCase()
    const state: PrCheck['state'] =
      (n.status ?? '').toUpperCase() !== 'COMPLETED'
        ? 'pending'
        : c === 'SUCCESS' || c === 'NEUTRAL'
          ? 'success'
          : c === 'SKIPPED'
            ? 'skipped'
            : 'failure' // FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE, STALE
    return { name: n.name ?? 'check', state, url: n.detailsUrl ?? null }
  }
  const s = (n.state ?? '').toUpperCase()
  return { name: n.context ?? 'status', state: s === 'SUCCESS' ? 'success' : s === 'PENDING' || s === 'EXPECTED' ? 'pending' : 'failure', url: n.targetUrl ?? null }
}

function statusOf(repo: RawRepo, p: RawPr): PrStatus {
  const items = (p.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(checkOf)
  const checks: PrStatus['checks']['state'] = items.some((c) => c.state === 'failure')
    ? 'failure'
    : items.some((c) => c.state === 'pending')
      ? 'pending'
      : items.some((c) => c.state === 'success')
        ? 'success'
        : 'none'
  const m = p.mergeStateStatus
  const merge: PrStatus['merge'] =
    p.mergeable === 'CONFLICTING' || m === 'DIRTY'
      ? 'conflicts'
      : m === 'BEHIND'
        ? 'behind'
        : m === 'BLOCKED'
          ? 'blocked'
          : m === 'UNSTABLE'
            ? 'unstable'
            : m === 'CLEAN' || m === 'HAS_HOOKS'
              ? 'clean'
              : 'unknown'
  return {
    url: p.url,
    number: p.number,
    state: p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : p.isDraft ? 'draft' : 'open',
    merge,
    review: p.reviewDecision === 'APPROVED' ? 'approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested' : p.reviewDecision === 'REVIEW_REQUIRED' ? 'review_required' : null,
    checks: { state: checks, items },
    autoMerge: !!p.autoMergeRequest,
    headRef: p.headRefName,
    baseRef: p.baseRefName,
    mergeMethod: repo.squashMergeAllowed ? 'squash' : repo.mergeCommitAllowed ? 'merge' : 'rebase'
  }
}

const lit = (s: string): string => JSON.stringify(s)

// Status of each pull request URL, in one GraphQL call. Results stay fresh for 30 s unless refresh is set.
export async function fetchPrStatuses(urls: string[], refresh = false): Promise<Record<string, PrStatus>> {
  const out: Record<string, PrStatus> = {}
  const wanted: { url: string; owner: string; name: string; number: number }[] = []
  for (const url of new Set(urls)) {
    const m = PR_URL.exec(url)
    if (!m) continue
    const hit = cache.get(url)
    if (hit && !refresh && Date.now() - hit.at < FRESH_MS) out[url] = hit.status
    else wanted.push({ url, owner: m[1], name: m[2], number: Number(m[3]) })
  }
  for (let i = 0; i < wanted.length; i += 40) {
    const batch = wanted.slice(i, i + 40)
    const query = `query {\n${batch
      .map((w, j) => `p${j}: repository(owner: ${lit(w.owner)}, name: ${lit(w.name)}) { squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed pullRequest(number: ${w.number}) { ${FIELDS} } }`)
      .join('\n')}\n}`
    const raw = await gh(['api', 'graphql', '-f', `query=${query}`])
    const data = (JSON.parse(raw) as { data?: Record<string, RawRepo | null> }).data ?? {}
    batch.forEach((w, j) => {
      const repo = data[`p${j}`]
      if (!repo?.pullRequest) return
      const status = statusOf(repo, repo.pullRequest)
      cache.set(w.url, { at: Date.now(), status })
      out[w.url] = status
    })
  }
  if (cache.size > 300) for (const k of [...cache.keys()].slice(0, cache.size - 300)) cache.delete(k)
  return out
}

// Merges with the repo's preferred method and deletes the branch on GitHub. The local branch and
// worktree are left for the "Clean up worktrees" step, so an open editor or a running agent isn't disturbed.
export async function mergePr(url: string): Promise<void> {
  if (!PR_URL.test(url)) throw new Error('Not a GitHub pull request link.')
  const [status] = Object.values(await fetchPrStatuses([url], true))
  if (!status) throw new Error("Couldn't read that pull request from GitHub.")
  if (status.state === 'merged') return
  if (status.state !== 'open') throw new Error(status.state === 'draft' ? 'It is still a draft. Mark it ready for review first.' : 'It is closed.')
  if (status.merge === 'conflicts') throw new Error('It has merge conflicts. Resolve them first.')
  await gh(['pr', 'merge', url, `--${status.mergeMethod}`, '--delete-branch'], 120_000)
  cache.delete(url)
}
