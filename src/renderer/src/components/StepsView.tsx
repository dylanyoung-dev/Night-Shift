import { Fragment, useEffect, useMemo, useState } from 'react'
import { DEFAULT_CLAUDE_COMMAND, setLabel, type LinearState, type Settings, type StepDef, type StepSet, type StepsFile, type WorktreeMode } from '../../../shared/types'
import { groupSteps } from '../util'
import { StatusIcon } from './LinearIcons'

interface Props {
  settings: Settings | null
  states: LinearState[] // every team state, so sets can cover hidden ones too
}

const NEW_STEP: Record<StepDef['type'], () => StepDef> = {
  script: () => ({ name: 'New script step', type: 'script', run: '', onFail: 'stop' }),
  claude: () => ({ name: 'Claude', type: 'claude', run: DEFAULT_CLAUDE_COMMAND, onFail: 'stop' }),
  linear: () => ({ name: 'Move ticket', type: 'linear', moveTo: '', onFail: 'continue' })
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

const typeLabel: Record<StepDef['type'], string> = { script: 'Script', claude: 'Claude', linear: 'Linear' }

function copy(sets: StepSet[]): StepSet[] {
  return JSON.parse(JSON.stringify(sets)) as StepSet[]
}

export default function StepsView({ settings, states }: Props): JSX.Element {
  const [file, setFile] = useState<StepsFile | null>(null)
  const [sets, setSets] = useState<StepSet[]>([])
  const [selected, setSelected] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  function load(): void {
    void window.nightShift.getSteps().then((f) => {
      setFile(f)
      setSets(copy(f.sets))
      setDirty(false)
      setError(null)
      setSelected((i) => Math.min(i, Math.max(0, f.sets.length - 1)))
    })
  }
  useEffect(load, [])
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

  function moveStep(i: number, by: number): void {
    change((set) => {
      const j = i + by
      if (j < 0 || j >= set.steps.length) return
      ;[set.steps[i], set.steps[j]] = [set.steps[j], set.steps[i]]
    })
  }

  function addSet(): void {
    const base = 'New steps'
    let name = base
    for (let n = 2; sets.some((s) => s.name.toLowerCase() === name.toLowerCase()); n++) name = `${base} ${n}`
    setSets((prev) => [...copy(prev), { name, states: [], steps: [NEW_STEP.claude()] }])
    setSelected(sets.length)
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
      const res = await window.nightShift.saveSteps(sets)
      if ('error' in res) {
        setError(res.error ?? 'Could not save.')
        return
      }
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

  return (
    <>
      <div className="statelist">
        <div className="listlabel">Sets of steps</div>
        {sets.map((s, i) => (
          <button key={i} type="button" className={`state${i === selected ? ' active' : ''}`} onClick={() => setSelected(i)}>
            {s.name || 'Untitled'}
            <span className="sub">
              &quot;{setLabel(s)}&quot; · {s.states.length ? s.states.join(', ') : 'No states yet'} · {s.steps.length} {s.steps.length === 1 ? 'step' : 'steps'}
            </span>
          </button>
        ))}
        <button className="btn" type="button" style={{ margin: '10px 12px 0' }} onClick={addSet}>
          New set of steps
        </button>
      </div>

      <div className="page steps-editor">
        <div className="header">
          <h1>{current?.name || 'Steps'}</h1>
          {dirty && <span className="chip warn-chip">Unsaved changes</span>}
          {saved && !dirty && <span className="note">Saved</span>}
          <div className="right">
            <button className="btn" type="button" onClick={load} disabled={saving}>
              {dirty ? 'Discard changes' : 'Reload'}
            </button>
            <button className="btn primary" type="button" onClick={() => void save()} disabled={!dirty || saving || !settings?.repoPath}>
              {saving ? 'Saving…' : 'Save steps'}
            </button>
          </div>
        </div>
        <div className="note">
          {!settings?.repoPath
            ? 'Set the repo path in Settings to save steps.'
            : file?.path
              ? `Saved to ${file.path}. Commit it so changes go through a PR.`
              : `Using built-in defaults. Saving creates ${settings.repoPath}\\.nightshift\\steps.yml.`}
        </div>
        {file?.error && <div className="banner inline">{file.error}</div>}
        {file?.problems?.length && !dirty ? <div className="banner inline">{file.problems.join(' ')}</div> : null}
        {error && <div className="banner inline">{error}</div>}

        {!current && <div className="empty">No sets of steps. Create one to get started.</div>}

        {current && (
          <>
            <section className="set-config" aria-label="Set settings">
              <label className="lbl">
                Name
                <input className="input" value={current.name} onChange={(e) => change((s) => (s.name = e.target.value))} />
              </label>
              <label className="lbl">
                Button label (on the ticket&apos;s card)
                <input
                  className="input"
                  value={current.label ?? ''}
                  placeholder={current.name || 'Run steps'}
                  onChange={(e) => change((s) => (s.label = e.target.value || undefined))}
                />
                {labelClash && (
                  <span className="note warn">
                    &quot;{labelClash.name}&quot; already shows a &quot;{setLabel(current)}&quot; button on the same state. Pick a different label.
                  </span>
                )}
              </label>
              <label className="lbl">
                Worktree
                <select
                  className="input"
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
              {(wtMode === 'inherit' ? settings?.worktreeMode : wtMode) !== 'agent' && (
                <label className="lbl">
                  Worktree path (blank = Settings)
                  <input
                    className="input"
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
            </section>

            <div className="grouplabel steps">Runs for tickets in</div>
            <div className="state-picks" role="group" aria-label="Linear states for this set">
              {states.map((st) => {
                const on = current.states.some((n) => n.toLowerCase() === st.name.toLowerCase())
                const also = others.get(st.name.toLowerCase()) ?? []
                return (
                  <button
                    key={st.id}
                    type="button"
                    className={`state-pick${on ? ' on' : ''}`}
                    aria-pressed={on}
                    title={also.length ? `Also has: ${also.map((s) => `${s.name} ("${setLabel(s)}" button)`).join(', ')}` : undefined}
                    onClick={() =>
                      change((s) => {
                        s.states = on ? s.states.filter((n) => n.toLowerCase() !== st.name.toLowerCase()) : [...s.states, st.name]
                      })
                    }
                  >
                    <StatusIcon state={st} />
                    {st.name}
                    {also.length > 0 && <span className="taken">also {also.map((s) => setLabel(s)).join(', ')}</span>}
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

            {groupSteps(current.steps).map((g) => (
              <section key={g.label}>
                <div className="grouplabel steps">{g.label === 'Claude' ? 'Claude · runs inside the worktree' : g.label}</div>
                {g.items.map(({ step: st, index: i }) => (
                  <Fragment key={i}>
                  <div className={`step-edit${st.type === 'claude' ? ' claude' : ''}`}>
                    <span className="num">{i + 1}</span>
                    <select
                      className={`input type-sel ${st.type}`}
                      aria-label={`Step ${i + 1} type`}
                      value={st.type}
                      onChange={(e) => {
                        const type = e.target.value as StepDef['type']
                        changeStep(i, type === 'linear' ? { type, run: undefined, moveTo: st.moveTo ?? '' } : { type, moveTo: undefined, run: st.run ?? '' })
                      }}
                    >
                      {(['script', 'claude', 'linear'] as const).map((t) => (
                        <option key={t} value={t}>
                          {typeLabel[t]}
                        </option>
                      ))}
                    </select>
                    <input className="input" aria-label={`Step ${i + 1} name`} value={st.name} onChange={(e) => changeStep(i, { name: e.target.value })} />
                    {st.type === 'linear' ? (
                      <select className="input" aria-label={`Step ${i + 1} move to`} value={st.moveTo ?? ''} onChange={(e) => changeStep(i, { moveTo: e.target.value })}>
                        <option value="">Move ticket to…</option>
                        {st.moveTo && !stateNames.includes(st.moveTo) && <option value={st.moveTo}>{st.moveTo} (not in Linear)</option>}
                        {stateNames.map((n) => (
                          <option key={n} value={n}>
                            Move to {n}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="input code-input"
                        aria-label={`Step ${i + 1} command`}
                        placeholder={st.type === 'claude' ? 'claude -p "/build $TICKET"' : 'npm ci'}
                        value={st.run ?? ''}
                        onChange={(e) => changeStep(i, { run: e.target.value })}
                      />
                    )}
                    <select className="input" aria-label={`Step ${i + 1} on fail`} value={st.onFail ?? 'stop'} onChange={(e) => changeStep(i, { onFail: e.target.value as StepDef['onFail'] })}>
                      <option value="stop">On fail: stop run</option>
                      <option value="continue">On fail: keep going</option>
                    </select>
                    <select
                      className="input"
                      aria-label={`Step ${i + 1} runs when`}
                      value={st.only ?? ''}
                      onChange={(e) => changeStep(i, { only: (e.target.value || undefined) as WorktreeMode | undefined })}
                    >
                      <option value="">Any worktree mode</option>
                      <option value="nightshift">Only if Night Shift creates it</option>
                      <option value="agent">Only if the agent decides</option>
                    </select>
                    <span className="step-tools">
                      <button className="icon-btn" type="button" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => moveStep(i, -1)}>
                        ↑
                      </button>
                      <button className="icon-btn" type="button" aria-label={`Move step ${i + 1} down`} disabled={i === current.steps.length - 1} onClick={() => moveStep(i, 1)}>
                        ↓
                      </button>
                      <button className="icon-btn" type="button" aria-label={`Remove step ${i + 1}`} onClick={() => change((s) => s.steps.splice(i, 1))}>
                        ×
                      </button>
                    </span>
                  </div>
                  {st.type === 'claude' && missingFlags(st.run ?? '').length > 0 && (
                    <div className="step-warn">
                      {missingFlags(st.run ?? '').map((m) => m.why).join(' ')}
                      <button
                        className="btn small"
                        type="button"
                        onClick={() => changeStep(i, { run: [(st.run ?? '').trim(), ...missingFlags(st.run ?? '').map((m) => m.flags)].join(' ').trim() })}
                      >
                        Add {missingFlags(st.run ?? '').map((m) => m.flags).join(' ')}
                      </button>
                    </div>
                  )}
                  </Fragment>
                ))}
              </section>
            ))}
            {!current.steps.length && <div className="empty">No steps yet.</div>}

            <div className="add-steps">
              <button className="btn" type="button" onClick={() => change((s) => s.steps.push(NEW_STEP.script()))}>
                Add script step
              </button>
              <button className="btn" type="button" onClick={() => change((s) => s.steps.push(NEW_STEP.claude()))}>
                Add Claude step
              </button>
              <button className="btn" type="button" onClick={() => change((s) => s.steps.push(NEW_STEP.linear()))}>
                Add Linear move
              </button>
              <button className={`btn danger${confirmDelete ? ' confirm' : ''}`} type="button" style={{ marginLeft: 'auto' }} onClick={deleteSet} onBlur={() => setConfirmDelete(false)}>
                {confirmDelete ? 'Click again to delete this set' : 'Delete set'}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}
