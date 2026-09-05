//! The image attachment's right-click menu — size presets, caption, open,
//! rename, reveal — shared by every window that renders images. Size presets
//! rewrite the marker in the given editor; "Custom width…" and "Caption…" drop
//! the cursor into the marker's own slot instead of asking through a dialog;
//! rename is window-specific (its reference-rewrite reloads the note
//! differently in each window), so the flow takes the window's own flush/reload
//! hooks.

import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { invoke } from '@tauri-apps/api/core'
import { buildImageMarker, invalidateAttachment, type ImageEmbedSpec } from './styler'
import { openContextMenu } from './context-menu'
import { textPrompt, alertModal } from './prompt-modal'

/// Inserts `![[name]]` on its own line at the selection, with a leading break if
/// we're mid-line and a trailing blank line — the same shape the Mac's
/// `insertImageReference` uses (the blank line is where the picture sits).
export function insertImageReference(name: string, v: EditorView) {
  const sel = v.state.selection.main
  const atLineStart = sel.from === 0 || v.state.doc.sliceString(sel.from - 1, sel.from) === '\n'
  const insertion = `${atLineStart ? '' : '\n'}![[${name}]]\n\n`
  v.dispatch({
    changes: { from: sel.from, to: sel.to, insert: insertion },
    selection: { anchor: sel.from + insertion.length },
  })
  v.focus()
}

/// Replaces the first exact occurrence of an `![[…]]` marker in `view` with a
/// rewritten one — how the size menu changes an image's width. Keyed on the full
/// marker text rather than a stored position, so it stays correct after edits
/// above it.
export function rewriteEmbedMarker(view: EditorView, oldText: string, newText: string) {
  if (oldText === newText) return
  const at = view.state.doc.toString().indexOf(oldText)
  if (at === -1) return
  view.dispatch({ changes: { from: at, to: at + oldText.length, insert: newText } })
}

/// Which part of an image marker an inline edit targets.
export type ImageMarkerSlot = 'width' | 'caption'

/// Drops the cursor straight into the marker's width or caption slot — the
/// "no dialog at all" replacement for the modal caption/width prompts, ported
/// from the Mac's `beginInlineImageEdit`. The marker is rewritten into a
/// canonical `![[name|width|caption]]` shape with the slot's `|` present (an
/// empty slot parses identically to an absent one, so the intermediate state
/// renders the same), then the slot's current text is selected — typing
/// replaces it, in the note itself, exactly like the click-into-the-marker
/// editing the styler already teaches.
///
/// Keyed on the full marker text rather than a stored position, like
/// `rewriteEmbedMarker`, so it stays correct after edits above it. Returns
/// false when the marker is no longer in the document.
export function beginInlineImageEdit(
  view: EditorView,
  raw: string,
  spec: ImageEmbedSpec,
  slot: ImageMarkerSlot,
): boolean {
  const at = view.state.doc.toString().indexOf(raw)
  if (at === -1) return false

  const widthToken =
    spec.width === undefined
      ? ''
      : spec.height === undefined
        ? String(spec.width)
        : `${spec.width}x${spec.height}`
  const caption = spec.caption ?? ''

  // Build the canonical marker while tracking where the slot's text lands.
  // Offsets are in UTF-16 units, the same units CodeMirror positions use.
  let inner = spec.name
  let slotStart = 0
  let slotLength = 0
  if (slot === 'width') {
    inner += '|'
    slotStart = 3 + inner.length
    inner += widthToken
    slotLength = widthToken.length
    if (caption) inner += `|${caption}`
  } else {
    if (widthToken) inner += `|${widthToken}`
    inner += '|'
    slotStart = 3 + inner.length
    inner += caption
    slotLength = caption.length
  }
  const replacement = `![[${inner}]]`

  const selection = EditorSelection.range(at + slotStart, at + slotStart + slotLength)
  view.dispatch({
    changes: replacement === raw ? [] : { from: at, to: at + raw.length, insert: replacement },
    selection,
    effects: EditorView.scrollIntoView(selection.from),
  })
  view.focus()
  return true
}

/// The prompt-and-rewrite half of renaming an attachment. The file move and the
/// vault-wide reference rewrite happen in Rust; `flush` puts the open buffer on
/// disk first (so its references are there to rewrite) and `reload` refreshes it
/// after (so it shows the new name rather than saving the old one back).
export async function renameAttachmentFlow(
  oldName: string,
  hooks: { flush: () => Promise<void>; reload: () => Promise<void> },
) {
  // Only the stem is selected: the extension is kept for them below anyway,
  // and selecting it invites deleting it.
  const stem = oldName.lastIndexOf('.')
  const input = await textPrompt('Rename image to:', oldName, stem > 0 ? stem : undefined)
  if (input === null) return
  let next = input.trim()
  if (!next || next === oldName) return
  // Keep the extension if the user dropped it, so the reference stays an image.
  if (!next.includes('.')) {
    const dot = oldName.lastIndexOf('.')
    if (dot !== -1) next += oldName.slice(dot)
  }
  await hooks.flush()
  try {
    await invoke('rename_attachment', { oldName, newName: next })
  } catch (e) {
    await alertModal(typeof e === 'string' ? e : 'Could not rename the image.')
    return
  }
  // Both names are stale now: nothing answers to the old one any more, and the
  // new one may be reusing bytes cached for a file that has since been replaced.
  invalidateAttachment(oldName)
  invalidateAttachment(next)
  await hooks.reload()
}

/// Opens the image menu at (x, y). `onRename` is the window's rename flow.
export function openImageMenu(
  raw: string,
  spec: ImageEmbedSpec,
  x: number,
  y: number,
  view: EditorView,
  onRename: (oldName: string) => void,
) {
  // Presets set the width and drop any explicit height, matching the Mac; the
  // caption rides along untouched. "Original size" clears the size token.
  const resize = (width: number | undefined) =>
    rewriteEmbedMarker(view, raw, buildImageMarker({ name: spec.name, width, caption: spec.caption }))
  openContextMenu(x, y, [
    { label: 'Small (240)', run: () => resize(240) },
    { label: 'Medium (400)', run: () => resize(400) },
    { label: 'Large (640)', run: () => resize(640) },
    { label: 'Original size', run: () => resize(undefined) },
    // Caption and width need no dialog at all — both are just text in the
    // marker (`![[name|400|caption]]`), so the item drops the cursor straight
    // into the right slot and you type in the note itself, the existing value
    // pre-selected. Same order as the Mac's menu.
    { label: 'Custom width…', run: () => void beginInlineImageEdit(view, raw, spec, 'width') },
    { label: '', separator: true },
    { label: 'Caption…', run: () => void beginInlineImageEdit(view, raw, spec, 'caption') },
    { label: 'Rename…', run: () => onRename(spec.name) },
    { label: 'Open image', run: () => void invoke('open_attachment', { name: spec.name }) },
    {
      label: 'Reveal in Explorer',
      run: () => void invoke('reveal_attachment', { name: spec.name }),
    },
  ])
}
