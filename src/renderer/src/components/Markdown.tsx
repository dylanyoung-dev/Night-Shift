import { useEffect, useState, type ReactNode } from 'react'

// Renders the markdown Linear stores (descriptions, comments) as React elements. No raw HTML
// is ever injected; links open in the browser and Linear-hosted images load through the API key.

const open = (url: string) => (e: React.MouseEvent) => {
  e.preventDefault()
  if (/^https?:\/\//.test(url)) void window.nightShift.openInBrowser(url)
}

function LinearImage({ src, alt }: { src: string; alt: string }): JSX.Element {
  const needsKey = src.startsWith('https://uploads.linear.app/')
  const [url, setUrl] = useState<string | null>(needsKey ? null : src)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!needsKey) return
    let live = true
    void window.nightShift.linearImage?.(src).then((d) => {
      if (!live) return
      if (d) setUrl(d)
      else setFailed(true)
    })
    return () => {
      live = false
    }
  }, [src, needsKey])
  if (failed || !/^(https:|data:image\/)/.test(url ?? 'https:'))
    return (
      <a href={src} onClick={open(src)}>
        {alt || 'image'}
      </a>
    )
  if (!url) return <span className="md-img-loading">Loading image…</span>
  return <img className="md-img" src={url} alt={alt} onClick={open(src)} title="Open full size in the browser" />
}

// Inline: code, images, links, autolinks, bold, italic, strikethrough.
// Groups: 1 code · 2-3 image · 4-5 link ([t](url) or [t](<url>)) · 6 <url> · 7 bare url · 8-9 bold · 10 strike
// · 11-12 italic · 13-14 Linear mention tag such as <issue label="IGN-1" href="…" />
const INLINE = /(`[^`]+`)|!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\s][^*]*)\*|(?<![\w])_([^_\s][^_]*)_(?![\w])|<([a-z]+)\s((?:[a-zA-Z-]+="[^"]*"\s*)+)\/>/g
const attr = (attrs: string, name: string): string | undefined => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1]

function inline(text: string, key = 'i', inLink = false): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0
    if (i > last) out.push(text.slice(last, i))
    const k = `${key}-${n++}`
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>)
    else if (m[3] !== undefined) out.push(<LinearImage key={k} src={m[3]} alt={m[2]} />)
    else if (m[5])
      out.push(
        /^https?:\/\//.test(m[5]) ? (
          <a key={k} href={m[5]} onClick={open(m[5])} title={m[5]}>
            {inline(m[4], k, true)}
          </a>
        ) : (
          <span key={k}>{inline(m[4], k)}</span> // only web links become links
        )
      )
    else if ((m[6] || m[7]) && inLink) out.push(m[6] || m[7]) // already inside a link
    else if (m[6] || m[7]) {
      const u = (m[6] || m[7])!
      out.push(
        <a key={k} href={u} onClick={open(u)}>
          {u}
        </a>
      )
    } else if (m[8] || m[9]) out.push(<strong key={k}>{inline((m[8] || m[9])!, k)}</strong>)
    else if (m[10]) out.push(<s key={k}>{inline(m[10], k)}</s>)
    else if (m[11] || m[12]) out.push(<em key={k}>{inline((m[11] || m[12])!, k)}</em>)
    else if (m[13]) {
      // Linear mention: show its label, linked when it has a web address.
      const label = attr(m[14], 'label') ?? attr(m[14], 'name') ?? m[13]
      const href = attr(m[14], 'href')
      out.push(
        href && /^https?:\/\//.test(href) ? (
          <a key={k} className="md-mention" href={href} onClick={open(href)} title={href}>
            {label}
          </a>
        ) : (
          <span key={k} className="md-mention">
            {label}
          </span>
        )
      )
    }
    last = i + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

interface ListItem {
  indent: number
  ordered: boolean
  task: boolean | null // null: not a checkbox
  text: string
}

function renderList(items: ListItem[], key: string): JSX.Element {
  // Nest by indentation.
  const base = items[0].indent
  const groups: { item: ListItem; kids: ListItem[] }[] = []
  for (const it of items) {
    if (it.indent > base && groups.length) groups[groups.length - 1].kids.push(it)
    else groups.push({ item: it, kids: [] })
  }
  const Tag = items[0].ordered ? 'ol' : 'ul'
  return (
    <Tag key={key} className={groups.some((g) => g.item.task !== null) ? 'md-tasks' : undefined}>
      {groups.map((g, i) => (
        <li key={i} className={g.item.task ? 'done' : undefined}>
          {g.item.task !== null && <input type="checkbox" checked={g.item.task} readOnly tabIndex={-1} aria-label={g.item.task ? 'Done' : 'Not done'} />}
          <span>{inline(g.item.text, `${key}-${i}`)}</span>
          {g.kids.length > 0 && renderList(g.kids, `${key}-${i}-k`)}
        </li>
      ))}
    </Tag>
  )
}

export default function Markdown({ text }: { text: string }): JSX.Element {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let para: string[] = []
  const flush = (): void => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(' '), `p${blocks.length}`)}</p>)
    para = []
  }
  const LIST = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/

  while (i < lines.length) {
    const line = lines[i]
    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++])
      i++
      blocks.push(
        <pre key={`c${blocks.length}`} className="md-code">
          <code>{code.join('\n')}</code>
        </pre>
      )
      continue
    }
    if (!line.trim()) {
      flush()
      i++
      continue
    }
    // Linear's collapsible section: "+++ Title" ... "+++"
    const fold = /^\s*\+\+\+\s*(.*)$/.exec(line)
    if (fold && fold[1]) {
      flush()
      const inner: string[] = []
      i++
      while (i < lines.length && !/^\s*\+\+\+\s*$/.test(lines[i])) inner.push(lines[i++])
      i++
      blocks.push(
        <details key={`d${blocks.length}`} className="md-fold">
          <summary>{inline(fold[1], `d${blocks.length}`)}</summary>
          <Markdown text={inner.join('\n')} />
        </details>
      )
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      const level = Math.min(6, h[1].length + 2) // descriptions sit under the panel's own title
      const Tag = `h${level}` as 'h3'
      blocks.push(<Tag key={`h${blocks.length}`}>{inline(h[2].replace(/\s#+\s*$/, ''), `h${blocks.length}`)}</Tag>)
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      blocks.push(<hr key={`r${blocks.length}`} />)
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      flush()
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push(
        <blockquote key={`q${blocks.length}`}>
          <Markdown text={quote.join('\n')} />
        </blockquote>
      )
      continue
    }
    if (LIST.test(line)) {
      flush()
      const items: ListItem[] = []
      while (i < lines.length) {
        const m = LIST.exec(lines[i])
        if (m) {
          items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), task: m[3] === undefined ? null : m[3] !== ' ', text: m[4] })
          i++
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ` ${lines[i].trim()}` // wrapped item text
          i++
        } else break
      }
      blocks.push(renderList(items, `l${blocks.length}`))
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush()
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((c) => c.trim())
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells)
        i++
      }
      const [head, ...body] = rows
      blocks.push(
        <div key={`t${blocks.length}`} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c, `th${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `td${ri}-${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }
    para.push(line.trim())
    i++
  }
  flush()
  return <div className="md">{blocks}</div>
}
