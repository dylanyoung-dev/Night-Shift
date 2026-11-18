import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { globalRunKey, isActiveRun, orderStates, setLabel, type BoardData, type IssueUpdate, type LinearIssue, type Run, type Settings, type StepChoice, type StepsFile } from '../../shared/types'
import Sidebar, { View } from './components/Sidebar'
import Board, { clearRelationsCache } from './components/Board'
import RunPanel from './components/RunPanel'
import LogView from './components/LogView'
import StepsView from './components/StepsView'
import SettingsView from './components/SettingsView'
import ProjectsView from './components/ProjectsView'
import AutomationsView from './components/AutomationsView'
import RunsView from './components/RunsView'
import UsageView from './components/UsageView'
import GlimpsePanel from './components/GlimpsePanel'
import UpdateBanner from './components/UpdateBanner'
import FilterBar, { applyFilters, NO_FILTERS, type Filters } from './components/FilterBar'
import BranchPicker from './components/BranchPicker'

const api = window.nightShift

// Two arrows chasing each other round a circle.
function RefreshIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 6.5A5.5 5.5 0 0 0 3.2 4.6" />
      <path d="M2.5 1.8v3.2h3.2" />
      <path d="M2.5 9.5a5.5 5.5 0 0 0 10.3 1.9" />
      <path d="M13.5 14.2V11h-3.2" />
    </svg>
  )
}

