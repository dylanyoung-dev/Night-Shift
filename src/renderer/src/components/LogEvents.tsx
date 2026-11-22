import { memo, useState } from 'react'
import LogText from './LogText'

// Turns a run log into blocks for the run details view: Night Shift's own header, one divider per
// step ("▸ name"), shell commands with their folder, Claude's start line, tool calls ("→ Tool …")
// with their output folded underneath, and everything else as text. The log keeps its plain-text
// form on disk; this only reads the line shapes Night Shift and the Claude stream writer produce.

export type LogEvent =
  | { k: 'head'; text: string; sub?: string }
  | { k: 'step'; name: string; detail?: string }
  | { k: 'cmd'; text: string; cwd?: string }
  | { k: 'claude'; text: string; tags: string[] }
  | { k: 'tool'; id: number; depth: number; tool: string; call: string; out: string[] }
  | { k: 'text'; lines: string[] }

const OUT_LINE = /^\s*(│|✗|\(read \d+ lines\)|⋯)/

export function parseLog(text: string): LogEvent[] {
  const lines = text.split('\n')
  const out: LogEvent[] = []
  let tools = 0
  let textBuf: string[] = []
  const flush = (): void => {
    while (textBuf.length && !textBuf[textBuf.length - 1].trim()) textBuf.pop()
    while (textBuf.length && !textBuf[0].trim()) textBuf.shift()
    if (textBuf.length) out.push({ k: 'text', lines: textBuf })
    textBuf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.startsWith('Night Shift: ')) {
      flush()
      const next = lines[i + 1] ?? ''
      if (next.startsWith('Worktree: ')) {
        out.push({ k: 'head', text: raw.slice('Night Shift: '.length), sub: next })
        i++
      } else out.push({ k: 'head', text: raw.slice('Night Shift: '.length) })
      continue
    }
    if (raw.startsWith('▸ ')) {
      flush()
      const body = raw.slice(2)
      const m = /^(.*?): (.*)$/.exec(body)
      out.push(m ? { k: 'step', name: m[1], detail: m[2] } : { k: 'step', name: body })
      continue
    }
    if (raw.startsWith('$ ')) {
      flush()
      const next = lines[i + 1] ?? ''
      const cwd = /^\s+\(in (.*)\)$/.exec(next)?.[1]
      out.push({ k: 'cmd', text: raw.slice(2), cwd })
      if (cwd !== undefined) i++
      continue
    }
    if (raw.startsWith('● ')) {
      flush()
      const parts = raw.slice(2).split(' · ')
      out.push({ k: 'claude', text: parts[0], tags: parts.slice(1) })
      continue
    }
    const tool = /^(\s*)→ (.*)$/.exec(raw)
    if (tool) {
      flush()
      const depth = Math.floor(tool[1].length / 4)
      const body = tool[2]
      const m = /^((?:Subagent \([^)]*\))|[\w.]+)(:?\s?)(.*)$/s.exec(body)
      const ev: LogEvent = { k: 'tool', id: tools++, depth, tool: m ? m[1] : 'Tool', call: m ? m[3] : body, out: [] }
      // Its output: the indented │ / ✗ lines (and read notes, heartbeats) that follow.
      while (i + 1 < lines.length && OUT_LINE.test(lines[i + 1])) ev.out.push(lines[++i])
      out.push(ev)
      continue
    }
    textBuf.push(raw)
  }
  flush()
  return out
}

export const TOOL_TONE: Record<string, string> = {
  Bash: 'shell',
  PowerShell: 'shell',
  Read: 'file',
  Write: 'file',
  Edit: 'file',
  MultiEdit: 'file',
  Glob: 'file',
  Grep: 'file',
  Linear: 'linear',
  Skill: 'agent'
}
export const toolTone = (name: string): string => (name.startsWith('Subagent') ? 'agent' : /linear/i.test(name) ? 'linear' : TOOL_TONE[name] ?? 'other')

