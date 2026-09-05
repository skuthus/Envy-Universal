//! The `:shortcode:` grid, shared by the Emoji reference tab and the emoji
//! picker.
//!
//! One builder rather than one per surface, because the two are meant to be the
//! same list: a shortcode that browses in the reference must be pickable for a
//! domain, and a second copy of the layout would drift the first time either
//! changed. The only thing a caller varies is what clicking a cell does.

import { EMOJI_SHORTCODES } from './emoji'

const ENTRIES = Object.entries(EMOJI_SHORTCODES)

export interface EmojiGrid {
  /// The grid element, for the caller to place.
  grid: HTMLElement
  /// Redraws showing only shortcodes containing `filter`; '' shows all.
  draw: (filter: string) => void
  /// Picks the first cell on screen, or returns false when nothing matches —
  /// what Return in a filter box means on both surfaces.
  pickFirst: () => boolean
  /// Moves keyboard focus into the grid (a no-op unless `keyboard` is on).
  focus: () => void
}

export interface EmojiGridOptions {
  /// Turns the grid into one tab stop that the arrows (or j/k) move around
  /// inside, with Return choosing the highlighted cell.
  ///
  /// Escape is deliberately *not* handled here: what backing out of a grid
  /// means belongs to whatever contains it — a modal cancels, the reference
  /// sheet closes — and swallowing the key would take that away.
  keyboard?: boolean
}

/// The highlight for keyboard selection.
///
/// The picker's stylesheet scopes its own `.selected` rule to the picker's
/// scroller, so a grid used anywhere else would move an invisible selection.
/// Injected once, on demand, rather than adding a global rule for a state most
/// surfaces never enter.
let highlightStyled = false
function ensureHighlightStyle(doc: Document) {
  if (highlightStyled) return
  highlightStyled = true
  const style = doc.createElement('style')
  style.textContent =
    '.emoji-grid:focus{outline:none}' +
    '.emoji-cell.selected{background:color-mix(in srgb, var(--envy-link) 24%, transparent)}'
  doc.head.append(style)
}

/// `cellTitle` is the per-cell tooltip and `onPick` the click handler — the
/// reference tab copies the shortcode, the picker resolves with the emoji.
/// Starts drawn unfiltered, so a caller can append it straight away.
export function buildEmojiGrid(
  cellTitle: string,
  onPick: (emoji: string, code: string) => void,
  opts: EmojiGridOptions = {},
): EmojiGrid {
  const grid = document.createElement('div')
  grid.className = 'emoji-grid'
  const draw = (filter: string) => {
    const needle = filter.trim().toLowerCase()
    const matches = needle ? ENTRIES.filter(([code]) => code.includes(needle)) : ENTRIES
    if (matches.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'reference-desc'
      empty.textContent = `No shortcodes match “${filter}”.`
      grid.replaceChildren(empty)
      return
    }
    grid.replaceChildren(
      ...matches.map(([code, emoji]) => {
        const cell = document.createElement('div')
        cell.className = 'emoji-cell'
        // Kept on the element so keyboard selection can read the choice back
        // without picking the glyph out of the cell's rendered text.
        cell.dataset.emoji = emoji
        cell.dataset.code = code
        const glyph = document.createElement('span')
        glyph.className = 'emoji-glyph'
        glyph.textContent = emoji
        const label = document.createElement('code')
        label.textContent = `:${code}:`
        cell.append(glyph, label)
        cell.title = cellTitle
        cell.onclick = () => onPick(emoji, code)
        return cell
      }),
    )
  }
  draw('')

  const cells = () => [...grid.querySelectorAll<HTMLElement>('.emoji-cell')]
  const pick = (cell: HTMLElement | undefined): boolean => {
    if (!cell?.dataset.emoji) return false
    onPick(cell.dataset.emoji, cell.dataset.code ?? '')
    return true
  }
  const pickFirst = () => pick(cells()[0])
  const focus = () => grid.focus()

  if (opts.keyboard) {
    ensureHighlightStyle(grid.ownerDocument)
    // One tab stop for the whole grid rather than one per cell: Tab reaches the
    // emoji, and the arrows move within them.
    grid.tabIndex = 0
    const highlight = (step: number) => {
      const all = cells()
      if (all.length === 0) return
      const at = all.findIndex((c) => c.classList.contains('selected'))
      const to = Math.max(0, Math.min(all.length - 1, at < 0 ? 0 : at + step))
      all[at]?.classList.remove('selected')
      all[to].classList.add('selected')
      all[to].scrollIntoView({ block: 'nearest' })
    }
    grid.addEventListener('keydown', (e) => {
      const all = cells()
      // Cells wrap, so a row is however many share the first one's top edge.
      const cols = all.filter((c) => c.offsetTop === all[0]?.offsetTop).length || 1
      const step =
        e.key === 'ArrowRight' || e.key === 'l' ? 1
        : e.key === 'ArrowLeft' || e.key === 'h' ? -1
        : e.key === 'ArrowDown' || e.key === 'j' ? cols
        : e.key === 'ArrowUp' || e.key === 'k' ? -cols
        : 0
      if (step !== 0) {
        e.preventDefault()
        highlight(step)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        pick(all.find((c) => c.classList.contains('selected')) ?? all[0])
      }
    })
  }

  return { grid, draw, pickFirst, focus }
}
