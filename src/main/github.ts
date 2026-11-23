import type { PrCheck, PrDraftComment, PrFile, PrFiles, PrLineComment, PrReviewEvent, PrStatus } from '../shared/types'
import { log } from './log'

// Pull request status and merging, with this machine's GitHub token (Settings › GitHub), the same way
// each machine uses its own Linear key. The token is read per call and never stored here.

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/
const FRESH_MS = 30_000
const cache = new Map<string, { at: number; status: PrStatus }>()

const NO_TOKEN = 'Add a GitHub token in Settings › GitHub to see pull request checks and merge from here.'

async function api(token: string | null, method: string, path: string, body?: unknown): Promise<unknown> {
  if (!token) throw new Error(NO_TOKEN)
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'night-shift',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000)
  })
  const text = await res.text()
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!res.ok) log.warn(`github: ${method} ${path} → ${res.status} ${String(json.message ?? res.statusText)} (scopes: ${res.headers.get('x-oauth-scopes') ?? 'n/a'})`)
  if (res.status === 401) throw new Error('GitHub turned down the token. Check it in Settings › GitHub.')
  if (!res.ok) throw new Error(`GitHub: ${String(json.message ?? res.statusText)}`)
  const errors = json.errors as { message: string }[] | undefined
  if (errors?.length && !json.data) throw new Error(`GitHub: ${errors[0].message}`)
  return json
}

// Asked in separate calls, so a token that can read pull requests but not checks still gets the rest.
const FIELDS_FULL = 'number url state isDraft mergeable mergeStateStatus reviewDecision headRefName baseRefName headRefOid autoMergeRequest { enabledAt }'
const FIELDS_MIN = 'number url state isDraft mergeable headRefName baseRefName headRefOid'
const CHECK_FIELDS = `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
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
  headRefOid?: string
  autoMergeRequest?: unknown
  commits?: { nodes: { commit: { statusCheckRollup: { state: string; contexts: { nodes: Record<string, string | null>[] } } | null } }[] }
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

function statusOf(repo: RawRepo, p: RawPr, items: PrCheck[]): PrStatus {
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

let lastToken: string | null = null
let checkRunsRefused = false // set when GitHub refuses REST check runs (fine-grained tokens)
let graphqlChecksRefused = false // set when GitHub refuses checks over GraphQL (fine-grained tokens)
type GqlReply<T> = { data?: Record<string, T | null>; errors?: { message: string; type?: string }[] }
const errText = (e: { message: string; type?: string }[] | undefined): string => (e ?? []).slice(0, 5).map((x) => `${x.type ?? ''} ${x.message}`.trim()).join(' | ')

interface Wanted {
  url: string
  owner: string
  name: string
  number: number
}

async function gql<T>(token: string | null, batch: Wanted[], body: (w: Wanted) => string): Promise<GqlReply<T>> {
  const parts = batch.map((w, j) => `p${j}: repository(owner: ${lit(w.owner)}, name: ${lit(w.name)}) { ${body(w)} }`)
  const query = `query { ${parts.join(' ')} }`
  const reply = (await api(token, 'POST', '/graphql', { query })) as GqlReply<T>
  if (reply.errors?.length) log.warn(`github: graphql: ${errText(reply.errors)}`)
  return reply
}

// Checks for one commit through the REST API: the fallback when GraphQL won't give them. Fine-grained
// tokens can't read check runs at all, so GitHub Actions jobs (Actions: Read) stand in for them, plus
// commit statuses (Commit statuses: Read) from services like Vercel.
async function restChecks(token: string | null, w: Wanted, sha: string): Promise<PrCheck[]> {
  const repo = `/repos/${encodeURIComponent(w.owner)}/${encodeURIComponent(w.name)}`
  const items: PrCheck[] = []
  // Fine-grained tokens can't be given Checks access, so GitHub refuses check runs with a 403. Ask once,
  // then go straight to the Actions and commit status routes (until the token changes or the app restarts).
  const runs = checkRunsRefused
    ? null
    : ((await api(token, 'GET', `${repo}/commits/${sha}/check-runs?per_page=100`).catch((err: Error) => {
        if (/not accessible|forbidden/i.test(err.message)) {
          checkRunsRefused = true
          log.info('github: this token cannot read check runs (normal for fine-grained tokens); using GitHub Actions and commit statuses from now on')
        }
        return null
      })) as { check_runs?: Record<string, string | null>[] } | null)
  for (const c of runs?.check_runs ?? []) items.push(checkOf({ __typename: 'CheckRun', name: c.name, status: (c.status ?? '').toUpperCase(), conclusion: (c.conclusion ?? '').toUpperCase(), detailsUrl: c.details_url ?? c.html_url }))
  let via = `check runs ${items.length}`
  if (!items.length) {
    const wf = (await api(token, 'GET', `${repo}/actions/runs?head_sha=${sha}&per_page=50`).catch(() => null)) as { workflow_runs?: { id: number; name: string; status: string; conclusion: string | null; html_url: string }[] } | null
    for (const run of wf?.workflow_runs ?? []) {
      const jobs = (await api(token, 'GET', `${repo}/actions/runs/${run.id}/jobs?per_page=100`).catch(() => null)) as { jobs?: { name: string; status: string; conclusion: string | null; html_url: string }[] } | null
      const list = jobs?.jobs?.length ? jobs.jobs : [run]
      for (const j of list) items.push(checkOf({ __typename: 'CheckRun', name: j.name, status: j.status.toUpperCase(), conclusion: (j.conclusion ?? '').toUpperCase(), detailsUrl: j.html_url }))
    }
    via += `, actions ${items.length}`
  }
  const before = items.length
  const st = (await api(token, 'GET', `${repo}/commits/${sha}/status`).catch(() => null)) as { statuses?: Record<string, string | null>[] } | null
  for (const c of st?.statuses ?? []) items.push(checkOf({ __typename: 'StatusContext', context: c.context, state: (c.state ?? '').toUpperCase(), targetUrl: c.target_url }))
  log.info(`github: #${w.number} checks via REST: ${via}, statuses ${items.length - before}`)
  return items
}

