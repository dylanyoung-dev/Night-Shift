import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TicketChartCard, TicketTiles, useTicketStats } from './TicketStatsSection'
import { Icon } from './Icons'
import type { PlanLimits, TokenCounts, UsageDay, UsageReport, UsageSlice } from '../../../shared/types'

type Metric = 'all' | 'work' | 'output' | 'cacheRead' | 'messages'
const METRICS: { id: Metric; label: string; hint: string }[] = [
  { id: 'all', label: 'All tokens', hint: 'Input, output and cache, everything the model processed' },
  { id: 'work', label: 'Input + output', hint: 'New tokens in and out, leaving cache out' },
  { id: 'output', label: 'Output', hint: 'Tokens Claude wrote' },
  { id: 'cacheRead', label: 'Cache reads', hint: 'Context re-read from the prompt cache' },
  { id: 'messages', label: 'Messages', hint: 'Model replies' }
]
const RANGES = [7, 30, 90]

const total = (t: TokenCounts): number => t.input + t.output + t.cacheWrite + t.cacheRead
function value(t: TokenCounts, m: Metric): number {
  if (m === 'all') return total(t)
  if (m === 'work') return t.input + t.output
  if (m === 'output') return t.output
  if (m === 'cacheRead') return t.cacheRead
  return t.messages
}

export function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
  return String(Math.round(n))
}
const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions): string => new Date(`${d}T12:00:00`).toLocaleDateString([], opts)

