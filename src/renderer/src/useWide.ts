import { useEffect, useState } from 'react'

// One responsive app: at 1800px and up the full sidebar, inline filters and a docked ticket panel;
// below that an icon rail, a Filters button, sideways-scrolling columns and the ticket as a drawer.
const WIDE = '(min-width: 1800px)'

export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches)
  useEffect(() => {
    const mq = window.matchMedia(WIDE)
    const on = (): void => setWide(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}