// Status of each pull request URL. Results stay fresh for 30 s unless refresh is set.
export async function fetchPrStatuses(token: string | null, urls: string[], refresh = false): Promise<{ statuses: Record<string, PrStatus>; error?: string }> {
  // A new token may have more access: ask GitHub for everything again.
  if (token !== lastToken) {
    lastToken = token
    checkRunsRefused = false
    graphqlChecksRefused = false
  }
  const out: Record<string, PrStatus> = {}
  let error: string | undefined
  const wanted: Wanted[] = []
  for (const url of new Set(urls)) {
    const m = PR_URL.exec(url)
    if (!m) continue
    const hit = cache.get(url)
    if (hit && !refresh && Date.now() - hit.at < FRESH_MS) out[url] = hit.status
    else wanted.push({ url, owner: m[1], name: m[2], number: Number(m[3]) })
  }
  for (let i = 0; i < wanted.length; i += 40) {
    const batch = wanted.slice(i, i + 40)
    // 1. The pull requests themselves. If GitHub refuses some fields, ask again with only the basics.
    const repoFields = 'squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed'
    let reply = await gql<RawRepo>(token, batch, (w) => `${repoFields} pullRequest(number: ${w.number}) { ${FIELDS_FULL} }`)
    const got = (r: GqlReply<RawRepo>): number => batch.filter((_w, j) => r.data?.[`p${j}`]?.pullRequest).length
    if (got(reply) < batch.length && reply.errors?.length) {
      const retry = await gql<RawRepo>(token, batch, (w) => `pullRequest(number: ${w.number}) { ${FIELDS_MIN} }`)
      if (got(retry) > got(reply)) reply = retry
    }
    const data = reply.data ?? {}
    const missing = batch.filter((_w, j) => !data[`p${j}`]?.pullRequest)
    log.info(`github: asked for ${batch.length} pull requests, got ${batch.length - missing.length}`)
    if (missing.length) {
      const first = reply.errors?.[0]
      const repoName = `${missing[0].owner}/${missing[0].name}`
      error =
        !first || first.type === 'NOT_FOUND' || /resolve to a Repository/i.test(first.message)
          ? `GitHub won't show ${repoName} to this token. Give the token access to that repository, or use a classic token with the repo scope.`
          : `GitHub: ${first.message}`
    }

    // 2. Their checks, in a separate call; per pull request through REST if GraphQL refuses.
    const found = batch.filter((_w, j) => data[`p${j}`]?.pullRequest)
    const checks = new Map<string, PrCheck[]>()
    if (found.length) {
      const cr = graphqlChecksRefused ? ({} as GqlReply<{ pullRequest: RawPr | null }>) : await gql<{ pullRequest: RawPr | null }>(token, found, (w) => `pullRequest(number: ${w.number}) { ${CHECK_FIELDS} }`).catch((err: Error) => {
        log.warn(`github: checks query failed: ${err.message}`)
        return {} as GqlReply<{ pullRequest: RawPr | null }>
      })
      // A fine-grained token is refused here every time; after the first no, go straight to REST.
      if (cr.errors?.some((e) => e.type === 'FORBIDDEN')) graphqlChecksRefused = true
      for (const [j, w] of found.entries()) {
        const rollup = cr.data?.[`p${j}`]?.pullRequest?.commits?.nodes[0]?.commit.statusCheckRollup
        if (rollup) checks.set(w.url, rollup.contexts.nodes.map(checkOf))
        else {
          const sha = data[`p${batch.indexOf(w)}`]?.pullRequest?.headRefOid
          checks.set(w.url, sha ? await restChecks(token, w, sha) : [])
        }
      }
    }

    batch.forEach((w, j) => {
      const repo = data[`p${j}`]
      if (!repo?.pullRequest) return
      const status = statusOf(repo, repo.pullRequest, checks.get(w.url) ?? [])
      cache.set(w.url, { at: Date.now(), status })
      out[w.url] = status
    })
  }
  if (cache.size > 300) for (const k of [...cache.keys()].slice(0, cache.size - 300)) cache.delete(k)
  return { statuses: out, error }
}