// One folded tool call. Memoised so a growing log only re-renders what changed.
export const ToolCall = memo(function ToolCall({
  ev,
  open,
  onToggle
}: {
  ev: Extract<LogEvent, { k: 'tool' }>
  open: boolean
  onToggle(id: number): void
}): JSX.Element {
  const hasOut = ev.out.length > 0
  const bad = ev.out.some((l) => /^\s*✗/.test(l))
  return (
    <div className={`lv-tool${bad ? ' bad' : ''}`} style={ev.depth ? { marginLeft: ev.depth * 20 } : undefined}>
      <button type="button" className="lv-tool-head" aria-expanded={hasOut ? open : undefined} disabled={!hasOut} onClick={() => onToggle(ev.id)}>
        <svg className="lv-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
        <span className={`lv-tool-name ${toolTone(ev.tool)}`}>{ev.tool}</span>
        <span className="lv-tool-call">{ev.call}</span>
        {hasOut && (
          <span className="lv-tool-lines">
            {ev.out.length === 1 ? '1 line' : `${ev.out.length} lines`}
            {bad ? ' · error' : ''}
          </span>
        )}
      </button>
      {open && hasOut && (
        <div className="lv-tool-out">
          {ev.call.length > 80 && (
            <div className="lv-tool-full">
              <LogText text={ev.call} />
            </div>
          )}
          <pre className="lv-pre">
            <LogText text={ev.out.join('\n')} />
          </pre>
        </div>
      )}
    </div>
  )
})

// The run details timeline: one row per tool call, with an icon on a rail. The output opens underneath
// and stays short (the first lines) until "Show all" is pressed.
const LONG_OUTPUT = 8

function ToolGlyph({ tone }: { tone: string }): JSX.Element {
  const p = { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (tone === 'shell') return <svg {...p}><path d="m5 8 4 4-4 4M12 17h7" /></svg>
  if (tone === 'file') return <svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
  if (tone === 'linear') return <svg {...p}><path d="M4 14 10 20M4 9l11 11M6 5l13 13M11 4l9 9" /></svg>
  if (tone === 'agent') return <svg {...p}><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>
  if (tone === 'say') return <svg {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></svg>
  return <svg {...p}><circle cx="12" cy="12" r="3" /></svg>
}

export const TimelineTool = memo(function TimelineTool({
  ev,
  open,
  onToggle
}: {
  ev: Extract<LogEvent, { k: 'tool' }>
  open: boolean
  onToggle(id: number): void
}): JSX.Element {
  const [all, setAll] = useState(false)
  const hasOut = ev.out.length > 0
  const bad = ev.out.some((l) => /^\s*✗/.test(l))
  const tone = toolTone(ev.tool)
  const long = ev.out.length > LONG_OUTPUT
  const shown = long && !all ? ev.out.slice(0, LONG_OUTPUT) : ev.out
  return (
    <li className={`tl-item${bad ? ' bad' : ''}`} style={ev.depth ? { marginLeft: ev.depth * 22 } : undefined}>
      <span className="tl-rail" aria-hidden="true">
        <span className={`tl-icon ${tone}`}>
          <ToolGlyph tone={tone} />
        </span>
      </span>
      <div className="tl-body">
        <button type="button" className="tl-head" aria-expanded={hasOut ? open : undefined} disabled={!hasOut} onClick={() => onToggle(ev.id)}>
          <span className={`tl-tool ${tone}`}>{ev.tool}</span>
          <span className="tl-call">{ev.call}</span>
          {hasOut && (
            <span className="tl-lines">
              {ev.out.length === 1 ? '1 line' : `${ev.out.length} lines`}
              {bad ? ' · error' : ''}
            </span>
          )}
          {hasOut && (
            <svg className="tl-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 6 6 6-6 6" />
            </svg>
          )}
        </button>
        {open && hasOut && (
          <div className="tl-out">
            {ev.call.length > 80 && (
              <div className="tl-full">
                <LogText text={ev.call} />
              </div>
            )}
            <pre className="tl-pre">
              <LogText text={shown.join('\n')} />
            </pre>
            {long && (
              <button type="button" className="tl-grow" onClick={() => setAll((a) => !a)}>
                {all ? 'Show less' : `Show all ${ev.out.length} lines`}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  )
})

// Claude's own words (and other plain output) in the timeline.
export const TimelineText = memo(function TimelineText({ lines, meta }: { lines: string[]; meta?: boolean }): JSX.Element {
  return (
    <li className={`tl-item${meta ? ' meta' : ''}`}>
      <span className="tl-rail" aria-hidden="true">
        <span className={`tl-icon ${meta ? 'other' : 'say'}`}>
          <ToolGlyph tone={meta ? 'other' : 'say'} />
        </span>
      </span>
      <div className="tl-body">
        <pre className="tl-text">
          <LogText text={lines.join('\n')} />
        </pre>
      </div>
    </li>
  )
})
