import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import SaveStatus from './SaveStatus'
import { CLAUDE_RUN_FLAGS, DEFAULT_CLAUDE_COMMAND, DEFAULT_FAILURE_LABEL, DEFAULT_FAILURE_RETRIES, FINISH_RUN_EXIT_CODE, setLabel, type LinearState, type OnFailure, type SaveConflict, type Settings, type StepDef, type StepSet, type StepsFile, type WorktreeMode } from '../../../shared/types'
import { groupSteps } from '../util'
import { StatusIcon } from './LinearIcons'
import { Icon } from './Icons'
import { useWide } from '../useWide'

interface Props {
  settings: Settings | null
  states: LinearState[] // every team state, so sets can cover hidden ones too
}

const NEW_STEP: Record<StepDef['type'], () => StepDef> = {
  script: () => ({ name: 'New script step', type: 'script', run: '', onFail: 'stop' }),
  claude: () => ({ name: 'Claude', type: 'claude', run: DEFAULT_CLAUDE_COMMAND, onFail: 'stop' }),
  linear: () => ({ name: 'Move ticket', type: 'linear', moveTo: '', onFail: 'continue' }),
  cleanup: () => ({ name: 'Clean up worktrees', type: 'cleanup', onFail: 'stop' })
}

// What a Claude step needs to work unattended and show its progress live.
const HAS_PERMISSION_FLAGS = /--permission-mode|--dangerously-skip-permissions|--allowed-?tools/i
const HAS_STREAM_FLAGS = /--output-format[ =]stream-json/i

function missingFlags(run: string): { flags: string; why: string }[] {
  const out: { flags: string; why: string }[] = []
  if (!HAS_PERMISSION_FLAGS.test(run)) {
    out.push({
      flags: '--permission-mode auto --allowedTools mcp__claude_ai_Linear',
      why: "Claude runs headless and can't ask for permission, so tools it isn't allowed (Linear, edits, commands) get refused."
    })
  }
  if (!HAS_STREAM_FLAGS.test(run)) {
    out.push({ flags: '--output-format stream-json --verbose', why: 'Without streaming output the live log stays empty until Claude finishes.' })
  }
  return out
}

// A global action has no ticket, so its Claude step runs a skill on the whole repo.
const GLOBAL_CLAUDE_COMMAND = `claude -p "/audit" ${CLAUDE_RUN_FLAGS}`

const typeLabel: Record<StepDef['type'], string> = { script: 'Script', claude: 'Claude', linear: 'Linear', cleanup: 'Clean up worktrees' }

function copy(sets: StepSet[]): StepSet[] {
  return JSON.parse(JSON.stringify(sets)) as StepSet[]
}

