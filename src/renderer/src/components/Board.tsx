import { useMemo, useState } from 'react'
import { groupLabel, shortLabel } from './FilterBar'
import { DEFAULT_FAILURE_LABEL, isActiveRun, type BoardData, type IssueUpdate, type LinearIssue, type LinearLabel, type LinearState, type Run, type StepChoice } from '../../../shared/types'
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
  SubIssuesIcon,
  MilestoneIcon
} from './LinearIcons'

interface Props {
  board: BoardData
  latestRun: Map<string, Run>
  runsByIssue: Map<string, Run[]> // every run per ticket, newest first
  onReorderColumns(stateNames: string[]): void // a column header was dragged to a new place
  onOpenLog(runId: string): void
  selectedIssue: string | null
  onSelect(issueId: string): void
  onStart(issueId: string, setName: string): void
  onUpdate(issueId: string, update: IssueUpdate): void
  setsFor(stateName: string): StepChoice[] // the sets of steps (buttons) for a state
  onGlimpse(issueId: string, tab?: 'ticket' | 'spec'): void // show the ticket's details (or its spec) in a side panel
  groupBy?: string | null // label group id (Initiative, Area…): one swimlane per label in it
}

const DRAG_TYPE = 'application/x-nightshift-issue'
const COL_DRAG_TYPE = 'application/x-nightshift-column'
const PER_COLUMN = 60
const OLDER_SHOWN = 4 // earlier runs listed under the latest one on a card
const EXPANDED_KEY = 'nightshift.expandedLanes' // lanes start collapsed; this remembers the opened ones

function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

interface Lane {
  key: string // label id, or '' for tickets without a label in the group
  label: LinearLabel | null
  name: string
  issues: LinearIssue[]
}

