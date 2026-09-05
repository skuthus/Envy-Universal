import { EditorView, keymap, drawSelection, rectangularSelection, type ViewUpdate } from '@codemirror/view'
import { Annotation, EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openFolderPicker } from '@tauri-apps/plugin-dialog'
import { getVersion } from '@tauri-apps/api/app'
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { openContextMenu, contextMenuOpen, type MenuItemSpec, type OpenMenuOptions } from './context-menu'
import { textPrompt, confirmModal, alertModal, setPromptFocusReturn, isDialogOpen } from './prompt-modal'
import { openImageMenu, renameAttachmentFlow, insertImageReference } from './image-menu'
import { openImagePicker } from './image-picker'
import { pickEmoji } from './emoji-picker'
import {
  embedHost,
  envyStyler,
  existingTitles,
  firstSearchMatch,
  isImageTarget,
  isGhostLinkForTest,
  plainTextField,
  refreshEmbeds,
  invalidateAttachments,
  searchQueryField,
  setPlainText,
  setSearchQuery,
  changedRange,
  flashField,
  setFlash,
  restyle,
  toggleTaskAtCursor,
  urlDomain,
} from './styler'
import {
  autoPairing,
  completionTransforms,
  emphasisKeymap,
  pairingEdit,
  dueTokenAt,
  toggleDueToken,
} from './input'
import { editorCompletion, completionSources, ghostRemainderForTest } from './completion'
import { listEditing, listContinuation, isListLine, renumberEdits } from './lists'
import {
  delimitedToTable,
  insertTable,
  padTableSource,
  serializeTableRow,
  tableEditing,
} from './tables'
import { installSmoothScroll, scrollTarget, smoothScrollTo } from './smooth-scroll'
import { installWindowChrome } from './window-chrome'
import {
  applyEditorZoom,
  applyStoredAppearance,
  currentOmarchy,
  currentTheme,
  initAppearance,
  themeNotices,
} from './theme'
import * as config from './config'
import {
  RESERVED_THEME_NAMES,
  THEME_NAME_PATTERN,
  type ThemeFileDto,
  cssToHex,
  legibilityNotices,
  overlayTokens,
  readThemeText,
  renderThemeFile,
  themeFile,
  themeFiles,
  themesDir,
  tokensFromTheme,
  writeThemeFile,
} from './themes'
import { createMiniNoteEditor, type MiniNoteEditor } from './mininote'
import { renderReference, toggleReference, type ReferenceTab } from './reference'
import { initKindleImport, syncKindleSettings } from './kindle'
import {
  SHORTCUT_SPECS,
  bindingFor,
  conflicts,
  displayBinding,
  eventToBinding,
  globalBindings,
  isModifierOnly,
  matches as matchesShortcut,
  resetAllBindings,
  setBinding,
  type ShortcutId,
} from './shortcuts'

// Nothing in this app should be able to fail silently again.
//
// Three separate features shipped broken for the same reason: a Tauri call was
// denied by a missing capability, the denial arrived as a *rejected promise*
// rather than a thrown error, and the call site discarded it with `void` or an
// un-awaited async handler. A rejected promise nobody is listening to produces
// no console output, no dialog, and no clue — the control simply does nothing,
// which is indistinguishable from a control that was never wired up.
//
// This makes the whole class audible at the one place every one of them
// surfaces, rather than relying on each call site to remember a `.catch()`.
window.addEventListener('unhandledrejection', (e) => {
  console.error('unhandled rejection — something failed silently:', e.reason)
})

const IS_WINDOWS = navigator.userAgent.includes('Windows')
if (IS_WINDOWS) document.documentElement.classList.add('windows')

interface NoteDto {
  id: string
  title: string
  preview: string
  content: string | null
  modifiedMs: number
  due: string | null
  dueCount: number
  tags: string[]
  isInbox: boolean
  aiProvenance: 'none' | 'created' | 'edited'
  hasUncheckedTask: boolean
  /// The folder this note sits in, relative to the Index root, or null at the
  /// root. What the list's folder dot is coloured by.
  subfolder: string | null
}

const searchInput = document.getElementById('search') as HTMLInputElement
// A dialog closing hands focus back to the search box in this window — the same
// place every other overlay returns to, so the keyboard never ends up stranded.
setPromptFocusReturn(() => searchInput.focus())
const panesEl = document.getElementById('panes')!
const dividerEl = document.getElementById('divider')!
/// The split sizes the *pane* (header + scrolling list), not the list itself —
/// the list is `flex: 1` inside it. Sizing the inner element instead leaves
/// the pane fixed at its CSS height, which reads as a divider that won't drag.
const listPaneEl = document.getElementById('list-pane')!
const listEl = document.getElementById('list')!
// The Mac's "Press ⏎ to create" hint: the promise of what Return does while
// nothing carries the typed title, so a partial match never surprises anyone.
const createHintEl = document.getElementById('create-hint')!
const listHeaderEl = document.getElementById('list-header')!
/// The sticky pinned rows, between the header and the scrolling list.
const pinnedStripEl = document.getElementById('pinned-strip')!
const titleEl = document.getElementById('note-title') as HTMLInputElement
/// The rename field and its chips. One of these, living in whichever pane is
/// active; the other pane shows its title in a plain strip of the same shape.
const titleBarEl = document.getElementById('note-title-bar')!
const dueEl = document.getElementById('note-due')!
const tagsEl = document.getElementById('note-tags')!
const folderChipEl = document.getElementById('note-folder')!
const editorElContainer = document.getElementById('editor')!
const emptyEl = document.getElementById('empty-state')!

/// The list, in display order — and, past one page, *sparse*.
///
/// `results.length` is always the full number of matches, so every index in
/// the app still means the same thing it did when the whole list was here.
/// What changed is that a slot may be `undefined`: the backend now returns one
/// page of notes plus a total rather than a `NoteDto` for every match, because
/// on a 30,000-note vault every match was 19.3 MB of JSON per debounced
/// keystroke — parsed, allocated and then almost entirely ignored by a list
/// that only ever paints about thirty rows. Missing pages are fetched by
/// `loadRange` as the window (or the highlight) reaches them.
let results: (NoteDto | undefined)[] = []
/// `results` is held in *display* order, so a render never has to sort. The
/// order depends only on the list itself, the sort field/direction and the pin
/// set — none of which a render changes — yet `renderList` re-sorted and
/// re-pinned on every call, and one arrow key calls it twice. The few places
/// that can actually invalidate the order mark it dirty instead, which puts a
/// render back at O(visible rows) on a vault of any size.
///
/// Only meaningful while the whole result set is in memory; past that the
/// backend owns the order — see `reorderResults`.
let orderDirty = true
function markOrderDirty() {
  orderDirty = true
}
let highlighted = 0
/// One editor and the note it holds. The window shows one or two of these;
/// everything that used to be "the open note" — its id, the DTO the title bar
/// reads, the external document standing in for a note, the text as last
/// written to disk, the pending save — is a field of the pane, and the
/// window-level code reads them off `activePane`.
interface Pane {
  el: HTMLElement
  captionEl: HTMLElement
  editorEl: HTMLElement
  view: EditorView
  noteId: string | null
  /// The open note as last read or saved.
  ///
  /// The title bar's tags, folder chip and due pill used to look it up in
  /// `results`. That worked while the whole list was in memory; past one page
  /// the open note's row may not be loaded at all, and a lookup that missed
  /// would silently blank the chips (or, in `commitRename`, compare the typed
  /// title against an empty string). Holding the note it already fetched costs
  /// one reference and removes the list from the question entirely.
  dto: NoteDto | null
  external: ExternalDoc | null
  /// The text as last loaded from or written to disk.
  ///
  /// Saving is guarded against this rather than fired unconditionally. Without
  /// the comparison, merely *opening* a note flushes the previous one — an
  /// identical rewrite that still stamps a new modified time, so clicking
  /// through the list reorders it under a date sort. The Mac guards the same
  /// way, in `scheduleSave`: `newValue != note.content`.
  savedContent: string
  /// Saves are debounced rather than fired per keystroke — the store writes
  /// the whole file atomically, and doing that on every character would be
  /// pointless disk churn. 400ms matches the reload debounce in the Mac's
  /// NoteStore.
  saveTimer: number | undefined
}

/// In screen order: left to right side by side, top to bottom stacked.
const panes: Pane[] = []
/// The pane the list opens into, the title bar and footer describe, and every
/// shortcut acts on. Always one of `panes`.
let activePane: Pane
/// `activePane.view`, kept as its own binding because that is what nearly
/// every editor call in this file reaches for.
let view: EditorView

/// Marks a transaction that copies a twin pane's edit, so the receiving pane
/// neither saves it (the pane it was typed in does) nor mirrors it back.
const mirrored = Annotation.define<boolean>()

const editable = new Compartment()
/// The emphasis bindings live in a compartment because they're remappable, and
/// a keymap facet can't be changed after the editor is built.
const emphasisKeys = new Compartment()
/// The area-switch chords, likewise — see `areaKeymap`.
const areaKeys = new Compartment()

/// A binding string ("Alt+ArrowUp") in CodeMirror's key notation.
function toEditorKey(binding: string): string {
  return binding.split('+').join('-')
}

/// Swallows the focus-cycling chords inside the editor without acting on them.
///
/// The default keymap claims Alt+Up/Down for moveLineUp/moveLineDown, so with
/// nothing here the editor would move a line *and* the window handler would
/// move focus — one keystroke doing two unrelated things. These entries take
/// the chord away from the editor and leave the actual focus change to the one
/// window-level handler, so there is still exactly one place that decides what
/// the shortcut does and remapping moves both halves at once.
function areaKeymap() {
  return keymap.of(
    (['focusNextArea', 'focusPreviousArea'] as const)
      .map((id) => bindingFor(id))
      .filter((b) => b !== '')
      .map((b) => ({ key: toEditorKey(b), run: () => true, preventDefault: true })),
  )
}

function applyEditorKeymap() {
  for (const p of panes) p.view.dispatch({
    effects: [
      emphasisKeys.reconfigure(
        keymap.of(emphasisKeymap(bindingFor('bold'), bindingFor('italic'))),
      ),
      areaKeys.reconfigure(areaKeymap()),
    ],
  })
}

// The existing note titles, lowercased, for the editor's ghost-link check — an
// O(1) membership test rebuilt only when the titles change. Declared *above*
// the editor because the styler reads it (through the existingTitles facet)
// while building its first decorations during construction below; a `let` down
// with the other known* lists would still be in its temporal dead zone then,
// and the ReferenceError would take the whole styler plugin down with it.
let knownTitlesLower = new Set<string>()

/// Builds a pane's editor. Everything an editor needs is here; the pane it
/// belongs to is closed over so the handlers act on it rather than on
/// whichever pane happens to be active.
function createPaneEditor(pane: Pane): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [
        history(),
        drawSelection(),
        rectangularSelection(),
        // Before the default keymap, so emphasis wins over the default binding
        // for those chords. In a compartment because the bindings are
        // remappable, and a facet can't be changed after the fact.
        emphasisKeys.of(keymap.of(emphasisKeymap(bindingFor('bold'), bindingFor('italic')))),
        // Ahead of the default keymap, which would otherwise claim Alt+Up/Down.
        areaKeys.of(areaKeymap()),
        // Enter/Tab/Shift-Tab continue and nest lists (and ordered lists
        // renumber) — Prec.high inside, so this beats the default newline/indent.
        listEditing,
        tableEditing,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        // Ghost-text completion for [[links]] and #tags, drawing from the same
        // title/tag lists the search box completes from. Read through a closure
        // so it tracks edits without the editor being reconfigured.
        editorCompletion,
        completionSources.of(() => ({ titles: knownTitles, tags: knownTags })),
        // The set the styler checks a [[link]]'s target against to decide whether
        // it's a ghost. A getter, so it reads the live set without reconfiguring.
        existingTitles.of(() => knownTitlesLower),
        completionTransforms,
        autoPairing,
        searchQueryField,
        plainTextField,
        flashField,
        embedHost.of({
          // Resolved by title on every mount rather than handed a pre-fetched
          // note, so "the source was renamed" and "the source doesn't exist
          // yet" both fall out of the ordinary lookup instead of each needing
          // their own handling.
          resolve: async (title) => {
            const note = await invoke<NoteDto | null>('resolve_title', { title })
            return note && note.content !== null
              ? { id: note.id, title: note.title, content: note.content }
              : null
          },
          save: async (id, content) => {
            await invoke('save_note', { id, content })
            await runSearch()
          },
          currentNoteId: () => pane.noteId,
          // The command returns raw bytes as an IPC Response, which arrives here as
          // an ArrayBuffer; the widget wraps it in an object URL.
          readAttachment: (name) =>
            invoke<ArrayBuffer>('read_attachment', { name }).catch(() => null),
          openAttachment: (name) => void invoke('open_attachment', { name }),
          onImageContextMenu: (raw, spec, x, y) =>
            openImageMenu(raw, spec, x, y, pane.view, (name) => void renameAttachment(name)),
        }),
        envyStyler,
        EditorView.domEventHandlers({
          mousedown: (event, v) => {
            // Ctrl+click follows a link, the Windows spelling of ⌘-click. Envy
            // requires a modifier by default (`requireModifierForLinkClick`) so
            // an ordinary click can still place the cursor inside a link to
            // edit it — the two gestures would otherwise fight.
            // Turning the setting off trades that away for a plain click.
            if (event.button !== 0) return false
            // A click inside a rendered embed belongs to the widget — the image's
            // own open/menu handlers, or a note embed's inner editor — never to a
            // marker follow. Without this, clicking the empty space beside an
            // image snaps to the marker line and "opens" the file, which for a
            // missing one throws an OS "cannot find" error.
            if ((event.target as HTMLElement | null)?.closest('.envy-image-embed, .envy-embed, .envy-md-table-wrap, .envy-md-pre-wrap')) {
              return false
            }
            const pos = v.posAtCoords({ x: event.clientX, y: event.clientY })
            if (pos === null) return false

            // Alt-click previews a link instead of following it; Alt+Shift-click
            // skips the peek and opens the note in its own window.
            if (event.altKey && settings.linkPreview !== 'off') {
              const target = wikiLinkTargetAt(v, pos)
              if (!target) return false
              event.preventDefault()
              if (event.shiftKey) void popOutLink(target, event.clientX, event.clientY)
              else void showLinkPreview(target, event.clientX, event.clientY)
              return true
            }

            // Clicking a due date retires it, or brings it back. Checked before
            // links because the two never overlap, and before the modifier gate
            // because retiring a date is a plain click.
            //
            // Guarded on the pointer's real x/y, like the wiki-link marker below:
            // a date that ends a line has empty space to its right that
            // posAtCoords snaps to the token's end, so without this a click well
            // past the date would cross it off. Only a click actually over the
            // token toggles it.
            const dueToken = event.ctrlKey || event.altKey ? null : dueTokenAt(v.state.doc.toString(), pos)
            if (dueToken) {
              const a = v.coordsAtPos(dueToken.from, 1)
              const b = v.coordsAtPos(dueToken.to, -1)
              const onToken =
                a &&
                b &&
                event.clientX >= a.left - 2 &&
                event.clientX <= b.right + 2 &&
                event.clientY >= Math.min(a.top, b.top) - 2 &&
                event.clientY <= Math.max(a.bottom, b.bottom) + 2
              if (onToken && toggleDueToken(v, pos)) {
                event.preventDefault()
                return true
              }
            }

            // In-note jumps happen on a plain click, no modifier — there's
            // nothing else a footnote reference or a heading anchor could mean.
            if (!event.altKey) {
              const footnote = footnoteRefAt(v, pos)
              if (footnote) {
                const range = footnoteDefinitionRange(v.state.doc.toString(), footnote)
                if (range) {
                  event.preventDefault()
                  jumpToRange(range)
                  return true
                }
              }
              const mdLink = markdownLinkAt(v, pos)
              if (mdLink?.url.startsWith('#')) {
                const range = headingRangeForSlug(v.state.doc.toString(), mdLink.url.slice(1))
                if (range) {
                  event.preventDefault()
                  jumpToRange(range)
                  return true
                }
              }
              // An outbound `[text](http…)` link opens externally, but honours the
              // modifier gate the same as a wiki-link so a plain click can still
              // land the caret to edit the URL.
              if (mdLink && /^https?:\/\//i.test(mdLink.url)) {
                if (settings.requireModifierForLinkClick && !event.ctrlKey) return false
                event.preventDefault()
                void invoke('open_external_url', { url: mdLink.url })
                return true
              }
            }

            if (settings.requireModifierForLinkClick && !event.ctrlKey) return false
            const target = wikiLinkTargetAt(v, pos)
            if (!target) return false
            const range = wikiLinkRangeAt(v, pos)
            // A collapsed `![[image]]` or `[[link]]` can fill its whole line, so a
            // click in the empty space past it snaps to the line end — which
            // posAtCoords reports as inside the marker. Guard on the pointer's real
            // x: past the rendered end of the marker, place the caret rather than
            // follow (and, for a missing image, throw an OS error).
            if (range) {
              const edge = v.coordsAtPos(range.to, -1)
              if (edge && event.clientX > edge.right + 2) return false
            }
            // With plain click-to-follow on, a click inside the link the caret
            // already sits in is an edit, not a navigation — otherwise a note
            // that is only a link (or repositioning within any link you've
            // entered) could never be clicked into. Ctrl still follows,
            // unconditionally. Mirrors the Mac's caretIsInsideWikiLink carve-out.
            if (!event.ctrlKey) {
              const caret = v.state.selection.main.from
              if (range && caret >= range.from && caret <= range.to) return false
            }
            event.preventDefault()
            // An `![[image.png]]` target is an attachment, not a note — open the
            // file rather than resolving (and ghost-creating) a note by that name.
            if (isImageTarget(target)) {
              void invoke('open_attachment', { name: target })
              return true
            }
            void followLink(target)
            return true
          },
          // Pasting an image writes it to Attachments/ and drops in an `![[…]]`.
          // Only claimed when the clipboard carries an image and no text — a
          // copied text run pastes as text, matching the Mac's no-string guard.
          paste: (event, v) => {
            if (!pane.noteId && !pane.external) return false
            const dt = event.clipboardData
            if (!dt || dt.getData('text/plain')) return false
            const item = [...dt.items].find(
              (it) => it.kind === 'file' && it.type.startsWith('image/'),
            )
            const file = item?.getAsFile()
            if (!file) return false
            event.preventDefault()
            void importPastedImage(file, v)
            return true
          },
        }),
        editable.of(EditorView.editable.of(false)),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || !(pane.noteId || pane.external)) return
          // A twin's keystrokes arriving here: the twin saves them, and copying
          // them back would bounce between the two forever.
          if (u.transactions.some((tr) => tr.annotation(mirrored))) return
          mirrorToTwins(pane, u)
          scheduleSave(pane)
          // Counts track the buffer, not the saved file — they should move as
          // you type, not lag 400ms behind on the save debounce.
          if (pane === activePane) renderStats()
        }),
      ],
    }),
    parent: pane.editorEl,
  })
}

// --- Panes -------------------------------------------------------------------
// The editor area holds one pane, or two side by side (stacked when the list is
// beside the editor). Splitting starts the second pane on the note you are
// looking at, and the two mirror each other's edits while they show the same
// note, so the split reads as two views of one file until you open something
// else in one of them.

function createPane(): Pane {
  const el = document.createElement('div')
  el.className = 'note-pane'
  const captionEl = document.createElement('div')
  captionEl.className = 'pane-caption'
  const editorEl = document.createElement('div')
  editorEl.className = 'pane-editor'
  el.append(captionEl, editorEl)
  const pane: Pane = {
    el,
    captionEl,
    editorEl,
    view: null as unknown as EditorView,
    noteId: null,
    dto: null,
    external: null,
    savedContent: '',
    saveTimer: undefined,
  }
  pane.view = createPaneEditor(pane)
  // Capture phase, so the pane is active before the editor handles the click
  // that landed in it; focusin covers the keyboard routes (Alt+Down, Tab).
  el.addEventListener('mousedown', () => activatePane(pane), true)
  el.addEventListener('focusin', () => activatePane(pane))
  panes.push(pane)
  editorElContainer.append(el)
  return pane
}

/// Makes `pane` the one the window describes: the title bar, footer and
/// interlinks switch to its note. Nothing is saved or loaded — each pane keeps
/// its own buffer and pending save.
function activatePane(pane: Pane) {
  if (pane === activePane) return
  activePane = pane
  view = pane.view
  pane.el.prepend(titleBarEl)
  titleEl.value = pane.dto?.title ?? pane.external?.name ?? ''
  titleEl.disabled = pane.external !== null
  renderDueBadge(pane.dto?.due ?? null)
  renderTitleBarTags(pane.dto?.tags ?? [])
  renderTitleBarFolder(pane.dto?.subfolder ?? null)
  fleetingActionsEl.classList.toggle('hidden', !(pane.dto?.isInbox && settings.inboxEnabled))
  applyFleetingSubmitShape()
  templateActionsEl.classList.toggle('hidden', pane.external?.kind !== 'template')
  syncEmptyState()
  renderPaneCaptions()
  renderStats()
  void refreshInterlinks()
}

/// The inactive pane names its note in a strip where the active pane has the
/// title bar, so the two bars sit level and nothing is said twice.
function renderPaneCaptions() {
  editorElContainer.classList.toggle('split', panes.length > 1)
  for (const p of panes) {
    p.el.classList.toggle('active', p === activePane)
    p.captionEl.textContent = p.dto?.title ?? p.external?.name ?? 'No note open'
  }
}

/// The "type to search" placeholder covers the whole editor area, so it is
/// only right while a single, empty pane is showing.
function syncEmptyState() {
  const empty = activePane.noteId === null && activePane.external === null
  emptyEl.classList.toggle('hidden', !empty || panes.length > 1)
}

/// The editor viewports just changed shape, and the styler decorates only
/// what's visible.
function measurePanes() {
  for (const p of panes) p.view.requestMeasure()
}

/// The panes holding a given note, or a given external document.
function panesShowing(noteId: string | null, external: ExternalDoc | null = null): Pane[] {
  return panes.filter(
    (p) =>
      (noteId !== null && p.noteId === noteId) ||
      (external !== null && p.external?.kind === external.kind && p.external.id === external.id),
  )
}

/// Which way two panes split. Unset, it follows the layout: side by side
/// under a wide editor (list above), stacked beside a tall one (list to the
/// left). Set, it is whichever way you last asked for, remembered per machine
/// like the divider positions.
function splitStacked(): boolean {
  const stored = localStorage.getItem('splitStacked')
  if (stored === 'true' || stored === 'false') return stored === 'true'
  return layoutMode !== 'vertical'
}

function applySplitAxis() {
  editorElContainer.classList.toggle('side-by-side', !splitStacked())
  applySplitFraction()
  measurePanes()
}

// --- Pane divider -------------------------------------------------------------
// The line between two panes is a handle: drag it, or with it focused use the
// arrow keys along it, and the panes share the editor in the new proportion.
// Each axis remembers its own share, per machine like the other divider.

const DIVIDER_STEP_PX = 24

const paneDividerEl = document.createElement('div')
paneDividerEl.id = 'pane-divider'
paneDividerEl.setAttribute('role', 'separator')
paneDividerEl.setAttribute('aria-label', 'Resize editor panes')
paneDividerEl.tabIndex = 0

function splitFractionKey(): string {
  return splitStacked() ? 'stackedSplitFraction' : 'sideBySideSplitFraction'
}

/// The first pane's share of the editor.
function splitFraction(): number {
  return storedNumber(splitFractionKey(), 0.5)
}

/// Clamped so neither pane can be dragged away — a pane with no width is a
/// state there's no way back out of by dragging.
function setSplitFraction(fraction: number) {
  const clamped = Math.min(0.85, Math.max(0.15, fraction))
  localStorage.setItem(splitFractionKey(), String(clamped))
  applySplitFraction()
}

/// Flex-grow in the ratio of the shares, so the split is a proportion of
/// whatever the editor is currently, not a pixel size that goes stale when
/// the window or the other divider moves.
function applySplitFraction() {
  if (panes.length < 2) {
    for (const p of panes) p.el.style.flex = ''
    return
  }
  const fraction = splitFraction()
  panes[0].el.style.flex = `${fraction} 1 0`
  panes[1].el.style.flex = `${1 - fraction} 1 0`
  measurePanes()
}

paneDividerEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  e.preventDefault()
  paneDividerEl.setPointerCapture(e.pointerId)
  paneDividerEl.classList.add('dragging')
  const onMove = (move: PointerEvent) => {
    const box = editorElContainer.getBoundingClientRect()
    setSplitFraction(
      splitStacked()
        ? (move.clientY - box.top) / Math.max(1, box.height)
        : (move.clientX - box.left) / Math.max(1, box.width),
    )
  }
  const onUp = () => {
    paneDividerEl.classList.remove('dragging')
    paneDividerEl.removeEventListener('pointermove', onMove)
    paneDividerEl.removeEventListener('pointerup', onUp)
  }
  paneDividerEl.addEventListener('pointermove', onMove)
  paneDividerEl.addEventListener('pointerup', onUp)
})

// Double-click puts the split back to even, the one position worth a gesture.
paneDividerEl.addEventListener('dblclick', () => setSplitFraction(0.5))

paneDividerEl.addEventListener('keydown', (e) => {
  const box = editorElContainer.getBoundingClientRect()
  const extent = Math.max(1, splitStacked() ? box.height : box.width)
  const step = DIVIDER_STEP_PX / extent
  const grow = splitStacked() ? 'ArrowDown' : 'ArrowRight'
  const shrink = splitStacked() ? 'ArrowUp' : 'ArrowLeft'
  if (e.key === grow) setSplitFraction(splitFraction() + step)
  else if (e.key === shrink) setSplitFraction(splitFraction() - step)
  else if (e.key === 'Home') setSplitFraction(0)
  else if (e.key === 'End') setSplitFraction(1)
  else return
  e.preventDefault()
})

function flipSplit() {
  localStorage.setItem('splitStacked', String(!splitStacked()))
  applySplitAxis()
}

function paneAt(x: number, y: number): Pane | null {
  const el = document.elementFromPoint(x, y)?.closest('.note-pane')
  return panes.find((p) => p.el === el) ?? null
}

/// Copies an edit made in `pane` into every other pane showing the same note.
/// Their documents are identical by construction — a twin starts as a copy
/// and receives every edit since — so the change set applies as is; if they
/// have somehow drifted, the whole text is put right instead.
function mirrorToTwins(pane: Pane, u: ViewUpdate) {
  for (const twin of panesShowing(pane.noteId, pane.external)) {
    if (twin === pane) continue
    const inStep = twin.view.state.doc.length === u.startState.doc.length
    twin.view.dispatch({
      changes: inStep
        ? u.changes
        : { from: 0, to: twin.view.state.doc.length, insert: u.state.doc.toString() },
      annotations: mirrored.of(true),
    })
  }
}

/// Opens a second pane on the active note, or, with two showing, closes the
/// one you are not in — so the same key takes the split down again.
async function toggleSplit() {
  if (panes.length > 1) {
    await closePane(panes.find((p) => p !== activePane)!)
    return
  }
  const source = activePane
  const twin = createPane()
  twin.noteId = source.noteId
  twin.dto = source.dto
  twin.external = source.external
  twin.savedContent = source.savedContent
  twin.view.dispatch({
    changes: { from: 0, to: 0, insert: source.view.state.doc.toString() },
    effects: editable.reconfigure(
      EditorView.editable.of(source.noteId !== null || source.external !== null),
    ),
    selection: { anchor: source.view.state.selection.main.head },
    annotations: mirrored.of(true),
  })
  twin.el.before(paneDividerEl)
  activatePane(twin)
  renderPaneCaptions()
  applySplitFraction()
  twin.view.focus()
}

/// Takes a pane down, its pending edit written first. The last pane never
/// closes — closeEditor empties it instead.
async function closePane(pane: Pane) {
  if (panes.length < 2) return
  cancelPendingSave(pane)
  await savePane(pane)
  panes.splice(panes.indexOf(pane), 1)
  if (pane === activePane) activatePane(panes[0])
  pane.view.destroy()
  pane.el.remove()
  paneDividerEl.remove()
  renderPaneCaptions()
  syncEmptyState()
  applySplitFraction()
  view.focus()
}

/// The note a pane was showing is gone (deleted, or turned into a template):
/// the active pane is emptied, any other pane is closed.
async function releasePanes(gone: Pane[]) {
  for (const pane of gone) {
    if (pane === activePane) closeEditor()
    else await closePane(pane)
  }
}

/// Opens a note beside what you are looking at: into the other pane, splitting
/// first if there is only one. That pane becomes the active one, so the note
/// is where the caret goes next.
async function openInSplitPane(id: string) {
  if (panes.length < 2) await toggleSplit()
  else activatePane(panes.find((p) => p !== activePane)!)
  await openNote(id)
  renderList()
  view.focus()
}

function focusOtherPane() {
  const other = panes.find((p) => p !== activePane)
  if (!other) return
  activatePane(other)
  other.view.focus()
}

activePane = createPane()
view = activePane.view
activePane.el.prepend(titleBarEl)

// --- Footer: interlinks and counts ------------------------------------------

interface InterlinkRef {
  id: string
  title: string
}
interface SuggestionDto {
  title: string
  /// UTF-16 offsets, so they're usable as JS string indices directly.
  start: number
  end: number
}
interface InterlinksDto {
  links: InterlinkRef[]
  backlinks: InterlinkRef[]
  suggested: SuggestionDto[]
}

const interlinksEl = document.getElementById('interlinks')!
const interlinksToggleEl = document.getElementById('interlinks-toggle') as HTMLButtonElement
const statsEl = document.getElementById('stats')!

let interlinksExpanded = localStorage.getItem('backlinksExpanded') === 'true'
let currentInterlinks: InterlinksDto = { links: [], backlinks: [], suggested: [] }

/// Grapheme clusters, matching Swift's `String.count` — an emoji or an
/// accented character built from combining marks is one character to a reader
/// and should be one here. `Intl.Segmenter` is the only correct way to do that
/// in JS; `.length` counts UTF-16 units and would report 2 for a single emoji.
const graphemes =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

function countCharacters(text: string): number {
  // Segmenting a very long note on every keystroke is wasted work for a
  // readout nobody reads to the character at that size, so fall back to code
  // points past the point where the difference stops mattering.
  if (!graphemes || text.length > 20000) return [...text].length
  let n = 0
  for (const _ of graphemes.segment(text)) n++
  return n
}

function countWords(text: string): number {
  // Matches Swift's `split { $0.isWhitespace || $0.isNewline }`, which drops
  // empty subsequences — so runs of whitespace collapse rather than counting.
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length
}

/// The footer's labels with a box-drawing rule between them. The rule is its
/// own element so it can take the marker colour, quieter than the counts,
/// like the bar's own border; a "│" inside the text would have to be the
/// text's colour.
function withFooterRules(parts: string[]): Node[] {
  const nodes: Node[] = []
  parts.forEach((part, i) => {
    if (i > 0) {
      const rule = document.createElement('span')
      rule.className = 'footer-rule'
      rule.textContent = '│'
      nodes.push(rule)
    }
    nodes.push(document.createTextNode(part))
  })
  return nodes
}

// --- Fitting the footer to the window -----------------------------------------
// The footer never wraps. When the window is too narrow for everything, the
// counts drop out one at a time, least useful first, until what is left fits;
// a wider window brings them back. Decided from the real overflow, measured,
// rather than from a breakpoint, so it holds for any font, zoom or setting.
type FooterCount = 'characters' | 'words' | 'folders' | 'notes'
// Dropped in this order, so words outlast characters, which outlast the
// vault totals; folders go first.
const FOOTER_COLLAPSE_ORDER: FooterCount[] = ['folders', 'notes', 'characters', 'words']
const footerCollapsed = new Set<FooterCount>()
const footerEl = document.getElementById('footer')!

function paintStats() {
  if (!activePane.noteId && !activePane.external) {
    statsEl.textContent = ''
    paintVaultLabel()
    return
  }
  const text = view.state.doc.toString()
  const parts: string[] = []
  if (settings.footerWords && !footerCollapsed.has('words')) {
    const words = countWords(text)
    parts.push(`${words.toLocaleString()} word${words === 1 ? '' : 's'}`)
  }
  if (settings.footerCharacters && !footerCollapsed.has('characters')) {
    const chars = countCharacters(text)
    parts.push(`${chars.toLocaleString()} character${chars === 1 ? '' : 's'}`)
  }
  statsEl.replaceChildren(...withFooterRules(parts))
  paintVaultLabel()
}

function footerOverflows(): boolean {
  return footerEl.scrollWidth > footerEl.clientWidth + 1
}

