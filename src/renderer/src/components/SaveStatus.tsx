import { useEffect, useRef, useState } from 'react'

// One save indicator for every editor (Settings, Actions, Automations, Projects): sits beside the Save
// button, vertically centred. Unsaved shows an amber dot; Saving a spinner; Saved a tick that fades
// after a few seconds so it doesn't linger. Ctrl+S (Cmd+S) saves while there are changes.
export default function SaveStatus({ dirty, saving, saved, onSave }: { dirty: boolean; saving?: boolean; saved?: boolean; onSave?(): void }): JSX.Element | null {
  const [showSaved, setShowSaved] = useState(false)
  useEffect(() => {
    if (!saved || dirty || saving) return setShowSaved(false)
    setShowSaved(true)
    const t = setTimeout(() => setShowSaved(false), 2500)
    return () => clearTimeout(t)
  }, [saved, dirty, saving])

  const save = useRef(onSave)
  save.current = onSave
  useEffect(() => {
    if (!dirty || saving) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save.current?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty, saving])

  const state = saving ? 'saving' : dirty ? 'dirty' : showSaved ? 'saved' : null
  return (
    <span className={`save-status${state ? ` ${state}` : ''}`} role="status" aria-live="polite" title={state === 'dirty' && onSave ? 'Ctrl+S to save' : undefined}>
      {state === 'saving' && (
        <>
          <span className="save-spin" aria-hidden="true" />
          Saving…
        </>
      )}
      {state === 'dirty' && (
        <>
          <span className="save-dot" aria-hidden="true" />
          Unsaved changes
        </>
      )}
      {state === 'saved' && (
        <>
          <svg className="save-tick" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 6.3 5 8.7l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Saved
        </>
      )}
    </span>
  )
}
