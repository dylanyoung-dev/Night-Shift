import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TicketBucket, TicketStats } from '../../../shared/types'
import { fmt } from './UsageView'

const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions): string => new Date(`${d}T12:00:00`).toLocaleDateString([], opts)
const one = (n: number): string => (n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, ''))
function duration(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

type Measure = 'count' | 'points' | 'tokens' | 'runs' | 'sessions'
const MEASURES: { id: Measure; label: string; hint: string }[] = [
  { id: 'count', label: 'Tickets done', hint: 'Tickets moved to a Done state' },
  { id: 'points', label: 'Points done', hint: 'Estimate points of the tickets done' },
  { id: 'tokens', label: 'Tokens per ticket', hint: 'Average tokens Night Shift runs used per ticket done' },
  { id: 'runs', label: 'Agents per ticket', hint: 'Average Night Shift runs per ticket done' },
  { id: 'sessions', label: 'Claude sessions per ticket', hint: 'Average Claude sessions per ticket done' }
]
const isAverage = (m: Measure): boolean => m === 'tokens' || m === 'runs' || m === 'sessions'
// Averages are over the tickets that had a Night Shift run; null when there were none.
function measure(b: TicketBucket, m: Measure): number | null {
  if (m === 'count') return b.count
  if (m === 'points') return b.points
  if (!b.agented) return null
  return (m === 'tokens' ? b.tokens : m === 'runs' ? b.runs : b.sessions) / b.agented
}
const show = (v: number, m: Measure): string => (m === 'tokens' ? fmt(v) : isAverage(m) ? one(v) : String(Math.round(v)))

interface Point extends TicketBucket {
  key: string
  label: string
  long: string
}

// Tickets completed in Linear, and what Night Shift's agents spent on them. Lives on the usage page.
export default function TicketStatsSection({ days, tick }: { days: number; tick: number }): JSX.Element | null {
  const api = window.nightShift
  const [stats, setStats] = useState<TicketStats | null>(null)
  const [by, setBy] = useState<'day' | 'week'>('day')
  const [m, setM] = useState<Measure>('count')
  const [asTable, setAsTable] = useState(false)

  useEffect(() => {
    if (!api.getTicketStats) return
    let live = true
    void api
      .getTicketStats(days)
      .then((s) => live && setStats(s))
      .catch((e: Error) => live && setStats((prev) => (prev ? { ...prev, error: e.message } : null)))
    return () => {
      live = false
    }
  }, [days, tick])

  if (!api.getTicketStats) return <div className="empty">Restart Night Shift to see completed tickets.</div>
  if (!stats) return <div className="note">Loading completed tickets…</div>

  const weekDiff = stats.thisWeek - stats.lastWeek
  const points: Point[] =
    by === 'day'
      ? stats.daily.map((d) => ({ ...d, key: d.date, label: dayLabel(d.date, { month: 'short', day: 'numeric' }), long: dayLabel(d.date, { weekday: 'short', month: 'short', day: 'numeric' }) }))
      : stats.weekly.map((w) => ({ ...w, key: w.start, label: dayLabel(w.start, { month: 'short', day: 'numeric' }), long: `Week of ${dayLabel(w.start, { month: 'short', day: 'numeric' })}` }))
  const rangeCount = stats.tickets.length

  return (
    <>
      {stats.error && <div className="empty">{stats.error}</div>}
      <div className="tiles">
        <div className="tile">
          <div className="tile-label">Tickets done today</div>
          <div className="tile-value">{stats.today}</div>
          <div className="tile-sub">Since midnight, moved to a Done state in Linear</div>
        </div>
        <div className="tile">
          <div className="tile-label">Tickets done this week</div>
          <div className="tile-value">{stats.thisWeek}</div>
          <div className="tile-sub">
            Since Monday · last week {stats.lastWeek}
            {stats.lastWeek || stats.thisWeek ? ` (${weekDiff >= 0 ? '+' : ''}${weekDiff} so far)` : ''}
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Tokens per ticket</div>
          <div className="tile-value">{stats.withAgents ? fmt(stats.avgTokens) : '–'}</div>
          <div className="tile-sub">
            {stats.withAgents
              ? `${fmt(stats.avgOutput)} written by Claude${stats.tokensPerPoint !== null ? ` · ${fmt(stats.tokensPerPoint)} per point` : ''}`
              : 'No completed tickets with Night Shift runs yet'}
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Agents per ticket</div>
          <div className="tile-value">{stats.withAgents ? one(stats.avgRuns) : '–'}</div>
          <div className="tile-sub">
            {stats.withAgents ? `runs on average · ${one(stats.avgSessions)} Claude sessions · ${duration(stats.avgAgentMs)} of agent time` : 'Runs and Claude sessions on each ticket'}
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Done with agents · {days} days</div>
          <div className="tile-value">{rangeCount ? `${Math.round((stats.withAgents / rangeCount) * 100)}%` : '–'}</div>
          <div className="tile-sub">
            {stats.withAgents} of {rangeCount} completed tickets had a Night Shift run
          </div>
        </div>
      </div>

      <section className="usage-card">
        <div className="usage-card-head">
          <h2>Tickets over time</h2>
          <select value={m} onChange={(e) => setM(e.target.value as Measure)} aria-label="Measure" title={MEASURES.find((x) => x.id === m)?.hint}>
            {MEASURES.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          <div className="seg" role="group" aria-label="Per">
            <button type="button" className={by === 'day' ? 'on' : ''} aria-pressed={by === 'day'} onClick={() => setBy('day')}>
              Per day
            </button>
            <button type="button" className={by === 'week' ? 'on' : ''} aria-pressed={by === 'week'} onClick={() => setBy('week')}>
              Per week
            </button>
          </div>
          <span className="note">
            {rangeCount} done in the last {days} days{by === 'week' ? ' · weeks start Monday' : ''}
            {isAverage(m) ? ' · averages over tickets with Night Shift runs' : ''}
          </span>
          <label className="toggle right">
            <input type="checkbox" checked={asTable} onChange={(e) => setAsTable(e.target.checked)} />
            Show tickets
          </label>
        </div>
        {asTable ? <TicketTable stats={stats} /> : <LineChart points={points} m={m} />}
      </section>
    </>
  )
}

function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v))
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p
  return 10 * p
}

