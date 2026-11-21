import { useEffect, useState } from 'react'
import type { LinearProject, NightShiftProject, Settings } from '../../../shared/types'
import ConflictBanner from './ConflictBanner'
import SaveStatus from './SaveStatus'
import { useWide } from '../useWide'

interface Props {
  settings: Settings
  linearProjects: LinearProject[]
  onSaved(s: Settings): void
  onShow(projectId: string): void // make it the active project and go to the board
}

function copy(p: NightShiftProject[]): NightShiftProject[] {
  return p.map((x) => ({ ...x, linearProjectIds: [...x.linearProjectIds] }))
}

// Night Shift projects: named slices of the team's tickets, each linked to Linear projects.
export default function ProjectsView({ settings, linearProjects, onSaved, onShow }: Props): JSX.Element {
  const wide = useWide()
  const [projects, setProjects] = useState<NightShiftProject[]>(() => copy(settings.projects))
  const [baseRevs, setBaseRevs] = useState(settings.sharedRevs) // revisions of what's being edited
  const [conflict, setConflict] = useState<string | null>(null)
  const [selected, setSelected] = useState(() => Math.max(0, settings.projects.findIndex((p) => p.id === settings.activeProjectId)))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => setConfirmDelete(false), [selected])

  const current = projects[selected] as NightShiftProject | undefined

  function change(patch: Partial<NightShiftProject>): void {
    setProjects((prev) => prev.map((p, i) => (i === selected ? { ...p, ...patch } : p)))
    setDirty(true)
    setSaved(false)
  }

  function toggleLinear(lp: LinearProject): void {
    if (!current) return
    const on = current.linearProjectIds.includes(lp.id)
    change({
      linearProjectIds: on ? current.linearProjectIds.filter((x) => x !== lp.id) : [...current.linearProjectIds, lp.id],
      // Name an untitled project after the first Linear project picked.
      ...(!on && !current.linearProjectIds.length && /^New project( \d+)?$/.test(current.name) ? { name: lp.name } : {})
    })
  }

  function addProject(): void {
    let name = 'New project'
    for (let n = 2; projects.some((p) => p.name === name); n++) name = `New project ${n}`
    setProjects((prev) => [...prev, { id: crypto.randomUUID(), name, linearProjectIds: [] }])
    setSelected(projects.length)
    setDirty(true)
    setSaved(false)
  }

  function deleteProject(): void {
    if (!confirmDelete) return setConfirmDelete(true)
    setProjects((prev) => prev.filter((_, i) => i !== selected))
    setSelected((i) => Math.max(0, i - 1))
    setDirty(true)
    setSaved(false)
    setConfirmDelete(false)
  }

  function discard(): void {
    setProjects(copy(settings.projects))
    setBaseRevs(settings.sharedRevs)
    setConflict(null)
    setSelected((i) => Math.min(i, Math.max(0, settings.projects.length - 1)))
    setDirty(false)
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const s = await window.nightShift.saveSettings({ projects, sharedRevs: baseRevs })
      onSaved(s)
      if (s.saveError) {
        setConflict(s.saveError.message)
        return
      }
      setConflict(null)
      setBaseRevs(s.sharedRevs)
      setProjects(copy(s.projects))
      setDirty(false)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const q = filter.trim().toLowerCase()
  const shownLinear = linearProjects.filter((lp) => !q || lp.name.toLowerCase().includes(q))
  const linkedNames = (p: NightShiftProject): string =>
    p.linearProjectIds.map((id) => linearProjects.find((lp) => lp.id === id)?.name ?? 'Unknown project').join(', ')
  const isActive = (p: NightShiftProject): boolean => settings.activeProjectId === p.id

  return (
    <>
      <nav className={`actions-list${wide ? ' wide' : ''}`} aria-label="Projects">
        <div className="actions-list-head">
          <h1>Projects</h1>
          <span className="count">{projects.length}</span>
        </div>
        <div className="actions-list-items">
          {projects.map((p, i) => (
            <button key={p.id} type="button" className={`action-item${i === selected ? ' active' : ''}`} aria-current={i === selected ? 'true' : undefined} onClick={() => setSelected(i)}>
              <span className="action-item-top">
                <span className="action-item-name">{p.name || 'Untitled'}</span>
                {isActive(p) && <span className="onoff on">On board</span>}
              </span>
              <span className="action-item-where">{p.linearProjectIds.length ? linkedNames(p) : 'Not linked yet'}</span>
            </button>
          ))}
          {!projects.length && <p className="note">No projects yet.</p>}
        </div>
        <div className="actions-list-foot one">
          <button className="btn" type="button" onClick={addProject}>
            New project
          </button>
        </div>
      </nav>

      <main className="actions-editor">
        <header className="actions-head">
          <div className="actions-title">
            <div className="actions-title-row">
              <h2>{current?.name || 'Projects'}</h2>
            </div>
            <div className="actions-path">
              A project shows only the tickets in the Linear projects you link to it. Pick one under Linear in the left nav to switch the board.
            </div>
          </div>
          <SaveStatus dirty={dirty} saving={saving} saved={saved} onSave={() => void save()} />
          <button className="btn" type="button" onClick={discard} disabled={!dirty || saving}>
            Discard
          </button>
          <button className="btn primary" type="button" onClick={() => void save()} disabled={!dirty || saving}>
            Save projects
          </button>
        </header>

        <div className="actions-scroll">
        {conflict && (
          <div className="actions-banners">
            <ConflictBanner message={conflict} onLoadTheirs={discard} onKeepMine={() => (setBaseRevs(settings.sharedRevs), setConflict(null))} />
          </div>
        )}
        <div className="pj-body">
        {!current && (
          <div className="settings-section empty-card">
            <div className="st-card-head">
              <h2>Start with a project</h2>
              <p className="section-intro">For example AmplifyUP, linked to the Amplify UP project in Linear, so the board shows only its tickets.</p>
            </div>
            <div>
              <button className="btn primary" type="button" onClick={addProject}>
                New project
              </button>
            </div>
          </div>
        )}

        {current && (
          <div className="projects-cards">
            <section className="settings-section" aria-labelledby="proj-name">
              <div className="st-card-head">
                <h2 id="proj-name">Name</h2>
                <p className="section-intro">Shown in the left nav and at the top of the board.</p>
              </div>
              <div className="form single">
                <input className="input name-input" aria-label="Project name" value={current.name} onChange={(e) => change({ name: e.target.value })} />
              </div>
            </section>

            <section className="settings-section" aria-labelledby="proj-linear">
              <div className="st-card-head">
                <h2 id="proj-linear">Linear projects</h2>
                <p className="section-intro">Tickets in any of these show on the board. Pick one or more.</p>
                <p className="section-intro">{current.linearProjectIds.length} linked</p>
              </div>
              <div className="form single">
                {linearProjects.length > 8 && (
                  <input
                    className="input"
                    type="search"
                    placeholder="Filter Linear projects…"
                    aria-label="Filter Linear projects"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                )}
                <div className="linear-project-grid" role="group" aria-label={`Linear projects for ${current.name}`}>
                  {shownLinear.map((lp) => {
                    const on = current.linearProjectIds.includes(lp.id)
                    return (
                      <button key={lp.id} type="button" className={`lp-card${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggleLinear(lp)}>
                        <span className="lp-icon" style={{ borderColor: lp.color }} aria-hidden="true">
                          <span style={{ background: lp.color }} />
                        </span>
                        <span className="lp-name">{lp.name}</span>
                        <span className="lp-state">{lp.state}</span>
                        {on && (
                          <svg className="check" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                            <path d="M3 7.3 L5.8 10 L11 4.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </button>
                    )
                  })}
                </div>
                {!linearProjects.length && <span className="note">Linear projects load once your Linear key and team are set in Settings.</span>}
                {!current.linearProjectIds.length && linearProjects.length > 0 && (
                  <span className="note warn">Pick at least one, or this project shows no tickets.</span>
                )}
              </div>
            </section>

            <section className="settings-section" aria-labelledby="proj-actions">
              <div className="st-card-head">
                <h2 id="proj-actions">Actions</h2>
                <p className="section-intro">{isActive(current) ? 'This project is on the board now.' : 'Show this project on the board, or remove it.'}</p>
              </div>
              <div className="form single action-row">
                <button
                  className="btn"
                  type="button"
                  disabled={dirty || isActive(current) || !settings.projects.some((p) => p.id === current.id)}
                  title={dirty ? 'Save first' : undefined}
                  onClick={() => onShow(current.id)}
                >
                  {isActive(current) ? 'On the board' : 'Show on board'}
                </button>
                <button className={`btn danger${confirmDelete ? ' confirm' : ''}`} type="button" onClick={deleteProject} onBlur={() => setConfirmDelete(false)}>
                  {confirmDelete ? 'Click again to delete' : 'Delete project'}
                </button>
              </div>
            </section>
          </div>
        )}
        </div>
        </div>
      </main>
    </>
  )
}
