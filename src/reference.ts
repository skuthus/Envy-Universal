//! The reference surfaces: Markup, Shortcuts, Emoji, About.
//!
//! On the Mac these are separate windows reached from the menu bar. Windows
//! has no menu bar here, so they share one overlay with tabs — the same
//! content, one way in, and nothing permanently occupying the window.

import markupGroups from './markup-help.json'
import { buildEmojiGrid } from './emoji-grid'
import { resolvedShortcuts, type ShortcutId } from './shortcuts'
// The application icon itself, not a copy or a redrawing of it. About is where
// someone looks to confirm what they are running, so showing anything other
// than the real mark is the one place it actually matters.
import appIcon from '../src-tauri/icons/128x128@2x.png'

interface MarkupEntry {
  syntax: string
  description: string
}
interface MarkupGroup {
  title: string
  entries: MarkupEntry[]
}

/// The Mac's descriptions name Mac keys. Rewriting them here rather than
/// editing the extracted data keeps the port mechanical — re-extracting from
/// the Swift stays a one-command job.
function windowsKeys(text: string): string {
  return text
    .replace(/\bCmd\+/g, 'Ctrl+')
    .replace(/\bCommand-/g, 'Ctrl-')
    .replace(/\bOption-/g, 'Alt-')
    .replace(/\bOption\+/g, 'Alt+')
    .replace(/⌘/g, 'Ctrl+')
    .replace(/⌥/g, 'Alt+')
}

/// How the live bindings are grouped for the sheet.
///
/// The bindings themselves come from `resolvedShortcuts()`, so a remap or a new
/// action shows up here without anyone remembering to edit a second list — the
/// old hand-written table had already drifted from what the app answered. Only
/// the *grouping* is an editorial choice, and anything this table has not
/// placed still appears, under "Other", rather than silently going missing.
const SHORTCUT_GROUPS: Array<{ title: string; ids: ShortcutId[] }> = [
  {
    title: 'Anywhere',
    ids: ['summonApp', 'showPinnedNote', 'unpinFromTray', 'keepOnTop'],
  },
  {
    title: 'Navigation',
    ids: ['jumpToSearch', 'clearSearch', 'focusNextArea', 'focusPreviousArea', 'toggleHelp'],
  },
  {
    title: 'Notes',
    ids: [
      'newFromTemplate',
      'extractToNote',
      'deleteNote',
      'restoreDeletedNote',
      'togglePin',
      'pinToTray',
      'popOut',
      'moveToFolder',
    ],
  },
  {
    title: 'Editor',
    ids: [
      'bold',
      'italic',
      'insertImage',
      'insertTable',
      'toggleCheckbox',
      'followLink',
      'peekLink',
      'retireDue',
      'emojiForLink',
      'togglePlainTextMode',
      'zoomIn',
      'zoomOut',
      'actualSize',
    ],
  },
  {
    title: 'Window',
    ids: ['toggleLayout', 'toggleInterlinks', 'centerWindow', 'openSettings'],
  },
]

/// The conventions the whole app follows, stated once at the top of the sheet.
///
/// These are not bindings in the remappable table — they are what every list,
/// grid and panel answers to — so they are written here rather than derived.
const KEYBOARD_CONVENTIONS: Array<[string, string]> = [
  ['Arrows or j / k', 'Move within a list or a grid'],
  ['Return', 'Open or choose whatever is highlighted'],
  ['Escape', 'Back out one step'],
  ['Tab / Shift+Tab', 'Move between areas — a filter box, a grid, a toolbar'],
  ['Shift+F10', 'Open the menu for whatever is focused (the Menu key does too)'],
]