/// Paints everything the settings allow, then hides counts in order until the
/// footer fits. Synchronous layout reads, so it runs once per change rather
/// than on every keystroke: `renderStats` and `renderVaultLabel` schedule it.
function fitFooter() {
  footerCollapsed.clear()
  paintStats()
  for (const key of FOOTER_COLLAPSE_ORDER) {
    if (!footerOverflows()) break
    footerCollapsed.add(key)
    paintStats()
  }
}

let footerFitFrame = 0
function scheduleFooterFit() {
  if (footerFitFrame) return
  footerFitFrame = requestAnimationFrame(() => {
    footerFitFrame = 0
    fitFooter()
  })
}
new ResizeObserver(() => scheduleFooterFit()).observe(footerEl)

function renderStats() {
  paintStats()
  scheduleFooterFit()
}

// Whole-vault totals, cached between the backend reads (which only change when
// notes or folders are added or removed) so the footer label can be repainted
// cheaply as the open note's own counts come and go beside it.
const vaultStatsEl = document.getElementById('vault-stats')!
let vaultCounts = { notes: 0, folders: 0 }

/// Paints the vault-totals label from the cached counts. The folder count is
/// shown only with subfolder scanning on — without it folders don't factor into
/// Envy, so a count would just be noise (the Mac's rule). The `·` divider rule
/// appears only when the open note's own counts sit beside it.
function renderVaultLabel() {
  paintVaultLabel()
  scheduleFooterFit()
}

function paintVaultLabel() {
  const { notes, folders } = vaultCounts
  const parts: string[] = []
  if (settings.footerNotes && !footerCollapsed.has('notes')) {
    parts.push(`${notes.toLocaleString()} note${notes === 1 ? '' : 's'}`)
  }
  if (settings.footerFolders && settings.includeSubfolders && !footerCollapsed.has('folders')) {
    parts.push(`${folders.toLocaleString()} folder${folders === 1 ? '' : 's'}`)
  }
  if (parts.length === 0) {
    vaultStatsEl.classList.add('hidden')
    return
  }
  vaultStatsEl.replaceChildren(...withFooterRules(parts))
  vaultStatsEl.classList.remove('hidden')
  vaultStatsEl.classList.toggle('with-divider', statsEl.textContent !== '')
}

/// Re-reads the vault totals from the store, then repaints. Called on each
/// search, since that's when a note or folder could have appeared or gone.
async function refreshVaultCounts() {
  if (!settings.footerNotes && !settings.footerFolders) {
    renderVaultLabel()
    return
  }
  try {
    vaultCounts = await invoke<{ notes: number; folders: number }>('vault_counts')
  } catch (err) {
    console.error('could not read vault counts', err)
  }
  renderVaultLabel()
}

function renderInterlinks() {
  const total =
    currentInterlinks.links.length +
    currentInterlinks.backlinks.length +
    currentInterlinks.suggested.length

  if (!activePane.noteId || total === 0 || !settings.showBacklinks) {
    interlinksToggleEl.classList.add('hidden')
    interlinksEl.classList.add('hidden')
    return
  }

  interlinksToggleEl.classList.remove('hidden')
  // The chevron points where the panel will move on the next click — up to
  // expand (it grows upward), down to collapse.
  interlinksToggleEl.textContent = `${interlinksExpanded ? '▾' : '▴'}  ${total} Interlink${total === 1 ? '' : 's'}`
  interlinksEl.classList.toggle('hidden', !interlinksExpanded)
  if (!interlinksExpanded) return

  const section = (title: string, rows: HTMLElement[]) => {
    const col = document.createElement('div')
    col.className = 'interlink-column'
    const h = document.createElement('h4')
    h.textContent = title
    col.append(h, ...rows)
    return col
  }

  const linkRow = (ref: InterlinkRef) => {
    const a = document.createElement('button')
    a.type = 'button'
    a.className = 'interlink-row'
    a.textContent = ref.title
    a.onclick = () => void openNote(ref.id).then(renderList)
    return a
  }

  const cols: HTMLElement[] = []
  // Only the non-empty sections appear, so a note with just backlinks doesn't
  // show two empty headings beside them.
  if (currentInterlinks.links.length) {
    cols.push(section('Links', currentInterlinks.links.map(linkRow)))
  }
  if (currentInterlinks.backlinks.length) {
    cols.push(section('Backlinks', currentInterlinks.backlinks.map(linkRow)))
  }
  if (currentInterlinks.suggested.length) {
    cols.push(
      section(
        'Suggested',
        currentInterlinks.suggested.map((s) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'interlink-row suggested'
          b.textContent = s.title
          b.title = 'Wrap this mention in [[…]]'
          b.onclick = () => void linkSuggestion(s)
          return b
        }),
      ),
    )
  }
  interlinksEl.replaceChildren(...cols)
}

/// Wraps a suggested mention in `[[…]]` — the only thing that ever changes a
/// note's text from the interlinks panel, and only on this explicit click.
async function linkSuggestion(s: SuggestionDto) {
  const text = view.state.doc.toString()
  // Re-verify before writing: the offsets came from the store's copy, and the
  // buffer may have moved on since. Wrapping the wrong span of someone's note
  // is far worse than doing nothing.
  if (text.slice(s.start, s.end).toLowerCase() !== s.title.toLowerCase()) {
    await refreshInterlinks()
    return
  }
  view.dispatch({
    changes: [
      { from: s.start, insert: '[[' },
      { from: s.end, insert: ']]' },
    ],
  })
  cancelPendingSave()
  await save()
  await refreshInterlinks()
}

/// Backlinks and suggestions come from a scan of the whole vault, so running
/// them from every 400 ms autosave made typing the most expensive thing the app
/// does. The panel is a reference, not a live readout of the caret: a trailing
/// debounce that resets on each save settles it about two seconds after you stop
/// and costs nothing at all while you keep going. Opening a note, and the
/// explicit actions that rewrite links (rename, extract, linking a suggestion),
/// still refresh immediately.
let interlinksTimer: number | undefined
const INTERLINKS_IDLE_MS = 2000

function scheduleInterlinks() {
  if (interlinksTimer !== undefined) clearTimeout(interlinksTimer)
  interlinksTimer = window.setTimeout(() => {
    interlinksTimer = undefined
    void refreshInterlinks()
  }, INTERLINKS_IDLE_MS)
}

async function refreshInterlinks() {
  // An immediate refresh subsumes whatever the debounce was still waiting for.
  if (interlinksTimer !== undefined) {
    clearTimeout(interlinksTimer)
    interlinksTimer = undefined
  }
  const id = activePane.noteId
  if (!id) {
    currentInterlinks = { links: [], backlinks: [], suggested: [] }
    renderInterlinks()
    return
  }
  const fetched = await invoke<InterlinksDto>('interlinks', { id })
  // Another note opened while the scan ran — showing its predecessor's links
  // is worse than showing none, and the open note has its own refresh coming.
  if (activePane.noteId !== id) return
  currentInterlinks = fetched
  renderInterlinks()
}

interlinksToggleEl.onclick = () => {
  interlinksExpanded = !interlinksExpanded
  localStorage.setItem('backlinksExpanded', String(interlinksExpanded))
  renderInterlinks()
  measurePanes()
}

// --- Wiki-links -------------------------------------------------------------

/// The link target under `pos`, or null if the position isn't inside one.
///
/// Scans the clicked line rather than consulting the decorations: the styler's
/// ranges aren't addressable after the fact, and a line is short enough that
/// re-matching it costs nothing. Handles `![[embed]]` too — the leading `!`
/// changes how it renders, not where it points.
/// The full `[[…]]` (or `![[…]]`) span at a position, or null — for deciding
/// whether a click landed inside a link the caret already occupies.
function wikiLinkRangeAt(v: EditorView, pos: number): { from: number; to: number } | null {
  const line = v.state.doc.lineAt(pos)
  const re = /!?\[\[([^\[\]]+)\]\]/g
  for (const m of line.text.matchAll(re)) {
    const from = line.from + m.index!
    const to = from + m[0].length
    if (pos >= from && pos <= to) return { from, to }
  }
  return null
}

function wikiLinkTargetAt(v: EditorView, pos: number): string | null {
  const line = v.state.doc.lineAt(pos)
  const re = /!?\[\[([^\[\]]+)\]\]/g
  for (const m of line.text.matchAll(re)) {
    const from = line.from + m.index!
    const to = from + m[0].length
    if (pos >= from && pos <= to) {
      // Strip an alias or heading suffix — `[[Note|shown]]` points at `Note`,
      // and `[[Note#Heading]]` resolves to the note. Mirrors WikiLink::parse.
      const body = m[1]
      const target = body.split('|')[0].split('#')[0].trim()
      return target || null
    }
  }
  return null
}

async function followLink(target: string) {
  // Flush the current note first: following a link that creates a note causes
  // a rescan, and an unsaved buffer would be read back stale.
  cancelPendingSave()
  await save()
  const note = await invoke<NoteDto>('open_link', { target })
  void refreshCompletionSources()
  await runSearch()
  await openNote(note.id)
  highlighted = await indexOfNote(note.id)
  if (highlighted < 0) highlighted = 0
  await ensureLoaded(highlighted)
  renderList()
  view.focus()
}

// --- Image attachments -------------------------------------------------------
// Pasting or dropping an image writes the file into the vault's Attachments/
// folder and inserts an `![[filename]]` embed the styler renders inline. Mirrors
// the Mac's paste/drop handlers in MarkdownTextView.

/// The last note this window wrote, and when. Rust already suppresses the
/// watcher for a moment after a write, but an `index-changed` raised by another
/// window (or by a rescan that outlasts that window) still arrives, and
/// re-reading a file we just wrote is a round trip for a string we already hold.
let lastOwnWriteId: string | null = null
let lastOwnWriteAt = 0
const OWN_WRITE_WINDOW_MS = 1500

/// Pulls the open note's text back from disk when it changed underneath the
/// buffer — a transclusion source edited elsewhere, an attachment renamed (which
/// rewrites references), the watcher firing. Skipped while unsaved keystrokes
/// are in flight, since clobbering what someone is typing is worse than a
/// moment's staleness.
async function reloadOpenNoteFromDisk() {
  for (const pane of panes) {
    if (!pane.noteId || pane.saveTimer !== undefined) continue
    const fresh = await invoke<NoteDto | null>('read_note', { id: pane.noteId })
    if (!fresh || fresh.content === null || fresh.content === pane.view.state.doc.toString()) continue
    const cursor = pane.view.state.selection.main.head
    const changed = changedRange(pane.view.state.doc.toString(), fresh.content)
    pane.view.dispatch({
      changes: { from: 0, to: pane.view.state.doc.length, insert: fresh.content },
      selection: { anchor: Math.min(cursor, fresh.content.length) },
      // Not an edit of this pane's making: the twin, if any, gets its own
      // copy from disk on the next turn of this loop.
      annotations: mirrored.of(true),
    })
    // What's on disk is now what's in the buffer, so a later save has nothing
    // to write until the text actually changes again.
    pane.savedContent = fresh.content
    if (pane === activePane) flashChangedRange(changed)
  }
}

/// Renames an attachment from the image's right-click menu. The shared flow does
/// the prompt and the Rust call; the hooks are this window's own — flush the open
/// buffer so its references are on disk to rewrite, then refresh everything so it
/// shows the new name rather than saving the old one back.
function renameAttachment(oldName: string) {
  return renameAttachmentFlow(oldName, {
    flush: async () => {
      cancelPendingSave()
      await save()
    },
    reload: async () => {
      await runSearch()
      refreshEmbeds()
      await reloadOpenNoteFromDisk()
    },
  })
}

/// Saves a pasted image blob to Attachments/ and drops in its reference. The
/// bytes go over as a plain array — a paste is one-off and images are modest, so
/// the simplicity is worth more than shaving the IPC.
async function importPastedImage(file: File, v: EditorView) {
  try {
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
    // WebView2 hands clipboard images over as PNG; keep the real subtype for the
    // rare non-PNG so the file extension matches its bytes.
    const ext = file.type.startsWith('image/') ? file.type.slice('image/'.length) : 'png'
    const name = await invoke<string>('save_attachment', {
      bytes,
      base: 'Pasted image',
      ext: ext || 'png',
    })
    insertImageReference(name, v)
  } catch (e) {
    console.error('could not paste image', e)
  }
}

// Native file drops. Tauri intercepts the webview's own drop events and reports
// them here with real file paths, so a dropped image is copied into
// Attachments/ (leaving the original in place) and referenced at the drop point.
void getCurrentWebview().onDragDropEvent(async (event) => {
  if (event.payload.type !== 'drop') return
  // The drop goes into the pane under the pointer, which becomes the active one.
  const under = paneAt(event.payload.position.x, event.payload.position.y)
  if (under) activatePane(under)
  if (!activePane.noteId && !activePane.external) return
  const imagePath = event.payload.paths.find((p) => isImageTarget(p))
  if (!imagePath) return
  // The position is labelled physical, but on Linux it is GTK's own logical
  // widget coordinate handed straight through (wry's webkitgtk drag_drop
  // passes the drag-drop signal's x/y untouched), so it is already in CSS
  // pixels. Dividing by devicePixelRatio, as the Windows port does for a real
  // physical position, put the caret at half the distance on a 2× display.
  const pos = view.posAtCoords({
    x: event.payload.position.x,
    y: event.payload.position.y,
  })
  try {
    const name = await invoke<string>('copy_attachment', { path: imagePath })
    // Land the caret where it was dropped, falling back to wherever it already
    // is if the drop wasn't over the text.
    if (pos != null) view.dispatch({ selection: { anchor: pos } })
    insertImageReference(name, view)
  } catch (e) {
    console.error('could not import dropped image', e)
  }
})

// --- In-note navigation ------------------------------------------------------
// Clicking a footnote reference jumps to its definition, and a `[text](#slug)`
// anchor jumps to that heading — both within the open note, both on a plain
// click, matching the Mac's envy-footnote / envy-heading schemes. A `[text](url)`
// with an http(s) URL opens externally, honouring the modifier gate like any
// other outbound link.

/// The `[text](url)` markdown link at a position, or null. Mirrors the styler's
/// `link` pattern; url is the part in parentheses.
function markdownLinkAt(v: EditorView, pos: number): { url: string; from: number; to: number } | null {
  const line = v.state.doc.lineAt(pos)
  const re = /(?<!!)\[([^\[\]]+)\]\(([^()\s]+)\)/g
  for (const m of line.text.matchAll(re)) {
    const from = line.from + m.index!
    const to = from + m[0].length
    if (pos >= from && pos <= to) return { url: m[2], from, to }
  }
  return null
}

/// The footnote label at a position when it's a *reference* `[^label]`, or null.
/// A definition marker `[^label]:` (colon straight after) is not a reference and
/// isn't clickable — matching the Mac, where only references carry the link.
function footnoteRefAt(v: EditorView, pos: number): string | null {
  const line = v.state.doc.lineAt(pos)
  const re = /\[\^([^\]]+)\]/g
  for (const m of line.text.matchAll(re)) {
    const from = line.from + m.index!
    const to = from + m[0].length
    if (pos >= from && pos <= to) {
      return v.state.doc.sliceString(to, to + 1) === ':' ? null : m[1]
    }
  }
  return null
}

/// A heading's slug, GitHub-style: lowercased, everything but letters, digits,
/// spaces and hyphens dropped, then runs of spaces collapsed to single dashes.
/// Mirrors MarkdownStyler.headingSlug so `[text](#slug)` matches its heading.
function headingSlug(text: string): string {
  const kept = [...text.toLowerCase()]
    .filter((c) => /[\p{L}\p{N}]/u.test(c) || c === ' ' || c === '-')
    .join('')
  return kept.split(' ').filter((s) => s.length > 0).join('-')
}

/// The `[^label]:` definition marker range for a footnote label, or null.
function footnoteDefinitionRange(doc: string, label: string): { from: number; to: number } | null {
  const re = /^\[\^([^\]]+)\]:[ \t]*/gm
  for (const m of doc.matchAll(re)) {
    if (m[1] === label) return { from: m.index!, to: m.index! + m[0].length }
  }
  return null
}

/// The range of the heading text whose slug matches, or null. Duplicate slugs
/// get `-1`, `-2`, … in document order, GitHub-style, as the Mac does.
function headingRangeForSlug(doc: string, slug: string): { from: number; to: number } | null {
  const re = /^(#{1,6})[ \t]+(.*)$/gm
  const seen = new Map<string, number>()
  for (const m of doc.matchAll(re)) {
    const base = headingSlug(m[2])
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    const resolved = count === 0 ? base : `${base}-${count}`
    if (resolved === slug) {
      const from = m.index! + (m[0].length - m[2].length)
      return { from, to: from + m[2].length }
    }
  }
  return null
}

/// Scrolls a range into view and flashes it — the Mac's scrollRangeToVisible +
/// showFindIndicator. The caret is left untouched, so a jump never disturbs
/// where you were typing.
function jumpToRange(range: { from: number; to: number }) {
  view.dispatch({ effects: EditorView.scrollIntoView(range.from, { y: 'center' }) })
  flashChangedRange(range)
}

// --- Layout -----------------------------------------------------------------
// Vertical (list above, note below) is how Envy-Linux opens: a stacked
// Notational Velocity pane, not a sidebar. Horizontal is the other choice, and
// it is `appearance.layout` in config.md, so it survives a relaunch and can be
// set from the file. The split position itself stays in localStorage: it is a
// pixel measurement of this window, not a preference anyone would write down.

type LayoutMode = 'vertical' | 'horizontal'

const DEFAULT_TOP_FRACTION = 0.38
const DEFAULT_LIST_WIDTH = 280
const MIN_LIST_WIDTH = 220

function storedNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? n : fallback
}

let layoutMode: LayoutMode = 'vertical'
// Drop the old 0.6 default once so the stacked list isn't huge on first open.
if (localStorage.getItem('omarchyStackedLayout') !== '1') {
  localStorage.removeItem('verticalSplitFraction')
  localStorage.setItem('omarchyStackedLayout', '1')
}

function applyLayout() {
  panesEl.className = layoutMode
  applySplitAxis()
  if (layoutMode === 'vertical') {
    const fraction = storedNumber('verticalSplitFraction', DEFAULT_TOP_FRACTION)
    listPaneEl.style.height = `${(fraction * 100).toFixed(3)}%`
    listPaneEl.style.width = ''
  } else {
    const width = storedNumber('horizontalListWidth', DEFAULT_LIST_WIDTH)
    listPaneEl.style.width = `${width}px`
    listPaneEl.style.height = ''
  }
  // The editor's viewport just changed shape, and the styler decorates only
  // what's visible.
  measurePanes()
}

/// Applying and persisting are separate: `applyAllSettings` re-applies the
/// layout the file already holds, and writing it back from there would be a
/// change made in answer to itself.
function setLayout(next: LayoutMode) {
  layoutMode = next
  saveSetting('layout', layoutMode)
  applyLayout()
}

function toggleLayout() {
  setLayout(layoutMode === 'vertical' ? 'horizontal' : 'vertical')
}

dividerEl.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  dividerEl.setPointerCapture(e.pointerId)
  dividerEl.classList.add('dragging')

  const onMove = (move: PointerEvent) => {
    const box = panesEl.getBoundingClientRect()
    if (layoutMode === 'vertical') {
      // Clamped so neither pane can be dragged away entirely — a zero-height
      // list or editor is a state there's no way back out of by dragging.
      const fraction = Math.min(0.9, Math.max(0.1, (move.clientY - box.top) / box.height))
      localStorage.setItem('verticalSplitFraction', String(fraction))
    } else {
      const width = Math.min(
        box.width - 240,
        Math.max(MIN_LIST_WIDTH, move.clientX - box.left),
      )
      localStorage.setItem('horizontalListWidth', String(width))
    }
    applyLayout()
  }
  const onUp = () => {
    dividerEl.classList.remove('dragging')
    dividerEl.removeEventListener('pointermove', onMove)
    dividerEl.removeEventListener('pointerup', onUp)
  }
  dividerEl.addEventListener('pointermove', onMove)
  dividerEl.addEventListener('pointerup', onUp)
})

function scheduleSave(pane: Pane = activePane) {
  cancelPendingSave(pane)
  pane.saveTimer = window.setTimeout(() => {
    pane.saveTimer = undefined
    void savePane(pane)
  }, 400)
}

/// Clearing the handle is not bookkeeping pedantry: `saveTimer === undefined`
/// is what "no unsaved keystrokes in flight" is read from, and a stale handle
/// would make the watcher refuse to ever refresh the open note.
function cancelPendingSave(pane: Pane = activePane) {
  window.clearTimeout(pane.saveTimer)
  pane.saveTimer = undefined
}

/// Writes the active pane's buffer — what every "flush before you do that"
/// caller means.
function save() {
  return savePane(activePane)
}

async function savePane(pane: Pane) {
  const content = pane.view.state.doc.toString()
  // Nothing changed — writing anyway would touch the modified time and
  // reorder the list for no reason.
  if (content === pane.savedContent) return

  if (pane.external) {
    try {
      await saveExternalDocument(pane.external, content)
      pane.savedContent = content
      for (const twin of panesShowing(null, pane.external)) twin.savedContent = content
    } catch (e) {
      console.error(`could not save ${pane.external.name}`, e)
    }
    return
  }

  if (!pane.noteId) return
  try {
    const saved = await invoke<NoteDto>('save_note', {
      id: pane.noteId,
      content,
    })
    // A twin showing the same note already holds this text, keystroke by
    // keystroke, so it has nothing of its own to write either.
    for (const twin of panesShowing(pane.noteId)) twin.savedContent = content
    // What the watcher is about to report, if the suppression window in Rust
    // misses it, is this write. `reloadOpenNoteFromDisk` would then re-read a
    // file it already has in the buffer, so the index-changed handler skips it.
    lastOwnWriteId = saved.id
    lastOwnWriteAt = Date.now()
    applySavedNote(saved)
    // Editing text can add or remove a [[link]], which changes what this note
    // points at and what it merely mentions. Debounced: see scheduleInterlinks.
    if (pane === activePane) scheduleInterlinks()
  } catch (e) {
    console.error('save failed', e)
  }
}

/// Folds a just-saved note's freshly derived values back into the list and the
/// title bar. Adding, changing, or deleting an `@due` token changes the pill,
/// the row, and possibly the sort position — none of which the watcher will
/// report, since a write suppresses it on purpose.
function applySavedNote(saved: NoteDto) {
  const idx = results.findIndex((n) => n?.id === saved.id)
  if (idx >= 0) {
    // Keep the content field: `results` entries carry it as null by design,
    // and the row only reads derived values anyway.
    results[idx] = { ...saved, content: null }
  }
  for (const pane of panesShowing(saved.id)) pane.dto = saved
  if (activePane.noteId === saved.id) renderDueBadge(saved.due)
  // A changed due date or modified time can move the row under the current
  // sort, so the order has to be recomputed — but resolve the highlight against
  // the *new* order before painting, rather than rendering once at the old
  // index and again at the corrected one.
  const keepId = results[highlighted]?.id ?? activePane.noteId
  if (!fullyLoaded()) {
    // Paged: the row that moved shifts every index after it, so the order has
    // to come back from the backend rather than be recomputed from the pages
    // this window happens to hold.
    void refetchList(keepId)
    return
  }
  markOrderDirty()
  reorderResults()
  const moved = results.findIndex((n) => n?.id === keepId)
  if (moved >= 0) highlighted = moved
  renderList()
}

function renderDueBadge(due: string | null) {
  const show = due && settings.showDuePill
  // Fixed to "smart" rather than the user's style, as the Mac does: the labels
  // this pill actually shows are identical across styles, so there is nothing
  // for the setting to change here.
  dueEl.textContent = show ? formatDue(due, 'smart') : ''
  dueEl.className = show ? `envy-due-${dueUrgencyClass(due)}` : ''
}

/// Tags of the open note, shown beside its title. Off by default — the tags
/// are already visible in the text, so this is for people who want them
/// summarised rather than hunted for.
// --- Link pills --------------------------------------------------------------
// A bare URL renders as a pill showing just its domain. The emoji beside it is
// a preference keyed by the domain — the note holds the plain URL, so every
// link to one site carries the same mark and nothing is written into the file.

/// The quick picks, matching the Mac's — a spread of source types a commonplace
/// book tends to collect.
const DOMAIN_EMOJI_PRESETS = ['📰', '📄', '📚', '📺', '🎥', '🎧', '🐙', '💻', '🛒', '💬', '⭐️', '🌐']

function domainEmojis(): Record<string, string> {
  return config.map('domain_emojis')
}

function setDomainEmoji(domain: string, emoji: string | null) {
  config.setMapEntry('domain_emojis', domain, emoji)
  // The pill is a widget built during styling, so a restyle is what repaints
  // it — there is no element to poke directly, and nothing in the document
  // changed for the plugin to notice on its own.
  view.dispatch({ effects: restyle.of(null) })
}

// Delegated rather than bound inside the widget: the widget is built by the
// styler, which has no business knowing about commands or context menus, and
// is rebuilt on every restyle anyway.
editorElContainer.addEventListener('click', (e) => {
  const pill = (e.target as HTMLElement).closest('.envy-url-pill') as HTMLElement | null
  if (!pill?.dataset.url) return
  e.preventDefault()
  void invoke('open_external_url', { url: pill.dataset.url }).catch((err) =>
    console.error('could not open the link', err),
  )
})

editorElContainer.addEventListener('contextmenu', (e) => {
  // An image widget runs its own menu (size/rename/reveal); leave it be.
  if ((e.target as HTMLElement).closest('.envy-image-embed')) return
  const pill = (e.target as HTMLElement).closest('.envy-url-pill') as HTMLElement | null
  const domain = pill?.dataset.domain
  // Off a pill, the plain editor menu — just "Insert Image…" for now, so the
  // picker has a discoverable home besides the shortcut.
  if (!domain) {
    if (!activePane.noteId && !activePane.external) return
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, [
      {
        label: 'Insert Image…',
        run: () => void openImagePicker((name) => insertImageReference(name, view)),
      },
      { label: 'Insert Table', run: () => void insertTable(view) },
      { label: '', separator: true },
      {
        label: panes.length > 1 ? 'Close Split' : 'Split Editor',
        run: () => void toggleSplit(),
      },
      {
        label: splitStacked() ? 'Panes Side by Side' : 'Panes Stacked',
        run: flipSplit,
      },
    ])
    return
  }
  e.preventDefault()
  e.stopPropagation()
  openContextMenu(e.clientX, e.clientY, domainEmojiMenu(domain))
})

/// The emoji menu for one link domain. Its own function because the keyboard
/// raises the same menu (see the `emojiForLink` shortcut) and a second copy
/// would be a second thing to keep in step.
function domainEmojiMenu(domain: string): MenuItemSpec[] {
  const current = domainEmojis()[domain]
  // Bare emoji, as the Mac's menu items are — the domain is already named by
  // the pill that was right-clicked, so repeating it on all twelve rows is
  // noise.
  const items: MenuItemSpec[] = DOMAIN_EMOJI_PRESETS.map((emoji) => ({
    label: emoji,
    run: () => setDomainEmoji(domain, emoji),
  }))
  items.push({ label: '', separator: true })
  items.push({
    label: 'Other…',
    run: async () => {
      // The picker is in-app, so choosing an emoji is the same gesture on every
      // platform rather than whatever panel the desktop happens to provide.
      const picked = await pickEmoji({ title: `Emoji for ${domain}`, current })
      if (picked === null) return
      setDomainEmoji(domain, picked)
    },
  })
  if (current) {
    items.push({
      label: 'Remove Emoji',
      destructive: true,
      run: () => setDomainEmoji(domain, null),
    })
  }
  return items
}

// --- Tag colours -------------------------------------------------------------
// Like a folder's colour, this is a *preference*, not note content. The `#tag`
// in the file is the truth and stays exactly as portable as before; the tint is
// presentation, the way the theme is. Open the vault in another editor and the
// tag still categorises exactly as it did — only the colour, which was never in
// the file, is absent.
//
// The colour belongs to the tag *name*, so every note carrying it shows the
// same one. That is the line that stops coloured tags becoming hidden per-note
// state attached to a note behind its back.

function tagColors(): Record<string, string> {
  return config.map('tag_colors')
}

function setTagColor(tag: string, color: string | null) {
  config.setMapEntry('tag_colors', tag, color)
  renderTitleBarTags(activePane.dto?.tags ?? [])
}

function tagColorMenu(tag: string): MenuItemSpec[] {
  const current = tagColors()[tag]
  const items: MenuItemSpec[] = FOLDER_PRESETS.map(([label, hex]) => ({
    label,
    swatch: hex,
    run: () => setTagColor(tag, hex),
  }))
  if (current) {
    items.push({ label: '', separator: true })
    items.push({
      label: 'Remove Color',
      destructive: true,
      run: () => setTagColor(tag, null),
    })
  }
  return items
}

function renderTitleBarTags(tags: string[]) {
  tagsEl.replaceChildren()
  if (!settings.showTagsInTitleBar || tags.length === 0) return
  const colors = tagColors()
  for (const t of tags) {
    const el = document.createElement('span')
    el.className = 'envy-tag title-tag'
    el.textContent = `#${t}`
    el.title = `Search tag:"${t}" — right-click to color it`
    const tint = colors[t]
    if (tint) {
      // A tinted tag paints its own translucent capsule from its colour, so it
      // reads as that colour without needing a second theme entry. An untinted
      // one keeps the theme's ordinary tag background untouched.
      el.style.color = tint
      el.style.background = `color-mix(in srgb, ${tint} 18%, transparent)`
    }
    el.onclick = () => {
      // Quoted, and quoting means exact — clicking #tag must not also surface
      // #tags, so what you click is exactly what you get (Mac 1.8.8).
      searchInput.value = `tag:"${t}"`
      void runSearch()
    }
    el.oncontextmenu = (e) => {
      e.preventDefault()
      openContextMenu(e.clientX, e.clientY, tagColorMenu(t))
    }
    tagsEl.append(el)
  }
}

/// The open note's folder as a chip beside its tags. Only for a note that sits
/// in a real subfolder — root and Inbox notes show nothing, so it costs no
/// space when unused. Tinted to the folder's colour (or a neutral outline when
/// it has none). Click pivots to the folder; right-click recolours it — but no
/// Rename here, the same as the Mac's title-bar chip. An outlined capsule, a
/// deliberately different species from the filled tag chips beside it.
function renderTitleBarFolder(subfolder: string | null) {
  folderChipEl.replaceChildren()
  if (!settings.showFolderInTitleBar || !subfolder) {
    folderChipEl.classList.add('hidden')
    return
  }
  folderChipEl.classList.remove('hidden')
  const color = folderColors()[subfolder]
  const chip = document.createElement('span')
  chip.className = 'title-folder-chip'
  chip.title = `In ${subfolder} · click to see this folder's notes`
  const icon = document.createElement('span')
  icon.className = 'title-folder-icon'
  const name = document.createElement('span')
  name.textContent = subfolder
  chip.append(icon, name)
  if (color) {
    chip.style.color = color
    chip.style.borderColor = `color-mix(in srgb, ${color} 40%, transparent)`
  }
  chip.onclick = () => searchByFolder(subfolder)
  chip.oncontextmenu = (e) => {
    e.preventDefault()
    openContextMenu(e.clientX, e.clientY, folderColorMenu(subfolder))
  }
  folderChipEl.append(chip)
}

function dueUrgencyClass(iso: string): string {
  const due = new Date(iso + 'T00:00:00')
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (due < today) return 'overdue'
  // End of the current calendar week, matching envy-core's urgency_for.
  const weekEnd = new Date(today.getTime() + (6 - today.getDay()) * 86400000)
  return due <= weekEnd ? 'soon' : 'later'
}

// --- Settings ---------------------------------------------------------------
// Every setting below lives in `~/.config/envy/config.md`, so the Settings
// panel and the file are two views of one thing: change either and the other
// follows. Defaults come from config/schema.json, not from here — a default
// written down twice is a default that will eventually disagree with itself.