// "5m ago", "3h ago", "2d ago"
function ago(t: number): string {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

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
  older,
  selected,
  sets,
  canEstimate,
  onSelect,
  onStart,
  onMenu,
  onOpenLog
}: {
  issue: LinearIssue
  state: LinearState
  progress: number
  run?: Run
  older: Run[] // earlier runs on this ticket, newest first
  selected: boolean
  sets: StepChoice[]
  canEstimate: boolean
  onSelect(): void
  onStart(setName: string): void
  onMenu(mode: MenuMode, at: { x: number; y: number }): void
  onOpenLog(runId: string): void
}): JSX.Element {
  const active = run && isActiveRun(run.status)
  const waiting = run?.status === 'waiting'
  // Red: the last run failed, or Linear still has the failure label on it (e.g. from another install).
  const failed = run?.status === 'failed' || issue.labels.some((l) => l.name.toLowerCase() === DEFAULT_FAILURE_LABEL.toLowerCase())
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
      className={`card${selected ? ' selected' : ''}${waiting ? ' needs-you' : active ? ' running' : failed ? ' failed' : ''}`}
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
        {issue.milestone && (
          <button type="button" className="prop" aria-label={`Milestone: ${issue.milestone.name}. Change`} onClick={menu('milestone')}>
            <MilestoneIcon />
            {issue.milestone.name}
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

      {older.length > 0 && (
        <ul className="run-stack" aria-label={`Earlier runs on ${issue.identifier}`}>
          {older.slice(0, OLDER_SHOWN).map((r) => (
            <li key={r.id}>
              <button type="button" className="run-row" title={`Open the log of ${r.stepsName} (${runLabel[r.status]})`} onClick={stop(() => onOpenLog(r.id))}>
                <span className="dot" style={{ background: runColor[r.status] }} />
                <span className="what">
                  {runLabel[r.status]} · {r.stepsName}
                </span>
                <span className="when">
                  {r.startedAt ? `${duration(r.startedAt, r.endedAt)} · ` : ''}
                  {ago(r.endedAt ?? r.startedAt ?? r.createdAt)}
                </span>
              </button>
            </li>
          ))}
          {older.length > OLDER_SHOWN && <li className="run-more">+{older.length - OLDER_SHOWN} earlier on Run history</li>}
        </ul>
      )}

      <div className="card-foot">
        <span className="created">{createdLabel(issue.createdAt)}</span>
          <button
            className="btn small card-run"
            type="button"
            aria-haspopup="menu"
            title={sets.length ? `Actions for ${issue.identifier}: ${sets.map((s) => s.label).join(', ')}` : `More for ${issue.identifier}`}
            onClick={menu('run')}
          >
            Actions ▾
          </button>
      </div>
    </article>
  )
}

export default function Board({ board, latestRun, runsByIssue, onReorderColumns, onOpenLog, selectedIssue, onSelect, onStart, onUpdate, setsFor, onGlimpse, groupBy }: Props): JSX.Element {
  const [menu, setMenu] = useState<{ issueId: string; mode: MenuMode; at: { x: number; y: number } } | null>(null)
  const [dropState, setDropState] = useState<string | null>(null)
  // Column being dragged by its header, and where it would land.
  const [colDrop, setColDrop] = useState<{ id: string; side: 'before' | 'after' } | null>(null)

  function moveColumn(name: string, targetId: string, side: 'before' | 'after'): void {
    const names = board.states.map((s) => s.name)
    const from = names.indexOf(name)
    const target = board.states.find((s) => s.id === targetId)
    if (from < 0 || !target || target.name === name) return
    names.splice(from, 1)
    const at = names.indexOf(target.name) + (side === 'after' ? 1 : 0)
    names.splice(at, 0, name)
    if (names.join('|') !== board.states.map((s) => s.name).join('|')) onReorderColumns(names)
  }
  const menuIssue = menu ? board.issues.find((i) => i.id === menu.issueId) : undefined
  const progress = useStartedProgress(board.states)
  const group = groupBy ? board.team?.labelGroups?.find((g) => g.id === groupBy) : undefined
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded)

  const sortByState = (issues: LinearIssue[]): Map<string, LinearIssue[]> => {
    const map = new Map<string, LinearIssue[]>()
    for (const i of issues) map.set(i.stateId, [...(map.get(i.stateId) ?? []), i])
    for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)
    return map
  }
  const byState = useMemo(() => sortByState(board.issues), [board.issues])

  // One lane per label in the group (in label-name order), then the tickets without one.
  const lanes = useMemo((): (Lane & { byState: Map<string, LinearIssue[]> })[] | null => {
    if (!group) return null
    const found = new Map<string, { label: LinearLabel | null; issues: LinearIssue[] }>()
    for (const i of board.issues) {
      const l = groupLabel(i, group.id, board.team) ?? null
      const key = l?.id ?? ''
      const lane = found.get(key) ?? { label: l, issues: [] }
      lane.issues.push(i)
      found.set(key, lane)
    }
    const out = [...found.entries()]
      .map(([key, v]) => ({ key, label: v.label, name: v.label ? shortLabel(v.label, group) : `No ${group.name.toLowerCase()}`, issues: v.issues }))
      .sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : a.name.localeCompare(b.name)))
    return out.map((lane) => ({ ...lane, byState: sortByState(lane.issues) }))
  }, [board.issues, board.team, group])

  function toggleLane(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      const id = `${group?.id}:${key}`
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]))
      } catch {
        // per-viewer convenience only
      }
      return next
    })
  }

  // A card dropped on a column (and, when grouped, on a lane): change its status, and move it to
  // that lane's label. Labels in a group are one per ticket, so the old one is swapped out.
  function dropCard(id: string, stateId: string, laneKey?: string): void {
    const moved = board.issues.find((i) => i.id === id)
    if (!moved) return
    const update: IssueUpdate = {}
    if (moved.stateId !== stateId) update.stateId = stateId
    if (group && laneKey !== undefined) {
      const current = groupLabel(moved, group.id, board.team)
      if ((current?.id ?? '') !== laneKey) {
        update.labelIds = [...moved.labels.filter((l) => l.id !== current?.id).map((l) => l.id), ...(laneKey ? [laneKey] : [])]
      }
    }
    if (Object.keys(update).length) onUpdate(id, update)
  }

  // Drag-and-drop on a column: column headers reorder, cards move. `cell` identifies the drop spot.
  function dropEvents(state: LinearState, cell: string, laneKey?: string): React.HTMLAttributes<HTMLElement> {
    return {
      onDragOver: (e) => {
        if (e.dataTransfer.types.includes(COL_DRAG_TYPE)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const r = e.currentTarget.getBoundingClientRect()
          const side = e.clientX < r.left + r.width / 2 ? 'before' : 'after'
          if (colDrop?.id !== state.id || colDrop.side !== side) setColDrop({ id: state.id, side })
          return
        }
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (dropState !== cell) setDropState(cell)
      },
      onDragLeave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setDropState((s) => (s === cell ? null : s))
        setColDrop((c) => (c?.id === state.id ? null : c))
      },
      onDrop: (e) => {
        e.preventDefault()
        setDropState(null)
        const col = e.dataTransfer.getData(COL_DRAG_TYPE)
        if (col) {
          const side = colDrop?.id === state.id ? colDrop.side : 'before'
          setColDrop(null)
          moveColumn(col, state.id, side)
          return
        }
        const id = e.dataTransfer.getData(DRAG_TYPE)
        if (id) dropCard(id, state.id, laneKey)
      }
    }
  }

  const colClass = (state: LinearState, cell: string, extra = ''): string =>
    `col${extra}${dropState === cell ? ' drop' : ''}${colDrop?.id === state.id ? ` col-drop-${colDrop.side}` : ''}`

  function head(state: LinearState, issues: LinearIssue[]): JSX.Element {
    const points = issues.reduce((sum, i) => sum + (i.estimate ?? 0), 0)
    const sets = setsFor(state.name)
    return (
      <div
        className="colhead"
        draggable
        title="Drag to move this column"
        onDragStart={(e) => {
          e.dataTransfer.setData(COL_DRAG_TYPE, state.name)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => setColDrop(null)}
      >
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
          <span className="steps-tag" title={`Actions: ${sets.map((s) => s.label).join(', ')}`}>
            {sets.length === 1 ? '1 action' : `${sets.length} actions`}
          </span>
        )}
      </div>
    )
  }

  function cards(state: LinearState, issues: LinearIssue[]): JSX.Element {
    const sets = setsFor(state.name)
    return (
      <div className="col-cards">
        {issues.slice(0, PER_COLUMN).map((issue) => (
          <Card
            key={issue.id}
            issue={issue}
            state={state}
            progress={progress.get(state.id) ?? 0.5}
            run={latestRun.get(issue.id)}
            older={runsByIssue.get(issue.id)?.slice(1) ?? []}
            selected={selectedIssue === issue.id}
            sets={sets}
            canEstimate={Boolean(board.team?.estimates.length)}
            onSelect={() => onSelect(issue.id)}
            onStart={(setName) => onStart(issue.id, setName)}
            onMenu={(mode, at) => setMenu({ issueId: issue.id, mode, at })}
            onOpenLog={onOpenLog}
          />
        ))}
        {issues.length > PER_COLUMN && <div className="more">+{issues.length - PER_COLUMN} more in Linear</div>}
      </div>
    )
  }

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
    <div className={`board-scroll${lanes ? ' lanes-scroll' : ''}`}>
      {lanes ? (
        <div className="lanes">
          <div className="lane-heads">
            {board.states.map((state) => (
              <section key={state.id} className={colClass(state, `head|${state.id}`, ' lane-colhead')} aria-label={state.name} {...dropEvents(state, `head|${state.id}`)}>
                {head(state, byState.get(state.id) ?? [])}
              </section>
            ))}
          </div>
          {lanes.length === 0 && <div className="empty">No tickets to show.</div>}
          {lanes.map((lane) => {
            const shut = !expanded.has(`${group?.id}:${lane.key}`)
            const points = lane.issues.reduce((sum, i) => sum + (i.estimate ?? 0), 0)
            return (
              <div key={lane.key || 'none'} className={`lane${shut ? ' shut' : ''}`} role="group" aria-label={`${group?.name}: ${lane.name}`}>
                <button type="button" className="lane-head" aria-expanded={!shut} onClick={() => toggleLane(lane.key)} title={lane.label?.name}>
                  <span className="lane-chev" aria-hidden="true">
                    {shut ? '▸' : '▾'}
                  </span>
                  <span className="lane-dot" style={{ background: lane.label?.color ?? 'transparent' }} aria-hidden="true" />
                  <span className={lane.label ? 'lane-name' : 'lane-name none'}>{lane.name}</span>
                  <span className="count">{lane.issues.length}</span>
                  {points > 0 && (
                    <span className="count points" title={`${points} points`}>
                      <EstimateIcon />
                      {points}
                    </span>
                  )}
                </button>
                {!shut && (
                  <div className="lane-row">
                    {board.states.map((state) => {
                      const cell = `${lane.key}|${state.id}`
                      return (
                        <section key={state.id} className={colClass(state, cell, ' lane-cell')} aria-label={`${state.name}, ${lane.name}`} {...dropEvents(state, cell, lane.key)}>
                          {cards(state, lane.byState.get(state.id) ?? [])}
                        </section>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="board">
          {board.states.map((state) => {
            const issues = byState.get(state.id) ?? []
            return (
              <section key={state.id} className={colClass(state, state.id)} aria-label={state.name} {...dropEvents(state, state.id)}>
                {head(state, issues)}
                {cards(state, issues)}
              </section>
            )
          })}
        </div>
      )}
      {menu && menuIssue && (
        <IssueMenu
          issue={menuIssue}
          board={board}
          mode={menu.mode}
          at={menu.at}
          onMode={(mode) => setMenu((m) => (m ? { ...m, mode } : m))}
          onUpdate={(update) => onUpdate(menuIssue.id, update)}
          onClose={() => setMenu(null)}
          runActions={setsFor(menuIssue.stateName)}
          runBlocked={(() => {
            const r = latestRun.get(menuIssue.id)
            return r && isActiveRun(r.status) ? `${menuIssue.identifier} already has a run going.` : undefined
          })()}
          onRun={(setName) => onStart(menuIssue.id, setName)}
          onGlimpse={(tab) => onGlimpse(menuIssue.id, tab)}
        />
      )}
    </div>
  )
}
