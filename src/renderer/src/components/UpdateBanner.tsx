import { useEffect, useState } from 'react'
import type { UpdateState } from '../../../shared/types'

// "Update ready" toast. Never forces a restart: ignoring it installs the update on the next quit.
export default function UpdateBanner({ running }: { running: number }): JSX.Element | null {
  const [state, setState] = useState<UpdateState | null>(null)
  const [hidden, setHidden] = useState<string | null>(null) // version dismissed for now
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    void window.nightShift.getUpdateState?.().then(setState)
    return window.nightShift.onUpdateState?.(setState)
  }, [])

  if (!state || state.status !== 'ready' || hidden === state.available) return null
  return (
    <div className="update-banner" role="status">
      <div className="update-text">
        <b>Update ready, restart to install</b>
        <span className="note">
          Night Shift {state.available} is downloaded.{' '}
          {running > 0 ? `Restarting stops ${running} running ${running === 1 ? 'agent' : 'agents'}. ` : ''}
          Otherwise it installs when you quit.
        </span>
      </div>
      <button
        className="btn small primary"
        type="button"
        disabled={restarting}
        onClick={() => {
          setRestarting(true)
          void window.nightShift.installUpdate?.()
        }}
      >
        {restarting ? 'Restarting…' : 'Restart'}
      </button>
      <button className="btn small" type="button" onClick={() => setHidden(state.available ?? null)} title="Hide until next launch">
        Later
      </button>
    </div>
  )
}
