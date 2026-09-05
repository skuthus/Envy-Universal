//! The emoji picker — an in-app modal for choosing one emoji.
//!
//! macOS can open the Character Viewer and read the choice back. Linux has no
//! system panel an app can invoke and read the same way (and the compose/IBus
//! pickers differ per desktop), so the choice is made in-app: the same
//! shortcode grid the Emoji reference tab shows, plus a field for pasting any
//! emoji the list does not carry. Built on demand rather than parked in
//! index.html, since it is only ever reached from a context menu.

import { buildEmojiGrid } from './emoji-grid'
import { returnFocusFromDialog } from './prompt-modal'

export interface EmojiPickerOptions {
  title: string
  /// The emoji already assigned, pre-filled into the paste field so the modal
  /// opens showing what it is about to replace.
  current?: string | null
}

/// One glyph. A paste can leave a variation selector behind, and an emoji is
/// one glyph however many code units it takes.
function firstGlyph(text: string): string | null {
  return [...text.trim()][0] ?? null
}

/// Resolves with the chosen emoji, or null if the modal was dismissed.
export function pickEmoji(opts: EmojiPickerOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'emoji-picker'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    const panel = document.createElement('div')
    panel.className = 'emoji-picker-panel'
    overlay.append(panel)

    // Settled once: a click that lands while the modal is already closing (a
    // glyph and the backdrop in the same gesture) must not resolve twice.
    let done = false
    const close = (value: string | null) => {
      if (done) return
      done = true
      overlay.remove()
      returnFocusFromDialog()
      resolve(value)
    }

    const title = document.createElement('div')
    title.className = 'emoji-picker-title'
    title.textContent = opts.title
    panel.append(title)

    const search = document.createElement('input')
    search.type = 'text'
    search.className = 'reference-search emoji-picker-search'
    search.placeholder = 'Filter shortcodes'
    search.autocomplete = 'off'
    search.spellcheck = false
    panel.append(search)

    const scroll = document.createElement('div')
    scroll.className = 'emoji-picker-scroll'
    // The grid brings its own keys (see emoji-grid): focusable so the arrows
    // have somewhere to land, and Tab from the search box reaches it before the
    // buttons. Escape is left to the overlay handler below.
    const { grid, draw, pickFirst } = buildEmojiGrid('Use', (emoji) => close(emoji), {
      keyboard: true,
    })
    scroll.append(grid)
    panel.append(scroll)

    const foot = document.createElement('div')
    foot.className = 'emoji-picker-foot'
    const pasteLabel = document.createElement('label')
    pasteLabel.className = 'emoji-picker-any'
    pasteLabel.textContent = 'or paste any emoji'
    const paste = document.createElement('input')
    paste.type = 'text'
    paste.className = 'emoji-picker-paste'
    paste.autocomplete = 'off'
    paste.spellcheck = false
    paste.value = opts.current ?? ''
    pasteLabel.append(paste)
    const buttons = document.createElement('div')
    buttons.className = 'emoji-picker-buttons'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'Cancel'
    cancel.onclick = () => close(null)
    const use = document.createElement('button')
    use.type = 'button'
    use.className = 'emoji-picker-use'
    use.textContent = 'Use'
    use.onclick = () => close(firstGlyph(paste.value))
    buttons.append(cancel, use)
    foot.append(pasteLabel, buttons)
    panel.append(foot)

    // --- Keyboard -----------------------------------------------------------
    search.oninput = () => draw(search.value)
    search.addEventListener('keydown', (e) => {
      // Enter takes the first match, so filtering to one shortcode and pressing
      // Enter is the whole interaction. Down steps into the grid instead.
      if (e.key === 'Enter') {
        e.preventDefault()
        pickFirst()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        grid.focus()
      }
    })
    paste.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      close(firstGlyph(paste.value))
    })
    // Escape cancels; capture phase so it beats the editor's own Escape while
    // the picker is the thing on screen, as the prompt does.
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close(null)
      }
    })
    // A click on the backdrop (outside the panel) cancels, like the other overlays.
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null)
    })

    document.body.append(overlay)
    search.focus()
  })
}
