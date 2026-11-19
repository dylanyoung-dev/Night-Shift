import { useEffect, useReducer } from 'react'
import type { IssueDetail } from '../../shared/types'

// Ticket details from Linear (description, comments, documents) for the panel's Ticket and Spec tabs.
// Loaded only when one of those tabs is open, then kept here so flipping between cards or tabs is
// instant. Stale-while-revalidate: a cached copy shows at once and is refreshed in the background
// when it's older than a minute, or when the ticket changed on the board (an agent or someone in
// Linear edited it). The board's refresh button clears it all.

const FRESH_MS = 60_000
const MAX_ENTRIES = 60

interface Entry {
  detail?: IssueDetail
  error?: string
  at: number // when detail was fetched
  sig: string // the board's view of the ticket when it was fetched
  pending?: Promise<void>
}

const cache = new Map<string, Entry>()
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((l) => l())

export function clearIssueDetailCache(): void {
  cache.clear()
  notify()
}

function fetchDetail(id: string, sig: string): Promise<void> {
  const prev = cache.get(id)
  if (prev?.pending) return prev.pending
  const pending = (async () => {
    let r: IssueDetail | { error: string }
    try {
      r = window.nightShift.getIssueDetail ? await window.nightShift.getIssueDetail(id) : { error: 'Restart Night Shift to load ticket details.' }
    } catch (err) {
      r = { error: (err as Error).message }
    }
    const cur = cache.get(id)
    if ('error' in r) cache.set(id, { detail: cur?.detail, error: r.error, at: cur?.at ?? 0, sig: cur?.sig ?? '' })
    else {
      cache.delete(id) // re-insert so the newest is last when trimming
      cache.set(id, { detail: r, at: Date.now(), sig })
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string)
    }
    notify()
  })()
  cache.set(id, { ...(prev ?? { at: 0, sig: '' }), pending })
  notify()
  return pending
}

export function useIssueDetail(
  id: string | null,
  sig: string,
  enabled: boolean
): { detail: IssueDetail | null; error: string | null; loading: boolean; reload(): void } {
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    listeners.add(rerender)
    return () => void listeners.delete(rerender)
  }, [])
  useEffect(() => {
    if (!enabled || !id) return
    const e = cache.get(id)
    if (e?.pending) return
    if (!e?.detail || e.sig !== sig || Date.now() - e.at > FRESH_MS) void fetchDetail(id, sig)
  }, [id, sig, enabled])
  const e = id ? cache.get(id) : undefined
  return {
    detail: e?.detail ?? null,
    error: e?.error ?? null,
    loading: !!e?.pending,
    reload: () => void (id && fetchDetail(id, sig))
  }
}

// Already in the cache, without loading anything (for the parent link in the header).
export function cachedIssueDetail(id: string | null): IssueDetail | null {
  return (id && cache.get(id)?.detail) || null
}
