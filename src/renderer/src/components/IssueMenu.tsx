import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BoardData, IssueUpdate, LinearIssue, StepChoice } from '../../../shared/types'
import { Avatar, DocIcon, EstimateIcon, GlimpseIcon, MilestoneIcon, PRIORITY_LABEL, PriorityIcon, StatusIcon } from './LinearIcons'

// 'actions' is the right-click menu; 'run' lists the ticket's actions (sets of steps) to start.
export type MenuMode = 'actions' | 'run' | 'status' | 'priority' | 'assignee' | 'labels' | 'estimate' | 'milestone'

interface Props {
  issue: LinearIssue
  board: BoardData
  mode: MenuMode
  at: { x: number; y: number } // viewport position to open at
  onMode(mode: MenuMode): void
  onUpdate(update: IssueUpdate): void
  onClose(): void
  runActions: StepChoice[] // the ticket's actions
  runBlocked?: string // why actions can't start now (e.g. a run is going)
  onRun(setName: string): void
  onGlimpse(tab?: 'ticket' | 'spec'): void // show the ticket's details (or its spec) in a side panel
}

interface Option {
  key: string
  label: string
  icon?: JSX.Element
  checked?: boolean
  sub?: boolean // opens another list (shows the chevron)
  divider?: boolean // horizontal line above it
  note?: boolean // greyed text, not clickable
  run(): void
}

const PRIORITY_ORDER = [0, 1, 2, 3, 4]
const TITLES: Record<MenuMode, string> = {
  actions: 'Change',
  run: 'Run an action',
  status: 'Change status',
  priority: 'Set priority',
  assignee: 'Assign to',
  labels: 'Labels',
  estimate: 'Set estimate',
  milestone: 'Set milestone'
}

function PlayIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3.5 2.2 L9.8 6 L3.5 9.8 Z" fill="currentColor" />
    </svg>
  )
}

