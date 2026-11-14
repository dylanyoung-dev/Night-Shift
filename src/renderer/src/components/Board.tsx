import { useMemo, useState } from 'react'
import { isActiveRun, type BoardData, type IssueUpdate, type LinearIssue, type LinearState, type Run, type StepChoice } from '../../../shared/types'
import IssueMenu, { type MenuMode } from './IssueMenu'
import { duration, runColor, runLabel } from '../util'
import {
  Avatar,
  BlockedIcon,
  EstimateIcon,
  PreviewIcon,
  PRIORITY_LABEL,
  PriorityIcon,
  PullRequestIcon,
  StatusIcon,
  SubIssuesIcon
} from './LinearIcons'

interface Props {
  board: BoardData
  latestRun: Map<string, Run>
  selectedIssue: string | null
  onSelect(issueId: string): void
  onStart(issueId: string, setName: string): void
  onUpdate(issueId: string, update: IssueUpdate): void
  setsFor(stateName: string): StepChoice[] // the sets of steps (buttons) for a state
}

const DRAG_TYPE = 'application/x-nightshift-issue'
const PER_COLUMN = 60

function createdLabel(iso: string): string {
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return `Created ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })}`
}

// Started states fill their pie further the later they come, like Linear.
function useStartedProgress(states: LinearState[]): Map<string, number> {
  return useMemo(() => {
    const started = states.filter((s) => s.type === 'started')
    return new Map(started.map((s, i) => [s.id, (i + 1) / (started.length + 1)]))
  }, [states])
}

function open(url: string): void {
  void window.nightShift.openInBrowser(url)
}

function Card({
  issue,
  state,
  progress,
  run,
  selected,
  sets,
  canEstimate,
  onSelect,
  onStart,
  onMenu
}: {
  issue: LinearIssue
  state: LinearState
  progress: number
  run?: Run
  selected: boolean
  sets: StepChoice[]
  canEstimate: boolean
  onSelect(): void
  onStart(setName: string): void
  onMenu(mode: MenuMode, at: { x: number; y: number }): void
}): JSX.Element {
  const active = run && isActiveRun(run.status)
  const waiting = run?.status === 'waiting'
  const step = run && run.currentStep >= 0 ? run.steps[run.currentStep] : undefined
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  // Opens a menu just under the chip that was clicked.
  const menu = (mode: MenuMode) => (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    onMenu(mode, { x: r.left, y: r.bottom + 4 })
  }

  return (
    <article
      className={`card${selected ? ' selected' : ''}${waiting ? ' needs-you' : ''}`}
      tabIndex={0}
      aria-label={`${issue.identifier} ${issue.title}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, issue.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu('actions', { x: e.clientX, y: e.clientY })
      }}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), onSelect())}
    >
      <div className="card-top">
        <span className="id">{issue.identifier}</span>
        {issue.parent && (
          <span className="parent" title={`${issue.parent.identifier} ${issue.parent.title}`}>
            <span aria-hidden="true">›</span> {issue.parent.title}
          </span>
        )}
        <button
          type="button"
          className="chip-btn avatar-btn"
          aria-label={issue.assignee ? `Assignee: ${issue.assignee.name}. Change` : 'Assign'}
          onClick={menu('assignee')}
        >
          <Avatar person={issue.assignee} />
        </button>
      </div>

      <div className="card-title">
        <button type="button" className="chip-btn status-btn" aria-label={`Status: ${state.name}. Change`} onClick={menu('status')}>
          <StatusIcon state={state} progress={progress} />
        </button>
        <span className="title">{issue.title}</span>
      </div>

      <div className="props">
        <button
          type="button"
          className="prop icon"
          aria-label={`Priority: ${PRIORITY_LABEL[issue.priority] ?? 'No priority'}. Change`}
          onClick={menu('priority')}
        >
          <PriorityIcon priority={issue.priority} />
        </button>
        {issue.blocked && (
          <span className="prop icon">
            <BlockedIcon />
          </span>
        )}
        {issue.estimate != null && (
          <button
            type="button"
            className="prop"
            aria-label={`Estimate: ${issue.estimate}. Change`}
            disabled={!canEstimate}
            onClick={menu('estimate')}
          >
            <EstimateIcon />
            {issue.estimate}
          </button>
        )}
        {issue.labels.map((l) => (
          <button key={l.id} type="button" className="prop" aria-label={`Label: ${l.name}. Change labels`} onClick={menu('labels')}>
            <span className="dot" style={{ background: l.color }} aria-hidden="true" />
            {l.name}
          </button>
        ))}
        {issue.pullRequests.map((pr) => (
          <button
            key={pr.url}
            type="button"
            className="prop link"
            title={`Pull request #${pr.number} (${pr.status}) · open on GitHub`}
            onClick={stop(() => open(pr.url))}
          >
            <PullRequestIcon status={pr.status} />#{pr.number}
          </button>
        ))}
        {issue.previewUrl && (
          <button type="button" className="prop link" title="Open deploy preview" onClick={stop(() => open(issue.previewUrl!))}>
            <PreviewIcon />
            Preview
          </button>
        )}
        {issue.subIssues && (
          <span className="prop" title={`${issue.subIssues.done} of ${issue.subIssues.total} sub-issues done`}>
            <SubIssuesIcon done={issue.subIssues.done} total={issue.subIssues.total} />
            {issue.subIssues.done}/{issue.subIssues.total}
          </span>
        )}
      </div>

      {run && (
        <div className={`agent${waiting ? ' waiting' : ''}`}>
          <span className="line">
            <span className="dot" style={{ background: runColor[run.status] }} />
            {runLabel[run.status]} · {run.stepsName} · Local
            {run.startedAt ? ` · ${duration(run.startedAt, run.endedAt)}` : ''}
          </span>
          {step && (
            <span className="mono">
              Step {run.currentStep + 1} of {run.steps.length} · {step.name}
            </span>
          )}
          {waiting && run.waiting && <span className="needs-reason">{run.waiting.reason}</span>}
        </div>
      )}

      <div className="card-foot">
        <span className="created">{createdLabel(issue.createdAt)}</span>
        {!active && sets.length > 0 && (
          <span className="card-runs">
            {sets.map((s) => (
              <button key={s.name} className="btn small card-run" type="button" title={`Run "${s.name}" for ${issue.identifier}`} onClick={stop(() => onStart(s.name))}>
                {s.label}
              </button>
            ))}
          </span>
        )}
      </div>
    </article>
  )
}

