// Shown when a save was refused because someone changed the same item on another machine meanwhile.
// Nothing was saved; the person chooses what happens next.
export default function ConflictBanner({
  message,
  onLoadTheirs,
  onKeepMine
}: {
  message: string
  onLoadTheirs(): void // drop the edits here and show the saved version
  onKeepMine(): void // keep the edits on screen; the next save replaces the other version
}): JSX.Element {
  return (
    <div className="banner inline conflict" role="alert">
      <span>{message}</span>
      <span className="row-actions">
        <button className="btn small" type="button" onClick={onLoadTheirs}>
          Load their version
        </button>
        <button className="btn small" type="button" onClick={onKeepMine} title="Keep your edits on screen; saving again replaces their version">
          Keep my edits
        </button>
      </span>
    </div>
  )
}
