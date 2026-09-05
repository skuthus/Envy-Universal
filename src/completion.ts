//! Inline ghost-text completion inside the editor, for `[[wiki-links]]` and
//! `#tags` — the grey suffix that appears as you type and is accepted with Tab
//! or the Right arrow.
//!
//! Ported from the Mac's `updateWikiLinkGhostSuggestion` /
//! `updateTagGhostSuggestion`. Two rules, one at a time:
//!
//! - **Wiki-link**: an open `[[` on the current line with no `]]` before the
//!   caret, the caret at the end of the query (nothing but a closing `]]`
//!   ahead), completes against note titles most-recent-first.
//! - **Tag**: a `#` at a word boundary with an all-tag-body fragment after it
//!   and no tag character under the caret, completes against tags most-used
//!   first.
//! - **Slash command**: a `/` at the start of a line or after a space, with a
//!   command name being typed after it. Unlike the other two this does not
//!   complete to text — Tab runs the command, which replaces the `/word` with
//!   whatever it inserts (today: `/table`).
//!
//! An *open* `[[` commits to link completion — it never falls through to a tag.
//! The tag rule only applies when there is no open `[[` on the line.

import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  keymap,
} from '@codemirror/view'
import { type EditorState, Facet, Prec } from '@codemirror/state'
import { invoke } from '@tauri-apps/api/core'
import { insertTable } from './tables'

/// The suggestion pools, read fresh each time so they track edits and moves
/// without the extension having to be reconfigured. `titles` is note titles
/// most-recently-modified first; `tags` is tag names most-used first — the same
/// two lists the search box completes from.
export interface CompletionSources {
  titles: string[]
  tags: string[]
}

export const completionSources = Facet.define<
  () => CompletionSources,
  () => CompletionSources
>({
  combine: (values) => values[0] ?? (() => ({ titles: [], tags: [] })),
})

/// The two pools straight from Rust — the same projections the main window's
/// search box refreshes on every search. For the editors that don't have those
/// lists on hand (the peek and embeds, the pop-out and pinned windows), so a
/// `#tag` or `[[link]]` completes there exactly as it does in the main editor.
/// Both calls are cheap; a failure leaves the pools empty rather than throwing
/// into a window that has nothing to show for it.
export async function loadCompletionSources(): Promise<CompletionSources> {
  try {
    const [tags, titles] = await Promise.all([
      invoke<string[]>('all_tags'),
      invoke<string[]>('all_titles'),
    ])
    return { titles, tags }
  } catch (err) {
    console.error('could not load completion sources', err)
    return { titles: [], tags: [] }
  }
}

/// A tag-body character: what may appear *after* the `#`. Matches the Mac's
/// `isTagBodyChar` (alphanumeric, `_`, `-`).
function isTagBody(ch: string): boolean {
  return /[A-Za-z0-9_-]/.test(ch)
}

/// A character that, immediately before a `#`, stops it from opening a tag —
/// so `a#b` and `##h` are not tag starts. The Mac's `blocksTagStart`
/// (alphanumeric, `_`, `#`).
function blocksTagStart(ch: string): boolean {
  return /[A-Za-z0-9_#]/.test(ch)
}

/// A command offered by typing `/name`. `run` gets the range the `/name`
/// occupies, so it replaces what was typed rather than leaving it behind.
interface SlashCommand {
  name: string
  label: string
  run: (view: EditorView, from: number, to: number) => boolean
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'table',
    label: 'Insert table',
    run: (view, from, to) => {
      // Two transactions rather than one: the skeleton's own command decides
      // how much blank line it needs, and it can only see that once the
      // `/table` it replaces is gone. Both are `input`, so one undo covers
      // them.
      view.dispatch({
        changes: { from, to, insert: '' },
        selection: { anchor: from },
        userEvent: 'input',
      })
      return insertTable(view)
    },
  },
]

/// What the ghost layer is offering: the grey text to draw after the caret,
/// an optional label naming the action, and the command to run if there is
/// one. A pure function of the state, so the plugin and the accept command
/// agree on exactly one answer.
interface GhostSuggestion {
  text: string
  label?: string
  command?: SlashCommand
  from?: number
  to?: number
}