// One 2px line with a dot per day or week. An average leaves a gap where no tickets had agent runs.
function LineChart({ points, m }: { points: Point[]; m: Measure }): JSX.Element {
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
  const pad = { l: 48, r: 16, t: 14, b: 26 }
  const plotW = Math.max(100, width - pad.l - pad.r)
  const plotH = H - pad.t - pad.b
  const vals = points.map((p) => measure(p, m))
  const top = Math.max(0, ...vals.map((v) => v ?? 0))
  const max = isAverage(m) ? niceMax(Math.max(top, m === 'tokens' ? 1000 : 1)) : Math.max(4, niceMax(Math.max(top, 1)))
  const step = points.length > 1 ? plotW / (points.length - 1) : 0
  const x = (i: number): number => (points.length > 1 ? pad.l + i * step : pad.l + plotW / 2)
  const y = (v: number): number => pad.t + plotH - (v / max) * plotH
  const ticks = [0, max / 2, max]
  const labelEvery = Math.ceil(points.length / Math.max(2, Math.floor(plotW / 70)))

  // Consecutive values make one segment; a missing average breaks the line.
  const segments: string[] = []
  let seg = ''
  vals.forEach((v, i) => {
    if (v === null) {
      if (seg) segments.push(seg)
      seg = ''
      return
    }
    seg += `${seg ? 'L' : 'M'}${x(i)},${y(v)} `
  })
  if (seg) segments.push(seg)
  const area = !isAverage(m) && segments[0] ? `${segments[0]}L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z` : null

  const h = hover !== null ? points[hover] : null
  const hv = hover !== null ? vals[hover] : null
  const label = MEASURES.find((o) => o.id === m)?.label ?? ''

  return (
    <div
      className="daychart"
      ref={wrapRef}
      onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const i = points.length > 1 ? Math.round((e.clientX - r.left - pad.l) / step) : 0
        setHover(Math.min(points.length - 1, Math.max(0, i)))
      }}
    >
      <svg width={width} height={H} role="img" aria-label={`${label}, ${points.length} points`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={pad.l + plotW} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="axis">
              {show(t, m)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % labelEvery === 0 ? (
            <text key={p.key} x={x(i)} y={H - 8} textAnchor="middle" className="axis">
              {p.label}
            </text>
          ) : null
        )}
        {area && <path d={area} className="line-area" />}
        {segments.map((d) => (
          <path key={d} d={d} className="line" />
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + plotH} className="crosshair" />}
        {vals.map((v, i) =>
          v === null || (points.length > 40 && hover !== i) ? null : (
            <circle key={points[i].key} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 3.5} className="dot" />
          )
        )}
      </svg>
      {h && hover !== null && (
        <div className="chart-tip" style={{ left: Math.min(width - 210, Math.max(0, x(hover) - 100)) }}>
          <div className="tip-head">{h.long}</div>
          <div className="tip-row">
            <span>{label}</span>
            <b>{hv === null ? '–' : show(hv, m)}</b>
          </div>
          {m !== 'count' && (
            <div className="tip-row">
              <span>Tickets done</span>
              <b>{h.count}</b>
            </div>
          )}
          {m !== 'points' && (
            <div className="tip-row">
              <span>Points</span>
              <b>{h.points}</b>
            </div>
          )}
          <div className="tip-row">
            <span>With Night Shift runs</span>
            <b>{h.agented}</b>
          </div>
          {h.agented > 0 && (
            <div className="tip-row">
              <span>Agent tokens</span>
              <b>{fmt(h.tokens)}</b>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TicketTable({ stats }: { stats: TicketStats }): JSX.Element {
  if (!stats.tickets.length) return <div className="note">No tickets completed in this range.</div>
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Done</th>
            <th>Points</th>
            <th>Runs</th>
            <th>Claude sessions</th>
            <th>Agent time</th>
            <th>All tokens</th>
            <th>Output</th>
          </tr>
        </thead>
        <tbody>
          {stats.tickets.map((t) => (
            <tr key={t.identifier}>
              <td className="name" title={t.title}>
                {t.identifier} · {t.title}
              </td>
              <td>{new Date(t.completedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</td>
              <td>{t.estimate ?? '–'}</td>
              <td>{t.runs || '–'}</td>
              <td>{t.sessions || '–'}</td>
              <td>{t.runs ? duration(t.agentMs) : '–'}</td>
              <td>{t.tokens ? fmt(t.tokens) : '–'}</td>
              <td>{t.output ? fmt(t.output) : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
