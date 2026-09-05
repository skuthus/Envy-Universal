//! The shortcut table itself: ids, labels and default chords.
//!
//! Pure data with no imports, split from `shortcuts.ts` so that
//! `scripts/gen-skill-docs.mjs` (which writes the agent skill's reference
//! sheet) and the Rust validator's test can read it without pulling in the
//! Tauri API and config machinery `shortcuts.ts` needs at runtime.

export type ShortcutId =
  | 'jumpToSearch'
  | 'newFromTemplate'
  | 'extractToNote'
  | 'deleteNote'
  | 'restoreDeletedNote'
  | 'toggleLayout'
  | 'bold'
  | 'italic'
  | 'zoomIn'
  | 'zoomOut'
  | 'actualSize'
  | 'centerWindow'
  | 'togglePlainTextMode'
  | 'focusNextArea'
  | 'focusPreviousArea'
  | 'togglePin'
  | 'pinToTray'
  | 'toggleInterlinks'
  | 'openSettings'
  | 'clearSearch'
  | 'summonApp'
  | 'showPinnedNote'
  | 'unpinFromTray'
  | 'keepOnTop'
  | 'insertImage'
  | 'insertTable'
  | 'followLink'
  | 'peekLink'
  | 'toggleCheckbox'
  | 'popOut'
  | 'moveToFolder'
  | 'retireDue'
  | 'emojiForLink'
  | 'toggleHelp'
  | 'toggleSplit'
  | 'switchPane'
  | 'flipSplit'

export interface ShortcutSpec {
  id: ShortcutId
  label: string
  /// The default binding, in the same string form remaps are stored as.
  default: string
  /// Global shortcuts are registered with the OS and work from any app, so
  /// changing one has to go back to Rust rather than just updating a table.
  global?: boolean
  /// Handled inside CodeMirror rather than by the window handler, so changing
  /// one reconfigures the editor's keymap.
  editor?: boolean
}

export const SHORTCUT_SPECS: ShortcutSpec[] = [
  { id: 'summonApp', label: 'Show/Hide Envy (works from any app)', default: 'Ctrl+Alt+Enter', global: true },
  { id: 'showPinnedNote', label: 'Show/Hide Pinned Note (works from any app)', default: 'Ctrl+Alt+ArrowDown', global: true },
  { id: 'unpinFromTray', label: 'Unpin Note from Tray (works from any app)', default: 'Ctrl+Alt+Shift+P', global: true },
  // The Mac binds Keep on Top to ⌥⌘T, but the port already gave Ctrl+Alt+T to
  // "Pin to Tray", so this takes the free Shift variant by default (remappable).
  { id: 'keepOnTop', label: 'Keep Envy on Top (works from any app)', default: 'Ctrl+Alt+Shift+T', global: true },
  // Escape rather than the Mac's ⌘L: on a keyboard-first Linux desktop "back
  // to the box" is the same gesture as "back out", and Escape already peels
  // every overlay one layer at a time, so the search box is simply the last
  // layer. Remappable to Ctrl+L for anyone who wants the browser habit.
  { id: 'jumpToSearch', label: 'Jump to Search', default: 'Escape' },
  { id: 'clearSearch', label: 'Clear Search', default: 'Alt+Backspace' },
  { id: 'newFromTemplate', label: 'New Note from Template', default: 'Ctrl+Shift+N' },
  // The Mac's ⌥⌘N. It makes a note, so it sits beside the other "new"
  // shortcuts rather than the formatting ones.
  { id: 'extractToNote', label: 'Extract Selection to New Note', default: 'Ctrl+Alt+N', editor: true },
  // The Mac's ⇧⌘I can't map here: Ctrl+I is Italic and Ctrl+Shift+I is the
  // WebView2 devtools chord. Ctrl+Alt+I keeps the "I for image" mnemonic and
  // sits with the other Ctrl+Alt editor actions (Extract, pins). Remappable.
  { id: 'insertImage', label: 'Insert Image', default: 'Ctrl+Alt+I' },
  // Ctrl+Shift+T is free: Ctrl+Alt+T is "Pin to Tray" and Ctrl+Alt+Shift+T is
  // "Keep on Top", and nothing else in the list (or in the webview — there are
  // no tabs to reopen here) claims the plain Shift variant. Remappable.
  { id: 'insertTable', label: 'Insert Table', default: 'Ctrl+Shift+T' },
  { id: 'deleteNote', label: 'Delete Note', default: 'Ctrl+Backspace' },
  { id: 'restoreDeletedNote', label: 'Restore Deleted Note', default: 'Ctrl+Shift+Backspace' },
  { id: 'togglePin', label: 'Pin/Unpin Note', default: 'Ctrl+Alt+P' },
  { id: 'pinToTray', label: 'Pin Note to Tray', default: 'Ctrl+Alt+T' },
  { id: 'toggleLayout', label: 'Toggle Layout', default: 'Ctrl+Shift+L' },
  { id: 'toggleInterlinks', label: 'Toggle Interlinks', default: 'Ctrl+Shift+B' },
  { id: 'togglePlainTextMode', label: 'Toggle Plain-Text Mode', default: 'Ctrl+Shift+P' },
  { id: 'centerWindow', label: 'Center Window', default: 'Ctrl+Enter' },
  { id: 'openSettings', label: 'Settings', default: 'Ctrl+,' },
  { id: 'focusNextArea', label: 'Focus Next Area', default: 'Alt+ArrowDown' },
  { id: 'focusPreviousArea', label: 'Focus Previous Area', default: 'Alt+ArrowUp' },
  { id: 'bold', label: 'Bold', default: 'Ctrl+B', editor: true },
  { id: 'italic', label: 'Italic', default: 'Ctrl+I', editor: true },
  // --- Editor actions the mouse already had -----------------------------------
  // Each of these was reachable only by clicking (or hovering) something. A
  // keyboard-only session could not follow a link, tick a checkbox, retire a
  // due date or give a URL an emoji at all, so each gets a chord in the same
  // remappable table as everything else rather than a hardcoded key test.
  { id: 'followLink', label: 'Follow Link Under Cursor', default: 'Ctrl+Shift+Enter' },
  { id: 'peekLink', label: 'Peek at Link Under Cursor', default: 'Alt+Enter' },
  { id: 'toggleCheckbox', label: 'Toggle Checkbox', default: 'Ctrl+Shift+D' },
  { id: 'retireDue', label: 'Retire/Restore Due Date', default: 'Ctrl+Shift+U' },
  { id: 'emojiForLink', label: 'Emoji for Link', default: 'Ctrl+Shift+E' },
  { id: 'popOut', label: 'Pop Out Note', default: 'Ctrl+Shift+O' },
  { id: 'toggleSplit', label: 'Split Editor / Close Split', default: 'Ctrl+\\' },
  { id: 'switchPane', label: 'Switch Editor Pane', default: 'Alt+\\' },
  { id: 'flipSplit', label: 'Flip Split Direction', default: 'Ctrl+Alt+\\' },
  { id: 'moveToFolder', label: 'Move to Folder…', default: 'Ctrl+Shift+M' },
  { id: 'toggleHelp', label: 'Markup Help', default: 'Ctrl+/' },
  { id: 'zoomIn', label: 'Zoom In', default: 'Ctrl+=' },
  { id: 'zoomOut', label: 'Zoom Out', default: 'Ctrl+-' },
  { id: 'actualSize', label: 'Actual Size', default: 'Ctrl+0' },
]
