import { useEffect, useRef, useState } from 'react'
import type { RepoBranches } from '../../../shared/types'

interface Props {
  repoPath: string
  baseBranch: string
  label: string // shown before the branch, e.g. the project name
  onChange(branch: string): void
}

// The top-bar chip doubles as a quick base-branch switcher, since it changes every release.
export default function BranchPicker({ repoPath, baseBranch, label, onChange }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [repo, setRepo] = useState<RepoBranches | null>(null)
  const [filter, setFilter] = useState('')
  const [fetching, setFetching] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setFilter('')
    void window.nightShift.listBranches(repoPath).then(setRepo)
    setTimeout(() => inputRef.current?.focus(), 0)
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, repoPath])

  async function fetchBranches(): Promise<void> {
    setFetching(true)
    try {
      setRepo(await window.nightShift.listBranches(repoPath, true))
    } finally {
      setFetching(false)
    }
  }

  function choose(name: string): void {
    setOpen(false)
    if (name !== baseBranch) onChange(name)
  }

  const q = filter.trim().toLowerCase()
  const branches = (repo?.branches ?? []).filter((b) => !q || b.name.toLowerCase().includes(q))
  // Release branches first: they're what the base usually moves between.
  const sorted = [...branches].sort((a, b) => Number(b.name.startsWith('release')) - Number(a.name.startsWith('release')) || Number(b.remote) - Number(a.remote) || a.name.localeCompare(b.name))

  return (
    <div className="branch-picker" ref={ref}>
      <button
        type="button"
        className="project-pill"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}, base branch ${baseBranch || 'not set'}. Change the base branch`}
        title="Change the base branch new ticket branches start from"
        onClick={() => setOpen((o) => !o)}
      >
        <strong>{label}</strong>
        <span className="mono-branch">{baseBranch || 'no base branch'}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="branch-menu" role="dialog" aria-label="Choose base branch">
          <div className="branch-menu-head">
            <input
              ref={inputRef}
              className="issue-menu-filter"
              placeholder="Filter branches…"
              aria-label="Filter branches"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && sorted[0]) choose(sorted[0].name)
              }}
            />
            <button className="btn small" type="button" disabled={!repo?.isRepo || fetching} onClick={() => void fetchBranches()}>
              {fetching ? 'Fetching…' : 'Fetch'}
            </button>
          </div>
          {!repoPath && <div className="issue-menu-empty">Set the repo path in Settings first.</div>}
          {repo && !repo.isRepo && repoPath && <div className="issue-menu-empty">{repo.error}</div>}
          <ul className="issue-menu-list" role="listbox" aria-label="Branches">
            {sorted.map((b) => (
              <li key={b.name} role="option" aria-selected={b.name === baseBranch}>
                <button type="button" className={`issue-menu-item${b.name === baseBranch ? ' active' : ''}`} onClick={() => choose(b.name)}>
                  <span className="lbl mono-lbl">{b.name}</span>
                  {!b.remote && <span className="taken">local only</span>}
                  {b.name === baseBranch && (
                    <svg className="check" width="14" height="14" viewBox="0 0 14 14" aria-label="Current">
                      <path d="M3 7.3 L5.8 10 L11 4.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              </li>
            ))}
            {repo?.isRepo && !sorted.length && <li className="issue-menu-empty">No branches match</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
