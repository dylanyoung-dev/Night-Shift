import { memo, useMemo } from 'react'

// Colours a run log the way an editor would: Night Shift's own lines, Claude's tool calls,
// shell commands, tool output and errors each get their own style, plus inline code, paths,
// ticket ids and URLs. Lines are rendered in blocks so a growing log only re-renders its end.

const BLOCK_LINES = 300

type Part = { t: string; c?: string }

const INLINE = /(`[^`\n]+`)|(https?:\/\/[^\s)>"'\]]+)|(\b[A-Z][A-Z0-9]{1,9}-\d+\b)|((?:[A-Za-z]:[\\/]|\.{0,2}\/)?(?:[\w.@-]+[\\/])+[\w.@-]+\.\w{1,6}\b)/g

function inline(text: string, base?: string): Part[] {
  const out: Part[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push({ t: text.slice(last, m.index), c: base })
    const c = m[1] ? 'syn-code' : m[2] ? 'syn-url' : m[3] ? 'syn-id' : 'syn-path'
    out.push({ t: m[0], c })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ t: text.slice(last), c: base })
  return out
}

// Shell: strings, flags, operators and the program name.
const SHELL = /("(?:[^"\\]|\\.)*"|'[^']*')|(\s--?[A-Za-z][\w-]*(?:=\S+)?)|(\|\||&&|[|;>]|2>&1|\$\(|\))|(\$[A-Z_][A-Z0-9_]*|\$\{[^}]+\})/g

function shell(cmd: string): Part[] {
  const out: Part[] = []
  let last = 0
  let first = true
  const plain = (s: string): void => {
    if (!s) return
    if (first) {
      // The program (first word, or the first word after an operator) stands out.
      const m = /^(\s*)(\S+)(.*)$/s.exec(s)
      if (m) {
        if (m[1]) out.push({ t: m[1] })
        out.push({ t: m[2], c: 'syn-prog' })
        if (m[3]) out.push(...inline(m[3]))
        first = false
        return
      }
    }
    out.push(...inline(s))
  }
  for (const m of cmd.matchAll(SHELL)) {
    plain(cmd.slice(last, m.index))
    const c = m[1] ? 'syn-str' : m[2] ? 'syn-flag' : m[3] ? 'syn-op' : 'syn-var'
    out.push({ t: m[0], c })
    if (m[3] && m[0] !== ')') first = true
    last = m.index! + m[0].length
  }
  plain(cmd.slice(last))
  return out
}

const TOOL_KIND: Record<string, string> = {
  Bash: 'syn-tool-shell',
  PowerShell: 'syn-tool-shell',
  Read: 'syn-tool-file',
  Write: 'syn-tool-file',
  Edit: 'syn-tool-file',
  MultiEdit: 'syn-tool-file',
  Glob: 'syn-tool-file',
  Grep: 'syn-tool-file',
  Linear: 'syn-tool-linear',
  Subagent: 'syn-tool-agent',
  Skill: 'syn-tool-agent'
}

function line(raw: string): { cls: string; parts: Part[] } {
  const indent = /^\s*/.exec(raw)![0]
  const s = raw.slice(indent.length)
  const lead = indent ? [{ t: indent }] : []
  const as = (cls: string, parts: Part[]): { cls: string; parts: Part[] } => ({ cls, parts: [...lead, ...parts] })

  if (!s) return { cls: '', parts: [{ t: raw }] }
  if (s.startsWith('▸ ')) return as('ln-step', [{ t: '▸ ', c: 'syn-mark' }, ...inline(s.slice(2))])
  if (s.startsWith('$ ')) return as('ln-cmd', [{ t: '$ ', c: 'syn-prompt' }, ...shell(s.slice(2))])
  if (/^\(in .*\)$/.test(s)) return as('ln-dim', inline(s))
  if (s.startsWith('● ')) return as(/stopped with an error/.test(s) ? 'ln-claude ln-bad' : 'ln-claude', [{ t: '● ', c: 'syn-mark' }, { t: s.slice(2) }])
  if (s.startsWith('→ ')) {
    const m = /^→ ((?:Subagent \([^)]*\))|[\w.]+)(:?)(\s?)(.*)$/s.exec(s)
    if (!m) return as('ln-tool', [{ t: s }])
    const name = m[1]
    const kind = TOOL_KIND[name.split(' ')[0]] ?? 'syn-tool'
    const rest = /^(Bash|PowerShell)$/.test(name) ? shell(m[4]) : inline(m[4])
    return as('ln-tool', [{ t: '→ ', c: 'syn-mark' }, { t: name, c: kind }, { t: m[2] + m[3] }, ...rest])
  }
  if (s.startsWith('│')) return as('ln-out', [{ t: '│', c: 'syn-gutter' }, ...inline(s.slice(1), 'syn-out')])
  if (s.startsWith('✗')) return as('ln-err', [{ t: '✗', c: 'syn-gutter-bad' }, ...inline(s.slice(1))])
  if (s.startsWith('⏸')) return as('ln-attn', inline(s))
  if (s.startsWith('▶ You:')) return as('ln-you', [{ t: '▶ You:', c: 'syn-mark' }, ...inline(s.slice(6))])
  if (/^(Night Shift: |Worktree: )/.test(s)) return as('ln-head', inline(s))
  if (/^Run done\.$/.test(s)) return as('ln-ok', [{ t: s }])
  if (/^(Run stopped\.|Stopped by you\.)$/.test(s)) return as('ln-warn', [{ t: s }])
  if (/^(Run failed\.|Step failed: |Error: |Could not )/.test(s)) return as('ln-bad', inline(s))
  if (/^Marked .* in Linear\.|^Removed ".*" from /.test(s)) return as('ln-attn', inline(s))
  if (/^\(read \d+ lines\)$/.test(s)) return as('ln-dim', [{ t: s }])
  return as('ln-text', inline(s))
}

const Block = memo(function Block({ text, end }: { text: string; end: boolean }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((l, i) => {
        const { cls, parts } = line(l)
        return (
          <span key={i} className={`ln ${cls}`}>
            {parts.map((p, j) => (p.c ? <span key={j} className={p.c}>{p.t}</span> : p.t))}
            {i < lines.length - 1 || !end ? '\n' : ''}
          </span>
        )
      })}
    </>
  )
})

export default function LogText({ text }: { text: string }): JSX.Element {
  const blocks = useMemo(() => {
    const lines = text.split('\n')
    const out: string[] = []
    for (let i = 0; i < lines.length; i += BLOCK_LINES) out.push(lines.slice(i, i + BLOCK_LINES).join('\n'))
    return out
  }, [text])
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={i} text={b} end={i === blocks.length - 1} />
      ))}
    </>
  )
}