/// The few things that are gestures rather than bindings, so they have no entry
/// in the shortcut table and cannot be derived from it.
const MOUSE_GESTURES: Array<[string, string]> = [
  ['Ctrl-click a [[link]]', 'Open it, creating it if needed'],
  ['Alt-click a [[link]]', 'Preview it without leaving (drag the preview by its title)'],
  ['Alt+Shift-click a [[link]]', 'Open it in its own window'],
  ['Click a due date', 'Retire it, or bring it back'],
]

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function renderMarkup(): HTMLElement {
  const root = el('div', 'reference-body')
  for (const group of markupGroups as MarkupGroup[]) {
    root.append(el('h4', 'reference-group', group.title))
    const table = el('div', 'reference-table')
    for (const entry of group.entries) {
      table.append(el('code', 'reference-syntax', entry.syntax))
      table.append(el('div', 'reference-desc', windowsKeys(entry.description)))
    }
    root.append(table)
  }
  return root
}

function renderRows(root: HTMLElement, title: string, rows: Array<[string, string]>) {
  if (rows.length === 0) return
  root.append(el('h4', 'reference-group', title))
  const table = el('div', 'reference-table')
  for (const [keys, what] of rows) {
    table.append(el('code', 'reference-syntax', keys))
    table.append(el('div', 'reference-desc', what))
  }
  root.append(table)
}

function renderShortcuts(): HTMLElement {
  const root = el('div', 'reference-body')
  renderRows(root, 'Keyboard', KEYBOARD_CONVENTIONS)

  const live = resolvedShortcuts()
  const placed = new Set<string>()
  for (const group of SHORTCUT_GROUPS) {
    const rows: Array<[string, string]> = []
    // Walked in the group's order, not the table's, so the sheet reads the way
    // it was written rather than the way the bindings happen to be declared.
    for (const id of group.ids) {
      const found = live.find((s) => s.id === id)
      if (!found?.chord) continue
      placed.add(found.id)
      rows.push([found.chord, found.label])
    }
    renderRows(root, group.title, rows)
  }
  renderRows(
    root,
    'Other',
    live.filter((s) => s.chord && !placed.has(s.id)).map((s): [string, string] => [s.chord, s.label]),
  )
  renderRows(root, 'With the mouse', MOUSE_GESTURES)
  return root
}

function renderEmoji(): HTMLElement {
  const root = el('div', 'reference-body')
  root.append(
    el(
      'p',
      'reference-desc',
      'Type a shortcode and finish it with the closing colon — it is replaced with the emoji immediately.',
    ),
  )
  const search = document.createElement('input')
  search.type = 'text'
  search.className = 'reference-search'
  search.placeholder = 'Filter shortcodes'
  root.append(search)

  // Clicking copies, since the point of browsing is to then use one — and so
  // does Return, with the grid keyboard-navigable for the same reason.
  const { grid, draw, pickFirst, focus } = buildEmojiGrid(
    'Copy',
    (_emoji, code) => {
      void navigator.clipboard?.writeText(`:${code}:`)
    },
    { keyboard: true },
  )
  search.oninput = () => draw(search.value)
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      pickFirst()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focus()
    }
  })
  root.append(grid)
  return root
}

function renderAbout(version: string): HTMLElement {
  const root = el('div', 'reference-body about')
  const mark = document.createElement('img')
  mark.className = 'about-mark'
  mark.src = appIcon
  mark.alt = 'Envy'
  mark.width = 88
  mark.height = 88
  root.append(mark)
  root.append(el('h3', '', 'Envy for Windows'))
  root.append(el('p', 'reference-desc', 'A flat-file, frictionless note-taking application.'))
  root.append(el('p', 'reference-desc', `Version ${version}`))
  root.append(el('p', 'reference-desc', 'Made by Skyler Schoos'))
  root.append(el('p', 'reference-desc', '© 2026'))
  return root
}

