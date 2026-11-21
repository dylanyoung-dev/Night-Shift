import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './ErrorBoundary'
import '@fontsource-variable/inter'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './styles.css'

// Width of the window buttons (minimize, maximize, close) drawn over the top bars, as --wco, so headers
// leave room for them. Measured here because CSS env(titlebar-area-*) isn't always available.
type Overlay = EventTarget & { visible: boolean; getTitlebarAreaRect(): DOMRect }
const overlay = (navigator as Navigator & { windowControlsOverlay?: Overlay }).windowControlsOverlay
function measureControls(): void {
  if (!overlay?.visible) return
  const r = overlay.getTitlebarAreaRect()
  const w = Math.max(0, Math.round(window.innerWidth - (r.x + r.width)))
  document.documentElement.style.setProperty('--wco', `${w || 138}px`)
}
if (overlay) {
  measureControls()
  overlay.addEventListener('geometrychange', measureControls)
  window.addEventListener('resize', measureControls)
} else if (/Windows/.test(navigator.userAgent)) {
  document.documentElement.style.setProperty('--wco', '138px') // Windows' three caption buttons
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