/// The config.md table and key behind each field of `settings`. The property
/// names are the app's own vocabulary and the schema's keys are the file's;
/// this is the one place the two meet. Anything below that is not a field of
/// `settings` — the layout, the zoom, the sort — is here for the same reason:
/// so a write goes through one named pair rather than a string at the call
/// site.
const SETTING_KEY = {
  showNotePreview: ['list', 'show_preview'],
  showDateModified: ['list', 'show_date'],
  showDueSort: ['list', 'show_due'],
  includeSubfolders: ['index', 'include_subfolders'],
  theme: ['appearance', 'theme'],
  fontSource: ['appearance', 'font'],
  fontCustom: ['appearance', 'font_family'],
  fontFeatures: ['appearance', 'font_features'],
  moveFocusToEditorOnEnter: ['list', 'focus_editor_on_enter'],
  dateDisplayStyle: ['list', 'date_style'],
  inboxEnabled: ['list', 'inbox_enabled'],
  keepPinnedNotesVisible: ['list', 'keep_pinned_visible'],
  newNotesStartInInbox: ['list', 'new_notes_in_inbox'],
  showInboxInMainList: ['list', 'show_inbox_in_list'],
  showTagsInTitleBar: ['editor', 'show_tags_in_title_bar'],
  footerWords: ['footer', 'words'],
  footerCharacters: ['footer', 'characters'],
  footerNotes: ['footer', 'notes'],
  footerFolders: ['footer', 'folders'],
  showFolderInTitleBar: ['editor', 'show_folder_in_title_bar'],
  folderListDisplay: ['list', 'folder_display'],
  folderDotTrailing: ['list', 'folder_marker_trailing'],
  showDuePill: ['editor', 'show_due_pill'],
  linkDomainPills: ['editor', 'link_domain_pills'],
  requireModifierForLinkClick: ['editor', 'require_modifier_for_links'],
  showBacklinks: ['editor', 'show_interlinks'],
  hideOnFocusLoss: ['system', 'hide_on_focus_loss'],
  hyprlandBind: ['system', 'hyprland_bind'],
  tiled: ['system', 'tiled'],
  popoutTiled: ['system', 'popout_tiled'],
  restoreFocusOnSummon: ['system', 'restore_focus_on_summon'],
  linkPreview: ['editor', 'link_preview'],
  listDensity: ['list', 'density'],
  interfaceTextSize: ['appearance', 'text_size'],
  fadeFocusHighlight: ['appearance', 'fade_focus_highlight'],
  showFooterClock: ['footer_clock', 'show'],
  showFooterClockDate: ['footer_clock', 'show_date'],
  showFooterClockOnlyWhenFullScreen: ['footer_clock', 'only_when_fullscreen'],
  footerClockDateFormat: ['footer_clock', 'date_format'],
  boldFileListText: ['list', 'bold_text'],
  templateDateFormat: ['templates', 'date_format'],
  trashEmptyIntervalValue: ['trash', 'empty_every'],
  trashEmptyIntervalUnit: ['trash', 'empty_unit'],
  // Live variables rather than fields of `settings`, because a shortcut flips
  // each of them too — but they persist the same way.
  layout: ['appearance', 'layout'],
  editorZoom: ['editor', 'zoom'],
  plainText: ['editor', 'plain_text'],
  sortField: ['list', 'sort'],
  sortAscending: ['list', 'sort_ascending'],
} as const satisfies Record<string, readonly [string, string]>

type SettingName = keyof typeof SETTING_KEY

const settingBool = (name: SettingName) => config.getBool(SETTING_KEY[name][0], SETTING_KEY[name][1])
const settingText = (name: SettingName) => config.getString(SETTING_KEY[name][0], SETTING_KEY[name][1])
const settingNumber = (name: SettingName) =>
  config.getNumber(SETTING_KEY[name][0], SETTING_KEY[name][1])

/// Everything the app reads while it runs, snapshotted from the config. Read
/// afresh (never patched in place from the file) so there is exactly one way a
/// value gets here.
function readSettings() {
  return {
    showNotePreview: settingBool('showNotePreview'),
    showDateModified: settingBool('showDateModified'),
    showDueSort: settingBool('showDueSort'),
    includeSubfolders: settingBool('includeSubfolders'),
    theme: settingText('theme'),
    fontSource: settingText('fontSource'),
    fontCustom: settingText('fontCustom'),
    fontFeatures: settingText('fontFeatures'),
    moveFocusToEditorOnEnter: settingBool('moveFocusToEditorOnEnter'),
    dateDisplayStyle: settingText('dateDisplayStyle'),
    // Whether the Inbox exists at all. Off, there is no capture queue: no
    // badge, no fleeting marks, no `inbox:` mode, and the two toggles below
    // are moot.
    inboxEnabled: settingBool('inboxEnabled'),
    // Parks the pinned notes (up to three) in a strip under the list header so
    // they stay reachable however far the list scrolls. Off, pins sort to the
    // top and scroll away with the rest.
    keepPinnedNotesVisible: settingBool('keepPinnedNotesVisible'),
    newNotesStartInInbox: settingBool('newNotesStartInInbox'),
    showInboxInMainList: settingBool('showInboxInMainList'),
    showTagsInTitleBar: settingBool('showTagsInTitleBar'),
    footerWords: settingBool('footerWords'),
    footerCharacters: settingBool('footerCharacters'),
    footerNotes: settingBool('footerNotes'),
    footerFolders: settingBool('footerFolders'),
    // The open note's folder as a chip beside its tags. Only ever shows for a
    // note that actually sits in a subfolder.
    showFolderInTitleBar: settingBool('showFolderInTitleBar'),
    // How a note's subfolder shows in the list row: a coloured dot, the folder
    // name as a chip, or nothing.
    folderListDisplay: settingText('folderListDisplay'),
    // Whether that marker sits after the title or before it. The Inbox mark
    // always leads regardless — it's a different kind of signal.
    folderDotTrailing: settingBool('folderDotTrailing'),
    showDuePill: settingBool('showDuePill'),
    // Also read by the styler, straight from the config, for the same reason
    // the emoji map is: a widget is rebuilt on every restyle anyway.
    linkDomainPills: settingBool('linkDomainPills'),
    requireModifierForLinkClick: settingBool('requireModifierForLinkClick'),
    showBacklinks: settingBool('showBacklinks'),
    hideOnFocusLoss: settingBool('hideOnFocusLoss'),
    hyprlandBind: settingBool('hyprlandBind'),
    tiled: settingBool('tiled'),
    popoutTiled: settingBool('popoutTiled'),
    restoreFocusOnSummon: settingBool('restoreFocusOnSummon'),
    linkPreview: settingText('linkPreview'),
    listDensity: settingText('listDensity'),
    interfaceTextSize: settingNumber('interfaceTextSize'),
    fadeFocusHighlight: settingBool('fadeFocusHighlight'),
    showFooterClock: settingBool('showFooterClock'),
    showFooterClockDate: settingBool('showFooterClockDate'),
    showFooterClockOnlyWhenFullScreen: settingBool('showFooterClockOnlyWhenFullScreen'),
    footerClockDateFormat: settingText('footerClockDateFormat'),
    boldFileListText: settingBool('boldFileListText'),
    templateDateFormat: settingText('templateDateFormat'),
    // How often the whole Trash is swept into the system Trash — a count and a
    // unit. The schema clamps it to 1–99, so the trash always empties on some
    // schedule.
    trashEmptyIntervalValue: settingNumber('trashEmptyIntervalValue'),
    trashEmptyIntervalUnit: settingText('trashEmptyIntervalUnit'),
  }
}

let settings = readSettings()

/// Writes one setting to config.md. Nothing else in this file writes a
/// setting: a value that reaches the file by another route is a value the
/// panel, the shortcuts and the config check can disagree about.
function saveSetting(name: SettingName, value: string | boolean | number) {
  const [table, key] = SETTING_KEY[name]
  config.set(table, key, value)
}

// --- Sorting ----------------------------------------------------------------

type SortField = 'name' | 'date' | 'due'

/// The direction each field starts in when first selected — Notational
/// Velocity's convention (names A→Z, dates newest first). Due defaults
/// ascending so the most urgent note is at the top, the same reasoning as
/// names starting A→Z rather than Z→A.
const DEFAULT_ASCENDING: Record<SortField, boolean> = {
  name: true,
  date: false,
  due: true,
}

let sortField = settingText('sortField') as SortField
let sortAscending = settingBool('sortAscending')

/// One reused collator instead of `localeCompare(…, options)` per comparison:
/// the options form rebuilds collation state on every call, which is the bulk
/// of a name sort's cost across O(n log n) comparisons on a large vault. Same
/// ordering (`numeric` approximates localizedStandardCompare, so "Note 2"
/// sorts before "Note 10"), a fraction of the work.
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/// Applied after filtering, replacing relevance order entirely — same as the
/// Mac, where sortNotes runs on the already-filtered list.
function sortNotes(notes: NoteDto[]): NoteDto[] {
  const dir = sortAscending ? 1 : -1
  const sorted = [...notes]
  switch (sortField) {
    case 'name':
      sorted.sort((a, b) => dir * nameCollator.compare(a.title, b.title))
      break
    case 'date':
      sorted.sort((a, b) => dir * (a.modifiedMs - b.modifiedMs))
      break
    case 'due':
      // An undated note always sorts to the end, whichever direction is
      // chosen — "no due date" isn't smaller or larger than a date, it's
      // absent, and having undated notes bury dated ones (or the reverse)
      // depending on which arrow is clicked would be surprising either way.
      sorted.sort((a, b) => {
        if (!a.due && !b.due) return 0
        if (!a.due) return 1
        if (!b.due) return -1
        return dir * a.due.localeCompare(b.due)
      })
      break
  }
  return sorted
}

/// Brings `results` back into display order if anything invalidated it.
///
/// Only while the whole result set is in memory. Past one page the backend
/// owns the order — it is the only side that can see the rows this window
/// doesn't hold — and re-sorting the fragment here would splice a locally
/// ordered piece into a globally ordered list. Keeping the local path for the
/// small case is not just an optimisation: `Intl.Collator` is ICU root
/// collation and the Rust name sort is an approximation of it (see
/// `fold_char`), so a vault that fits in one page keeps exactly the order it
/// had before paging existed.
function reorderResults(): (NoteDto | undefined)[] {
  if (!orderDirty) return results
  orderDirty = false
  if (!fullyLoaded()) return results
  results = applyPinning(sortNotes(results as NoteDto[]))
  return results
}

function renderSortHeader() {
  const fields: Array<[SortField, string]> = [
    ['name', 'Name'],
    ...(settings.showDueSort ? ([['due', 'Due']] as Array<[SortField, string]>) : []),
    ...(settings.showDateModified ? ([['date', 'Date']] as Array<[SortField, string]>) : []),
  ]
  // Name takes the slack; Due and Date sit together over the one value column
  // they both control, since only the field being sorted on is displayed there.
  const sortGroup = document.createElement('div')
  sortGroup.className = 'sort-group'
  const buttons = fields.map(([field, label]) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'sort-button' + (sortField === field ? ' active' : '')
      b.dataset.field = field
      b.textContent = label
      if (sortField === field) {
        const arrow = document.createElement('span')
        arrow.className = 'sort-arrow'
        arrow.textContent = sortAscending ? '▲' : '▼'
        b.append(arrow)
      }
      b.onclick = () => {
        if (sortField === field) {
          sortAscending = !sortAscending
        } else {
          sortField = field
          sortAscending = DEFAULT_ASCENDING[field]
        }
        saveSetting('sortField', sortField)
        saveSetting('sortAscending', sortAscending)
        renderSortHeader()
        if (fullyLoaded()) {
          markOrderDirty()
          renderList()
          return
        }
        // Paged: the head of the new order is a different set of rows, so
        // nothing already fetched survives. The highlight keeps its index
        // rather than its note, which is what the local re-sort did too.
        void refetchList(null)
      }
      return b
  })
  const name = buttons.find((b) => b.dataset.field === 'name')!
  sortGroup.append(...buttons.filter((b) => b !== name))
  listHeaderEl.replaceChildren(name, sortGroup)
}

/// A lone digit padded to two places with a figure space (U+2007, one digit
/// wide in tabular and monospace fonts). The column is right-aligned, so
/// without it "Yesterday, 9:50 PM" sits one digit further right than
/// "Yesterday, 10:41 PM" and the day names zigzag down the list.
const padLoneDigit = (text: string) => text.replace(/(^|[\s,])(\d)(?=[:,\s]|$)/g, '$1\u2007$2')
const shortTime = (d: Date) =>
  padLoneDigit(d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
const abbrevDate = (d: Date) =>
  padLoneDigit(d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))

/// The four date styles, matching the Mac's picker exactly.
///
/// "Smart" names the day only while that's still useful — today and yesterday
/// carry a time, because for a note touched in the last two days *when* is the
/// interesting part; anything older is just a date.
function formatModified(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(d)) / 86400000)

  switch (settings.dateDisplayStyle) {
    case 'relative': {
      if (days === 0) return 'today'
      if (days === 1) return 'yesterday'
      if (days < 7) return `${days} days ago`
      if (days < 30) return `${Math.floor(days / 7)} week${days < 14 ? '' : 's'} ago`
      if (days < 365) return `${Math.floor(days / 30)} month${days < 60 ? '' : 's'} ago`
      return `${Math.floor(days / 365)} year${days < 730 ? '' : 's'} ago`
    }
    case 'dateTime':
      return `${abbrevDate(d)}, ${shortTime(d)}`
    case 'dateOnly':
      return abbrevDate(d)
    default:
      if (days === 0) return `Today, ${shortTime(d)}`
      if (days === 1) return `Yesterday, ${shortTime(d)}`
      return abbrevDate(d)
  }
}

/// A due date's own formatting, distinct from `formatModified` because a due
/// date is a calendar day with no meaningful time — every `@…` token resolves
/// to local midnight — so a clock time beside one is never right.
///
/// Today/Tomorrow/Yesterday and the coming week's day names are the same under
/// every style; only what happens beyond that differs, and only for "relative".
/// This mirrors the Mac's `DateDisplayStyle.formatDueDate`.
function formatDue(iso: string, style: string): string {
  const d = new Date(iso + 'T00:00:00')
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((d.getTime() - today.getTime()) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  // Weekday names for the coming week, as the Mac does.
  if (days > 1 && days < 7) {
    return d.toLocaleDateString(undefined, { weekday: 'long' })
  }
  if (style === 'relative') return relativeDay(days)
  return abbrevDate(d)
}

/// Named relative wording for a whole number of days either side of today,
/// matching the buckets `formatModified` uses for the past — but a due date can
/// also be in the future, which a modified date never is.
function relativeDay(days: number): string {
  const n = Math.abs(days)
  const label =
    n < 7
      ? `${n} days`
      : n < 30
        ? `${Math.floor(n / 7)} week${n < 14 ? '' : 's'}`
        : n < 365
          ? `${Math.floor(n / 30)} month${n < 60 ? '' : 's'}`
          : `${Math.floor(n / 365)} year${n < 730 ? '' : 's'}`
  return days < 0 ? `${label} ago` : `in ${label}`
}

// --- List virtualization ----------------------------------------------------
// The Mac's list is a `LazyVStack` inside a `ScrollView`: SwiftUI only ever
// materialises the rows actually on screen, so an Index of 5,000 notes costs
// the same to display as one of 50. Building a DOM node per result — which is
// what this did — made every keystroke pay for the whole Index instead, since
// each search re-renders the list.
//
// Same idea reproduced here. One spacer element carries the full scroll height
// so the scrollbar stays honest, and only the rows inside the viewport exist as
// elements, positioned absolutely at their true offsets. The overscan renders a
// few rows past each edge so a fast scroll doesn't flash empty space before the
// next frame lands.

const listSizer = document.createElement('div')
listSizer.id = 'list-sizer'

/// Rows are uniform in height — every field in one is `nowrap`, so nothing
/// reflows onto a second line — but the exact height depends on the row
/// padding, the UI scale and whether previews are switched on. Rather than
/// track all three settings, it's measured from a real rendered row and
/// corrected whenever it turns out to have changed.
let rowHeight = 24
// Whether `rowHeight` has to be measured again. Rows are content-sized and
// baseline-aligned, so an emoji, CJK text or a folder dot can make one row a
// pixel taller than its neighbours — measuring "the first row in the window"
// on every render made the assumed height flip as the window moved, and
// every flip repositioned every row: a visible jolt on each arrow press that
// happened to land on such a row. Height depends on font, density and text
// size only, so it is measured once and again only when one of those changes.
let rowHeightDirty = true
function markRowHeightDirty() {
  rowHeightDirty = true
}
const ROW_OVERSCAN = 12

/// The window currently in the DOM, so scrolling can skip the rebuild whenever
/// the same rows are still the right ones.
let renderedFrom = -1
let renderedTo = -1

/// The list is `overflow: hidden` while the pane is collapsed, and measures
/// zero before first layout. Falling back to a plausible height keeps the
/// first render from producing an empty list that only fills in on scroll.
function listViewport(): number {
  return listEl.clientHeight || 600
}

/// Decoded once per render rather than per row. It is a JSON parse, and the
/// list is the hottest thing in the app — the same reason the Mac caches its
/// folder colours instead of decoding inside the row body.
let folderColorCache: Record<string, string> = {}

/// How many of the leading rows are lifted into the sticky strip — the run of
/// pinned notes at the top of `results`, capped at three so the strip can
/// never grow to swallow the list. Zero when the setting is off. `results`
/// itself is untouched: the strip shows rows 0..n and the scrolling list shows
/// the rest, so `highlighted` keeps indexing one array either way. Reading
/// only the leading run keeps this O(pins), not a walk of the whole list.
let stickyCount = 0
const STICKY_PIN_LIMIT = 3

function computeStickyCount(): number {
  if (!settings.keepPinnedNotesVisible) return 0
  let n = 0
  // Page 0 is always loaded and the pins always head it, so this never reads a
  // row that hasn't arrived — but it asks rather than assumes.
  while (n < STICKY_PIN_LIMIT && n < results.length) {
    const id = results[n]?.id
    if (!id || !pinnedIds.has(id)) break
    n++
  }
  return n
}

/// Whether the strip is at capacity — a fourth pin, with the strip on, would
/// just fall back to the old scroll-away behaviour and muddy the model, so it
/// is refused. Unlimited with the strip off. Mirrors the Mac's pinLimitReached.
function pinLimitReached(): boolean {
  return settings.keepPinnedNotesVisible && pinnedIds.size >= STICKY_PIN_LIMIT
}

/// Every browse mode replaces the list wholesale and shows no pins, so the
/// strip collapses away there — the same as the Mac's empty stickyPinnedNotes.
function hidePinnedStrip() {
  pinnedStripEl.classList.add('hidden')
  pinnedStripEl.replaceChildren()
}

/// Sizes the trailing date column to the widest label the list is actually
/// showing — every loaded row's date, or the trash/template list's labels —
/// rather than to the widest label the date style *could* produce. Sized to
/// "Yesterday, 12:46 PM" while every row read "Today, 2:11 PM", the column
/// left a band of nothing between the titles' ellipsis and the dates. Now a
/// list of today's notes gets a tight column, and a longer label widens it
/// the moment such a row is loaded.
///
/// Each label costs a synchronous layout to measure, so labels are deduped
/// (a Kindle import gives hundreds of rows the same minute) and measured
/// only when the set of labels, the face, the interface scale, the bold-rows
/// flag, the date style or the calendar day changes. `force` is for the
/// `document.fonts.ready` callers: a web font can land without any of these
/// changing and shifts every metric when it does.
let dateColKey: string | null = null

function dateColumnKey(labels: string[]): string {
  const root = document.documentElement.style
  return [
    root.getPropertyValue('--envy-font-family'),
    root.getPropertyValue('--envy-font-size'),
    root.getPropertyValue('--envy-ui-scale'),
    document.body.classList.contains('bold-file-list') ? 'b' : '',
    settings.dateDisplayStyle,
    new Date().getDate(),
    labels.join('\u0001'),
  ].join('|')
}

/// The text a row's date slot shows — one function, used both to build the
/// row and to size the column, so the two can never disagree.
function rowDateLabel(note: NoteDto): string {
  if (sortField === 'due') {
    // Left blank when this note has no due date, rather than quietly falling
    // back to the modified date — a sorted column leaves a row's cell empty
    // rather than substituting an unrelated value.
    if (!note.due) return ''
    const suffix = note.dueCount > 1 ? ` +${note.dueCount - 1}` : ''
    return formatDue(note.due, settings.dateDisplayStyle) + suffix
  }
  return formatModified(note.modifiedMs)
}

/// Every distinct label the list on screen puts in the date slot.
function currentDateLabels(): string[] {
  const labels = new Set<string>()
  if (templateFragment() !== null) {
    labels.add('Template')
  } else if (trashFragment() !== null) {
    for (const n of trashResults) labels.add(formatModified(n.modifiedMs))
  } else {
    for (const n of results) if (n) labels.add(rowDateLabel(n))
  }
  labels.delete('')
  return [...labels].sort()
}

function syncDateColumnWidth(force = false) {
  if (!listPaneEl.classList.contains('has-date')) {
    dateColKey = null
    listPaneEl.style.removeProperty('--envy-date-col')
    return
  }
  const labels = currentDateLabels()
  const key = dateColumnKey(labels)
  if (!force && key === dateColKey) return
  dateColKey = key
  const probe = document.createElement('span')
  probe.className = 'row-date'
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;left:0;top:0;width:auto;max-width:none;overflow:visible;white-space:nowrap;'
  listPaneEl.append(probe)
  let max = 0
  for (const s of labels) {
    probe.textContent = s
    max = Math.max(max, probe.getBoundingClientRect().width)
  }
  probe.remove()
  // Never narrower than the sort headings that live in the same column, or
  // an empty list would fold "Due Date" over itself.
  const headings = document.querySelector<HTMLElement>('.sort-group')
  if (headings) max = Math.max(max, headings.scrollWidth)
  listPaneEl.style.setProperty('--envy-date-col', `${Math.ceil(max)}px`)
}

function renderList() {
  folderColorCache = folderColors()
  reorderResults()
  // Whether the trailing value column is reserved at all. There is only one —
  // it shows whichever date the list is sorted by — and "Show date modified"
  // governs it entirely, so with that off the titles get the full width.
  listPaneEl.classList.toggle('has-date', settings.showDateModified)
  syncDateColumnWidth()
  stickyCount = computeStickyCount()
  if (stickyCount === 0) {
    hidePinnedStrip()
  } else {
    pinnedStripEl.replaceChildren(
      ...(results.slice(0, stickyCount) as NoteDto[]).map((n, i) => buildRow(n, i)),
    )
    pinnedStripEl.classList.remove('hidden')
  }
  // trash: and template: replace the list's children wholesale, so the spacer
  // has to be put back rather than assumed to still be there.
  if (listSizer.parentElement !== listEl) listEl.replaceChildren(listSizer)
  listSizer.style.height = `${(results.length - stickyCount) * rowHeight}px`
  scrollHighlightIntoView()
  renderRowWindow(true)
}

/// Mirrors the Mac's `.onChange(of: selectedID) { proxy.scrollTo(...) }` —
/// it scrolls when the selection *changes*, not on every re-render, so
/// toggling a setting doesn't yank the list back to the selected row.
///
/// Necessary here in a way it wasn't before: with only the visible rows in the
/// DOM, arrow-keying to an off-screen row would otherwise select something that
/// doesn't exist on screen and never scroll to it.
let lastScrolledId: string | null = null
function scrollHighlightIntoView() {
  if (highlighted < 0 || highlighted >= results.length) {
    lastScrolledId = null
    return
  }
  // Keyed by the note where the row is loaded and by index where it isn't: a
  // row whose page hasn't arrived still has a position to scroll to, and
  // returning early on it would leave the highlight off screen until the page
  // landed.
  const id = results[highlighted]?.id ?? `#${highlighted}`
  if (id === lastScrolledId) return
  lastScrolledId = id
  // A row in the sticky strip is always on screen; nothing to scroll to.
  if (highlighted < stickyCount) return
  const top = (highlighted - stickyCount) * rowHeight
  const viewport = listViewport()
  // Judged against where the scroller is heading, not where the animation
  // has got to: with a key held, the last target is a row or two ahead of the
  // painted position, and measuring the painted one would order a fresh
  // scroll every press even when the row is already on its way into view.
  const heading = scrollTarget(listEl)
  // Kept a few rows in from the edge, vim's scrolloff: the glide trails its
  // target by a row or two while a key is held, and a highlight aligned to the
  // very edge would spend that time just out of sight.
  const margin = Math.min(3, Math.floor(viewport / rowHeight / 3)) * rowHeight
  if (top < heading + margin) {
    smoothScrollTo(listEl, top - margin)
  } else if (top + rowHeight > heading + viewport - margin) {
    smoothScrollTo(listEl, top + rowHeight - viewport + margin)
  }
}

/// Applies the `overflows` fade to every title that doesn't fit, in one pass
/// per render. Reads every title's overflow first, then writes every class
/// toggle, so the layout-forcing measurements don't interleave with the writes
/// into a reflow per row (the old per-row rAF did exactly that). Coalesced to
/// one frame — a rebuild that recurses to correct row height only measures once.
/// Covers both the scrolling window and the pinned strip, since both hold rows.
let overflowFrame = 0
function scheduleOverflowMeasure() {
  if (overflowFrame) return
  overflowFrame = requestAnimationFrame(() => {
    overflowFrame = 0
    const texts = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#list-sizer .row-title-text, #pinned-strip .row-title-text',
      ),
    )
    const overflowing = texts.map((el) => titleOverflow(el) > 0)
    texts.forEach((el, i) => el.classList.toggle('overflows', overflowing[i]))
  })
}

/// A row whose page hasn't arrived yet: the right height and nothing else.
/// Deliberately not a guess at the note — showing the wrong title for a beat
/// is worse than showing none, and a list that flickers through other people's
/// notes as you scroll is exactly the bug virtualization is supposed to avoid.
/// The zero-width space is what gives it a line's height without painting.
function buildBlankRow(): HTMLElement {
  const row = document.createElement('div')
  row.className = 'row row-pending'
  row.setAttribute('role', 'option')
  row.setAttribute('aria-selected', 'false')
  const title = document.createElement('div')
  title.className = 'row-title'
  const text = document.createElement('span')
  text.className = 'row-title-text'
  text.textContent = '\u200B'
  title.append(text)
  const main = document.createElement('div')
  main.className = 'row-main'
  main.append(title)
  row.append(main)
  return row
}

/// Which way the last window moved, so the prefetch goes ahead of the scroll
/// rather than behind it.
let lastWindowScrollTop = 0

function renderRowWindow(force = false) {
  const viewport = listViewport()
  // Offsets are in *scrolling* rows — the results minus the ones lifted into
  // the strip — so the window and each row's top are shifted by stickyCount.
  const from =
    stickyCount + Math.max(0, Math.floor(listEl.scrollTop / rowHeight) - ROW_OVERSCAN)
  const to = Math.min(
    results.length,
    stickyCount + Math.ceil((listEl.scrollTop + viewport) / rowHeight) + ROW_OVERSCAN,
  )
  // Fetch what the window needs, plus one page beyond it in the direction of
  // travel — so a scroll that keeps going finds the next page already there
  // rather than blank rows while it arrives.
  const goingDown = listEl.scrollTop >= lastWindowScrollTop
  lastWindowScrollTop = listEl.scrollTop
  void loadRange(goingDown ? from : from - PAGE_SIZE, goingDown ? to + PAGE_SIZE : to)

  if (!force && from === renderedFrom && to === renderedTo) return
  renderedFrom = from
  renderedTo = to

  const rows: HTMLElement[] = []
  for (let i = from; i < to; i++) {
    const note = results[i]
    const row = note ? buildRow(note, i) : buildBlankRow()
    row.style.top = `${(i - stickyCount) * rowHeight}px`
    rows.push(row)
  }
  listSizer.replaceChildren(...rows)
  // One batched overflow pass for the new window (coalesced with the pinned
  // strip's, and with the height-correction re-render below).
  scheduleOverflowMeasure()

  // Correct the assumed row height from a real row — but ONLY on a forced
  // (content) render, never on a scroll render. The height depends on the font
  // and density, not on how far the list is scrolled, so re-measuring while
  // scrolling was pointless. Worse, `rows[0]` is a different note at every
  // scroll offset, and re-measuring it re-entrantly could land two notes of
  // slightly different heights in alternation — `rowHeight` would oscillate and
  // this function recursed forever, freezing the app. Measuring only on force,
  // and re-rendering the corrected window with force off, makes it settle in one
  // step and never loop. Measured fractionally (not `offsetHeight`, which rounds)
  // so rows don't drift a fraction of a pixel apart down a long list.
  // A blank row is not a fair sample — it carries no date and no preview — so
  // the measurement takes the first row that is actually a note.
  if (force && rowHeightDirty) {
    // Natural heights, then the tallest note row in the window: every row is
    // then given exactly that height, so none is clipped and none overlaps.
    listPaneEl.style.removeProperty('--envy-row-height')
    let measured = 0
    rows.forEach((row, k) => {
      if (results[from + k] !== undefined) measured = Math.max(measured, row.getBoundingClientRect().height)
    })
    if (measured > 0) {
      rowHeightDirty = false
      listPaneEl.style.setProperty('--envy-row-height', `${measured}px`)
      if (Math.abs(measured - rowHeight) > 0.5) {
        rowHeight = measured
        listSizer.style.height = `${(results.length - stickyCount) * rowHeight}px`
        renderedFrom = -1
        renderedTo = -1
        renderRowWindow(false)
      }
    }
  }
}

// Coalesce scroll events to one window rebuild per frame. On a large list a
// momentum scroll fires scroll events faster than a rebuild (and its per-row
// measurement) can run; doing the work synchronously per event let the
// layer-promoted scroller outrun it and paint blank rows. A rAF gate runs the
// rebuild at most once per frame, always reading the latest scrollTop when it
// fires, so the window still lands on the final position without falling behind.
let scrollFrame = 0
listEl.addEventListener(
  'scroll',
  () => {
    if (scrollFrame) return
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0
      renderRowWindow()
    })
  },
  { passive: true },
)

/// A list row's folder marker, per the folderListDisplay setting: a coloured
/// dot ('dot', only when the folder has a colour), the folder name as a tinted
/// chip ('name', for any subfolder), or nothing ('off'). Clicking it pivots to
/// that folder's notes and right-clicking recolours it — the same gestures the
/// title-bar chip offers. Returns null when there's nothing to draw. The click
/// stops propagating so it never doubles as opening the row's note.
function buildFolderIndicator(subfolder: string): HTMLElement | null {
  const mode = settings.folderListDisplay
  if (mode === 'off') return null
  const color = folderColorCache[subfolder]
  let el: HTMLElement
  if (mode === 'name') {
    el = document.createElement('span')
    el.className = 'folder-name-chip'
    el.textContent = subfolder
    if (color) {
      el.style.color = color
      el.style.background = `color-mix(in srgb, ${color} 15%, transparent)`
    }
  } else {
    // 'dot': the dot alone means "in a coloured folder", so an uncoloured
    // folder shows nothing rather than a blank circle.
    if (!color) return null
    el = document.createElement('span')
    el.className = 'folder-dot row-folder-dot'
    el.style.background = color
  }
  el.title = `In ${subfolder} — click to see this folder's notes`
  el.onclick = (e) => {
    e.stopPropagation()
    searchByFolder(subfolder)
  }
  el.oncontextmenu = (e) => {
    e.preventDefault()
    e.stopPropagation()
    openContextMenu(e.clientX, e.clientY, folderColorMenu(subfolder))
  }
  return el
}

/// Speed and delay of the hover reveal, the Mac's `HuggingScrollingText`:
/// linear at 40pt/s after a 0.2s pause, so a title of any length reads at the
/// same pace rather than a long one flying past.
const TITLE_SCROLL_PX_PER_S = 40
const TITLE_SCROLL_DELAY_MS = 200

/// How many pixels of a title are hidden, or 0 when it fits. `scrollWidth` is
/// rounded up and `clientWidth` rounded down, so a title whose real width is
/// fractional reads as overflowing by a pixel even though every character is
/// visible — and the trailing fade then ate its last letters on every other
/// row. Measure against the unrounded box instead.
function titleOverflow(el: HTMLElement): number {
  // The text's own box, measured with a Range so it is sub-pixel exact; the
  // element's box likewise. `scrollWidth` would round the text up and still
  // flag some titles that fit by a hair.
  const range = document.createRange()
  range.selectNodeContents(el)
  const overflow = range.getBoundingClientRect().width - el.getBoundingClientRect().width
  return overflow > 0.5 ? overflow : 0
}