// Merges with the repo's preferred method and deletes the branch on GitHub. The local branch and
// worktree are left for the "Clean up worktrees" step, so an open editor or a running agent isn't disturbed.
export async function mergePr(token: string | null, url: string): Promise<void> {
  const m = PR_URL.exec(url)
  if (!m) throw new Error('Not a GitHub pull request link.')
  const [, owner, name, number] = m
  const got = await fetchPrStatuses(token, [url], true)
  const [status] = Object.values(got.statuses)
  if (!status) throw new Error(got.error ?? "Couldn't read that pull request from GitHub.")
  if (status.state === 'merged') return
  if (status.state !== 'open') throw new Error(status.state === 'draft' ? 'It is still a draft. Mark it ready for review first.' : 'It is closed.')
  if (status.merge === 'conflicts') throw new Error('It has merge conflicts. Resolve them first.')
  const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  await api(token, 'PUT', `${repo}/pulls/${number}/merge`, { merge_method: status.mergeMethod })
  cache.delete(url)
  // Delete the branch, but only when it lives in this repo (not a fork) and isn't the base of anything.
  const pr = (await api(token, 'GET', `${repo}/pulls/${number}`).catch(() => null)) as { head?: { ref?: string; repo?: { full_name?: string } | null } } | null
  const head = pr?.head
  if (head?.ref && head.repo?.full_name?.toLowerCase() === `${owner}/${name}`.toLowerCase()) {
    await api(token, 'DELETE', `${repo}/git/refs/heads/${head.ref.split('/').map(encodeURIComponent).join('/')}`).catch(() => undefined)
  }
}

// Cancels the GitHub Actions workflow runs still going (or queued) on the pull request's latest commit.
// Checks from other apps (Vercel and the like, reported as commit statuses) can't be stopped from here.
// Needs the token's Actions permission set to Read and write.
export async function cancelPrChecks(token: string | null, url: string): Promise<{ cancelled: number; other: number }> {
  const m = PR_URL.exec(url)
  if (!m) throw new Error('Not a GitHub pull request link.')
  const [, owner, name, number] = m
  const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  const pr = (await api(token, 'GET', `${repo}/pulls/${number}`)) as { head?: { sha?: string } }
  const sha = pr.head?.sha
  if (!sha) throw new Error("Couldn't find the pull request's latest commit.")
  const wf = (await api(token, 'GET', `${repo}/actions/runs?head_sha=${sha}&per_page=100`)) as { workflow_runs?: { id: number; status: string }[] }
  const going = (wf.workflow_runs ?? []).filter((r) => r.status !== 'completed')
  let cancelled = 0
  let firstError: string | null = null
  for (const run of going) {
    try {
      await api(token, 'POST', `${repo}/actions/runs/${run.id}/cancel`)
      cancelled++
    } catch (err) {
      firstError ??= (err as Error).message
    }
  }
  if (going.length && !cancelled && firstError) {
    throw new Error(/not accessible|forbidden|403/i.test(firstError) ? "GitHub won't let this token cancel runs. Give it Actions: Read and write in Settings › GitHub." : firstError)
  }
  // Statuses still pending after this come from other apps.
  const st = (await api(token, 'GET', `${repo}/commits/${sha}/status`).catch(() => null)) as { statuses?: { state: string }[] } | null
  const other = (st?.statuses ?? []).filter((s) => s.state === 'pending').length
  cache.delete(url)
  return { cancelled, other }
}

