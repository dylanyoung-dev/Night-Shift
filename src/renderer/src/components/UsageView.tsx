import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TokenCounts, UsageDay, UsageReport, UsageSlice } from '../../../shared/types'

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
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [asTable, setAsTable] = useState(false)

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

  return (
    <div className="page usage">
      <div className="header">
        <h1>Claude Code usage</h1>
        <span className="note">From Claude Code&apos;s session logs on this machine. Includes your own sessions and Night Shift&apos;s runs.</span>
        <div className="right">
          <div className="seg" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <button key={r} type="button" className={days === r ? 'on' : ''} aria-pressed={days === r} onClick={() => setDays(r)}>
                {r} days
              </button>
            ))}
          </div>
          <button className="btn small" type="button" onClick={() => void load(true)} disabled={loading}>
            {loading ? 'Reading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="empty">{error}</div>}
      {!report && !error && (
        <div className="empty">
          {progress ? `Reading session logs… ${progress.done} of ${progress.total} files. The first time takes a while; after that only new lines are read.` : 'Reading session logs…'}
        </div>
      )}

      {report && (
        <>
          <div className="tiles">
            <div className="tile hero">
              <div className="tile-label">Current 5-hour window</div>
              {w ? (
                <>
                  <div className="tile-value">{fmt(total(w))}</div>
                  <div className="tile-sub">
                    tokens · {w.messages} messages · {clock(w.start)}–{clock(w.end)}
                  </div>
                  <WindowBar start={w.start} end={w.end} now={report.generatedAt} />
                  <div className="tile-sub">
                    Resets at {clock(w.end)} · about {fmt(w.perMinute)} tokens a minute
                  </div>
                </>
              ) : (
                <>
                  <div className="tile-value">0</div>
                  <div className="tile-sub">No Claude Code activity in the last 5 hours. A new window starts with your next message.</div>
                </>
              )}
            </div>
            <Tile label="Today" t={report.today} />
            <Tile label="Last 7 days" t={report.week} />
            <div className="tile">
              <div className="tile-label">Night Shift runs · {days} days</div>
              <div className="tile-value">{fmt(ns)}</div>
              <div className="tile-sub">
                {periodTotal ? `${Math.round((ns / periodTotal) * 100)}% of all tokens` : 'No usage yet'} · {report.nightShift.messages} messages
              </div>
            </div>
          </div>

          <section className="usage-card">
            <div className="usage-card-head">
              <h2>Usage over time</h2>
              <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)} aria-label="Measure" title={METRICS.find((m) => m.id === metric)?.hint}>
                {METRICS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <span className="note">{fmt(value(report.period, metric))} in the last {days} days</span>
              <label className="toggle right">
                <input type="checkbox" checked={asTable} onChange={(e) => setAsTable(e.target.checked)} />
                Show as table
              </label>
            </div>
            {asTable ? <DayTable days={report.daily} /> : <DayChart days={report.daily} metric={metric} />}
          </section>

          <div className="usage-split">
            <SliceTable title={`By model · ${days} days`} rows={report.byModel} />
            <SliceTable title={`By folder · ${days} days`} rows={report.byProject} />
          </div>

          <p className="note usage-foot">
            Read from {report.files} session files in {report.sources.join(', ') || 'no Claude folder found'}. Counts are tokens reported by Claude for each reply; your plan&apos;s limit percentages aren&apos;t in these logs, so check those with /usage in Claude Code. Updated {clock(report.generatedAt)}.
          </p>
        </>
      )}
    </div>
  )
}

function Tile({ label, t }: { label: string; t: TokenCounts }): JSX.Element {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{fmt(total(t))}</div>
      <div className="tile-sub">
        {fmt(t.input + t.output)} in + out · {fmt(t.cacheRead + t.cacheWrite)} cache · {t.messages} messages
      </div>
    </div>
  )
}

function WindowBar({ start, end, now }: { start: number; end: number; now: number }): JSX.Element {
  const pct = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100))
  return (
    <div className="winbar" role="img" aria-label={`${Math.round(pct)}% of the window has passed`}>
      <div style={{ width: `${pct}%` }} />
    </div>
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
      <svg width={width} height={H} role="img" aria-label={`Daily ${METRICS.find((m) => m.id === metric)?.label}, ${days.length} days`}>
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

function SliceTable({ title, rows }: { title: string; rows: UsageSlice[] }): JSX.Element {
  const max = Math.max(1, ...rows.map(total))
  return (
    <section className="usage-card">
      <div className="usage-card-head">
        <h2>{title}</h2>
      </div>
      {!rows.length && <div className="note">Nothing in this range.</div>}
      <table className="usage-table slices">
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="name" title={r.name}>
                {r.name}
              </td>
              <td className="meter-cell">
                <div className="meter">
                  <div style={{ width: `${(total(r) / max) * 100}%` }} />
                </div>
              </td>
              <td title={`${fmt(r.input)} in · ${fmt(r.output)} out · ${fmt(r.cacheWrite)} cache write · ${fmt(r.cacheRead)} cache read`}>{fmt(total(r))}</td>
              <td className="muted">{fmt(r.output)} out</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
