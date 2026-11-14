import type { NightShiftApi } from '../../shared/types'

declare global {
  interface Window {
    nightShift: NightShiftApi
  }
}

export {}
