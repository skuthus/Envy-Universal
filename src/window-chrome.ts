//! Custom window controls for Windows: min / max / close, themed like the rest
//! of Envy's chrome, sitting in the existing search / title bars rather than
//! a second OS title strip.

import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

export type CloseMode = 'hide' | 'close'

export const IS_WINDOWS = /Windows/i.test(navigator.userAgent)

/// What the file manager is called, for the menu items and buttons that open
/// one. The Mac says "Show in Finder"; the Linux build says "Show in Folder"
/// because the file manager is whatever the desktop set; Windows has one name
/// for it and users look for that name. One constant so the five places that
/// offer this — two list menus, the image menu, the trash panel and Settings —
/// cannot drift apart.
export const REVEAL_LABEL = IS_WINDOWS ? 'Reveal in Explorer' : 'Show in Folder'

/// The title-bar glyphs, as path data on a 10×10 viewBox rather than markup.
/// They were SVG strings assigned through `innerHTML`, which check.sh's
/// invariant stops on sight — rightly, even though these four are static
/// literals with nothing interpolated into them: the check is a tripwire, and
/// a file excused from it is excused forever, including for whatever is added
/// to it next. Built as real nodes instead, so nothing in this file turns a
/// string into markup. The maximize square is a closed path, not a `<rect>`,
/// so one builder covers all four; `stroke-linejoin: round` in the stylesheet
/// renders it identically either way.
const ICONS = {
  minimize: ['M2 5.5h6'],
  maximize: ['M2 2h6v6H2z'],
  restore: ['M3 4h5v5H3z', 'M2 6V2h4'],
  close: ['M2.5 2.5l5 5M7.5 2.5l-5 5'],
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 10 10')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

export function installWindowChrome(opts?: {
  close?: CloseMode
  maximize?: boolean
  dragEl?: HTMLElement | null
}): void {
  if (!IS_WINDOWS) return
  document.documentElement.classList.add('windows')

  const root = document.querySelector<HTMLElement>('.window-controls')
  if (!root) return

  const win = getCurrentWindow()
  const closeMode = opts?.close ?? 'hide'
  const canMaximize = opts?.maximize !== false

  const minBtn = root.querySelector<HTMLButtonElement>('[data-win="minimize"]')
  const maxBtn = root.querySelector<HTMLButtonElement>('[data-win="maximize"]')
  const closeBtn = root.querySelector<HTMLButtonElement>('[data-win="close"]')

  if (minBtn) {
    minBtn.replaceChildren(icon('minimize'))
    minBtn.onclick = () => void win.minimize().catch((err) => console.error(err))
  }
  if (maxBtn) {
    if (!canMaximize) {
      maxBtn.remove()
    } else {
      const paint = async () => {
        const on = await win.isMaximized().catch(() => false)
        maxBtn.replaceChildren(icon(on ? 'restore' : 'maximize'))
        maxBtn.title = on ? 'Restore' : 'Maximize'
        maxBtn.setAttribute('aria-label', maxBtn.title)
      }
      maxBtn.onclick = () => void win.toggleMaximize().then(paint).catch((err) => console.error(err))
      void paint()
      void win.onResized(() => void paint())
    }
  }
  if (closeBtn) {
    closeBtn.replaceChildren(icon('close'))
    closeBtn.title = closeMode === 'hide' ? 'Hide Envy' : 'Close'
    closeBtn.setAttribute('aria-label', closeBtn.title)
    closeBtn.onclick = () => {
      // Hiding goes through Rust so the window's place is remembered first.
      const action = closeMode === 'hide' ? invoke('hide_main') : win.close()
      void action.catch((err) => console.error(err))
    }
  }

  const drag = opts?.dragEl
  if (drag && canMaximize) {
    drag.addEventListener('dblclick', (e) => {
      const t = e.target
      if (t instanceof HTMLElement && t.closest('input, button, textarea, select, a, [contenteditable]')) {
        return
      }
      void win.toggleMaximize().catch((err) => console.error(err))
    })
  }
}