export default function StepsView({ settings, states }: Props): JSX.Element {
  const wide = useWide()
  const [file, setFile] = useState<StepsFile | null>(null)
  const [sets, setSets] = useState<StepSet[]>([])
  const [selected, setSelected] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [conflict, setConflict] = useState<SaveConflict | null>(null) // the last save clashed with an edit elsewhere
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  function load(): void {
    void window.nightShift.getSteps().then((f) => {
      setFile(f)
      setSets(copy(f.sets))
      setDirty(false)
      setError(null)
      setConflict(null)
      setChangedElsewhere(false)
      setSelected((i) => Math.min(i, Math.max(0, f.sets.length - 1)))
    })
  }
  useEffect(load, [])
  // Saved on another machine (or the host's window): reload, unless there are unsaved edits here.
  useEffect(
    () =>
      window.nightShift.onStepsChanged?.(() => {
        if (dirtyRef.current) setChangedElsewhere(true)
        else load()
      }),
    []
  )

  // After a clash: keep the edits on screen and take the latest revisions, so the next Save applies them.
  async function keepMine(): Promise<void> {
    const latest = await window.nightShift.getSteps()
    setFile(latest)
    setConflict(null)
    setChangedElsewhere(false)
  }
  useEffect(() => setConfirmDelete(false), [selected])

  const current = sets[selected] as StepSet | undefined

  // The other sets on each state, shown on its chip. A state can have several sets.
  const others = useMemo(() => {
    const m = new Map<string, StepSet[]>()
    sets.forEach((set, i) => {
      if (i === selected) return
      set.states.forEach((st) => m.set(st.toLowerCase(), [...(m.get(st.toLowerCase()) ?? []), set]))
    })
    return m
  }, [sets, selected])

  // Two sets on one state need different buttons.
  const labelClash = current
    ? sets.find(
        (s, i) =>
          i !== selected &&
          setLabel(s).toLowerCase() === setLabel(current).toLowerCase() &&
          s.states.some((st) => current.states.some((c) => c.toLowerCase() === st.toLowerCase()))
      )
    : undefined

  function change(fn: (set: StepSet) => void): void {
    setSets((prev) => {
      const next = copy(prev)
      fn(next[selected])
      return next
    })
    setDirty(true)
    setSaved(false)
  }

  function changeStep(i: number, patch: Partial<StepDef>): void {
    change((set) => Object.assign(set.steps[i], patch))
  }

  function changeFailure(patch: Partial<OnFailure>): void {
    change((set) => {
      const next: OnFailure = { ...set.onFailure, ...patch }
      for (const k of Object.keys(next) as (keyof OnFailure)[]) if (next[k] === undefined) delete next[k]
      set.onFailure = Object.keys(next).length ? next : undefined
    })
  }

  function moveStep(i: number, by: number): void {
    change((set) => {
      const j = i + by
      if (j < 0 || j >= set.steps.length) return
      ;[set.steps[i], set.steps[j]] = [set.steps[j], set.steps[i]]
    })
  }

  function addSet(global = false): void {
    const base = global ? 'New global action' : 'New action'
    let name = base
    for (let n = 2; sets.some((s) => s.name.toLowerCase() === name.toLowerCase()); n++) name = `${base} ${n}`
    const fresh: StepSet = global
      ? { name, global: true, states: [], steps: [{ name: 'Claude', type: 'claude', run: GLOBAL_CLAUDE_COMMAND, onFail: 'stop' }] }
      : { name, states: [], steps: [NEW_STEP.claude()] }
    setSets((prev) => [...copy(prev), fresh])
    setSelected(sets.length)
    setDirty(true)
    setSaved(false)
  }

  // A copy of the selected set, placed right after it. Same states and steps; the name and the
  // button label get "copy" so the two don't clash on the same states.
  function duplicateSet(): void {
    const src = sets[selected]
    if (!src) return
    const taken = (n: string): boolean => sets.some((s) => s.name.toLowerCase() === n.toLowerCase())
    let name = `${src.name} copy`
    for (let n = 2; taken(name); n++) name = `${src.name} copy ${n}`
    const dup: StepSet = { ...copy([src])[0], name, label: `${setLabel(src)} (copy)` }
    setSets((prev) => [...copy(prev.slice(0, selected + 1)), dup, ...copy(prev.slice(selected + 1))])
    setSelected(selected + 1)
    setDirty(true)
    setSaved(false)
  }

  function deleteSet(): void {
    if (!confirmDelete) return setConfirmDelete(true)
    setSets((prev) => prev.filter((_, i) => i !== selected))
    setSelected((i) => Math.max(0, i - 1))
    setDirty(true)
    setSaved(false)
    setConfirmDelete(false)
  }

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const res = await window.nightShift.saveSteps(sets, file?.revs)
      if ('error' in res) {
        if ('conflict' in res && res.conflict) setConflict(res.conflict)
        else setError(res.error ?? 'Could not save.')
        return
      }
      setConflict(null)
      setChangedElsewhere(false)
      setFile(res)
      setSets(copy(res.sets))
      setDirty(false)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const stateNames = states.map((s) => s.name)
  const unknownStates = current ? current.states.filter((st) => !stateNames.some((n) => n.toLowerCase() === st.toLowerCase())) : []
  const wtMode: WorktreeMode | 'inherit' = current?.worktree?.mode ?? 'inherit'
  const stepCount = (n: number): string => (n === 1 ? '1 step' : `${n} steps`)
  const where = (s: StepSet): string => (s.global ? 'Run menu and automations' : s.states.length ? s.states.join(', ') : 'No states yet')
  // States that other actions also show on, for the note under the state chips.
  const shared = current
    ? states
        .map((st) => ({ name: st.name, also: others.get(st.name.toLowerCase()) ?? [] }))
        .filter((x) => x.also.length)
        .map((x) => `${x.name} has ${x.also.map((s) => setLabel(s)).join(' and ')}`)
    : []

  // One step: a numbered badge on a rail, and a card coloured by its type.
  function stepRow(st: StepDef, i: number): JSX.Element {
    const last = i === current!.steps.length - 1
    const tools = (
      <span className="step-tools">
        <button className="icon-btn" type="button" aria-label={`Move step ${i + 1} up`} title="Move up" disabled={i === 0} onClick={() => moveStep(i, -1)}>
          <Icon name="up" size={14} width={2.2} />
        </button>
        <button className="icon-btn" type="button" aria-label={`Move step ${i + 1} down`} title="Move down" disabled={last} onClick={() => moveStep(i, 1)}>
          <Icon name="down" size={14} width={2.2} />
        </button>
        <button className="icon-btn remove" type="button" aria-label={`Remove step ${i + 1}`} title="Remove step" onClick={() => change((s) => s.steps.splice(i, 1))}>
          <Icon name="close" size={14} width={2.2} />
        </button>
      </span>
    )
    const missing = st.type === 'claude' ? missingFlags(st.run ?? '') : []
    return (
      <div className="pipe-step">
        <div className="pipe-rail" aria-hidden="true">
          <span className={`pipe-badge ${st.type}`}>{i + 1}</span>
          <span className="pipe-line" />
        </div>
        <div className={`pipe-card ${st.type}`}>
          {st.type === 'cleanup' ? (
            <>
              <div className="pipe-top">
                <span className="pipe-type cleanup">
                  <Icon name="trash" size={12} width={2.2} />
                  Clean up worktrees
                </span>
                <span className="spacer" />
                {tools}
              </div>
              <p className="pipe-text">
                Removes the worktrees of tickets that are Done or Canceled in Linear. Nothing to set up. It keeps worktrees with a run going or uncommitted
                changes, and local branches whose commits aren&apos;t on the remote.
              </p>
            </>
          ) : (
            <>
              <div className="pipe-top">
                <label className={`pipe-type ${st.type}`}>
                  <Icon name={st.type === 'claude' ? 'claude' : st.type === 'linear' ? 'arrow' : 'script'} size={12} width={2.2} />
                  <span className="sr-only">Step {i + 1} type</span>
                  <select
                    value={st.type}
                    onChange={(e) => {
                      const type = e.target.value as StepDef['type']
                      changeStep(
                        i,
                        type === 'linear'
                          ? { type, run: undefined, moveTo: st.moveTo ?? '' }
                          : type === 'cleanup'
                            ? { type, run: undefined, moveTo: undefined, ...(st.name.startsWith('New ') || !st.name.trim() ? { name: 'Clean up worktrees' } : {}) }
                            : { type, moveTo: undefined, run: st.run ?? '' }
                      )
                    }}
                  >
                    {(['script', 'claude', 'linear'] as const).map((t) => (
                      <option key={t} value={t}>
                        {typeLabel[t]}
                      </option>
                    ))}
                  </select>
                </label>
                <input className="pipe-name" aria-label={`Step ${i + 1} name`} value={st.name} onChange={(e) => changeStep(i, { name: e.target.value })} />
                <select
                  className={`pipe-sel${st.onFail === 'continue' ? ' soft' : ''}`}
                  aria-label={`Step ${i + 1} on fail`}
                  value={st.onFail ?? 'stop'}
                  onChange={(e) => changeStep(i, { onFail: e.target.value as StepDef['onFail'] })}
                >
                  <option value="stop">On fail: stop run</option>
                  <option value="continue">On fail: keep going</option>
                </select>
                <select
                  className="pipe-sel"
                  aria-label={`Step ${i + 1} runs when`}
                  value={st.only ?? ''}
                  onChange={(e) => changeStep(i, { only: (e.target.value || undefined) as WorktreeMode | undefined })}
                >
                  <option value="">Any worktree mode</option>
                  <option value="nightshift">Only if Night Shift creates it</option>
                  <option value="agent">Only if the agent decides</option>
                </select>
                {tools}
              </div>
              {st.type === 'linear' ? (
                <label className="pipe-move">
                  <span>Move the ticket to</span>
                  <select className="pipe-sel big" value={st.moveTo ?? ''} onChange={(e) => changeStep(i, { moveTo: e.target.value })}>
                    <option value="">Pick a state…</option>
                    {st.moveTo && !stateNames.includes(st.moveTo) && <option value={st.moveTo}>{st.moveTo} (not in Linear)</option>}
                    {stateNames.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <textarea
                  className="pipe-code"
                  aria-label={`Step ${i + 1} command`}
                  spellCheck={false}
                  rows={(st.run ?? '').length > 90 ? 2 : 1}
                  placeholder={st.type === 'claude' ? 'claude -p "/build $TICKET"' : 'npm ci'}
                  value={st.run ?? ''}
                  onChange={(e) => changeStep(i, { run: e.target.value.replace(/\r?\n/g, ' ') })}
                  // One command: Enter doesn't add a line (long commands still wrap).
                  onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
                />
              )}
              {st.type === 'script' && (
                <p className="pipe-hint">
                  Exit with code {FINISH_RUN_EXIT_CODE} (<span className="mono">exit $NS_FINISH_CODE</span>) to end the run as done and skip the steps after this one.
                </p>
              )}
              {missing.length > 0 && (
                <div className="step-warn">
                  {missing.map((m) => m.why).join(' ')}
                  <button
                    className="btn small"
                    type="button"
                    onClick={() => changeStep(i, { run: [(st.run ?? '').trim(), ...missing.map((m) => m.flags)].join(' ').trim() })}
                  >
                    Add {missing.map((m) => m.flags).join(' ')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <nav className={`actions-list${wide ? ' wide' : ''}`} aria-label="Actions">
        <div className="actions-list-head">
          <h1>Actions</h1>
          <span className="count">{sets.length}</span>
        </div>
        <div className="actions-list-items">
          {sets.map((s, i) => (
            <button key={i} type="button" className={`action-item${i === selected ? ' active' : ''}`} aria-current={i === selected ? 'true' : undefined} onClick={() => setSelected(i)}>
              <span className="action-item-top">
                <span className="action-item-name">{s.name || 'Untitled'}</span>
                {s.global && <span className="global-tag">Global</span>}
                <span className="action-item-steps">{stepCount(s.steps.length)}</span>
              </span>
              <span className="action-item-where">
                {setLabel(s) !== s.name && <>&quot;{setLabel(s)}&quot; · </>}
                {where(s)}
              </span>
            </button>
          ))}
          {!sets.length && <p className="note">No actions yet.</p>}
        </div>
        <div className="actions-list-foot">
          <button className="btn" type="button" onClick={() => addSet()}>
            New action
          </button>
          <button className="btn" type="button" title="An action not tied to a ticket, run from the base branch" onClick={() => addSet(true)}>
            New global
          </button>
        </div>
      </nav>

      <main className="actions-editor">
        <header className="actions-head">
          <div className="actions-title">
            <div className="actions-title-row">
              <h2>{current?.name || 'Actions'}</h2>
              {current && (
                <span className="note">
                  {stepCount(current.steps.length)} · {current.global ? 'Global' : current.states.length ? current.states.join(', ') : 'No states yet'}
                </span>
              )}
            </div>
            <div className="actions-path">
              {file?.path ? (
                settings?.mode === 'remote' ? (
                  <>
                    Saved on the host, in <span className="mono-path">{file.path}</span>. Changes show on every machine straight away.
                  </>
                ) : (
                  <>
                    Saved with Night Shift's own data, in <span className="mono-path">{file.path}</span>
                  </>
                )
              ) : (
                <>
                  Using built-in defaults. Saving stores them with Night Shift's own data, not in the repo.
                </>
              )}
            </div>
          </div>
          <SaveStatus dirty={dirty} saving={saving} saved={saved} onSave={() => void save()} />
          <button className="btn" type="button" onClick={load} disabled={saving}>
            {dirty ? 'Discard' : 'Reload'}
          </button>
          <button className="btn primary" type="button" onClick={() => void save()} disabled={!dirty || saving}>
            Save actions
          </button>
        </header>

        <div className="actions-scroll">
          <div className="actions-banners">
            {file?.error && <div className="banner inline">{file.error}</div>}
            {file?.problems?.length && !dirty ? <div className="banner inline">{file.problems.join(' ')}</div> : null}
            {error && <div className="banner inline">{error}</div>}
            {conflict && (
              <div className="banner inline conflict" role="alert">
                <span>{conflict.message}</span>
                <span className="row-actions">
                  <button className="btn small" type="button" onClick={load}>
                    Load their version
                  </button>
                  <button className="btn small" type="button" onClick={() => void keepMine()} title="Keep your edits on screen; saving again replaces their version">
                    Keep my edits
                  </button>
                </span>
              </div>
            )}
            {changedElsewhere && !conflict && <div className="banner inline">Actions were changed on another machine while you were editing. Saving checks for clashes first.</div>}
          </div>

          {!current && <div className="empty actions-empty">No actions yet. Create one to get started.</div>}

          {current && (
            <div className="actions-body">
              <div className="actions-settings">
                <section className="a-card" aria-labelledby="a-basics">
                  <h3 id="a-basics">Action</h3>
                  <label className="a-field">
                    <span>Name</span>
                    <input className="a-input" value={current.name} onChange={(e) => change((s) => (s.name = e.target.value))} />
                  </label>
                  <label className="a-field">
                    <span>{current.global ? 'Name in the Run action menu' : "Button label in the ticket's Actions menu"}</span>
                    <input
                      className="a-input"
                      value={current.label ?? ''}
                      placeholder={current.name || 'Run'}
                      onChange={(e) => change((s) => (s.label = e.target.value || undefined))}
                    />
                    {labelClash && (
                      <span className="note warn">
                        &quot;{labelClash.name}&quot; already shows a &quot;{setLabel(current)}&quot; action on the same state. Pick a different label.
                      </span>
                    )}
                  </label>
                  {!current.global && (
                    <label className="a-field">
                      <span>Worktree</span>
                      <select
                        className="a-input"
                        value={wtMode}
                        onChange={(e) =>
                          change((s) => {
                            const v = e.target.value
                            s.worktree = v === 'inherit' ? (s.worktree?.path ? { path: s.worktree.path } : undefined) : { ...s.worktree, mode: v as WorktreeMode }
                          })
                        }
                      >
                        <option value="inherit">Use Settings ({settings?.worktreeMode === 'agent' ? 'agent decides' : 'Night Shift creates'})</option>
                        <option value="nightshift">Night Shift creates it</option>
                        <option value="agent">Let the agent decide</option>
                      </select>
                    </label>
                  )}
                  {!current.global && (wtMode === 'inherit' ? settings?.worktreeMode : wtMode) !== 'agent' && (
                    <label className="a-field">
                      <span>Worktree path (blank = Settings)</span>
                      <input
                        className="a-input mono-input"
                        value={current.worktree?.path ?? ''}
                        placeholder={settings?.worktreePath}
                        onChange={(e) =>
                          change((s) => {
                            const path = e.target.value
                            s.worktree = path || s.worktree?.mode ? { ...s.worktree, path: path || undefined } : undefined
                          })
                        }
                      />
                    </label>
                  )}
                  <label className="a-check boxed">
                    <input
                      type="checkbox"
                      checked={Boolean(current.global)}
                      onChange={(e) =>
                        change((s) => {
                          if (e.target.checked) {
                            s.global = true
                            s.states = []
                            s.worktree = undefined
                            s.onFailure = undefined
                            s.steps = s.steps.filter((st) => st.type !== 'linear') // no ticket to move
                          } else {
                            delete s.global
                          }
                        })
                      }
                    />
                    <span>
                      <strong>Global action</strong>
                      <span className="sub">
                        Not tied to a ticket or state. Runs from a fresh checkout of <span className="mono-path">{settings?.baseBranch || 'the base branch'}</span>,
                        started from Run action at the top of the board or from an automation.
                      </span>
                    </span>
                  </label>
                </section>

                {current.global ? (
                  <section className="a-card" aria-labelledby="a-where">
                    <h3 id="a-where">Where it runs</h3>
                    {current.steps.length > 0 && current.steps.every((st) => st.type === 'cleanup') ? (
                      <p className="a-note">Runs on the repo itself, so nothing is checked out first. The log lists every worktree it removed or kept, and why.</p>
                    ) : (
                      <p className="a-note">
                        Each run checks out the latest {settings?.baseBranch || 'base branch'} into its own folder (replaced every run), and every step runs
                        there. <code>$WORKTREE</code> is that folder, <code>$BASE</code> the branch. There&apos;s no ticket, so <code>$TICKET</code> is empty.
                      </p>
                    )}
                  </section>
                ) : (
                  <section className="a-card" aria-labelledby="a-states">
                    <div className="a-card-head">
                      <h3 id="a-states">Available on tickets in</h3>
                      <span className="note">{current.states.length} selected</span>
                    </div>
                    <div className="state-picks" role="group" aria-labelledby="a-states">
                      {states.map((st) => {
                        const on = current.states.some((n) => n.toLowerCase() === st.name.toLowerCase())
                        const also = others.get(st.name.toLowerCase()) ?? []
                        return (
                          <button
                            key={st.id}
                            type="button"
                            className={`state-pick${on ? ' on' : ''}`}
                            aria-pressed={on}
                            title={also.length ? `Other actions here: ${also.map((s) => (setLabel(s) === s.name ? s.name : `${s.name} ("${setLabel(s)}")`)).join(', ')}` : undefined}
                            onClick={() =>
                              change((s) => {
                                s.states = on ? s.states.filter((n) => n.toLowerCase() !== st.name.toLowerCase()) : [...s.states, st.name]
                              })
                            }
                          >
                            <StatusIcon state={st} size={12} />
                            {st.name}
                            {also.length > 0 && (
                              <span className="taken">
                                +{also.length}
                                <span className="sr-only"> other {also.length === 1 ? 'action' : 'actions'}: {also.map((s) => setLabel(s)).join(', ')}</span>
                              </span>
                            )}
                          </button>
                        )
                      })}
                      {unknownStates.map((name) => (
                        <button
                          key={name}
                          type="button"
                          className="state-pick on unknown"
                          title="Not a state in Linear. Click to remove."
                          onClick={() => change((s) => (s.states = s.states.filter((n) => n !== name)))}
                        >
                          {name} <span className="taken">not in Linear</span>
                        </button>
                      ))}
                      {!states.length && <span className="note">Linear states load once your Linear key is set.</span>}
                    </div>
                    {shared.length > 0 && <p className="a-note">A small +number means other actions also show on that state: {shared.join(', ')}.</p>}
                  </section>
                )}

                {!current.global && (
                  <section className="a-card" aria-labelledby="a-fail">
                    <h3 id="a-fail">If a run fails</h3>
                    <label className="a-field">
                      <span>Send the ticket back to</span>
                      <select className="a-input" value={current.onFailure?.moveTo ?? ''} onChange={(e) => changeFailure({ moveTo: e.target.value || undefined })}>
                        <option value="">Leave it where it is</option>
                        {states.map((st) => (
                          <option key={st.id} value={st.name}>
                            {st.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="a-grid2">
                      <label className="a-field">
                        <span>Label it in Linear</span>
                        <input
                          className="a-input"
                          value={current.onFailure?.label ?? ''}
                          placeholder={DEFAULT_FAILURE_LABEL}
                          onChange={(e) => changeFailure({ label: e.target.value || undefined })}
                        />
                      </label>
                      <label className="a-field">
                        <span>Give up after failures in a row</span>
                        <input
                          className="a-input"
                          type="number"
                          min={1}
                          max={20}
                          value={(current.onFailure?.retries ?? DEFAULT_FAILURE_RETRIES) + 1}
                          disabled={!current.onFailure?.moveTo}
                          title={current.onFailure?.moveTo ? undefined : 'Pick a state to send it back to first'}
                          onChange={(e) => changeFailure({ retries: Math.max(0, Math.floor(Number(e.target.value) || 1) - 1) })}
                        />
                      </label>
                    </div>
                    <label className="a-check">
                      <input type="checkbox" checked={current.onFailure?.comment !== false} onChange={(e) => changeFailure({ comment: e.target.checked ? undefined : false })} />
                      <span>Comment on the ticket with the failed step and the end of the log</span>
                    </label>
                    <p className="a-note">
                      {current.onFailure?.moveTo
                        ? `A failed run labels the ticket "${current.onFailure.label || DEFAULT_FAILURE_LABEL}" and moves it to ${current.onFailure.moveTo}, so an automation there runs it again. After ${(current.onFailure.retries ?? DEFAULT_FAILURE_RETRIES) + 1} failures in a row it stays put. A successful run removes the label. Stopping a run yourself does none of this.`
                        : 'A failed run leaves the ticket where it is. Pick a state to send it back to, so an automation on that state gives it another run.'}
                    </p>
                  </section>
                )}

                <div className="row-actions">
                  <button className="btn" type="button" title="Make a copy of this action to change" onClick={duplicateSet}>
                    Duplicate action
                  </button>
                  <button className={`btn danger${confirmDelete ? ' confirm' : ''}`} type="button" onClick={deleteSet} onBlur={() => setConfirmDelete(false)}>
                    {confirmDelete ? 'Click again to delete this action' : 'Delete action'}
                  </button>
                </div>
              </div>

              <section className="actions-steps" aria-labelledby="a-steps">
                <div className="a-steps-head">
                  <h3 id="a-steps">Steps</h3>
                  <span className="note">
                    Run top to bottom. Variables: <span className="mono-path">$TICKET $ID $BRANCH $BASE $WORKTREE $REPO</span>
                  </span>
                </div>
                {groupSteps(current.steps).map((g, gi) => (
                  <div key={g.label} className="pipe-group" role="group" aria-label={g.label}>
                    <div className="pipe-phase">
                      <span className="pipe-rail" aria-hidden="true">
                        <span className={`pipe-line short${gi === 0 ? ' none' : ''}`} />
                      </span>
                      <span className="sec-label">
                        {g.label === 'Claude' ? 'Claude · runs inside the worktree' : g.items.every(({ step }) => step.type === 'cleanup') ? 'Steps' : g.label}
                      </span>
                    </div>
                    {g.items.map(({ step: st, index: i }) => (
                      <Fragment key={i}>{stepRow(st, i)}</Fragment>
                    ))}
                  </div>
                ))}
                {!current.steps.length && <p className="note">No steps yet.</p>}
                <div className="pipe-step add">
                  <div className="pipe-rail" aria-hidden="true">
                    <span className="pipe-badge add">
                      <Icon name="plus" size={12} width={2.6} />
                    </span>
                  </div>
                  <div className="add-steps">
                    <button className="add-step" type="button" onClick={() => change((s) => s.steps.push(NEW_STEP.script()))}>
                      <Icon name="script" size={12} width={2.2} />
                      Script step
                    </button>
                    <button className="add-step" type="button" onClick={() => change((s) => s.steps.push(NEW_STEP.claude()))}>
                      <Icon name="claude" size={12} width={2.2} />
                      Claude step
                    </button>
                    {!current.global && (
                      <button className="add-step" type="button" onClick={() => change((s) => s.steps.push(NEW_STEP.linear()))}>
                        <Icon name="arrow" size={12} width={2.2} />
                        Linear move
                      </button>
                    )}
                    {!current.steps.some((st) => st.type === 'cleanup') && (
                      <button className="add-step" type="button" title="Remove the worktrees of tickets that are Done or Canceled in Linear" onClick={() => change((s) => s.steps.push(NEW_STEP.cleanup()))}>
                        <Icon name="trash" size={12} width={2.2} />
                        Worktree cleanup
                      </button>
                    )}
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>
      </main>
    </>
  )
}
