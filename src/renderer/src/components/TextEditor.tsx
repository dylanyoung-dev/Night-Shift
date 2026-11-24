import { useEffect, useRef, useState } from 'react'
import Markdown from './Markdown'

// Edits a ticket's title and description, or one of its documents (spec, plan, …), in the panel and saves
// them to Linear. Markdown with a few formatting buttons and a preview. Files dropped or pasted in (or
// picked with Attach) are uploaded to Linear and linked where the cursor is: images show inline, other
// files as links (and, on a ticket, are also added to its attachments).
//
// Unsaved text is kept per ticket and document while Night Shift is open, so switching cards doesn't
// lose it. A save that would overwrite someone else's edit in Linear is refused first, with the choice
// to reload or save anyway.

export interface EditTarget {
  key: string // `${issueId}|ticket` or `${issueId}|${documentId}`
  kind: 'ticket' | 'document'
  title: string
  body: string
}
type Draft = { title: string; body: string; base: { title: string; body: string } }
const drafts = new Map<string, Draft>()
export const hasDraft = (key: string): boolean => drafts.has(key)
export const dropDraft = (key: string): void => void drafts.delete(key)

interface Props {
  target: EditTarget
  issueId: string
  pendingFiles?: File[] // dropped on the ticket before the editor opened; uploaded at the end
  onSave(title: string, body: string, base: { title: string; body: string }, overwrite: boolean): Promise<{ ok: true } | { conflict: true; error: string } | { error: string }>
  onDone(saved: boolean): void
}

const isImage = (f: File): boolean => f.type.startsWith('image/')
const mdEscape = (s: string): string => s.replace(/[[\]]/g, '')

