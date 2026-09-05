//! Remappable keyboard shortcuts.
//!
//! Every binding the app reacts to is declared here, so there is one list to
//! read, one to remap, and one for the reference sheet to show. Handlers ask
//! `matches()` rather than testing keys themselves — a handler that checks
//! `e.key === 'l'` directly is a binding nobody can change and nobody can find.

import { map as configMap, setMapEntries, setMapEntry } from './config'

export type { ShortcutId, ShortcutSpec } from './shortcut-specs'
import { SHORTCUT_SPECS, type ShortcutId } from './shortcut-specs'
export { SHORTCUT_SPECS }

/// Remaps live in the config file's `[shortcuts]` table, `id = "Chord"`, so a
/// binding can be changed by hand or by an agent as well as by the recorder.
/// An id that isn't listed keeps its default — the table only ever holds the
/// chords somebody deliberately changed.
const TABLE = 'shortcuts'

function overrides(): Record<string, string> {
  return configMap(TABLE)
}

export function bindingFor(id: ShortcutId): string {
  const spec = SHORTCUT_SPECS.find((s) => s.id === id)
  return overrides()[id] ?? spec?.default ?? ''
}

export function setBinding(id: ShortcutId, binding: string | null) {
  setMapEntry(TABLE, id, binding)
}

export function resetAllBindings() {
  const cleared: Record<string, null> = {}
  for (const id of Object.keys(overrides())) cleared[id] = null
  setMapEntries(TABLE, cleared)
}

/// Canonical form of a keyboard event, so a binding compares as a string.
///
/// Modifier order is fixed rather than however they were pressed — otherwise
/// "Alt+Ctrl+P" and "Ctrl+Alt+P" would be different bindings that behave
/// identically, and only one of them would ever match.
export function eventToBinding(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  let key = e.key
  if (key === ' ') key = 'Space'
  // Single letters normalise to upper case so Shift doesn't change identity.
  else if (key.length === 1) key = key.toUpperCase()
  parts.push(key)
  return parts.join('+')
}

/// Whether an event is a bare modifier press. A recorder has to ignore these
/// or it captures "Ctrl" the instant you reach for a chord.
export function isModifierOnly(e: KeyboardEvent): boolean {
  return ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)
}

export function matches(id: ShortcutId, e: KeyboardEvent): boolean {
  return eventToBinding(e) === bindingFor(id)
}

/// Human-readable form for the reference sheet and the recorder.
export function displayBinding(binding: string): string {
  return binding
    .replace('ArrowDown', 'Down')
    .replace('ArrowUp', 'Up')
    .replace('ArrowLeft', 'Left')
    .replace('ArrowRight', 'Right')
}

/// Any binding used by more than one action. A clash means one of them can
/// never fire, and silently losing a shortcut is worse than being told.
export function conflicts(): Map<string, ShortcutId[]> {
  const byBinding = new Map<string, ShortcutId[]>()
  for (const spec of SHORTCUT_SPECS) {
    const b = bindingFor(spec.id)
    if (!b) continue
    byBinding.set(b, [...(byBinding.get(b) ?? []), spec.id])
  }
  for (const [b, ids] of byBinding) if (ids.length < 2) byBinding.delete(b)
  return byBinding
}

/// Every binding as it stands *now* — defaults with any remap applied — in the
/// display form. The reference sheet renders from this rather than from
/// `SHORTCUT_SPECS.default`, so a remapped chord is what the help says it is.
export function resolvedShortcuts(): { id: ShortcutId; label: string; chord: string }[] {
  return SHORTCUT_SPECS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    chord: displayBinding(bindingFor(spec.id)),
  }))
}

/// The three global bindings, in the form the Rust side registers them.
export function globalBindings(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spec of SHORTCUT_SPECS) {
    if (spec.global) out[spec.id] = bindingFor(spec.id)
  }
  return out
}
