//! A popped-out note: a note in its own floating, resizable window, opened from
//! the list's "Pop Out" menu. Several can be open at once. It's a real editing
//! surface — edits save straight to the note — and following a `[[link]]` inside
//! it opens the target in the *main* window rather than swapping the float's
//! content, matching the Mac's pop-out (onNavigate drives the main editor).
//!
//! Shares the styler, theme and list-editing with the main window, so a popped
//! note looks and edits exactly as it does in the app.

import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { envyStyler, embedHost, isImageTarget } from './styler'
import { makeEmbedHost } from './embed-host'
import { openImageMenu, renameAttachmentFlow, insertImageReference } from './image-menu'
import { openImagePicker } from './image-picker'
import { openContextMenu } from './context-menu'
import { setPromptFocusReturn } from './prompt-modal'
import { listEditing } from './lists'
import { insertTable, tableEditing } from './tables'
import { matches as matchesShortcut } from './shortcuts'
import {
  editorCompletion,
  completionSources,
  loadCompletionSources,
  type CompletionSources,
} from './completion'
import { initAppearance, applyEditorZoom } from './theme'
import { installSmoothScroll } from './smooth-scroll'
import { installWindowChrome } from './window-chrome'
import { getBool, getNumber, onChange as onConfigChange } from './config'

// Its own entry point, so it needs its own last-resort handler — the main
// window's doesn't reach here.
window.addEventListener('unhandledrejection', (e) => {
  console.error('pop-out failed silently:', e.reason)
})
installSmoothScroll()
installWindowChrome({
  close: 'close',
  dragEl: document.getElementById('popout-title-bar'),
})

interface NoteDto {
  id: string
  title: string
  content: string | null
}

const editorEl = document.getElementById('popout-editor')!
const titleEl = document.getElementById('popout-title') as HTMLInputElement
let noteId: string | null = null
let noteTitle = ''
let savedContent = ''
let saveTimer: number | undefined
// Read from the config file, which every window shares. A function rather
// than a captured value: the file can change while this window is open.
// Defaults on, so a plain click still places the caret to edit a link.
const requireModifier = () => getBool('editor', 'require_modifier_for_links')

/// Ghost-completion pools, fetched with the note and again whenever the index
/// changes, so a `#tag` or `[[link]]` completes here as it does in the app.
let completion: CompletionSources = { titles: [], tags: [] }
async function refreshCompletionSources() {
  completion = await loadCompletionSources()
}

/// The `[[…]]` target at a position, alias and heading stripped — the same
/// resolution the main window's follow uses.
function wikiLinkTargetAt(v: EditorView, pos: number): string | null {
  const line = v.state.doc.lineAt(pos)
  const re = /!?\[\[([^\[\]]+)\]\]/g
  for (const m of line.text.matchAll(re)) {
    const from = line.from + m.index!
    const to = from + m[0].length
    if (pos >= from && pos <= to) {
      const target = m[1].split('|')[0].split('#')[0].trim()
      return target || null
    }
  }
  return null
}

const view = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      history(),
      drawSelection(),
      listEditing,
      tableEditing,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      editorCompletion,
      completionSources.of(() => completion),
      // Resolves `![[note]]` transclusions and `![[image.png]]` attachments, so
      // a popped note renders images (and embeds) exactly as the main window —
      // including the image's right-click size/rename/reveal menu.
      embedHost.of({
        ...makeEmbedHost(() => noteId),
        onImageContextMenu: (raw, spec, x, y) =>
          openImageMenu(raw, spec, x, y, view, (name) => void renamePoppedImage(name)),
      }),
      envyStyler,
      EditorView.domEventHandlers({
        mousedown: (event, v) => {
          if (event.button !== 0) return false
          // Clicks inside a rendered embed belong to the widget (the image's own
          // open handler), never to a marker follow.
          if ((event.target as HTMLElement | null)?.closest('.envy-image-embed, .envy-embed, .envy-md-table-wrap, .envy-md-pre-wrap')) {
            return false
          }
          const pos = v.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos === null) return false
          // Honour the same modifier gate as the main editor, so a plain click
          // can still land the caret inside a link to edit it.
          if (requireModifier() && !event.ctrlKey) return false
          const target = wikiLinkTargetAt(v, pos)
          if (!target) return false
          event.preventDefault()
          // An image reference opens the file; a note reference opens in main.
          if (isImageTarget(target)) {
            void invoke('open_attachment', { name: target })
            return true
          }
          void followInMain(target)
          return true
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && noteId) {
          window.clearTimeout(saveTimer)
          saveTimer = window.setTimeout(() => {
            saveTimer = undefined
            void save()
          }, 400)
        }
      }),
    ],
  }),
  parent: editorEl,
})

/// Following a link opens the target in the main window (creating it if needed),
/// bringing that window forward — the float stays put on whatever it was
/// showing, as a reference you keep beside your work.
async function followInMain(target: string) {
  await flush()
  try {
    const note = await invoke<NoteDto>('open_link', { target })
    await invoke('open_in_main_window', { id: note.id })
  } catch (e) {
    console.error('could not follow the link', e)
  }
}

async function save() {
  if (!noteId) return
  const content = view.state.doc.toString()
  if (content === savedContent) return
  try {
    await invoke('save_note', { id: noteId, content })
    savedContent = content
  } catch (e) {
    console.error('pop-out save failed', e)
  }
}

