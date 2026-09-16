//! The reference surfaces: Markup, Shortcuts, Emoji, About.
//!
//! On the Mac these are separate windows reached from the menu bar. Neither
//! Linux nor Windows has a menu bar here, so they share one overlay with tabs
//! — the same content, one way in, and nothing permanently occupying the
//! window.

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
  // Just "Envy". This read "Envy for Windows" on Linux too — the string came
  // over with the port and nobody caught it, so a Linux user asking what they
  // were running was told the wrong platform. One binary, one name.
  root.append(el('h3', '', 'Envy'))
  root.append(el('p', 'reference-desc', 'A flat-file, frictionless note-taking application.'))
  root.append(el('p', 'reference-desc', `Version ${version}`))
  root.append(el('p', 'reference-desc', 'Made by Skyler Schoos'))
  root.append(el('p', 'reference-desc', '© 2026'))
  return root
}

/// What changed in this build.
///
/// This tree's own history — Linux and Windows now share it — and not the
/// Mac's, which has a different past and whose release notes would describe
/// changes a user here never experienced. Newest first. Kept in step with
/// `release-notes/<version>.md`, which the GitHub release and the
/// website carry, in the same words.
const WHATS_NEW: Array<{ title: string; body: string }> = [
  {
    title: 'The window comes back where you left it',
    body: 'On Hyprland a hidden window is unmapped and a shown one is placed fresh, so summoning Envy after dragging it into a corner put it back in the middle of the screen. Every hide now writes the window’s place beside the config, and Hyprland is told where to map it before it shows, so it comes back in place without a slide. A cold launch lands there too.',
  },
  {
    title: 'Clicks land on the line you clicked',
    body: 'Every fenced code block above a click pushed the caret a line’s worth below the line you meant; in a note with seven fences it landed five lines low by the bottom. The fence’s spacing is now measured with it, and a click lands where it was aimed.',
  },
  {
    title: 'Up and Down move one line, into a code block rather than over it',
    body: 'From the line under a code block, Up jumped to the line above the block, seven lines in one press, and Down from above it leapt to the second line below. Each press now moves to the adjacent line: into a fence, which opens for editing, and over a table, which keeps its own editing, to the line just past it.',
  },
  {
    title: 'Packaged for aarch64',
    body: 'The pacman repository comes in two architectures: repo for x86_64 and repo-aarch64 for ARM (the README has the second Server line). The tarball and AppImage are built for both.',
  },
  {
    title: 'Windows',
    body: 'Hide on focus loss works: with the hide-on-focus-loss setting on, bringing another app to the front hides Envy. A click on the tray icon toggles the window and the eye follows it; the click used to hide and re-show in one go, and the eye stayed open after a hide. The tray eye is the same drawing as the Linux bar icon. Settings no longer shows the Hyprland-only “tiled” rows.',
  },
  {
    title: 'Under the hood',
    body: 'rustls, on the updater’s HTTPS path, is updated past RUSTSEC-2026-0285.',
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
