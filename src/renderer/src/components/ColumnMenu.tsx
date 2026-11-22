import { useEffect, useRef } from 'react'
import type { ColumnSettings } from '../../../shared/types'

// A board column's settings, from the gear on its header (or a right-click on the header): its background color, and
// whether it's greyed out. Saved with this machine's settings, by state name.

// Light tints: they become the column's background.
const SWATCHES = ['#e9edf2', '#e4e7fb', '#dcf1f6', '#dff3e7', '#fbf1d3', '#fce6d6', '#fadede', '#ece3fc', '#f9e2f1', '#ecebe6']

export default function ColumnMenu({
  name,
  value,
  at,
  onChange,
  onClose
}: {
  name: string
  value: ColumnSettings
  at: { x: number; y: number }
  onChange(next: ColumnSettings): void
  onClose(): void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose) // the board re-renders often; keep one listener
  closeRef.current = onClose

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, input')?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [])

  // Keep it on screen.
  const left = Math.max(8, Math.min(at.x, window.innerWidth - 280))
  const top = Math.max(8, Math.min(at.y, window.innerHeight - 260))
  const set = (patch: Partial<ColumnSettings>): void => {
    const next = { ...value, ...patch }
    if (!next.color) delete next.color
    if (!next.muted) delete next.muted
    onChange(next)
  }

  return (
    <div ref={ref} className="col-menu" role="dialog" aria-label={`${name} column settings`} style={{ left, top }}>
      <div className="col-menu-title">{name}</div>

      <div className="col-menu-sec">
        <div className="col-menu-label">Color</div>
        <div className="col-swatches" role="radiogroup" aria-label="Column background color">
          <button type="button" role="radio" aria-checked={!value.color} className={`col-swatch linear${!value.color ? ' on' : ''}`} title="No color" onClick={() => set({ color: undefined })}>
            <span aria-hidden="true">L</span>
          </button>
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={value.color === c}
              aria-label={c}
              className={`col-swatch${value.color === c ? ' on' : ''}`}
              style={{ background: c }}
              onClick={() => set({ color: c })}
            />
          ))}
          <label className="col-swatch custom" title="Pick any color">
            <span className="sr-only">Custom color</span>
            <input type="color" value={value.color ?? '#e4e7fb'} onChange={(e) => set({ color: e.target.value })} />
          </label>
        </div>
      </div>

      <label className="col-menu-check">
        <input type="checkbox" checked={!!value.muted} onChange={(e) => set({ muted: e.target.checked })} />
        <span>
          Grey out this column
          <span className="note">Still on the board and you can drag tickets in and out, but it&apos;s set apart from the rest.</span>
        </span>
      </label>

      {(value.color || value.muted) && (
        <button type="button" className="btn small col-menu-reset" onClick={() => onChange({})}>
          Reset to Linear&apos;s look
        </button>
      )}
    </div>
  )
}
