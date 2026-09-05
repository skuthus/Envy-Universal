//! The app's own right-click menu. A webview has no access to a native menu, so
//! this reimplements the parts people expect for free: dismissal on click-away,
//! Escape, scroll, and window blur, plus flipping when it would open past the
//! window edge. Shared by every window (main, pop-out, pinned) so each has the
//! same menu — the module's listeners register per entry point.
//!
//! It is also fully drivable from the keyboard, because a menu that only opens
//! under a pointer is a menu half the app can't reach: the first item takes
//! focus on open, arrows (and j/k, the Omarchy convention) move, Right/Return
//! opens a submenu, Left/Backspace closes it back to its parent, and Escape
//! peels exactly one level.

const contextMenuEl = document.getElementById('context-menu')!

export interface MenuItemSpec {
  label: string
  /// Omitted for an item that only opens a submenu, and for a separator.
  run?: () => void | Promise<void>
  destructive?: boolean
  /// Turns this item into a submenu. Built lazily, on hover, because the only
  /// one so far lists the Index's folders and walking the disk to fill a menu
  /// nobody opened is work for nothing.
  submenu?: () => MenuItemSpec[] | Promise<MenuItemSpec[]>
  /// A horizontal rule rather than an item. The label is ignored.
  separator?: boolean
  /// A swatch drawn before the label — the colour of the folder an item files
  /// into, so the menu reads the same way the list does.
  swatch?: string | null
  /// Shown greyed out and inert — for an action that exists but can't apply
  /// right now (a fourth pin with the sticky strip full).
  disabled?: boolean
}

export interface OpenMenuOptions {
  /// Opens straight into the submenu with this label, focused — for a shortcut
  /// that means "file this note" rather than "show me the menu".
  submenu?: string
}

/// The chain of panels currently open, outermost (the menu root) first. This is
/// what makes Escape peel one level rather than closing the lot: it pops.
let openPanels: HTMLElement[] = []
let focusReturn: HTMLElement | null = null

/// Each submenu panel's opener, so closing a level can put focus back on the
/// item that opened it.
const openerOf = new WeakMap<HTMLElement, HTMLElement>()

export function closeContextMenu() {
  const hadFocus = contextMenuEl.contains(document.activeElement)
  contextMenuEl.classList.add('hidden')
  contextMenuEl.replaceChildren()
  openPanels = []
  const back = focusReturn
  focusReturn = null
  // Only when the menu is what holds focus. Dismissing by clicking somewhere
  // else has already chosen a new home for the caret, and yanking it back to
  // where the menu was opened from would undo that click.
  if (hadFocus && back?.isConnected) back.focus({ preventScroll: true })
}

/// This level's own rows. A submenu's buttons live *inside* the parent button,
/// so only direct children belong to the level being walked.
function itemsIn(panel: HTMLElement): HTMLButtonElement[] {
  return [...panel.children].filter(
    (c): c is HTMLButtonElement => c instanceof HTMLButtonElement && !c.disabled,
  )
}

function focusItem(panel: HTMLElement, index: number) {
  const items = itemsIn(panel)
  if (items.length === 0) return
  // `preventScroll` throughout: a scroll anywhere closes the menu (see the
  // listener at the bottom), so focusing a row that needed scrolling into view
  // would shut the thing it was trying to reach.
  items[(index + items.length) % items.length].focus({ preventScroll: true })
}

function moveFocus(delta: number) {
  const panel = openPanels[openPanels.length - 1]
  if (!panel) return
  const items = itemsIn(panel)
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  focusItem(panel, at < 0 ? (delta > 0 ? 0 : -1) : at + delta)
}

/// The submenu panel hanging off `b`, filled on first use and pushed onto the
/// open chain. Shared by hover and the keyboard so the two can't drift apart.
async function openSubmenu(b: HTMLButtonElement, focusFirst: boolean) {
  const panel = b.querySelector<HTMLElement>(':scope > .context-submenu')
  if (!panel) return
  const fill = fillerOf.get(panel)
  if (fill) {
    fillerOf.delete(panel)
    await fill()
  }
  panel.classList.remove('hidden')
  // Flip to the left when there isn't room on the right.
  const r = panel.getBoundingClientRect()
  panel.classList.toggle('flip', r.right > window.innerWidth)
  if (openPanels[openPanels.length - 1] !== panel) openPanels.push(panel)
  openerOf.set(panel, b)
  if (focusFirst) focusItem(panel, 0)
}

/// Closes the innermost open submenu and puts focus back on the item that
/// opened it. One level, never two — Escape and Left both lean on this.
function closeSubmenu(): boolean {
  if (openPanels.length < 2) return false
  const panel = openPanels.pop()!
  panel.classList.add('hidden')
  const opener = openerOf.get(panel)
  if (opener?.isConnected) opener.focus({ preventScroll: true })
  return true
}

/// Lazy fillers, keyed by the panel they fill. A `WeakMap` rather than a
/// closure flag so both the hover path and the keyboard path see the same
/// "already built" answer.
const fillerOf = new WeakMap<HTMLElement, () => Promise<void>>()

