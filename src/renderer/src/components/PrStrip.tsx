import { useEffect, useState } from 'react'
import type { LinearPullRequest } from '../../../shared/types'
import { canMerge, mergePullRequest, prProblem, refreshPrs, stopPrChecks, usePrStatus } from '../prStatus'
import { ChecksIcon } from './PrChip'
import { PullRequestIcon } from './LinearIcons'

// The ticket panel's pull requests: one card each with live status and a checks summary. The card opens to
// list failed and running checks (each opens on GitHub) and to confirm a merge, which asks once more.

const METHOD: Record<string, string> = { squash: 'Squash and merge', merge: 'Merge', rebase: 'Rebase and merge' }

// Open or closed per pull request, for as long as the app runs. Unset: open only when something's wrong.
const openRows = new Map<string, boolean>()

function PrRow({ pr, openUrl }: { pr: LinearPullRequest; openUrl(url: string): void }): JSX.Element {
  const { status, error } = usePrStatus(pr.url)
  const [confirm, setConfirm] = useState(false)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [stopNote, setStopNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [, redraw] = useState(0)
  useEffect(() => {
    setConfirm(false)
    setMergeError(null)
    setStopNote(null)
  }, [pr.url])
  // Fresh numbers when the panel opens on this ticket.
  useEffect(() => void refreshPrs([pr.url], true), [pr.url])

  const problem = status ? prProblem(status) : null
  const failing = status?.checks.items.filter((c) => c.state === 'failure') ?? []
  const running = status?.checks.items.filter((c) => c.state === 'pending') ?? []
  const passed = status?.checks.items.filter((c) => c.state === 'success').length ?? 0
  const total = status?.checks.items.length ?? 0
  const open = confirm || (openRows.get(pr.url) ?? problem?.tone === 'bad')
  const toggle = (): void => {
    openRows.set(pr.url, !open)
    if (open) setConfirm(false)
    redraw((n) => n + 1)
  }
  const summary = !status
    ? ''
    : !total
      ? 'No checks'
      : [failing.length && `${failing.length} failed`, running.length && `${running.length} running`, passed && `${passed} passed`].filter(Boolean).join(' · ')

  async function stop(): Promise<void> {
    setStopping(true)
    setStopNote(await stopPrChecks(pr.url))
    setStopping(false)
  }

  async function merge(): Promise<void> {
    setMerging(true)
    setMergeError(null)
    const err = await mergePullRequest(pr.url)
    setMerging(false)
    setConfirm(false)
    setMergeError(err)
  }

  return (
    <div className={`pr-card${open ? ' open' : ''}`}>
      <div className="pr-card-head">
        <button type="button" className="pr-link" onClick={() => openUrl(pr.url)} title="Open on GitHub">
          <PullRequestIcon status={status?.state ?? pr.status} />
          <span className="mono">#{pr.number}</span>
          {status && (
            <span className="pr-branch mono">
              {status.headRef} → {status.baseRef}
            </span>
          )}
        </button>
        {status?.state === 'merged' ? (
          <span className="pr-state merged">Merged</span>
        ) : status?.state === 'closed' ? (
          <span className="pr-state">Closed</span>
        ) : problem ? (
          <span className={`pr-state ${problem.tone}`}>{problem.text}</span>
        ) : status ? (
          <span className="pr-state good">{status.autoMerge ? 'Auto-merge on' : 'Ready to merge'}</span>
        ) : null}
        <span className="spacer" />
        {status && canMerge(status) && !confirm && (
          <button
            className="btn small"
            type="button"
            onClick={() => {
              openRows.set(pr.url, true)
              setConfirm(true)
            }}
            disabled={merging}
          >
            Merge…
          </button>
        )}
        <button type="button" className="pr-toggle" aria-expanded={open} onClick={toggle} title={open ? 'Hide checks' : 'Show checks'}>
          {status && <ChecksIcon state={status.checks.state} />}
          <span>{summary || 'Checks'}</span>
          <svg className="pr-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="pr-card-body">
          {confirm && status && (
            <div className="pr-merge" role="group" aria-label={`Merge pull request #${pr.number}`}>
              <div className="pr-merge-title">
                {METHOD[status.mergeMethod]} #{pr.number} into <span className="mono">{status.baseRef}</span>?
              </div>
              <p className="pr-merge-text">
                GitHub merges it and deletes <span className="mono">{status.headRef}</span>. The local worktree stays until Clean up worktrees runs.
              </p>
              {(status.checks.state === 'failure' || status.checks.state === 'pending') && (
                <p className={`pr-merge-warn${status.checks.state === 'failure' ? ' bad' : ''}`}>
                  {status.checks.state === 'failure'
                    ? `${failing.length} ${failing.length === 1 ? 'check' : 'checks'} failed.`
                    : `${running.length} ${running.length === 1 ? 'check is' : 'checks are'} still running.`}
                </p>
              )}
              <div className="pr-merge-actions">
                {!merging && (
                  <button className="btn small" type="button" onClick={() => setConfirm(false)}>
                    Cancel
                  </button>
                )}
                <button className={`btn small primary${merging ? ' busy' : ''}`} type="button" onClick={() => void merge()} disabled={merging}>
                  {merging && <span className="btn-spin" aria-hidden="true" />}
                  {merging ? 'Merging…' : METHOD[status.mergeMethod]}
                </button>
              </div>
            </div>
          )}
          {(running.length > 0 || stopping) && (
            <div className="pr-stop-row">
              <span className="note">
                {running.length} {running.length === 1 ? 'check' : 'checks'} running
              </span>
              <button
                className={`btn small danger${stopping ? ' busy' : ''}`}
                type="button"
                onClick={() => void stop()}
                disabled={stopping}
                title="Cancel the GitHub Actions runs going on this pull request. Re-run them from GitHub."
              >
                {stopping && <span className="btn-spin" aria-hidden="true" />}
                {stopping ? 'Stopping…' : 'Stop running checks'}
              </button>
            </div>
          )}
          {stopNote && <div className={`note${stopNote.ok ? '' : ' warn'}`}>{stopNote.text}</div>}
          {total > 0 ? (
            <ul className="pr-checklist">
              {[...failing, ...running].map((c) => (
                <li key={c.name}>
                  <ChecksIcon state={c.state === 'failure' ? 'failure' : 'pending'} />
                  {c.url ? (
                    <button type="button" className="pr-link" onClick={() => openUrl(c.url!)} title="Open on GitHub">
                      {c.name}
                    </button>
                  ) : (
                    <span>{c.name}</span>
                  )}
                  <span className="note">{c.state === 'failure' ? 'failed' : 'running'}</span>
                </li>
              ))}
              {passed > 0 && (
                <li className="note">
                  <ChecksIcon state="success" />
                  {passed} passed
                </li>
              )}
            </ul>
          ) : (
            status && <div className="note">GitHub reports no checks for this pull request.</div>
          )}
        </div>
      )}
      {(mergeError || (!status && error)) && <div className="note warn pr-card-err">{mergeError ?? error}</div>}
    </div>
  )
}

export default function PrStrip({ prs, openUrl }: { prs: LinearPullRequest[]; openUrl(url: string): void }): JSX.Element | null {
  if (!prs.length) return null
  return (
    <section className="pr-strip" aria-label="Pull requests">
      {prs.map((pr) => (
        <PrRow key={pr.url} pr={pr} openUrl={openUrl} />
      ))}
    </section>
  )
}
