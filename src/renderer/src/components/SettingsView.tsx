import { useEffect, useRef, useState } from 'react'
import ConflictBanner from './ConflictBanner'
import SaveStatus from './SaveStatus'
import RestartButton from './RestartButton'
import { DEFAULT_HOST_PORT, DEFAULT_WORKTREE_PATH, type HostSettings, type HostStatus, type ImportGroupKey, type RemoteStatus, type ImportPreview, type RepoBranches, type Settings, type UpdateState } from '../../../shared/types'

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
  onSaved(s: Settings): void
}

const STATE_TYPES = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']

const ALL_SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'linear', label: 'Linear' },
  { id: 'github', label: 'GitHub' },
  { id: 'machine', label: 'Remote access' },
  { id: 'repo', label: 'Repository', local: true },
  { id: 'worktrees', label: 'Worktrees', local: true },
  { id: 'runs', label: 'Runs', local: true },
  { id: 'hostmachine', label: 'Host machine', remote: true },
  { id: 'sharing', label: 'Share settings' },
  { id: 'about', label: 'About' }
]

export default function SettingsView({ settings, onSaved }: Props): JSX.Element {
  const [form, setForm] = useState({ ...settings })
  const [apiKey, setApiKey] = useState('')
  const [ghToken, setGhToken] = useState('') // typed but not saved yet; '' keeps the saved one
  const [removeGh, setRemoveGh] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [active, setActive] = useState('appearance')
  const remote = settings.mode === 'remote' // as saved; switching applies on Save
  const SECTIONS = ALL_SECTIONS.filter((x) => (remote ? !x.local : !x.remote))
  const scrollRef = useRef<HTMLDivElement>(null)

  // Highlight the section nearest the top of the scroll area.
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onScroll = (): void => {
      const top = root.getBoundingClientRect().top + 80 // near the top of the scroll area
      let current = SECTIONS[0].id
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id)
        if (el && el.getBoundingClientRect().top <= top) current = s.id
      }
      setActive(current)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [remote])
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

  const branchNames = repo?.branches.map((b) => b.name) ?? []
  const baseKnown = branchNames.includes(form.baseBranch)
  const baseOnOrigin = repo?.branches.some((b) => b.name === form.baseBranch && b.remote) ?? false

  // Remote mode: live connection status, and a test before switching.
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatus | null>(null)
  const [remoteTest, setRemoteTest] = useState<{ text: string; ok: boolean } | null>(null)
  const [testing, setTesting] = useState(false)
  useEffect(() => {
    void window.nightShift.getRemoteStatus?.().then(setRemoteStatus)
    return window.nightShift.onRemoteStatus?.(setRemoteStatus)
  }, [])
  // "dylandesktop.tail1a8202.ts.net:47615" pasted into the host box fills in both fields.
  function setRemoteHost(value: string): void {
    const m = /^(?:https?:\/\/)?([^\s/:]+):(\d{2,5})\/?$/.exec(value.trim())
    set('remote', m ? { host: m[1], port: Number(m[2]) } : { ...form.remote, host: value.trim() })
    setRemoteTest(null)
  }
  async function testRemote(): Promise<void> {
    if (!window.nightShift.testRemote) return
    setTesting(true)
    const r = await window.nightShift.testRemote(form.remote)
    setTesting(false)
    setRemoteTest('error' in r ? { text: r.error, ok: false } : { text: `Connected to ${r.name} · Night Shift ${r.appVersion}`, ok: true })
  }
  const [conflict, setConflict] = useState<string | null>(null)

  // Host: status comes live from the main process; the settings apply on Save.
  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null)
  const [hostLogins, setHostLogins] = useState(settings.host.allowedLogins.join(', '))
  const [hostCopied, setHostCopied] = useState(false)
  const [dirtyHost, setDirtyHost] = useState(false)
  useEffect(() => {
    void window.nightShift.getHostStatus?.().then(setHostStatus)
    return window.nightShift.onHostStatus?.(setHostStatus)
  }, [])
  // This machine's role. Host and remote are exclusive, so they're one choice.
  type Role = 'local' | 'host' | 'remote'
  const roleOf = (x: Settings): Role => (x.mode === 'remote' ? 'remote' : x.host.enabled ? 'host' : 'local')
  const role = roleOf(form)
  const savedRole = roleOf(settings)
  function chooseRole(r: Role): void {
    setForm((f) => ({ ...f, mode: r === 'remote' ? 'remote' : 'local', host: { ...f.host, enabled: r === 'host' } }))
    setSaved(false)
    setDirty(true)
    setRemoteTest(null)
  }
  function setHost(patch: Partial<HostSettings>): void {
    set('host', { ...form.host, ...patch })
    setDirtyHost(true)
  }

  function set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    setForm((f) => ({ ...f, [key]: value }))
    setSaved(false)
    setDirty(true)
  }

  async function save(): Promise<void> {
    // activeProjectId is left out: it's set from the sidebar and may have changed since this form opened.
    const { hasLinearKey: _ignored, hasGithubToken: _gh, activeProjectId: _active, ...rest } = form
    setSaving(true)
    const s = await window.nightShift.saveSettings({ ...rest, ...(apiKey ? { linearApiKey: apiKey } : {}), ...(ghToken ? { githubToken: ghToken } : removeGh ? { githubToken: '' } : {}) }).finally(() => setSaving(false))
    setApiKey('')
    setGhToken('')
    setRemoveGh(false)
    if (s.saveError) {
      // Shared settings clashed with an edit elsewhere: nothing shared was saved; keep the form as typed.
      setConflict(s.saveError.message)
      onSaved(s)
      return
    }
    setConflict(null)
    setForm({ ...s })
    setHostLogins(s.host.allowedLogins.join(', '))
    setDirtyHost(false)
    onSaved(s)
    setSaved(true)
    setDirty(false)
  }

  function discard(): void {
    setForm({ ...settings })
    setApiKey('')
    setGhToken('')
    setRemoveGh(false)
    setHostLogins(settings.host.allowedLogins.join(', '))
    setDirtyHost(false)
    setConflict(null)
    setDirty(false)
  }

  // Theme saves on its own, without the Save button, so the change shows at once.
  async function chooseTheme(theme: Settings['theme']): Promise<void> {
    setForm((f) => ({ ...f, theme }))
    const saved = await window.nightShift.saveSettings({ theme })
    onSaved(saved)
  }

  const [fileMsg, setFileMsg] = useState<{ text: string; warn?: boolean } | null>(null)

  async function exportFile(): Promise<void> {
    const res = await window.nightShift.exportSettings()
    if (!res) return
    setFileMsg('error' in res ? { text: res.error, warn: true } : { text: `Exported to ${res.path}. It doesn't include your Linear API key.` })
  }

  // Import is two steps: pick a file and see what's in it, then apply the parts that are ticked.
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [keep, setKeep] = useState<Set<ImportGroupKey>>(new Set())

  const hasLocal = (key: ImportGroupKey): boolean =>
    key === 'projects' ? settings.projects.length > 0 : key === 'automations' ? settings.automations.length > 0 : false

  async function chooseImportFile(): Promise<void> {
    const res = await window.nightShift.previewImport()
    if (!res) return
    if ('error' in res) {
      setFileMsg({ text: res.error, warn: true })
      return
    }
    setFileMsg(null)
    setPreview(res)
    // Leave out parts that would only clear what's here (an empty list in the file).
    setKeep(new Set(res.groups.filter((g) => !g.empty || !hasLocal(g.key)).map((g) => g.key)))
  }

  // Applying replaces the form with what was saved; unsaved edits here are dropped.
  async function applyImport(): Promise<void> {
    const res = await window.nightShift.applyImport([...keep])
    if ('error' in res) {
      setFileMsg({ text: res.error, warn: true })
      return
    }
    setPreview(null)
    setApiKey('')
    setGhToken('')
    setRemoveGh(false)
    setForm({ ...res.settings })
    onSaved(res.settings)
    setSaved(false)
    setDirty(false) // import saves straight away
    setFileMsg({ text: ['Imported.', ...res.notes].join(' '), warn: res.notes.some((n) => n.includes("doesn't exist")) })
  }

  const anyChange = dirty || !!apiKey || !!ghToken || removeGh
  const jump = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActive(id)
  }

  return (
    <div className="st-page">
      <header className="actions-head st-head">
        <div className="actions-title">
          <div className="actions-title-row">
            <h1>Settings</h1>
          </div>
          <div className="actions-path">
            {remote ? 'This machine is a remote. Runs, actions and automations come from the host.' : 'How Night Shift connects to Linear and GitHub, and where agents work.'}
          </div>
        </div>
        <SaveStatus dirty={anyChange} saving={saving} saved={saved} onSave={() => void save()} />
        <button className="btn" type="button" disabled={!anyChange || saving} onClick={discard}>
          Discard
        </button>
        <button className="btn primary" type="button" disabled={!anyChange || saving} onClick={() => void save()}>
          Save settings
        </button>
      </header>
      {conflict && (
        <div className="st-banners">
          <ConflictBanner
            message={conflict}
            onLoadTheirs={discard}
            onKeepMine={() => (setForm((f) => ({ ...f, sharedRevs: settings.sharedRevs })), setConflict(null))}
          />
        </div>
      )}

      <div className="st-body">
        <nav className="st-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={`st-nav-item${active === s.id ? ' active' : ''}`}
              aria-current={active === s.id ? 'true' : undefined}
              onClick={(e) => {
                e.preventDefault()
                jump(s.id)
              }}
            >
              {s.label}
            </a>
          ))}
        </nav>
        <div className="st-scroll" ref={scrollRef}>
        <div className="st-main">
        <section id="appearance" className="settings-section" aria-labelledby="appearance-title">
          <div className="st-card-head">
            <h2 id="appearance-title">Appearance</h2>
            <p className="section-intro">Applies straight away. This machine only; it isn&apos;t in the exported file.</p>
          </div>
          <div className="form">
            <div className="field wide">
              Theme
              <div className="choices three" role="radiogroup" aria-label="Theme">
                {(
                  [
                    ['system', 'Match Windows', 'Follows your Windows light or dark setting.'],
                    ['dark', 'Dark', 'Night Shift stays dark.'],
                    ['light', 'Light', 'Night Shift stays light.']
                  ] as const
                ).map(([value, title, sub]) => (
                  <label key={value} className={`choice${form.theme === value ? ' active' : ''}`}>
                    <input type="radio" name="theme" checked={form.theme === value} onChange={() => void chooseTheme(value)} />
                    <span>
                      <strong>{title}</strong>
                      <span className="sub">{sub}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </section>
        <section id="linear" className="settings-section" aria-labelledby="linear-title">
          <div className="st-card-head">
            <h2 id="linear-title">Linear</h2>
            <p className="section-intro">Where tickets come from and how often Night Shift checks for changes.</p>
          </div>
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
              Reload the board from Linear every (minutes)
              <input
                className="input"
                type="number"
                min={1}
                max={120}
                value={form.boardRefreshMinutes}
                onChange={(e) => set('boardRefreshMinutes', Number(e.target.value) || 5)}
              />
              <span className="note">This machine only. The arrows next to Run action reload it now.</span>
            </label>
            <label className="field">
              Automations check Linear every (seconds)
              <input
                className="input"
                type="number"
                min={15}
                value={form.pollSeconds}
                onChange={(e) => set('pollSeconds', Number(e.target.value) || 60)}
              />
              <span className="note">{remote ? 'Shared: automations run on the host.' : 'Shared with remotes. Automations only run on this machine.'}</span>
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
            <div className="field wide">
              Column order
              <div className="row-actions">
                <span className="note">
                  {form.columnOrder?.length ? 'Your own order. Drag column headers on the board to change it.' : "Linear's order. Drag column headers on the board to change it."}
                </span>
                {(form.columnOrder?.length ?? 0) > 0 && (
                  <button className="btn small" type="button" onClick={() => set('columnOrder', [])}>
                    Reset to Linear&apos;s order
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
        <section id="github" className="settings-section" aria-labelledby="github-title">
          <div className="st-card-head">
            <h2 id="github-title">GitHub</h2>
            <p className="section-intro">Shows each ticket's pull request checks and conflicts, and lets you merge from the ticket panel.</p>
          </div>
          <div className="form">
            <label className="field">
              GitHub token {settings.hasGithubToken && !removeGh ? '(saved, leave blank to keep it)' : ''}
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={ghToken}
                placeholder={settings.hasGithubToken && !removeGh ? '••••••••' : 'github_pat_…'}
                onChange={(e) => {
                  setGhToken(e.target.value)
                  setRemoveGh(false)
                  setSaved(false)
                }}
              />
            </label>
            <p className="note">
              Make a fine-grained token on GitHub (Settings › Developer settings › Personal access tokens) for the repository, with: Pull requests: Read and write, Contents: Read and write (to delete the branch after a merge), Actions: Read and Commit statuses: Read (for checks). Read-only is enough if you only want to see status. It stays on this machine and isn&apos;t shared or exported.
            </p>
            {settings.hasGithubToken && !ghToken && (
              <div>
                <button
                  className="btn small"
                  type="button"
                  onClick={() => {
                    setRemoveGh((x) => !x)
                    setSaved(false)
                  }}
                >
                  {removeGh ? 'Keep the saved token' : 'Remove the saved token'}
                </button>
              </div>
            )}
          </div>
        </section>
        <section id="machine" className="settings-section" aria-labelledby="machine-title">
          <div className="st-card-head">
            <h2 id="machine-title">Remote access</h2>
            <p className="section-intro">
              Use Night Shift across your machines over Tailscale. One machine is the host and runs every agent; others connect to it as remotes. A machine is one or the other, never both.
            </p>
          </div>
          <div className="form">
            <div className="field wide">
              This machine
              <div className="choices three" role="radiogroup" aria-label="This machine's role">
                {(
                  [
                    ['local', 'On its own', 'Runs agents here. No other machine can connect.'],
                    ['host', 'Host', 'Runs agents here, and your other devices can connect to it.'],
                    ['remote', 'Remote', 'Uses another machine\'s agents, runs, actions and automations.']
                  ] as const
                ).map(([value, title, sub]) => (
                  <label key={value} className={`choice${role === value ? ' active' : ''}`}>
                    <input type="radio" name="machine-role" checked={role === value} onChange={() => chooseRole(value)} />
                    <span>
                      <strong>{title}</strong>
                      <span className="sub">{sub}</span>
                    </span>
                  </label>
                ))}
              </div>
              {role !== savedRole && <span className="note">Save settings to switch.{role === 'remote' || savedRole === 'remote' ? ' The window reloads.' : ''}</span>}
            </div>
            {role === 'host' && (
              <>
                <p className="note field wide">Listens on this machine's Tailscale address only, never on your local network or the internet. Only devices signed in to Tailscale as you can connect.</p>
                <label className="field">
                  Host name
                  <input
                    className="input"
                    value={form.host.name}
                    placeholder={hostStatus?.name || 'Tailscale machine name'}
                    onChange={(e) => setHost({ name: e.target.value })}
                  />
                </label>
                <label className="field">
                  Port
                  <input
                    className="input"
                    type="number"
                    min={1024}
                    max={65535}
                    value={form.host.port}
                    onChange={(e) => setHost({ port: Number(e.target.value) || DEFAULT_HOST_PORT })}
                  />
                </label>
                <label className="field wide">
                  Also allow these Tailscale logins (optional)
                  <input
                    className="input"
                    value={hostLogins}
                    placeholder="name@example.com, …"
                    onChange={(e) => {
                      setHostLogins(e.target.value)
                      setHost({ allowedLogins: e.target.value.split(/[\s,;]+/).filter(Boolean) })
                    }}
                  />
                  <span className="note">
                    {hostStatus?.login ? `Devices signed in as ${hostStatus.login} are always allowed.` : 'Devices signed in to Tailscale as you are always allowed.'}
                  </span>
                </label>
                <div className="field wide" role="status">
                  <span>
                    {!hostStatus || hostStatus.state === 'off'
                      ? 'Off.'
                      : hostStatus.state === 'listening'
                        ? `Listening on ${hostStatus.addresses.map((a) => (a.includes(':') ? `[${a}]` : a) + `:${hostStatus.port}`).join(' and ')}.`
                        : hostStatus.state === 'waiting'
                          ? `Waiting for Tailscale: ${hostStatus.error ?? ''}. Trying again every 15 seconds.`
                          : `Not listening: ${hostStatus.error ?? 'unknown error'}.`}
                    {hostStatus?.lastCaller && ` Last request from ${hostStatus.lastCaller.device} at ${new Date(hostStatus.lastCaller.at).toLocaleTimeString()}.`}
                  </span>
                  {hostStatus?.state === 'listening' && hostStatus.dnsName && (
                    <div className="inputrow">
                      <span className="mono">{`${hostStatus.dnsName}:${hostStatus.port}`}</span>
                      <button
                        className="btn small"
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(`${hostStatus.dnsName}:${hostStatus.port}`)
                          setHostCopied(true)
                          window.setTimeout(() => setHostCopied(false), 1500)
                        }}
                      >
                        {hostCopied ? 'Copied' : 'Copy connection'}
                      </button>
                    </div>
                  )}
                  {dirtyHost && savedRole === 'host' && <span className="note">Save settings to apply host changes.</span>}
                </div>
              </>
            )}
            {role === 'remote' && (
              <>
                <p className="note field wide">The board still comes straight from Linear with this machine's key. Everything else comes from the host.</p>
                <label className="field">
                  Host
                  <input
                    className="input"
                    value={form.remote.host}
                    placeholder="dylandesktop.tail1a8202.ts.net"
                    onChange={(e) => setRemoteHost(e.target.value)}
                  />
                  <span className="note">Its Tailscale name, as shown on the host under Settings › Remote access. Pasting name:port fills in both.</span>
                </label>
                <label className="field">
                  Port
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.remote.port}
                    onChange={(e) => (set('remote', { ...form.remote, port: Number(e.target.value) || DEFAULT_HOST_PORT }), setRemoteTest(null))}
                  />
                </label>
                <div className="field wide" role="status">
                  <div className="inputrow">
                    <button className="btn small" type="button" disabled={!form.remote.host || testing} onClick={() => void testRemote()}>
                      {testing ? 'Testing…' : 'Test connection'}
                    </button>
                    {remoteTest && <span className={remoteTest.ok ? 'note' : 'note warn-text'}>{remoteTest.text}</span>}
                  </div>
                  {remote && remoteStatus && (
                    <span className="note">
                      {remoteStatus.state === 'connected'
                        ? `Connected to ${remoteStatus.name ?? remoteStatus.host} (Night Shift ${remoteStatus.appVersion ?? '?'}).`
                        : remoteStatus.state === 'connecting'
                          ? `Connecting to ${remoteStatus.host}…`
                          : remoteStatus.state === 'incompatible'
                            ? remoteStatus.error
                            : `Can't reach ${remoteStatus.name ?? remoteStatus.host}${remoteStatus.since ? ` since ${new Date(remoteStatus.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}. Trying again every 10 seconds.`}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
        {remote && (
          <section id="hostmachine" className="settings-section" aria-labelledby="hostmachine-title">
            <div className="st-card-head">
              <h2 id="hostmachine-title">Host machine</h2>
              <p className="section-intro">Set on the host. Shown here for reference.</p>
            </div>
            <div className="form">
              <div className="field wide">
                Repository
                <span className="mono">{settings.repoPath || '(not set on the host)'}</span>
              </div>
              <div className="field wide">
                Base branch
                <input className="input" value={form.baseBranch} onChange={(e) => set('baseBranch', e.target.value.trim())} />
                <span className="note">Shared: new worktrees and global actions on the host start from it.</span>
              </div>
              <div className="field wide">
                Worktree path
                <span className="mono">{settings.worktreePath}</span>
              </div>
              <div className="field">
                Max runs at once
                <span className="mono">{settings.maxConcurrent}</span>
              </div>
            </div>
          </section>
        )}
        {!remote && (
          <>
        <section id="repo" className="settings-section" aria-labelledby="repo-title">
          <div className="st-card-head">
            <h2 id="repo-title">Repository</h2>
            <p className="section-intro">The checkout agents work in, and the branch new ticket branches start from.</p>
          </div>
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
          <div className="st-card-head">
            <h2 id="worktrees-title">Worktrees</h2>
            <p className="section-intro">Where each run works. An action can override this on the Actions page.</p>
          </div>
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
          <div className="st-card-head">
            <h2 id="runs-title">Runs</h2>
            <p className="section-intro">How many local runs can go at once, across all actions.</p>
          </div>
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
          </>
        )}
        <section id="sharing" className="settings-section" aria-labelledby="sharing-title">
          <div className="st-card-head">
            <h2 id="sharing-title">Share settings</h2>
            <p className="section-intro">Move your projects, automations and general settings to another machine.</p>
          </div>
          <div className="form">
            <div className="field wide">
              <span>Export to a file here, then import it on the other machine. Projects and automations come along too; automations arrive switched off. The Linear API key is never included; add it on each machine.</span>
              <div className="inputrow share-row">
                <button className="btn" type="button" onClick={() => void exportFile()}>
                  Export settings
                </button>
                <button className="btn" type="button" onClick={() => void chooseImportFile()}>
                  Import settings…
                </button>
              </div>
              {preview && (
                <fieldset className="import-preview">
                  <legend>
                    Import from <span className="mono">{preview.fileName}</span>: choose what to bring in
                  </legend>
                  {preview.groups.map((g) => (
                    <label key={g.key} className="check-row">
                      <input
                        type="checkbox"
                        checked={keep.has(g.key)}
                        onChange={(e) =>
                          setKeep((k) => {
                            const next = new Set(k)
                            if (e.target.checked) next.add(g.key)
                            else next.delete(g.key)
                            return next
                          })
                        }
                      />
                      <span>
                        <strong>{g.label}</strong>
                        <span className="sub">{g.summary}</span>
                        {g.notes.map((n) => (
                          <span key={n} className="sub warn-text">
                            {n}
                          </span>
                        ))}
                      </span>
                    </label>
                  ))}
                  {dirty && <span className="note warn">Your unsaved changes on this page will be replaced.</span>}
                  <div className="inputrow share-row">
                    <button className="btn primary" type="button" disabled={!keep.size} onClick={() => void applyImport()}>
                      Import selected ({keep.size})
                    </button>
                    <button className="btn" type="button" onClick={() => setPreview(null)}>
                      Cancel
                    </button>
                  </div>
                </fieldset>
              )}
              {fileMsg && <span className={`note${fileMsg.warn ? ' warn' : ''}`}>{fileMsg.text}</span>}
            </div>
          </div>
        </section>
        <section id="about" className="settings-section" aria-labelledby="about-title">
          <div className="st-card-head">
            <h2 id="about-title">About</h2>
            <p className="section-intro">The version you&apos;re running and its updates.</p>
          </div>
          <div className="form">
            <AboutVersion />
          </div>
        </section>
        </div>
        </div>
      </div>
    </div>
  )
}

function AboutVersion(): JSX.Element {
  const [u, setU] = useState<UpdateState | null>(null)
  useEffect(() => {
    void window.nightShift.getUpdateState?.().then(setU)
    return window.nightShift.onUpdateState?.(setU)
  }, [])
  const status = !u
    ? ''
    : u.status === 'dev'
      ? 'Development build: updates are only checked in the installed app.'
      : u.status === 'checking'
        ? 'Checking for updates…'
        : u.status === 'downloading'
          ? `Downloading ${u.available ?? 'an update'}${u.percent ? ` (${u.percent}%)` : ''}…`
          : u.status === 'ready'
            ? `Version ${u.available} is ready. Restart to install it, or it installs when you quit.`
            : u.status === 'error'
              ? "Couldn't check for updates (offline?). It tries again in a few hours."
              : u.checkedAt
                ? `Up to date. Last checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
                : 'Up to date.'
  return (
    <div className="field wide">
      Version
      <div className="row-actions">
        <span className="mono" style={{ fontSize: 13, color: 'var(--text)' }}>
          {u ? u.version : 'Restart Night Shift to see the version.'}
        </span>
        <span className="note">{status}</span>
        {u?.status === 'ready' ? (
          <RestartButton />
        ) : (
          u &&
          u.status !== 'dev' && (
            <button
              className="btn small"
              type="button"
              disabled={u.status === 'checking' || u.status === 'downloading' || !window.nightShift.checkForUpdates}
              onClick={() => void window.nightShift.checkForUpdates?.().then(setU)}
            >
              {u.status === 'checking' ? 'Checking…' : 'Check for updates'}
            </button>
          )
        )}
      </div>
    </div>
  )
}
