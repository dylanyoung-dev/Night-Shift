import { app } from 'electron'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Automation, NightShiftProject, SaveConflict, SharedSettings, StepSet } from '../shared/types'

// Shared settings (actions, automations, projects and a few scalars) have one copy, on the host, and
// can be edited from the host's window or any remote. Each item has a revision: a short hash of its
// content. A save carries the revisions the editor started from; an item someone else changed in the
// meantime is a conflict and nothing is saved. Items the editor didn't touch are taken from the
// current copy, so edits to different items on different machines never overwrite each other.

export const SHARED_SCALARS = ['linearTeamKey', 'baseBranch', 'worktreeMode', 'pollSeconds'] as const
type Scalar = (typeof SHARED_SCALARS)[number]

// Key order and undefined fields don't count, so an item that round-trips through the editor unchanged
// keeps its revision.
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])])
    )
  }
  return v ?? null
}

export function rev(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(canonical(value))).digest('hex').slice(0, 12)
}

const actionKey = (s: StepSet): string => `action:${s.name.trim().toLowerCase()}`

export function settingsRevs(s: SharedSettings): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of SHARED_SCALARS) out[`setting:${k}`] = rev(s[k])
  for (const p of s.projects) out[`project:${p.id}`] = rev(p)
  for (const a of s.automations) out[`automation:${a.id}`] = rev(a)
  return out
}

export function actionRevs(sets: StepSet[]): Record<string, string> {
  return Object.fromEntries(sets.map((s) => [actionKey(s), rev(s)]))
}

// Who last saved each item, so a conflict can say "changed on DylanLaptop at 10:42".
interface Edit {
  by: string
  at: number
}
let edits: Record<string, Edit> | null = null
const editsFile = (): string => join(app.getPath('userData'), 'shared-edits.json')
function loadEdits(): Record<string, Edit> {
  if (!edits) {
    try {
      edits = JSON.parse(readFileSync(editsFile(), 'utf8')) as Record<string, Edit>
    } catch {
      edits = {}
    }
  }
  return edits
}
export function noteEdits(keys: string[], by: string): void {
  const e = loadEdits()
  const at = Date.now()
  for (const k of keys) e[k] = { by, at }
  try {
    writeFileSync(editsFile(), JSON.stringify(e))
  } catch {
    /* best effort */
  }
}
function lastEdit(key: string): Edit | undefined {
  return loadEdits()[key]
}

interface Merged<T> {
  items: T[]
  conflicts: SaveConflict['items']
  changed: string[] // keys this save changes
}

// Three-way merge of one list: current (host), incoming (editor), base revisions (what the editor loaded).
function mergeList<T>(kind: SaveConflict['items'][number]['kind'], current: T[], incoming: T[], base: Record<string, string>, keyOf: (x: T) => string, nameOf: (x: T) => string): Merged<T> {
  const cur = new Map(current.map((x) => [keyOf(x), x]))
  const inc = new Map(incoming.map((x) => [keyOf(x), x]))
  const conflicts: Merged<T>['conflicts'] = []
  const changed: string[] = []
  const conflict = (key: string, name: string): void => {
    const e = lastEdit(key)
    conflicts.push({ kind, key, name, by: e?.by, at: e?.at })
  }
  const out: T[] = []
  for (const [key, x] of inc) {
    const b = base[key]
    const c = cur.get(key)
    if (b === undefined) {
      // New in the editor. Clashes only if someone else added the same one differently.
      if (c && rev(c) !== rev(x)) conflict(key, nameOf(x))
      out.push(x)
      if (!c || rev(c) !== rev(x)) changed.push(key)
    } else if (rev(x) === b) {
      if (c) out.push(c) // untouched here: keep the current copy (maybe changed elsewhere)
    } else if (c && rev(c) === b) {
      out.push(x) // changed here only
      changed.push(key)
    } else {
      conflict(key, nameOf(x)) // changed here, and changed or deleted elsewhere
      if (c) out.push(c)
    }
  }
  for (const [key, c] of cur) {
    if (inc.has(key)) continue
    const b = base[key]
    if (b === undefined) out.push(c) // added elsewhere since the editor loaded
    else if (rev(c) !== b) {
      conflict(key, nameOf(c)) // deleted here, but changed elsewhere
      out.push(c)
    } else changed.push(key) // deleted here
  }
  return { items: out, conflicts, changed }
}

export function mergeSettings(current: SharedSettings, incoming: Partial<SharedSettings>, base: Record<string, string>): { next: SharedSettings; conflicts: SaveConflict['items']; changed: string[] } {
  const next = { ...current }
  const conflicts: SaveConflict['items'] = []
  const changed: string[] = []
  for (const k of SHARED_SCALARS) {
    if (!(k in incoming)) continue
    const key = `setting:${k}`
    const v = incoming[k as Scalar]
    if (rev(v) === rev(current[k])) continue
    const b = base[key]
    if (b !== undefined && rev(v) === b) continue // untouched by this editor (the form sends every field): keep the current value
    if (b !== undefined && rev(current[k]) !== b) {
      const e = lastEdit(key)
      conflicts.push({ kind: 'setting', key, name: k, by: e?.by, at: e?.at })
      continue
    }
    ;(next as Record<string, unknown>)[k] = v
    changed.push(key)
  }
  if (incoming.projects) {
    const m = mergeList<NightShiftProject>('project', current.projects, incoming.projects, base, (p) => `project:${p.id}`, (p) => p.name)
    next.projects = m.items
    conflicts.push(...m.conflicts)
    changed.push(...m.changed)
  }
  if (incoming.automations) {
    const m = mergeList<Automation>('automation', current.automations, incoming.automations, base, (a) => `automation:${a.id}`, (a) => a.name)
    next.automations = m.items
    conflicts.push(...m.conflicts)
    changed.push(...m.changed)
  }
  return { next, conflicts, changed }
}

export function mergeActions(current: StepSet[], incoming: StepSet[], base: Record<string, string>): Merged<StepSet> {
  return mergeList<StepSet>('action', current, incoming, base, actionKey, (s) => s.name)
}

// "Changed on DylanLaptop at 10:42 while you were editing: Build steps. Your change wasn't saved."
export function conflictMessage(items: SaveConflict['items']): string {
  const names = items.map((i) => `${i.kind === 'setting' ? 'the setting' : `the ${i.kind}`} "${i.name}"`).join(', ')
  const who = items.find((i) => i.by)
  const where = who ? ` on ${who.by}${who.at ? ` at ${new Date(who.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}` : ' somewhere else'
  return `Changed${where} while you were editing: ${names}. Your change wasn't saved.`
}