/// Scrolls a list title on hover to reveal the rest, resetting on leave.
///
/// The `overflows` fade for a title that doesn't fit is applied separately, in
/// one batched pass per render (`scheduleOverflowMeasure`) rather than a frame
/// per row — measuring each title forces layout, and doing that per row
/// reflowed the whole list while it was already rebuilding on scroll. The hover
/// handler still measures its own one title, which is not a hot path.
function hoverScrollTitle(titleText: HTMLElement) {
  let frame: number | undefined
  titleText.addEventListener('mouseenter', () => {
    const overflow = titleOverflow(titleText)
    if (overflow <= 0) return
    // A hair past the exact overflow, so the last character clears the clipped
    // edge rather than stopping flush against it.
    const distance = overflow + 2
    titleText.classList.add('scrolling')
    const started = performance.now()
    const step = (now: number) => {
      const elapsed = now - started - TITLE_SCROLL_DELAY_MS
      const travelled = Math.max(0, (elapsed / 1000) * TITLE_SCROLL_PX_PER_S)
      titleText.scrollLeft = Math.min(distance, travelled)
      if (travelled < distance) frame = requestAnimationFrame(step)
      else frame = undefined
    }
    frame = requestAnimationFrame(step)
  })
  titleText.addEventListener('mouseleave', () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    titleText.classList.remove('scrolling')
    titleText.scrollLeft = 0
  })
}

function buildRow(note: NoteDto, i: number): HTMLElement {
      const row = document.createElement('div')
      // The primary selection is marked differently from the rest: it's the
      // one the editor is showing, and losing track of which that is makes a
      // multi-selection feel arbitrary.
      const selected = isSelected(note)
      row.className =
        'row' + (i === highlighted ? ' highlighted' : selected ? ' multi-selected' : '')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(selected))
      row.dataset.index = String(i)

      const title = document.createElement('div')
      title.className = 'row-title'
      // The title text lives in its own span so it, and only it, ellipsizes —
      // the folder/inbox/pin markers around it stay whole and centred.
      const titleText = document.createElement('span')
      titleText.className = 'row-title-text'
      titleText.textContent = note.title
      title.append(titleText)
      hoverScrollTitle(titleText)

      // A fleeting note is marked with an amber dot, always leading — "unfiled"
      // outranks a folder category, and the two never stack. A filed note in a
      // subfolder instead gets its folder marker, on whichever side the setting
      // chooses (trailing by default; the Inbox mark is unaffected).
      if (note.isInbox) {
        const dot = document.createElement('span')
        dot.className = 'inbox-dot'
        dot.title = 'Fleeting note'
        title.prepend(dot)
      } else if (note.subfolder) {
        const indicator = buildFolderIndicator(note.subfolder)
        if (indicator) {
          indicator.classList.add(settings.folderDotTrailing ? 'marker-trailing' : 'marker-leading')
          if (settings.folderDotTrailing) title.append(indicator)
          else title.prepend(indicator)
        }
      }
      if (note.id === trayPinnedId) {
        const pin = document.createElement('span')
        pin.className = 'pin-mark'
        pin.textContent = '📍'
        pin.title = 'Pinned to the tray — clicking the tray icon opens this'
        title.prepend(pin)
      } else if (pinnedIds.has(note.id)) {
        const pin = document.createElement('span')
        pin.className = 'pin-mark'
        pin.textContent = '📌'
        pin.title = 'Pinned to the top of the list'
        title.prepend(pin)
      }
      // The ⎈ AI-provenance mark is deliberately not shown — the Mac hides its
      // own "until the feature is designed" (NoteRow.swift). The core still
      // parses `aiProvenance`, so the badge can be restored later without
      // touching the scanner.

      // Title and preview sit together on one line, the preview following the
      // title rather than wrapping under it — the Mac's row is a single HStack.
      const main = document.createElement('div')
      main.className = 'row-main'
      main.append(title)

      // Empty previews are skipped rather than rendered blank, matching the
      // Mac's `showPreview && !note.preview.isEmpty`.
      if (settings.showNotePreview && note.preview) {
        const meta = document.createElement('span')
        meta.className = 'row-meta'
        meta.textContent = note.preview
        main.append(meta)
      }

      row.append(main)

      // One trailing slot, not two. It shows whichever date the list is sorted
      // by — a traditional sortable list shows the column you sorted on, the
      // way Finder's Date Modified column doesn't stick around once you sort by
      // Date Created instead. Only sorting by Due actually changes it; Name
      // falls back to the modified date.
      //
      // showDateModified defaults to true on the Mac and showNotePreview to
      // false, so the default row is title and date. Preview is opt-in, and
      // joins that same line rather than adding a second one.
      if (settings.showDateModified) {
        const date = document.createElement('span')
        date.className = 'row-date'
        date.textContent = rowDateLabel(note)
        // Urgency colour belongs to a due date, not to a timestamp, so it
        // only applies while the slot is actually showing one.
        if (sortField === 'due' && note.due) {
          date.classList.add(`envy-due-${dueUrgencyClass(note.due)}`)
        }
        row.append(date)
      }

      row.onclick = (e) => {
        if (e.shiftKey) {
          void selectRange(i).then(() => {
            renderList()
            void openHighlighted(false)
          })
        } else if (e.ctrlKey) {
          toggleMultiSelect(i)
          renderList()
        } else {
          selectSingle(i)
          void openHighlighted()
        }
      }
      row.oncontextmenu = (e) => {
        e.preventDefault()
        const selection = fullSelection()
        // Right-clicking inside an existing multi-selection acts on the whole
        // of it; anywhere else it collapses to that one note first, so the
        // menu and the list never disagree about what's about to happen.
        if (selection.length > 1 && selection.includes(note.id)) {
          openContextMenu(e.clientX, e.clientY, bulkMenuItems(selection.length))
          return
        }
        selectSingle(i)
        renderList()
        openContextMenu(e.clientX, e.clientY, noteMenuItems(note))
      }
      return row
}

/// Briefly highlights text that changed on disk, so an external edit is
/// noticed without having to spot the diff yourself.
///
/// The fade is a CSS transition rather than stepped in JS — the Mac steps the
/// alpha by hand only because text attributes aren't animatable properties.
/// Here they are.
let flashTimer: number | undefined
function flashChangedRange(range: { from: number; to: number } | null) {
  window.clearTimeout(flashTimer)
  if (!range) return
  view.dispatch({ effects: setFlash.of(range) })
  flashTimer = window.setTimeout(() => {
    flashTimer = undefined
    view.dispatch({ effects: setFlash.of(null) })
  }, 900)
}

/// Centres the window on whichever monitor it's currently on.
async function centreWindow() {
  try {
    await getCurrentWindow().center()
  } catch (err) {
    console.error('could not centre the window', err)
  }
}

// --- Link preview ------------------------------------------------------------
// Alt-click a [[link]] to read the note without leaving where you are.
//
// Deliberately a modifier-click rather than hover, following the Mac: a popover
// that appears from a passing hover can sit exactly where a Ctrl-click was
// aimed, and the two gestures collide. Alt has no competing meaning here.

const linkPreviewEl = document.getElementById('link-preview')!
const linkPreviewBodyEl = document.getElementById('link-preview-body')!

/// The preview's own editor, torn down each time it closes.
///
/// Not a persistent one reused across previews: it holds a note id and a
/// pending save, and carrying either into a preview of a *different* note is
/// how one note's edit lands in another's file.
let previewEditor: MiniNoteEditor | null = null
/// The note on show, for the pin — null while previewing a link to nowhere.
let previewNoteId: string | null = null
const linkPreviewTitleTextEl = document.getElementById('link-preview-title-text')!
const linkPreviewPinEl = document.getElementById('link-preview-pin') as HTMLButtonElement

function hideLinkPreview() {
  linkPreviewEl.classList.add('hidden')
  const editor = previewEditor
  previewEditor = null
  previewNoteId = null
  if (editor) {
    void editor.flush().finally(() => editor.destroy())
  }
}

/// The last size a pop-out was dragged to, written by the pop-out window into
/// the shared origin's localStorage. Passed along so the next one opens the
/// same size; Rust falls back to its own default when it's absent or corrupt.
function storedPopoutSize(): [number, number] | undefined {
  try {
    const parsed = JSON.parse(localStorage.getItem('popoutSize') ?? 'null')
    if (parsed && Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) {
      return [parsed.width, parsed.height]
    }
  } catch {
    // A malformed value is the same as none.
  }
  return undefined
}

// Pin detaches the peek into its own floating window that stays open and frees
// the peek slot, so several can sit open at once — the Mac's pinned peek, which
// is the same panel its Pop Out opens. The peek's pending edit is flushed first
// so the float reads the note as it stands.
linkPreviewPinEl.onclick = async () => {
  const id = previewNoteId
  if (!id) return
  await previewEditor?.flush()
  hideLinkPreview()
  try {
    await invoke('pop_out_note', { id, innerSize: storedPopoutSize() })
  } catch (e) {
    console.error('could not pin the peek as a floating window', e)
  }
}

/// Alt+Shift-click: straight to a floating window, the same one the peek's
/// pin makes. A link to a note that doesn't exist yet has nothing to float,
/// so that case falls back to the peek and its "doesn't exist" message.
async function popOutLink(target: string, x: number, y: number) {
  const note = await invoke<NoteDto | null>('resolve_title', { title: target })
  if (!note) {
    void showLinkPreview(target, x, y)
    return
  }
  hideLinkPreview()
  try {
    await invoke('pop_out_note', { id: note.id, innerSize: storedPopoutSize() })
  } catch (e) {
    console.error('could not pop the link out', e)
  }
}

// The peek drags by its title bar. It opens where the pointer was, which is
// often over the very text someone wants to keep reading, so being able to
// shove it aside is what keeps it from having to be dismissed and reopened.
const linkPreviewTitleEl = document.getElementById('link-preview-title')!
linkPreviewTitleEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
  const startX = e.clientX - linkPreviewEl.offsetLeft
  const startY = e.clientY - linkPreviewEl.offsetTop
  linkPreviewTitleEl.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => {
    const { width, height } = linkPreviewEl.getBoundingClientRect()
    const left = Math.min(Math.max(0, ev.clientX - startX), window.innerWidth - width)
    const top = Math.min(Math.max(0, ev.clientY - startY), window.innerHeight - height)
    linkPreviewEl.style.left = `${left}px`
    linkPreviewEl.style.top = `${top}px`
  }
  const up = () => {
    linkPreviewTitleEl.removeEventListener('pointermove', move)
    linkPreviewTitleEl.removeEventListener('pointerup', up)
    linkPreviewTitleEl.removeEventListener('pointercancel', up)
  }
  linkPreviewTitleEl.addEventListener('pointermove', move)
  linkPreviewTitleEl.addEventListener('pointerup', up)
  linkPreviewTitleEl.addEventListener('pointercancel', up)
  e.preventDefault()
})

async function showLinkPreview(target: string, x: number, y: number) {
  hideLinkPreview()
  const note = await invoke<NoteDto | null>('resolve_title', { title: target })
  linkPreviewTitleTextEl.textContent = note ? note.title : target
  previewNoteId = note?.id ?? null
  // No pin for a note that doesn't exist yet: there is nothing to float.
  linkPreviewPinEl.hidden = !note
  linkPreviewBodyEl.replaceChildren()

  if (note && note.content !== null) {
    // A live editor rather than rendered text: the same code path the embeds
    // use, so a previewed note styles and behaves exactly as it does in the
    // main editor, and can be corrected on the spot without opening it.
    previewEditor = createMiniNoteEditor(
      linkPreviewBodyEl,
      { id: note.id, title: note.title, content: note.content },
      async (id, content) => {
        await invoke('save_note', { id, content })
        await runSearch()
      },
    )
  } else {
    const msg = document.createElement('div')
    msg.className = 'link-preview-message'
    msg.textContent = "This note doesn't exist yet. Ctrl-click the link to create it."
    linkPreviewBodyEl.append(msg)
  }
  linkPreviewEl.classList.remove('hidden')

  // Placed after it has a size, and flipped rather than allowed off-screen.
  const { width, height } = linkPreviewEl.getBoundingClientRect()
  const left = x + width > window.innerWidth ? Math.max(8, x - width) : x
  const top = y + height > window.innerHeight ? Math.max(8, y - height) : y + 18
  linkPreviewEl.style.left = `${left}px`
  linkPreviewEl.style.top = `${top}px`
}

window.addEventListener('mousedown', (e) => {
  if (!linkPreviewEl.contains(e.target as Node)) hideLinkPreview()
}, true)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideLinkPreview()
})

// --- Zoom and plain-text mode -----------------------------------------------

/// Editor text size, independent of the interface. Notes are what you read for
/// hours; the chrome isn't.
let editorZoom = settingNumber('editorZoom')

function applyZoom() {
  applyEditorZoom(editorZoom)
  measurePanes()
  // The list reads the same font size, so its row height and date column
  // are stale the moment the zoom moves — the same re-measure a font change
  // gets, or rows drift apart from their slots at larger sizes.
  markRowHeightDirty()
  syncDateColumnWidth(true)
  renderRowWindow(true)
}

function setZoom(next: number) {
  // Clamped so a stuck key can't leave the editor unreadably small or absurdly
  // large with no obvious way back short of clearing storage.
  // Rounded so ten presses of Ctrl+= write 2 to the config file, not
  // 1.9999999999999998.
  editorZoom = Math.round(Math.min(2.5, Math.max(0.6, next)) * 100) / 100
  saveSetting('editorZoom', editorZoom)
  applyZoom()
}

/// Plain-text mode shows the raw markdown instead of styling it — for when you
/// want to see exactly what's in the file rather than what it means.
let plainTextMode = settingBool('plainText')

/// Applying is separate from persisting, so that re-applying the config after
/// the file changed cannot write the value straight back out again.
function setPlainTextMode(on: boolean) {
  plainTextMode = on
  saveSetting('plainText', on)
  applyPlainTextMode()
}

function applyPlainTextMode() {
  // Nothing else to change: the styler simply stops emitting decorations, so
  // the text, cursor and scroll position all stay exactly where they were.
  for (const p of panes) p.view.dispatch({ effects: setPlainText.of(plainTextMode) })
}

// --- Inbox ------------------------------------------------------------------
// Fleeting notes wait in Inbox/. The badge is what lets the inbox be a filter
// rather than a mode: the notes stay out of the way, but the number doesn't,
// so a backlog can't quietly accumulate unseen.

const inboxBadgeEl = document.getElementById('inbox-badge') as HTMLButtonElement
const fleetingActionsEl = document.getElementById('fleeting-actions')!

async function refreshInboxBadge() {
  // No inbox, no count — the store reports zero while it's off anyway, but
  // there's no reason to ask.
  if (!settings.inboxEnabled) {
    inboxBadgeEl.classList.add('hidden')
    return
  }
  const count = await invoke<number>('inbox_count')
  // Strictly "something is waiting". With the inbox empty there is nowhere to
  // go back *from*, and clearing the query is the ordinary way out of any
  // query — so at zero the control disappears rather than sitting at "0".
  if (count === 0) {
    inboxBadgeEl.classList.add('hidden')
    return
  }
  inboxBadgeEl.classList.remove('hidden')
  const inInbox = inboxFragment() !== null
  // The same control in two states rather than two controls: in the inbox
  // it's the way out, everywhere else it's the way in. One position, one
  // shape, and the button that got you somewhere brings you back.
  inboxBadgeEl.textContent = inInbox ? '‹' : String(count)
  inboxBadgeEl.classList.toggle('leaving', inInbox)
  inboxBadgeEl.title = inInbox
    ? 'Back out of the Inbox'
    : `${count} fleeting note${count === 1 ? '' : 's'} waiting — click to review`
}

inboxBadgeEl.onclick = () => {
  searchInput.value = inboxFragment() !== null ? '' : 'inbox:'
  searchInput.focus()
  void runSearch()
}

/// The next fleeting note waiting, excluding the one being acted on — so
/// working through a backlog is a run of decisions rather than a series of
/// round trips back to the list.
/// Only the rows actually in memory are searched. Past one page that means
/// the backlog has to have a fleeting note among the loaded rows for the
/// advance to happen — which it does whenever the list is the inbox itself,
/// the only mode this is reachable from — and otherwise the editor simply
/// closes, which is what it already did when the backlog ran out.
function nextFleetingAfter(id: string): NoteDto | null {
  return results.find((n) => n?.isInbox && n.id !== id) ?? null
}

async function moveToNextFleeting(actedOnId: string) {
  const next = nextFleetingAfter(actedOnId)
  await runSearch()
  const at = next ? await indexOfNote(next.id) : -1
  if (next && at >= 0) {
    await openNote(next.id)
    highlighted = at
    await ensureLoaded(highlighted)
    renderList()
  } else {
    closeEditor()
  }
}

/// Files the open fleeting note — into The Index root, or straight into a
/// folder. The note is resolved at click time, never captured by the menu:
/// a submit auto-advances to the next capture, and a captured id would file
/// the note that just left rather than the one on screen (the Mac's 1.8.6
/// bug). Either way the same advance-to-the-next-capture flow follows.
async function submitFleeting(subfolder: string | null) {
  if (!activePane.noteId) return
  const id = activePane.noteId
  cancelPendingSave()
  await save()
  let filed: NoteDto
  try {
    filed = await invoke<NoteDto>('submit_from_inbox', { id, subfolder })
  } catch (err) {
    void alertModal(typeof err === 'string' ? err : 'Could not file that note.')
    return
  }
  // Filing moves the file out of Inbox/, so the id changes.
  migratePin(id, filed.id)
  await moveToNextFleeting(id)
}

const fleetingSubmitMenuEl = document.getElementById('fleeting-submit-menu') as HTMLButtonElement

/// Submit's dropdown offers the same folders Move to does; a plain button when
/// subfolder scanning is off, since folders don't exist then.
function applyFleetingSubmitShape() {
  document
    .getElementById('fleeting-submit-group')!
    .classList.toggle('no-folders', !settings.includeSubfolders)
}

document.getElementById('fleeting-submit')!.onclick = () => void submitFleeting(null)

/// The arrow half of Submit: The Index, then every folder with its colour —
/// the same list Move to offers. Dropped below the button, not at the pointer,
/// so it reads as the button's own menu.
fleetingSubmitMenuEl.onclick = async () => {
  if (!activePane.noteId) return
  let folders: string[] = []
  try {
    folders = await invoke<string[]>('list_subfolders')
  } catch (err) {
    console.error('could not list folders', err)
  }
  const colors = folderColors()
  const items: MenuItemSpec[] = [
    { label: 'The Index', swatch: null, run: () => submitFleeting(null) },
  ]
  if (folders.length) items.push({ label: '', separator: true })
  for (const f of folders) {
    items.push({ label: f, swatch: colors[f] ?? null, run: () => submitFleeting(f) })
  }
  const r = fleetingSubmitMenuEl.getBoundingClientRect()
  openContextMenu(r.left, r.bottom + 2, items)
}

document.getElementById('fleeting-delete')!.onclick = async () => {
  if (!activePane.noteId) return
  const id = activePane.noteId
  cancelPendingSave()
  activePane.noteId = null
  await invoke('delete_note', { id })
  void refreshCompletionSources()
  await moveToNextFleeting(id)
}

// --- Trash ------------------------------------------------------------------
// `trash:` swaps the list over to what's been deleted, the same shape
// `template:` and `inbox:` use. Return never acts here — restore and delete
// stay explicit buttons or a right-click, never a side effect of pressing a
// key while browsing what you threw away.

const trashPreviewEl = document.getElementById('trash-preview')!
const trashTitleEl = document.getElementById('trash-preview-title')!
const trashBodyEl = document.getElementById('trash-preview-body')!

let trashResults: NoteDto[] = []

function showTrashPreview(note: NoteDto | null) {
  if (!note) {
    trashPreviewEl.classList.add('hidden')
    return
  }
  trashTitleEl.textContent = note.title
  trashBodyEl.textContent = note.content ?? ''
  trashPreviewEl.classList.remove('hidden')
  emptyEl.classList.add('hidden')
}

/// `scrollToHighlight` is off for the right-click path: the row under the
/// pointer is already on screen, and a scroll event would close the context
/// menu that opens right after this returns.
function renderTrashList(scrollToHighlight = true) {
  // Trashed rows always carry a date, whatever the notes list was showing.
  listPaneEl.classList.add('has-date')
  syncDateColumnWidth()
  hidePinnedStrip()
  listEl.replaceChildren(
    ...trashResults.map((note, i) => {
      const row = document.createElement('div')
      row.className = 'row' + (i === highlighted ? ' highlighted' : '')
      const title = document.createElement('div')
      title.className = 'row-title'
      const icon = document.createElement('span')
      icon.className = 'trash-mark'
      icon.textContent = '🗑'
      const nameText = document.createElement('span')
      nameText.className = 'row-title-text'
      nameText.textContent = note.title
      title.append(icon, nameText)
      const date = document.createElement('span')
      date.className = 'row-date'
      date.textContent = formatModified(note.modifiedMs)
      row.append(title, date)

      row.onclick = () => {
        highlighted = i
        renderTrashList()
        showTrashPreview(note)
      }
      row.oncontextmenu = (e) => {
        e.preventDefault()
        highlighted = i
        renderTrashList(false)
        showTrashPreview(note)
        openContextMenu(e.clientX, e.clientY, trashMenuItems(note))
      }
      return row
    }),
  )
  showTrashPreview(trashResults[highlighted] ?? null)
  if (scrollToHighlight) scrollHighlightedRowIntoView()
}

/// The browse lists (trash, templates, catalogs) build every row in flow rather
/// than virtualising, so keeping an arrow-key highlight on screen is the plain
/// DOM call — the note list's own scroll logic works in row offsets instead.
function scrollHighlightedRowIntoView() {
  listEl.querySelector('.row.highlighted')?.scrollIntoView({ block: 'nearest' })
}

function trashMenuItems(note: NoteDto): MenuItemSpec[] {
  return [
    { label: 'Restore', run: () => restoreTrashed(note) },
    { label: 'Reveal in Explorer', run: () => invoke('reveal_note', { id: note.id }) },
    { label: 'Delete', destructive: true, run: () => deleteTrashed(note) },
  ]
}

async function restoreTrashed(note: NoteDto) {
  const restored = await invoke<NoteDto>('restore_from_trash', { id: note.id })
  migratePin(note.id, restored.id)
  void refreshCompletionSources()
  await runSearch()
}

async function deleteTrashed(note: NoteDto) {
  await invoke('delete_from_trash', { id: note.id })
  void refreshCompletionSources()
  await runSearch()
}

document.getElementById('trash-restore')!.onclick = () => {
  const note = trashResults[highlighted]
  if (note) void restoreTrashed(note)
}
document.getElementById('trash-reveal')!.onclick = () => {
  const note = trashResults[highlighted]
  if (note) void invoke('reveal_note', { id: note.id })
}
document.getElementById('trash-delete')!.onclick = () => {
  const note = trashResults[highlighted]
  if (note) void deleteTrashed(note)
}

// --- Templates --------------------------------------------------------------
// A template is a plain .md file in the Index's Templates/ folder — never a
// note, and never in the search results. `template:` swaps the list over to
// showing them, live and editable, the same shape trash: and inbox: use.

interface TemplateDto {
  id: string
  name: string
}

let templateResults: TemplateDto[] = []

/// A file from outside the vault, open in the editor. Templates were the first
/// of these; config.md and the theme files are the same idea, so they share
/// one path rather than each growing a parallel one. `id` is whatever that
/// kind's save command needs — a template path, a theme name, nothing for the
/// config, which there is only one of.
interface ExternalDoc {
  kind: 'template' | 'config' | 'theme'
  id: string
  name: string
}

/// Set while such a file is open, so saves route to it rather than the note
/// store, and so everything that asks "is there something to type into?" can
/// keep asking one question.

function renderTemplateList() {
  // Same as trash: a single trailing label in the value column.
  listPaneEl.classList.add('has-date')
  syncDateColumnWidth()
  hidePinnedStrip()
  listEl.replaceChildren(
    ...templateResults.map((t, i) => {
      const row = document.createElement('div')
      row.className = 'row' + (i === highlighted ? ' highlighted' : '')
      const title = document.createElement('div')
      title.className = 'row-title'
      const nameText = document.createElement('span')
      nameText.className = 'row-title-text'
      nameText.textContent = t.name
      title.append(nameText)
      const kind = document.createElement('span')
      kind.className = 'row-date'
      kind.textContent = 'Template'
      row.append(title, kind)
      row.onclick = () => {
        highlighted = i
        void openTemplate(t)
      }
      return row
    }),
  )
  scrollHighlightedRowIntoView()
}

/// Where an external document's edits go. Each kind has its own command
/// because each is a different file with a different owner — but from the
/// editor's side they are all "save this text back where it came from".
function saveExternalDocument(doc: ExternalDoc, content: string): Promise<unknown> {
  if (doc.kind === 'template') return invoke('save_template', { path: doc.id, content })
  // config_write_text re-emits config-changed, so every window re-applies the
  // settings the moment the file is saved from here.
  if (doc.kind === 'config') return invoke('config_write_text', { content })
  return invoke('theme_write_text', { name: doc.id, content })
}

/// Opens a file that isn't a note in the editor. They are all markdown, which
/// is the whole reason config.md and the theme files are markdown: the editor
/// styles them exactly as it styles a note, so the toml block renders as a
/// code block and a theme file's sample body previews the theme it describes.
async function openExternalDocument(doc: ExternalDoc, content: string) {
  cancelPendingSave()
  await save()
  activePane.noteId = null
  activePane.dto = null
  activePane.external = doc
  activePane.savedContent = content
  titleEl.value = doc.name
  titleEl.disabled = true // these files are renamed on disk, not from here
  renderDueBadge(null)
  renderTitleBarTags([])
  renderTitleBarFolder(null)
  fleetingActionsEl.classList.add('hidden')
  syncEmptyState()
  renderPaneCaptions()
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    effects: editable.reconfigure(EditorView.editable.of(true)),
    selection: { anchor: 0 },
  })
  measurePanes()
  currentInterlinks = { links: [], backlinks: [], suggested: [] }
  renderInterlinks()
  renderStats()
  // "Create Note from Template" only means anything for a template.
  templateActionsEl.classList.toggle('hidden', doc.kind !== 'template')
  view.focus()
}

async function openTemplate(t: TemplateDto) {
  const content = await invoke<string>('read_template', { path: t.id })
  await openExternalDocument({ kind: 'template', id: t.id, name: t.name }, content)
}

const templateActionsEl = document.getElementById('template-actions')!

document.getElementById('template-create')!.onclick = async () => {
  const doc = activePane.external
  if (doc?.kind !== 'template') return
  const name = templateResults.find((t) => t.id === doc.id)?.name ?? ''
  const created = await invoke<NoteDto>('create_note_from_template', {
    path: doc.id,
    title: name,
  })
  void refreshCompletionSources()
  // Leaves template-browsing mode: you asked for a note, so show the note.
  searchInput.value = ''
  await runSearch()
  await openNote(created.id)
  selectSingle(Math.max(0, await indexOfNote(created.id)))
  renderList()
  view.focus()
}

async function openHighlightedTemplate() {
  const t = templateResults[highlighted]
  if (!t) return
  await openTemplate(t)
  renderTemplateList()
}

/// Scrolls the first search match in the open note into view, about a third
/// of the way down the editor rather than the bare minimum — a match just
/// below the fold would otherwise land flush against the bottom edge with no
/// context under it, which reads as a lurch rather than "here's your result".
/// The cursor and selection are left where they were: this moves the view,
/// not the insertion point. Nothing happens for a blank query, or one made
/// only of operators that name nothing literal, since there's nothing lit up
/// to go to. Mirrors the Mac's jumpToFirstSearchMatch (1.11.0).
let lastJumpedQuery: string | null = null
function jumpToFirstSearchMatch(force = false) {
  const query = searchInput.value
  // Only when the query itself changed (or a different note opened). runSearch
  // also re-runs for the watcher and after edits, and yanking the editor to
  // the match again while someone is typing would be the lurch this exists to
  // avoid.
  if (!force && query === lastJumpedQuery) return
  lastJumpedQuery = query
  if (!query.trim() || view.state.doc.length === 0) return
  const pos = firstSearchMatch(view.state.doc.toString(), query)
  if (pos === null) return
  view.dispatch({
    effects: EditorView.scrollIntoView(pos, {
      y: 'start',
      yMargin: view.scrollDOM.clientHeight / 3,
    }),
  })
}

// --- Paging -----------------------------------------------------------------
// The list is fetched a page at a time. `results` is sparse past the first
// page (see its declaration); everything below fills it in.

/// Rows per fetch. Wide enough that any ordinary vault comes back whole in one
/// call — below this the list behaves exactly as it did when the backend sent
/// everything — and small enough that the page a keystroke pays for is a
/// couple of hundred KB rather than nineteen megabytes.
const PAGE_SIZE = 300

interface SearchSpec {
  query: string
  sortField: SortField
  sortAscending: boolean
  pinned: string[]
  hideInbox: boolean
}

interface SearchPage {
  notes: NoteDto[]
  total: number
  ready?: boolean
}

/// The spec the rows currently in `results` were fetched under. Every later
/// page has to use this one rather than reading the live search box and sort
/// header again: a page fetched under a spec the earlier pages weren't would
/// splice rows from two different orders into one list.
let activeSpec: SearchSpec = {
  query: '',
  sortField: 'date',
  sortAscending: false,
  pinned: [],
  hideInbox: false,
}

/// What the list *would* be fetched under right now.
///
/// The inbox filter is part of it because the list is paged: filtering fleeting
/// notes out after a page arrives would leave short pages and a total that
/// counts rows the list never shows. The rule itself is unchanged — never
/// hidden when the query is already about the inbox, since asking for "inbox:"
/// and being shown nothing because of a setting elsewhere would be its own bug.
function currentSpec(): SearchSpec {
  const query = searchInput.value
  return {
    query,
    sortField,
    sortAscending,
    pinned: [...pinnedIds],
    hideInbox: !settings.showInboxInMainList && !query.toLowerCase().includes('inbox:'),
  }
}

/// Whether the whole result set is in memory. Below one page it always is, and
/// then every path that walks the list — the local sort, a shift-range, the
/// "where did this note go" lookups — is exactly what it was before paging.
function fullyLoaded(): boolean {
  return results.length <= PAGE_SIZE
}

/// Pages already in `results`, and the fetches still on their way. Keyed by
/// page index. Both are cleared whenever the list is replaced, so a page from
/// the previous query can never land in the current one.
const loadedPages = new Set<number>()
const pagesInFlight = new Map<number, Promise<void>>()
/// The full id list for the current spec, once something has needed it.
let allIdsCache: string[] | null = null

/// Empties the list and everything keyed on it. The browse modes (trash,
/// templates, the catalogs) replace the list wholesale, so the page
/// bookkeeping has to go with it rather than survive into the next search.
function clearResults() {
  results = []
  loadedPages.clear()
  pagesInFlight.clear()
  allIdsCache = null
}

/// Installs a freshly fetched page 0 as the whole list.
function installFirstPage(page: SearchPage) {
  results = new Array<NoteDto | undefined>(page.total)
  for (let i = 0; i < page.notes.length; i++) results[i] = page.notes[i]
  loadedPages.clear()
  pagesInFlight.clear()
  allIdsCache = null
  // Normally one page, but the test hook installs a whole list this way — mark
  // every page the rows actually cover, so nothing is re-fetched.
  for (let p = 0; p * PAGE_SIZE < page.notes.length; p++) loadedPages.add(p)
  setIndexLoading(page.ready === false)
}

/// Fetches whatever pages `[from, to)` needs and paints them as they land.
///
/// Deduped by page, and stamped with the search generation: a page that comes
/// back after the query moved on is dropped rather than written into a list it
/// no longer describes.
async function loadRange(from: number, to: number): Promise<void> {
  const first = Math.max(0, Math.floor(from / PAGE_SIZE))
  const last = Math.min(Math.ceil(results.length / PAGE_SIZE), Math.ceil(to / PAGE_SIZE))
  const waits: Array<Promise<void>> = []
  for (let page = first; page < last; page++) {
    if (loadedPages.has(page)) continue
    const pending = pagesInFlight.get(page)
    if (pending) {
      waits.push(pending)
      continue
    }
    const gen = searchGeneration
    const offset = page * PAGE_SIZE
    const fetch = invoke<SearchPage>('search', { spec: activeSpec, offset, limit: PAGE_SIZE })
      .then((got) => {
        if (gen !== searchGeneration) return
        for (let i = 0; i < got.notes.length; i++) results[offset + i] = got.notes[i]
        loadedPages.add(page)
        // The new rows may carry a wider date than any loaded so far.
        syncDateColumnWidth()
        // The rows may be on screen already, as blanks.
        renderRowWindow(true)
      })
      .catch((err) => {
        console.error('could not load a page of results', err)
      })
      .finally(() => {
        if (pagesInFlight.get(page) === fetch) pagesInFlight.delete(page)
      })
    pagesInFlight.set(page, fetch)
    waits.push(fetch)
  }
  await Promise.all(waits)
}