/// What changed in this build.
///
/// The Linux port's own history, not the Mac's or Windows' — the ports have
/// different pasts, and release notes for changes a user never experienced
/// are noise. Kept in step with `linux/release-notes/<version>.md`, which
/// the GitHub release and the website carry.
const WHATS_NEW: Array<{ title: string; body: string }> = [
  {
    title: 'Split the editor',
    body: 'Ctrl+\\ splits the editor into two panes and closes the split again. Alt+\\ hops between them; Ctrl+Alt+\\ flips them between side by side and stacked, and the choice is remembered. Right-click a note in the list → Send to Split Pane opens it beside the one you are in. The same note open in both panes mirrors every edit.',
  },
  {
    title: 'A divider you can drag',
    body: 'The line between the panes drags. Double-click it for an even split, or focus it and use the arrow keys along it. Each direction keeps its own share.',
  },
  {
    title: 'A solid eye in the bar',
    body: 'The bar eye is now solid in the bar’s text colour with the iris a see-through hole, drawn at the size of the shell’s own icons.',
  },
  {
    title: 'The pinned panel stays put',
    body: 'The pinned-note panel no longer vanishes while the pointer travels to it from the bar, and it reopens where you last put it.',
  },
  {
    title: 'Return creates unless the title exists',
    body: 'Return in the search box opens the note titled exactly what you typed, and otherwise creates one — even when other notes match the words, the Mac’s rule. A “Press ⏎ to create …” line under the list says which it is about to do. Arrow down to open a partial match instead.',
  },
  {
    title: 'Escape jumps to search',
    body: 'From anywhere, Escape closes whatever is open one layer at a time and then lands in the search box. Ctrl+L is still there as a remap in Settings → Shortcuts.',
  },
  {
    title: 'Check for Updates means it',
    body: 'Settings → Updates → Check Now, and the bar icon’s menu, ask GitHub for the newest release. If it is newer, a dialog offers to open a terminal with the update command. Envy never checks on its own.',
  },
  {
    title: 'Fonts you can actually pick',
    body: 'Font family is a dropdown of every installed family, monospace first. A new OpenType features setting takes tags like ss01 for any font, and Cascadia’s cursive italics switch on by themselves.',
  },
  {
    title: 'Kindles that don’t mount',
    body: 'Kindles that connect over MTP — every recent Paperwhite — are detected and read directly. No more copying My Clippings.txt by hand.',
  },
  {
    title: 'Fixes',
    body: 'A task’s checkbox sits one space from its text and the strike covers the words alone. A wrapped quote keeps its rule down every row. A dropped image lands at the caret on a scaled display. Renaming an image selects the name, not the extension. The date column fits the dates on screen. Insets and paddings scale with the zoom, up to 160%. American spelling throughout.',
  },
]

export type ReferenceTab = 'markup' | 'shortcuts' | 'emoji' | 'whatsnew' | 'about'

export function renderReference(tab: ReferenceTab, version: string): HTMLElement {
  switch (tab) {
    case 'shortcuts':
      return renderShortcuts()
    case 'emoji':
      return renderEmoji()
    case 'whatsnew': {
      const root = el('div', 'reference-body')
      for (const item of WHATS_NEW) {
        root.append(el('h4', 'reference-group', item.title))
        root.append(el('p', 'reference-desc', item.body))
      }
      return root
    }
    case 'about':
      return renderAbout(version)
    default:
      return renderMarkup()
  }
}

/// Opens the reference sheet if it is closed, closes it if it is open.
///
/// The overlay's own open and close live with the window chrome (they render
/// the tabs and need the app version, neither of which this module has), so
/// this drives the controls they are already bound to rather than growing a
/// second idea of what "open" means that could disagree with the first. The
/// direct class change is the fallback for a surface that never wired them.
export function toggleReference(): void {
  const sheet = document.getElementById('reference')
  if (!sheet) return
  if (sheet.classList.contains('hidden')) {
    // Markup first, since that is what the binding is called; the Shortcuts
    // tab (and every other) is one Tab and an arrow away once the sheet is up.
    const open =
      document.getElementById('open-markup') ?? document.getElementById('open-shortcuts')
    if (open) open.click()
    else sheet.classList.remove('hidden')
    return
  }
  document.getElementById('reference-close')?.click()
  sheet.classList.add('hidden')
}
