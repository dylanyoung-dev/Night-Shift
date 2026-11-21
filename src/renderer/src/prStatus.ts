import { useEffect, useReducer } from 'react'
import type { LinearIssue, PrStatus } from '../../shared/types'

// Live pull request status from GitHub (checks, conflicts, reviews) for the cards and the panel.
// One poller (usePrPolling, in App) refreshes every open PR on the board each minute, when the set of
// PRs changes, and when the window comes back into focus; cards and the panel just read the store.

const POLL_MS = 60_000
let statuses: Record<string, PrStatus> = {}
let error: string | null = null
let loading = false
let boardUrls: string[] = [] // every live PR on the board, kept by the poller
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((l) => l())

function useStore(): void {
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    listeners.add(rerender)
    return () => void listeners.delete(rerender)
  }, [])
}

// PRs worth asking GitHub about: anything Linear doesn't already know is merged or closed.
const live = (issues: LinearIssue[]): string[] =>
  [...new Set(issues.flatMap((i) => i.pullRequests.filter((p) => p.status !== 'merged' && p.status !== 'closed').map((p) => p.url)))].sort()

export async function refreshPrs(urls: string[], force = false): Promise<void> {
  if (!urls.length || !window.nightShift.getPrStatuses) return
  loading = true
  notify()
  try {
    const r = await window.nightShift.getPrStatuses(urls, force)
    statuses = { ...statuses, ...r.statuses }
    error = r.error ?? null
  } catch (err) {
    error = (err as Error).message
  } finally {
    loading = false
    notify()
  }
}

export function usePrPolling(issues: LinearIssue[]): void {
  const key = live(issues).join('\n')
  useEffect(() => {
    const urls = key ? key.split('\n') : []
    boardUrls = urls
    if (!urls.length) return
    void refreshPrs(urls)
    const t = setInterval(() => void refreshPrs(urls), POLL_MS)
    // While GitHub is still working out whether a PR can merge ("unknown"), look again sooner.
    const soon = setInterval(() => {
      const unsure = urls.filter((u) => statuses[u]?.state === 'open' && statuses[u]?.merge === 'unknown')
      if (unsure.length && !loading) void refreshPrs(unsure, true)
    }, 10_000)
    const onFocus = (): void => void refreshPrs(urls)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(t)
      clearInterval(soon)
      window.removeEventListener('focus', onFocus)
    }
  }, [key])
}

export function usePrStatus(url: string | undefined): { status: PrStatus | null; error: string | null; loading: boolean } {
  useStore()
  return { status: url ? statuses[url] ?? null : null, error, loading }
}

export async function mergePullRequest(url: string): Promise<string | null> {
  if (!window.nightShift.mergePr) return 'Restart Night Shift to merge from here.'
  const r = await window.nightShift.mergePr(url)
  await refreshPrs([url], true)
  if ('error' in r) return r.error
  // Merging moves the base branch, so other PRs may now conflict. GitHub works that out in the
  // background (reporting "unknown" for a few seconds), so check them all now and twice more.
  const others = (): string[] => boardUrls.filter((u) => u !== url)
  void refreshPrs(others(), true)
  for (const ms of [8_000, 25_000]) setTimeout(() => void refreshPrs(others(), true), ms)
  return null
}

// One short phrase for what's holding a PR up, or null when it's good to go (or merged/closed).
export function prProblem(s: PrStatus): { text: string; tone: 'bad' | 'wait' } | null {
  if (s.state === 'merged' || s.state === 'closed') return null
  if (s.merge === 'conflicts') return { text: 'Merge conflicts', tone: 'bad' }
  if (s.checks.state === 'failure') {
    const n = s.checks.items.filter((c) => c.state === 'failure').length
    return { text: `${n} ${n === 1 ? 'check' : 'checks'} failed`, tone: 'bad' }
  }
  if (s.review === 'changes_requested') return { text: 'Changes requested', tone: 'bad' }
  if (s.checks.state === 'pending') return { text: 'Checks running', tone: 'wait' }
  if (s.merge === 'behind') return { text: 'Behind base branch', tone: 'wait' }
  if (s.state === 'draft') return { text: 'Draft', tone: 'wait' }
  if (s.review === 'review_required') return { text: 'Needs review', tone: 'wait' }
  if (s.merge === 'blocked') return { text: 'Blocked', tone: 'wait' }
  return null
}

export const canMerge = (s: PrStatus): boolean => s.state === 'open' && (s.merge === 'clean' || s.merge === 'unstable' || s.merge === 'behind')