/// Makes sure one row is in memory, for the callers that are about to read it
/// — the highlight moving, a note being opened. Returns immediately when it
/// already is, which is every case on a vault of ordinary size.
async function ensureLoaded(index: number): Promise<void> {
  if (index < 0 || index >= results.length || results[index]) return
  await loadRange(index, index + 1)
}

/// Every matching note's id, in list order — the cheap command, not a page of
/// notes. Cached for the life of the current result set, since the only things
/// that can change it also replace the list.
async function allResultIds(): Promise<string[]> {
  if (allIdsCache) return allIdsCache
  const gen = searchGeneration
  const ids = await invoke<string[]>('search_ids', { spec: activeSpec })
  if (gen !== searchGeneration) return ids
  allIdsCache = ids
  return ids
}

/// Where a note sits in the full order, or -1. Answers from the loaded rows
/// when it can — which is always, on a vault that fits in one page — and only
/// falls back to the id list when the row hasn't been fetched.
async function indexOfNote(id: string | null): Promise<number> {
  if (!id) return -1
  const local = results.findIndex((n) => n?.id === id)
  if (local >= 0 || fullyLoaded()) return local
  return (await allResultIds()).indexOf(id)
}

/// Re-reads the list after something moved a row within it — a save that
/// changed the sort key, a pin, a sort-header click.
///
/// Everything already fetched is dropped rather than patched: one row moving
/// shifts every index after it, so pages held from before the change would
/// interleave rows from two different orders. Cheaper than it sounds — it is
/// one page, the same call a keystroke makes, and it is only ever taken on the
/// paged path.
async function refetchList(keepId: string | null): Promise<void> {
  const gen = ++searchGeneration
  // Only the ordering is re-read. The query stays as it was last *searched*:
  // the box may already hold a keystroke whose debounce hasn't run, and this
  // is a reorder of the list on screen, not a new search.
  activeSpec = { ...activeSpec, sortField, sortAscending, pinned: [...pinnedIds] }
  const page = await invoke<SearchPage>('search', {
    spec: activeSpec,
    offset: 0,
    limit: PAGE_SIZE,
  })
  if (gen !== searchGeneration) return
  installFirstPage(page)
  if (keepId) {
    const moved = await indexOfNote(keepId)
    if (gen !== searchGeneration) return
    if (moved >= 0) highlighted = moved
  }
  highlighted = Math.max(0, Math.min(results.length - 1, highlighted))
  await ensureLoaded(highlighted)
  if (gen !== searchGeneration) return
  renderList()
}

/// The search box searches as you type, but each run fans out into several IPC
/// calls (the query plus the badge and count refreshes) and a full
/// re-render — firing that on every keystroke was the bulk of the box's typing
/// cost. Debouncing coalesces a burst of keystrokes into one run. Only this
/// per-keystroke path is debounced; every other `runSearch` caller (selecting a
/// folder, toggling a setting, …) still runs immediately.
let searchDebounceTimer: number | undefined
const SEARCH_DEBOUNCE_MS = 130

function scheduleSearch() {
  if (searchDebounceTimer !== undefined) clearTimeout(searchDebounceTimer)
  searchDebounceTimer = window.setTimeout(() => {
    searchDebounceTimer = undefined
    void runSearch()
  }, SEARCH_DEBOUNCE_MS)
}

/// Run `fn` only once the query on screen has actually been searched. Enter and
/// the arrow keys act on `results`; if a debounced search is still pending they
/// would otherwise act on the previous query's list, so flush it first.
///
/// Waits on whatever run is in flight *last*, not merely on the one it started:
/// the watcher or a setting change can supersede ours mid-flight, and acting on
/// a list that is about to be replaced is the same bug in a different disguise.
function afterPendingSearch(fn: () => void) {
  if (searchDebounceTimer === undefined) {
    fn()
    return
  }
  void runSearch().then(function settled(): void | Promise<void> {
    if (searchInFlight) return searchInFlight.then(settled)
    fn()
  })
}

/// Which run's reply is still wanted. Overlapping searches are ordinary here —
/// a keystroke, the watcher and a settings toggle can all be in flight at once —
/// and nothing orders the replies, so an older one landing last would leave the
/// list showing a query that is no longer in the box. Every await inside a run
/// re-checks its stamp and drops out if a newer run has started.
let searchGeneration = 0

/// The newest run still in flight, for callers that must act on the final list.
let searchInFlight: Promise<void> | undefined

function runSearch(): Promise<void> {
  // The flag is cleared inside `finally`, which runs before `run` itself
  // settles — so a `.then` on the returned promise always sees it already
  // cleared unless a *newer* run has begun in the meantime.
  const run: Promise<void> = performSearch().finally(() => {
    if (searchInFlight === run) searchInFlight = undefined
  })
  searchInFlight = run
  return run
}

async function performSearch() {
  const gen = ++searchGeneration
  // Hidden until the plain-search branch below knows whether Return would
  // create. Operator, template, trash and catalog queries never create.
  createHintEl.classList.add('hidden')
  // A direct run supersedes any keystroke-debounced one still waiting.
  if (searchDebounceTimer !== undefined) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = undefined
  }
  // Push the query into the editor so matches light up in the open note.
  view.dispatch({ effects: setSearchQuery.of(searchInput.value) })
  jumpToFirstSearchMatch()
  // Before the branches: the badge's count comes from the store and its
  // in/out state from the query, so it has to update whichever list is about
  // to be shown.
  void refreshInboxBadge()

  const template = templateFragment()
  if (template !== null) {
    const found = await invoke<TemplateDto[]>('list_templates', { fragment: template })
    if (gen !== searchGeneration) return
    templateResults = found
    clearResults()
    markOrderDirty()
    trashResults = []
    highlighted = 0
    trashPreviewEl.classList.add('hidden')
    renderTemplateList()
    return
  }

  const trash = trashFragment()
  if (trash !== null) {
    const found = await invoke<NoteDto[]>('trashed_notes', { fragment: trash })
    if (gen !== searchGeneration) return
    trashResults = found
    clearResults()
    markOrderDirty()
    templateResults = []
    highlighted = 0
    // The editor belongs to the Index, not to the trash — hide it rather than
    // leave the last-opened note sitting behind a trash preview.
    closeEditor()
    renderTrashList()
    return
  }

  const catalog = catalogMode()
  if (catalog !== null) {
    const rows = await invoke<CatalogRow[]>(catalog === 'tag' ? 'tag_catalog' : 'folder_catalog')
    if (gen !== searchGeneration) return
    catalogRows = rows
    clearResults()
    markOrderDirty()
    trashResults = []
    templateResults = []
    highlighted = 0
    trashPreviewEl.classList.add('hidden')
    renderCatalog(catalog)
    return
  }

  trashResults = []
  templateResults = []
  trashPreviewEl.classList.add('hidden')
  void refreshVaultCounts()
  // Fleeting notes can be kept out of the way until you go looking for them —
  // the backend applies that now, along with the sort and the pins, because
  // only it can see the rows this window hasn't fetched. See `currentSpec`.
  activeSpec = currentSpec()
  const page = await invoke<SearchPage>('search', {
    spec: activeSpec,
    offset: 0,
    limit: PAGE_SIZE,
  })
  if (gen !== searchGeneration) return
  installFirstPage(page)
  markOrderDirty()
  highlighted = 0
  renderList()
  renderCreateHint()
}

/// Focus the editor after opening, unless the setting says to stay in the
/// search box — some people arrow through results reading, and being thrown
/// into the text each time fights that.
function focusEditorIfWanted() {
  if (settings.moveFocusToEditorOnEnter) view.focus()
}

async function openNote(id: string) {
  // Flush any pending edit to the note we're leaving before switching.
  cancelPendingSave()
  await save()

  const note = await invoke<NoteDto | null>('read_note', { id })
  if (!note) return
  activePane.noteId = note.id
  // Held for the title bar, which used to hunt for this row in `results`.
  activePane.dto = note
  activePane.external = null
  activePane.savedContent = note.content ?? ''
  titleEl.value = note.title
  titleEl.disabled = false
  renderDueBadge(note.due)
  renderTitleBarTags(note.tags)
  renderTitleBarFolder(note.subfolder ?? null)
  // Reviewing a fleeting note is a decision — file it or bin it — so the two
  // actions appear only while looking at one.
  fleetingActionsEl.classList.toggle('hidden', !(note.isInbox && settings.inboxEnabled))
  applyFleetingSubmitShape()
  templateActionsEl.classList.add('hidden')
  syncEmptyState()
  renderPaneCaptions()
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: note.content ?? '' },
    effects: editable.reconfigure(EditorView.editable.of(true)),
    selection: { anchor: 0 },
  })
  // The pane's size can change as the empty state is uncovered, and the
  // styler decorates only what's in view — without a re-measure the viewport
  // it computed a moment ago may not match what's actually on screen.
  measurePanes()
  // Opening a result of a search lands on what matched, not on the top of the
  // note — the same jump typing in the box makes for the note already open.
  jumpToFirstSearchMatch(true)
  renderStats()
  await refreshInterlinks()
}

/// `rerender` is off for callers that have already painted the new highlight —
/// opening a note changes nothing in `results`, so their render is the only one
/// needed and a second full list render per arrow key is pure waste.
async function openHighlighted(rerender = true) {
  await ensureLoaded(highlighted)
  const target = results[highlighted]
  if (!target) return
  await openNote(target.id)
  if (rerender) renderList()
}

/// Moves the list selection by one row and shows what it lands on — the way the
/// Mac's list behaves: the editor follows the highlight (as the trash and
/// template previews already do here), and keyboard focus stays put so you can
/// keep arrowing. `extend` grows a Shift-range instead, only in the ordinary
/// note list. Shared by the search box and the window-level handler, so arrows
/// navigate whether or not the search field happens to hold focus — otherwise
/// they fall through to the browser and merely scroll the list.
async function arrowNavigate(delta: number, extend: boolean) {
  const catalog = catalogMode()
  const inTemplate = templateFragment() !== null
  const inTrash = trashFragment() !== null
  if (extend && !inTemplate && !inTrash && catalog === null) {
    await extendSelection(delta)
    renderList()
    void openHighlighted(false)
    return
  }
  const next = Math.max(0, Math.min(currentListLength() - 1, highlighted + delta))
  if (next === highlighted && currentListLength() > 0) {
    // Already at the end being pushed against — nothing moves, and re-opening
    // the same note would only fight the editor for no reason.
    return
  }
  if (inTemplate || inTrash) {
    highlighted = next
    renderCurrentList()
  } else if (catalog !== null) {
    highlighted = next
    renderCatalog(catalog)
  } else {
    // The index moves first, synchronously. A held key repeats forty times a
    // second, and the old order — wait for the row's page, then select — let
    // every press that arrived during a fetch compute from the same stale
    // index and resolve out of order, so the highlight lurched while the
    // scroll position, set for whichever press finished last, ran ahead of
    // it. Now each press lands on exactly the next row and the scroll follows
    // the index the highlight shows; a fetch only delays the note opening.
    selectSingle(next)
    repaintSelection()
    scrollHighlightIntoView()
    const token = ++navToken
    // The row being moved onto has to exist before it can be opened —
    // otherwise arrowing past the loaded pages lands on a blank row and the
    // editor is left showing the note before it. Usually already loaded,
    // since the render window prefetches a page ahead of itself.
    await ensureLoaded(next)
    if (token !== navToken) return // a later press has moved on
    const row = results[next]
    if (!row) return
    if (anchorId === null) anchorId = row.id // the row arrived after selectSingle
    scheduleOpenHighlighted()
  }
}

let navToken = 0
let openHighlightedTimer = 0

/// Re-marks the highlighted and multi-selected rows in place. Moving the
/// highlight changes no row's content, so rebuilding the window for it — the
/// full render's job — is forty rebuilds a second under a held arrow key for
/// no visible gain; toggling two classes on the rows already on screen is the
/// whole change. Rows the scroll brings in are built with the right classes.
function repaintSelection() {
  const rows = [...listSizer.children, ...pinnedStripEl.children] as HTMLElement[]
  for (const row of rows) {
    const i = Number(row.dataset.index)
    if (!Number.isFinite(i)) continue
    const note = results[i]
    const selected = note ? isSelected(note) : false
    // Toggled, not reassigned: a row carries other classes (sticky, inbox,
    // folder marks) that the highlight has no business clearing.
    row.classList.toggle('highlighted', i === highlighted)
    row.classList.toggle('multi-selected', i !== highlighted && selected)
    row.setAttribute('aria-selected', String(selected))
  }
}

/// Opens the highlighted note once the arrow key rests. Held down, the
/// highlight moves every 25 ms; opening every note it passes over is a load,
/// a restyle and an interlink lookup per row, none of which anyone sees. The
/// delay is short enough that a single press still feels immediate.
function scheduleOpenHighlighted() {
  if (openHighlightedTimer) clearTimeout(openHighlightedTimer)
  openHighlightedTimer = window.setTimeout(() => {
    openHighlightedTimer = 0
    void openHighlighted(false)
  }, 40)
}

// --- Multi-select -----------------------------------------------------------
// `highlighted` is the primary selection — the one driving the editor.
// `multiSelected` holds the rest, and `anchorId` is the fixed end of a
// Shift-range so extending it repeatedly grows from where it started rather
// than from wherever the cursor last landed.

const multiSelected = new Set<string>()
let anchorId: string | null = null

function fullSelection(): string[] {
  const primary = results[highlighted]?.id
  const all = new Set(multiSelected)
  if (primary) all.add(primary)
  return [...all]
}

function isSelected(note: NoteDto): boolean {
  return note.id === results[highlighted]?.id || multiSelected.has(note.id)
}

function selectSingle(index: number) {
  highlighted = index
  multiSelected.clear()
  anchorId = results[index]?.id ?? null
}

/// Selects everything between the anchor and `index`, inclusive, in the list's
/// current order. The clicked note becomes the primary, so the editor follows
/// the end you're dragging rather than the end you started from.
///
/// A range can span rows no page has fetched — shift-clicking near the bottom
/// of a long list is exactly that — and a selection that quietly skipped them
/// would delete or move fewer notes than it said it would. So when the range
/// isn't fully in memory the ids come from `search_ids`, which is the whole
/// list's ids and nothing else. Below one page nothing changes.
async function selectRange(index: number) {
  const anchorIndex = await indexOfNote(anchorId)
  if (anchorIndex < 0) {
    selectSingle(index)
    return
  }
  const [lo, hi] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex]
  multiSelected.clear()
  let ids: Array<string | undefined>
  if (fullyLoaded()) {
    ids = results.slice(lo, hi + 1).map((n) => n?.id)
  } else {
    ids = (await allResultIds()).slice(lo, hi + 1)
  }
  for (const id of ids) if (id) multiSelected.add(id)
  highlighted = index
  await ensureLoaded(index)
  multiSelected.delete(results[index]?.id ?? '')
}

/// Toggles one note's membership. Demoting the primary promotes another
/// selected note to take its place, since the primary is what drives the
/// editor and has to stay in step with "is anything selected at all".
function toggleMultiSelect(index: number) {
  const note = results[index]
  if (!note) return
  if (index === highlighted) {
    const next = [...multiSelected][0]
    if (next) {
      multiSelected.delete(next)
      // Ctrl-clicking only ever reaches rows that are on screen, so the note
      // being promoted is in a loaded page by construction.
      highlighted = results.findIndex((n) => n?.id === next)
    }
    return
  }
  if (multiSelected.has(note.id)) multiSelected.delete(note.id)
  else multiSelected.add(note.id)
}

async function extendSelection(delta: number) {
  if (results.length === 0) return
  if (!anchorId) anchorId = results[highlighted]?.id ?? null
  await selectRange(Math.max(0, Math.min(results.length - 1, highlighted + delta)))
}

async function deleteSelection() {
  const ids = fullSelection()
  if (ids.length === 0) return
  // Flushed, not dropped: the copy that lands in the trash should be the note
  // as last typed, so restoring it brings back everything.
  cancelPendingSave()
  await save()
  const gone = panes.filter((p) => ids.includes(p.noteId ?? ''))
  for (const pane of gone) pane.noteId = null
  // One call, not a loop: the store treats a single delete as one undo step,
  // so a bulk delete restores as one action.
  await invoke('delete_notes', { ids })
  void refreshCompletionSources()
  multiSelected.clear()
  anchorId = null
  await releasePanes(gone)
  await runSearch()
}

function bulkMenuItems(count: number): MenuItemSpec[] {
  return [
    {
      label: `Show ${count} Notes in Folder`,
      run: async () => {
        for (const id of fullSelection()) await invoke('reveal_note', { id })
      },
    },
    // The single-note menu's Move to, applied to the whole selection. Only
    // when subfolders are listed, for the same reason as there.
    ...(settings.includeSubfolders
      ? [
          {
            label: `Move ${count} Notes to`,
            submenu: () => moveToItems(fullSelection()),
          } as MenuItemSpec,
        ]
      : []),
    { label: `Move ${count} Notes to Trash`, destructive: true, run: deleteSelection },
  ]
}

// --- Folders -----------------------------------------------------------------
// A second axis alongside tags: a note lives in exactly one folder ("which
// pile"), but can carry many tags ("what it's about").
//
// The folder itself is on disk and fully portable — it is just where the file
// sits. The *colour* is a preference keyed by the folder's path relative to the
// Index root, so nothing is ever written into a note, and the key survives the
// Index being moved while still telling apart same-named folders at different
// depths.

/// The palette offered for folders, matching the Mac's presets exactly, so a
/// coloured folder sits in the same family as tags and links.
const FOLDER_PRESETS: Array<[string, string]> = [
  ['Red', '#FF4B39'],
  ['Orange', '#F5A623'],
  ['Yellow', '#F5D423'],
  ['Green', '#30D158'],
  ['Blue', '#5A80FF'],
  ['Purple', '#B46BFF'],
  ['Pink', '#FF6FB0'],
]

function folderColors(): Record<string, string> {
  return config.map('folder_colors')
}

function setFolderColor(folder: string, color: string | null) {
  config.setMapEntry('folder_colors', folder, color)
  // Every folder is born coloured, so "Remove Color" rolls a fresh preset
  // rather than leaving a gap — the same thing the Mac's rebuild does the
  // moment the preference changes.
  if (!color) ensureFolderColors([folder])
  repaintFolderColors()
}

/// Repaints everything keyed on a folder's colour: the list rows and the open
/// note's title-bar chip, in step rather than waiting for the note to be
/// reopened.
function repaintFolderColors() {
  renderList()
  renderTitleBarFolder(activePane.dto?.subfolder ?? null)
}

/// Every folder is born coloured, tag-style: any folder seen without a colour
/// (newly created in Envy, made in a file manager, or predating this behaviour)
/// gets a random preset, persisted — so its dot, and the dot's right-click
/// recolour menu, always exist. Mirrors the Mac's rebuildFolderColors.
function ensureFolderColors(folders: string[]) {
  const all = folderColors()
  const assigned: Record<string, string> = {}
  for (const folder of folders) {
    if (all[folder]) continue
    assigned[folder] = FOLDER_PRESETS[Math.floor(Math.random() * FOLDER_PRESETS.length)][1]
  }
  if (Object.keys(assigned).length === 0) return
  // One write for the whole batch: a first scan of a big vault would otherwise
  // rewrite config.md once per folder it had never seen.
  config.setMapEntries('folder_colors', assigned)
  repaintFolderColors()
}

/// The colour menu for a folder's dot — the same palette as tags, plus a
/// clear. Shown by right-clicking a folder dot in the list or a catalog row.
/// Pivots the search to one folder's notes — the click every folder marker
/// shares (list dot/chip, title-bar chip). The quoted-exact form, since folder
/// names carry spaces far more often than tags; a name containing a quote can't
/// be quoted, so it falls back to the unquoted partial rather than a malformed
/// query. Mirrors the Mac's searchByFolder.
function searchByFolder(folder: string) {
  searchInput.value = folder.includes('"')
    ? `folder:${folder.replace(/"/g, '')}`
    : `folder:"${folder}"`
  void runSearch()
}

function folderColorMenu(folder: string): MenuItemSpec[] {
  const current = folderColors()[folder]
  const items: MenuItemSpec[] = FOLDER_PRESETS.map(([label, hex]) => ({
    label,
    swatch: hex,
    run: () => setFolderColor(folder, hex),
  }))
  if (current) {
    items.push({ label: '', separator: true })
    items.push({
      label: 'Remove Color',
      destructive: true,
      run: () => setFolderColor(folder, null),
    })
  }
  return items
}

// --- Browse catalogs ---------------------------------------------------------
// A bare `tag:` or `folder:` in the search box turns the list into a catalog:
// every tag / folder as a coloured pill or dot with its note count, most-used
// first. Click a row to see its notes (the search pivots to the quoted, exact
// form); right-click to recolour or rename. The operators still filter when
// combined with anything else — the catalog is only the *bare* form.

interface CatalogRow {
  name: string
  count: number
}
type CatalogKind = 'tag' | 'folder'
let catalogRows: CatalogRow[] = []

/// Which catalog the current query asks for, or null. The folder catalog needs
/// subfolders shown — clicking a folder there filters to notes that would
/// otherwise be hidden — so it only offers when they are.
function catalogMode(): CatalogKind | null {
  const q = searchInput.value.trim().toLowerCase()
  if (q === 'tag:') return 'tag'
  if (q === 'folder:' && settings.includeSubfolders) return 'folder'
  return null
}

/// Re-keys the stored colours after a folder rename, so a coloured folder — and
/// everything nested inside it — keeps its colour under the new path rather than
/// silently losing it (the thing a plain Explorer rename does).
function migrateFolderColors(oldPath: string, newPath: string) {
  const all = folderColors()
  const moves: Record<string, string | null> = {}
  for (const key of Object.keys(all)) {
    if (key === oldPath || key.startsWith(`${oldPath}/`)) {
      moves[newPath + key.slice(oldPath.length)] = all[key]
      moves[key] = null
    }
  }
  if (Object.keys(moves).length > 0) config.setMapEntries('folder_colors', moves)
}

