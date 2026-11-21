import type { LinearPullRequest, PrStatus } from '../../../shared/types'
import { prProblem, usePrStatus } from '../prStatus'
import { PullRequestIcon } from './LinearIcons'

// The pull request chip on a card: number, checks, and what (if anything) is holding it up, live from GitHub.

export function ChecksIcon({ state }: { state: PrStatus['checks']['state'] }): JSX.Element | null {
  if (state === 'none') return null
  if (state === 'pending') return <span className="pr-checks pending" aria-label="Checks running" />
  return (
    <svg className={`pr-checks ${state}`} width="12" height="12" viewBox="0 0 12 12" aria-label={state === 'success' ? 'Checks passed' : 'Checks failed'}>
      <circle cx="6" cy="6" r="5.4" fill="currentColor" />
      {state === 'success' ? (
        <path d="M3.6 6.2 L5.3 7.8 L8.4 4.4" fill="none" stroke="var(--panel)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M4.2 4.2 L7.8 7.8 M7.8 4.2 L4.2 7.8" fill="none" stroke="var(--panel)" strokeWidth="1.4" strokeLinecap="round" />
      )}
    </svg>
  )
}

export function prSummary(s: PrStatus): string {
  const failing = s.checks.items.filter((c) => c.state === 'failure').map((c) => c.name)
  const parts = [
    `Pull request #${s.number}: ${s.state}`,
    s.merge === 'conflicts' ? 'merge conflicts' : s.merge === 'behind' ? 'behind the base branch' : s.merge === 'blocked' ? 'blocked by branch protection' : null,
    s.checks.state === 'failure' ? `failed: ${failing.join(', ')}` : s.checks.state === 'pending' ? 'checks running' : s.checks.state === 'success' ? 'checks passed' : null,
    s.review === 'approved' ? 'approved' : s.review === 'changes_requested' ? 'changes requested' : s.review === 'review_required' ? 'needs review' : null
  ]
  return parts.filter(Boolean).join(' · ')
}

export default function PrChip({ pr, onOpen }: { pr: LinearPullRequest; onOpen(e: React.MouseEvent): void }): JSX.Element {
  const { status } = usePrStatus(pr.url)
  const problem = status ? prProblem(status) : null
  return (
    <button
      type="button"
      className={`prop link pr-chip${problem ? ` ${problem.tone}` : ''}`}
      title={`${status ? prSummary(status) : `Pull request #${pr.number} (${pr.status})`} · open on GitHub`}
      onClick={onOpen}
    >
      <PullRequestIcon status={status?.state ?? pr.status} />#{pr.number}
      {status && <ChecksIcon state={status.checks.state} />}
      {problem && <span className="pr-problem">{problem.text}</span>}
    </button>
  )
}
