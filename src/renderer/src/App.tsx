import { useCallback, useEffect, useMemo, useState } from 'react'
import { isActiveRun, setLabel, type BoardData, type IssueUpdate, type LinearIssue, type Run, type Settings, type StepChoice, type StepsFile } from '../../shared/types'
import Sidebar, { View } from './components/Sidebar'
import Board from './components/Board'
import RunPanel from './components/RunPanel'
import LogView from './components/LogView'
import StepsView from './components/StepsView'
import SettingsView from './components/SettingsView'
import ProjectsView from './components/ProjectsView'
import AutomationsView from './components/AutomationsView'
import RunsView from './components/RunsView'
import FilterBar, { applyFilters, NO_FILTERS, type Filters } from './components/FilterBar'
import BranchPicker from './components/BranchPicker'

const api = window.nightShift

export default function App(): JSX.Element {
  const [view, setView] = useState<View>('board')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [board, setBoard] = useState<BoardData>({ states: [], issues: [], fetchedAt: null })
  const [runs, setRuns] = useState<Run[]>([])
  const [logs, setLogs] = useState<Record<string, string>>({})
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [logRunId, setLogRunId] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [steps, setSteps] = useState<StepsFile | null>(null)
  const [startMenu, setStartMenu] = useState(false)
  const [switchingTo, setSwitchingTo] = useState<string | null>(null) // project name while its tickets load
  const shownBoard = useMemo(() => ({ ...board, issues: applyFilters(board.issues, filters) }), [board, filters])

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

  const issue = board.issues.find((i) => i.id === selectedIssue) ?? null
  const run = selectedIssue ? latestRun.get(selectedIssue) ?? null : null
  const runActive = Boolean(run && isActiveRun(run.status))
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

  // Sets of steps, reloaded after each sync and when leaving the Steps page (edits show at once).
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
  const issueSets = issue ? setsFor(issue.stateName) : []

  async function start(issueId: string, setName?: string): Promise<void> {
    setStartMenu(false)
    const res = await api.startRun(issueId, setName)
    if ('error' in res) setMessage(res.error)
    else {
      setMessage(null)
      setSelectedIssue(issueId)
    }
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
          issue={board.issues.find((i) => i.id === logRun.issueId) ?? null}
          onClose={() => setLogRunId(null)}
          onStop={(id) => void api.stopRun(id)}
          onOpenLinear={(url) => void api.openInBrowser(url)}
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
                <span className="dot" style={{ background: runningCount ? '#3fb950' : '#3a3f4b' }} />
                Local {runningCount} of {settings?.maxConcurrent ?? 0} running{queuedCount ? ` · ${queuedCount} queued` : ''}
              </span>
              <span className="status">
                {board.fetchedAt ? `Synced ${new Date(board.fetchedAt).toLocaleTimeString()}` : 'Not synced yet'}
              </span>
              <div className="right">
                <button className="btn" type="button" onClick={() => void api.refreshBoard()}>
                  Sync Linear
                </button>
                <span className="start-run">
                  <button
                    className="btn primary"
                    type="button"
                    disabled={!issue || runActive || !issueSets.length}
                    aria-haspopup={issueSets.length > 1 ? 'menu' : undefined}
                    aria-expanded={issueSets.length > 1 ? startMenu : undefined}
                    title={!issue ? 'Select a ticket first' : !issueSets.length ? `No steps for ${issue.stateName}` : `Run steps for ${issue.identifier}`}
                    onClick={() => {
                      if (!issue) return
                      if (issueSets.length > 1) setStartMenu((o) => !o)
                      else void start(issue.id, issueSets[0]?.name)
                    }}
                  >
                    {issueSets.length > 1 ? 'Start run ▾' : issueSets[0] ? `Start: ${issueSets[0].label}` : 'Start run'}
                  </button>
                  {startMenu && issue && issueSets.length > 1 && (
                    <span className="start-menu" role="menu">
                      {issueSets.map((s) => (
                        <button key={s.name} type="button" role="menuitem" className="issue-menu-item" onClick={() => void start(issue.id, s.name)}>
                          <span className="lbl">{s.label}</span>
                        </button>
                      ))}
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
            />
            <Board
              board={shownBoard}
              latestRun={latestRun}
              selectedIssue={selectedIssue}
              onSelect={setSelectedIssue}
              onStart={(id, setName) => void start(id, setName)}
              setsFor={setsFor}
              onUpdate={(id, update) => void updateIssue(id, update)}
            />
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
  if (u.labelIds !== undefined) {
    const known = new Map([...(board.team?.labels ?? []), ...issue.labels].map((l) => [l.id, l]))
    next.labels = u.labelIds.map((id) => known.get(id)).filter((l): l is NonNullable<typeof l> => Boolean(l))
  }
  return next
}
