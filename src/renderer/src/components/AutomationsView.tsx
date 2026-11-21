import { useEffect, useMemo, useState } from 'react'
import type { Automation, AutomationStatus, LinearState, Settings, StepsFile } from '../../../shared/types'
import { StatusIcon } from './LinearIcons'
import ConflictBanner from './ConflictBanner'
import SaveStatus from './SaveStatus'
import { Icon, type IconName } from './Icons'
import { useWide } from '../useWide'

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

const isWeekdays = (days: number[]): boolean => days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))

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
  const wide = useWide()
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

  // Plain-words summary of the automation, plus what would stop it doing anything.
  const projectName = current?.projectId ? settings.projects.find((p) => p.id === current.projectId)?.name ?? 'a removed project' : `All of team ${settings.linearTeamKey}`
  const dayWord = !current || current.days.length === 0 || current.days.length === 7 ? 'every day' : isWeekdays(current.days) ? 'on weekdays' : `on ${current.days.map((d) => DAYS[d]).join(', ')}`
  const hoursText = current?.window ? `between ${time12(current.window.start)} and ${time12(current.window.end)}` : 'at any time'
  const noAction = current && !isGlobal ? current.states.filter((s) => !(setsByState.get(s.toLowerCase()) ?? []).length) : []
  let summary = ''
  let warning = ''
  if (current) {
    if (isGlobal) {
      summary = `Runs ${current.globalAction || 'a global action (none picked yet)'} from ${settings.baseBranch || 'the base branch'} every ${everyLabel(current.everyMinutes)}, ${dayWord}, ${hoursText}${current.maxRuns !== null ? `, ${current.maxRuns} times in all` : ''}, on this machine.`
      if (!current.globalAction) warning = globalNames.length ? 'Pick a global action to run.' : 'No global actions yet. Make one on the Actions page and mark it Global.'
    } else {
      const where = current.states.length ? current.states.join(', ') : 'no states yet'
      summary =
        current.mode === 'watch'
          ? `Watches ${projectName} for tickets arriving in ${where}, ${dayWord}, ${hoursText}. ${current.perTicket === 'perArrival' ? 'Each ticket runs once per arrival' : `Tickets run again after a ${current.cooldownHours} hour cooldown`}, at most ${current.maxActive} at once, on this machine.`
          : `Every ${everyLabel(current.everyMinutes)}, picks ${current.ticketsPerRun === 1 ? '1 ticket' : `${current.ticketsPerRun} tickets`} from ${where} in ${projectName}, ${dayWord}, ${hoursText}.${current.cooldownHours > 0 ? ` Skips tickets that ran in the last ${current.cooldownHours} hours.` : ''}${current.maxRuns !== null ? ` Stops after ${current.maxRuns} runs.` : ''}`
      if (!current.states.length) warning = 'Pick at least one state so it has tickets to work on.'
      else if (noAction.length) warning = `${noAction.join(', ')} ${noAction.length === 1 ? 'has' : 'have'} no action set up, so tickets there won't run.`
    }
  }
  const runNowMessage = message && message !== 'Saved' ? message : null

  // A choice shown as a card with an icon (What it runs, How it starts).
  const optionCard = (o: { on: boolean; disabled?: boolean; icon: IconName; label: string; desc: string; pick(): void }): JSX.Element => (
    <button
      key={o.label}
      type="button"
      role="radio"
      aria-checked={o.on}
      aria-disabled={o.disabled || undefined}
      className={`opt-card${o.on ? ' on' : ''}${o.disabled ? ' disabled' : ''}`}
      onClick={() => !o.disabled && o.pick()}
    >
      <span className="opt-icon" aria-hidden="true">
        <Icon name={o.icon} size={16} />
      </span>
      <span className="opt-text">
        <strong>{o.label}</strong>
        <span>{o.desc}</span>
      </span>
    </button>
  )

  return (
    <>
      <nav className={`actions-list${wide ? ' wide' : ''}`} aria-label="Automations">
        <div className="actions-list-head">
          <h1>Automations</h1>
          <span className="count">{list.length}</span>
        </div>
        <div className="actions-list-items">
          {list.map((a, i) => (
            <button key={a.id} type="button" className={`action-item${i === selected ? ' active' : ''}`} aria-current={i === selected ? 'true' : undefined} onClick={() => setSelected(i)}>
              <span className="action-item-top">
                <span className="dot" style={{ background: a.enabled ? 'var(--ok)' : 'var(--idle)' }} aria-hidden="true" />
                <span className="action-item-name">{a.name || 'Untitled'}</span>
                <span className={`onoff${a.enabled ? ' on' : ''}`}>{a.enabled ? 'On' : 'Off'}</span>
              </span>
              <span className="action-item-where">
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
          {!list.length && <p className="note">No automations yet.</p>}
        </div>
        <div className="actions-list-foot one">
          <button className="btn" type="button" onClick={add}>
            New automation
          </button>
        </div>
      </nav>

      <main className="actions-editor">
        <header className="actions-head">
          <div className="actions-title">
            <div className="actions-title-row">
              <h2>{current ? current.name || 'Untitled automation' : 'Automations'}</h2>
              {!dirty && runNowMessage && <span className="note">{runNowMessage}</span>}
            </div>
            <div className="actions-path">
              Automations start runs for tickets in their states, using the actions set up for those states. They obey the {settings.maxConcurrent}-at-once limit
              for local runs in Settings.
            </div>
          </div>
          <SaveStatus dirty={dirty} saving={saving} saved={message === 'Saved'} onSave={() => void save()} />
          <button className="btn" type="button" disabled={!dirty || saving} onClick={() => (setList(copy(settings.automations)), setDirty(false))}>
            Discard
          </button>
          <button className="btn primary" type="button" disabled={!dirty || saving} onClick={() => void save()}>
            Save automations
          </button>
        </header>

        <div className="actions-scroll">
          {conflict && (
            <div className="actions-banners">
              <ConflictBanner
                message={conflict}
                onLoadTheirs={() => (setList(copy(settings.automations)), setBaseRevs(settings.sharedRevs), setDirty(false), setConflict(null))}
                onKeepMine={() => (setBaseRevs(settings.sharedRevs), setConflict(null))}
              />
            </div>
          )}

          {!current && (
            <div className="au-body">
              <section className="a-card au-empty" aria-labelledby="au-first">
                <h3 id="au-first">Schedule your first agent</h3>
                <p className="a-note">For example: watch Ready to Build overnight and pick up each ticket as it arrives, or run a Spec action on one ticket every hour.</p>
                <div>
                  <button className="btn primary" type="button" onClick={add}>
                    New automation
                  </button>
                </div>
              </section>
            </div>
          )}

          {current && (
            <div className="au-body">
              <div className="au-form">
                <section className="a-card" aria-labelledby="au-basics">
                  <h3 id="au-basics">Basics</h3>
                  <div className="au-name-row">
                    <label className="a-field au-name">
                      <span>Name</span>
                      <input className="a-input big" value={current.name} onChange={(e) => change({ name: e.target.value })} />
                    </label>
                    <button type="button" role="switch" aria-checked={current.enabled} aria-label="Automation on" className={`au-switch${current.enabled ? ' on' : ''}`} onClick={() => change({ enabled: !current.enabled })}>
                      <span className="au-switch-track" aria-hidden="true">
                        <span className="au-switch-knob" />
                      </span>
                      {current.enabled ? 'On' : 'Off'}
                    </button>
                  </div>
                  {!current.enabled && <p className="a-note au-tight">New automations start switched off, so nothing runs until you turn it on and save.</p>}

                  <div className="a-field">
                    <span id="au-kind-label">What it runs</span>
                    <div className="opt-grid" role="radiogroup" aria-labelledby="au-kind-label">
                      {optionCard({ on: !isGlobal, icon: 'tickets', label: 'Tickets', desc: 'Runs the actions set up for tickets in chosen states.', pick: () => change({ kind: 'tickets', globalAction: null }) })}
                      {optionCard({
                        on: isGlobal,
                        icon: 'globe',
                        label: 'A global action',
                        desc: 'Runs a global action from the base branch on a schedule. No tickets involved.',
                        pick: () => change({ kind: 'global', mode: 'schedule', globalAction: current.globalAction ?? globalNames[0] ?? null })
                      })}
                    </div>
                  </div>

                  <div className="a-field">
                    <span id="au-mode-label">How it starts</span>
                    <div className="opt-grid" role="radiogroup" aria-labelledby="au-mode-label">
                      {optionCard({
                        on: current.mode === 'watch',
                        disabled: isGlobal,
                        icon: 'eye',
                        label: 'Watch for tickets',
                        desc: isGlobal ? 'Global actions run on a schedule only.' : 'Picks tickets up as they arrive in its states, at any time or within set hours.',
                        pick: () => change({ mode: 'watch' })
                      })}
                      {optionCard({
                        on: current.mode === 'schedule',
                        icon: 'clock',
                        label: 'On a schedule',
                        desc: 'Runs every so often, a set number of tickets each time, optionally a set number of times.',
                        pick: () => change({ mode: 'schedule' })
                      })}
                    </div>
                  </div>

                  <label className="a-field au-narrow">
                    <span>Agent</span>
                    <select className="a-input big" value={current.runner} onChange={() => change({ runner: 'local' })}>
                      <option value="local">Local: Claude Code on this machine</option>
                      <option value="cloud" disabled>
                        Cloud: Claude Code on the web (coming soon)
                      </option>
                    </select>
                  </label>
                </section>

                {isGlobal ? (
                  <section className="a-card" aria-labelledby="au-global">
                    <div className="au-card-title">
                      <h3 id="au-global">Global action</h3>
                      <span className="note">
                        Each run checks out the latest {settings.baseBranch || 'base branch'} and runs the action there. If the last run is still going, that turn is
                        skipped.
                      </span>
                    </div>
                    <label className="a-field au-narrow">
                      <span>Action to run from the base branch</span>
                      <select className="a-input big" value={current.globalAction ?? ''} onChange={(e) => change({ globalAction: e.target.value || null })}>
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
                  </section>
                ) : (
                  <section className="a-card" aria-labelledby="au-tickets">
                    <div className="au-card-title">
                      <h3 id="au-tickets">Tickets</h3>
                      <span className="note">Which tickets it works on. Each state runs its own action from the Actions page.</span>
                    </div>
                    <label className="a-field au-narrow">
                      <span>Project</span>
                      <select className="a-input big" value={current.projectId ?? ''} onChange={(e) => change({ projectId: e.target.value || null })}>
                        <option value="">All of team {settings.linearTeamKey}</option>
                        {settings.projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="a-field">
                      <span className="au-label-row">
                        <span id="au-states-label">States, one or more</span>
                        <span className="note">{current.states.length} selected</span>
                      </span>
                      <div className="au-states" role="group" aria-labelledby="au-states-label">
                        {states.map((s) => {
                          const on = current.states.some((n) => n.toLowerCase() === s.name.toLowerCase())
                          const setName = (setsByState.get(s.name.toLowerCase()) ?? []).join(', ')
                          return (
                            <button
                              key={s.id}
                              type="button"
                              className={`au-state${on ? ' on' : ''}${setName ? '' : ' none'}`}
                              aria-pressed={on}
                              disabled={!setName && !on}
                              title={setName ? `Action: ${setName}` : 'No action for this state. Add one on the Actions page.'}
                              onClick={() => change({ states: on ? current.states.filter((n) => n.toLowerCase() !== s.name.toLowerCase()) : [...current.states, s.name] })}
                            >
                              <span className="au-box" aria-hidden="true">
                                {on && <Icon name="check" size={11} width={3.4} />}
                              </span>
                              <StatusIcon state={s} size={12} />
                              <span className="au-state-text">
                                <span className="au-state-name">{s.name}</span>
                                <span className="au-state-action">{setName || 'No action set up'}</span>
                              </span>
                            </button>
                          )
                        })}
                        {!states.length && <span className="note">States load once Linear is connected.</span>}
                      </div>
                    </div>
                    {needsSetChoice && (
                      <label className="a-field au-narrow">
                        <span>Action to run (a chosen state has more than one)</span>
                        <select className="a-input big" value={current.stepSet ?? ''} onChange={(e) => change({ stepSet: e.target.value || null })}>
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
                  </section>
                )}

                <section className="a-card" aria-labelledby="au-when">
                  <div className="au-card-title">
                    <h3 id="au-when">When</h3>
                    <span className="note">{current.mode === 'schedule' ? 'How often it runs, and on which days and hours.' : 'Days and hours it watches. Outside them it waits.'}</span>
                  </div>
                  {current.mode === 'schedule' && (
                    <div className="au-inline">
                      <label className="a-field">
                        <span>Run every</span>
                        <select className="a-input big" value={current.everyMinutes} onChange={(e) => change({ everyMinutes: Number(e.target.value) })}>
                          {(EVERY.includes(current.everyMinutes) ? EVERY : [...EVERY, current.everyMinutes].sort((a, b) => a - b)).map((m) => (
                            <option key={m} value={m}>
                              {everyLabel(m)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {!isGlobal && (
                        <label className="a-field">
                          <span>Tickets each time</span>
                          <input
                            className="a-input big num"
                            type="number"
                            min={1}
                            max={20}
                            value={current.ticketsPerRun}
                            onChange={(e) => change({ ticketsPerRun: Math.max(1, Number(e.target.value) || 1) })}
                          />
                        </label>
                      )}
                      <label className="a-field">
                        <span>Number of runs</span>
                        <span className="au-pair">
                          <select
                            className="a-input big"
                            value={current.maxRuns === null ? 'none' : 'limit'}
                            onChange={(e) => change({ maxRuns: e.target.value === 'none' ? null : current.maxRuns ?? 5 })}
                          >
                            <option value="none">No limit</option>
                            <option value="limit">Stop after…</option>
                          </select>
                          {current.maxRuns !== null && (
                            <input
                              className="a-input big num"
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
                  <div className="a-field">
                    <span className="au-label-row">
                      <span id="au-days-label">Days</span>
                      <span className="note">{current.days.length === 0 || current.days.length === 7 ? 'Every day' : isWeekdays(current.days) ? 'Weekdays' : current.days.map((d) => DAYS[d]).join(', ')}</span>
                    </span>
                    <div className="au-days" role="group" aria-labelledby="au-days-label">
                      {DAYS.map((d, i) => {
                        const on = current.days.length === 0 || current.days.includes(i)
                        return (
                          <button
                            key={d}
                            type="button"
                            className={`au-day${on ? ' on' : ''}`}
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
                      <span className="au-sep" aria-hidden="true" />
                      <button type="button" className="add-step" onClick={() => change({ days: [] })}>
                        Every day
                      </button>
                      <button type="button" className="add-step" onClick={() => change({ days: [1, 2, 3, 4, 5] })}>
                        Weekdays
                      </button>
                    </div>
                  </div>
                  <div className="au-inline">
                    <label className="a-field">
                      <span>Hours</span>
                      <select
                        className="a-input big"
                        value={current.window ? 'window' : 'any'}
                        onChange={(e) => change({ window: e.target.value === 'any' ? null : { start: '20:00', end: '08:00' } })}
                      >
                        <option value="any">Any time</option>
                        <option value="window">Between set hours</option>
                      </select>
                    </label>
                    {current.window && (
                      <>
                        <label className="a-field">
                          <span>From</span>
                          <input
                            className="a-input big"
                            type="time"
                            value={current.window.start}
                            onChange={(e) => e.target.value && change({ window: { ...current.window!, start: e.target.value } })}
                          />
                        </label>
                        <label className="a-field">
                          <span>To</span>
                          <input
                            className="a-input big"
                            type="time"
                            value={current.window.end}
                            onChange={(e) => e.target.value && change({ window: { ...current.window!, end: e.target.value } })}
                          />
                        </label>
                      </>
                    )}
                  </div>
                  {current.window && current.window.start > current.window.end && <p className="a-note au-tight">Runs overnight, across midnight.</p>}
                </section>

                {!isGlobal && (
                  <section className="a-card" aria-labelledby="au-pick">
                    <div className="au-card-title">
                      <h3 id="au-pick">Picking tickets</h3>
                      <span className="note">Highest priority first, then board order.</span>
                    </div>
                    {current.mode === 'schedule' ? (
                      <>
                        <label className="a-field">
                          <span>Skip tickets that ran in the last</span>
                          <span className="au-pair">
                            <input
                              className="a-input big num"
                              type="number"
                              min={0}
                              value={current.cooldownHours}
                              onChange={(e) => change({ cooldownHours: Math.max(0, Number(e.target.value) || 0) })}
                            />
                            <span className="note">hours</span>
                          </span>
                        </label>
                        <label className="a-check">
                          <input type="checkbox" checked={current.onlyIfTickets} onChange={(e) => change({ onlyIfTickets: e.target.checked })} />
                          <span>
                            <strong>Only run when the state has tickets</strong>
                            <span className="sub">
                              An empty state doesn&apos;t use up a run: it checks again in a minute and runs as soon as a ticket arrives. Off: the run counts even with
                              nothing to do.
                            </span>
                          </span>
                        </label>
                      </>
                    ) : (
                      <>
                        <div className="opt-grid" role="radiogroup" aria-label="Runs per ticket">
                          {(
                            [
                              ['perArrival', 'Once each time it arrives', 'Runs when a ticket enters the state. Moving out and back in runs it again.'],
                              ['repeat', 'Any number of times', 'Runs again while the ticket stays in the state, after the cooldown below.']
                            ] as const
                          ).map(([id, label, desc]) => (
                            <button
                              key={id}
                              type="button"
                              role="radio"
                              aria-checked={current.perTicket === id}
                              className={`opt-card${current.perTicket === id ? ' on' : ''}`}
                              onClick={() => change({ perTicket: id })}
                            >
                              <span className="opt-radio" aria-hidden="true" />
                              <span className="opt-text">
                                <strong>{label}</strong>
                                <span>{desc}</span>
                              </span>
                            </button>
                          ))}
                        </div>
                        <div className="au-inline">
                          <div className="a-field">
                            <span id="au-max-label">At most running at once</span>
                            <span className="au-stepper" role="group" aria-labelledby="au-max-label">
                              <button type="button" aria-label="Fewer" disabled={current.maxActive <= 1} onClick={() => change({ maxActive: Math.max(1, current.maxActive - 1) })}>
                                −
                              </button>
                              <input
                                type="number"
                                min={1}
                                max={20}
                                aria-labelledby="au-max-label"
                                value={current.maxActive}
                                onChange={(e) => change({ maxActive: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })}
                              />
                              <button type="button" aria-label="More" disabled={current.maxActive >= 20} onClick={() => change({ maxActive: Math.min(20, current.maxActive + 1) })}>
                                +
                              </button>
                            </span>
                            <span className="note">Local runs are capped at {settings.maxConcurrent} in Settings.</span>
                          </div>
                          {current.perTicket === 'repeat' && (
                            <label className="a-field">
                              <span>Cooldown between runs of a ticket</span>
                              <span className="au-pair">
                                <input
                                  className="a-input big num"
                                  type="number"
                                  min={0}
                                  value={current.cooldownHours}
                                  onChange={(e) => change({ cooldownHours: Math.max(0, Number(e.target.value) || 0) })}
                                />
                                <span className="note">hours</span>
                              </span>
                            </label>
                          )}
                        </div>
                      </>
                    )}
                  </section>
                )}
              </div>

              <aside className="au-side" aria-label="Summary and status">
                <section className="a-card" aria-labelledby="au-summary">
                  <div className="a-card-head">
                    <h3 id="au-summary">In plain words</h3>
                    <span className={`onoff${current.enabled ? ' on' : ''}`}>{current.enabled ? 'On' : 'Off'}</span>
                  </div>
                  <p className="au-summary">{summary}</p>
                  {warning && (
                    <div className="au-warn" role="note">
                      <Icon name="warn" size={14} width={2.2} />
                      <span>{warning}</span>
                    </div>
                  )}
                </section>
                <section className="a-card" aria-labelledby="au-status">
                  <div className="au-card-title">
                    <h3 id="au-status">Status</h3>
                    <span className="note">Run now checks straight away, ignoring the schedule and hours.</span>
                  </div>
                  <dl className="au-status">
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
                  {runNowMessage && (
                    <p className="note" role="status">
                      {runNowMessage}
                    </p>
                  )}
                  <div className="row-actions">
                    <button className="btn" type="button" disabled={dirty || !saved} title={dirty ? 'Save first' : !saved ? 'Save it first' : undefined} onClick={() => void runNow()}>
                      Run now
                    </button>
                  </div>
                </section>
                <div className="row-actions">
                  <button className={`btn danger${confirmDelete ? ' confirm' : ''}`} type="button" onClick={remove} onBlur={() => setConfirmDelete(false)}>
                    {confirmDelete ? 'Click again to delete' : 'Delete automation'}
                  </button>
                </div>
              </aside>
            </div>
          )}
        </div>
      </main>
    </>
  )
}