export default function TextEditor({ target, issueId, pendingFiles, onSave, onDone }: Props): JSX.Element {
  const start = drafts.get(target.key) ?? { title: target.title, body: target.body, base: { title: target.title, body: target.body } }
  const [title, setTitle] = useState(start.title)
  const [body, setBody] = useState(start.body)
  const base = start.base
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [uploads, setUploads] = useState(0)
  const [dragging, setDragging] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const bodyRef = useRef(body)
  bodyRef.current = body

  const dirty = title !== base.title || body !== base.body
  useEffect(() => {
    if (dirty) drafts.set(target.key, { title, body, base })
    else drafts.delete(target.key)
  }, [title, body]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pendingFiles?.length) void upload(pendingFiles, 'end')
    if (!pendingFiles?.length) area.current?.focus()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Replaces the selection (or inserts at the cursor) and keeps the cursor after the new text.
  function insert(text: string, at?: 'end'): void {
    const el = area.current
    const cur = bodyRef.current
    const s = at === 'end' || !el ? cur.length : el.selectionStart
    const e = at === 'end' || !el ? cur.length : el.selectionEnd
    const pre = at === 'end' && cur && !cur.endsWith('\n') ? '\n\n' : ''
    const next = cur.slice(0, s) + pre + text + cur.slice(e)
    setBody(next)
    bodyRef.current = next
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      const pos = s + pre.length + text.length
      el.setSelectionRange(pos, pos)
    })
  }
  // Wraps the selection, for the formatting buttons.
  function wrap(before: string, after = before, placeholder = 'text'): void {
    const el = area.current
    if (!el) return
    const s = el.selectionStart
    const e = el.selectionEnd
    const picked = body.slice(s, e) || placeholder
    const next = body.slice(0, s) + before + picked + after + body.slice(e)
    setBody(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(s + before.length, s + before.length + picked.length)
    })
  }
  // Puts a prefix at the start of each selected line (lists, headings, quotes).
  function linePrefix(prefix: string): void {
    const el = area.current
    if (!el) return
    const s = body.lastIndexOf('\n', el.selectionStart - 1) + 1
    const e = el.selectionEnd
    const lines = body.slice(s, e).split('\n')
    const done = lines.map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : prefix + l)).join('\n')
    const next = body.slice(0, s) + done + body.slice(e)
    setBody(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(s, s + done.length)
    })
  }

  // Each file gets a placeholder at once, replaced by its link when the upload finishes.
  async function upload(files: File[], at?: 'end'): Promise<void> {
    for (const f of files) {
      const tag = `<!-- uploading ${mdEscape(f.name)} ${Math.random().toString(36).slice(2, 7)} -->`
      insert(`${tag}\n`, at)
      setUploads((n) => n + 1)
      void (async () => {
        let link = ''
        try {
          const bytes = new Uint8Array(await f.arrayBuffer())
          const r = (await window.nightShift.uploadToIssue?.(issueId, { name: f.name, type: f.type, bytes }, target.kind === 'ticket' && !isImage(f))) ?? {
            error: 'Uploading needs a restart of Night Shift.'
          }
          if ('error' in r) setError(`${f.name}: ${r.error}`)
          else {
            link = isImage(f) ? `![${mdEscape(f.name)}](${r.url})` : `[${mdEscape(f.name)}](${r.url})`
            if (r.attachError) setError(`${f.name} was uploaded and linked, but not added to the ticket's attachments: ${r.attachError}`)
          }
        } catch (err) {
          setError(`${f.name}: ${(err as Error).message}`)
        } finally {
          const cur = bodyRef.current
          const next = link ? cur.replace(tag, link) : cur.replace(`${tag}\n`, '').replace(tag, '')
          setBody(next)
          bodyRef.current = next
          setUploads((n) => n - 1)
        }
      })()
    }
  }

  async function save(overwrite = false): Promise<void> {
    if (uploads > 0) return
    setSaving(true)
    setError(null)
    try {
      const r = await onSave(title, body, base, overwrite)
      if ('ok' in r) {
        drafts.delete(target.key)
        onDone(true)
        return
      }
      setError(r.error)
      setConflict('conflict' in r)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }
  function cancel(): void {
    drafts.delete(target.key)
    onDone(false)
  }

  const files = (dt: DataTransfer | null): File[] => (dt ? [...dt.files] : [])

  return (
    <div
      className={`te${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        const list = files(e.dataTransfer)
        setDragging(false)
        if (!list.length) return
        e.preventDefault()
        if (mode !== 'write') setMode('write')
        void upload(list)
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          void save()
        }
        if (e.key === 'Escape' && !dirty) {
          e.stopPropagation()
          cancel()
        }
      }}
    >
      <input className="te-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />

      <div className="te-bar">
        <div className="seg-tabs" role="tablist" aria-label="Write or preview">
          <button type="button" role="tab" aria-selected={mode === 'write'} className={mode === 'write' ? 'on' : ''} onClick={() => setMode('write')}>
            Write
          </button>
          <button type="button" role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>
            Preview
          </button>
        </div>
        {mode === 'write' && (
          <div className="te-tools" role="toolbar" aria-label="Formatting">
            <button type="button" title="Heading" onClick={() => linePrefix('## ')}>
              H
            </button>
            <button type="button" title="Bold (Ctrl+B)" onClick={() => wrap('**')}>
              <b>B</b>
            </button>
            <button type="button" title="Italic (Ctrl+I)" onClick={() => wrap('_')}>
              <i>I</i>
            </button>
            <button type="button" title="Code" onClick={() => wrap('`', '`', 'code')}>
              {'</>'}
            </button>
            <button type="button" title="Link" onClick={() => wrap('[', '](https://)', 'link text')}>
              Link
            </button>
            <span className="te-sep" />
            <button type="button" title="Bulleted list" onClick={() => linePrefix('- ')}>
              • List
            </button>
            <button type="button" title="Checklist" onClick={() => linePrefix('- [ ] ')}>
              ☐ Todo
            </button>
            <button type="button" title="Quote" onClick={() => linePrefix('> ')}>
              ❝
            </button>
            <span className="te-sep" />
            <button type="button" title="Attach images or files (or drop them here, or paste)" onClick={() => fileInput.current?.click()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
              </svg>
              Attach
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const list = [...(e.target.files ?? [])]
                e.target.value = ''
                if (list.length) void upload(list)
              }}
            />
          </div>
        )}
      </div>

      {mode === 'write' ? (
        <textarea
          ref={area}
          className="te-area"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write in Markdown. Drop or paste images and files to upload them."
          spellCheck
          onPaste={(e) => {
            const list = files(e.clipboardData)
            if (!list.length) return
            e.preventDefault()
            void upload(list)
          }}
          onKeyDown={(e) => {
            if (!(e.ctrlKey || e.metaKey)) return
            const k = e.key.toLowerCase()
            if (k === 'b') {
              e.preventDefault()
              wrap('**')
            } else if (k === 'i') {
              e.preventDefault()
              wrap('_')
            }
          }}
        />
      ) : (
        <div className="te-preview">{body.trim() ? <Markdown text={body} /> : <p className="note">Nothing to preview.</p>}</div>
      )}

      {dragging && <div className="te-drop">Drop to upload to Linear</div>}

      <div className="te-foot">
        {error && <span className="note warn te-error">{error}</span>}
        {!error && uploads > 0 && <span className="note">Uploading {uploads} file{uploads === 1 ? '' : 's'}…</span>}
        {!error && !uploads && <span className="note">{dirty ? 'Unsaved changes · Ctrl+S to save' : 'No changes yet'}</span>}
        <span className="spacer" />
        {conflict && (
          <button type="button" className="btn small danger" disabled={saving || uploads > 0} onClick={() => void save(true)}>
            Save anyway
          </button>
        )}
        <button type="button" className="btn small" onClick={cancel} disabled={saving}>
          {dirty ? 'Discard' : 'Cancel'}
        </button>
        <button type="button" className="btn small primary" disabled={saving || uploads > 0 || !dirty || !title.trim()} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save to Linear'}
        </button>
      </div>
    </div>
  )
}