/// Builds the rows for one menu level. Shared by the menu and its submenus, so
/// a submenu looks and behaves like the menu it hangs off.
function menuRows(items: MenuItemSpec[], onPick: () => void): HTMLElement[] {
  return items.map((item) => {
    if (item.separator) {
      const hr = document.createElement('div')
      hr.className = 'context-separator'
      return hr
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.className =
      'context-item' +
      (item.destructive ? ' destructive' : '') +
      (item.submenu ? ' has-submenu' : '')
    if (item.swatch !== undefined) {
      const dot = document.createElement('span')
      dot.className = 'context-swatch'
      // A folder with no colour still gets the slot, so labels line up.
      if (item.swatch) dot.style.background = item.swatch
      else dot.classList.add('empty')
      b.append(dot)
    }
    b.append(document.createTextNode(item.label))
    if (item.disabled) {
      b.disabled = true
      return b
    }

    if (item.submenu) {
      const panel = document.createElement('div')
      panel.className = 'context-submenu hidden'
      b.append(panel)
      fillerOf.set(panel, async () => {
        panel.replaceChildren(...menuRows(await item.submenu!(), onPick))
      })
      b.onmouseenter = () => void openSubmenu(b, false)
      b.onmouseleave = () => {
        // Not while the keyboard is standing in it: the pointer drifting off
        // the row would otherwise close the submenu out from under the item
        // that has focus, and drop focus on the floor with it.
        if (panel.contains(document.activeElement)) return
        panel.classList.add('hidden')
        // Only unwind the chain if this really is the innermost open level.
        if (openPanels[openPanels.length - 1] === panel) openPanels.pop()
      }
      // A parent that only opens a submenu isn't itself clickable. Flagged in
      // the DOM as well, because Return has to tell "open the submenu" from
      // "run this item, which happens to have one" and an `onclick` that only
      // swallows the event looks like an action from the outside.
      if (!item.run) {
        b.dataset.submenuOnly = ''
        b.onclick = (e) => e.stopPropagation()
      }
    }

    if (item.run) {
      b.onclick = () => {
        onPick()
        void item.run!()
      }
    }
    return b
  })
}

export function openContextMenu(
  x: number,
  y: number,
  items: MenuItemSpec[],
  options: OpenMenuOptions = {},
) {
  // Where focus goes when the menu closes: whatever held it when the menu
  // opened, which is the right answer for a right-click and for a shortcut
  // alike — the menu is a detour, not a destination.
  focusReturn = document.activeElement as HTMLElement | null
  contextMenuEl.replaceChildren(...menuRows(items, closeContextMenu))
  // Placed offscreen-but-measurable first: the size isn't known until the
  // items are in the DOM, and it's needed to decide whether to flip.
  contextMenuEl.classList.remove('hidden')
  contextMenuEl.style.left = '0px'
  contextMenuEl.style.top = '0px'
  const { width, height } = contextMenuEl.getBoundingClientRect()
  const left = x + width > window.innerWidth ? Math.max(0, x - width) : x
  const top = y + height > window.innerHeight ? Math.max(0, y - height) : y
  contextMenuEl.style.left = `${left}px`
  contextMenuEl.style.top = `${top}px`
  openPanels = [contextMenuEl]

  const wanted = options.submenu
    ? itemsIn(contextMenuEl).find((b) => b.textContent?.trim() === options.submenu)
    : undefined
  if (wanted) {
    // Focused before the submenu is built, not after: filling it can await a
    // walk of the Index's folders, and leaving focus nowhere in the meantime
    // would drop a keystroke that arrived during it.
    wanted.focus({ preventScroll: true })
    void openSubmenu(wanted, true)
  }
  // The first item, so the menu is usable from the keyboard the instant it
  // appears however it was opened — a right-click leaves the pointer in charge
  // and this costs it nothing.
  else focusItem(contextMenuEl, 0)
}

/// Whether the menu is showing. Callers use it to keep their own Escape from
/// firing while the menu owns the key.
export function contextMenuOpen(): boolean {
  return !contextMenuEl.classList.contains('hidden')
}

// `capture` so a click that lands on something interactive closes the menu
// before that thing handles it, rather than after.
window.addEventListener(
  'mousedown',
  (e) => {
    if (!contextMenuEl.contains(e.target as Node)) closeContextMenu()
  },
  true,
)
window.addEventListener('blur', closeContextMenu)
window.addEventListener('scroll', closeContextMenu, true)

// Capture, and ahead of every other Escape listener in the app: while the menu
// is up it owns the keyboard, so Escape closes *it* — one level — rather than
// also closing the settings panel or the reference sheet behind it.
window.addEventListener(
  'keydown',
  (e) => {
    if (!contextMenuOpen()) return
    const focused = document.activeElement as HTMLButtonElement | null
    const inMenu = focused instanceof HTMLButtonElement && contextMenuEl.contains(focused)
    const take = () => {
      e.preventDefault()
      e.stopPropagation()
    }

    switch (e.key) {
      case 'Escape':
        take()
        if (!closeSubmenu()) closeContextMenu()
        return
      case 'ArrowDown':
      case 'j':
        take()
        moveFocus(1)
        return
      case 'ArrowUp':
      case 'k':
        take()
        moveFocus(-1)
        return
      case 'Home':
        take()
        focusItem(openPanels[openPanels.length - 1] ?? contextMenuEl, 0)
        return
      case 'End':
        take()
        focusItem(openPanels[openPanels.length - 1] ?? contextMenuEl, -1)
        return
      case 'ArrowRight':
        if (!inMenu || !focused.classList.contains('has-submenu')) return
        take()
        void openSubmenu(focused, true)
        return
      case 'ArrowLeft':
      case 'Backspace':
        take()
        closeSubmenu()
        return
      case 'Enter':
      case ' ':
        if (!inMenu) return
        take()
        // Return on a parent row opens its submenu instead of activating it —
        // the row has no action of its own to run.
        if (focused.dataset.submenuOnly !== undefined) {
          void openSubmenu(focused, true)
        } else {
          focused.click()
        }
        return
      default:
        return
    }
  },
  true,
)
// Suppress the webview's own menu everywhere — this is an app, not a page.
window.addEventListener('contextmenu', (e) => e.preventDefault())