async function renameTagFlow(oldName: string) {
  // A rename rewrites every note carrying the tag, the open one included, so
  // any unsaved typing there is committed first rather than lost or undone.
  cancelPendingSave()
  await save()
  const next = (await textPrompt(`Rename #${oldName} to`, oldName))?.trim()
  if (!next || next === oldName) return
  const clean = next.replace(/^#/, '').toLowerCase()
  if (!clean || clean === oldName) return
  // Renaming onto a tag that already exists is a merge — every note carrying
  // the old one comes to carry the survivor. Worth a word first, since it can't
  // be undone in one step.
  const exists = catalogRows.some((r) => r.name === clean)
  if (exists && !(await confirmModal(`#${clean} already exists. Merge #${oldName} into it?`, 'Merge'))) {
    return
  }
  // The colour belongs to the surviving name: keep the target's if it has one,
  // otherwise carry the old tag's colour across.
  const colors = tagColors()
  if (!colors[clean] && colors[oldName]) setTagColor(clean, colors[oldName])
  if (colors[oldName]) setTagColor(oldName, null)
  void invoke('rename_tag', { oldName, newName: clean })
    .then(() => runSearch())
    .catch((err) => console.error('rename tag failed', err))
}

async function renameFolderFlow(oldPath: string) {
  // Every note inside moves, so a pending edit to one of them is committed
  // first — the same reason the tag rename flushes.
  cancelPendingSave()
  await save()
  const next = (
    await textPrompt(
      `Rename "${oldPath}" to (add a "/" to file it under another folder)`,
      oldPath,
    )
  )?.trim()
  if (!next || next === oldPath) return
  void invoke<string>('rename_folder', { oldPath, newPath: next })
    .then((newPath) => {
      migrateFolderColors(oldPath, newPath)
      // A folder that somehow had no colour to carry across gets one now.
      ensureFolderColors([newPath])
      return runSearch()
    })
    .catch((err) => {
      // The command rejects with a human message (reserved / taken / empty).
      void alertModal(typeof err === 'string' ? err : 'Could not rename that folder.')
    })
}

/// Renders the catalog into the list. Rows are keyboard-navigable like the note
/// list; the primary row is highlighted, click pivots, right-click acts.
function renderCatalog(kind: CatalogKind, scrollToHighlight = true) {
  listPaneEl.classList.remove('has-date')
  syncDateColumnWidth()
  hidePinnedStrip()
  const colors = kind === 'tag' ? tagColors() : folderColors()
  listEl.replaceChildren(
    ...catalogRows.map((entry, i) => {
      const row = document.createElement('div')
      row.className = 'row catalog-row' + (i === highlighted ? ' highlighted' : '')
      row.setAttribute('role', 'option')

      const label = document.createElement('span')
      const tint = colors[entry.name]
      if (kind === 'tag') {
        label.className = 'envy-tag catalog-tag'
        label.textContent = `#${entry.name}`
        if (tint) {
          label.style.color = tint
          label.style.background = `color-mix(in srgb, ${tint} 18%, transparent)`
        }
      } else {
        label.className = 'catalog-folder'
        const dot = document.createElement('span')
        dot.className = 'folder-dot'
        // A folder with no colour still gets a hollow marker, so names line up.
        if (tint) dot.style.background = tint
        else dot.classList.add('empty')
        label.append(dot, document.createTextNode(entry.name))
      }

      const count = document.createElement('span')
      count.className = 'catalog-count'
      count.textContent = String(entry.count)
      row.append(label, count)

      const pivot = () => {
        // The quoted form, so clicking a row shows exactly its count — an exact
        // match, never a lookalike.
        searchInput.value = `${kind}:"${entry.name}"`
        void runSearch()
      }
      const menu = () =>
        kind === 'tag'
          ? [
              ...tagColorMenu(entry.name),
              { label: '', separator: true } as MenuItemSpec,
              { label: 'Rename Tag…', run: () => renameTagFlow(entry.name) } as MenuItemSpec,
            ]
          : [
              ...folderColorMenu(entry.name),
              { label: '', separator: true } as MenuItemSpec,
              { label: 'Rename Folder…', run: () => renameFolderFlow(entry.name) } as MenuItemSpec,
            ]

      row.onclick = () => {
        highlighted = i
        pivot()
      }
      row.oncontextmenu = (e) => {
        e.preventDefault()
        highlighted = i
        // No highlight scroll here — see renderTrashList.
        renderCatalog(kind, false)
        openContextMenu(e.clientX, e.clientY, menu())
      }
      return row
    }),
  )
  if (scrollToHighlight) scrollHighlightedRowIntoView()
}

/// Moves `ids` into `subfolder` (null = the Index root), the selection following
/// the notes across the id changes a move makes — one note from the single-note
/// menu, the whole selection from the bulk menu.
///
/// Pending edits are flushed first, so an edit made a moment ago lands wherever
/// the note goes rather than at a path that no longer exists (the Mac's 1.8.1
/// "edits follow the note"). When the open note is among them, the editor
/// follows it too — its id and pin move with the file.
///
/// A note whose name collides in the destination is refused by the store, to
/// keep wikilinks honest. It's skipped, the rest still go, and the refusals are
/// reported once at the end rather than as one dialog per note.
async function moveNotes(ids: string[], subfolder: string | null) {
  if (ids.length === 0) return
  cancelPendingSave()
  await save()
  const moved = new Map<string, string>()
  const refused: string[] = []
  for (const id of ids) {
    try {
      const note = await invoke<NoteDto>('move_note_to_subfolder', { id, subfolder })
      moved.set(id, note.id)
    } catch (err) {
      refused.push(typeof err === 'string' ? err : 'Could not move that note.')
    }
  }
  for (const [from, to] of moved) {
    migratePin(from, to)
    for (const pane of panesShowing(from)) pane.noteId = to
    if (anchorId === from) anchorId = to
    if (multiSelected.delete(from)) multiSelected.add(to)
  }
  // A folder that didn't exist a moment ago is born coloured, like the rest.
  if (subfolder && moved.size > 0) ensureFolderColors([subfolder])
  // A move is suppressed from the watcher, so nothing else will tell the
  // autofill that a folder (and a note's path) just changed.
  if (moved.size > 0) void refreshCompletionSources()
  const primary = results[highlighted]?.id
  const primaryAfter = primary ? (moved.get(primary) ?? primary) : null
  await runSearch()
  if (primaryAfter) {
    const idx = await indexOfNote(primaryAfter)
    if (idx >= 0) {
      highlighted = idx
      await ensureLoaded(highlighted)
      renderList()
    }
  }
  if (activePane.noteId && [...moved.values()].includes(activePane.noteId)) {
    // The title-bar chip names the folder the open note now sits in.
    renderTitleBarFolder(activePane.dto?.subfolder ?? null)
  }
  if (refused.length > 0) {
    void alertModal(
      refused.length === 1
        ? refused[0]
        : `${refused.length} notes could not be moved:\n${refused.join('\n')}`,
    )
  }
}

/// The "Move to" submenu: the Index root, every folder, and a way to make one.
/// Takes the ids to move, so the single-note menu and the bulk menu share it.
async function moveToItems(ids: string[]): Promise<MenuItemSpec[]> {
  let folders: string[] = []
  try {
    folders = await invoke<string[]>('list_subfolders')
  } catch (err) {
    console.error('could not list folders', err)
  }
  const colors = folderColors()
  const move = (to: string | null) => () => moveNotes(ids, to)

  const items: MenuItemSpec[] = [{ label: 'The Index', swatch: null, run: move(null) }]
  if (folders.length) items.push({ label: '', separator: true })
  for (const f of folders) {
    // The folder a note is already in is shown but does nothing — moving it
    // there is a no-op anyway, and hiding it makes the list look wrong.
    items.push({ label: f, swatch: colors[f] ?? null, run: move(f) })
  }
  items.push({ label: '', separator: true })
  items.push({
    label: 'New Folder…',
    run: async () => {
      const name = await textPrompt('New folder name')
      if (!name?.trim()) return
      // The move creates the folder on demand, so there is nothing to make
      // first — this is a move to a name that does not exist yet.
      await move(name.trim())()
    },
  })
  return items
}

function noteMenuItems(note: NoteDto): MenuItemSpec[] {
  return [
    {
      label: pinnedIds.has(note.id) ? 'Unpin Note' : 'Pin Note',
      // Greyed out, not hidden, when the sticky strip is full — the same
      // `.disabled(!isPinned && pinLimitReached)` the Mac's menu applies.
      disabled: !pinnedIds.has(note.id) && pinLimitReached(),
      run: () => {
        highlighted = results.findIndex((n) => n?.id === note.id)
        togglePin()
      },
    },
    {
      label: note.id === trayPinnedId ? 'Unpin from Tray' : 'Pin to Tray',
      run: async () => {
        highlighted = results.findIndex((n) => n?.id === note.id)
        await toggleTrayPin()
      },
    },
    {
      label: 'Pop Out',
      run: () => void invoke('pop_out_note', { id: note.id, innerSize: storedPopoutSize() }),
    },
    {
      label: 'Send to Split Pane',
      run: () => void openInSplitPane(note.id),
    },
    {
      label: 'Rename',
      run: async () => {
        await openNote(note.id)
        renderList()
        titleEl.focus()
        titleEl.select()
      },
    },
    // Only when subfolders are actually listed. Filing a note into a folder
    // Envy then hides from the list would look like deleting it.
    ...(settings.includeSubfolders
      ? [{ label: 'Move to', submenu: () => moveToItems([note.id]) } as MenuItemSpec]
      : []),
    { label: 'Reveal in Explorer', run: () => invoke('reveal_note', { id: note.id }) },
    {
      label: 'Make This Note a Template',
      run: async () => {
        // A pending edit belongs in the template, not lost with the note.
        cancelPendingSave()
        await save()
        await invoke('convert_to_template', { id: note.id })
        // It stops being a note at all, so the pin goes rather than moves.
        migratePin(note.id, null)
        await releasePanes(panesShowing(note.id))
        await runSearch()
      },
    },
    {
      label: 'Move to Trash',
      destructive: true,
      run: async () => {
        selectSingle(results.findIndex((n) => n?.id === note.id))
        await deleteSelection()
      },
    },
  ]
}

// Settings has no in-window control at all, by design. It lives on Ctrl+, and
// in the tray menu — which on Windows is where a background-capable app puts
// its menu, so that's idiomatic rather than a compromise. Anything app-level
// that needs a home later (About, Markup Help, What's New) belongs in the tray
// menu beside it, not in the window.

// --- Pinning ----------------------------------------------------------------
// A pinned note stays at the top of the list regardless of sort. Membership is
// the app's own state rather than anything written into the file — pinning is
// about how *you* want the list arranged, not about the note's content, and
// writing a marker into someone's prose to record a UI preference would be
// the wrong trade.

const pinnedIds = new Set<string>(
  JSON.parse(localStorage.getItem('pinnedIds') ?? '[]') as string[],
)

function persistPins() {
  // Pinned notes sort to the front, so any change to the set reorders the list.
  markOrderDirty()
  localStorage.setItem('pinnedIds', JSON.stringify([...pinnedIds]))
}

/// Moves a pin when a note's id changes out from under it.
///
/// A note's id is its file path, so anything that moves the file — a rename,
/// filing a fleeting note, restoring from trash — mints a new id and would
/// silently drop the pin. Losing a pin because you corrected a typo in a title
/// is the kind of small betrayal that stops people trusting the feature.
///
/// Passing `null` as the new id drops the pin instead, for when the note stops
/// being a note at all (becoming a template).
export function migratePin(oldId: string, newId: string | null) {
  if (pinnedIds.delete(oldId)) {
    if (newId) pinnedIds.add(newId)
    persistPins()
  }
  if (trayPinnedId === oldId) {
    trayPinnedId = newId
    if (newId) localStorage.setItem('trayPinnedId', newId)
    else localStorage.removeItem('trayPinnedId')
    void invoke('set_pinned_note', { id: newId })
  }
}

/// Pinned notes first, each group keeping the order the sort produced.
function applyPinning(notes: NoteDto[]): NoteDto[] {
  if (pinnedIds.size === 0) return notes
  const pinned = notes.filter((n) => pinnedIds.has(n.id))
  const rest = notes.filter((n) => !pinnedIds.has(n.id))
  return [...pinned, ...rest]
}

/// The one note pinned to the tray, if any. Distinct from list pinning: that
/// arranges the list, this substitutes what a tray click does. Only one note
/// can hold it, so setting it displaces whatever held it before.
let trayPinnedId: string | null = localStorage.getItem('trayPinnedId')

async function toggleTrayPin() {
  const target = results[highlighted]
  if (!target) return
  trayPinnedId = trayPinnedId === target.id ? null : target.id
  if (trayPinnedId) localStorage.setItem('trayPinnedId', trayPinnedId)
  else localStorage.removeItem('trayPinnedId')
  await invoke('set_pinned_note', { id: trayPinnedId })
  renderList()
}

function togglePin() {
  const target = results[highlighted]
  if (!target) return
  if (pinnedIds.has(target.id)) pinnedIds.delete(target.id)
  else if (pinLimitReached()) return
  else pinnedIds.add(target.id)
  persistPins()
  // Keep the highlight on the note that just moved, rather than on whatever
  // row happens to sit at the old index now — resolved against the reordered
  // list before painting, so pinning costs one render rather than two.
  if (!fullyLoaded()) {
    // Paged: pinning changes the head of the order, and the pin set is part of
    // the spec every page is fetched under, so the list is re-read.
    void refetchList(target.id)
    return
  }
  reorderResults()
  const moved = results.findIndex((n) => n?.id === target.id)
  if (moved >= 0) highlighted = moved
  renderList()
}

// --- Query shapes -----------------------------------------------------------

/// Prefix operators that scope the *whole* box rather than filtering within
/// it. Each shows its own kind of thing in the list.
function prefixFragment(query: string, prefix: string): string | null {
  const trimmed = query.trim()
  return trimmed.toLowerCase().startsWith(prefix)
    ? trimmed.slice(prefix.length)
    : null
}

const templateFragment = () => prefixFragment(searchInput.value, 'template:')
/// With the Inbox switched off `inbox:` is not a mode — neither a browse nor
/// a capture — so this reads as "no fragment" and the box behaves like any
/// other query.
const inboxFragment = () =>
  settings.inboxEnabled ? prefixFragment(searchInput.value, 'inbox:') : null
const trashFragment = () => prefixFragment(searchInput.value, 'trash:')

/// Whether any word in the query is a search operator.
///
/// This is what stops Return creating a note literally named `tag:xyz`. Every
/// operator counts, not just the prefix ones — the query is a filter, and a
/// filter that matches nothing means "nothing matched", not "make me a note
/// called that".
function containsSearchOperator(query: string): boolean {
  return query
    .trim()
    .split(/\s+/)
    .some((raw) => {
      const w = raw.toLowerCase()
      return (
        /^-?(tag|date|stale|due|link|interlink|folder|title|img|embed|template|trash|inbox|ai):/.test(
          w,
        ) ||
        w === 'orphan:' ||
        w === 'linked:' ||
        w === 'ghost:' ||
        w === '-ghost:' ||
        w === 'todo:' ||
        w === '-todo:' ||
        w === '-ai:' ||
        (w.startsWith('-') && w.length > 1)
      )
    })
}

/// Return: open the note titled exactly what was typed, or create one.
///
/// Partial matches in the list do not change that — the Mac's rule. Typing
/// "welcome to envy is" while "Welcome to Envy" exists makes the new note;
/// the search box is a title field first and a filter second, and the line
/// under the list says which of the two Return is about to do.
///
/// The exceptions matter as much as the rule:
///
/// - `template:` opens the highlighted template for editing.
/// - `trash:` never acts. Restore and delete are always explicit, never a side
///   effect of pressing Return while browsing.
/// - `inbox:` is the one browse operator where Return *writes*: typing
///   `inbox: call mom` captures it. The operator that scopes the box is the one
///   that routes writing into it, so there's no second syntax to learn. A bare
///   `inbox:`, or an exact match on something already waiting, just opens it.
/// - Any other operator query opens the highlighted note and never creates,
///   since the query is a filter rather than a title.
/// Parses the `Folder/Title` quick-create form. Splits on the *last* slash; the
/// part before must case-insensitively match an existing subfolder (nested
/// ones included), the part after is the title. Returns null — falling through
/// to an ordinary search/create — when subfolders are off, there's no slash, or
/// the folder isn't one that exists. It never invents a folder. Mirrors the
/// Mac's folderTargetedCreation.
function folderTargetedCreation(raw: string): { folder: string; title: string } | null {
  if (!settings.includeSubfolders) return null
  const slash = raw.lastIndexOf('/')
  if (slash === -1) return null
  const folderPart = raw.slice(0, slash).trim()
  const titlePart = raw.slice(slash + 1).trim()
  if (!folderPart || !titlePart) return null
  const match = knownFolders.find((f) => f.toLowerCase() === folderPart.toLowerCase())
  return match ? { folder: match, title: titlePart } : null
}

async function openOrCreate() {
  const raw = searchInput.value
  const query = raw.trim()

  if (templateFragment() !== null) {
    await openHighlightedTemplate()
    return
  }
  if (trashFragment() !== null) return

  const catalog = catalogMode()
  if (catalog !== null) {
    // Enter (or click) on a row pivots the search to that tag/folder, exact.
    const row = catalogRows[highlighted]
    if (row) {
      searchInput.value = `${catalog}:"${row.name}"`
      await runSearch()
    }
    return
  }

  const inbox = inboxFragment()
  if (inbox !== null) {
    const title = inbox.trim()
    // Loaded rows only. Past one page an inbox holding more fleeting notes
    // than a page could carry could capture a second note under a title
    // already further down the list — a duplicate title, which the Index
    // tolerates, rather than anything lost.
    const existing = results.some((n) => n?.title.toLowerCase() === title.toLowerCase())
    if (!title || existing) {
      await openHighlighted()
      focusEditorIfWanted()
      return
    }
    await captureToInbox(title)
    return
  }

  if (containsSearchOperator(query)) {
    await openHighlighted()
    focusEditorIfWanted()
    return
  }

  // An exact title match opens rather than duplicating.
  // Loaded rows only, same as the inbox check above: what falls through is a
  // new note rather than the existing one being opened.
  const exact = results.find((n) => n?.title.toLowerCase() === query.toLowerCase())
  if (exact) {
    await openNote(exact.id)
    highlighted = await indexOfNote(exact.id)
    await ensureLoaded(highlighted)
    renderList()
    focusEditorIfWanted()
    return
  }

  // "Work/Retro notes" files a new "Retro notes" inside the Work folder — the
  // slash is a folder picker, and it takes priority over opening a partial
  // match, since typing it is a deliberate "make this here". Only fires when
  // the part before the last slash names a real subfolder, so an ordinary
  // search that happens to contain a slash falls straight through.
  const targeted = folderTargetedCreation(query)
  if (targeted) {
    const created = await invoke<NoteDto>('create_note_in_subfolder', {
      title: targeted.title,
      subfolder: targeted.folder,
    })
    void refreshCompletionSources()
    searchInput.value = ''
    await runSearch()
    await openNote(created.id)
    renderList()
    focusEditorIfWanted()
    return
  }

  // Nothing typed: Return just moves into whatever is highlighted.
  if (!query) {
    if (results.length > 0) {
      await openHighlighted()
      focusEditorIfWanted()
    }
    return
  }

  // "New notes start in the Inbox" makes filing a deliberate act. Notes made
  // by following a link, or from a template, are unaffected — both are already
  // placed, so routing them through a capture queue asks a question you have
  // already answered.
  const command =
    settings.newNotesStartInInbox && settings.inboxEnabled ? 'create_inbox_note' : 'create_note'
  const created = await invoke<NoteDto>(command, { title: query })
  void refreshCompletionSources()
  searchInput.value = ''
  await runSearch()
  await openNote(created.id)
  renderList()
  focusEditorIfWanted()
}

/// Shows "Press ⏎ to create …" under the list whenever Return would make a
/// note: a plain query with no exactly-titled note among the loaded rows.
/// Reads the same rows openOrCreate does, so the pill and the key agree.
function renderCreateHint() {
  const query = searchInput.value.trim()
  const exact = results.some((n) => n?.title.toLowerCase() === query.toLowerCase())
  if (!query || containsSearchOperator(query) || exact) {
    createHintEl.classList.add('hidden')
    return
  }
  const targeted = folderTargetedCreation(query)
  createHintEl.textContent = targeted
    ? `Press ⏎ to create “${targeted.title}” in ${targeted.folder}`
    : `Press ⏎ to create “${query}”`
  createHintEl.classList.remove('hidden')
}

async function captureToInbox(title: string) {
  const note = await invoke<NoteDto>('create_inbox_note', { title })
  void refreshCompletionSources()
  // Back to a bare "inbox:" — you're still in the box, ready for the next
  // thought, rather than leaving the last capture sitting there looking like
  // a filter.
  searchInput.value = 'inbox:'
  await runSearch()
  await openNote(note.id)
  highlighted = Math.max(0, await indexOfNote(note.id))
  await ensureLoaded(highlighted)
  renderList()
  view.focus()
}

// --- Tag ghost-text ----------------------------------------------------------
// Typing "tag:tec" shows the rest of "technology" ahead of the caret; Tab or
// Right accepts it. Ghost text rather than a dropdown: a list would cover the
// note list, which is the thing you're narrowing.

const searchGhostEl = document.getElementById('search-ghost')!
let knownTags: string[] = []
let knownFolders: string[] = []
let knownTitles: string[] = []

/// Whether the store handed back a different set of titles. A length check
/// then an element-wise compare: N string comparisons against N `toLowerCase`
/// allocations plus a Set rebuild, on a list that almost never changes between
/// refreshes. Order is stable (the store returns them by recency), so a plain
/// positional compare is enough.
function titlesUnchanged(next: string[]): boolean {
  if (next.length !== knownTitles.length) return false
  for (let i = 0; i < next.length; i++) if (next[i] !== knownTitles[i]) return false
  return true
}

function updateKnownTitles(titles: string[]) {
  // The lowercased set is what wiki-link styling consults, and the restyle is
  // what makes a ghost link resolve the moment its target exists — but neither
  // means anything when the titles came back identical, and a restyle of the
  // open note is not free.
  if (titlesUnchanged(titles)) return
  knownTitles = titles
  knownTitlesLower = new Set(titles.map((t) => t.toLowerCase()))
  // Nothing in the open note's text changed, so nudge the styler to repaint —
  // otherwise a link stays a ghost after its target is created (or keeps its
  // resolved styling after the target is deleted) until the next keystroke.
  view.dispatch({ effects: restyle.of(null) })
}

/// Which operators complete their argument as you type, and where each draws
/// its suggestions from — matching the Mac's 1.8.4 autofill. `tag:`/`folder:`
/// complete from your real lists; `link:`/`interlink:`/`title:` complete note
/// titles by recency.
///
/// The `-` polarity of each completes too: excluding a folder or tag you have
/// wants the same help as including it.
interface CompletionSpec {
  /// Case-sensitivity of the source. Tags and folders are matched lowercased
  /// (that's how the operators match); titles keep their case so the ghost
  /// reads as the real title.
  source: () => string[]
  lower: boolean
}

const COMPLETION_OPERATORS: Record<string, CompletionSpec> = {
  'tag:': { source: () => knownTags, lower: true },
  'folder:': { source: () => knownFolders, lower: true },
  'link:': { source: () => knownTitles, lower: false },
  'interlink:': { source: () => knownTitles, lower: false },
  'title:': { source: () => knownTitles, lower: false },
}

/// Refreshes the autofill sources — and, through `updateKnownTitles`, the set
/// the styler uses to tell a resolved wiki-link from a ghost.
///
/// Three IPC calls and a whole-vault title projection, which is far too much to
/// run per keystroke: this used to fire from every search, so typing in the box
/// re-listed every title in the vault on each debounce tick. The note set only
/// changes when something changes it, so this runs at startup, on
/// `index-changed` (anything outside the app), and after each in-app create,
/// rename, move or delete — an in-app move being suppressed from the watcher is
/// exactly why those explicit calls have to be there.
async function refreshCompletionSources() {
  try {
    const [tags, folders, titles] = await Promise.all([
      invoke<string[]>('all_tags'),
      invoke<string[]>('list_subfolders'),
      invoke<string[]>('all_titles'),
    ])
    knownTags = tags
    knownFolders = folders
    // Colours only mean anything once folders are listed — the same gate the
    // Mac's rebuildFolderColors keeps.
    if (settings.includeSubfolders) ensureFolderColors(folders)
    // Routes through the setter so the ghost-link title set and a restyle come
    // along with the new titles.
    updateKnownTitles(titles)
  } catch (err) {
    console.error('could not refresh autofill sources', err)
  }
}

/// The completion (the part after what's typed) for the operator argument being
/// typed at the very end of the box, or null.
///
/// Only the token at the caret, and only when the caret is at the end — a ghost
/// offered mid-string would insert where the caret isn't. The whole argument is
/// matched, spaces included, so `link:Rust Gu` completes a multi-word title;
/// the accept step re-quotes anything with a space.
function ghostCompletion(): string | null {
  const value = searchInput.value
  if (searchInput.selectionStart !== value.length) return null
  for (const [op, spec] of Object.entries(COMPLETION_OPERATORS)) {
    // The argument runs from the operator to the end of the box. Preceded by
    // start-or-space, and an optional `-`, and an optional opening quote.
    const re = new RegExp(`(^|\\s)-?${op}"?(.*)$`)
    const m = value.match(re)
    if (!m) continue
    const fragment = m[2]
    if (!fragment) return null
    const needle = spec.lower ? fragment.toLowerCase() : fragment
    const pool = spec.source()
    const hit = pool.find((candidate) => {
      const c = spec.lower ? candidate.toLowerCase() : candidate
      return c.startsWith(needle) && c !== needle
    })
    return hit ? hit.slice(fragment.length) : null
  }
  return null
}

function renderGhost() {
  const rest = ghostCompletion()
  searchGhostEl.textContent = rest ? searchInput.value + rest : ''
  searchGhostEl.classList.toggle('hidden', !rest)
}

/// The box's value with the current ghost accepted, quoting the argument if the
/// completed value contains a space.
///
/// The quote isn't cosmetic: an unquoted space would tokenize `folder:Client
/// Work` into two terms. It also flips the argument to the operators' *exact*
/// match, which is the right default for a name you picked whole from a list —
/// clicking a real folder should mean that folder, not a substring of it.
function acceptCompletion(): string {
  const rest = ghostCompletion()
  if (rest === null) return searchInput.value
  const completed = searchInput.value + rest
  const m = completed.match(/^(.*?(?:^|\s)-?(?:tag|folder|link|interlink|title):)"?(.*)$/)
  if (!m || !m[2].includes(' ')) return completed
  return `${m[1]}"${m[2]}"`
}

searchInput.addEventListener('input', () => {
  renderGhost()
  scheduleSearch()
})
searchInput.addEventListener('blur', () => searchGhostEl.classList.add('hidden'))

/// Whichever list is on screen — notes, or templates while `template:` is
/// typed. Arrowing has to move through what's actually shown.
function currentListLength(): number {
  if (templateFragment() !== null) return templateResults.length
  if (trashFragment() !== null) return trashResults.length
  if (catalogMode() !== null) return catalogRows.length
  return results.length
}
function renderCurrentList() {
  const catalog = catalogMode()
  if (templateFragment() !== null) renderTemplateList()
  else if (trashFragment() !== null) renderTrashList()
  else if (catalog !== null) renderCatalog(catalog)
  else renderList()
}

searchInput.addEventListener('keydown', (e) => {
  // Plain or Shift-modified arrows only: Alt+Up/Down is the area cycle, and
  // a chord that moves focus must not also move the highlight.
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    const dir = e.key === 'ArrowDown' ? 1 : -1
    const shift = e.shiftKey
    afterPendingSearch(() => void arrowNavigate(dir, shift))
  } else if (e.key === 'Enter') {
    e.preventDefault()
    afterPendingSearch(() => void openOrCreate())
  } else if (e.key === 'Escape') {
    searchInput.value = ''
    void runSearch()
  } else if ((e.key === 'Tab' || e.key === 'ArrowRight') && ghostCompletion()) {
    // Accepts the ghost. Right-arrow as well as Tab because the caret is
    // already at the end, so "move right" and "take the suggestion" are the
    // same gesture there.
    e.preventDefault()
    searchInput.value = acceptCompletion()
    renderGhost()
    void runSearch()
  } else if (e.key === 'Backspace' && e.altKey) {
    // Alt+Backspace clears the whole box — the Mac's ⌥⌫. Faster than
    // selecting and deleting when a long operator query has stopped being
    // useful.
    e.preventDefault()
    searchInput.value = ''
    void runSearch()
  }
})

// Arrow-key list navigation when the search box does *not* hold focus. After
// clicking a note or a catalog row, focus sits on the body, and without this
// the arrows would fall through to the browser and merely scroll the list
// instead of moving the selection — the thing the Mac's list does with them.
// The editor keeps its own arrows for the cursor, and so do the search and
// title fields and any open overlay, so this only steps in when the list is
// what you're looking at.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  if (e.defaultPrevented) return
  // Alt+Up/Down cycles focus areas; it is not a list move.
  if (e.altKey || e.ctrlKey || e.metaKey) return
  if (view.hasFocus) return
  const active = document.activeElement as HTMLElement | null
  if (active) {
    const tag = active.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return
  }
  // Don't move the list behind a dialog that has taken over the screen.
  if (
    !settingsEl.classList.contains('hidden') ||
    isDialogOpen() ||
    !referenceEl.classList.contains('hidden')
  ) {
    return
  }
  e.preventDefault()
  void arrowNavigate(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
})

// --- Focus areas -------------------------------------------------------------
// Search → list → editor, wrapping both ways: the cycle the Mac app has on
// ⌥↑/⌥↓, and the one Omarchy's own panels use. The list is the piece that had
// no keyboard identity before — arrows moved its highlight, but focus never
// actually lived there, so Return, Delete and a context menu had nothing to
// hang off and the "focused area" was a guess based on what *wasn't* focused.

type FocusArea = 'search' | 'list' | 'editor'
const FOCUS_ORDER: FocusArea[] = ['search', 'list', 'editor']

function currentArea(): FocusArea {
  if (panes.some((p) => p.view.hasFocus)) return 'editor'
  const active = document.activeElement
  if (active && listPaneEl.contains(active)) return 'list'
  // Anything else — the search box, the title field, or nothing at all —
  // counts as the search end of the cycle, so focus that has ended up
  // somewhere odd still steps somewhere predictable rather than nowhere.
  return 'search'
}

function focusArea(area: FocusArea) {
  if (area === 'search') {
    searchInput.focus()
    searchInput.select()
  } else if (area === 'list') {
    // `preventScroll`: the list is its own scroller and focusing it must not
    // yank the viewport away from the row the highlight is on.
    listEl.focus({ preventScroll: true })
  } else {
    view.focus()
  }
}

function cycleArea(delta: 1 | -1) {
  const at = FOCUS_ORDER.indexOf(currentArea())
  focusArea(FOCUS_ORDER[(at + delta + FOCUS_ORDER.length) % FOCUS_ORDER.length])
}

// --- The list's own keyboard --------------------------------------------------
// Only while the list actually holds focus, which is either after Alt+Down onto
// it or after clicking a row (a row is a plain div, so the click lands focus on
// the nearest focusable ancestor — the list itself). Everything here calls
// `preventDefault`, which is also what stops the body-level arrow fallback
// above from moving the highlight a second time.

/// A page of rows, minus one of overlap so the row you were reading is still on
/// screen after the jump. The same measure the list's virtualisation uses.
function listPageStep(): number {
  return Math.max(1, Math.floor(listViewport() / rowHeight) - 1)
}

/// Big enough to clamp to either end of any list, without `Infinity` — the
/// callee adds it to an index before clamping, and `Infinity` there would make
/// an arithmetic NaN out of a perfectly ordinary "go to the end".
const LIST_JUMP = 1e9

listEl.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return
  if (document.activeElement !== listEl) return
  // Not behind a dialog or the settings panel — they are what the keyboard is
  // for while they are up.
  if (!settingsEl.classList.contains('hidden') || isDialogOpen()) return
  if (!referenceEl.classList.contains('hidden')) return
  if (e.ctrlKey || e.altKey || e.metaKey) return

  const nav = (delta: number, extend: boolean) => {
    e.preventDefault()
    afterPendingSearch(() => void arrowNavigate(delta, extend))
  }

  switch (e.key) {
    case 'ArrowDown':
      return nav(1, e.shiftKey)
    case 'ArrowUp':
      return nav(-1, e.shiftKey)
    // j/k alongside the arrows, the Omarchy convention. Safe here in a way it
    // would not be anywhere else in the app: the list is not a text field, so
    // a bare letter has nothing else it could mean.
    case 'j':
      return nav(1, false)
    case 'k':
      return nav(-1, false)
    case 'PageDown':
      return nav(listPageStep(), e.shiftKey)
    case 'PageUp':
      return nav(-listPageStep(), e.shiftKey)
    case 'End':
      return nav(LIST_JUMP, e.shiftKey)
    case 'Home':
      return nav(-LIST_JUMP, e.shiftKey)
    case 'Enter':
      e.preventDefault()
      afterPendingSearch(() => void activateHighlighted())
      return
    case 'Escape':
      // One layer: back to the search box, which is where the list was entered
      // from. It does not also clear the query — that is the search box's own
      // Escape, one press further on.
      e.preventDefault()
      focusArea('search')
      return
    case 'Delete':
      // Notes only. `deleteSelection` acts on the note results, and the trash,
      // template and catalog lists are showing something else entirely — a
      // Delete there would quietly bin whatever happened to sit at the same
      // index in a list nobody is looking at.
      if (templateFragment() !== null || trashFragment() !== null || catalogMode() !== null) {
        return
      }
      // Deliberately the same handler the Ctrl+Backspace shortcut runs, not a
      // second copy of it: whatever confirmation or flush that path grows, the
      // list's Delete grows with it.
      e.preventDefault()
      SHORTCUT_HANDLERS.deleteNote?.()
      return
    default:
      return
  }
})

/// Return in the list: opens what the highlight is on, in whichever list is
/// showing.
///
/// Deliberately not `openOrCreate` — that is the *search box's* Return, and its
/// "no exact match, so make one" half would mint a note out of the query when
/// all you did was press Return on a row that was already there.
async function activateHighlighted() {
  if (templateFragment() !== null) {
    await openHighlightedTemplate()
    return
  }
  // A trash row has no editor to drop into; its preview is already showing.
  if (trashFragment() !== null) return
  const catalog = catalogMode()
  if (catalog !== null) {
    // Return on a tag or folder pivots the search to it, exactly as clicking
    // the row does. Focus stays in the list, which is where the results land.
    const row = catalogRows[highlighted]
    if (!row) return
    searchInput.value = `${catalog}:"${row.name}"`
    await runSearch()
    return
  }
  // The Mac's list drops into the editor on Return. The note under the
  // highlight is already open (the editor follows the highlight), so this is a
  // focus move with a guarantee attached rather than a load.
  await openHighlighted()
  focusArea('editor')
}

// --- The note menu, from the keyboard ----------------------------------------

/// The row the highlight is on, wherever it is drawn — the sticky pinned strip
/// counts, since a pinned note is highlighted there rather than in the list.
function highlightedRowEl(): HTMLElement | null {
  return listPaneEl.querySelector<HTMLElement>('.row.highlighted')
}

/// The same menu a right-click on the highlighted row would raise, anchored to
/// the row so it opens where the eye already is.
function openHighlightedNoteMenu(options: OpenMenuOptions = {}) {
  // Only the ordinary note list. Trash, templates and the catalogs each have
  // their own menu over their own rows, and raising a note menu over them
  // would act on something other than what is highlighted.
  if (templateFragment() !== null || trashFragment() !== null || catalogMode() !== null) return
  const note = results[highlighted]
  if (!note) return
  const row = highlightedRowEl()
  const r = (row ?? listEl).getBoundingClientRect()
  const selection = fullSelection()
  const items =
    selection.length > 1 && selection.includes(note.id)
      ? bulkMenuItems(selection.length)
      : noteMenuItems(note)
  openContextMenu(r.left + 12, r.bottom - 2, items, options)
}

// Shift+F10 and the Menu key: the two chords every desktop toolkit answers with
// a context menu. Not in the remappable table on purpose — they are the
// platform's spelling of "menu for this thing", the way Escape is the
// platform's spelling of "back out".
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return
  if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return
  if (!settingsEl.classList.contains('hidden') || isDialogOpen()) return
  if (view.hasFocus) return
  e.preventDefault()
  openHighlightedNoteMenu()
})

// --- Divider ------------------------------------------------------------------
// The split is draggable, and a drag is not something a keyboard can do. With
// the divider in the Tab order it needs keys of its own or it is a focus stop
// that does nothing.


/// Moves the split by `deltaPx`, positive meaning "give the list more room".
/// Clamped exactly as the drag is, so neither pane can be keyed away entirely.
function resizeSplit(deltaPx: number) {
  const box = panesEl.getBoundingClientRect()
  if (layoutMode === 'vertical') {
    const current = storedNumber('verticalSplitFraction', DEFAULT_TOP_FRACTION)
    const fraction = Math.min(0.9, Math.max(0.1, current + deltaPx / Math.max(1, box.height)))
    localStorage.setItem('verticalSplitFraction', String(fraction))
  } else {
    const current = storedNumber('horizontalListWidth', DEFAULT_LIST_WIDTH)
    const width = Math.min(box.width - 240, Math.max(MIN_LIST_WIDTH, current + deltaPx))
    localStorage.setItem('horizontalListWidth', String(width))
  }
  applyLayout()
}

dividerEl.addEventListener('keydown', (e) => {
  // The axis follows the layout, so the key that moves the divider is always
  // the one that points along it: Up/Down when the list sits above the editor,
  // Left/Right when it sits beside it.
  const grow = layoutMode === 'vertical' ? 'ArrowDown' : 'ArrowRight'
  const shrink = layoutMode === 'vertical' ? 'ArrowUp' : 'ArrowLeft'
  if (e.key === grow) resizeSplit(DIVIDER_STEP_PX)
  else if (e.key === shrink) resizeSplit(-DIVIDER_STEP_PX)
  // Home/End snap to the extremes — the clamp is what makes them extremes
  // rather than "off screen", so this is the same call with a step nothing can
  // exceed.
  else if (e.key === 'Home') resizeSplit(-1e6)
  else if (e.key === 'End') resizeSplit(1e6)
  else return
  e.preventDefault()
})

async function restoreDeleted() {
  const restored = await invoke<NoteDto[]>('restore_last_deleted')
  await runSearch()
  if (restored.length > 0) {
    highlighted = Math.max(0, await indexOfNote(restored[0].id))
    await ensureLoaded(highlighted)
    renderList()
  }
}

// --- Renaming ---------------------------------------------------------------
// The title bar *is* the rename field — a note's title is its filename, so
// there's nothing else it could edit. Committing runs the store's rename,
// which rewrites every [[link]] and ![[embed]] pointing at the old title
// across the Index.

async function commitRename() {
  if (!activePane.noteId) return
  const next = titleEl.value.trim()
  const current = activePane.dto?.title ?? ''
  if (!next || next === current) {
    titleEl.value = current
    return
  }
  try {
    const renamed = await invoke<NoteDto>('rename_note', { id: activePane.noteId, title: next })
    // The file moved, so its id did too — carry any pin across with it.
    const twins = panesShowing(activePane.noteId)
    migratePin(activePane.noteId, renamed.id)
    for (const pane of twins) {
      pane.noteId = renamed.id
      pane.dto = renamed
    }
    renderPaneCaptions()
    // The sanitizer may have changed what was typed — a title Windows can't
    // represent as a filename comes back altered, and showing the typed text
    // would be a lie about what's on disk.
    titleEl.value = renamed.title
    // A rename changes both what completes and what links to this note, and
    // neither can wait for the idle debounce — the panel is showing the old
    // title right now.
    void refreshCompletionSources()
    void refreshInterlinks()
    await runSearch()
    highlighted = Math.max(0, await indexOfNote(renamed.id))
    await ensureLoaded(highlighted)
    renderList()
  } catch (e) {
    console.error('rename failed', e)
    titleEl.value = current
  }
}

titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    void commitRename().then(() => view.focus())
  } else if (e.key === 'Escape') {
    e.preventDefault()
    titleEl.value = activePane.dto?.title ?? ''
    view.focus()
  }
})
titleEl.addEventListener('blur', () => void commitRename())

// Hovering a truncated title scrolls it, so a long name can be read without
// renaming or resizing. Only when it actually overflows, and never while the
// field is focused — once it's the rename box, the caret drives scrolling and
// two things fighting over scrollLeft is worse than truncation.
let titleScroll: number | undefined
titleEl.addEventListener('mouseenter', () => {
  if (document.activeElement === titleEl) return
  const overflow = titleEl.scrollWidth - titleEl.clientWidth
  if (overflow <= 0) return
  titleEl.classList.add('scrolling')
  const started = performance.now()
  const step = (now: number) => {
    // A slow there-and-back sweep with a pause at each end, so the start and
    // end of the title are both readable rather than flying past.
    const t = ((now - started) / 1000) % 8
    const eased = t < 1 ? 0 : t < 4 ? (t - 1) / 3 : t < 5 ? 1 : (8 - t) / 3
    titleEl.scrollLeft = overflow * Math.min(1, Math.max(0, eased))
    titleScroll = requestAnimationFrame(step)
  }
  titleScroll = requestAnimationFrame(step)
})
titleEl.addEventListener('mouseleave', () => {
  if (titleScroll !== undefined) cancelAnimationFrame(titleScroll)
  titleScroll = undefined
  titleEl.classList.remove('scrolling')
  titleEl.scrollLeft = 0
})

function closeEditor() {
  activePane.noteId = null
  activePane.dto = null
  activePane.external = null
  activePane.savedContent = ''
  titleEl.value = ''
  titleEl.disabled = false
  dueEl.textContent = ''
  tagsEl.replaceChildren()
  renderTitleBarFolder(null)
  fleetingActionsEl.classList.add('hidden')
  templateActionsEl.classList.add('hidden')
  syncEmptyState()
  renderPaneCaptions()
  currentInterlinks = { links: [], backlinks: [], suggested: [] }
  renderInterlinks()
  renderStats()
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: '' },
    effects: editable.reconfigure(EditorView.editable.of(false)),
  })
}