export default function App(): JSX.Element {
  const [view, setView] = useState<View>('board')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [board, setBoard] = useState<BoardData>({ states: [], issues: [], fetchedAt: null })
  const [runs, setRuns] = useState<Run[]>([])
  const [logs, setLogs] = useState<Record<string, string>>({})
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null)
  const [glimpse, setGlimpse] = useState<{ id: string; tab: 'ticket' | 'spec'; at: number } | null>(null) // ticket shown in the Linear panel
  const [message, setMessage] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false) // the refresh button was pressed: the board is locked until Linear answers
  // Skips every cache: the board's, and the relations loaded on cards.
  const reloadBoard = async (): Promise<void> => {
    setReloading(true)
    clearRelationsCache()
    try {
      setBoard(await api.refreshBoard())
    } finally {
      setReloading(false)
    }
  }
  // Log screens opened on top of the current view, newest last. Back goes to the one before,
  // then to the view underneath (board, Agents, Run history…).
  const [logStack, setLogStack] = useState<string[]>([])
  const logRunId = logStack[logStack.length - 1] ?? null
  const setLogRunId = (id: string | null): void =>
    setLogStack((st) => (id === null ? [] : st[st.length - 1] === id ? st : [...st.filter((x) => x !== id), id]))
  const backFromLog = (): void => setLogStack((st) => st.slice(0, -1))
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  // Board swimlanes by a label group (Initiative, Area…). Remembered by group name, per viewer.
  const [groupByName, setGroupByName] = useState<string | null>(() => {
    try {
      return localStorage.getItem('nightshift.groupBy')
    } catch {
      return null
    }
  })
  const groupBy = board.team?.labelGroups?.find((g) => g.name === groupByName)?.id ?? null
  function chooseGroupBy(id: string | null): void {
    const name = board.team?.labelGroups?.find((g) => g.id === id)?.name ?? null
    setGroupByName(name)
    try {
      if (name) localStorage.setItem('nightshift.groupBy', name)
      else localStorage.removeItem('nightshift.groupBy')
    } catch {
      // per-viewer convenience only
    }
  }
  const [steps, setSteps] = useState<StepsFile | null>(null)
  const [startMenu, setStartMenu] = useState(false)
  const [switchingTo, setSwitchingTo] = useState<string | null>(null) // project name while its tickets load
  const columnOrder = settings?.columnOrder ?? []
  const shownBoard = useMemo(
    () => ({ ...board, states: orderStates(board.states, columnOrder), issues: applyFilters(board.issues, filters, board.team) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board, filters, columnOrder.join('|')]
  )
  // Dragging a column header saves the new order (by state name, so it travels with exported settings).
  function reorderColumns(names: string[]): void {
    setSettings((s) => (s ? { ...s, columnOrder: names } : s))
    void api.saveSettings({ columnOrder: names }).then(setSettings)
  }

  // Switching project saves it (so it sticks) and main reloads the board for it.
  async function chooseProject(id: string | null): Promise<void> {
    setLogRunId(null)
    setView('board')
    setSelectedIssue(null)
    if (id === (settings?.activeProjectId ?? null)) return
    setSwitchingTo(id ? settings?.projects.find((p) => p.id === id)?.name ?? 'project' : `team ${settings?.linearTeamKey ?? ''}`)
    setFilters(NO_FILTERS) // labels and people differ between projects
    setSettings(await api.saveSettings({ activeProjectId: id }))
  }

  // Esc closes the run panel (the live log view handles its own Esc first).
  useEffect(() => {
    if (logRunId || !selectedIssue) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelectedIssue(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [logRunId, selectedIssue])
  const logRun = logRunId ? runs.find((r) => r.id === logRunId) ?? null : null
  const [, setTick] = useState(0)

  useEffect(() => {
    void api.getSettings().then((s) => {
      setSettings(s)
      if (!s.hasLinearKey || !s.repoPath) setView('settings')
    })
    void api.getBoard().then(setBoard)
    void api.getRuns().then(setRuns)
    const offSettings = api.onSettings(setSettings) // e.g. an automation switched itself off
    const offOpenRun = api.onOpenRun((runId) => setLogRunId(runId)) // a notification was clicked
    const offBoard = api.onBoard((b) => {
      setBoard(b)
      setSwitchingTo(null)
    })
    const offRuns = api.onRuns((r) => setRuns([...r]))
    const offOut = api.onRunOutput((runId, chunk) =>
      setLogs((prev) => ({ ...prev, [runId]: ((prev[runId] ?? '') + chunk).slice(-20000) }))
    )
    const timer = setInterval(() => setTick((t) => t + 1), 1000) // keeps durations moving
    return () => {
      offBoard()
      offSettings()
      offOpenRun()
      offRuns()
      offOut()
      clearInterval(timer)
    }
  }, [])

  const runningCount = runs.filter((r) => r.status === 'running').length
  const queuedCount = runs.filter((r) => r.status === 'queued').length

  // Latest run per ticket, for the cards.
  const latestRun = useMemo(() => {
    const map = new Map<string, Run>()
    for (const r of runs) if (!map.has(r.issueId)) map.set(r.issueId, r)
    return map
  }, [runs])

  const runsByIssue = useMemo(() => {
    const map = new Map<string, Run[]>()
    for (const r of runs) map.set(r.issueId, [...(map.get(r.issueId) ?? []), r]) // runs come newest first
    return map
  }, [runs])

  const issue = board.issues.find((i) => i.id === selectedIssue) ?? null
  const glimpseIssue = glimpse ? board.issues.find((i) => i.id === glimpse.id) ?? null : null
  const run = selectedIssue ? latestRun.get(selectedIssue) ?? null : null
  const activeRuns = runs.filter((r) => isActiveRun(r.status))
  const needsYou = runs.filter((r) => r.status === 'waiting')

  // Shows the change right away, then main replaces the card with Linear's copy.
  // On failure main has already put Linear's version back; the banner says why.
  async function updateIssue(issueId: string, update: IssueUpdate): Promise<void> {
    setBoard((b) => ({ ...b, issues: b.issues.map((i) => (i.id === issueId ? applyLocally(i, update, b) : i)) }))
    const res = await api.updateIssue(issueId, update)
    if ('error' in res) setMessage(`Couldn't update the ticket. ${res.error}`)
    else setMessage(null)
  }

  // Actions (sets of steps), reloaded after each sync and when leaving the Actions page (edits show at once).
  useEffect(() => {
    if (view !== 'steps') void api.getSteps().then(setSteps)
  }, [board.fetchedAt, view])

  const setsFor = useCallback(
    (stateName: string): StepChoice[] =>
      (steps?.sets ?? [])
        .filter((s) => s.states.some((st) => st.toLowerCase() === stateName.toLowerCase()))
        .map((s) => ({ name: s.name, label: setLabel(s) })),
    [steps]
  )
  const logIssue = logRun ? board.issues.find((i) => i.id === logRun.issueId) ?? null : null

  // Global actions (not tied to a ticket) for the Run menu at the top of the board.
  const globalActions = (steps?.sets ?? []).filter((s) => s.global)
  const startMenuRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!startMenu) return
    const close = (e: MouseEvent | KeyboardEvent): void => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !startMenuRef.current?.contains(e.target as Node)) setStartMenu(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [startMenu])

  async function startGlobal(name: string): Promise<void> {
    setStartMenu(false)
    if (!api.startGlobalRun) return setMessage('Restart Night Shift to run global actions.')
    const res = await api.startGlobalRun(name)
    if ('error' in res) return setMessage(res.error)
    setMessage(null)
    setLogRunId(res.id) // show its log straight away
  }

  async function start(issueId: string, setName?: string): Promise<Run | null> {
    setStartMenu(false)
    const res = await api.startRun(issueId, setName)
    if ('error' in res) {
      setMessage(res.error)
      return null
    }
    setMessage(null)
    setSelectedIssue(issueId)
    return res
  }

  return (
    <div className="app">
      <Sidebar
        view={view}
        onView={(v) => {
          setLogRunId(null)
          setView(v)
        }}
        running={activeRuns.length}
        needsYou={needsYou.length}
        teamKey={settings?.linearTeamKey}
        projects={settings?.projects ?? []}
        linearProjects={board.team?.projects ?? []}
        activeProjectId={settings?.activeProjectId ?? null}
        onProject={(id) => void chooseProject(id)}
        onManageProjects={() => {
          setLogRunId(null)
          setView('projects')
        }}
      />
      {logRun && (
        <LogView
          run={logRun}
          issue={logIssue}
          onClose={backFromLog}
          onStop={(id) => void api.stopRun(id)}
          onOpenLinear={(url) => void api.openInBrowser(url)}
          actions={logIssue ? setsFor(logIssue.stateName) : []}
          // Start the action and follow the new run here.
          onAction={(setName) => logIssue && void start(logIssue.id, setName).then((r) => r && setLogRunId(r.id))}
        />
      )}
      {!logRun && view === 'board' && (
        <>
          <div className="main">
            <header className="topbar">
              {settings && (
                <BranchPicker
                  repoPath={settings.repoPath}
                  baseBranch={settings.baseBranch}
                  label={board.project ? board.project.name : `All of team ${settings.linearTeamKey}`}
                  onChange={(branch) => void api.saveSettings({ baseBranch: branch }).then(setSettings)}
                />
              )}
              {switchingTo && <span className="status">Loading {switchingTo}…</span>}
              {needsYou.length > 0 && (
                <button
                  type="button"
                  className="needs-chip"
                  title={needsYou.map((r) => `${r.identifier}: ${r.waiting?.reason ?? ''}`).join('\n')}
                  onClick={() => setLogRunId(needsYou[0].id)}
                >
                  <span className="pulse" aria-hidden="true" />
                  {needsYou.length === 1 ? `${needsYou[0].identifier} needs you` : `${needsYou.length} runs need you`}
                </button>
              )}
              <span className="status">
                <span className="dot" style={{ background: runningCount ? 'var(--ok)' : 'var(--idle)' }} />
                Local {runningCount} of {settings?.maxConcurrent ?? 0} running{queuedCount ? ` · ${queuedCount} queued` : ''}
              </span>
              <span className="status">
                {board.fetchedAt ? `Synced ${new Date(board.fetchedAt).toLocaleTimeString()}` : 'Not synced yet'}
              </span>
              <div className="right">
                <button
                  className={`btn icon-only${reloading ? ' spinning' : ''}`}
                  type="button"
                  disabled={reloading}
                  aria-label="Reload the board from Linear"
                  title={`Reload the board from Linear${board.fetchedAt ? ` · last synced ${new Date(board.fetchedAt).toLocaleTimeString()}` : ''}`}
                  onClick={() => void reloadBoard()}
                >
                  <RefreshIcon />
                </button>
                <span className="start-run" ref={startMenuRef}>
                  <button
                    className="btn primary"
                    type="button"
                    disabled={!globalActions.length}
                    aria-haspopup="menu"
                    aria-expanded={startMenu}
                    title={
                      globalActions.length
                        ? `Run a global action from ${settings?.baseBranch || 'the base branch'}`
                        : 'No global actions yet. Make one on the Actions page and mark it Global.'
                    }
                    onClick={() => setStartMenu((o) => !o)}
                  >
                    Run action ▾
                  </button>
                  {startMenu && globalActions.length > 0 && (
                    <span className="start-menu" role="menu">
                      <span className="start-menu-note">Global actions · from {settings?.baseBranch || 'the base branch'}</span>
                      {globalActions.map((s) => {
                        const going = runs.find((r) => r.issueId === globalRunKey(s.name) && isActiveRun(r.status))
                        return (
                          <button
                            key={s.name}
                            type="button"
                            role="menuitem"
                            className="issue-menu-item"
                            title={going ? 'Already running. Click to open its log.' : `Run ${s.name}`}
                            onClick={() => (going ? (setStartMenu(false), setLogRunId(going.id)) : void startGlobal(s.name))}
                          >
                            <span className="lbl">{setLabel(s)}</span>
                            {going && <span className="hint">running</span>}
                          </button>
                        )
                      })}
                    </span>
                  )}
                </span>
              </div>
            </header>
            {board.error && <div className="banner">{board.error}</div>}
            {message && <div className="banner">{message}</div>}
            <FilterBar
              filters={filters}
              team={board.team}
              shown={shownBoard.issues.length}
              total={board.issues.length}
              onChange={setFilters}
              groupBy={groupBy}
              onGroupBy={chooseGroupBy}
            />
            <div className="board-area" aria-busy={reloading}>
            <Board
              board={shownBoard}
              latestRun={latestRun}
              runsByIssue={runsByIssue}
              onReorderColumns={reorderColumns}
              onOpenLog={setLogRunId}
              selectedIssue={selectedIssue}
              onSelect={setSelectedIssue}
              onStart={(id, setName) => void start(id, setName)}
              setsFor={setsFor}
              groupBy={groupBy}
              onUpdate={(id, update) => void updateIssue(id, update)}
              onGlimpse={(id, tab) => setGlimpse({ id, tab: tab ?? 'ticket', at: Date.now() })}
            />
            {reloading && (
              <div className="board-lock" role="status">
                <span className="spinner" aria-hidden="true" />
                Reloading from Linear…
              </div>
            )}
            </div>
          </div>
          {(issue || run) && (
          <RunPanel
            issue={issue}
            run={run}
            log={run ? logs[run.id] ?? run.logTail : ''}
            sets={issue ? setsFor(issue.stateName) : []}
            onStart={(id, setName) => void start(id, setName)}
            onStop={(id) => void api.stopRun(id)}
            onOpenLog={setLogRunId}
            onOpenLinear={(url) => void api.openInBrowser(url)}
            onClose={() => setSelectedIssue(null)}
          />
          )}
          {glimpseIssue && glimpse && <GlimpsePanel issue={glimpseIssue} tab={glimpse.tab} tabRequest={glimpse.at} onClose={() => setGlimpse(null)} />}
        </>
      )}
      {!logRun && view === 'agents' && (
        <RunsView
          runs={activeRuns}
          title="Running agents"
          note={`${runningCount} running · ${queuedCount} queued · max ${settings?.maxConcurrent ?? 0} local`}
          empty="Nothing running right now."
          onOpen={(r) => setLogRunId(r.id)}
        />
      )}
      {!logRun && view === 'runs' && (
        <RunsView
          runs={runs}
          onOpen={(r) => setLogRunId(r.id)}
        />
      )}
      {!logRun && view === 'usage' && <UsageView />}
      {!logRun && view === 'steps' && <StepsView settings={settings} states={board.allStates?.length ? board.allStates : board.states} />}
      {!logRun && view === 'settings' && settings && (
        <SettingsView settings={settings} onSaved={setSettings} />
      )}
      {!logRun && view === 'automations' && settings && (
        <AutomationsView
          settings={settings}
          states={board.allStates?.length ? board.allStates : board.states}
          onSaved={setSettings}
        />
      )}
      {!logRun && view === 'projects' && settings && (
        <ProjectsView
          settings={settings}
          linearProjects={board.team?.projects ?? []}
          onSaved={setSettings}
          onShow={(id) => void chooseProject(id)}
        />
      )}
      <UpdateBanner running={runningCount} />
    </div>
  )
}

function applyLocally(issue: LinearIssue, u: IssueUpdate, board: BoardData): LinearIssue {
  const next = { ...issue }
  if (u.stateId !== undefined) {
    const st = (board.allStates ?? board.states).find((s) => s.id === u.stateId)
    if (st) {
      next.stateId = st.id
      next.stateName = st.name
    }
  }
  if (u.priority !== undefined) next.priority = u.priority
  if (u.estimate !== undefined) next.estimate = u.estimate
  if (u.assigneeId !== undefined) next.assignee = board.team?.members.find((m) => m.id === u.assigneeId) ?? null
  if (u.projectMilestoneId !== undefined) {
    const m = board.team?.projects.flatMap((p) => p.milestones).find((x) => x.id === u.projectMilestoneId)
    next.milestone = m ? { id: m.id, name: m.name } : null
  }
  if (u.labelIds !== undefined) {
    const known = new Map([...(board.team?.labels ?? []), ...issue.labels].map((l) => [l.id, l]))
    next.labels = u.labelIds.map((id) => known.get(id)).filter((l): l is NonNullable<typeof l> => Boolean(l))
  }
  return next
}
