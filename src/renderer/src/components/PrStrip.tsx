import { useEffect, useState } from 'react'
import type { LinearPullRequest } from '../../../shared/types'
import { canMerge, mergePullRequest, prProblem, refreshPrs, usePrStatus } from '../prStatus'
import { ChecksIcon } from './PrChip'
import { PullRequestIcon } from './LinearIcons'

// The ticket panel's pull request strip: live status, failed or running checks (each opens on GitHub),
// and "Merge and delete branch", which asks once more before it does anything.

const METHOD: Record<string, string> = { squash: 'Squash and merge', merge: 'Merge', rebase: 'Rebase and merge' }

function PrRow({ pr, openUrl }: { pr: LinearPullRequest; openUrl(url: string): void }): JSX.Element {
  const { status, error } = usePrStatus(pr.url)
  const [confirm, setConfirm] = useState(false)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  useEffect(() => {
    setConfirm(false)
    setMergeError(null)
  }, [pr.url])
  // Fresh numbers when the panel opens on this ticket.
  useEffect(() => void refreshPrs([pr.url], true), [pr.url])

  const problem = status ? prProblem(status) : null
  const shown = status?.checks.items.filter((c) => c.state === 'failure' || c.state === 'pending') ?? []
  const passed = status?.checks.items.filter((c) => c.state === 'success').length ?? 0

  async function merge(): Promise<void> {
    setMerging(true)
    setMergeError(null)
    const err = await mergePullRequest(pr.url)
    setMerging(false)
    setConfirm(false)
    setMergeError(err)
  }

  return (
    <div className="pr-row">
      <div className="pr-line">
        <button type="button" className="pr-link" onClick={() => openUrl(pr.url)} title="Open on GitHub">
          <PullRequestIcon status={status?.state ?? pr.status} />
          <span className="mono">#{pr.number}</span>
          {status && <span className="pr-branch mono">{status.headRef} → {status.baseRef}</span>}
        </button>
        {status && <ChecksIcon state={status.checks.state} />}
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
          <button className="btn small" type="button" onClick={() => setConfirm(true)} disabled={merging}>
            Merge…
          </button>
        )}
        {status && confirm && (
          <span className="pr-confirm">
            <button className={`btn small primary${merging ? ' busy' : ''}`} type="button" onClick={() => void merge()} disabled={merging}>
              {merging && <span className="btn-spin" aria-hidden="true" />}
              {merging ? 'Merging…' : `${METHOD[status.mergeMethod]} and delete branch`}
            </button>
            {!merging && (
              <button className="btn small" type="button" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            )}
          </span>
        )}
      </div>
      {confirm && status && !merging && (
        <div className="note">
          Merges into <span className="mono">{status.baseRef}</span> on GitHub and deletes <span className="mono">{status.headRef}</span> there. The local worktree stays until Clean up worktrees runs.
          {status.checks.state === 'failure' && ' Some checks failed.'}
          {status.checks.state === 'pending' && ' Checks are still running.'}
        </div>
      )}
      {shown.length > 0 && (
        <ul className="pr-checklist">
          {shown.map((c) => (
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
          {passed > 0 && <li className="note">{passed} passed</li>}
        </ul>
      )}
      {(mergeError || (!status && error)) && <div className="note warn">{mergeError ?? error}</div>}
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