// Every app-level binding, dispatched through the shortcut registry rather
// than by testing keys here. A handler that checks `e.key === 'l'` directly is
// a binding nobody can remap and nobody can find.
const SHORTCUT_HANDLERS: Partial<Record<ShortcutId, () => void>> = {
  togglePin,
  pinToTray: () => void toggleTrayPin(),
  centerWindow: () => void centreWindow(),
  openSettings: () => {
    if (settingsEl.classList.contains('hidden')) openSettings()
    else closeSettings()
  },
  // Delete is Ctrl+Backspace rather than the bare Del key Windows convention
  // would suggest: inside the editor Del is forward-delete, and a shortcut
  // that destroys the note you are typing in depending on focus is a bad
  // trade for idiom.
  deleteNote: () => void deleteSelection(),
  restoreDeletedNote: () => void restoreDeleted(),
  zoomIn: () => setZoom(editorZoom + 0.1),
  zoomOut: () => setZoom(editorZoom - 0.1),
  actualSize: () => setZoom(1),
  togglePlainTextMode: () => {
    setPlainTextMode(!plainTextMode)
    // Keep the Settings checkbox honest if the panel happens to be open.
    checkbox('setting-plain-text').checked = plainTextMode
  },
  toggleInterlinks: () => interlinksToggleEl.click(),
  toggleLayout,
  jumpToSearch: () => {
    searchInput.focus()
    searchInput.select()
  },
  clearSearch: () => {
    searchInput.value = ''
    void runSearch()
  },
  // The Mac's newFromTemplateRequested does exactly this — puts "template:" in
  // the search field and focuses it. The template list is already what that
  // query shows, so the shortcut is a way into it rather than a separate mode.
  newFromTemplate: () => {
    searchInput.value = 'template:'
    searchInput.focus()
    void runSearch()
  },
  extractToNote: () => void extractSelectionToNote(),
  insertImage: () => {
    if (activePane.noteId || activePane.external) {
      void openImagePicker((name) => insertImageReference(name, view))
    }
  },
  insertTable: () => {
    if (activePane.noteId || activePane.external) insertTable(view)
  },
  focusNextArea: () => cycleArea(1),
  focusPreviousArea: () => cycleArea(-1),
  toggleSplit: () => void toggleSplit(),
  switchPane: focusOtherPane,
  flipSplit,

  // --- The editor actions that used to need a mouse ---------------------------

  followLink: () => {
    if (!view.hasFocus) return
    followLinkAtCaret()
  },
  peekLink: () => {
    if (!view.hasFocus || settings.linkPreview === 'off') return
    const head = view.state.selection.main.head
    const target = wikiLinkTargetAt(view, head)
    if (!target) return
    // Anchored under the caret, where Alt-click would have anchored it under
    // the pointer — the preview should appear next to the link, not at a
    // corner of the window.
    const c = view.coordsAtPos(head)
    void showLinkPreview(target, c?.left ?? 0, c?.bottom ?? 0)
  },
  toggleCheckbox: () => {
    if (!activePane.noteId && !activePane.external) return
    // Returns false when the caret line has no checkbox, which is a no-op
    // rather than an error — the same as clicking where there is no box.
    toggleTaskAtCursor(view)
  },
  retireDue: () => {
    if (!activePane.noteId && !activePane.external) return
    const pos = dueTokenPosForCaret()
    if (pos !== null) toggleDueToken(view, pos)
  },
  emojiForLink: () => {
    if (!activePane.noteId && !activePane.external) return
    const found = urlNearCaret(false)
    const domain = found ? urlDomain(found.url) : null
    if (!found || !domain) return
    const c = view.coordsAtPos(found.from)
    openContextMenu(c?.left ?? 0, (c?.bottom ?? 0) + 4, domainEmojiMenu(domain))
  },
  popOut: () => {
    // The open note first, then the highlight — with the editor focused the
    // note you mean is the one you are looking at, and the two are the same
    // note in every case but a list that has moved on without being opened.
    const id = activePane.noteId ?? results[highlighted]?.id
    if (!id) return
    void invoke('pop_out_note', { id, innerSize: storedPopoutSize() })
  },
  moveToFolder: () => {
    // Filing into a folder the list then hides would look like deleting the
    // note, which is why the menu item is conditional too.
    if (!settings.includeSubfolders) return
    openHighlightedNoteMenu({ submenu: 'Move to' })
  },
  toggleHelp: () => toggleReference(),
}

/// The keyboard half of Ctrl-click, in the same order of preference the click
/// handler uses: an in-note jump first (a footnote reference, a `#heading`
/// anchor), then an outbound markdown link, then a wiki-link or attachment,
/// then a bare URL. No modifier gate — asking for the link *is* the modifier
/// here, so `requireModifierForLinkClick` has nothing to decide.
function followLinkAtCaret(): boolean {
  const pos = view.state.selection.main.head
  const doc = view.state.doc.toString()

  const footnote = footnoteRefAt(view, pos)
  if (footnote) {
    const range = footnoteDefinitionRange(doc, footnote)
    if (range) {
      jumpToRange(range)
      return true
    }
  }
  const mdLink = markdownLinkAt(view, pos)
  if (mdLink?.url.startsWith('#')) {
    const range = headingRangeForSlug(doc, mdLink.url.slice(1))
    if (range) {
      jumpToRange(range)
      return true
    }
  }
  if (mdLink && /^https?:\/\//i.test(mdLink.url)) {
    void invoke('open_external_url', { url: mdLink.url })
    return true
  }
  const target = wikiLinkTargetAt(view, pos)
  if (target) {
    // An `![[image.png]]` target is an attachment, not a note — open the file
    // rather than resolving (and ghost-creating) a note by that name.
    if (isImageTarget(target)) void invoke('open_attachment', { name: target })
    else void followLink(target)
    return true
  }
  const bare = urlNearCaret(true)
  if (bare) {
    void invoke('open_external_url', { url: bare.url })
    return true
  }
  return false
}

/// A bare URL — the thing the styler draws as a pill — at the caret, or, when
/// `insideOnly` is off, the nearest one on the caret's own line.
///
/// Line-bounded on purpose: "nearest" across a whole note is a guess, and
/// silently giving an emoji to a link three paragraphs away is worse than
/// doing nothing. Reading the document rather than hunting for the pill widget
/// in the DOM keeps this working for a link scrolled out of the viewport,
/// where no widget exists to find.
const BARE_URL_RE = /https?:\/\/[^\s<>()[\]]+/gi

function urlNearCaret(insideOnly: boolean): { url: string; from: number; to: number } | null {
  const doc = view.state.doc.toString()
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  let best: { url: string; from: number; to: number } | null = null
  let bestDistance = Infinity
  BARE_URL_RE.lastIndex = 0
  for (const m of doc.matchAll(BARE_URL_RE)) {
    const from = m.index!
    const to = from + m[0].length
    if (to < line.from || from > line.to) continue
    const distance = head < from ? from - head : head > to ? head - to : 0
    if (insideOnly && distance > 0) continue
    if (distance < bestDistance) {
      bestDistance = distance
      best = { url: m[0], from, to }
    }
  }
  return best
}

/// Where to apply the due-date toggle: the token the caret is in, else the
/// first one on the caret's line, else the note's own first due date — which
/// is what "retire the due date" means when the caret is nowhere near one.
function dueTokenPosForCaret(): number | null {
  const doc = view.state.doc.toString()
  const head = view.state.selection.main.head
  if (dueTokenAt(doc, head)) return head
  // Only positions that could start a token are worth asking about; `dueTokenAt`
  // rescans the whole document per call, so a character-by-character sweep of a
  // long note would be needless work.
  const line = view.state.doc.lineAt(head)
  for (let i = line.from; i < line.to; i++) {
    if (doc[i] === '@' && dueTokenAt(doc, i + 1)) return i + 1
  }
  for (let i = 0; i < doc.length; i++) {
    if (doc[i] === '@' && dueTokenAt(doc, i + 1)) return i + 1
  }
  return null
}

/// Splits the selection off into a note of its own, leaving a `[[link]]` behind.
///
/// The replacement goes through a normal editor transaction rather than being
/// written around it, so the split lands on the undo stack as one step and
/// triggers the ordinary save and restyle — the same reason the Mac routes it
/// through `shouldChangeText`/`didChangeText` instead of mutating storage
/// directly.
///
/// No naming prompt: the title comes from the selection's first line. This is
/// meant to keep writing flowing, and a dialog in the middle of it would do the
/// opposite — renaming afterwards is one keystroke away if the guess is wrong.
async function extractSelectionToNote() {
  const { from, to } = view.state.selection.main
  if (from === to) return
  const selected = view.state.sliceDoc(from, to)
  if (!selected.trim()) return

  let created: NoteDto
  try {
    created = await invoke<NoteDto>('extract_to_note', {
      selection: selected,
      inInbox: settings.newNotesStartInInbox && settings.inboxEnabled,
    })
  } catch (err) {
    console.error('could not extract the selection', err)
    return
  }

  const link = `[[${created.title}]]`
  view.dispatch({
    changes: { from, to, insert: link },
    // The cursor lands after the link, where writing would naturally carry on,
    // rather than leaving the whole link selected.
    selection: { anchor: from + link.length },
  })
  view.focus()
  // Extraction creates a note and writes a link to it in one move, so both the
  // completion sources and the panel are stale the instant it returns.
  void refreshCompletionSources()
  void refreshInterlinks()
  await runSearch()
}

/// Escape is a layer-peeler before it is a shortcut. Whatever sits closest to
/// the keyboard owns the press — an overlay, a dialog, a menu, a field that
/// already handled it (the list, the title, a completion in the editor) — and
/// only when nothing does is Escape free to be a binding, by default Jump to
/// Search. Without this, closing Settings would also yank focus to the box.
function escapeIsTaken(e: KeyboardEvent): boolean {
  return (
    e.defaultPrevented ||
    !settingsEl.classList.contains('hidden') ||
    !referenceEl.classList.contains('hidden') ||
    !linkPreviewEl.classList.contains('hidden') ||
    isDialogOpen() ||
    contextMenuOpen()
  )
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && escapeIsTaken(e)) return
  for (const [id, run] of Object.entries(SHORTCUT_HANDLERS)) {
    if (!matchesShortcut(id as ShortcutId, e)) continue
    e.preventDefault()
    run?.()
    return
  }
})

window.addEventListener('resize', () => measurePanes())

// The backend rescans and emits; the frontend re-runs its own query rather
// than being handed results, so a reload can't clobber whatever has since been
// typed into the search box.
//
// Bursts are the normal case, not the exception: one action can touch many
// files (an attachment rename rewrites every note that referenced it, a sync
// drops in a folder's worth at once) and the watcher reports each. A trailing
// window collapses the burst into a single refresh, so a hundred events cost
// one search instead of a hundred.
let indexChangedTimer: number | undefined
const INDEX_CHANGED_COALESCE_MS = 300

async function handleIndexChanged() {
  setLoading(true)
  try {
    await runSearch()
  } finally {
    setLoading(false)
  }
  // Titles, tags and folders can only have moved if the index did, so this is
  // where the autofill and wiki-link sources are brought back up to date.
  void refreshCompletionSources()
  // The "always current" half of transclusion: a source note edited elsewhere
  // should update where it's embedded, not keep showing what it looked like
  // when the host note was opened.
  refreshEmbeds()
  // An attachment may have been renamed or replaced under us, so the cached
  // bytes behind every picture are no longer trustworthy.
  invalidateAttachments()
  // Our own save is the likeliest cause of this event, and re-reading a file
  // whose text is already in the buffer is a round trip for nothing.
  if (
    activePane.noteId !== null &&
    activePane.noteId === lastOwnWriteId &&
    Date.now() - lastOwnWriteAt < OWN_WRITE_WINDOW_MS
  ) {
    return
  }
  await reloadOpenNoteFromDisk()
}

void listen('index-changed', () => {
  if (indexChangedTimer !== undefined) clearTimeout(indexChangedTimer)
  indexChangedTimer = window.setTimeout(() => {
    indexChangedTimer = undefined
    void handleIndexChanged()
  }, INDEX_CHANGED_COALESCE_MS)
})

// Summoning should land in the search box — the point of summoning is to type.
// "Keep focus where it was when summoned" — on by default, as on the Mac.
//
// The window is hidden rather than torn down between summons, so whatever had
// focus still has it when it comes back; the setting only decides whether to
// override that. Turning it off sends focus to the search box, which is what
// this did unconditionally before the setting existed.
void listen('summoned', () => {
  if (settings.restoreFocusOnSummon) return
  searchInput.focus()
  searchInput.select()
})

// The popover's "Open" button, and anything else that wants the app brought
// forward on a particular note.
void listen<string>('open-note', async (e) => {
  await openNote(e.payload)
  highlighted = Math.max(0, await indexOfNote(e.payload))
  await ensureLoaded(highlighted)
  renderList()
})

// Tray menu: "New Note" and "Settings…".
void listen('new-note', () => {
  searchInput.focus()
  searchInput.select()
})
void listen('open-settings', () => openSettings())

/// "Last checked …" line for the Updates section, relative like the Mac's
/// RelativeDateTimeFormatter. The timestamp is stamped by the update-checked
/// listener below, so every check — launch, tray, or "Check Now" — feeds it.
function lastCheckedDescription(): string {
  const stored = Number(localStorage.getItem('updateLastCheckedDate'))
  if (!Number.isFinite(stored) || stored <= 0) return 'Last checked: never'
  const diffSec = Math.round((Date.now() - stored) / 1000)
  if (diffSec < 60) return 'Last checked just now'
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const min = Math.round(diffSec / 60)
  if (min < 60) return `Last checked ${rtf.format(-min, 'minute')}`
  const hr = Math.round(min / 60)
  if (hr < 24) return `Last checked ${rtf.format(-hr, 'hour')}`
  return `Last checked ${rtf.format(-Math.round(hr / 24), 'day')}`
}

function renderLastChecked() {
  const label = document.getElementById('setting-update-last-checked')
  if (label) label.textContent = lastCheckedDescription()
}

// Rust fires this when any update check finishes (found nothing, failed, or an
// install was deferred). Stamp now as the last-checked time so the label is
// accurate no matter which path — launch, tray, or button — ran the check.
void listen('update-checked', () => {
  localStorage.setItem('updateLastCheckedDate', String(Date.now()))
  renderLastChecked()
})

// The tray pin can be cleared from the popover or the global unpin shortcut,
// so the marker in the list has to follow rather than assume.
void listen('pinned-note-changed', async () => {
  trayPinnedId = await invoke<string | null>('pinned_note_id')
  if (trayPinnedId) localStorage.setItem('trayPinnedId', trayPinnedId)
  else localStorage.removeItem('trayPinnedId')
  renderList()
})

// Follow Omarchy by default. Dark / Light / System pin the Envious faces as
// a Settings override; System still tracks prefers-color-scheme.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
function syncTheme() {
  markRowHeightDirty()
  applyStoredAppearance()
  applyZoom()
  // A theme file that fails the legibility floors keeps its colours — somebody
  // chose them — but says so, so the file and the screen never disagree
  // silently.
  setFooterNotice('theme', themeNotices())
  void document.fonts.ready.then(() => {
    markRowHeightDirty()
    syncDateColumnWidth(true)
    renderRowWindow(true)
  })
}
function syncFontSettingsRow() {
  const custom = settings.fontSource === 'custom'
  el('setting-font-custom-row').classList.toggle('hidden', !custom)
  const omarchyFont = dropdown('setting-font').querySelector('option[value="omarchy"]')
  if (omarchyFont) (omarchyFont as HTMLOptionElement).hidden = IS_WINDOWS
}

// --- Font family picker ------------------------------------------------------
// A list rather than a field to type a name into: nobody knows what fontconfig
// calls the fonts on their machine, and a typo silently falls back to the
// browser default. Fetched each time the panel opens — fc-list is quick, and
// a font installed while Envy runs should show up.

interface FontFamily {
  name: string
  mono: boolean
}
let fontFamilies: FontFamily[] = []

async function refreshFontFamilies() {
  try {
    fontFamilies = await invoke<FontFamily[]>('font_families')
  } catch (err) {
    console.error('could not list font families', err)
    fontFamilies = []
  }
  syncFontFamilyOptions()
}

/// Rebuilds the picker: monospace families, then everything else, with the
/// configured name selected. A name fontconfig doesn't list (a font since
/// removed, or one typed into config.md) stays selectable as its own entry so
/// opening Settings never changes what the file says.
function syncFontFamilyOptions() {
  const select = dropdown('setting-font-custom')
  const current = settings.fontCustom
  select.replaceChildren()
  const add = (parent: HTMLElement, value: string, label = value) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    parent.append(option)
  }
  if (!current) add(select, '', 'Choose a family…')
  else if (!fontFamilies.some((f) => f.name === current)) add(select, current, `${current} (not installed)`)
  const group = (label: string, families: FontFamily[]) => {
    if (families.length === 0) return
    const g = document.createElement('optgroup')
    g.label = label
    for (const f of families) add(g, f.name)
    select.append(g)
  }
  group('Monospace', fontFamilies.filter((f) => f.mono))
  group('Other', fontFamilies.filter((f) => !f.mono))
  select.value = current
}
darkQuery.addEventListener('change', syncTheme)

// --- Footer clock and loading indicator --------------------------------------

const clockEl = document.getElementById('footer-clock')!
const loadingEl = document.getElementById('loading-indicator')!

/// The four clock date formats, matching the Mac's `ClockDateFormat` exactly —
/// the same four cases, in the same order, producing the same shapes.
function formatClockDate(d: Date): string {
  switch (settings.footerClockDateFormat) {
    case 'medium':
      return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
    case 'full':
      return d.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    case 'numeric':
      return d.toLocaleDateString(undefined, {
        month: 'numeric',
        day: 'numeric',
        year: 'numeric',
      })
    default:
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
}

/// Whether the window currently fills the screen.
///
/// macOS has a real full-screen mode a window is either in or not. Windows has
/// both true full screen and maximised, and maximised is what someone here
/// means by it, so either counts.
///
/// Asked of the window rather than inferred by comparing `outerWidth` against
/// `screen.width`. That comparison is not just approximate, it fails *unsafely*:
/// where those values are unavailable they are all zero, zero matches zero, and
/// it concludes the window is full screen — so the setting silently stops
/// hiding anything. Both calls are read-only and already in `core:window:default`.
async function isFullScreen(): Promise<boolean> {
  try {
    // Rust asks the compositor. GTK's own "maximized" answered yes for any
    // tiled window on Hyprland, and its fullscreen flag only knew about
    // fullscreen the app requested itself, so the clock never hid.
    return await invoke<boolean>('main_window_fullscreen')
  } catch {
    // Outside Tauri. Reporting "not full screen" keeps the clock visible rather
    // than hiding it for a reason that cannot be checked.
    return false
  }
}

/// Ticks on a timer rather than being computed once — a clock rendered from a
/// value read at startup freezes at whatever time the app happened to open.
let clockTimer: number | undefined
function startClockTick() {
  const tick = async () => {
    if (!settings.showFooterClock) {
      clockEl.classList.add('hidden')
      return
    }
    // "Only in full screen" is for people who want the clock exactly when the
    // window is covering the one in the system tray, and not otherwise.
    if (settings.showFooterClockOnlyWhenFullScreen && !(await isFullScreen())) {
      clockEl.classList.add('hidden')
      return
    }
    const now = new Date()
    const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    clockEl.textContent = settings.showFooterClockDate
      ? `${formatClockDate(now)} · ${time}`
      : time
    clockEl.classList.remove('hidden')
  }
  void tick()
  window.clearInterval(clockTimer)
  // Every 30s, matching the Mac's own cadence — a minute-resolution clock
  // doesn't need per-second work, but a 60s tick can show a stale minute for
  // almost a whole one.
  clockTimer = window.setInterval(() => void tick(), 30_000)
}
// Entering or leaving full screen resizes the window; re-check then rather
// than waiting for the next 30-second tick.
window.addEventListener('resize', () => {
  if (settings.showFooterClock && settings.showFooterClockOnlyWhenFullScreen) startClockTick()
})

// --- Footer notices ---------------------------------------------------------
// One line in the footer for the things the app noticed but shouldn't
// interrupt anybody about: a problem in config.md, a theme file whose colours
// don't read. Keyed by source so one can be replaced without losing the other,
// and only the first is shown — the rest are counted, and all of them are in
// the tooltip and the console.

const noticeEl = document.getElementById('footer-notice')!
const footerNotices = new Map<string, string[]>()

function setFooterNotice(source: string, lines: string[]) {
  if (lines.length === 0) footerNotices.delete(source)
  else footerNotices.set(source, lines)
  const all = [...footerNotices.values()].flat()
  noticeEl.textContent =
    all.length === 0 ? '' : all.length === 1 ? all[0] : `${all[0]} (+${all.length - 1} more)`
  noticeEl.title = all.join('\n')
  noticeEl.classList.toggle('hidden', all.length === 0)
}

/// Shown while a rescan is in flight. It lives in the footer rather than above
/// the list, so it can't shift the list's layout every time it appears — a
/// scan over several thousand notes is common enough (external sync, a bulk
/// import) that a moving list would be a constant distraction.
let loadingDepth = 0
function setLoading(active: boolean) {
  loadingDepth = Math.max(0, loadingDepth + (active ? 1 : -1))
  loadingEl.classList.toggle('hidden', loadingDepth === 0 && !indexLoading)
}

let indexLoading = false
function setIndexLoading(loading: boolean) {
  indexLoading = loading
  loadingEl.classList.toggle('hidden', loadingDepth === 0 && !indexLoading)
}

// --- Reference sheets --------------------------------------------------------
// Markup, Shortcuts, Emoji and About. On the Mac these are separate windows off
// the menu bar; here they share one overlay with tabs, so there is one way in
// and nothing permanently occupying the window.

const referenceEl = document.getElementById('reference')!
const referenceTabsEl = document.getElementById('reference-tabs')!
const referenceContentEl = document.getElementById('reference-content')!

const REFERENCE_TABS: Array<[ReferenceTab, string]> = [
  ['markup', 'Markup'],
  ['shortcuts', 'Shortcuts'],
  ['emoji', 'Emoji'],
  ['whatsnew', "What's New"],
  ['about', 'About'],
]

/// Asked of the app itself rather than written down here.
///
/// It used to be the literal "0.1.0", which nothing ever updated — so About
/// went on claiming 0.1.0 while the installed build was 0.1.1, and would have
/// drifted further with every release. A version string that has to be edited
/// by hand in a second place is a version string that will eventually lie, and
/// About is the one screen whose entire job is to answer this accurately.
///
/// "unknown" only shows outside Tauri, where there is no app to ask.
/// Wrapped, not just `.catch()`ed, for the same reason the focus handler below
/// is: outside Tauri these helpers can throw synchronously rather than reject,
/// and an uncaught throw at module scope takes the rest of the script with it.
let appVersion = 'unknown'
try {
  void getVersion()
    .then((v) => {
      appVersion = v
      showWhatsNewIfUpdated(v)
    })
    .catch((err) => console.error('could not read the app version', err))
} catch (err) {
  console.error('could not read the app version', err)
}

/// Opens What's New the first time a given version runs, and never again.
///
/// The stored version is written *before* the panel opens, not after, so a
/// crash or a quit while reading it doesn't queue the same announcement up for
/// every launch that follows. Seen once is seen.
///
/// A fresh install has no stored version and so would be shown release notes
/// for a build it has no history with — the Mac has the same shape, but there
/// the empty string is also what a first launch sees, and it treats that as
/// "record the version, say nothing".
function showWhatsNewIfUpdated(version: string) {
  if (!version || version === 'unknown') return
  const seen = localStorage.getItem('lastSeenWhatsNewVersion')
  localStorage.setItem('lastSeenWhatsNewVersion', version)
  if (seen === null || seen === version) return
  openReference('whatsnew')
}

function openReference(tab: ReferenceTab) {
  referenceTabsEl.replaceChildren(
    ...REFERENCE_TABS.map(([id, label]) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'reference-tab' + (id === tab ? ' active' : '')
      b.textContent = label
      b.onclick = () => openReference(id)
      return b
    }),
  )
  referenceContentEl.replaceChildren(renderReference(tab, appVersion))
  referenceContentEl.scrollTop = 0
  referenceEl.classList.remove('hidden')
}

function closeReference() {
  referenceEl.classList.add('hidden')
}

document.getElementById('reference-close')!.onclick = closeReference
referenceEl.onclick = (e) => {
  if (e.target === referenceEl) closeReference()
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !referenceEl.classList.contains('hidden')) closeReference()
})

// --- Settings panel ---------------------------------------------------------

const settingsEl = document.getElementById('settings')!
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const checkbox = (id: string) => el<HTMLInputElement>(id)
const dropdown = (id: string) => el<HTMLSelectElement>(id)

function openSettings() {
  // Autostart is the one value whose truth lives outside the app — an XDG
  // autostart entry other tools can change — so it is read from the system
  // each time rather than cached.
  void invoke<boolean>('autostart_enabled').then((on) => {
    checkbox('setting-autostart').checked = on
  })
  recording = null
  syncSettingsControls()
  void refreshFontFamilies()
  settingsEl.classList.remove('hidden')
}

/// Assigns to a text field only when the cursor isn't in it. The panel is
/// re-synced whenever config.md changes, and an agent writing an unrelated key
/// while somebody is halfway through typing a date format should not take the
/// half-typed format away.
function setField(id: string, value: string) {
  const field = el<HTMLInputElement>(id)
  if (document.activeElement !== field) field.value = value
}

/// Puts every control in the panel back in step with the settings. Called when
/// the panel opens and whenever config.md changes underneath it, so the panel
/// is never showing a value the app has stopped using.
function syncSettingsControls() {
  checkbox('setting-preview').checked = settings.showNotePreview
  checkbox('setting-date').checked = settings.showDateModified
  checkbox('setting-due').checked = settings.showDueSort
  checkbox('setting-subfolders').checked = settings.includeSubfolders
  checkbox('setting-focus-editor').checked = settings.moveFocusToEditorOnEnter
  checkbox('setting-keep-pinned-visible').checked = settings.keepPinnedNotesVisible
  checkbox('setting-inbox-enabled').checked = settings.inboxEnabled
  checkbox('setting-inbox-new').checked = settings.newNotesStartInInbox
  checkbox('setting-inbox-in-list').checked = settings.showInboxInMainList
  applyInboxDependentToggles()
  checkbox('setting-footer-words').checked = settings.footerWords
  checkbox('setting-footer-characters').checked = settings.footerCharacters
  checkbox('setting-footer-notes').checked = settings.footerNotes
  checkbox('setting-footer-folders').checked = settings.footerFolders
  checkbox('setting-show-tags').checked = settings.showTagsInTitleBar
  checkbox('setting-show-folder-titlebar').checked = settings.showFolderInTitleBar
  checkbox('setting-folder-trailing').checked = settings.folderDotTrailing
  dropdown('setting-folder-display').value = settings.folderListDisplay
  // The folder-display choices only bite when subfolders are shown, so the
  // control is disabled otherwise — the same gating the Mac's picker uses.
  dropdown('setting-folder-display').disabled = !settings.includeSubfolders
  checkbox('setting-folder-trailing').disabled = !settings.includeSubfolders
  checkbox('setting-show-due-pill').checked = settings.showDuePill
  checkbox('setting-domain-pills').checked = settings.linkDomainPills
  checkbox('setting-require-modifier').checked = settings.requireModifierForLinkClick
  // Not part of `settings`: plain-text mode is its own live variable, toggled
  // by shortcut too, so the checkbox reads that rather than the settings object.
  checkbox('setting-plain-text').checked = plainTextMode
  checkbox('setting-show-interlinks').checked = settings.showBacklinks
  checkbox('setting-hide-on-blur').checked = settings.hideOnFocusLoss
  checkbox('setting-hyprland-bind').checked = settings.hyprlandBind
  checkbox('setting-tiled').checked = settings.tiled
  checkbox('setting-popout-tiled').checked = settings.popoutTiled
  checkbox('setting-restore-focus').checked = settings.restoreFocusOnSummon
  renderLastChecked()
  dropdown('setting-date-style').value = settings.dateDisplayStyle
  dropdown('setting-link-preview').value = settings.linkPreview
  dropdown('setting-density').value = settings.listDensity
  dropdown('setting-text-size').value = String(settings.interfaceTextSize)
  checkbox('setting-fade-focus').checked = settings.fadeFocusHighlight
  checkbox('setting-bold-list').checked = settings.boldFileListText
  checkbox('setting-clock').checked = settings.showFooterClock
  checkbox('setting-clock-date').checked = settings.showFooterClockDate
  checkbox('setting-clock-fullscreen').checked = settings.showFooterClockOnlyWhenFullScreen
  dropdown('setting-clock-date-format').value = settings.footerClockDateFormat
  renderShortcutSettings()
  setField('setting-trash-interval', String(settings.trashEmptyIntervalValue))
  dropdown('setting-trash-unit').value = settings.trashEmptyIntervalUnit
  setField('setting-template-date', settings.templateDateFormat)
  updateTemplateDatePreview()
  dropdown('setting-layout').value = layoutMode
  renderThemeOptions()
  dropdown('setting-font').value = settings.fontSource
  syncFontFamilyOptions()
  setField('setting-font-features', settings.fontFeatures)
  syncFontSettingsRow()
  syncKindleSettings()
  renderConfigSection()
}

/// A live preview, because the token language is the part nobody remembers.
function updateTemplateDatePreview() {
  const pattern = el<HTMLInputElement>('setting-template-date').value
  const now = new Date()
  const map: Record<string, string> = {
    yyyy: String(now.getFullYear()),
    MMMM: now.toLocaleDateString(undefined, { month: 'long' }),
    MM: String(now.getMonth() + 1).padStart(2, '0'),
    dd: String(now.getDate()).padStart(2, '0'),
    EEEE: now.toLocaleDateString(undefined, { weekday: 'long' }),
  }
  // Longest token first, or "MM" would eat the front of "MMMM".
  const rendered = pattern.replace(/yyyy|MMMM|MM|dd|EEEE/g, (t) => map[t] ?? t)
  el('setting-template-date-preview').textContent =
    `Preview: ${rendered}  ·  tokens: yyyy MM dd MMMM EEEE`
}

/// Row padding per density, matching the Mac's own values.
const DENSITY_PADDING: Record<string, string> = { compact: '1px', cozy: '5px', comfy: '10px' }

/// The chrome scale — the list, the search box, the footer. Deliberately not
/// the note text, which has its own zoom: the two are different jobs, and
/// wanting bigger UI is not the same as wanting bigger prose.
function applyChromeSettings() {
  markRowHeightDirty()
  document.documentElement.style.setProperty(
    '--envy-row-padding',
    DENSITY_PADDING[settings.listDensity] ?? DENSITY_PADDING.compact,
  )
  document.documentElement.style.setProperty(
    '--envy-ui-scale',
    String(settings.interfaceTextSize),
  )
  // A class rather than a style property, because it applies to the row's text
  // and not to a value the row is sized by — the Mac passes it into NoteRow as
  // the `bold` flag on every Text in the row.
  document.body.classList.toggle('bold-file-list', settings.boldFileListText)
  syncDateColumnWidth()
}

/// Binds a checkbox to a boolean setting, persisting it and running whatever
/// needs to happen afterwards.
function bindToggle(id: string, key: keyof typeof settings, after?: () => void) {
  checkbox(id).onchange = (e) => {
    const on = (e.target as HTMLInputElement).checked
    ;(settings as Record<string, unknown>)[key] = on
    saveSetting(key, on)
    after?.()
  }
}

function closeSettings() {
  settingsEl.classList.add('hidden')
}

el('settings-close').onclick = closeSettings
settingsEl.onclick = (e) => {
  if (e.target === settingsEl) closeSettings() // click the backdrop to dismiss
}

bindToggle('setting-preview', 'showNotePreview', renderList)
bindToggle('setting-date', 'showDateModified', () => {
  renderSortHeader()
  renderList()
})
bindToggle('setting-due', 'showDueSort', () => {
  renderSortHeader()
  renderList()
})
bindToggle('setting-focus-editor', 'moveFocusToEditorOnEnter')
/// The two inbox toggles below only mean anything while there is an inbox, so
/// they grey out with it — the same `.disabled(!inboxEnabled)` the Mac applies.
function applyInboxDependentToggles() {
  checkbox('setting-inbox-new').disabled = !settings.inboxEnabled
  checkbox('setting-inbox-in-list').disabled = !settings.inboxEnabled
}

/// Tells the store whether Inbox/ is a capture queue or just a folder. The
/// store owns what "fleeting" means — the badge count, the row mark, and the
/// `inbox:` operator all come back from it — so the switch has to reach it,
/// at boot and on every change, before the list is re-run.
async function pushInboxEnabled() {
  try {
    await invoke('set_inbox_enabled', { on: settings.inboxEnabled })
  } catch (err) {
    console.error('could not apply the inbox setting', err)
  }
}