// A Linear-style command menu for one card. Every choice is sent to Linear by the caller.
export default function IssueMenu({ issue, board, mode, at, onMode, onUpdate, onClose, runActions, runBlocked, onRun, onGlimpse }: Props): JSX.Element {
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState(at)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const team = board.team
  const states = board.allStates?.length ? board.allStates : board.states
  const labelIds = useMemo(() => new Set(issue.labels.map((l) => l.id)), [issue.labels])

  const project = team?.projects.find((p) => p.id === issue.projectId)

  const options = useMemo<Option[]>(() => {
    // Fixed options at the bottom of the card's Actions dropdown, under a line.
    const statics = (): Option[] => [
      { key: 'glimpse', label: 'Glimpse in Linear', icon: <GlimpseIcon />, divider: true, run: () => (onGlimpse('ticket'), onClose()) },
      ...(issue.hasSpec !== false ? [{ key: 'spec', label: 'View spec', icon: <DocIcon />, run: () => (onGlimpse('spec'), onClose()) }] : [])
    ]
    const pick = (update: IssueUpdate) => () => {
      onUpdate(update)
      onClose()
    }
    switch (mode) {
      case 'run':
        return [
          ...(runBlocked
            ? [{ key: 'blocked', label: runBlocked, note: true, run: () => undefined }]
            : !runActions.length
              ? [{ key: 'none', label: `No actions for ${issue.stateName}`, note: true, run: () => undefined }]
              : runActions.map((a) => ({
              key: a.name,
              label: a.label,
              icon: <PlayIcon />,
              run: () => {
                onRun(a.name)
                onClose()
              }
            }))),
          ...statics()
        ]
      case 'actions':
        return [
          ...(runActions.length ? [{ key: 'run', label: 'Run an action', icon: <PlayIcon />, sub: true, run: () => onMode('run') }] : []),
          { key: 'status', label: 'Status', icon: <StatusIcon state={states.find((s) => s.id === issue.stateId) ?? states[0]} />, sub: true, run: () => onMode('status') },
          { key: 'priority', label: 'Priority', icon: <PriorityIcon priority={issue.priority} />, sub: true, run: () => onMode('priority') },
          { key: 'assignee', label: 'Assignee', icon: <Avatar person={issue.assignee} />, sub: true, run: () => onMode('assignee') },
          { key: 'labels', label: 'Labels', icon: <span className="dot" style={{ background: issue.labels[0]?.color ?? '#6e7681' }} />, sub: true, run: () => onMode('labels') },
          ...(team?.estimates.length ? [{ key: 'estimate', label: 'Estimate', icon: <EstimateIcon />, sub: true, run: () => onMode('estimate') }] : []),
          { key: 'milestone', label: 'Milestone', icon: <MilestoneIcon filled={Boolean(issue.milestone)} />, sub: true, run: () => onMode('milestone') },
          { key: 'linear', label: 'Open in Linear', run: () => (void window.nightShift.openInBrowser(issue.url), onClose()) }
        ]
      case 'milestone':
        if (!project) return [{ key: 'noproject', label: 'Add this ticket to a project in Linear to give it a milestone.', note: true, run: () => undefined }]
        if (!project.milestones.length) return [{ key: 'nomilestones', label: `${project.name} has no milestones yet. Add them in Linear.`, note: true, run: () => undefined }]
        return [
          { key: 'none', label: 'No milestone', icon: <MilestoneIcon filled={false} />, checked: !issue.milestone, run: issue.milestone ? pick({ projectMilestoneId: null }) : onClose },
          ...project.milestones.map((m) => ({
            key: m.id,
            label: m.targetDate ? `${m.name} · ${new Date(`${m.targetDate}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : m.name,
            icon: <MilestoneIcon />,
            checked: m.id === issue.milestone?.id,
            run: m.id === issue.milestone?.id ? onClose : pick({ projectMilestoneId: m.id })
          }))
        ]
      case 'status':
        return states.map((s) => ({
          key: s.id,
          label: s.name,
          icon: <StatusIcon state={s} />,
          checked: s.id === issue.stateId,
          run: s.id === issue.stateId ? onClose : pick({ stateId: s.id })
        }))
      case 'priority':
        return PRIORITY_ORDER.map((p) => ({
          key: String(p),
          label: PRIORITY_LABEL[p],
          icon: <PriorityIcon priority={p} />,
          checked: p === issue.priority,
          run: p === issue.priority ? onClose : pick({ priority: p })
        }))
      case 'assignee':
        return [
          { key: 'none', label: 'No assignee', icon: <Avatar person={null} />, checked: !issue.assignee, run: issue.assignee ? pick({ assigneeId: null }) : onClose },
          ...(team?.members ?? []).map((m) => ({
            key: m.id,
            label: m.name,
            icon: <Avatar person={m} />,
            checked: m.id === issue.assignee?.id,
            run: m.id === issue.assignee?.id ? onClose : pick({ assigneeId: m.id })
          }))
        ]
      case 'labels':
        // Toggles stay open so several labels can be changed in one go, like Linear.
        return (team?.labels ?? []).map((l) => ({
          key: l.id,
          label: l.name,
          icon: <span className="dot" style={{ background: l.color }} />,
          checked: labelIds.has(l.id),
          run: () =>
            onUpdate({
              // A group (Initiative, Area…) holds one label per ticket: picking one swaps out the other.
              labelIds: labelIds.has(l.id)
                ? [...labelIds].filter((id) => id !== l.id)
                : [...[...labelIds].filter((id) => !l.groupId || team?.labels.find((t) => t.id === id)?.groupId !== l.groupId), l.id]
            })
        }))
      case 'estimate':
        return [
          { key: 'none', label: 'No estimate', icon: <EstimateIcon />, checked: issue.estimate == null, run: issue.estimate == null ? onClose : pick({ estimate: null }) },
          ...(team?.estimates ?? []).map((e) => ({
            key: String(e.value),
            label: `${e.label} ${e.label === String(e.value) ? (e.value === 1 ? 'point' : 'points') : ''}`.trim(),
            icon: <EstimateIcon />,
            checked: issue.estimate === e.value,
            run: issue.estimate === e.value ? onClose : pick({ estimate: e.value })
          }))
        ]
    }
  }, [mode, issue, states, team, project, labelIds, onMode, onUpdate, onClose, runActions, runBlocked, onRun, onGlimpse])

  const shown = filter ? options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase())) : options

  useEffect(() => {
    setFilter('')
    setActive(Math.max(0, options.findIndex((o) => o.checked)))
    inputRef.current?.focus()
    // Reset only when the menu switches lists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  useEffect(() => setActive((a) => Math.min(a, Math.max(0, shown.length - 1))), [shown.length])

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8))
    })
  }, [at, mode, shown.length])

  // Close on outside click; keys are captured so Esc closes the menu, not the panel behind it.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        // First Esc clears the filter, the next closes the menu.
        if (filter) setFilter('')
        else onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => (a + 1) % Math.max(1, shown.length))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (a - 1 + shown.length) % Math.max(1, shown.length))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        shown[active]?.run()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose, shown, active, mode, filter])

  // Short lists don't need a filter box.
  const searchable = mode !== 'actions' && !(mode === 'run' && runActions.length <= 6) && !(mode === 'milestone' && (project?.milestones.length ?? 0) <= 6)

  return (
    <div
      ref={ref}
      className="issue-menu"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={`${TITLES[mode]} for ${issue.identifier}`}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="issue-menu-head">
        <span className="mono">{issue.identifier}</span>
        <span>{TITLES[mode]}</span>
      </div>
      {searchable ? (
        <input
          ref={inputRef}
          className="issue-menu-filter"
          placeholder="Type to filter…"
          aria-label="Filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      ) : (
        <input ref={inputRef} className="sr-only" aria-hidden="true" tabIndex={-1} readOnly />
      )}
      <ul className="issue-menu-list" role="listbox" aria-multiselectable={mode === 'labels'}>
        {shown.map((o, i) => (
          <li key={o.key} role="option" aria-selected={o.checked ?? false} aria-disabled={o.note || undefined} className={o.divider && i > 0 ? 'divided' : undefined}>
            {o.note ? (
              <span className="issue-menu-note">{o.label}</span>
            ) : (
            <button
              type="button"
              className={`issue-menu-item${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={o.run}
            >
              <span className="ico">{o.icon}</span>
              <span className="lbl">{o.label}</span>
              {o.sub && <span className="chev" aria-hidden="true">›</span>}
              {o.checked && (
                <svg className="check" width="14" height="14" viewBox="0 0 14 14" aria-label="Current">
                  <path d="M3 7.3 L5.8 10 L11 4.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            )}
          </li>
        ))}
        {!shown.length && (
          <li className="issue-menu-empty">No matches</li>
        )}
      </ul>
      {mode === 'labels' && <div className="issue-menu-foot">Changes save to Linear as you click</div>}
    </div>
  )
}