export default function UsageView(): JSX.Element {
  const api = window.nightShift
  const [days, setDays] = useState(30)
  const [metric, setMetric] = useState<Metric>('all')
  const [report, setReport] = useState<UsageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0) // the Refresh button: rebuild the ticket numbers too
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [asTable, setAsTable] = useState(false)
  const [limits, setLimits] = useState<PlanLimits | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  useEffect(() => {
    void api.getLimits?.().then(setLimits)
    return api.onLimits?.(setLimits)
  }, [])

  async function checkNow(): Promise<void> {
    if (!api.checkLimits) return
    setChecking(true)
    setCheckError(null)
    const r = await api.checkLimits()
    if ('error' in r) setCheckError(r.error)
    else setLimits(r)
    setChecking(false)
  }

  async function load(refresh = false): Promise<void> {
    if (!api.getUsage) {
      setError('Restart Night Shift to turn on the usage page.')
      return
    }
    setLoading(true)
    setError(null)
    const poll = window.setInterval(() => {
      void api.usageProgress?.().then((p) => setProgress(p.scanning ? p : null))
    }, 400)
    try {
      setReport(await api.getUsage(days, refresh))
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      window.clearInterval(poll)
      setProgress(null)
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(id)
  }, [days])

  const w = report?.window
  const ns = report ? total(report.nightShift) : 0
  const periodTotal = report ? total(report.period) : 0
  const tickets = useTicketStats(days, report?.generatedAt ?? 0, refreshTick)
  const peak = report?.daily.reduce<UsageDay | null>((best, d) => (!best || value(d, metric) > value(best, metric) ? d : best), null)

  return (
    <div className="usage-page">
      <header className="u-head">
        <div className="u-head-title">
          <h1>Claude Code usage</h1>
          <span className="note">From Claude Code&apos;s session logs on this machine. Includes your own sessions and Night Shift&apos;s runs.</span>
        </div>
        <div className="u-seg" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={days === r} onClick={() => setDays(r)}>
              {r} days
            </button>
          ))}
        </div>
        <button className={`btn${loading ? ' spinning-icon' : ''}`} type="button" onClick={() => (setRefreshTick((n) => n + 1), void load(true))} disabled={loading}>
          <Icon name="refresh" size={14} />
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </header>

      <div className="u-scroll">
        <div className="u-body">
          {error && <div className="empty">{error}</div>}
          {!report && !error && (
            <div className="empty">
              {progress ? `Reading session logs… ${progress.done} of ${progress.total} files. The first time takes a while; after that only new lines are read.` : 'Reading session logs…'}
            </div>
          )}

          {report && (
            <>
              <div className="u-row">
                <PlanCard
                  limits={limits}
                  now={report.generatedAt}
                  checking={checking}
                  error={checkError}
                  onCheck={api.checkLimits ? () => void checkNow() : undefined}
                  window={w ? { total: total(w), messages: w.messages, perMinute: w.perMinute, start: w.start, end: w.end } : null}
                />
                <Tile label="Today" t={report.today} />
                <Tile label="Last 7 days" t={report.week} />
                <section className="u-card u-tile u-grow">
                  <h2 className="u-tile-label">Night Shift runs · {days} days</h2>
                  <span className="u-tile-value big">{fmt(ns)}</span>
                  <span className="u-tile-sub">
                    {periodTotal ? `${Math.round((ns / periodTotal) * 100)}% of all tokens` : 'No usage yet'} · {report.nightShift.messages} messages
                  </span>
                  {periodTotal > 0 && (
                    <div className="u-share">
                      <div className="u-share-bar" role="img" aria-label={`Night Shift ${Math.round((ns / periodTotal) * 100)}% of all tokens`}>
                        <span style={{ width: `${(ns / periodTotal) * 100}%`, background: 'var(--cat-2)' }} />
                        <span style={{ flex: 1, background: 'var(--cat-1)' }} />
                      </div>
                      <div className="u-legend">
                        <span>
                          <i style={{ background: 'var(--cat-2)' }} />
                          Night Shift
                        </span>
                        <span>
                          <i style={{ background: 'var(--cat-1)' }} />
                          Your sessions
                        </span>
                      </div>
                    </div>
                  )}
                </section>
              </div>

              <section className="u-section" aria-labelledby="u-tickets">
                <h2 id="u-tickets" className="sec-label">
                  Tickets
                  {tickets.stats && (
                    <span className="sec-label-note" title="Saved on this machine and updated every 15 minutes">
                      Updated {clock(tickets.stats.generatedAt)}
                    </span>
                  )}
                </h2>
                <TicketTiles stats={tickets.stats} supported={tickets.supported} days={days} />
              </section>

              <div className="u-row">
                {tickets.supported && <TicketChartCard stats={tickets.stats} days={days} />}
                <section className="u-card u-chart" aria-labelledby="u-bchart">
                  <div className="u-chart-head">
                    <div className="u-chart-title">
                      <h2 id="u-bchart">{metric === 'messages' ? 'Messages' : 'Tokens used'}</h2>
                      <span className="note">
                        {fmt(value(report.period, metric))} in the last {days} days
                        {peak && value(peak, metric) > 0 ? ` · peak ${dayLabel(peak.date, { month: 'short', day: 'numeric' })}, ${fmt(value(peak, metric))}` : ''}
                      </span>
                    </div>
                    <select className="u-select" value={metric} onChange={(e) => setMetric(e.target.value as Metric)} aria-label="Measure" title={METRICS.find((m) => m.id === metric)?.hint}>
                      {METRICS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <label className="u-check">
                      <input type="checkbox" checked={asTable} onChange={(e) => setAsTable(e.target.checked)} />
                      Show as table
                    </label>
                  </div>
                  {asTable ? <DayTable days={report.daily} /> : <DayChart days={report.daily} metric={metric} />}
                </section>
              </div>

              <div className="u-row">
                <ModelCard title="By model" days={days} rows={report.byModel} />
                <FolderCard title="By folder" days={days} rows={report.byProject} />
              </div>

              <p className="note usage-foot">
                Read from {report.files} session files in {report.sources.join(', ') || 'no Claude folder found'}. Token counts are what Claude reported for each reply on this machine. Plan limits come from Claude itself, so they match /usage and include every device you use. Updated {clock(report.generatedAt)}.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: 'Current session',
  seven_day: 'Weekly, all models',
  seven_day_opus: 'Weekly, Opus',
  seven_day_sonnet: 'Weekly, Sonnet'
}
const WINDOW_SUBS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: '7-day limit',
  seven_day_opus: '7-day limit',
  seven_day_sonnet: '7-day limit'
}
const windowName = (k: string): string => WINDOW_NAMES[k] ?? k.replace(/_/g, ' ')
function resetLabel(t: number, now: number): string {
  const sameDay = new Date(t).toDateString() === new Date(now).toDateString()
  return sameDay ? clock(t) : new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

// A ring showing how much of a plan limit is used: amber from 75%, red from 90%.
function Ring({ pct, label }: { pct: number; label: string }): JSX.Element {
  const r = 34
  const c = 2 * Math.PI * r
  const tone = pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : ''
  return (
    <svg className={`u-ring ${tone}`} width="84" height="84" viewBox="0 0 84 84" role="img" aria-label={`${label}, ${pct}% used`}>
      <circle cx="42" cy="42" r={r} className="track" />
      {pct > 0 && <circle cx="42" cy="42" r={r} className="arc" strokeDasharray={`${(c * Math.min(100, pct)) / 100} ${c}`} transform="rotate(-90 42 42)" />}
      <text x="42" y="47" textAnchor="middle">
        {pct}%
      </text>
    </svg>
  )
}

function PlanCard({
  limits,
  now,
  checking,
  error,
  onCheck,
  window: win5
}: {
  limits: PlanLimits | null
  now: number
  checking: boolean
  error: string | null
  onCheck?: () => void
  window: { total: number; messages: number; perMinute: number; start: number; end: number } | null
}): JSX.Element {
  const order = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']
  const keys = limits ? Object.keys(limits.windows).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)) : []
  const elapsed = win5 ? Math.min(100, Math.max(0, ((now - win5.start) / (win5.end - win5.start)) * 100)) : 0
  return (
    <section className="u-card u-plan" aria-labelledby="u-limits">
      <div className="u-plan-head">
        <h2 id="u-limits">Plan limits</h2>
        {limits && (
          <span className="note">
            As of {clock(limits.seenAt)}
            {new Date(limits.seenAt).toDateString() !== new Date(now).toDateString() ? ` on ${new Date(limits.seenAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''},{' '}
            {limits.source === 'check' ? 'from Check now' : 'from a Night Shift run'}
          </span>
        )}
        {onCheck && (
          <button className="btn small" type="button" onClick={onCheck} disabled={checking} title="Sends Claude one very short Haiku message to get fresh numbers">
            {checking ? 'Checking…' : 'Check now'}
          </button>
        )}
      </div>
      {error && <div className="note warn">{error}</div>}
      <div className="u-plan-body">
        {!limits && <p className="note u-limit">No numbers yet. They arrive with the next Night Shift run, or press Check now.</p>}
        {keys.map((k) => {
          const lim = limits!.windows[k]
          const reset = lim.resetsAt !== undefined && lim.resetsAt <= now
          const pct = reset ? 0 : Math.round(lim.utilization * 100)
          return (
            <div key={k} className="u-limit">
              <Ring pct={pct} label={windowName(k)} />
              <div className="u-limit-text">
                <span className="u-limit-name">{windowName(k)}</span>
                {WINDOW_SUBS[k] && <span className="u-limit-sub">{WINDOW_SUBS[k]}</span>}
                <span className="note">
                  {reset ? `Reset at ${resetLabel(lim.resetsAt!, now)} since the last report` : lim.resetsAt ? `Resets ${resetLabel(lim.resetsAt, now)}` : ''}
                </span>
              </div>
            </div>
          )
        })}
        <div className="u-window">
          <span className="note">Tokens this 5-hour window</span>
          {win5 ? (
            <>
              <span className="u-tile-value">{fmt(win5.total)}</span>
              <span className="u-tile-sub">
                {win5.messages} messages since {clock(win5.start)} · about {fmt(win5.perMinute)} a minute
              </span>
              <div className="u-window-bar" role="img" aria-label={`${Math.round(elapsed)}% of the window has passed`}>
                <div style={{ width: `${elapsed}%` }} />
              </div>
              <div className="u-window-ends">
                <span>{clock(win5.start)}</span>
                <span>Window ends about {clock(win5.end)} · this machine only</span>
              </div>
            </>
          ) : (
            <>
              <span className="u-tile-value">0</span>
              <span className="u-tile-sub">No Claude Code activity on this machine in the last 5 hours.</span>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function Tile({ label, t }: { label: string; t: TokenCounts }): JSX.Element {
  return (
    <section className="u-card u-tile u-grow">
      <h2 className="u-tile-label">{label}</h2>
      <span className="u-tile-value big">{fmt(total(t))}</span>
      <span className="u-tile-sub">
        {fmt(t.input + t.output)} in + out · {fmt(t.cacheRead + t.cacheWrite)} cache · {t.messages.toLocaleString()} messages
      </span>
    </section>
  )
}

function DayChart({ days, metric }: { days: UsageDay[]; metric: Metric }): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [hover, setHover] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const H = 220
  const pad = { l: 48, r: 8, t: 12, b: 26 }
  const plotW = Math.max(100, width - pad.l - pad.r)
  const plotH = H - pad.t - pad.b
  const vals = days.map((d) => value(d, metric))
  const max = niceMax(Math.max(...vals, 1))
  const slot = plotW / days.length
  const barW = Math.max(2, Math.min(28, slot - 2))
  const y = (v: number): number => pad.t + plotH - (v / max) * plotH
  const ticks = [0, max / 2, max]
  const labelEvery = Math.ceil(days.length / Math.max(2, Math.floor(plotW / 70)))
  const h = hover !== null ? days[hover] : null

  return (
    <div className="daychart" ref={wrapRef} onMouseLeave={() => setHover(null)}>
      <svg className={hover !== null ? 'hovering' : undefined} width={width} height={H} role="img" aria-label={`Daily ${METRICS.find((m) => m.id === metric)?.label}, ${days.length} days`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={pad.l + plotW} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="axis">
              {fmt(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const v = vals[i]
          const x = pad.l + i * slot + (slot - barW) / 2
          const top = y(v)
          const hgt = pad.t + plotH - top
          return (
            <g key={d.date}>
              {v > 0 && <path d={roundedTop(x, top, barW, hgt, Math.min(4, barW / 2, hgt))} className={`bar${hover === i ? ' on' : ''}`} />}
              {i % labelEvery === 0 && (
                <text x={pad.l + i * slot + slot / 2} y={H - 8} textAnchor="middle" className="axis">
                  {dayLabel(d.date, { month: 'short', day: 'numeric' })}
                </text>
              )}
              <rect x={pad.l + i * slot} y={pad.t} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          )
        })}
      </svg>
      {h && hover !== null && (
        <div className="chart-tip" style={{ left: Math.min(width - 210, Math.max(0, pad.l + hover * slot + slot / 2 - 100)) }}>
          <div className="tip-head">{dayLabel(h.date, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
          <div className="tip-row">
            <span>All tokens</span>
            <b>{fmt(total(h))}</b>
          </div>
          <div className="tip-row">
            <span>Input</span>
            <b>{fmt(h.input)}</b>
          </div>
          <div className="tip-row">
            <span>Output</span>
            <b>{fmt(h.output)}</b>
          </div>
          <div className="tip-row">
            <span>Cache write / read</span>
            <b>
              {fmt(h.cacheWrite)} / {fmt(h.cacheRead)}
            </b>
          </div>
          <div className="tip-row">
            <span>Messages</span>
            <b>{h.messages}</b>
          </div>
          <div className="tip-row">
            <span>From Night Shift</span>
            <b>{total(h) ? `${Math.round((h.nightShift / total(h)) * 100)}%` : '–'}</b>
          </div>
        </div>
      )}
    </div>
  )
}

function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

// A bar anchored to the baseline with only its top corners rounded.
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`
}

function DayTable({ days }: { days: UsageDay[] }): JSX.Element {
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead>
          <tr>
            <th>Day</th>
            <th>Input</th>
            <th>Output</th>
            <th>Cache write</th>
            <th>Cache read</th>
            <th>All tokens</th>
            <th>Messages</th>
          </tr>
        </thead>
        <tbody>
          {[...days].reverse().map((d) => (
            <tr key={d.date}>
              <td>{dayLabel(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
              <td>{fmt(d.input)}</td>
              <td>{fmt(d.output)}</td>
              <td>{fmt(d.cacheWrite)}</td>
              <td>{fmt(d.cacheRead)}</td>
              <td>{fmt(total(d))}</td>
              <td>{d.messages}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const share = (n: number, all: number): string => {
  if (!all || !n) return '0%'
  const p = (n / all) * 100
  return p < 0.1 ? '<0.1%' : p < 10 ? `${p.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(p)}%`
}
const catColor = (i: number): string => `var(--cat-${(i % 6) + 1})`

// Models: a stacked share bar (with the table below as its legend), then share, total and output.
function ModelCard({ title, days, rows }: { title: string; days: number; rows: UsageSlice[] }): JSX.Element {
  const all = rows.reduce((sum, r) => sum + total(r), 0)
  return (
    <section className="u-card u-slices" aria-label={`${title}, ${days} days`}>
      <div className="u-slices-head">
        <h2>{title}</h2>
        <span className="note">{days} days</span>
      </div>
      {!rows.length && <div className="note">Nothing in this range.</div>}
      {all > 0 && (
        <div className="u-stack" role="img" aria-label={rows.map((r) => `${r.name} ${share(total(r), all)}`).join(', ')}>
          {rows.map((r, i) => (
            <span key={r.name} style={{ width: `${(total(r) / all) * 100}%`, background: catColor(i) }} />
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <table className="u-table">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Share</th>
              <th scope="col">Total</th>
              <th scope="col">Out</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.name}>
                <td className="name" title={r.name}>
                  <i style={{ background: catColor(i) }} aria-hidden="true" />
                  {r.name}
                </td>
                <td className="muted">{share(total(r), all)}</td>
                <td className="strong" title={`${fmt(r.input)} in · ${fmt(r.output)} out · ${fmt(r.cacheWrite)} cache write · ${fmt(r.cacheRead)} cache read`}>
                  {fmt(total(r))}
                </td>
                <td className="muted">{fmt(r.output)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

const FOLDERS_SHOWN = 6

// Folders: log-scale bars, so small folders still show next to one big one.
function FolderCard({ title, days, rows }: { title: string; days: number; rows: UsageSlice[] }): JSX.Element {
  const [all, setAll] = useState(false)
  const lmax = Math.log10(Math.max(10, ...rows.map(total)))
  const shown = all ? rows : rows.slice(0, FOLDERS_SHOWN)
  return (
    <section className="u-card u-slices" aria-label={`${title}, ${days} days`}>
      <div className="u-slices-head">
        <h2>{title}</h2>
        <span className="note">{days} days · log scale bars</span>
      </div>
      {!rows.length && <div className="note">Nothing in this range.</div>}
      <div className="u-folders">
        {shown.map((r) => (
          <div key={r.name} className="u-folder">
            <span className="name" title={r.name}>
              {r.name}
            </span>
            <span className="u-meter" aria-hidden="true">
              <span style={{ width: `${Math.max(4, (Math.log10(Math.max(1, total(r))) / lmax) * 100)}%` }} />
            </span>
            <span className="strong" title={`${fmt(r.input)} in · ${fmt(r.output)} out · ${fmt(r.cacheWrite)} cache write · ${fmt(r.cacheRead)} cache read`}>
              {fmt(total(r))}
            </span>
            <span className="muted">{fmt(r.output)} out</span>
          </div>
        ))}
      </div>
      {rows.length > FOLDERS_SHOWN && (
        <button className="btn small u-more" type="button" aria-expanded={all} onClick={() => setAll((x) => !x)}>
          {all ? 'Show fewer folders' : `Show all ${rows.length} folders`}
        </button>
      )}
    </section>
  )
}