bindToggle('setting-keep-pinned-visible', 'keepPinnedNotesVisible', () => {
  // Switching the strip on lifts the rows out of the scrolling list, so the
  // remembered scroll position no longer points at the same row; re-seat the
  // highlight rather than leave it possibly off screen.
  lastScrolledId = null
  renderList()
})
bindToggle('setting-inbox-enabled', 'inboxEnabled', () => {
  applyInboxDependentToggles()
  void (async () => {
    await pushInboxEnabled()
    await runSearch()
    // The open note's review buttons follow the switch too, rather than
    // waiting for the note to be reopened.
    fleetingActionsEl.classList.toggle(
      'hidden',
      !(activePane.dto?.isInbox && settings.inboxEnabled),
    )
  })()
})
bindToggle('setting-inbox-new', 'newNotesStartInInbox')
bindToggle('setting-inbox-in-list', 'showInboxInMainList', () => void runSearch())
bindToggle('setting-footer-words', 'footerWords', renderStats)
bindToggle('setting-footer-characters', 'footerCharacters', renderStats)
bindToggle('setting-footer-notes', 'footerNotes', () => void refreshVaultCounts())
bindToggle('setting-footer-folders', 'footerFolders', () => void refreshVaultCounts())
bindToggle('setting-show-tags', 'showTagsInTitleBar', () => {
  renderTitleBarTags(activePane.dto?.tags ?? [])
})
bindToggle('setting-show-folder-titlebar', 'showFolderInTitleBar', () => {
  renderTitleBarFolder(activePane.dto?.subfolder ?? null)
})
bindToggle('setting-folder-trailing', 'folderDotTrailing', renderList)
bindToggle('setting-show-due-pill', 'showDuePill', () => {
  renderDueBadge(activePane.dto?.due ?? null)
})
bindToggle('setting-domain-pills', 'linkDomainPills', () =>
  view.dispatch({ effects: restyle.of(null) }),
)
bindToggle('setting-require-modifier', 'requireModifierForLinkClick')
// Plain-text mode isn't a `settings` key (it's a live variable the shortcut
// flips too), so it can't ride bindToggle — wire it straight to the same apply.
checkbox('setting-plain-text').onchange = (e) => {
  setPlainTextMode((e.target as HTMLInputElement).checked)
}
bindToggle('setting-show-interlinks', 'showBacklinks', renderInterlinks)
bindToggle('setting-hide-on-blur', 'hideOnFocusLoss')
// Applied by Rust when the config write lands: it edits bindings.lua and
// reloads Hyprland, which is not the webview's to do.
bindToggle('setting-hyprland-bind', 'hyprlandBind')
// Rust asks Hyprland to float or tile the open windows when these land.
bindToggle('setting-tiled', 'tiled')
bindToggle('setting-popout-tiled', 'popoutTiled')
bindToggle('setting-restore-focus', 'restoreFocusOnSummon')
// The only update check there is: Linux has no background one. `manual: true`
// is what the Rust side acts on. The update-checked event stamps the
// last-checked line.
el('setting-check-updates').onclick = () =>
  void invoke('check_for_updates', { manual: true })

dropdown('setting-date-style').onchange = (e) => {
  settings.dateDisplayStyle = (e.target as HTMLSelectElement).value
  saveSetting('dateDisplayStyle', settings.dateDisplayStyle)
  renderList()
}

dropdown('setting-folder-display').onchange = (e) => {
  settings.folderListDisplay = (e.target as HTMLSelectElement).value
  saveSetting('folderListDisplay', settings.folderListDisplay)
  renderList()
}

dropdown('setting-density').onchange = (e) => {
  settings.listDensity = (e.target as HTMLSelectElement).value
  saveSetting('listDensity', settings.listDensity)
  applyChromeSettings()
}

dropdown('setting-text-size').onchange = (e) => {
  settings.interfaceTextSize = Number((e.target as HTMLSelectElement).value)
  saveSetting('interfaceTextSize', settings.interfaceTextSize)
  applyChromeSettings()
}

bindToggle('setting-fade-focus', 'fadeFocusHighlight', () =>
  document.body.classList.toggle('fade-focus', settings.fadeFocusHighlight),
)
bindToggle('setting-clock', 'showFooterClock', startClockTick)
bindToggle('setting-clock-date', 'showFooterClockDate', startClockTick)
bindToggle('setting-clock-fullscreen', 'showFooterClockOnlyWhenFullScreen', startClockTick)
bindToggle('setting-bold-list', 'boldFileListText', applyChromeSettings)
dropdown('setting-clock-date-format').onchange = (e) => {
  settings.footerClockDateFormat = (e.target as HTMLSelectElement).value
  saveSetting('footerClockDateFormat', settings.footerClockDateFormat)
  startClockTick()
}

dropdown('setting-link-preview').onchange = (e) => {
  settings.linkPreview = (e.target as HTMLSelectElement).value
  saveSetting('linkPreview', settings.linkPreview)
  if (settings.linkPreview === 'off') hideLinkPreview()
}

// Committed on change/blur rather than each keystroke, and clamped 1–99 the way
// the Mac clamps its field — an empty or out-of-range value would otherwise make
// the interval meaningless. The clamped number is written back to the field.
el<HTMLInputElement>('setting-trash-interval').onchange = () => {
  const field = el<HTMLInputElement>('setting-trash-interval')
  const clamped = Math.min(99, Math.max(1, Math.round(Number(field.value) || 0)))
  settings.trashEmptyIntervalValue = clamped
  field.value = String(clamped)
  saveSetting('trashEmptyIntervalValue', clamped)
}
dropdown('setting-trash-unit').onchange = (e) => {
  settings.trashEmptyIntervalUnit = (e.target as HTMLSelectElement).value
  saveSetting('trashEmptyIntervalUnit', settings.trashEmptyIntervalUnit)
}

el<HTMLInputElement>('setting-template-date').oninput = () => {
  settings.templateDateFormat = el<HTMLInputElement>('setting-template-date').value
  saveSetting('templateDateFormat', settings.templateDateFormat)
  updateTemplateDatePreview()
  void invoke('set_template_date_format', { pattern: settings.templateDateFormat })
}

// --- Shortcut recorder -------------------------------------------------------

/// Pushes the three global bindings to Rust, which re-registers them with the
/// OS. Called on boot too, so defaults and remaps take the same path and can't
/// drift apart.
async function syncGlobalShortcuts() {
  const g = globalBindings()
  const failed = await invoke<string[]>('set_global_shortcuts', {
    summon: g.summonApp,
    showPinned: g.showPinnedNote,
    unpin: g.unpinFromTray,
    keepOnTop: g.keepOnTop,
  })
  if (failed.length > 0) {
    console.warn('these global shortcuts could not be registered:', failed)
  }
  return failed
}

let recording: ShortcutId | null = null

function renderShortcutSettings() {
  const clashes = conflicts()
  const list = el('shortcut-list')
  // The global chords are left out: Wayland gives no app a hotkey that works
  // from other apps, so a recorder for one would only pretend. The note under
  // the list says where they went (the Hyprland bind, the bar icon's menu).
  list.replaceChildren(
    ...SHORTCUT_SPECS.filter((spec) => !spec.global).map((spec) => {
      const row = document.createElement('div')
      row.className = 'shortcut-row'
      row.append(el2('span', 'shortcut-label', spec.label))

      const button = document.createElement('button')
      button.type = 'button'
      const binding = bindingFor(spec.id)
      const clashing = clashes.has(binding)
      button.className =
        'shortcut-key' +
        (recording === spec.id ? ' recording' : '') +
        (clashing ? ' clashing' : '')
      button.textContent =
        recording === spec.id ? 'Press keys…' : displayBinding(binding) || 'Unset'
      button.onclick = () => {
        recording = recording === spec.id ? null : spec.id
        renderShortcutSettings()
      }
      row.append(button)
      return row
    }),
  )

  const note = el('shortcut-conflicts')
  note.textContent =
    clashes.size === 0
      ? ''
      : `Conflicting: ${[...clashes.values()]
          .map((ids) => ids.map((i) => SHORTCUT_SPECS.find((s) => s.id === i)?.label).join(' / '))
          .join('; ')} — only one of each pair will fire.`
}

function el2(tag: string, className: string, text: string): HTMLElement {
  const n = document.createElement(tag)
  n.className = className
  n.textContent = text
  return n
}

// Capture phase, and before the app's own shortcut dispatch: while recording,
// every chord belongs to the recorder — otherwise pressing Ctrl+L to bind it
// would jump to the search box instead.
window.addEventListener(
  'keydown',
  (e) => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      recording = null
      renderShortcutSettings()
      return
    }
    // Bare modifiers are ignored, or the recorder captures "Ctrl" the instant
    // you reach for a chord.
    if (isModifierOnly(e)) return
    const id = recording
    setBinding(id, eventToBinding(e))
    recording = null
    renderShortcutSettings()
    if (SHORTCUT_SPECS.find((s) => s.id === id)?.global) void syncGlobalShortcuts()
    if (SHORTCUT_SPECS.find((s) => s.id === id)?.editor) applyEditorKeymap()
  },
  true,
)

el('shortcut-reset').onclick = () => {
  resetAllBindings()
  renderShortcutSettings()
  void syncGlobalShortcuts()
  applyEditorKeymap()
}

el('open-markup').onclick = () => openReference('markup')
el('open-shortcuts').onclick = () => openReference('shortcuts')
el('open-emoji').onclick = () => openReference('emoji')
el('open-about').onclick = () => openReference('about')

el('setting-reveal-templates').onclick = () => void invoke('reveal_folder', { which: 'templates' })
el('setting-reveal-trash').onclick = () => void invoke('reveal_folder', { which: 'trash' })

/// Returns null both when the picker is dismissed and when it fails to open.
///
/// The failure is caught rather than left to reject, because these are `async`
/// click handlers: an unhandled rejection there goes nowhere the user can see,
/// so the button simply appears dead. That is exactly how a missing
/// `dialog:allow-open` capability presented — the plugin was registered in
/// Rust, but registering a plugin is not the same as permitting the frontend to
/// call it, and the denial surfaced as a button that did nothing at all.
async function openFolderDialog(): Promise<string | null> {
  try {
    const picked = await openFolderPicker({ directory: true, multiple: false })
    return typeof picked === 'string' ? picked : null
  } catch (err) {
    console.error('could not open the folder picker', err)
    return null
  }
}

el('setting-change-index').onclick = async () => {
  try {
    const picked = await openFolderDialog()
    if (!picked) return
    await invoke('set_index_directory', {
      path: picked,
      includeSubfolders: settings.includeSubfolders,
    })
    el('settings-index-path').textContent = picked
    closeEditor()
    searchInput.value = ''
    void refreshCompletionSources()
    await runSearch()
  } catch (err) {
    console.error('could not change the Index folder', err)
  }
}
el<HTMLInputElement>('setting-subfolders').onchange = async (e) => {
  settings.includeSubfolders = (e.target as HTMLInputElement).checked
  saveSetting('includeSubfolders', settings.includeSubfolders)
  await invoke('set_include_subfolders', { include: settings.includeSubfolders })
  void refreshCompletionSources()
  await runSearch()
  // Submit's folder arrow exists only while folders are listed.
  applyFleetingSubmitShape()
}
el<HTMLSelectElement>('setting-layout').onchange = (e) => {
  setLayout((e.target as HTMLSelectElement).value as LayoutMode)
}
el<HTMLSelectElement>('setting-font').onchange = (e) => {
  settings.fontSource = (e.target as HTMLSelectElement).value
  saveSetting('fontSource', settings.fontSource)
  syncFontSettingsRow()
  syncTheme()
}
dropdown('setting-font-custom').onchange = (e) => {
  settings.fontCustom = (e.target as HTMLSelectElement).value
  saveSetting('fontCustom', settings.fontCustom)
  syncFontFamilyOptions()
  syncTheme()
}
el<HTMLInputElement>('setting-font-features').oninput = (e) => {
  settings.fontFeatures = (e.target as HTMLInputElement).value
  saveSetting('fontFeatures', settings.fontFeatures)
  syncTheme()
}
el('settings-open-folder').onclick = () => void invoke('reveal_index')

// --- Theme files and the config file ----------------------------------------
// The theme dropdown lists the four built-in faces, then every file in
// ~/.config/envy/themes, then the things you can do with them. The actions use
// values no theme name can take (a name is `[a-z0-9][a-z0-9-]*`), so choosing
// one can never be mistaken for choosing a theme.

const THEME_EXPORT = '!export'
const THEME_EDIT = '!edit'
const THEME_FOLDER = '!folder'
const BUILT_IN_THEMES = ['omarchy', 'system', 'dark', 'light']

/// The theme file actually in play: the one named by the setting, or — in
/// Omarchy mode — one named after the current Omarchy theme, which is how an
/// override for a single Omarchy theme gets picked up without being selected.
function activeThemeFile(): ThemeFileDto | null {
  if (!BUILT_IN_THEMES.includes(settings.theme)) return themeFile(settings.theme)
  const slug = currentOmarchy()?.theme
  return settings.theme === 'omarchy' && slug ? themeFile(slug) : null
}

function themeOption(value: string, label: string, disabled = false): HTMLOptionElement {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  option.disabled = disabled
  return option
}

function renderThemeOptions() {
  const select = dropdown('setting-theme')
  const files = themeFiles()
  const options = [
    ...(IS_WINDOWS ? [] : [themeOption('omarchy', 'Follow Omarchy')]),
    themeOption('system', 'Follow system'),
    themeOption('dark', 'Dark (Envious)'),
    themeOption('light', 'Light (Envious)'),
  ]
  if (files.length > 0) {
    options.push(themeOption('', '── Theme files ──', true))
    for (const file of files) {
      // The four built-in words are spoken for, so a file with one of those
      // names can never be selected. Listed greyed rather than hidden: a file
      // that silently does nothing is the worse puzzle.
      const reserved = RESERVED_THEME_NAMES.includes(file.name)
      options.push(
        themeOption(file.name, reserved ? `${file.name} (reserved name)` : file.name, reserved),
      )
    }
  }
  // A theme named in config.md with no file behind it is still listed, or the
  // dropdown would show a face the app isn't using.
  if (!BUILT_IN_THEMES.includes(settings.theme) && !files.some((f) => f.name === settings.theme)) {
    options.push(themeOption(settings.theme, `${settings.theme} (no such file)`))
  }
  options.push(themeOption('', '──────────', true))
  options.push(themeOption(THEME_EXPORT, 'Export current theme…'))
  options.push(themeOption(THEME_EDIT, 'Edit theme file', activeThemeFile() === null))
  options.push(themeOption(THEME_FOLDER, 'Open themes folder'))
  select.replaceChildren(...options)
  select.value = settings.theme
}

dropdown('setting-theme').onchange = (e) => {
  const value = (e.target as HTMLSelectElement).value
  // The three actions aren't choices, so the dropdown goes back to showing the
  // theme that is actually on.
  if (value === THEME_EXPORT || value === THEME_EDIT || value === THEME_FOLDER) {
    if (value === THEME_EXPORT) void exportThemeFlow()
    if (value === THEME_EDIT) void editThemeFileInEnvy()
    if (value === THEME_FOLDER) void invoke('reveal_folder', { which: 'themes' })
    renderThemeOptions()
    return
  }
  settings.theme = value
  saveSetting('theme', value)
  syncTheme()
  renderThemeOptions()
}

/// Writes what is on screen to a theme file, so "I like this, but…" starts
/// from the real thing rather than from a blank file.
async function exportTheme(name: string) {
  const { theme, dark } = currentTheme()
  const error = await writeThemeFile(name, tokensFromTheme(theme, dark))
  if (error) await alertModal(error)
}

async function exportThemeFlow() {
  // The current Omarchy theme's own name is the likeliest answer: exporting it
  // and editing the result is exactly how a per-Omarchy-theme override starts.
  const suggestion = currentOmarchy()?.theme ?? 'my-theme'
  const typed = await textPrompt('Save the current theme as', suggestion)
  if (typed === null) return
  const name = typed.trim().toLowerCase()
  if (!name) return
  if (!THEME_NAME_PATTERN.test(name)) {
    await alertModal(
      'A theme name is lower-case letters, digits and dashes, starting with a letter or digit.',
    )
    return
  }
  await exportTheme(name)
}

async function editThemeFileInEnvy() {
  const file = activeThemeFile()
  if (!file) return
  try {
    await openExternalDocument(
      { kind: 'theme', id: file.name, name: `${file.name}.md` },
      await readThemeText(file.name),
    )
    closeSettings()
  } catch (err) {
    await alertModal(String(err))
  }
}

/// config.md in Envy's own editor — the same as opening it in any editor,
/// except that saving it re-applies every setting straight away.
async function editConfigInEnvy() {
  try {
    await openExternalDocument(
      { kind: 'config', id: '', name: 'config.md' },
      await invoke<string>('config_read_text'),
    )
    closeSettings()
  } catch (err) {
    await alertModal(String(err))
  }
}

function renderConfigSection() {
  el('settings-config-path').textContent = config.configPath()
  el('settings-themes-path').textContent = themesDir()
  const problems = config.configProblems()
  const note = el('settings-config-problems')
  note.textContent = problems.length === 0 ? '' : `Problems: ${problems.join('; ')}`
  note.hidden = problems.length === 0
}

el('setting-edit-config').onclick = () => void editConfigInEnvy()
el('setting-open-config-folder').onclick = () => void invoke('reveal_folder', { which: 'config' })

// --- Applying the whole config ----------------------------------------------

/// Re-reads every setting and makes the app match it — the side effect each
/// control's own handler would have run, plus the controls themselves.
///
/// One function, used by the boot path and by every change that arrives from
/// the file, because a setting that only takes effect when it is toggled in
/// the panel is a setting that only half exists. `initial` is the boot call,
/// where the pushes to Rust and the first search are already in flight (in
/// parallel, deliberately) and repeating them would only cost a round trip.
function applyAllSettings({ initial = false } = {}) {
  const before = settings
  settings = readSettings()
  layoutMode = settingText('layout') === 'horizontal' ? 'horizontal' : 'vertical'
  editorZoom = settingNumber('editorZoom')
  plainTextMode = settingBool('plainText')
  sortField = settingText('sortField') as SortField
  sortAscending = settingBool('sortAscending')

  setFooterNotice(
    'config',
    config.configProblems().map((p) => `config.md: ${p}`),
  )
  syncTheme()
  applyChromeSettings()
  document.body.classList.toggle('fade-focus', settings.fadeFocusHighlight)
  applyPlainTextMode()
  applyLayout()
  startClockTick()
  applyEditorKeymap()
  renderSortHeader()
  renderList()
  renderTitleBarTags(activePane.dto?.tags ?? [])
  renderTitleBarFolder(activePane.dto?.subfolder ?? null)
  renderDueBadge(activePane.dto?.due ?? null)
  renderInterlinks()
  renderStats()
  // Tag colours, domain emojis and the link-pill switch are all read during
  // styling, and none of them is in the document — only a restyle repaints them.
  view.dispatch({ effects: restyle.of(null) })
  // Only worth doing while the panel is on screen; opening it syncs anyway.
  if (!settingsEl.classList.contains('hidden')) syncSettingsControls()
  if (initial) return

  void syncGlobalShortcuts()
  void invoke('set_template_date_format', { pattern: settings.templateDateFormat })
  // These three change what the store considers in scope, so they only go back
  // to Rust when they actually changed — each one costs a rescan.
  if (before.includeSubfolders !== settings.includeSubfolders) {
    void invoke('set_include_subfolders', { include: settings.includeSubfolders }).then(
      () => void refreshCompletionSources(),
    )
  }
  if (before.inboxEnabled !== settings.inboxEnabled) void pushInboxEnabled()
  markOrderDirty()
  void refreshVaultCounts()
  void runSearch()
}

// A change to config.md this window didn't make: an agent, an editor, the
// `envynote config edit` path, or another window. Everything is re-applied
// rather than just the key that changed — the file arrives whole, and working
// out the difference would be a second model of what a setting does.
config.onChange((local) => {
  if (!local) applyAllSettings()
})

// `envynote theme export <name>` and `envynote config edit`, forwarded by
// Rust from the control socket after showing the window.
void listen<string>('export-theme', (e) => void exportTheme(e.payload))
void listen('edit-config', () => void editConfigInEnvy())

/// The moment a trash emptied at `fromMs` next falls due, adding the interval
/// as real calendar units — a month means the same day next month, not a fixed
/// 30 days — matching the Mac's Calendar.date(byAdding:).
function trashDueAfter(fromMs: number, value: number, unit: string): number {
  const d = new Date(fromMs)
  if (unit === 'weeks') d.setDate(d.getDate() + value * 7)
  else if (unit === 'months') d.setMonth(d.getMonth() + value)
  else d.setDate(d.getDate() + value)
  return d.getTime()
}

/// Empties the trash into the system Trash (XDG Trash on Linux) if enough time has passed since the
/// last empty, then records now as the new baseline — the Windows half of the
/// Mac's TrashPreference.emptyIfDue, called at launch and hourly. The schedule
/// lives here because the interval settings and the baseline are the frontend's.
async function emptyTrashIfDue() {
  const key = 'trashLastEmptiedDate'
  const stored = Number(localStorage.getItem(key))
  // No usable baseline (fresh install, or upgrading from the old age-based
  // model): start the clock now rather than sweeping an existing trash the
  // instant this version first runs. The first auto-empty is then one interval
  // out, which is the least surprising thing on a first encounter.
  if (!Number.isFinite(stored) || stored <= 0) {
    localStorage.setItem(key, String(Date.now()))
    return
  }
  const due = trashDueAfter(
    stored,
    settings.trashEmptyIntervalValue,
    settings.trashEmptyIntervalUnit,
  )
  if (Date.now() < due) return
  const emptied = await invoke<number>('empty_trash')
  localStorage.setItem(key, String(Date.now()))
  // Repaint if the user happens to be looking at the trash when it's swept.
  if (emptied > 0) await runSearch()
}

// Confirmed because it clears the whole trash at once — but recoverable now:
// the notes go to the system Trash (Recycle Bin on Windows), the same as the Mac sends them to the macOS
// Trash. Empties the same schedule the timer does, so the baseline resets here.
el('setting-empty-trash').onclick = async () => {
  const waiting = await invoke<NoteDto[]>('trashed_notes', { fragment: '' })
  if (waiting.length === 0) {
    await alertModal('The trash is already empty.')
    return
  }
  const ok = await confirmModal(
    `Move ${waiting.length} note${waiting.length === 1 ? '' : 's'} to the system Trash?`,
    'Empty Trash',
  )
  if (!ok) return
  await invoke('empty_trash')
  localStorage.setItem('trashLastEmptiedDate', String(Date.now()))
  await runSearch()
}

// Autostart is the one setting whose truth lives outside the app — it's a
// registry entry the user (or another tool) can change behind our back — so
// it's read from the system when Settings opens rather than cached here.
el<HTMLInputElement>('setting-autostart').onchange = async (e) => {
  const box = e.target as HTMLInputElement
  try {
    await invoke('set_autostart', { enabled: box.checked })
  } catch (err) {
    console.error('autostart failed', err)
    box.checked = !box.checked
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsEl.classList.contains('hidden')) closeSettings()
})

// Dismiss on click-away, for people who treat Envy as a summoned scratchpad
// rather than a window they keep open. Off by default: losing the window
// because you glanced at a browser is startling if you didn't ask for it.
//
// try/catch rather than .catch(): getCurrentWindow() throws *synchronously*
// when there's no Tauri context, so there is no promise to attach to — and an
// uncaught throw at module scope takes the whole script with it, leaving a
// blank window with nothing in the console to explain it.
// `hide()` needs `core:window:allow-hide` granted explicitly — `core:default`
// covers only the read-only window calls — and a denied call rejects rather
// than throwing, so `void` on it discarded the one piece of evidence that
// anything was wrong. The window simply stayed put with a silent unhandled
// rejection behind it.
//
// The Mac hides on `didResignActiveNotification`, which is an *application*
// event: it fires when another app takes over, and explicitly not when focus
// moves between Envy's own windows, so this "can't accidentally hide the main
// window out from under those". Tauri has no app-level equivalent — focus is
// reported per window — so the same guarantee has to be reconstructed by asking
// whether any Envy window still holds focus before hiding. Without it, opening
// the pinned note would blur the main window and hide it, which is the exact
// accident the Mac's comment is about.
//
// The wait is what makes that check meaningful: at the moment the blur arrives
// the incoming window has not been marked focused yet, so an immediate poll
// reports nothing focused and hides regardless. Both calls used here are
// read-only and already covered by `core:default`.
async function anyEnvyWindowFocused(): Promise<boolean> {
  const windows = await getAllWindows()
  const focused = await Promise.all(windows.map((w) => w.isFocused().catch(() => false)))
  return focused.some(Boolean)
}

// While "Keep Envy on Top" is on, the auto-hide is suppressed — a window
// pinned above everything that vanished the moment you clicked away would fight
// itself. The tray toggle flips this over the `keep-on-top-changed` event, and
// the initial value is read at boot. Mirrors the Mac, where keepOnTop
// suppresses the same hide.
let keepOnTopActive = false
try {
  void listen<boolean>('keep-on-top-changed', (e) => {
    keepOnTopActive = e.payload
  })
} catch {
  // Outside Tauri (dev in a plain browser).
}

try {
  void getCurrentWindow().onFocusChanged(async ({ payload: focused }) => {
    if (focused || !settings.hideOnFocusLoss || keepOnTopActive) return
    // Settings is an in-page overlay rather than its own window, so it needs
    // its own guard — losing the panel mid-change would be the same accident.
    if (!settingsEl.classList.contains('hidden')) return
    try {
      await new Promise((resolve) => setTimeout(resolve, 120))
      if (await anyEnvyWindowFocused()) return
      await getCurrentWindow().hide()
    } catch (err) {
      console.error('could not hide on focus loss', err)
    }
  })
} catch {
  // Running outside Tauri (a plain browser during development).
}

async function boot() {
  installSmoothScroll()
  installWindowChrome({
    close: 'hide',
    dragEl: document.getElementById('search-bar'),
  })
  setIndexLoading(true)
  // The config comes first, before anything reads a setting: every value below
  // is in it, and starting from a default that then has to be corrected on
  // screen is a flicker with nothing to gain.
  await config.initConfig()
  settings = readSettings()
  // Startup was a chain of nine awaited round trips, each waiting on the one
  // before it for no reason: these are one-way pushes of stored preferences,
  // and none of them reads anything another one writes. Fired together they
  // cost one round trip's latency rather than nine. The two the search genuinely
  // depends on — subfolders decides what is in scope, inbox decides what the
  // store calls fleeting — are still awaited before `runSearch`, because they
  // are in this group and the whole group is.
  //
  // `Promise.all` is built here, not at the await, so a rejection always has a
  // handler attached and the failure still aborts boot exactly as it used to.
  const pushes: Array<Promise<unknown>> = [
    invoke('set_template_date_format', { pattern: settings.templateDateFormat }),
    pushInboxEnabled(),
    // Registers the global chords with the OS. Nothing is registered in Rust at
    // startup, so this is the only path — defaults and remaps go the same way.
    syncGlobalShortcuts(),
    // The placeholder stays "Search or Create Note" — the Index path belongs in
    // Settings, where it can be changed. Repeating it in the box a person looks
    // at all day is noise about something that never varies.
    invoke<string>('index_directory').then((dir) => {
      el('settings-index-path').textContent = dir
    }),
    // The on-top state is a Rust-side preference (toggled from the tray), so
    // read the remembered value once at startup for the hide-on-focus-loss
    // guard. Swallowed rather than fatal: this is the one call that has to
    // survive running outside Tauri.
    invoke<boolean>('keep_on_top')
      .then((on) => {
        keepOnTopActive = on
      })
      .catch(() => {}),
  ]
  // The backend keeps the tray pin only in memory, so hand it back the value
  // that survived the restart.
  if (trayPinnedId) pushes.push(invoke('set_pinned_note', { id: trayPinnedId }))
  if (settings.includeSubfolders) {
    pushes.push(invoke('set_include_subfolders', { include: true }))
  }
  const pushed = Promise.all(pushes)
  await initAppearance(() => {
    applyZoom()
    void document.fonts.ready.then(() => {
    markRowHeightDirty()
    syncDateColumnWidth(true)
    renderRowWindow(true)
  })
  })
  // The same pass a change to config.md takes, so a value can never behave
  // differently at launch than it does when the file changes.
  applyAllSettings({ initial: true })
  searchInput.focus()
  initKindleImport(openSettings)
  // Search and the Index scan must not block first paint. `index-changed`
  // refills the list when the background walk finishes; this still runs once
  // now in case that event already fired.
  void pushed.then(() => {
    void refreshCompletionSources()
    void runSearch()
  })
  // The Mac empties on launch and then hourly: a summon/hide app can run for
  // weeks without a relaunch, so a launch-only check can't keep an "every N
  // days" schedule honest. Cheap on the ticks it isn't due — just a date compare.
  void emptyTrashIfDue()
  window.setInterval(() => void emptyTrashIfDue(), 60 * 60 * 1000)
}

// Exposed for debugging from the webview console. The decoration pass is
// viewport-dependent and link resolution is position-dependent, so
// reproducing either means driving the real view rather than reasoning about
// the regexes in isolation.
;(window as any).__envy = {
  view,
  wikiLinkTargetAt,
  wikiLinkRangeAt,
  headingSlug,
  headingRangeForSlug,
  footnoteDefinitionRange,
  listContinuation,
  isListLine,
  renumberForTest: () => renumberEdits(view.state),
  // Lets the interlinks panel be exercised without a backend, so its layout
  // can be checked in a plain browser rather than by driving the real app.
  // Positioning and dismissal are layout behaviour, checkable in a plain
  // browser without a backend behind them.
  openContextMenu,
  noteMenuItems,
  // The app's *own* references. A dynamic import of the styler from a console
  // yields a separate module record under Vite, and separate StateField
  // identities with it — so a test importing it directly would find the field
  // "not registered" and prove nothing.
  setSearchQuery,
  searchQueryField,
  // Exposed so a preference-driven repaint can be exercised the same way the
  // query one is — the pill's emoji lives outside the document, so nothing in
  // a transaction would otherwise show it changing.
  restyle,
  pairingEdit,
  dueTokenAt,
  toggleDueToken,
  changedRange,
  // The pure table functions: row serialisation (with escaped pipes), the
  // re-pad that lines the columns up on the way out of a table, and the
  // TSV/CSV sniff behind the paste handler. There is no JS test runner in this
  // repo, so these are exercised from the webview console like the rest.
  insertTable,
  serializeTableRow,
  padTableSource,
  delimitedToTable,
  selectSingle,
  selectRange,
  toggleMultiSelect,
  extendSelection,
  fullSelection,
  ghostCompletion,
  acceptCompletion,
  // The config and theme-file pure functions. There is no JS test runner in
  // this repo, so — like the table and list helpers above — the parts worth
  // checking are the ones with no DOM in them: what the schema defaults to,
  // what an overlay produces, and that a theme survives the round trip out to
  // a file and back.
  config,
  renderThemeFile,
  tokensFromTheme,
  overlayTokens,
  legibilityNotices,
  cssToHex,
  currentTheme,
  // The WebView2 dialog stand-ins, so their resolve behaviour (OK vs Cancel,
  // confirm vs prompt) can be exercised without the native dialogs that don't
  // exist in this webview.
  textPrompt,
  confirmModal,
  alertModal,
  arrowNavigate,
  renameTagFlow,
  // Folder-finish surfaces, verifiable without a backend: the Folder/Title
  // parse, the folder pivot, and the two folder markers.
  folderTargetedCreation,
  searchByFolder,
  renderTitleBarFolder,
  buildFolderIndicator,
  setKnownFoldersForTest: (f: string[]) => {
    knownFolders = f
  },
  setCatalogRowsForTest: (rows: CatalogRow[]) => {
    catalogRows = rows
  },
  setTagsForTest: (t: string[]) => {
    knownTags = t
  },
  setCompletionSourcesForTest: (tags: string[], folders: string[], titles: string[]) => {
    knownTags = tags
    knownFolders = folders
    // Through the setter so the ghost-link title set and a restyle come too.
    updateKnownTitles(titles)
  },
  isGhostLinkForTest,
  // The editor ghost completion, decided on the live editor state (no focus
  // needed, unlike the on-screen widget).
  editorGhostForTest: () => ghostRemainderForTest(view.state),
  setResultsForTest: (r: NoteDto[]) => {
    // Through the same installer a real search uses, so a test list is a
    // fully loaded one page rather than a sparse array with no bookkeeping.
    installFirstPage({ notes: r, total: r.length })
    markOrderDirty()
    multiSelected.clear()
    anchorId = null
    highlighted = 0
  },
  // The list is virtualized, so how much work a render actually does depends on
  // the live viewport height and scroll position. Measuring that means driving
  // the real function against the real element, not counting nodes in the
  // abstract.
  renderList,
  listState: () => ({
    total: results.length,
    rendered: listSizer.childElementCount,
    rowHeight,
    scrollHeight: listEl.scrollHeight,
  }),
  previewInterlinks(data: InterlinksDto, expanded = true) {
    currentInterlinks = data
    interlinksExpanded = expanded
    activePane.noteId = activePane.noteId ?? 'preview'
    renderInterlinks()
  },
}

void boot()

