//! A small live editor showing one note, used by embeds and the link preview.
//!
//! One code path for "show another note's content and let me click into it",
//! rather than a read-only renderer that has to be kept in step with the real
//! editor. Both places want exactly the same behaviour, and the Mac reuses
//! `MarkdownTextView` for both for the same reason.
//!
//! Starts non-editable and flips on first click, so scrolling past one while
//! reading can never start typing into a different file.

import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { allowEmbeds, envyStyler, searchQueryField } from './styler'
import { tableEditing } from './tables'
import { autoPairing, completionTransforms, emphasisKeymap } from './input'
import {
  editorCompletion,
  completionSources,
  loadCompletionSources,
  type CompletionSources,
} from './completion'
import { bindingFor } from './shortcuts'

/// Ghost-completion pools shared by every mini editor in this window, read
/// through a closure so a refresh reaches editors already on screen. Refreshed
/// when an editor is created — the moment a peek opens or an embed mounts —
/// but coalesced, since a note with several embeds mounts them all at once and
/// one fetch serves the lot.
let sources: CompletionSources = { titles: [], tags: [] }
let sourcesFetchedAt = 0
function refreshSources() {
  const now = Date.now()
  if (now - sourcesFetchedAt < 1000) return
  sourcesFetchedAt = now
  void loadCompletionSources().then((s) => {
    sources = s
  })
}

export interface MiniNote {
  id: string
  title: string
  content: string
}

export interface MiniNoteEditor {
  view: EditorView
  /// Whether it has been clicked into. An embed being edited is skipped when
  /// refreshing from disk — a refresh must never yank text out from under
  /// someone mid-sentence.
  isEditable(): boolean
  /// Replaces the content without going through the save path, for pulling a
  /// fresh copy in from disk.
  setContent(content: string): void
  /// Flushes any pending save. Call before the container goes away — hiding is
  /// the normal way these close, and a debounce in flight would otherwise be
  /// dropped with it.
  flush(): Promise<void>
  destroy(): void
}

export function createMiniNoteEditor(
  parent: HTMLElement,
  note: MiniNote,
  save: (id: string, content: string) => Promise<void>,
  opts: { allowEmbeds?: boolean } = {},
): MiniNoteEditor {
  // Its own compartment, not a shared one: a module-level compartment is a
  // single reconfigurable slot, so the first click into any of these would
  // flip every one on screen to editable at once.
  const editable = new Compartment()
  let isEditable = false
  let lastSynced = note.content
  let timer: number | undefined
  refreshSources()

  const commit = async () => {
    const content = view.state.doc.toString()
    if (content === lastSynced) return
    await save(note.id, content)
    lastSynced = content
  }

  const view = new EditorView({
    state: EditorState.create({
      doc: note.content,
      extensions: [
        EditorView.lineWrapping,
        searchQueryField,
        // Never embeds inside an embed or a preview — a note embedding itself,
        // or two embedding each other, would expand forever.
        allowEmbeds.of(opts.allowEmbeds ?? false),
        envyStyler,
        tableEditing,
        completionTransforms,
        autoPairing,
        // Ghost text for `[[links]]` and `#tags`, as in the main editor — the
        // Mac's peeks and pop-outs complete too (1.8.5).
        editorCompletion,
        completionSources.of(() => sources),
        // Embeds and previews follow the same remapped bindings as the main
        // editor — a shortcut that works in one and not the other would be
        // worse than not having it here at all.
        keymap.of(emphasisKeymap(bindingFor('bold'), bindingFor('italic'))),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        editable.of(EditorView.editable.of(false)),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || !isEditable) return
          window.clearTimeout(timer)
          timer = window.setTimeout(() => {
            timer = undefined
            void commit()
          }, 400)
        }),
      ],
    }),
    parent,
  })

  parent.addEventListener('mousedown', () => {
    if (isEditable) return
    isEditable = true
    view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(true)) })
    // The click that flipped it is already spent, so focus has to be given
    // explicitly or the first click only ever arms the editor.
    view.focus()
  })

  return {
    view,
    isEditable: () => isEditable,
    setContent(content) {
      lastSynced = content
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
    },
    async flush() {
      window.clearTimeout(timer)
      timer = undefined
      await commit()
    },
    destroy() {
      window.clearTimeout(timer)
      view.destroy()
    },
  }
}
