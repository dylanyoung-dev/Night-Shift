import type { Run } from '../../../shared/types'
import { duration, runColor, runLabel } from '../util'

interface Props {
  runs: Run[]
  onOpen(run: Run): void
  title?: string
  note?: string
  empty?: string
}

export default function RunsView({
  runs,
  onOpen,
  title = 'Run history',
  note = 'Last 200 runs on this machine',
  empty = 'No runs yet.'
}: Props): JSX.Element {
  return (
    <div className="page">
      <div className="header">
        <h1>{title}</h1>
        <span className="note">{note}</span>
      </div>
      {!runs.length && <div className="empty">{empty}</div>}
      {runs.map((r) => (
        <div key={r.id} className="steprow" style={{ gridTemplateColumns: '16px 90px minmax(0,1fr) 140px 100px' }}>
          <span className="dot" style={{ background: runColor[r.status] }} />
          <span className="mono">{r.identifier}</span>
          <span style={{ fontSize: 13 }}>
            {r.title}
            <span className="mono"> · {r.stepsName}</span>
            {r.startedBy && <span className="mono"> · by {r.startedBy}</span>}
          </span>
          <span className="mono">
            {runLabel[r.status]} · {duration(r.startedAt, r.endedAt)}
          </span>
          <button className="btn small" type="button" onClick={() => onOpen(r)}>
            Open
          </button>
        </div>
      ))}
    </div>
  )
}