// The pull request's changed files with their diffs, for the Code review tab. GitHub returns up to
// 3000 files, 100 a page; a file whose diff is too big comes back without a patch.
export async function fetchPrFiles(token: string | null, url: string): Promise<PrFiles> {
  const m = PR_URL.exec(url)
  if (!m) throw new Error('Not a GitHub pull request link.')
  const [, owner, name, number] = m
  const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  const pr = (await api(token, 'GET', `${repo}/pulls/${number}`)) as {
    title?: string
    head?: { sha?: string; ref?: string }
    base?: { ref?: string }
    additions?: number
    deletions?: number
    changed_files?: number
    user?: { login?: string }
  }
  type RawFile = { filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string }
  const files: PrFile[] = []
  for (let page = 1; page <= 30; page++) {
    const batch = (await api(token, 'GET', `${repo}/pulls/${number}/files?per_page=100&page=${page}`)) as unknown as RawFile[]
    if (!Array.isArray(batch)) break
    for (const f of batch) {
      files.push({
        path: f.filename,
        ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
        status: (['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged'].includes(f.status) ? f.status : 'modified') as PrFile['status'],
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        ...(typeof f.patch === 'string' ? { patch: f.patch } : {})
      })
    }
    if (batch.length < 100) break
  }
  // Review comments already on the pull request, to show beside their lines.
  type RawComment = { id: number; path: string; side?: string; line?: number | null; start_line?: number | null; body?: string; created_at?: string; user?: { login?: string }; in_reply_to_id?: number }
  const comments: PrLineComment[] = []
  for (let page = 1; page <= 10; page++) {
    const batch = (await api(token, 'GET', `${repo}/pulls/${number}/comments?per_page=100&page=${page}`).catch(() => [])) as unknown as RawComment[]
    if (!Array.isArray(batch)) break
    for (const c of batch) {
      comments.push({
        id: c.id,
        path: c.path,
        side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT',
        line: typeof c.line === 'number' ? c.line : null,
        ...(typeof c.start_line === 'number' ? { startLine: c.start_line } : {}),
        author: c.user?.login ?? '',
        body: c.body ?? '',
        createdAt: c.created_at ?? '',
        ...(c.in_reply_to_id ? { replyTo: c.in_reply_to_id } : {})
      })
    }
    if (batch.length < 100) break
  }
  return {
    url,
    title: pr.title ?? '',
    headSha: pr.head?.sha ?? '',
    headRef: pr.head?.ref ?? '',
    baseRef: pr.base?.ref ?? '',
    author: pr.user?.login ?? '',
    additions: pr.additions ?? files.reduce((n, f) => n + f.additions, 0),
    deletions: pr.deletions ?? files.reduce((n, f) => n + f.deletions, 0),
    changedFiles: pr.changed_files ?? files.length,
    files,
    comments
  }
}

// Submits a review on the pull request: approve, request changes or just comment. Needs the token's
// Pull requests permission set to Read and write. GitHub doesn't let you approve your own pull request.
export async function submitPrReview(token: string | null, url: string, event: PrReviewEvent, body: string, comments: PrDraftComment[] = [], commitId?: string): Promise<void> {
  const m = PR_URL.exec(url)
  if (!m) throw new Error('Not a GitHub pull request link.')
  const [, owner, name, number] = m
  const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  try {
    const lineComments = comments.map((c) => ({
      path: c.path,
      body: c.body,
      side: c.side,
      line: c.line,
      ...(c.startLine && c.startLine !== c.line ? { start_line: c.startLine, start_side: c.startSide ?? c.side } : {})
    }))
    await api(token, 'POST', `${repo}/pulls/${number}/reviews`, {
      event,
      ...(body.trim() ? { body: body.trim() } : {}),
      ...(commitId ? { commit_id: commitId } : {}),
      ...(lineComments.length ? { comments: lineComments } : {})
    })
  } catch (err) {
    const msg = (err as Error).message
    if (/not accessible|forbidden|403/i.test(msg)) throw new Error("GitHub won't let this token review. Give it Pull requests: Read and write in Settings › GitHub.")
    throw err
  }
  cache.delete(url)
}
