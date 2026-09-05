//! Custom window controls for Windows: min / max / close, themed like the rest
//! of Envy's chrome, sitting in the existing search / title bars rather than
//! a second OS title strip.

import { getCurrentWindow } from '@tauri-apps/api/window'

export type CloseMode = 'hide' | 'close'

const IS_WINDOWS = /Windows/i.test(navigator.userAgent)

const ICONS = {
  minimize:
    '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5.5h6"/></svg>',
  maximize:
    '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="2" y="2" width="6" height="6"/></svg>',
  restore:
    '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 4h5v5H3z"/><path d="M2 6V2h4"/></svg>',
  close:
    '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>',
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
    minBtn.innerHTML = ICONS.minimize
    minBtn.onclick = () => void win.minimize().catch((err) => console.error(err))
  }
  if (maxBtn) {
    if (!canMaximize) {
      maxBtn.remove()
    } else {
      const paint = async () => {
        const on = await win.isMaximized().catch(() => false)
        maxBtn.innerHTML = on ? ICONS.restore : ICONS.maximize
        maxBtn.title = on ? 'Restore' : 'Maximize'
        maxBtn.setAttribute('aria-label', maxBtn.title)
      }
      maxBtn.onclick = () => void win.toggleMaximize().then(paint).catch((err) => console.error(err))
      void paint()
      void win.onResized(() => void paint())
    }
  }
  if (closeBtn) {
    closeBtn.innerHTML = ICONS.close
    closeBtn.title = closeMode === 'hide' ? 'Hide Envy' : 'Close'
    closeBtn.setAttribute('aria-label', closeBtn.title)
    closeBtn.onclick = () => {
      const action = closeMode === 'hide' ? win.hide() : win.close()
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