export default function Board({ board, latestRun, selectedIssue, onSelect, onStart, onUpdate, setsFor }: Props): JSX.Element {
  const [menu, setMenu] = useState<{ issueId: string; mode: MenuMode; at: { x: number; y: number } } | null>(null)
  const [dropState, setDropState] = useState<string | null>(null)
  const menuIssue = menu ? board.issues.find((i) => i.id === menu.issueId) : undefined
  const progress = useStartedProgress(board.states)

  const byState = useMemo(() => {
    const map = new Map<string, LinearIssue[]>()
    for (const i of board.issues) map.set(i.stateId, [...(map.get(i.stateId) ?? []), i])
    for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)
    return map
  }, [board.issues])

  if (!board.states.length) {
    return (
      <div className="board-scroll">
        <div className="board">
          <div className="empty">No Linear states loaded yet.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="board-scroll">
      <div className="board">
        {board.states.map((state) => {
          const issues = byState.get(state.id) ?? []
          const points = issues.reduce((sum, i) => sum + (i.estimate ?? 0), 0)
          const sets = setsFor(state.name)
          return (
            <section
              key={state.id}
              className={`col${dropState === state.id ? ' drop' : ''}`}
              aria-label={state.name}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (dropState !== state.id) setDropState(state.id)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropState((s) => (s === state.id ? null : s))
              }}
              onDrop={(e) => {
                e.preventDefault()
                setDropState(null)
                const id = e.dataTransfer.getData(DRAG_TYPE)
                const moved = board.issues.find((i) => i.id === id)
                if (moved && moved.stateId !== state.id) onUpdate(id, { stateId: state.id })
              }}
            >
              <div className="colhead">
                <StatusIcon state={state} progress={progress.get(state.id)} />
                <span className="name">{state.name}</span>
                <span className="count">{issues.length}</span>
                {points > 0 && (
                  <span className="count points" title={`${points} points`}>
                    <EstimateIcon />
                    {points}
                  </span>
                )}
                {sets.length > 0 && (
                  <span className="steps-tag" title={`Steps: ${sets.map((s) => s.label).join(', ')}`}>
                    {sets.length === 1 ? 'Steps' : `${sets.length} steps`}
                  </span>
                )}
              </div>
              <div className="col-cards">
                {issues.slice(0, PER_COLUMN).map((issue) => (
                  <Card
                    key={issue.id}
                    issue={issue}
                    state={state}
                    progress={progress.get(state.id) ?? 0.5}
                    run={latestRun.get(issue.id)}
                    selected={selectedIssue === issue.id}
                    sets={sets}
                    canEstimate={Boolean(board.team?.estimates.length)}
                    onSelect={() => onSelect(issue.id)}
                    onStart={(setName) => onStart(issue.id, setName)}
                    onMenu={(mode, at) => setMenu({ issueId: issue.id, mode, at })}
                  />
                ))}
                {issues.length > PER_COLUMN && <div className="more">+{issues.length - PER_COLUMN} more in Linear</div>}
              </div>
            </section>
          )
        })}
      </div>
      {menu && menuIssue && (
        <IssueMenu
          issue={menuIssue}
          board={board}
          mode={menu.mode}
          at={menu.at}
          onMode={(mode) => setMenu((m) => (m ? { ...m, mode } : m))}
          onUpdate={(update) => onUpdate(menuIssue.id, update)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