async function load() {
  void refreshCompletionSources()
  try {
    const id = await invoke<string | null>('popout_note_id')
    if (!id) return
    const note = await invoke<NoteDto | null>('read_note', { id })
    if (!note) return
    noteId = note.id
    noteTitle = note.title
    savedContent = note.content ?? ''
    titleEl.value = note.title
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: savedContent },
      selection: { anchor: 0 },
    })
  } catch (e) {
    console.error('could not load the popped-out note', e)
  }
}

/// Renames the note from the title field — a real rename, so every `[[link]]`
/// pointing at it is rewritten across the Index, exactly as the main window's
/// title bar does. The file's path is its id, so the id changes with it; the
/// main window is nudged to rescan since Envy's own writes are hidden from the
/// watcher.
async function commitRename() {
  if (!noteId) return
  const next = titleEl.value.trim()
  if (!next || next === noteTitle) {
    titleEl.value = noteTitle
    return
  }
  try {
    const renamed = await invoke<NoteDto>('rename_note', { id: noteId, title: next })
    noteId = renamed.id
    // The sanitizer may have altered what was typed (a filename Windows can't
    // represent), so show what actually landed on disk.
    noteTitle = renamed.title
    titleEl.value = renamed.title
    await emit('index-changed')
  } catch (e) {
    console.error('pop-out rename failed', e)
    titleEl.value = noteTitle
  }
}

// Enter commits and returns focus to the editor; blur commits too. Escape here
// reverts, matching the main window's title field.
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    void commitRename().then(() => view.focus())
  } else if (e.key === 'Escape') {
    // Revert, and don't let the window's Escape-to-close fire.
    e.preventDefault()
    e.stopPropagation()
    titleEl.value = noteTitle
    view.focus()
  }
})
titleEl.addEventListener('blur', () => void commitRename())

async function flush() {
  window.clearTimeout(saveTimer)
  await save()
}

/// Renames the attachment behind a right-clicked image. The shared flow rewrites
/// references vault-wide in Rust; here we flush this float's buffer first, then
/// nudge the main window to rescan and reload our own note with the new name.
function renamePoppedImage(oldName: string) {
  return renameAttachmentFlow(oldName, {
    flush,
    reload: async () => {
      await emit('index-changed')
      await load()
    },
  })
}

// A dialog (rename) hands focus back to the editor in this float.
setPromptFocusReturn(() => view.focus())

// Titles and tags come and go as notes are edited elsewhere; every window's
// save announces itself this way, so the pools stay current without polling.
void listen('index-changed', () => void refreshCompletionSources())

// The editor's own right-click menu — just "Insert Image…" for now, the same as
// the main window. An image widget runs its own menu, so leave those clicks be.
editorEl.addEventListener('contextmenu', (e) => {
  if ((e.target as HTMLElement).closest('.envy-image-embed')) return
  if (!noteId) return
  e.preventDefault()
  e.stopPropagation()
  openContextMenu(e.clientX, e.clientY, [
    {
      label: 'Insert Image…',
      run: () => void openImagePicker((name) => insertImageReference(name, view)),
    },
    { label: 'Insert Table', run: () => void insertTable(view) },
  ])
})

// The same face size and chrome scale as the main window, from the same two
// settings, so a popped-out note reads at the size it was popped out at —
// and follows if either setting changes while it is open.
function applySizing() {
  applyEditorZoom(getNumber('editor', 'zoom'))
  document.documentElement.style.setProperty(
    '--envy-ui-scale',
    String(getNumber('appearance', 'text_size')),
  )
  view.requestMeasure()
}
void initAppearance(applySizing)
onConfigChange(() => applySizing())

// The size sticks: drag any edge and the next pop-out opens that size, as the
// Mac's self-persisting peek panel does. Stored in the origin's localStorage,
// where the main window reads it back to pass along when it opens the next one.
// Logical pixels, the units the window builder takes; debounced because a drag
// fires a resize per frame.
let resizeTimer: number | undefined
try {
  const current = getCurrentWindow()
  void current.onResized(({ payload }) => {
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(async () => {
      try {
        const { width, height } = payload.toLogical(await current.scaleFactor())
        localStorage.setItem(
          'popoutSize',
          JSON.stringify({ width: Math.round(width), height: Math.round(height) }),
        )
      } catch (e) {
        console.error('could not remember the pop-out size', e)
      }
    }, 250)
  })
} catch {
  // Running outside Tauri.
}

// Escape closes the float (after flushing) — the same quick dismissal the peek
// and pinned popover offer. The native title bar's close button closes it too.
// (No onCloseRequested handler: an async close listener deferred the native
// close, so the window wouldn't shut. The 400ms save debounce and this flush
// cover the pending edit instead.)
window.addEventListener('keydown', (e) => {
  // The one editor action this window shares with the main one — read through
  // the registry, so a remap there applies here too.
  if (noteId && matchesShortcut('insertTable', e)) {
    e.preventDefault()
    insertTable(view)
    return
  }
  if (e.key !== 'Escape') return
  e.preventDefault()
  void flush().then(() => getCurrentWindow().close())
})

void load()
view.focus()
