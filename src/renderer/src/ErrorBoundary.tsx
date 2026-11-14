import { Component, type ReactNode } from 'react'

interface State {
  error: Error | null
}

// Shows what went wrong instead of a blank window if the UI crashes.
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('Night Shift UI crashed:', error)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h1>Something went wrong in Night Shift</h1>
        <p className="note">Runs keep going in the background. Reloading the window usually fixes this; if it doesn't, restart Night Shift.</p>
        <pre className="log">{error.stack ?? error.message}</pre>
        <button className="btn primary" type="button" onClick={() => location.reload()}>
          Reload window
        </button>
      </div>
    )
  }
}
