// Stroke icons from the design (24px grid, drawn in currentColor). Decorative: the button or text
// beside each one carries the name.

export const ICON = {
  board: 'M3 3h7v18H3zM14 3h7v10h-7z',
  agents: 'M12 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21a8 8 0 0 1 16 0',
  auto: 'M13 2 4 14h7l-1 8 9-12h-7z',
  actions: 'M7 4v16l13-8z',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  usage: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  chevron: 'm6 9 6 6 6-6',
  refresh: 'M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M3 21v-5h5',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm9 16-3.5-3.5',
  filters: 'M3 5h18M6 12h12M10 19h4',
  warn: 'M12 3 2 21h20L12 3zM12 10v4M12 17.5v.5',
  blocked: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM8 12h8',
  flag: 'M5 21V4h11l-2 4 2 4H5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  external: 'M7 17 17 7M8 7h9v9',
  close: 'M6 6l12 12M18 6 6 18',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  plus: 'M12 5v14M5 12h14',
  script: 'M4 17l6-5-6-5M12 19h8',
  claude: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  up: 'M12 19V5M6 11l6-6 6 6',
  tickets: 'M4 5h16v14H4zM4 10h16M9 5v14',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  back: 'M19 12H5M11 6l-6 6 6 6',
  check: 'm5 12 5 5 9-10',
  minus: 'M5 12h14',
  stop: 'M7 7h10v10H7z',
  branch: 'M6 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM6 15.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM18 6.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM6 8.5v7M18 11.5a6 6 0 0 1-6 6H8.5',
  chevronRight: 'm9 6 6 6-6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  settings:
    'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'
} as const

export type IconName = keyof typeof ICON

export function Icon({ name, size = 16, width = 2, className }: { name: IconName; size?: number; width?: number; className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON[name]} />
    </svg>
  )
}

// The solid play triangle on the Run action button.
export function PlayIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M7 4v16l13-8z" />
    </svg>
  )
}
