import { useEffect, useState } from 'react'

// "Restart to update". Quitting and starting the new version takes a few seconds, so once clicked the
// button turns grey with a spinner and can't be clicked again. If Night Shift is somehow still here
// after 30 seconds, the button comes back so it can be tried again.
export default function RestartButton({ label = 'Restart to update', className = 'btn small primary' }: { label?: string; className?: string }): JSX.Element {
  const [restarting, setRestarting] = useState(false)
  useEffect(() => {
    if (!restarting) return
    const t = setTimeout(() => setRestarting(false), 30_000)
    return () => clearTimeout(t)
  }, [restarting])
  return (
    <button
      className={`${className}${restarting ? ' busy' : ''}`}
      type="button"
      disabled={restarting}
      aria-busy={restarting}
      onClick={() => {
        setRestarting(true)
        void window.nightShift.installUpdate?.()
      }}
    >
      {restarting && <span className="btn-spin" aria-hidden="true" />}
      {restarting ? 'Restarting…' : label}
    </button>
  )
}
