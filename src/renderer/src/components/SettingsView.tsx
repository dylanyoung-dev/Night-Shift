import { useEffect, useRef, useState } from 'react'
import { DEFAULT_WORKTREE_PATH, type LinearProject, type NightShiftProject, type RepoBranches, type Settings } from '../../../shared/types'

// Mirrors resolveWorktreePath in the main process, for the example under the field.
function previewPath(template: string, repo: string): string {
  const root = repo.trim() || 'C:\\path\\to\\repo'
  const sep = root.includes('\\') ? '\\' : '/'
  const vars: Record<string, string> = { REPO: root, ID: 'ign-644', TICKET: 'IGN-644', BRANCH: 'chore-ign-644' }
  let p = (template.trim() || DEFAULT_WORKTREE_PATH).replace(/\$(REPO|ID|TICKET|BRANCH)\b/g, (_, k: string) => vars[k])
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) p = `${root}${sep}${p}`
  return p.replace(/[\\/]+/g, sep)
}

interface Props {
  settings: Settings
  linearProjects: LinearProject[] // the team's Linear projects to link to
  focusProjects?: boolean // scroll to the Projects section on open
  onSaved(s: Settings): void
}

const STATE_TYPES = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']

const SECTIONS = [
  { id: 'linear', label: 'Linear' },
  { id: 'projects', label: 'Projects' },
  { id: 'repo', label: 'Repository' },
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'runs', label: 'Runs' },
  { id: 'sharing', label: 'Share settings' }
]

