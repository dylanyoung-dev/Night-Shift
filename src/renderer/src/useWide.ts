import { useEffect, useState } from 'react'

// One responsive app: at 1800px and up the full sidebar, inline filters and a docked ticket panel;
// below that an icon rail, a Filters button, sideways-scrolling columns and the ticket as a drawer.
const WIDE = '(min-width: 1800px)'

// The full sidebar needs more room than the rest: below 2200px it folds to the icon rail, so a laptop
// keeps its width for the board.
const WIDE_SIDEBAR = '(min-width: 2200px)'

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const update = (): void => setOn(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [query])
  return on
}

export function useWide(): boolean {
  return useMedia(WIDE)
}

export function useWideSidebar(): boolean {
  return useMedia(WIDE_SIDEBAR)
}
