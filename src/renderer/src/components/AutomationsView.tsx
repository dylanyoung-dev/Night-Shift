import { useEffect, useMemo, useState } from 'react'
import type { Automation, AutomationStatus, LinearState, Settings, StepsFile } from '../../../shared/types'
import { StatusIcon } from './LinearIcons'
import ConflictBanner from './ConflictBanner'
import SaveStatus from './SaveStatus'

interface Props {
  settings: Settings
  states: LinearState[] // every team state
  onSaved(s: Settings): void
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const EVERY = [5, 10, 15, 30, 60, 120, 240, 480, 720, 1440]

function everyLabel(m: number): string {
  if (m < 60) return `${m} minutes`
  if (m === 60) return '1 hour'
  if (m < 1440) return `${m / 60} hours`
  return m === 1440 ? '1 day' : `${m / 1440} days`
}

function time12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`
}

function when(a: Automation): string {
  const hours = a.window ? `${time12(a.window.start)} to ${time12(a.window.end)}` : 'any time'
  const days = a.days.length && a.days.length < 7 ? ` · ${a.days.map((d) => DAYS[d]).join(', ')}` : ''
  return (a.mode === 'schedule' ? `Every ${everyLabel(a.everyMinutes)}` : 'Watching') + ` · ${hours}${days}`
}

function ago(t?: number): string {
  if (!t) return 'never'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(t).toLocaleString()
}

function newAutomation(name: string): Automation {
  return {
    id: crypto.randomUUID(),
    name,
    enabled: false, // nothing runs until it's switched on
    mode: 'watch',
    projectId: null,
    states: [],
    stepSet: null,
    runner: 'local',
    days: [],
    window: null,
    everyMinutes: 60,
    ticketsPerRun: 1,
    onlyIfTickets: true,
    maxRuns: null,
    perTicket: 'perArrival',
    cooldownHours: 12,
    maxActive: 1
  }
}

const copy = (list: Automation[]): Automation[] => JSON.parse(JSON.stringify(list)) as Automation[]

export default function AutomationsView({ settings, states, onSaved }: Props): JSX.Element {
  const [list, setList] = useState<Automation[]>(() => copy(settings.automations))
  const [baseRevs, setBaseRevs] = useState(settings.sharedRevs) // revisions of what's being edited
  const [conflict, setConflict] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, AutomationStatus>>({})
  const [steps, setSteps] = useState<StepsFile | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [, setTick] = useState(0)

  useEffect(() => {
    void window.nightShift.getAutomationStatus().then(setStatus)
    void window.nightShift.getSteps().then(setSteps)
    const off = window.nightShift.onAutomationStatus(setStatus)
    const t = setInterval(() => setTick((n) => n + 1), 15_000) // keeps "5 min ago" fresh
    return () => {
      off()
      clearInterval(t)
    }
  }, [])

  // Main may switch an automation off (it finished its runs); pick that up if nothing is being edited.
  useEffect(() => {
    if (!dirty) {
      setList(copy(settings.automations))
      setBaseRevs(settings.sharedRevs)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.automations])

  useEffect(() => setConfirmDelete(false), [selected])

  const current = list[selected] as Automation | undefined
  const st = current ? status[current.id] : undefined
  const saved = current ? settings.automations.find((a) => a.id === current.id) : undefined

  const isGlobal = current?.kind === 'global'
  const globalNames = (steps?.sets ?? []).filter((s) => s.global).map((s) => s.name)

  // The sets of steps on each state; states without one can't be picked.
  const setsByState = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const set of steps?.sets ?? []) for (const s of set.global ? [] : set.states) m.set(s.toLowerCase(), [...(m.get(s.toLowerCase()) ?? []), set.name])
    return m
  }, [steps])
  // Sets covering the chosen states; a choice only matters when a state has more than one.
  const chosenSets = current ? [...new Set(current.states.flatMap((s) => setsByState.get(s.toLowerCase()) ?? []))] : []
  const needsSetChoice = current ? current.states.some((s) => (setsByState.get(s.toLowerCase()) ?? []).length > 1) : false

  function change(patch: Partial<Automation>): void {
    setList((prev) => prev.map((a, i) => (i === selected ? { ...a, ...patch } : a)))
    setDirty(true)
    setMessage(null)
  }

  function add(): void {
    let name = 'New automation'
    for (let n = 2; list.some((a) => a.name === name); n++) name = `New automation ${n}`
    setList((prev) => [...prev, newAutomation(name)])
    setSelected(list.length)
    setDirty(true)
  }

  function remove(): void {
    if (!confirmDelete) return setConfirmDelete(true)
    setList((prev) => prev.filter((_, i) => i !== selected))
    setSelected((i) => Math.max(0, i - 1))
    setDirty(true)
    setConfirmDelete(false)
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const s = await window.nightShift.saveSettings({ automations: list, sharedRevs: baseRevs })
      onSaved(s)
      if (s.saveError) {
        setConflict(s.saveError.message)
        return
      }
      setConflict(null)
      setBaseRevs(s.sharedRevs)
      setList(copy(s.automations))
      setDirty(false)
      setMessage('Saved')
    } finally {
      setSaving(false)
    }
  }

  async function runNow(): Promise<void> {
    if (!current) return
    setMessage('Checking…')
    const res = await window.nightShift.runAutomationNow(current.id)
    setMessage('error' in res ? res.error : res.message)
  }

  const nextText = (): string => {
    if (!current || !saved) return 'Save it first.'
    if (!saved.enabled) return 'Off'
    if (current.mode === 'watch') return `Checks on every Linear sync (every ${settings.pollSeconds}s)${current.window || current.days.length ? ', within its hours' : ''}`
    const t = st?.nextRunAt
    const due = !t || t <= Date.now()
    return due ? (current.window || current.days.length ? 'As soon as its hours start' : 'Within 30 seconds') : new Date(t).toLocaleString()
  }

  return (
    <>
      <div className="statelist">
        <div className="listlabel">Automations</div>
        {list.map((a, i) => (
          <button key={a.id} type="button" className={`state${i === selected ? ' active' : ''}`} onClick={() => setSelected(i)}>
            <span className="project-row">
              <span className="dot" style={{ background: a.enabled ? 'var(--ok)' : 'var(--idle)' }} aria-hidden="true" />
              {a.name || 'Untitled'}
              {!a.enabled && <span className="badge off">Off</span>}
            </span>
            <span className="sub">
              {a.kind === 'global'
                ? a.globalAction
                  ? `Global: ${a.globalAction} · ${when(a)}`
                  : 'No global action yet'
                : a.states.length
                  ? `${a.states.join(', ')} · ${when(a)}`
                  : 'No states yet'}
            </span>
          </button>
        ))}
        {!list.length && <div className="note" style={{ padding: '0 12px' }}>No automations yet.</div>}
        <button className="btn" type="button" style={{ margin: '10px 12px 0' }} onClick={add}>
          New automation
        </button>
      </div>

      <div className="page projects-page">
        <div className="header">
          <h1>{current?.name || 'Automations'}</h1>
          {!dirty && message && message !== 'Saved' && <span className="note">{message}</span>}
          <div className="right">
            <SaveStatus dirty={dirty} saving={saving} saved={message === 'Saved'} onSave={() => void save()} />
            {dirty && (
              <button className="btn" type="button" disabled={saving} onClick={() => (setList(copy(settings.automations)), setDirty(false))}>
                Discard
              </button>
            )}
            <button className="btn primary" type="button" disabled={!dirty || saving} onClick={() => void save()}>
              Save automations
            </button>
          </div>
          {conflict && (
            <ConflictBanner
              message={conflict}
              onLoadTheirs={() => (setList(copy(settings.automations)), setBaseRevs(settings.sharedRevs), setDirty(false), setConflict(null))}
              onKeepMine={() => (setBaseRevs(settings.sharedRevs), setConflict(null))}
            />
          )}
        </div>
        <p className="note">
          Automations start runs for tickets in their states, using the actions set up for those states. They obey the {settings.maxConcurrent}-at-once limit
          for local runs in Settings.
        </p>

        {!current && (
          <div className="settings-section empty-card">
            <div className="section-side">
              <h2>Schedule your first agent</h2>
              <p className="section-intro">
                For example: watch Ready to Build overnight and pick up each ticket as it arrives, or run a Spec action on one ticket every hour.
              </p>
            </div>
            <div>
              <button className="btn primary" type="button" onClick={add}>
                New automation
              </button>
            </div>
          </div>
        )}

        {current && (
          <div className="projects-cards">
            <section className="settings-section" aria-labelledby="au-basics">
              <div className="section-side">
                <h2 id="au-basics">Basics</h2>
                <p className="section-intro">New automations start switched off, so nothing runs until you turn it on and save.</p>
              </div>
              <div className="form single">
                <div className="inputrow">
                  <input className="input name-input" aria-label="Automation name" value={current.name} onChange={(e) => change({ name: e.target.value })} />
                  <label className={`toggle-pill${current.enabled ? ' on' : ''}`}>
                    <input type="checkbox" checked={current.enabled} onChange={(e) => change({ enabled: e.target.checked })} />
                    {current.enabled ? 'On' : 'Off'}
                  </label>
                </div>
                <div className="choices" role="radiogroup" aria-label="What it runs">
                  <label className={`choice${!isGlobal ? ' active' : ''}`}>
                    <input type="radio" name="au-kind" checked={!isGlobal} onChange={() => change({ kind: 'tickets', globalAction: null })} />
                    <span>
                      <strong>Tickets</strong>
                      <span className="sub">Runs the actions set up for tickets in chosen states.</span>
                    </span>
                  </label>
                  <label className={`choice${isGlobal ? ' active' : ''}`}>
                    <input
                      type="radio"
                      name="au-kind"
                      checked={isGlobal}
                      onChange={() => change({ kind: 'global', mode: 'schedule', globalAction: current.globalAction ?? globalNames[0] ?? null })}
                    />
                    <span>
                      <strong>A global action</strong>
                      <span className="sub">Runs a global action from the base branch on a schedule. No tickets involved.</span>
                    </span>
                  </label>
                </div>
                {!isGlobal && (
                <div className="choices" role="radiogroup" aria-label="Type">
                  <label className={`choice${current.mode === 'watch' ? ' active' : ''}`}>
                    <input type="radio" name="au-mode" checked={current.mode === 'watch'} onChange={() => change({ mode: 'watch' })} />
                    <span>
                      <strong>Watch for tickets</strong>
                      <span className="sub">Picks tickets up as they arrive in its states, at any time or within set hours.</span>
                    </span>
                  </label>
                  <label className={`choice${current.mode === 'schedule' ? ' active' : ''}`}>
                    <input type="radio" name="au-mode" checked={current.mode === 'schedule'} onChange={() => change({ mode: 'schedule' })} />
                    <span>
                      <strong>On a schedule</strong>
                      <span className="sub">Runs every so often, a set number of tickets each time, optionally a set number of times.</span>
                    </span>
                  </label>
                </div>
                )}
                <label className="field">
                  Agent
                  <select className="input" value={current.runner} onChange={() => change({ runner: 'local' })}>
                    <option value="local">Local: Claude Code on this machine</option>
                    <option value="cloud" disabled>
                      Cloud: Claude Code on the web (coming soon)
                    </option>
                  </select>
                </label>
              </div>
            </section>

            {isGlobal ? (
              <section className="settings-section" aria-labelledby="au-global">
                <div className="section-side">
                  <h2 id="au-global">Global action</h2>
                  <p className="section-intro">
                    Each run checks out the latest {settings.baseBranch || 'base branch'} and runs the action there. If the last run is still going, that
                    turn is skipped.
                  </p>
                </div>
                <div className="form single">
                  <label className="field">
                    Action
                    <select className="input" value={current.globalAction ?? ''} onChange={(e) => change({ globalAction: e.target.value || null })}>
                      <option value="">Pick a global action…</option>
                      {current.globalAction && !globalNames.includes(current.globalAction) && (
                        <option value={current.globalAction}>{current.globalAction} (not a global action any more)</option>
                      )}
                      {globalNames.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    {!globalNames.length && <span className="note">No global actions yet. Make one on the Actions page and mark it Global.</span>}
                  </label>
                </div>
              </section>
            ) : (
            <section className="settings-section" aria-labelledby="au-tickets">
              <div className="section-side">
                <h2 id="au-tickets">Tickets</h2>
                <p className="section-intro">Which tickets it works on. Each state runs its own action from the Actions page.</p>
              </div>
              <div className="form single">
                <label className="field">
                  Project
                  <select className="input" value={current.projectId ?? ''} onChange={(e) => change({ projectId: e.target.value || null })}>
                    <option value="">All of team {settings.linearTeamKey}</option>
                    {settings.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="field">
                  States (one or more)
                  <div className="state-picks" role="group" aria-label="States">
                    {states.map((s) => {
                      const on = current.states.some((n) => n.toLowerCase() === s.name.toLowerCase())
                      const setNames = setsByState.get(s.name.toLowerCase()) ?? []
                      const setName = setNames.join(', ')
                      return (
                        <button
                          key={s.id}
                          type="button"
                          className={`state-pick${on ? ' on' : ''}`}
                          aria-pressed={on}
                          disabled={!setName && !on}
                          title={setName ? `Action: ${setName}` : 'No action for this state. Add one on the Actions page.'}
                          onClick={() => change({ states: on ? current.states.filter((n) => n.toLowerCase() !== s.name.toLowerCase()) : [...current.states, s.name] })}
                        >
                          <StatusIcon state={s} />
                          {s.name}
                          {setName ? <span className="taken">{setName}</span> : <span className="taken">no action</span>}
                        </button>
                      )
                    })}
                    {!states.length && <span className="note">States load once Linear is connected.</span>}
                  </div>
                </div>
                {needsSetChoice && (
                  <label className="field">
                    Action to run (a chosen state has more than one)
                    <select className="input" value={current.stepSet ?? ''} onChange={(e) => change({ stepSet: e.target.value || null })}>
                      <option value="">Each state&apos;s first action</option>
                      {chosenSets.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    {current.stepSet && current.states.some((st) => !(setsByState.get(st.toLowerCase()) ?? []).includes(current.stepSet!)) && (
                      <span className="note">States without &quot;{current.stepSet}&quot; run their first set instead.</span>
                    )}
                  </label>
                )}
              </div>
            </section>

            )}

            <section className="settings-section" aria-labelledby="au-when">
              <div className="section-side">
                <h2 id="au-when">When</h2>
                <p className="section-intro">
                  {current.mode === 'schedule' ? 'How often it runs, and on which days and hours.' : 'Days and hours it watches. Outside them it waits.'}
                </p>
              </div>
              <div className="form single">
                {current.mode === 'schedule' && (
                  <div className="inline-fields">
                    <label className="field">
                      Run every
                      <select className="input" value={current.everyMinutes} onChange={(e) => change({ everyMinutes: Number(e.target.value) })}>
                        {(EVERY.includes(current.everyMinutes) ? EVERY : [...EVERY, current.everyMinutes].sort((a, b) => a - b)).map((m) => (
                          <option key={m} value={m}>
                            {everyLabel(m)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      Number of runs
                      <span className="inputrow">
                        <select
                          className="input"
                          value={current.maxRuns === null ? 'none' : 'limit'}
                          onChange={(e) => change({ maxRuns: e.target.value === 'none' ? null : current.maxRuns ?? 5 })}
                        >
                          <option value="none">No limit</option>
                          <option value="limit">Stop after…</option>
                        </select>
                        {current.maxRuns !== null && (
                          <input
                            className="input num-input"
                            type="number"
                            min={1}
                            aria-label="Stop after this many runs"
                            value={current.maxRuns}
                            onChange={(e) => change({ maxRuns: Math.max(1, Number(e.target.value) || 1) })}
                          />
                        )}
                      </span>
                    </label>
                  </div>
                )}
                <div className="field">
                  Days
                  <div className="state-picks" role="group" aria-label="Days">
                    {DAYS.map((d, i) => {
                      const on = current.days.length === 0 || current.days.includes(i)
                      return (
                        <button
                          key={d}
                          type="button"
                          className={`state-pick day${on ? ' on' : ''}`}
                          aria-pressed={on}
                          onClick={() => {
                            const base = current.days.length ? current.days : [0, 1, 2, 3, 4, 5, 6]
                            const next = on ? base.filter((x) => x !== i) : [...base, i].sort()
                            change({ days: next.length === 7 ? [] : next })
                          }}
                        >
                          {d}
                        </button>
                      )
                    })}
                  </div>
                  {current.days.length === 0 && <span className="note">Every day</span>}
                </div>
                <div className="field">
                  Hours
                  <span className="inputrow hours-row">
                    <select
                      className="input"
                      value={current.window ? 'window' : 'any'}
                      onChange={(e) => change({ window: e.target.value === 'any' ? null : { start: '20:00', end: '08:00' } })}
                    >
                      <option value="any">Any time</option>
                      <option value="window">Between…</option>
                    </select>
                    {current.window && (
                      <>
                        <input
                          className="input time-input"
                          type="time"
                          aria-label="From"
                          value={current.window.start}
                          onChange={(e) => e.target.value && change({ window: { ...current.window!, start: e.target.value } })}
                        />
                        <span className="note">to</span>
                        <input
                          className="input time-input"
                          type="time"
                          aria-label="To"
                          value={current.window.end}
                          onChange={(e) => e.target.value && change({ window: { ...current.window!, end: e.target.value } })}
                        />
                      </>
                    )}
                  </span>
                  {current.window && current.window.start > current.window.end && <span className="note">Runs overnight, across midnight.</span>}
                </div>
              </div>
            </section>

            {!isGlobal && (
            <section className="settings-section" aria-labelledby="au-pick">
              <div className="section-side">
                <h2 id="au-pick">Picking tickets</h2>
                <p className="section-intro">Highest priority first, then board order.</p>
              </div>
              <div className="form single">
                {current.mode === 'schedule' ? (
                  <>
                    <div className="inline-fields">
                      <label className="field">
                        Tickets each run
                        <input
                          className="input num-input"
                          type="number"
                          min={1}
                          max={20}
                          value={current.ticketsPerRun}
                          onChange={(e) => change({ ticketsPerRun: Math.max(1, Number(e.target.value) || 1) })}
                        />
                      </label>
                      <label className="field">
                        Skip tickets that ran in the last
                        <span className="inputrow">
                          <input
                            className="input num-input"
                            type="number"
                            min={0}
                            value={current.cooldownHours}
                            onChange={(e) => change({ cooldownHours: Math.max(0, Number(e.target.value) || 0) })}
                          />
                          <span className="note">hours</span>
                        </span>
                      </label>
                    </div>
                    <label className="check-row">
                      <input type="checkbox" checked={current.onlyIfTickets} onChange={(e) => change({ onlyIfTickets: e.target.checked })} />
                      <span>
                        <strong>Only run when the state has tickets</strong>
                        <span className="sub">
                          An empty state doesn&apos;t use up a run: it checks again in a minute and runs as soon as a ticket arrives. Off: the run counts
                          even with nothing to do.
                        </span>
                      </span>
                    </label>
                  </>
                ) : (
                  <>
                    <div className="choices" role="radiogroup" aria-label="Runs per ticket">
                      <label className={`choice${current.perTicket === 'perArrival' ? ' active' : ''}`}>
                        <input type="radio" name="au-per" checked={current.perTicket === 'perArrival'} onChange={() => change({ perTicket: 'perArrival' })} />
                        <span>
                          <strong>Once each time it arrives</strong>
                          <span className="sub">Runs when a ticket enters the state. Moving out and back in runs it again.</span>
                        </span>
                      </label>
                      <label className={`choice${current.perTicket === 'repeat' ? ' active' : ''}`}>
                        <input type="radio" name="au-per" checked={current.perTicket === 'repeat'} onChange={() => change({ perTicket: 'repeat' })} />
                        <span>
                          <strong>Any number of times</strong>
                          <span className="sub">Runs again while the ticket stays in the state, after the cooldown below.</span>
                        </span>
                      </label>
                    </div>
                    <div className="inline-fields">
                      {current.perTicket === 'repeat' && (
                        <label className="field">
                          Cooldown between runs of a ticket
                          <span className="inputrow">
                            <input
                              className="input num-input"
                              type="number"
                              min={0}
                              value={current.cooldownHours}
                              onChange={(e) => change({ cooldownHours: Math.max(0, Number(e.target.value) || 0) })}
                            />
                            <span className="note">hours</span>
                          </span>
                        </label>
                      )}
                      <label className="field">
                        At most running at once
                        <input
                          className="input num-input"
                          type="number"
                          min={1}
                          max={20}
                          value={current.maxActive}
                          onChange={(e) => change({ maxActive: Math.max(1, Number(e.target.value) || 1) })}
                        />
                      </label>
                    </div>
                  </>
                )}
              </div>
            </section>

            )}

            <section className="settings-section" aria-labelledby="au-status">
              <div className="section-side">
                <h2 id="au-status">Status</h2>
                <p className="section-intro">Run now checks straight away, ignoring the schedule and hours.</p>
              </div>
              <div className="form single">
                <dl className="status-list">
                  <dt>Next</dt>
                  <dd>{nextText()}</dd>
                  <dt>{current.mode === 'schedule' ? 'Last run' : 'Last pick-up'}</dt>
                  <dd>{ago(st?.lastRunAt)}</dd>
                  <dt>Last checked</dt>
                  <dd>{ago(st?.lastCheckedAt)}</dd>
                  {current.mode === 'schedule' && current.maxRuns !== null && (
                    <>
                      <dt>Runs</dt>
                      <dd>
                        {st?.runsDone ?? 0} of {current.maxRuns}
                      </dd>
                    </>
                  )}
                  <dt>Result</dt>
                  <dd>{st?.lastResult ?? 'Not run yet'}</dd>
                </dl>
                {message && message !== 'Saved' && <span className="note">{message}</span>}
                <div className="inputrow action-buttons">
                  <button className="btn" type="button" disabled={dirty || !saved} title={dirty ? 'Save first' : undefined} onClick={() => void runNow()}>
                    Run now
                  </button>
                  <button className={`btn danger${confirmDelete ? ' confirm' : ''}`} type="button" onClick={remove} onBlur={() => setConfirmDelete(false)}>
                    {confirmDelete ? 'Click again to delete' : 'Delete automation'}
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </>
  )
}