function ghostSuggestion(state: EditorState): GhostSuggestion | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const pos = sel.head
  const line = state.doc.lineAt(pos)
  const before = state.doc.sliceString(line.from, pos)
  const sources = state.facet(completionSources)()

  // --- Wiki-link ---------------------------------------------------------
  const lastOpen = before.lastIndexOf('[[')
  if (lastOpen !== -1) {
    const between = before.slice(lastOpen + 2)
    // A `]]` between the opener and the caret means that link is already
    // closed — fall through to the tag rule below. Anything else keeps us in
    // link context and commits to it.
    if (!between.includes(']]')) {
      const query = between
      if (!query || query.includes('[') || query.includes(']')) return null
      // The caret must sit at the end of the query — either the end of the
      // line, or immediately before the closing `]]`. Text in between means
      // the user is editing a finished link, not extending a new one.
      const after = state.doc.sliceString(pos, line.to)
      const closeAhead = after.indexOf(']]')
      const trailing = closeAhead === -1 ? '' : after.slice(0, closeAhead)
      if (trailing !== '') return null
      const lowered = query.toLowerCase()
      const match = sources.titles.find(
        (t) => t.toLowerCase().startsWith(lowered) && t.length > query.length,
      )
      return match ? { text: match.slice(query.length) } : null
    }
  }

  // --- Slash command -----------------------------------------------------
  // After the link rule, which commits to an open `[[` — a `/` inside one is
  // part of a path, not a command.
  // At least one letter typed: a bare `/` is a slash far more often than it is
  // the start of a command, and offering on it would put a table one stray Tab
  // away from every path and date.
  const slash = /(^|\s)\/([A-Za-z]+)$/.exec(before)
  if (slash) {
    // Mid-word: the caret has to sit at the end of what was typed, or this is
    // an old command being edited rather than a new one being written.
    const charAfter = state.doc.sliceString(pos, pos + 1)
    if (!/[A-Za-z]/.test(charAfter)) {
      const fragment = slash[2].toLowerCase()
      const command = SLASH_COMMANDS.find((c) => c.name.startsWith(fragment))
      if (command) {
        const from = pos - fragment.length - 1
        return {
          text: command.name.slice(fragment.length),
          label: command.label,
          command,
          from,
          to: pos,
        }
      }
    }
  }

  // --- Tag ---------------------------------------------------------------
  const lastHash = before.lastIndexOf('#')
  if (lastHash === -1) return null
  // The `#` must open a tag: a word character (or another `#`) right before it
  // disqualifies it.
  if (lastHash > 0 && blocksTagStart(before[lastHash - 1])) return null
  const fragment = before.slice(lastHash + 1)
  if (!fragment) return null
  // Every character since the `#` must be a tag-body character — a space or
  // punctuation means the `#` was not the start of the tag being typed.
  if (![...fragment].every(isTagBody)) return null
  // And the caret must be at the fragment's end: a tag character right after it
  // means we are in the middle of an existing tag, not extending its tail.
  const charAfter = state.doc.sliceString(pos, pos + 1)
  if (charAfter && isTagBody(charAfter)) return null

  const lowered = fragment.toLowerCase()
  const match = sources.tags.find(
    (t) => t.startsWith(lowered) && t.length > fragment.length,
  )
  return match ? { text: match.slice(fragment.length) } : null
}

/// The remainder alone, for the tests and anything that only wants the text.
function ghostRemainder(state: EditorState): string | null {
  return ghostSuggestion(state)?.text || null
}

/// The grey suffix drawn at the caret. An `atomic`-free widget with `side: 1`
/// so it sits after the cursor without becoming part of the document.
class GhostWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly label: string,
  ) {
    super()
  }
  eq(other: GhostWidget) {
    return other.text === this.text && other.label === this.label
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-ghost-completion'
    span.textContent = this.text
    // A command names what Tab would do; a plain completion is its own label.
    if (this.label) {
      const hint = document.createElement('span')
      hint.className = 'cm-ghost-hint'
      hint.textContent = ` ${this.label} ⇥`
      span.append(hint)
    }
    return span
  }
  ignoreEvent() {
    return false
  }
}

const ghostPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    /// What is currently shown, so the accept command acts on exactly that
    /// rather than recomputing and possibly disagreeing with the screen.
    suggestion: GhostSuggestion | null = null

    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }

    update(update: ViewUpdate) {
      // Recompute on anything that could move the caret or change the text —
      // and on focus, since a blurred editor should show nothing.
      if (update.docChanged || update.selectionSet || update.focusChanged) {
        this.decorations = this.build(update.view)
      }
    }

    build(view: EditorView): DecorationSet {
      this.suggestion = null
      if (!view.hasFocus) return Decoration.none
      const found = ghostSuggestion(view.state)
      // A command whose name is fully typed has no remainder left to draw, but
      // its label still has to say that Tab will do something.
      if (!found || (!found.text && !found.label)) return Decoration.none
      this.suggestion = found
      const pos = view.state.selection.main.head
      return Decoration.set([
        Decoration.widget({
          widget: new GhostWidget(found.text, found.label ?? ''),
          side: 1,
        }).range(pos),
      ])
    }
  },
  { decorations: (v) => v.decorations },
)

/// Inserts the visible ghost at the caret — or runs it, when it is a command.
/// Returns false when there is none, so Tab and the Right arrow keep their
/// normal meaning the rest of the time.
///
/// `allowCommand` is false for the Right arrow: moving the caret right should
/// never build a table, whereas Tab is the deliberate "take it" gesture.
function acceptGhost(view: EditorView, allowCommand = true): boolean {
  const plugin = view.plugin(ghostPlugin)
  const found = plugin?.suggestion
  if (!found) return false
  if (found.command) {
    if (!allowCommand) return false
    return found.command.run(view, found.from!, found.to!)
  }
  const remainder = found.text
  if (!remainder) return false
  const pos = view.state.selection.main.head
  view.dispatch({
    changes: { from: pos, insert: remainder },
    selection: { anchor: pos + remainder.length },
    // One transaction, so a single undo takes the whole completion back.
    userEvent: 'input.complete',
  })
  return true
}

/// Tab and Right accept. Right as well as Tab because the caret is already at
/// the end of what's typed, so "move right" and "take the suggestion" are the
/// same gesture — and both fall through when no ghost is showing.
const ghostKeymap = Prec.highest(
  keymap.of([
    { key: 'Tab', run: acceptGhost },
    { key: 'ArrowRight', run: (v) => acceptGhost(v, false) },
  ]),
)

export const editorCompletion = [ghostPlugin, ghostKeymap]

/// Exposed for tests only — the pure completion decision, without the focus
/// guard the on-screen plugin applies, so it can be exercised in a headless
/// editor that cannot take real focus.
export function ghostRemainderForTest(state: EditorState): string | null {
  return ghostRemainder(state)
}