export default function SettingsView({ settings, linearProjects, focusProjects, onSaved }: Props): JSX.Element {
  const [form, setForm] = useState({ ...settings })
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [active, setActive] = useState(focusProjects ? 'projects' : 'linear')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Highlight the section nearest the top of the scroll area.
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onScroll = (): void => {
      const top = root.getBoundingClientRect().top + 90
      let current = SECTIONS[0].id
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id)
        if (el && el.getBoundingClientRect().top <= top) current = s.id
      }
      // At the very bottom, the last section wins even if it's short.
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1].id
      setActive(current)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [])
  const [repo, setRepo] = useState<RepoBranches | null>(null)
  const [fetching, setFetching] = useState(false)

  // Reload the branch list whenever the repo path settles.
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      void window.nightShift.listBranches(form.repoPath).then((r) => live && setRepo(r))
    }, 400)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [form.repoPath])

  async function pickRepo(): Promise<void> {
    const dir = await window.nightShift.pickFolder(form.repoPath || undefined)
    if (!dir) return
    const r = await window.nightShift.listBranches(dir)
    // A folder inside a checkout still means the whole checkout. git reports C:/x, Windows wants C:\x.
    set('repoPath', r.root ? r.root.replace(/\//g, '\\') : dir)
  }

  async function fetchBranches(): Promise<void> {
    setFetching(true)
    try {
      setRepo(await window.nightShift.listBranches(form.repoPath, true))
    } finally {
      setFetching(false)
    }
  }

  // Projects are saved with the rest of the settings.
  function setProject(i: number, patch: Partial<NightShiftProject>): void {
    set(
      'projects',
      form.projects.map((p, j) => (j === i ? { ...p, ...patch } : p))
    )
  }
  function addProject(): void {
    let name = 'New project'
    for (let n = 2; form.projects.some((p) => p.name === name); n++) name = `New project ${n}`
    set('projects', [...form.projects, { id: crypto.randomUUID(), name, linearProjectIds: [] }])
  }
  function removeProject(i: number): void {
    const gone = form.projects[i]
    setForm((f) => ({
      ...f,
      projects: f.projects.filter((_, j) => j !== i),
      activeProjectId: f.activeProjectId === gone.id ? null : f.activeProjectId
    }))
    setSaved(false)
    setDirty(true)
  }

  useEffect(() => {
    if (focusProjects) document.getElementById('projects')?.scrollIntoView({ block: 'start' })
  }, [focusProjects])

  const branchNames = repo?.branches.map((b) => b.name) ?? []
  const baseKnown = branchNames.includes(form.baseBranch)
  const baseOnOrigin = repo?.branches.some((b) => b.name === form.baseBranch && b.remote) ?? false

  function set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    setForm((f) => ({ ...f, [key]: value }))
    setSaved(false)
    setDirty(true)
  }

  async function save(): Promise<void> {
    // activeProjectId is left out: it's set from the sidebar and may have changed since this form opened.
    const { hasLinearKey: _ignored, activeProjectId: _active, ...rest } = form
    const s = await window.nightShift.saveSettings({ ...rest, ...(apiKey ? { linearApiKey: apiKey } : {}) })
    setApiKey('')
    setForm({ ...s })
    onSaved(s)
    setSaved(true)
    setDirty(false)
  }

  const [fileMsg, setFileMsg] = useState<{ text: string; warn?: boolean } | null>(null)

  async function exportFile(): Promise<void> {
    const res = await window.nightShift.exportSettings()
    if (!res) return
    setFileMsg('error' in res ? { text: res.error, warn: true } : { text: `Exported to ${res.path}. It doesn't include your Linear API key.` })
  }

  // Import replaces the form with what was saved; unsaved edits here are dropped.
  async function importFile(): Promise<void> {
    const res = await window.nightShift.importSettings()
    if (!res) return
    if ('error' in res) {
      setFileMsg({ text: res.error, warn: true })
      return
    }
    setForm({ ...res.settings })
    onSaved(res.settings)
    setSaved(false)
    setDirty(false) // import saves straight away
    setFileMsg({ text: ['Settings imported.', ...res.notes].join(' '), warn: res.notes.some((n) => n.includes("doesn't exist")) })
  }

  return (
    <div className="page settings-page" ref={scrollRef}>
      <div className="header settings-header">
        <h1>Settings</h1>
        <div className="right">
          {dirty ? <span className="chip warn-chip">Unsaved changes</span> : saved && <span className="note">Saved</span>}
          <button className="btn primary" type="button" disabled={!dirty && !apiKey} onClick={() => void save()}>
            Save settings
          </button>
        </div>
      </div>

      <div className="settings-layout">
        <div className="settings-main">
        <section id="linear" className="settings-section" aria-labelledby="linear-title">
          <h2 id="linear-title">Linear</h2>
          <p className="section-intro">Where tickets come from and how often Night Shift checks for changes.</p>
          <div className="form">
            <label className="field">
              Linear API key {settings.hasLinearKey ? '(saved, leave blank to keep it)' : ''}
              <input
                className="input"
                type="password"
                value={apiKey}
                placeholder={settings.hasLinearKey ? '••••••••' : 'lin_api_…'}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setSaved(false)
                  setDirty(true)
                }}
              />
            </label>
            <label className="field">
              Linear team key
              <input className="input" value={form.linearTeamKey} onChange={(e) => set('linearTeamKey', e.target.value.trim())} />
            </label>
            <label className="field">
              Check Linear every (seconds)
              <input
                className="input"
                type="number"
                min={15}
                value={form.pollSeconds}
                onChange={(e) => set('pollSeconds', Number(e.target.value) || 60)}
              />
            </label>
            <div className="field wide">
              Hide these Linear state types from the board
              <div className="checks">
                {STATE_TYPES.map((t) => (
                  <label key={t}>
                    <input
                      type="checkbox"
                      checked={form.hiddenStateTypes.includes(t)}
                      onChange={(e) =>
                        set(
                          'hiddenStateTypes',
                          e.target.checked ? [...form.hiddenStateTypes, t] : form.hiddenStateTypes.filter((x) => x !== t)
                        )
                      }
                    />
                    {t === 'canceled' ? 'canceled & duplicate' : t}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </section>
        <section id="projects" className="settings-section" aria-labelledby="projects-title">
          <h2 id="projects-title">Projects</h2>
          <p className="section-intro">Each project shows only the tickets in the Linear projects you link. They appear under Linear in the left nav.</p>
          <div className="form">
            <div className="field wide projects-section">
              {form.projects.map((p, i) => (
                <div key={p.id} className="project-edit">
                  <div className="inputrow">
                    <input
                      className="input"
                      aria-label="Project name"
                      value={p.name}
                      onChange={(e) => setProject(i, { name: e.target.value })}
                    />
                    <button className="btn danger" type="button" onClick={() => removeProject(i)}>
                      Remove
                    </button>
                  </div>
                  <div className="state-picks" role="group" aria-label={`Linear projects for ${p.name}`}>
                    {linearProjects.map((lp) => {
                      const on = p.linearProjectIds.includes(lp.id)
                      return (
                        <button
                          key={lp.id}
                          type="button"
                          className={`state-pick${on ? ' on' : ''}`}
                          aria-pressed={on}
                          onClick={() =>
                            setProject(i, {
                              linearProjectIds: on ? p.linearProjectIds.filter((x) => x !== lp.id) : [...p.linearProjectIds, lp.id],
                              // Name an untitled project after the first Linear project picked.
                              ...(!on && /^New project( \d+)?$/.test(p.name) && !p.linearProjectIds.length ? { name: lp.name } : {})
                            })
                          }
                        >
                          <span className="dot" style={{ background: lp.color }} aria-hidden="true" />
                          {lp.name}
                          {lp.state === 'completed' || lp.state === 'canceled' ? <span className="taken">{lp.state}</span> : null}
                        </button>
                      )
                    })}
                    {!linearProjects.length && <span className="note">Linear projects load once your Linear key and team are set.</span>}
                  </div>
                  {!p.linearProjectIds.length && <span className="note warn">Pick at least one Linear project, or this project shows no tickets.</span>}
                </div>
              ))}
              <div>
                <button className="btn" type="button" onClick={addProject}>
                  Add project
                </button>
              </div>
            </div>
          </div>
        </section>
        <section id="repo" className="settings-section" aria-labelledby="repo-title">
          <h2 id="repo-title">Repository</h2>
          <p className="section-intro">The checkout agents work in, and the branch new ticket branches start from.</p>
          <div className="form">
            <div className="field wide">
              <label htmlFor="repoPath">Repo path (the checkout agents work in)</label>
              <div className="inputrow">
                <input
                  id="repoPath"
                  className="input"
                  value={form.repoPath}
                  placeholder="C:\Development\auto-personalization-poc"
                  onChange={(e) => set('repoPath', e.target.value)}
                />
                <button className="btn" type="button" onClick={() => void pickRepo()}>
                  Browse…
                </button>
              </div>
              {repo && form.repoPath.trim() && (
                <span className={`note${repo.isRepo ? '' : ' warn'}`}>
                  {repo.isRepo
                    ? `Git repo · ${repo.branches.length} ${repo.branches.length === 1 ? 'branch' : 'branches'}${repo.current ? ` · checked out: ${repo.current}` : ''}`
                    : repo.error}
                </span>
              )}
            </div>
            <div className="field wide">
              <label htmlFor="baseBranch">Base branch: new ticket branches start from origin/&lt;this&gt;</label>
              <div className="inputrow">
                {repo?.isRepo && branchNames.length > 0 ? (
                  <select
                    id="baseBranch"
                    className="input"
                    value={form.baseBranch}
                    onChange={(e) => set('baseBranch', e.target.value)}
                  >
                    {!baseKnown && <option value={form.baseBranch}>{form.baseBranch || 'Choose a branch'} (not found)</option>}
                    <optgroup label="On origin">
                      {repo.branches
                        .filter((b) => b.remote)
                        .map((b) => (
                          <option key={b.name} value={b.name}>
                            {b.name}
                          </option>
                        ))}
                    </optgroup>
                    {repo.branches.some((b) => !b.remote) && (
                      <optgroup label="Local only">
                        {repo.branches
                          .filter((b) => !b.remote)
                          .map((b) => (
                            <option key={b.name} value={b.name}>
                              {b.name}
                            </option>
                          ))}
                      </optgroup>
                    )}
                  </select>
                ) : (
                  <input
                    id="baseBranch"
                    className="input"
                    value={form.baseBranch}
                    onChange={(e) => set('baseBranch', e.target.value.trim())}
                  />
                )}
                <button
                  className="btn"
                  type="button"
                  disabled={!repo?.isRepo || fetching}
                  title="git fetch --prune origin, then reload the list"
                  onClick={() => void fetchBranches()}
                >
                  {fetching ? 'Fetching…' : 'Fetch branches'}
                </button>
              </div>
              {repo?.isRepo && form.baseBranch && !baseOnOrigin && (
                <span className="note warn">
                  {baseKnown
                    ? `${form.baseBranch} is only local. The default steps branch off origin/${form.baseBranch}, so push it first.`
                    : `${form.baseBranch} isn't in this repo. Try Fetch branches.`}
                </span>
              )}
            </div>
          </div>
        </section>
        <section id="worktrees" className="settings-section" aria-labelledby="worktrees-title">
          <h2 id="worktrees-title">Worktrees</h2>
          <p className="section-intro">Where each run works. A set of steps can override this on the Steps page.</p>
          <div className="form">
            <div className="field wide">
              New worktrees
              <div className="choices">
                <label className={`choice${form.worktreeMode === 'nightshift' ? ' active' : ''}`}>
                  <input
                    type="radio"
                    name="worktreeMode"
                    checked={form.worktreeMode === 'nightshift'}
                    onChange={() => set('worktreeMode', 'nightshift')}
                  />
                  <span>
                    <strong>Night Shift creates them</strong>
                    <span className="sub">At the path below, before any step runs. Claude starts inside it.</span>
                  </span>
                </label>
                <label className={`choice${form.worktreeMode === 'agent' ? ' active' : ''}`}>
                  <input
                    type="radio"
                    name="worktreeMode"
                    checked={form.worktreeMode === 'agent'}
                    onChange={() => set('worktreeMode', 'agent')}
                  />
                  <span>
                    <strong>Let the agent decide</strong>
                    <span className="sub">
                      Night Shift creates nothing. Steps run in the repo, and steps that need $WORKTREE are skipped.
                    </span>
                  </span>
                </label>
              </div>
            </div>
            {form.worktreeMode === 'nightshift' && (
              <label className="field wide">
                Worktree path ($REPO, $ID, $TICKET, $BRANCH; relative paths go inside the repo)
                <input
                  className="input"
                  value={form.worktreePath}
                  placeholder={DEFAULT_WORKTREE_PATH}
                  onChange={(e) => set('worktreePath', e.target.value)}
                />
                <span className="note">Example for IGN-644: {previewPath(form.worktreePath, form.repoPath)}</span>
              </label>
            )}
          </div>
        </section>
        <section id="runs" className="settings-section" aria-labelledby="runs-title">
          <h2 id="runs-title">Runs</h2>
          <p className="section-intro">How many local runs can go at once, across all sets of steps.</p>
          <div className="form">
            <label className="field">
              Max local runs at once
              <input
                className="input"
                type="number"
                min={1}
                max={10}
                value={form.maxConcurrent}
                onChange={(e) => set('maxConcurrent', Number(e.target.value) || 1)}
              />
            </label>
          </div>
        </section>
        <section id="sharing" className="settings-section" aria-labelledby="sharing-title">
          <h2 id="sharing-title">Share settings</h2>
          <div className="form">
            <div className="field wide">
              <span>Export your projects and general settings to a file, then import it on another machine. The Linear API key is never included.</span>
              <div className="inputrow share-row">
                <button className="btn" type="button" onClick={() => void exportFile()}>
                  Export settings
                </button>
                <button className="btn" type="button" onClick={() => void importFile()}>
                  Import settings
                </button>
              </div>
              {fileMsg && <span className={`note${fileMsg.warn ? ' warn' : ''}`}>{fileMsg.text}</span>}
            </div>
          </div>
        </section>
        </div>
        <nav className="settings-toc" aria-label="Settings sections">
          <div className="listlabel">On this page</div>
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={`toc-link${active === s.id ? ' active' : ''}`}
              aria-current={active === s.id ? 'true' : undefined}
              onClick={(e) => {
                e.preventDefault()
                document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                setActive(s.id)
              }}
            >
              {s.label}
            </a>
          ))}
        </nav>
      </div>
    </div>
  )
}
