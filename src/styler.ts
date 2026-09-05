import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view'
import { EditorState, Facet, Range, StateEffect, StateField, Text } from '@codemirror/state'
import { invoke } from '@tauri-apps/api/core'
import { createMiniNoteEditor, type MiniNoteEditor } from './mininote'
import { resolveDueToken, urgencyFor } from './due'
import {
  findTableBlocks,
  forEachPipe,
  padTableSource,
  serializeTable,
  serializeTableRow,
  tableRowLines,
  type CellAlign,
  type TableBlock,
} from './tables'
import { emphasisEdit } from './input'
import { matches as matchesShortcut } from './shortcuts'
import { findFencedBlocks, type FenceBlock } from './fences'
import { getBool, map as configMap } from './config'

// --- Embeds -----------------------------------------------------------------

export interface EmbedNote {
  id: string
  title: string
  content: string
}

/// What an embed needs from the app to resolve and write a note. Supplied as a
/// facet so the styler keeps knowing nothing about Tauri or the note store.
export interface EmbedHost {
  resolve(title: string): Promise<EmbedNote | null>
  save(id: string, content: string): Promise<void>
  /// The note the host editor is currently showing, for the self-embed guard.
  currentNoteId(): string | null
  /// The bytes of an attachment by filename, for rendering `![[image.png]]`
  /// inline. Null when the file is missing (the widget shows a placeholder).
  readAttachment(name: string): Promise<ArrayBuffer | null>
  /// Opens an attachment in the system default app — clicking the image.
  openAttachment(name: string): void
  /// Right-clicking an inline image: the app shows the size menu and rewrites
  /// the marker. `raw` is the exact `![[…]]` text so the right one is replaced.
  onImageContextMenu(raw: string, spec: ImageEmbedSpec, x: number, y: number): void
}

export const embedHost = Facet.define<EmbedHost, EmbedHost | null>({
  combine: (values) => values[0] ?? null,
})

/// Whether this editor renders embeds at all.
///
/// The editor *inside* an embed sets this false. Without it, a note embedding
/// itself — or two notes embedding each other — would expand forever.
export const allowEmbeds = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? true,
})

/// The set of existing note titles, lowercased, so the styler can tell a
/// `[[link]]` that resolves from a "ghost" one whose target doesn't exist yet.
/// A getter returning a live set (like the completion sources), read fresh each
/// styling pass so a ghost un-ghosts the moment its target is created — the
/// styler just needs a `restyle` nudge when the set changes. Default resolves
/// everything, so an editor given no set (an embed's inner editor) never paints
/// a ghost.
export const existingTitles = Facet.define<() => Set<string>, () => Set<string>>({
  combine: (values) => values[0] ?? (() => new Set()),
})

/// Attachment extensions that count as resolvable on sight — a `[[pic.png]]`
/// or `![[pic.png]]` is a kept promise, not an unfilled one, so it never
/// ghosts. Mirrors envy-core's IMAGE_ATTACHMENT_EXTENSIONS.
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tiff', 'tif', 'bmp',
])

export function isImageTarget(target: string): boolean {
  const dot = target.lastIndexOf('.')
  return dot !== -1 && IMAGE_EXTENSIONS.has(target.slice(dot + 1).toLowerCase())
}

/// A parsed image embed. `![[name|400]]`, `![[name|400x300]]`,
/// `![[name|400|caption]]`, and `![[name|caption]]` all decompose here.
export interface ImageEmbedSpec {
  name: string
  width?: number
  height?: number
  caption?: string
}

/// Splits an embed body into name / size / caption, matching the Mac's
/// `imageEmbedRanges`: the segment right after the name is a size only when it's
/// `<digits>` or `<digits>x<digits>`; whatever remains is the caption.
export function parseImageEmbed(inner: string): ImageEmbedSpec {
  const parts = inner.split('|').map((p) => p.trim())
  const spec: ImageEmbedSpec = { name: parts[0] }
  let rest = parts.slice(1)
  const size = rest[0] ? /^(\d+)(?:x(\d+))?$/.exec(rest[0]) : null
  if (size) {
    spec.width = Number(size[1])
    if (size[2]) spec.height = Number(size[2])
    rest = rest.slice(1)
  }
  const caption = rest.join('|').trim()
  if (caption) spec.caption = caption
  return spec
}

/// Rebuilds the `![[…]]` marker from a spec — the inverse of `parseImageEmbed`,
/// the twin of the Mac's `imageInner`. Used when the size menu rewrites the size.
export function buildImageMarker(spec: ImageEmbedSpec): string {
  const parts = [spec.name]
  if (spec.width !== undefined) {
    parts.push(spec.height !== undefined ? `${spec.width}x${spec.height}` : String(spec.width))
  }
  if (spec.caption) parts.push(spec.caption)
  return `![[${parts.join('|')}]]`
}

/// Whether a `[[link]]`'s target names something that exists — a note (case
/// insensitively) or an image attachment. An empty title set is treated as
/// "unknown, assume resolved" so a not-yet-loaded index (or an embed's inner
/// editor, which is given no set) never flashes every link as a ghost.
function titleResolves(target: string, titles: Set<string>): boolean {
  if (titles.size === 0) return true
  if (isImageTarget(target)) return true
  return titles.has(target.toLowerCase())
}

/// Test-only: would a `[[body]]` render as a ghost, given these existing
/// titles? Combines target extraction (alias/heading stripped), the image
/// exemption, and the case-insensitive lookup — the same decision the styler
/// makes per link. The inline styler is a ViewPlugin whose decorations only
/// materialise in a composited editor, so its ghosting can't be seen in a
/// headless pane; this exposes the decision so it can be.
export function isGhostLinkForTest(body: string, titles: string[]): boolean {
  const set = new Set(titles.map((t) => t.trim().toLowerCase()))
  return !titleResolves(wikiLinkTarget(body), set)
}

/// The live search query, pushed in from the search box so matches can be
/// highlighted in the open note. Held in editor state rather than a module
/// variable so a query change goes through the normal update cycle and
/// triggers a redecorate like any other change.
export const setSearchQuery = StateEffect.define<string>()

/// Plain-text mode: show the markdown as written, styling nothing.
///
/// A toggle rather than a separate view, so the text, cursor and scroll
/// position are all exactly where they were — the only thing that changes is
/// whether the styler runs.
export const setPlainText = StateEffect.define<boolean>()

/// Forces a restyle when something the decorations depend on changed outside
/// the document — a per-domain emoji, say, which lives in preferences rather
/// than in the text. Without it nothing in the transaction would tell the
/// plugin anything had changed, and the pill would keep its old mark until the
/// next keystroke.
export const restyle = StateEffect.define<null>()

/// Whether this editor currently has focus. Block table widgets live in a
/// StateField (CodeMirror forbids them on plugins), so they cannot read
/// `view.hasFocus` the way the inline styler does — this field is the stand-in,
/// kept in step by `focusChangeEffect`.
const setEditorFocused = StateEffect.define<boolean>()

const editorFocusedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setEditorFocused)) return e.value
    return value
  },
})

export const plainTextField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPlainText)) return e.value
    return value
  },
})

/// Briefly marks a range that changed outside Envy, so the edit is noticed
/// without having to spot the diff yourself.
///
/// Uses the theme's highlight token — one "highlight" concept for everything
/// in the editor, rather than a second hardcoded colour nobody can change.
export const setFlash = StateEffect.define<{ from: number; to: number } | null>()

const flashMark = Decoration.mark({ class: 'envy-flash' })

export const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        return e.value && e.value.to > e.value.from
          ? Decoration.set([flashMark.range(e.value.from, e.value.to)])
          : Decoration.none
      }
    }
    // Mapped through edits so a flash still marks the right text if something
    // else changes while it's fading.
    return value.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

/// The span where two versions of a note differ — a common-prefix/suffix trim
/// rather than a real diff. It only has to be good enough to point the eye at
/// the right paragraph, and it's exact for the common case of one edited
/// region.
export function changedRange(before: string, after: string): { from: number; to: number } | null {
  if (before === after) return null
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  return { from: start, to: endAfter }
}

export const searchQueryField = StateField.define<string>({
  create: () => '',
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSearchQuery)) return e.value
    return value
  },
})

// Patterns transcribed verbatim from MarkdownStyler.swift. Every one of them
// is JS-compatible as written — including the lookbehinds, which WebView2
// supports since it's Chromium. That compatibility is the single biggest
// reason this port is tractable: the grammar doesn't have to be redesigned,
// only re-rendered.
const P = {
  embed: /!\[\[([^\[\]]+)\]\]/g,
  wikiLink: /\[\[([^\[\]]+)\]\]/g,
  boldItalic: /\*\*\*([^*\n]+)\*\*\*/g,
  bold: /\*\*([^*\n]+)\*\*/g,
  italic: /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
  /// GFM underscore emphasis. `(?!_)` keeps `__bold__` off the italic pass;
  /// word-boundaries keep `snake_case` alone. The Omarchy manual writes
  /// `_Install > Browser_` and `_beautiful_`.
  boldUnderscore: /(?<!\w)__([^_\n]+?)__(?!\w)/g,
  italicUnderscore: /(?<!\w)_(?!_)([^_\n]+?)_(?!_|\w)/g,
  strikethrough: /~~([^~\n]+)~~/g,
  highlight: /==([^=\n]+)==/g,
  code: /`([^`\n]+)`/g,
  fencedCodeBlock: /^```[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm,
  header: /^(#{1,6})[ \t]+(.*)$/gm,
  blockquote: /^(>[ \t]?)(.*)$/gm,
  horizontalRule: /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm,
  taskList: /^(\s*(?:[-*+][ \t]+)?)(\[[ xX]\])([ \t]+.*)$/gm,
  unorderedList: /^(\s*)([-*+])([ \t]+.*)$/gm,
  orderedList: /^(\s*)(\d+[.)])([ \t]+.*)$/gm,
  link: /(?<!!)\[([^\[\]]+)\]\(([^()\s]+)\)/g,
  autolinkBracket: /<(https?:\/\/[^\s>]+)>/g,
  bareURL: /(?<![(<])\bhttps?:\/\/[^\s<>()]+\b/g,
  footnoteDefinition: /^\[\^([^\]]+)\]:[ \t]*/gm,
  footnoteReference: /\[\^([^\]]+)\]/g,
  hashtag: /(?<![\w#])#[A-Za-z0-9_-]+/g,
  due: /(?<![\w])@(today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|[0-9/-]+)(?!\w)/gi,
  checkedTaskLine: /^\s*(?:[-*+][ \t]+)?\[[xX]\][ \t]+.*$/gm,
}

/// Shows a `*` bullet as an actual `•` glyph — the displayed character only;
/// the file still holds `*`, and the cursor/backspace still see it, since the
/// widget is revealed back to `*` whenever the caret is on it. Mirrors the
/// Mac's glyph substitution for `*`.
class BulletWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'envy-list-bullet'
    span.textContent = '•'
    return span
  }
}
const bulletWidget = Decoration.replace({ widget: new BulletWidget() })

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super()
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos
  }
  toDOM(view: EditorView) {
    const box = document.createElement('span')
    box.className = 'envy-checkbox' + (this.checked ? ' envy-checkbox-checked' : '')
    // A vector checkmark rather than a "✓" glyph, so it scales with the box
    // under editor zoom instead of staying a font-sized symbol beside it, and
    // draws the same on every theme (the Mac's 1.8.7 redraw). Sized in em by
    // the CSS, like the box itself.
    if (this.checked) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('aria-hidden', 'true')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M3.5 8.5 6.5 11.5 12.5 4.5')
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '2.2')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      svg.append(path)
      box.append(svg)
    }
    box.setAttribute('aria-checked', String(this.checked))
    box.setAttribute('role', 'checkbox')
    // Matches MarkdownStyler.taskCheckboxRanges: the *glyph* (☑/☐) is a
    // floating overlay, but the checked state itself is real text on disk, and
    // toggling rewrites exactly one character — the one between the brackets,
    // not the whole "[x]" run. Keeping that one-character granularity means an
    // undo steps back over the toggle alone, and it keeps the file diff
    // identical to what the Mac build produces for the same action.
    box.onmousedown = (e) => {
      e.preventDefault()
      e.stopPropagation()
      const toggleFrom = this.pos + 1
      view.dispatch({
        changes: { from: toggleFrom, to: toggleFrom + 1, insert: this.checked ? ' ' : 'x' },
      })
    }
    return box
  }
  // Let the widget own its clicks: if the editor also handled them it would put
  // the cursor in the task, which reveals the raw "[x]" and fights the toggle.
  ignoreEvent() {
    return true
  }
}

/// Toggles the `- [ ]` / `- [x]` box on the caret's line — the keyboard twin of
/// clicking one. It makes the *same* one-character change the widget's
/// mousedown does (the character between the brackets, never the whole `[x]`),
/// so an undo steps back over the toggle alone and the file diff matches.
///
/// The line is the caret's, or the first line of a selection. False when that
/// line carries no checkbox, so a caller can let the key mean something else.
export function toggleTaskAtCursor(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.from)
  // The styler's own pattern, minus the global flag it needs for scanning a
  // whole document — one definition, so a change to what counts as a task
  // cannot leave the key toggling something the checkboxes don't draw.
  const m = new RegExp(P.taskList.source).exec(line.text)
  if (!m) return false
  const toggleFrom = line.from + m[1].length + 1
  view.dispatch({
    changes: { from: toggleFrom, to: toggleFrom + 1, insert: m[2][1] === ' ' ? 'x' : ' ' },
  })
  return true
}

/// Every embed currently on screen, so the app can refresh them when the
/// source changes on disk. Widgets add themselves on mount and drop out on
/// destroy.
const mountedEmbeds = new Set<EmbedWidget>()

/// Re-reads every visible embed from the store — the "always current" half of
/// transclusion. An embed being edited is skipped, so a refresh can never yank
/// text out from under someone mid-sentence.
export function refreshEmbeds() {
  for (const w of mountedEmbeds) void w.refresh()
}

function embedMessage(text: string): HTMLElement {
  const p = document.createElement('div')
  p.className = 'envy-embed-message'
  p.textContent = text
  return p
}

/// Decoded attachments, shared and reference-counted by name.
///
/// A widget's DOM is destroyed the moment its line leaves the viewport and
/// rebuilt when it comes back, so a picture that is scrolled past was re-read
/// over IPC and re-decoded on every crossing — the single most expensive thing
/// scrolling a note full of images could do. One entry per file holds the
/// in-flight read *and* the object URL, so N widgets on the same picture share
/// one fetch; the URL is revoked only after the last widget lets go and a short
/// grace expires, which is long enough for a scroll to come straight back and
/// short enough that closing a note doesn't keep its pictures resident.
interface AttachmentEntry {
  refs: number
  /// Resolves to null for a file that isn't there — cached like any other
  /// answer, so a missing image doesn't re-ask on every scroll either.
  bytes: Promise<ArrayBuffer | null>
  url: string | null
  evict: number | undefined
}

const attachmentCache = new Map<string, AttachmentEntry>()
const ATTACHMENT_GRACE_MS = 5000

function acquireAttachment(
  name: string,
  read: (name: string) => Promise<ArrayBuffer | null>,
): AttachmentEntry {
  let entry = attachmentCache.get(name)
  if (!entry) {
    entry = {
      refs: 0,
      url: null,
      evict: undefined,
      bytes: Promise.resolve()
        .then(() => read(name))
        .catch((e) => {
          console.error(`could not read attachment "${name}"`, e)
          return null
        }),
    }
    attachmentCache.set(name, entry)
  }
  if (entry.evict !== undefined) {
    clearTimeout(entry.evict)
    entry.evict = undefined
  }
  entry.refs++
  return entry
}

function releaseAttachment(name: string) {
  const entry = attachmentCache.get(name)
  if (!entry) return
  entry.refs--
  if (entry.refs > 0) return
  entry.evict = window.setTimeout(() => dropAttachment(name), ATTACHMENT_GRACE_MS)
}

function dropAttachment(name: string) {
  const entry = attachmentCache.get(name)
  if (!entry) return
  if (entry.evict !== undefined) clearTimeout(entry.evict)
  attachmentCache.delete(name)
  // Revoking a URL an <img> already loaded from is harmless — the bitmap is
  // the element's, not the URL's — so this is safe even with widgets still up.
  if (entry.url) URL.revokeObjectURL(entry.url)
}

/// The file behind `name` is no longer what was cached — it was renamed, or
/// replaced under us. The next widget to ask re-reads it.
export function invalidateAttachment(name: string) {
  dropAttachment(name)
}

/// Everything is suspect: the index changed and it doesn't say which files.
export function invalidateAttachments() {
  for (const name of [...attachmentCache.keys()]) dropAttachment(name)
}

/// The picker's entry point: it reads attachments through Rust directly rather
/// than through an embed host, but it is the same files, so it shares the cache
/// (and its grace period — reopening the picker within a few seconds decodes
/// nothing). Returns null for a file that isn't there.
export async function attachmentUrl(
  name: string,
  read: (name: string) => Promise<ArrayBuffer | null>,
): Promise<string | null> {
  const entry = acquireAttachment(name, read)
  const bytes = await entry.bytes
  if (!bytes) return null
  if (attachmentCache.get(name) !== entry) {
    // Invalidated while the read was in flight; the caller releases either way,
    // and a URL minted onto a detached entry would never be revoked.
    return null
  }
  if (!entry.url) entry.url = URL.createObjectURL(new Blob([bytes]))
  return entry.url
}

export function releaseAttachmentUrl(name: string) {
  releaseAttachment(name)
}

/// An `![[image.png]]` rendered as the picture itself, in a block below the
/// marker line — the twin of the note EmbedWidget, but for attachments. The
/// bytes and the object URL come from the shared cache above, so the same
/// picture is read and decoded once however many times it is scrolled past.
class ImageEmbedWidget extends WidgetType {
  private held = false
  private alive = true

  constructor(
    readonly spec: ImageEmbedSpec,
    readonly raw: string,
    readonly host: EmbedHost | null,
  ) {
    super()
  }

  private get name() {
    return this.spec.name
  }

  /// Same marker text → same rendered picture (name, size and caption all live
  /// in `raw`), so CodeMirror reuses the DOM and the decoded image across edits
  /// elsewhere; a size or caption change rebuilds it.
  eq(other: ImageEmbedWidget) {
    return other.raw === this.raw
  }

  /// The click and context-menu handlers are the widget's own; without this the
  /// outer editor would treat a click on the image as a click on opaque space
  /// and move its caret instead.
  ignoreEvent() {
    return true
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'envy-image-embed'
    const img = document.createElement('img')
    img.alt = this.name
    img.draggable = false
    // An explicit width/height caps the picture; max-width:100% (in CSS) still
    // holds it inside the text column, matching the Mac's min(width, column).
    if (this.spec.width !== undefined) img.style.width = `${this.spec.width}px`
    if (this.spec.height !== undefined) img.style.height = `${this.spec.height}px`
    // Double-click opens the picture in the default app. A single click does
    // nothing — otherwise clicking around the document keeps popping images open
    // in the background. (The right-click menu and Ctrl+clicking the filename
    // text are the other ways in.)
    img.addEventListener('dblclick', () => this.host?.openAttachment(this.name))
    // Right-click offers the size presets, delegated to the app (which owns the
    // menu and the document rewrite).
    wrap.addEventListener('contextmenu', (e) => {
      if (!this.host) return
      e.preventDefault()
      this.host.onImageContextMenu(this.raw, this.spec, e.clientX, e.clientY)
    })
    // Keyboard twins of the two mouse gestures above. The embed is a tab stop
    // so the picture can be reached at all without a mouse: Return opens it
    // (the double-click), Shift+F10 or the Menu key raises the same size and
    // rename menu the right-click does, anchored to the picture rather than to
    // a pointer that isn't there. Escape hands focus back to the document.
    wrap.tabIndex = 0
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.host?.openAttachment(this.name)
        return
      }
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        if (!this.host) return
        e.preventDefault()
        const box = wrap.getBoundingClientRect()
        this.host.onImageContextMenu(this.raw, this.spec, box.left + 12, box.bottom - 12)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        wrap.blur()
        view.focus()
      }
    })
    wrap.append(img)
    if (this.spec.caption) {
      const caption = document.createElement('div')
      caption.className = 'envy-image-caption'
      caption.textContent = this.spec.caption
      wrap.append(caption)
    }
    void this.load(img, wrap)
    return wrap
  }

  private async load(img: HTMLImageElement, wrap: HTMLElement) {
    // No host means a surface that doesn't serve attachments yet (the pop-out
    // and pinned windows). Render nothing rather than a false "missing" — the
    // file is fine, this window just can't fetch it.
    if (!this.host) return
    const host = this.host
    // `attachmentUrl` takes the ref synchronously; recording it only now means
    // `destroy` can never release one this widget was not actually given.
    const url = await attachmentUrl(this.name, (n) => host.readAttachment(n))
    this.held = true
    if (!this.alive) {
      // Destroyed mid-flight: nothing will call destroy again, so let go now.
      this.held = false
      releaseAttachment(this.name)
      return
    }
    if (!url) {
      this.showMissing(wrap)
      return
    }
    img.src = url
  }

  /// A missing file degrades to a placeholder rather than a broken-image icon,
  /// matching the Mac's dashed "Missing image" block. The reference text stays,
  /// so the note still records what should be there.
  private showMissing(wrap: HTMLElement) {
    wrap.classList.add('envy-image-embed-missing')
    wrap.textContent = `⚠ Missing image: ${this.name}`
  }

  destroy() {
    this.alive = false
    if (this.held) {
      this.held = false
      releaseAttachment(this.name)
    }
  }
}

class EmbedWidget extends WidgetType {
  private editor: MiniNoteEditor | null = null
  private body: HTMLElement | null = null

  constructor(
    readonly title: string,
    readonly host: EmbedHost | null,
    readonly hostNoteId: string | null,
  ) {
    super()
  }

  /// Reuse hinges on this. Returning false on every rebuild would tear down
  /// and recreate the nested editor on every keystroke in the host note,
  /// losing its cursor, its scroll position, and any edit in flight.
  eq(other: EmbedWidget) {
    return other.title === this.title && other.hostNoteId === this.hostNoteId
  }

  /// Events belong to the nested editor, not the host. Without this the outer
  /// view treats clicks inside the embed as clicks on an opaque widget and
  /// moves its own cursor instead.
  ignoreEvent() {
    return true
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    // A left rule rather than a box. A border frames the embed as a component
    // sitting in the note; a rule marks where the other note's text starts and
    // stops without pretending it's a different kind of thing — which is the
    // point of transclusion. Same device markdown already uses for
    // blockquotes.
    wrap.className = 'envy-embed'
    const body = document.createElement('div')
    body.className = 'envy-embed-body'
    wrap.append(body)
    this.body = body
    mountedEmbeds.add(this)
    void this.mount(body)
    return wrap
  }

  destroy() {
    mountedEmbeds.delete(this)
    this.editor?.destroy()
    this.editor = null
  }

  private async mount(body: HTMLElement) {
    if (!this.host) return
    let note: EmbedNote | null = null
    try {
      note = await this.host.resolve(this.title)
    } catch (e) {
      // A lookup that fails outright is not the same as a note that isn't
      // there, and silently leaving a bare rule on screen would be the worst
      // of both — it reads as an empty note rather than a problem.
      console.error(`could not resolve embed "${this.title}"`, e)
      if (this.body === body) body.replaceChildren(embedMessage('Could not load this note'))
      return
    }
    // The widget may have been torn down while the lookup was in flight.
    if (this.body !== body) return

    if (!note) {
      body.replaceChildren(embedMessage('Note not found'))
      return
    }
    // Rendering a second live, independently-editable copy of the buffer
    // you're already typing in means two debounced saves racing, each
    // silently discarding the other's work.
    if (note.id === this.hostNoteId) {
      body.replaceChildren(embedMessage('Already open above'))
      return
    }

    body.replaceChildren()
    // The same editor the link preview uses — one code path for "show another
    // note's content and let me click into it".
    const host = this.host
    this.editor = createMiniNoteEditor(body, note, (id, content) => host.save(id, content))
  }

  /// Pull fresh content from the store, unless this embed is the one being
  /// typed into.
  async refresh() {
    const editor = this.editor
    if (!this.host || !editor || editor.isEditable()) return
    const note = await this.host.resolve(this.title)
    if (!note || this.editor !== editor) return
    if (note.content === editor.view.state.doc.toString()) return
    editor.setContent(note.content)
  }
}

interface Mark {
  from: number
  to: number
  deco: Decoration
}

const mark = (cls: string) => Decoration.mark({ class: cls })
const hidden = Decoration.replace({})

// --- Link pills --------------------------------------------------------------

/// The domain a bare URL should show — its host, with any leading `www.`
/// dropped. `null` for a string with no `://host`, which then falls back to
/// plain full-URL styling rather than collapsing to nothing.
///
/// Parsed by hand rather than with `URL`, which is lenient in ways that hurt
/// here: it happily accepts a truncated URL mid-typing and invents a host.
export function urlDomain(urlText: string): string | null {
  const sep = urlText.indexOf('://')
  if (sep < 0) return null
  let start = sep + 3
  let end = urlText.length
  for (let i = start; i < urlText.length; i++) {
    const c = urlText[i]
    if (c === '/' || c === '?' || c === '#') {
      end = i
      break
    }
  }
  if (end - start > 4 && urlText.slice(start, start + 4).toLowerCase() === 'www.') {
    start += 4
  }
  return end > start ? urlText.slice(start, end) : null
}

/// Per-domain emoji for link pills — a preference, not note content.
///
/// The note holds the plain URL; the emoji is presentation keyed by the site,
/// so every link to one domain carries the same mark and nothing is written
/// into the file. Read straight from storage rather than passed in, because a
/// widget is rebuilt on every restyle anyway and threading it through the
/// facets would buy nothing.
function domainEmoji(domain: string): string | null {
  return configMap('domain_emojis')[domain] ?? null
}

/// Whether bare URLs collapse to domain pills. Read from the config for the
/// same reason as the emoji map — the setting changes rarely and a restyle
/// repaints when it does. Defaults on, matching the Mac.
function domainPillsEnabled(): boolean {
  return getBool('editor', 'link_domain_pills')
}

/// A bare URL collapsed to `emoji domain ↗`.
class UrlPillWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly domain: string,
    /// Captured at build time rather than read in `toDOM`, so that `eq` can see
    /// it. A widget whose `eq` returns true keeps its existing DOM and is never
    /// asked to build again — so comparing only the URL and domain meant a
    /// newly chosen emoji did not appear until something else forced the pill
    /// to be rebuilt, which is exactly the symptom: it changed after leaving
    /// the note and coming back.
    readonly emoji: string | null,
  ) {
    super()
  }

  eq(other: UrlPillWidget) {
    return (
      other.url === this.url && other.domain === this.domain && other.emoji === this.emoji
    )
  }

  toDOM() {
    const pill = document.createElement('span')
    pill.className = 'envy-url-pill'
    pill.title = this.url
    const emoji = this.emoji
    if (emoji) {
      const e = document.createElement('span')
      e.className = 'envy-url-emoji'
      e.textContent = emoji
      pill.append(e)
    }
    const label = document.createElement('span')
    label.className = 'envy-url-domain'
    label.textContent = this.domain
    pill.append(label)
    const arrow = document.createElement('span')
    arrow.className = 'envy-url-arrow'
    arrow.textContent = '↗'
    pill.append(arrow)
    // The URL rides along so the click and right-click handlers in the app can
    // act without re-parsing the document.
    pill.dataset.url = this.url
    pill.dataset.domain = this.domain
    return pill
  }

  /// The pill handles its own clicks — without this the view treats them as
  /// clicks on an opaque widget and just moves the caret.
  ignoreEvent() {
    return true
  }
}

const styles = {
  boldItalic: mark('envy-bold envy-italic'),
  bold: mark('envy-bold'),
  italic: mark('envy-italic'),
  strikethrough: mark('envy-strike'),
  highlight: mark('envy-highlight-mark'),
  code: mark('envy-code'),
  codeBlock: mark('envy-code-block'),
  link: mark('envy-link'),
  wikiLink: mark('envy-wikilink'),
  /// A `[[link]]` whose target doesn't exist yet — the same link, dimmed, so a
  /// glance separates kept promises from IOUs. Still clickable (click creates
  /// the note), same as the Mac.
  ghostLink: mark('envy-wikilink envy-wikilink-ghost'),
  tag: mark('envy-tag'),
  blockquote: mark('envy-blockquote'),
  blockquoteText: mark('envy-blockquote-text'),
  /// The rule and the indent live on the *line*, not on the text span: an
  /// inline span's left border is drawn once, at its start, so a wrapped
  /// quote showed the bar beside its first visual line only. A line
  /// decoration boxes every wrapped row.
  blockquoteLine: Decoration.line({ class: 'envy-blockquote-line' }),
  footnote: mark('envy-footnote'),
  /// A footnote *reference* `[^1]` — the label rendered as a small raised
  /// superscript in the link colour, with the `[^`/`]` hidden, matching the Mac.
  footnoteRef: mark('envy-footnote-ref'),
  /// A footnote *definition*'s number, superscripted like the reference but in
  /// the dim footnote colour (it's the passive end, not a clickable link).
  footnoteDefNum: mark('envy-footnote-defnum'),
  /// A list marker (`-`/`+`/`*` or `1.`) dimmed so the content reads first.
  listMarker: mark('envy-list-marker'),
  completedTask: mark('envy-completed-task'),
  marker: mark('envy-marker'),
  hr: mark('envy-hr'),
} as const

/// Envy hides markup only when the cursor is elsewhere — 1.3.0's "a link stays
/// editable once your cursor is inside it". That single rule is what makes a
/// no-preview-pane editor usable: without it, styling fights the person typing.
///
/// An *unfocused* editor reveals nothing at all. A CodeMirror state always
/// carries a selection, and a fresh one sits at position 0 — so without this
/// check, any document beginning with a heading showed its `#` until something
/// moved the cursor. Most visible inside an embed, which is unfocused by
/// design until clicked, but the host editor had it too on every note that
/// opened with a heading.
///
/// The Mac does the same thing by passing its selection only while the text
/// view is first responder, and nil otherwise.
function selectionTouches(view: EditorView, from: number, to: number): boolean {
  if (!view.hasFocus) return false
  for (const r of view.state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true
  }
  return false
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/// The same quote-aware tokenizer the search itself uses, so what lights up
/// matches what was searched. A naive space split would treat a quoted phrase
/// as the literal string `"build"`, quotes and all, and highlight nothing.
function tokenizeQuery(q: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of q) {
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
    } else if (ch === ' ' && !inQuotes) {
      if (current) out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) out.push(current)
  return out
}

/// Operators that name nothing a note's text actually contains.
///
/// They filter on when a note was touched, where it sits, what points at it,
/// whether it has an unfinished task — none of which is written anywhere in
/// the prose. Highlighting them would light up the literal word in any note
/// unlucky enough to contain it: a note mentioning "todo:" would glow for a
/// `todo:` search that matched it for an entirely different reason.
///
/// `tag:` is deliberately absent. A tag *is* in the text, so it is handled
/// below by highlighting the matched part of each qualifying `#tag`. `title:`
/// is absent for the same reason — its argument is real title text, so it falls
/// through to the ordinary highlighter.
const NON_LITERAL_OPERATORS =
  /^(date|stale|due|link|interlink|folder|img|embed|ghost|todo|ai|inbox|template|trash|orphan|linked):/

/// Ranges in `text` that the query matches, for highlighting.
///
/// Each word highlights independently: a scattered multi-word AND search has
/// no single contiguous phrase to find in the first place. Operators that name
/// nothing literal in a note's text highlight nothing, because there is
/// nothing in the prose that corresponds to them — see
/// `NON_LITERAL_OPERATORS`.
function searchMatchRanges(text: string, query: string): Array<[number, number]> {
  const trimmed = query.trim()
  if (!trimmed || !text) return []
  const out: Array<[number, number]> = []

  const addPattern = (pattern: string) => {
    let re: RegExp
    try {
      // The `u` flag is load-bearing, not decoration: `\p{L}` and `\p{N}` are
      // only Unicode property escapes in unicode mode. Without it they parse
      // as a character class of the literal characters p, {, L, } — so the
      // word-boundary guard silently stops guarding, and a closed-quote search
      // for "nee" lights up the "nee" inside "needed".
      re = new RegExp(pattern, 'gui')
    } catch {
      return
    }
    for (const m of text.matchAll(re)) {
      if (m[0].length > 0) out.push([m.index!, m.index! + m[0].length])
    }
  }
  const addLiteral = (literal: string) => addPattern(escapeRegex(literal))

  for (const token of tokenizeQuery(trimmed)) {
    const lowered = token.toLowerCase()
    // An exclusion highlights nothing — the same rule the quoted branch below
    // states and applies. It holds for every kind: `-oranges`, `-tag:x`,
    // `-due:overdue`. Without this they fell through to the literal branch and
    // were searched for verbatim, hyphen and all.
    if (lowered.startsWith('-') && lowered.length > 1) continue
    if (NON_LITERAL_OPERATORS.test(lowered)) continue

    if (token.startsWith('"')) {
      // A *closed* quote matched on word boundaries, so it highlights on word
      // boundaries too — otherwise "nee" would light up inside "needed" in a
      // note that only matched the whole word. An open, still-being-typed
      // quote highlights as the substring it matched as.
      //
      // `-"phrase"` no longer reaches here: the exclusion check above catches
      // every kind of exclusion, this one included.
      const phrase = token.replace(/^"/, '').replace(/"$/, '')
      if (!phrase) continue
      if (token.length >= 2 && token.endsWith('"')) {
        addPattern(`(?<![\\p{L}\\p{N}_])${escapeRegex(phrase)}(?![\\p{L}\\p{N}_])`)
      } else {
        addLiteral(phrase)
      }
      continue
    }

    if (lowered.startsWith('tag:')) {
      // "tag:techn" matches "#technology", so highlight just the matched
      // substring inside each qualifying tag rather than the tag's whole
      // extent — consistent with a plain search only lighting up what was
      // actually typed.
      const name = lowered.slice('tag:'.length)
      if (!name) continue
      for (const m of text.matchAll(/(?<![\w#])#[A-Za-z0-9_-]+/g)) {
        const at = m[0].toLowerCase().indexOf(name)
        if (at < 0) continue
        out.push([m.index! + at, m.index! + at + name.length])
      }
      continue
    }

    addLiteral(token)
  }
  return out
}

/// The offset of the earliest range in `text` that `query` lights up, or null
/// when the query paints nothing here — no match at all, or a query made only
/// of operators that name nothing literal (`due:`, `orphan:`, an exclusion).
/// Drives the editor's scroll-to-match: it shares its matching rules with the
/// highlighting itself, so where the view jumps can't drift from what actually
/// lit up. Mirrors the Mac's `MarkdownStyler.firstSearchMatch`.
export function firstSearchMatch(text: string, query: string): number | null {
  let earliest: number | null = null
  for (const [start] of searchMatchRanges(text, query)) {
    if (earliest === null || start < earliest) earliest = start
  }
  return earliest
}

/// The note a `[[…]]` body points at — alias and heading stripped. Mirrors
/// `WikiLink::parse` in envy-core.
function wikiLinkTarget(body: string): string {
  return body.split('|')[0].split('#')[0].trim()
}

function buildDecorations(view: EditorView): DecorationSet {
  // Plain-text mode styles nothing at all — not even the search highlight,
  // since the point is to see the file exactly as it is.
  if (view.state.field(plainTextField, false)) return Decoration.none

  const marks: Mark[] = []
  const doc = view.state.doc
  // The existing-title set for the ghost-link check, read once per pass.
  const titles = view.state.facet(existingTitles)()

  // Expand each visible range out to whole lines — the ^-anchored patterns are
  // wrong on a slice that starts mid-line, and CM6's visibleRanges make no
  // line guarantees.
  //
  // Then MERGE the expanded ranges. Two adjacent visible ranges can meet
  // inside a single line, and expanding both to that line's bounds makes them
  // overlap — so the line would be scanned twice and every decoration on it
  // emitted twice. Duplicate `replace` decorations over identical ranges make
  // CM6 render the markup it was told to hide. Whether any given line lands on
  // such a seam depends on scroll offset and pane height, which is exactly why
  // this surfaced on one heading and not an identical one further down.
  const spans: Array<[number, number]> = []
  for (const { from, to } of view.visibleRanges) {
    const start = doc.lineAt(from).from
    const end = doc.lineAt(to).to
    const last = spans[spans.length - 1]
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end)
    } else {
      spans.push([start, end])
    }
  }
  // Replaced tables and fences are block widgets covering those lines. Marks
  // inside the same range fight the replacement (CodeMirror drops one or both),
  // so punch them out of the scan before any inline pass runs.
  punchOut(spans, replacedBlockRanges(view.state))

  for (const [base, spanEnd] of spans) {
    const text = doc.sliceString(base, spanEnd)

    // Code wins over everything nested inside it. Collected first so later
    // scans can skip anything overlapping — mirrors MarkdownStyler's own
    // precedence, where a `*` inside a fence is not emphasis.
    const codeRanges: Array<[number, number]> = []
    const claimCode = (a: number, b: number) => codeRanges.push([a, b])
    const insideCode = (a: number, b: number) =>
      codeRanges.some(([x, y]) => a < y && b > x)

    for (const m of text.matchAll(P.fencedCodeBlock)) {
      const s = base + m.index!
      const e = s + m[0].length
      claimCode(s, e)
      marks.push({ from: s, to: e, deco: styles.codeBlock })
    }
    for (const m of text.matchAll(P.code)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (insideCode(s, e)) continue
      claimCode(s, e)
      marks.push({ from: s, to: e, deco: styles.code })
      if (!selectionTouches(view, s, e)) {
        marks.push({ from: s, to: s + 1, deco: hidden })
        marks.push({ from: e - 1, to: e, deco: hidden })
      }
    }

    // Retirement ranges — a due token inside "~~...~~" or on a checked task
    // line is retired, exactly as Note.activeDueDates computes it. Rendering
    // has to agree with the model or the pill and the search disagree.
    const retired: Array<[number, number]> = []
    for (const m of text.matchAll(P.strikethrough)) {
      retired.push([base + m.index!, base + m.index! + m[0].length])
    }
    for (const m of text.matchAll(P.checkedTaskLine)) {
      retired.push([base + m.index!, base + m.index! + m[0].length])
    }
    const isRetired = (a: number, b: number) =>
      retired.some(([x, y]) => a < y && b > x)

    // --- Block constructs -------------------------------------------------
    // Line-level constructs are gated on their *marker* sitting in code (a
    // fenced block swallows the whole line, marker included), not on the
    // line overlapping a code span: a heading, quote or task that merely
    // contains `inline code` is still a heading, quote or task.
    for (const m of text.matchAll(P.header)) {
      const s = base + m.index!
      const level = m[1].length
      const markerEnd = s + m[1].length + (m[0].length - m[1].length - m[2].length)
      if (insideCode(s, markerEnd)) continue
      marks.push({ from: s, to: s + m[0].length, deco: mark(`envy-h${level}`) })
      if (!selectionTouches(view, s, s + m[0].length)) {
        marks.push({ from: s, to: markerEnd, deco: hidden })
      } else {
        marks.push({ from: s, to: markerEnd, deco: styles.marker })
      }
    }

    for (const m of text.matchAll(P.blockquote)) {
      const s = base + m.index!
      const end = s + m[0].length
      if (insideCode(s, s + m[1].length)) continue
      // A bare ">" with nothing after it is left alone entirely, as on the Mac
      // — no rule, no indent, no collapse. There is no quote yet, only the
      // character that starts one, and hiding it would delete what you just
      // typed from under the cursor.
      if (m[2].length === 0) continue
      const markerEnd = s + m[1].length
      marks.push({ from: s, to: s, deco: styles.blockquoteLine })
      marks.push({ from: s, to: end, deco: styles.blockquote })
      // Italic on the content alone, not the marker — the Mac applies the
      // italic font to its contentRange only, the same way every other element
      // here confines marker colour to the marker's own range.
      marks.push({ from: markerEnd, to: end, deco: styles.blockquoteText })
      // The ">" is markup, so it collapses once the cursor leaves the line and
      // comes back the moment it returns — exactly as headings and task boxes
      // already do. Leaving it permanently visible was the odd one out.
      if (!selectionTouches(view, s, end)) {
        marks.push({ from: s, to: markerEnd, deco: hidden })
      } else {
        marks.push({ from: s, to: markerEnd, deco: styles.marker })
      }
    }

    for (const m of text.matchAll(P.horizontalRule)) {
      const s = base + m.index!
      if (insideCode(s, s + m[0].length)) continue
      marks.push({ from: s, to: s + m[0].length, deco: styles.hr })
    }

    for (const m of text.matchAll(P.taskList)) {
      const s = base + m.index!
      const boxFrom = s + m[1].length
      if (insideCode(s, boxFrom + 3)) continue
      const checked = m[2][1] !== ' '
      if (!selectionTouches(view, boxFrom, boxFrom + 3)) {
        marks.push({
          from: boxFrom,
          to: boxFrom + 3,
          deco: Decoration.replace({ widget: new CheckboxWidget(checked, boxFrom) }),
        })
      }
      if (checked) {
        // The strike covers the words alone. m[3] starts with the whitespace
        // between "]" and the text, and may end with trailing whitespace; a
        // line drawn across either reaches back to the box or past the last
        // letter, and the Mac stops it at the text.
        const rest = m[3]
        const textFrom = boxFrom + 3 + (rest.length - rest.trimStart().length)
        const textTo = boxFrom + 3 + rest.trimEnd().length
        if (textTo > textFrom) {
          marks.push({ from: textFrom, to: textTo, deco: styles.completedTask })
        }
      }
    }

    for (const m of text.matchAll(P.footnoteDefinition)) {
      const s = base + m.index!
      const markerEnd = s + m[0].length
      if (insideCode(s, markerEnd)) continue
      // The definition text (everything after the "[^n]:" marker) reads as a
      // small, dim footnote. The marker collapses to just its number, shown as
      // a superscript so you can tell which reference a definition answers to —
      // the "[^" and "]:" hide, the number stays. (The Mac hides the number
      // too; keeping it is the clearer call.) Revealed raw when the caret's on.
      const lineEnd = doc.lineAt(s).to
      if (lineEnd > markerEnd) {
        marks.push({ from: markerEnd, to: lineEnd, deco: styles.footnote })
      }
      if (!selectionTouches(view, s, markerEnd)) {
        const numFrom = s + 2 // after "[^"
        const numTo = numFrom + m[1].length
        marks.push({ from: s, to: numFrom, deco: hidden })
        marks.push({ from: numFrom, to: numTo, deco: styles.footnoteDefNum })
        marks.push({ from: numTo, to: markerEnd, deco: hidden })
      } else {
        marks.push({ from: s, to: markerEnd, deco: styles.marker })
      }
    }

    // --- Inline constructs ------------------------------------------------
    // Order matters and mirrors the Swift: *** before ** before *, and embed
    // before wikiLink so "![[X]]" isn't read as a bare "[[X]]" with a stray "!".
    // Underscore forms sit next to their asterisk twins so `__bold__` claims
    // before `_italic_`, the same way `**` claims before `*`.
    const inline: Array<[RegExp, Decoration, number]> = [
      [P.embed, styles.wikiLink, 3],
      [P.wikiLink, styles.wikiLink, 2],
      [P.boldItalic, styles.boldItalic, 3],
      [P.bold, styles.bold, 2],
      [P.boldUnderscore, styles.bold, 2],
      [P.italic, styles.italic, 1],
      [P.italicUnderscore, styles.italic, 1],
      [P.strikethrough, styles.strikethrough, 2],
    ]
    const claimed: Array<[number, number]> = []
    for (const [re, baseDeco, markerLen] of inline) {
      for (const m of text.matchAll(re)) {
        const s = base + m.index!
        const e = s + m[0].length
        if (insideCode(s, e)) continue
        if (claimed.some(([x, y]) => s < y && e > x)) continue
        claimed.push([s, e])
        // A `[[link]]` or `![[embed]]` whose target doesn't exist yet is
        // dimmed. m[1] is the body; the marker hides/reveals still land on the
        // brackets, so only the body carries the ghost colour — as on the Mac.
        const deco =
          (re === P.wikiLink || re === P.embed) &&
          !titleResolves(wikiLinkTarget(m[1]), titles)
            ? styles.ghostLink
            : baseDeco
        marks.push({ from: s, to: e, deco })
        if (!selectionTouches(view, s, e)) {
          marks.push({ from: s, to: s + markerLen, deco: hidden })
          marks.push({ from: e - (markerLen === 3 && re === P.embed ? 2 : markerLen), to: e, deco: hidden })
          // `[[Note|shown]]` shows only "shown": collapse the "Note|" the same
          // way a `[text](url)` hides its target, so an aliased link reads as
          // its alias. A `#heading` (no pipe) is left as written, like the Mac.
          if (re === P.wikiLink) {
            const pipe = m[1].indexOf('|')
            if (pipe !== -1) {
              marks.push({ from: s + markerLen, to: s + markerLen + pipe + 1, deco: hidden })
            }
          }
          // An image embed shows just its filename: hide the `|width|caption`
          // suffix so `![[photo.png|400]]` reads as "photo.png", the size and
          // caption living on the rendered picture below. Matches the Mac
          // collapsing the size token.
          if (re === P.embed && isImageTarget(wikiLinkTarget(m[1]))) {
            const pipe = m[1].indexOf('|')
            if (pipe !== -1) {
              marks.push({ from: s + markerLen + pipe, to: e - 2, deco: hidden })
            }
          }
        } else {
          marks.push({ from: s, to: s + markerLen, deco: styles.marker })
          marks.push({ from: e - (markerLen === 3 && re === P.embed ? 2 : markerLen), to: e, deco: styles.marker })
        }
      }
    }

    // `==highlight==` is the last inline pass, as on the Mac: everything else
    // has claimed its ranges by now, and the search pass still paints after.
    // The two share a colour, so a marked word that is also a search match
    // simply stays marked — the honest outcome of reusing one colour for both.
    // Inline code and fenced blocks are already claimed, so `a == b` inside
    // backticks is left alone for free.
    //
    // It gets its own pass rather than joining the loop above because the
    // background belongs to the *content* alone, never the markers — the Mac
    // applies it to `match.range(at: 1)` for the same reason. Painting the whole
    // match instead puts the revealed `==` on the highlight, where the dim
    // marker colour is chosen to be quiet against the page and comes out barely
    // readable against amber.
    for (const m of text.matchAll(P.highlight)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (insideCode(s, e)) continue
      if (claimed.some(([x, y]) => s < y && e > x)) continue
      claimed.push([s, e])
      marks.push({ from: s + 2, to: e - 2, deco: styles.highlight })
      if (!selectionTouches(view, s, e)) {
        marks.push({ from: s, to: s + 2, deco: hidden })
        marks.push({ from: e - 2, to: e, deco: hidden })
      } else {
        marks.push({ from: s, to: s + 2, deco: styles.marker })
        marks.push({ from: e - 2, to: e, deco: styles.marker })
      }
    }

    for (const m of text.matchAll(P.link)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (insideCode(s, e)) continue
      marks.push({ from: s, to: e, deco: styles.link })
      if (!selectionTouches(view, s, e)) {
        marks.push({ from: s, to: s + 1, deco: hidden })
        marks.push({ from: s + 1 + m[1].length, to: e, deco: hidden })
      }
    }

    const domainPills = domainPillsEnabled()
    for (const re of [P.autolinkBracket, P.bareURL]) {
      for (const m of text.matchAll(re)) {
        const s = base + m.index!
        const e = s + m[0].length
        if (insideCode(s, e)) continue
        if (claimed.some(([x, y]) => s < y && e > x)) continue
        marks.push({ from: s, to: e, deco: styles.link })

        // A bare URL collapses to a pill showing just its domain. Bracketed
        // autolinks keep their full text: someone wrote the brackets to say
        // "this is a URL", and hiding it would undo that.
        if (re !== P.bareURL) continue
        // With pills off, the URL stays a full-length link — still styled and
        // clickable, just never collapsed. Matches the Mac's linkDomainPills.
        if (!domainPills) continue
        const domain = urlDomain(m[0])
        // No `://host` to show means nothing to collapse to, so it stays a
        // plain full-length link rather than becoming an empty pill.
        if (!domain) continue
        // Revealed while the cursor is inside it, exactly like every other
        // marker — a pill you cannot put the caret into is a link you cannot
        // edit.
        if (selectionTouches(view, s, e)) continue
        marks.push({
          from: s,
          to: e,
          deco: Decoration.replace({
            widget: new UrlPillWidget(m[0], domain, domainEmoji(domain)),
          }),
        })
      }
    }

    for (const m of text.matchAll(P.footnoteReference)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (insideCode(s, e)) continue
      // A definition marker "[^1]:" is styled by the definition pass above, not
      // here — the colon straight after the "]" is what tells them apart.
      if (doc.sliceString(e, e + 1) === ':') continue
      const labelFrom = s + 2 // after "[^"
      const labelTo = e - 1 // before "]"
      marks.push({ from: labelFrom, to: labelTo, deco: styles.footnoteRef })
      // Hide the "[^" and "]" so the reference reads as a bare superscript,
      // revealing them (as markers) only when the cursor is inside — the same
      // hide/reveal every other markup gets.
      if (!selectionTouches(view, s, e)) {
        marks.push({ from: s, to: labelFrom, deco: hidden })
        marks.push({ from: labelTo, to: e, deco: hidden })
      } else {
        marks.push({ from: s, to: labelFrom, deco: styles.marker })
        marks.push({ from: labelTo, to: e, deco: styles.marker })
      }
    }

    // List markers: dim the bullet/number so the content leads, and show a `*`
    // as a `•` glyph. The marker char on disk is untouched; the `*` reveals
    // back when the caret is on it. Mirrors the Mac's listMarkerColor + glyph.
    for (const m of text.matchAll(P.unorderedList)) {
      const ms = base + m.index! + m[1].length
      const me = ms + 1
      if (insideCode(ms, me)) continue
      if (m[2] === '*' && !selectionTouches(view, ms, me)) {
        marks.push({ from: ms, to: me, deco: bulletWidget })
      } else {
        marks.push({ from: ms, to: me, deco: styles.listMarker })
      }
    }
    for (const m of text.matchAll(P.orderedList)) {
      const ms = base + m.index! + m[1].length
      const me = ms + m[2].length
      if (insideCode(ms, me)) continue
      marks.push({ from: ms, to: me, deco: styles.listMarker })
    }

    for (const m of text.matchAll(P.hashtag)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (insideCode(s, e)) continue
      marks.push({ from: s, to: e, deco: styles.tag })
    }

    for (const m of text.matchAll(P.due)) {
      const s = base + m.index!
      const e = s + m[0].length
      if (insideCode(s, e)) continue
      if (isRetired(s, e)) continue
      const date = resolveDueToken(m[1])
      if (!date) continue // unparseable just means no due date, never a crash
      marks.push({ from: s, to: e, deco: mark(`envy-due envy-due-${urgencyFor(date)}`) })
    }
  }

  // Search highlights go on last so they layer over whatever styling a span
  // already has — a match can land on bold text, a link, a tag or plain prose,
  // and it should read as a match in every one of those.
  const query = view.state.field(searchQueryField, false) ?? ''
  if (query.trim()) {
    for (const [base, spanEnd] of spans) {
      const text = doc.sliceString(base, spanEnd)
      for (const [s, e] of searchMatchRanges(text, query)) {
        marks.push({ from: base + s, to: base + e, deco: mark('envy-search-match') })
      }
    }
  }

  marks.sort((a, b) => a.from - b.from || a.to - b.to)
  return Decoration.set(
    marks.map((m) => m.deco.range(m.from, m.to)) as Range<Decoration>[],
    true,
  )
}

/// Subtract `holes` from `spans` in place. Each hole is a `[from, to)` range
/// that should not be scanned — used to keep inline marks off replaced tables.
function punchOut(spans: Array<[number, number]>, holes: Array<[number, number]>) {
  if (holes.length === 0) return
  for (const [hFrom, hTo] of holes) {
    for (let i = 0; i < spans.length; i++) {
      const [s, e] = spans[i]
      if (hTo <= s || hFrom >= e) continue
      if (hFrom <= s && hTo >= e) {
        spans.splice(i, 1)
        i--
        continue
      }
      if (hFrom <= s) {
        spans[i][0] = hTo
        continue
      }
      if (hTo >= e) {
        spans[i][1] = hFrom
        continue
      }
      spans.splice(i, 1, [s, hFrom], [hTo, e])
      i++
    }
  }
}

/// `findTableBlocks`/`findFencedBlocks` each walk the whole document line by
/// line, and they depend on nothing but the text. Yet a single keystroke calls
/// them ~4 times (both block state fields, plus the inline plugin's
/// `replacedBlockRanges`), and a bare cursor move calls them again — even though
/// the *set* of blocks cannot change without a doc edit; only whether each is
/// revealed can. Memoize both by the document: CodeMirror's `Text` is immutable,
/// so identity is a sound key. A doc edit produces a new `Text` and recomputes;
/// a selection change keeps the same `Text` and hits the cache. Turns the N
/// whole-document scans per update into one, and none at all on cursor movement.
let blockCache: { doc: Text; tables: TableBlock[]; fences: FenceBlock[] } | null = null

function blocksFor(doc: Text): { tables: TableBlock[]; fences: FenceBlock[] } {
  if (!blockCache || blockCache.doc !== doc) {
    blockCache = { doc, tables: findTableBlocks(doc), fences: findFencedBlocks(doc) }
  }
  return blockCache
}

function replacedBlockRanges(state: EditorState): Array<[number, number]> {
  if (state.field(plainTextField, false)) return []
  const { tables, fences } = blocksFor(state.doc)
  const out: Array<[number, number]> = []
  for (const block of tables) {
    if (shouldReplaceRange(state, block.from, block.to)) out.push([block.from, block.to])
  }
  for (const block of fences) {
    if (shouldReplaceRange(state, block.from, block.to)) out.push([block.from, block.to])
  }
  return out
}

function shouldReplaceRange(state: EditorState, from: number, to: number): boolean {
  if (state.field(plainTextField, false)) return false
  // Unfocused: always the HTML widget, matching the rest of the styler's
  // "reveal markup only while the caret is in it" rule. A StateField cannot
  // read `view.hasFocus`, so `editorFocusedField` is the stand-in.
  if (!state.field(editorFocusedField, false)) return true
  return !selectionOverlapsRange(state, from, to)
}

/// `[from, to)` overlap. An empty caret at `to` (the line after the block)
/// is outside it, so the widget stays up.
function selectionOverlapsRange(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.empty) {
      if (r.head >= from && r.head < to) return true
    } else if (r.from < to && r.to > from) {
      return true
    }
  }
  return false
}

/// Rendered GFM tables. Block widgets (so they have to live in a StateField:
/// "Block decorations may not be specified via plugins"). The pipe source
/// stays on disk; when the cursor is outside the table it is replaced with
/// the same HTML the Omarchy manual produces for that markdown — `<table>` /
/// `<thead>` / `<tbody>`, code chips, linked cells.
///
/// The cells are editable in place. Every keystroke in one rebuilds *that row's
/// source line* and dispatches it as an ordinary transaction, so the file still
/// holds the pipes, undo still works, and there is no second model of the table
/// anywhere. Three things keep the widget alive across its own edits:
///
/// - `eq` compares the source, so a table nothing touched keeps its DOM
///   whatever else the transaction did. It compares `from` as well: the cached
///   block behind the DOM is only refreshed in `updateDOM`, so a table that
///   *moved* has to go through there rather than be reused with stale offsets.
/// - `updateDOM` patches the cell text in place when only content changed, so
///   the focused cell is never re-created and never loses its caret. Anything
///   that changes the shape (a row, a column, an alignment) rebuilds, and the
///   caller puts focus back afterwards.
/// - the CodeMirror selection is parked just after the block while a cell has
///   focus, so the "cursor is inside the block → show the pipes" rule cannot
///   fire underneath the person typing.
class TableWidget extends WidgetType {
  constructor(readonly block: TableBlock) {
    super()
  }
  eq(other: TableWidget) {
    return other.block.src === this.block.src && other.block.from === this.block.from
  }
  get estimatedHeight() {
    return 8 + (1 + this.block.rows.length) * 32
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'envy-md-table-wrap'
    tableStates.set(wrap, { view, block: this.block })
    wrap.append(
      buildTableToolbar(wrap),
      buildTableScroller(this.block, view.state.facet(EditorView.editable)),
    )
    wireTable(wrap)
    return wrap
  }
  updateDOM(dom: HTMLElement, _view: EditorView, old: TableWidget) {
    const state = tableStates.get(dom)
    if (!state) return false
    // The reuse search offers this widget every table tile in turn, so the
    // pairing has to be checked rather than assumed: the same block either
    // stayed put and changed (same `from`) or moved without changing (same
    // source). Anything else is a different table and must not be patched.
    if (old.block.from !== this.block.from && old.block.src !== this.block.src) return false
    if (tableShape(old.block) !== tableShape(this.block)) return false
    state.block = this.block
    const active = dom.ownerDocument.activeElement
    for (const cell of dom.querySelectorAll<HTMLElement>('th[data-row], td[data-row]')) {
      // The focused cell already holds what the person typed — rewriting it
      // would destroy the caret to say something it already says.
      if (cell === active) continue
      const raw = cellRaw(this.block, Number(cell.dataset.row), Number(cell.dataset.col))
      if (cell.dataset.raw !== raw) renderTableCellInto(cell, raw, false)
    }
    return true
  }
  destroy(dom: HTMLElement) {
    tableStates.delete(dom)
  }
  /// Everything inside the widget is the widget's: cells handle their own
  /// keys, input and clicks, and CodeMirror must not also act on them.
  ignoreEvent() {
    return true
  }
}

/// The live block behind a rendered table, kept honest by `toDOM`/`updateDOM`.
/// Handlers read it from here rather than closing over the widget they were
/// created with, because that widget is replaced on every transaction.
interface TableState {
  view: EditorView
  block: TableBlock
}
const tableStates = new WeakMap<HTMLElement, TableState>()

/// Rows × columns × alignments. Two blocks with the same shape can swap cell
/// text without the DOM changing structure — the test `updateDOM` patches on.
function tableShape(block: TableBlock): string {
  return `${block.rows.length}x${tableCols(block)}:${block.aligns.join(',')}`
}

function tableCols(block: TableBlock): number {
  return Math.max(block.header.length, block.aligns.length, ...block.rows.map((r) => r.length))
}

/// Row 0 is the header; row n+1 is `rows[n]`, the same numbering the DOM and
/// `tableRowLines` use.
function cellRaw(block: TableBlock, row: number, col: number): string {
  const cells = row === 0 ? block.header : (block.rows[row - 1] ?? [])
  return cells[col] ?? ''
}

/// Whether the webview honours `contenteditable="plaintext-only"`. WebKitGTK
/// versions differ, and the fallback (`true` plus a paste that is sanitised to
/// text) has to be chosen at runtime rather than guessed at build time.
let plaintextOnly: boolean | null = null
function supportsPlaintextOnly(): boolean {
  if (plaintextOnly === null) {
    const probe = document.createElement('div')
    try {
      probe.contentEditable = 'plaintext-only'
    } catch {
      // Older WebKit throws on the unknown value rather than ignoring it.
    }
    plaintextOnly = probe.contentEditable === 'plaintext-only'
  }
  return plaintextOnly
}

/// A cell's content: the formatted inline markdown when it is at rest, the raw
/// cell markdown while it is being edited. Editing formatted DOM is how these
/// widgets usually go wrong — `**a**` renders as `a`, and there is no honest
/// way back from that — so the swap happens on focus and reverses on blur.
function renderTableCellInto(cell: HTMLElement, raw: string, asRaw: boolean) {
  cell.dataset.raw = raw
  if (asRaw) {
    if (cell.textContent !== raw) cell.textContent = raw
  } else {
    cell.replaceChildren(...tableCellNodes(raw))
  }
}

function buildTableScroller(block: TableBlock, editable: boolean): HTMLElement {
  // The scroller is inside the wrap rather than being it, so the toolbar can
  // sit beside the table without being clipped by `overflow-x`.
  const scroll = document.createElement('div')
  scroll.className = 'envy-md-table-scroll'
  const table = document.createElement('table')
  table.className = 'envy-md-table'
  const cols = tableCols(block)
  const thead = document.createElement('thead')
  thead.append(tableRowEl('th', block, 0, cols, editable))
  table.append(thead)
  const tbody = document.createElement('tbody')
  for (let r = 0; r < block.rows.length; r++) {
    tbody.append(tableRowEl('td', block, r + 1, cols, editable))
  }
  table.append(tbody)
  scroll.append(table)
  return scroll
}

function tableRowEl(
  kind: 'th' | 'td',
  block: TableBlock,
  row: number,
  cols: number,
  editable: boolean,
): HTMLElement {
  const tr = document.createElement('tr')
  for (let col = 0; col < cols; col++) {
    const cell = document.createElement(kind)
    const align = block.aligns[col] ?? 'left'
    if (align !== 'left') cell.style.textAlign = align
    cell.dataset.row = String(row)
    cell.dataset.col = String(col)
    // A read-only editor (the main window with no note open) must not become
    // editable just because part of it renders as a table.
    cell.contentEditable = !editable ? 'false' : supportsPlaintextOnly() ? 'plaintext-only' : 'true'
    // A cell is one line of markdown; nothing inside it should be a spell-check
    // or autocorrect target either, since it is source text.
    cell.spellcheck = false
    renderTableCellInto(cell, cellRaw(block, row, col), false)
    tr.append(cell)
  }
  return tr
}

// --- Editing a cell ----------------------------------------------------------

function tableWrapOf(node: EventTarget | null): HTMLElement | null {
  const el = node as HTMLElement | null
  return el?.closest?.('.envy-md-table-wrap') ?? null
}

function cellOf(node: EventTarget | null): HTMLElement | null {
  const el = node as HTMLElement | null
  const cell = el?.closest?.('th[data-row], td[data-row]') as HTMLElement | null
  return cell ?? null
}

function cellAt(wrap: HTMLElement, row: number, col: number): HTMLElement | null {
  return wrap.querySelector<HTMLElement>(
    `th[data-row="${row}"][data-col="${col}"], td[data-row="${row}"][data-col="${col}"]`,
  )
}

/// The cell that has focus, which is what every toolbar button acts on — the
/// buttons cancel their own mousedown, so focus is still in the cell when the
/// action runs.
function focusedCell(wrap: HTMLElement): HTMLElement | null {
  const active = wrap.ownerDocument.activeElement
  return active && wrap.contains(active) ? cellOf(active) : null
}

/// Where focus last was inside the grid. `focusedCell` asks the document, which
/// answers correctly for the mouse (the buttons cancel their own mousedown, so
/// the cell never lost focus) but not for the keyboard, where reaching a button
/// means the button *is* the active element. Remembering the cell is what lets
/// a tabbed-to button still act on the cell you were editing.
const lastCellPos = new WeakMap<HTMLElement, { row: number; col: number }>()

function cellPos(cell: HTMLElement): { row: number; col: number } {
  return { row: Number(cell.dataset.row ?? 0), col: Number(cell.dataset.col ?? 0) }
}

/// The cell every toolbar action is defined against, however the toolbar was
/// reached.
function activeCellPos(wrap: HTMLElement): { row: number; col: number } {
  const cell = focusedCell(wrap)
  return cell ? cellPos(cell) : (lastCellPos.get(wrap) ?? { row: 0, col: 0 })
}

/// Caret offsets inside a cell, counted in characters of its text.
function cellSelection(cell: HTMLElement): { from: number; to: number } | null {
  const sel = cell.ownerDocument.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!cell.contains(range.startContainer) || !cell.contains(range.endContainer)) return null
  const before = cell.ownerDocument.createRange()
  before.selectNodeContents(cell)
  before.setEnd(range.startContainer, range.startOffset)
  const from = before.toString().length
  return { from, to: from + range.toString().length }
}

function setCellSelection(cell: HTMLElement, from: number, to: number) {
  const node = cell.firstChild ?? cell
  const max = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '').length : 0
  const range = cell.ownerDocument.createRange()
  range.setStart(node, Math.min(from, max))
  range.setEnd(node, Math.min(to, max))
  const sel = cell.ownerDocument.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/// `at` is a caret offset; `select` takes the whole cell instead, which is what
/// Tab does — the same "typing replaces what's there" the raw-pipes Tab gives,
/// so the two editing modes feel identical.
function focusTableCell(
  wrap: HTMLElement,
  row: number,
  col: number,
  at?: number,
  select = false,
) {
  const cell = cellAt(wrap, row, col)
  if (!cell) return
  cell.focus()
  const len = (cell.textContent ?? '').length
  if (select) {
    setCellSelection(cell, 0, len)
    return
  }
  const put = Math.min(at ?? len, len)
  setCellSelection(cell, put, put)
}

/// Puts focus back in a cell after a change that rebuilt the widget's DOM. The
/// new DOM is already in place by the time `dispatch` returns, but a rebuild
/// that CodeMirror defers to a measure pass is retried once on the next frame.
function refocusTableCell(view: EditorView, from: number, row: number, col: number, at?: number) {
  const attempt = () => {
    for (const wrap of view.contentDOM.querySelectorAll<HTMLElement>('.envy-md-table-wrap')) {
      if (tableStates.get(wrap)?.block.from !== from) continue
      focusTableCell(wrap, row, col, at)
      return true
    }
    return false
  }
  if (!attempt()) requestAnimationFrame(() => void attempt())
}

/// Keeps the CodeMirror selection out of the block a cell is being edited in.
/// `block.to` is the start of the line *after* the table, which the reveal rule
/// counts as outside — so the widget stays up while the caret has somewhere
/// sensible to be if the person tabs back into the document.
function parkSelectionAfter(view: EditorView, block: TableBlock) {
  if (!selectionOverlapsRange(view.state, block.from, block.to)) return
  view.dispatch({ selection: { anchor: Math.min(block.to, view.state.doc.length) } })
}

/// Rebuilds one row's source line from the cells on screen and dispatches it.
///
/// One line, not the block: an edit that only retypes a cell should be one
/// small change so undo, the save debounce and `updateDOM` all stay cheap.
function commitTableRow(cell: HTMLElement) {
  const wrap = tableWrapOf(cell)
  const state = wrap && tableStates.get(wrap)
  if (!wrap || !state) return
  const { view, block } = state
  const row = Number(cell.dataset.row)
  const col = Number(cell.dataset.col)
  // The editable facet can be switched off after the widget was drawn; a cell
  // is never a way around it, so anything typed is simply put back.
  if (!view.state.facet(EditorView.editable)) {
    renderTableCellInto(cell, cellRaw(block, row, col), true)
    return
  }
  const caret = cellSelection(cell)?.from
  cell.dataset.raw = cell.textContent ?? ''
  const lineNo = tableRowLines(view.state.doc, block)[row]
  if (lineNo === undefined) return
  const line = view.state.doc.line(lineNo)
  const cols = tableCols(block)
  const cells: string[] = []
  for (let c = 0; c < cols; c++) {
    cells.push(cellAt(wrap, row, c)?.dataset.raw ?? cellRaw(block, row, c))
  }
  const indent = /^\s*/.exec(line.text)![0]
  const text = indent + serializeTableRow(cells)
  if (text === line.text) return
  const park = selectionOverlapsRange(view.state, block.from, block.to)
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: text },
    selection: park ? { anchor: block.to + (text.length - line.text.length) } : undefined,
    userEvent: 'input',
  })
  // Normally `updateDOM` patched around the focused cell and nothing moved.
  // But some text reshapes the block as it is typed — a lone backtick makes
  // the parser read past the next pipe until its pair arrives — and that
  // rebuilds the widget. Putting focus back is better than dropping the person
  // out of the table mid-word.
  if (wrap.ownerDocument.activeElement !== cell) {
    refocusTableCell(view, block.from, row, col, caret)
  }
}

/// A whole-block rewrite: the shape changed, so the source is regenerated and
/// the widget rebuilt. `focus` is where the caret should land afterwards.
function rewriteTable(
  wrap: HTMLElement,
  parts: { header: string[]; aligns: CellAlign[]; rows: string[][] },
  focus: { row: number; col: number } | null,
) {
  const state = tableStates.get(wrap)
  if (!state) return
  const { view, block } = state
  // Padded on the way in: a structural change rewrites the whole block anyway,
  // so there is nothing to gain from leaving it ragged until the next blur.
  const src = padTableSource(
    serializeTable(parts.header, parts.aligns, parts.rows, block.src.endsWith('\n')),
  )
  if (src === block.src) return
  view.dispatch({
    changes: { from: block.from, to: block.to, insert: src },
    // Just after the new block — outside it, so the rendered table stays up.
    selection: { anchor: block.from + src.length },
    userEvent: 'input',
  })
  if (focus) refocusTableCell(view, block.from, focus.row, focus.col)
}

/// The block as rectangular arrays — ragged rows filled out — so row and
/// column edits are ordinary array work.
function tableParts(block: TableBlock): { header: string[]; aligns: CellAlign[]; rows: string[][] } {
  const cols = tableCols(block)
  const fill = (row: string[]) => Array.from({ length: cols }, (_, i) => row[i] ?? '')
  return {
    header: fill(block.header),
    aligns: Array.from({ length: cols }, (_, i) => block.aligns[i] ?? 'left'),
    rows: block.rows.map(fill),
  }
}

// --- Keys inside a cell ------------------------------------------------------

function moveCell(wrap: HTMLElement, row: number, col: number, dir: 1 | -1) {
  const block = tableStates.get(wrap)?.block
  if (!block) return
  const cols = tableCols(block)
  const lastRow = block.rows.length
  let r = row
  let c = col + dir
  if (c >= cols) {
    c = 0
    r++
  } else if (c < 0) {
    c = cols - 1
    r--
  }
  if (r > lastRow) {
    // Tab off the end appends a row, the way it does in every spreadsheet.
    addTableRow(wrap, lastRow, { row: lastRow + 1, col: 0 })
    return
  }
  if (r < 0) {
    // Backwards off the first cell lands on the toolbar, which sits above the
    // grid in the DOM — where Shift+Tab should go, and the only way to reach
    // the buttons without a mouse. Wrapping to the last cell is the fallback
    // for a table whose toolbar is not there (a read-only surface).
    const first = wrap.querySelector<HTMLElement>('.envy-table-btn')
    if (first) {
      first.focus()
      return
    }
    r = lastRow
    c = cols - 1
  }
  focusTableCell(wrap, r, c, undefined, true)
}

/// Inserts an empty row below `row` (row 0 being the header).
function addTableRow(wrap: HTMLElement, row: number, focus: { row: number; col: number } | null) {
  const block = tableStates.get(wrap)?.block
  if (!block) return
  const parts = tableParts(block)
  parts.rows.splice(row, 0, parts.header.map(() => ''))
  rewriteTable(wrap, parts, focus)
}

function removeTableRow(wrap: HTMLElement, row: number) {
  const block = tableStates.get(wrap)?.block
  // The header is the table's definition, not a row: removing it would leave
  // the delimiter describing nothing.
  if (!block || row < 1) return
  const parts = tableParts(block)
  parts.rows.splice(row - 1, 1)
  rewriteTable(wrap, parts, { row: Math.min(row, parts.rows.length), col: 0 })
}

function addTableColumn(wrap: HTMLElement, col: number) {
  const block = tableStates.get(wrap)?.block
  if (!block) return
  const parts = tableParts(block)
  parts.header.splice(col + 1, 0, '')
  parts.aligns.splice(col + 1, 0, 'left')
  for (const row of parts.rows) row.splice(col + 1, 0, '')
  rewriteTable(wrap, parts, { row: 0, col: col + 1 })
}

function removeTableColumn(wrap: HTMLElement, col: number) {
  const block = tableStates.get(wrap)?.block
  // A table with no columns is not a table; the delete button is the way out.
  if (!block || tableCols(block) <= 1) return
  const parts = tableParts(block)
  parts.header.splice(col, 1)
  parts.aligns.splice(col, 1)
  for (const row of parts.rows) row.splice(col, 1)
  rewriteTable(wrap, parts, { row: 0, col: Math.max(0, col - 1) })
}

function alignTableColumn(wrap: HTMLElement, col: number, align: CellAlign) {
  const state = tableStates.get(wrap)
  if (!state) return
  const parts = tableParts(state.block)
  if (parts.aligns[col] === align) return
  parts.aligns[col] = align
  const at = activeCellPos(wrap)
  rewriteTable(wrap, parts, { row: at.row, col: at.col })
}

/// Tables whose next blur must not re-pad: "Edit as text" leaves the caret
/// *inside* the block, and rewriting the text under it would throw the caret to
/// one end of the table — the opposite of what the button promised.
const skipRepad = new WeakSet<HTMLElement>()

/// Drops out of the rendered table and into the pipes, caret in the same cell —
/// what clicking a table used to do, kept as a button now that a click edits.
function editTableAsText(wrap: HTMLElement) {
  const state = tableStates.get(wrap)
  if (!state) return
  const { view, block } = state
  const { row, col } = activeCellPos(wrap)
  const cell = focusedCell(wrap)
  const lineNo = tableRowLines(view.state.doc, block)[row] ?? view.state.doc.lineAt(block.from).number
  const line = view.state.doc.line(lineNo)
  const pipes: number[] = []
  forEachPipe(line.text, (rel) => pipes.push(rel))
  let at = (pipes[col] ?? pipes[0] ?? 0) + 1
  if (line.text[at] === ' ') at++
  skipRepad.add(wrap)
  cell?.blur()
  view.dispatch({ selection: { anchor: line.from + at }, scrollIntoView: true })
  view.focus()
}

function deleteTable(wrap: HTMLElement) {
  const state = tableStates.get(wrap)
  if (!state) return
  const { view, block } = state
  if (!view.state.facet(EditorView.editable)) return
  focusedCell(wrap)?.blur()
  view.dispatch({
    changes: { from: block.from, to: block.to, insert: '' },
    selection: { anchor: block.from },
    userEvent: 'delete.table',
  })
  view.focus()
}

/// Leaves the table for the document, caret just after it.
function leaveTable(wrap: HTMLElement) {
  const state = tableStates.get(wrap)
  if (!state) return
  const { view, block } = state
  focusedCell(wrap)?.blur()
  const at = Math.min(block.to, view.state.doc.length)
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
  view.focus()
}

/// Ctrl+B / Ctrl+I inside a cell, applied to the cell's raw text with the same
/// rule the editor's own emphasis commands use.
function emphasiseCell(cell: HTMLElement, marker: string): boolean {
  const sel = cellSelection(cell)
  if (!sel || sel.from === sel.to) return false
  const edit = emphasisEdit(cell.textContent ?? '', sel.from, sel.to, marker)
  if (!edit) return false
  cell.textContent = edit.text
  setCellSelection(cell, edit.from, edit.to)
  commitTableRow(cell)
  return true
}

/// Re-pads the whole block so the pipes line up again, once the table is done
/// being edited. Cosmetic, and only dispatched when it actually changes the
/// text — an idle blur should not put anything on the undo stack.
function repadTable(wrap: HTMLElement) {
  const state = tableStates.get(wrap)
  if (!state) return
  const { view, block } = state
  if (!view.state.facet(EditorView.editable)) return
  // The block may have been edited or deleted from elsewhere since; only pad
  // what is still exactly the text this widget is showing.
  if (view.state.doc.sliceString(block.from, block.to) !== block.src) return
  const padded = padTableSource(block.src)
  if (padded === block.src) return
  view.dispatch({
    changes: { from: block.from, to: block.to, insert: padded },
    userEvent: 'input.format',
  })
}

/// One place for every listener the rendered table needs. Delegated on the
/// wrap, so a rebuilt row or column is wired without re-attaching anything.
function wireTable(wrap: HTMLElement) {
  wrap.addEventListener('mousedown', (e) => {
    const target = e.target as HTMLElement
    if (target.closest('a') || target.closest('.envy-table-toolbar') || cellOf(target)) return
    // The margin around the table: nothing to edit there, so the caret goes
    // after the block rather than into it.
    e.preventDefault()
    leaveTable(wrap)
  })

  wrap.addEventListener('input', (e) => {
    const cell = cellOf(e.target)
    if (cell) commitTableRow(cell)
  })

  // A cell holds one line of markdown, whatever was on the clipboard.
  wrap.addEventListener('paste', (e) => {
    const cell = cellOf(e.target)
    if (!cell) return
    e.preventDefault()
    const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/\s*[\r\n]+\s*/g, ' ')
    if (!text) return
    // execCommand is the only insertion that keeps the webview's own undo
    // stack for the cell; the manual range edit is the fallback when it is
    // refused (and is what a `plaintext-only`-less WebKit needs anyway).
    if (!cell.ownerDocument.execCommand('insertText', false, text)) {
      const sel = cellSelection(cell) ?? { from: 0, to: 0 }
      const current = cell.textContent ?? ''
      cell.textContent = current.slice(0, sel.from) + text + current.slice(sel.to)
      setCellSelection(cell, sel.from + text.length, sel.from + text.length)
      commitTableRow(cell)
    }
  })

  wrap.addEventListener('focusin', (e) => {
    const cell = cellOf(e.target)
    const state = tableStates.get(wrap)
    if (!cell || !state) return
    lastCellPos.set(wrap, cellPos(cell))
    wrap.classList.add('editing')
    disarmTableDelete(wrap)
    // Raw markdown while editing. Cells with no markup already read the same
    // either way, and leaving those alone keeps the caret exactly where the
    // click put it.
    const raw = cell.dataset.raw ?? ''
    if (cell.textContent !== raw) {
      renderTableCellInto(cell, raw, true)
      setCellSelection(cell, raw.length, raw.length)
    }
    parkSelectionAfter(state.view, state.block)
    state.view.requestMeasure()
  })

  wrap.addEventListener('focusout', (e) => {
    const cell = cellOf(e.target)
    if (cell) renderTableCellInto(cell, cell.textContent ?? '', false)
    // `relatedTarget` is null when focus lands on the body, so the question is
    // asked after the browser has finished moving it.
    setTimeout(() => {
      if (!tableStates.has(wrap) || wrap.contains(wrap.ownerDocument.activeElement)) return
      wrap.classList.remove('editing')
      disarmTableDelete(wrap)
      if (!skipRepad.delete(wrap)) repadTable(wrap)
      tableStates.get(wrap)?.view.requestMeasure()
    }, 0)
  })

  wrap.addEventListener('keydown', (e) => {
    const cell = cellOf(e.target)
    if (!cell) return
    const row = Number(cell.dataset.row)
    const col = Number(cell.dataset.col)
    const block = tableStates.get(wrap)?.block
    if (!block) return

    if (e.key === 'Tab') {
      e.preventDefault()
      moveCell(wrap, row, col, e.shiftKey ? -1 : 1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      // Shift+Enter would mean a line break, and a pipe-table cell cannot
      // hold one — so it does nothing rather than something surprising.
      if (!e.shiftKey) addTableRow(wrap, row, { row: row + 1, col: 0 })
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      leaveTable(wrap)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = row + (e.key === 'ArrowDown' ? 1 : -1)
      if (next < 0 || next > block.rows.length) return
      e.preventDefault()
      focusTableCell(wrap, next, col)
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const sel = cellSelection(cell)
      if (!sel || sel.from !== sel.to) return
      const len = (cell.textContent ?? '').length
      if (e.key === 'ArrowLeft' ? sel.from !== 0 : sel.to !== len) return
      e.preventDefault()
      moveCell(wrap, row, col, e.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    // Swallowed whether or not there is a selection to wrap: without
    // `plaintext-only` the webview answers Ctrl+B with its own bold command,
    // which would put markup into a cell that is meant to hold source text.
    if (matchesShortcut('bold', e)) {
      e.preventDefault()
      emphasiseCell(cell, '**')
      return
    }
    if (matchesShortcut('italic', e)) {
      e.preventDefault()
      emphasiseCell(cell, '*')
    }
  })
}

// --- The table toolbar -------------------------------------------------------

/// Delete is two-step rather than a modal: the modal would take focus out of
/// the cell the toolbar is attached to, and "click it twice" says the same
/// thing without leaving the table.
function disarmTableDelete(wrap: HTMLElement) {
  const btn = wrap.querySelector<HTMLButtonElement>('.envy-table-btn.armed')
  if (!btn) return
  btn.classList.remove('armed')
  btn.textContent = 'Delete'
}

function buildTableToolbar(wrap: HTMLElement): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'envy-table-toolbar'
  const add = (label: string, title: string, run: () => void, cls = '') => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'envy-table-btn' + (cls ? ' ' + cls : '')
    btn.title = title
    btn.textContent = label
    const activate = () => {
      if (!btn.classList.contains('armed')) disarmTableDelete(wrap)
      run()
    }
    // mousedown, not click, and cancelled: the cell must keep focus, since
    // every action here is defined relative to the cell being edited.
    btn.onmousedown = (e) => {
      e.preventDefault()
      e.stopPropagation()
      activate()
    }
    // Enter and Space are the keyboard's click, and Escape goes back to the
    // cell. Cancelling the key also cancels the click the browser would
    // synthesise from it, so an action still runs exactly once per press.
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      const at = activeCellPos(wrap)
      if (e.key !== 'Escape') activate()
      // Every action that rewrites the table already puts focus back in a cell
      // (or, for "Edit as text" and Delete, in the document). Focus still on
      // the button means nothing moved it, so the mouse path's "you are still
      // in the cell" is restored by hand — unless Delete just armed itself and
      // is waiting here for the confirming press.
      if (wrap.ownerDocument.activeElement !== btn) return
      if (e.key !== 'Escape' && btn.classList.contains('armed')) return
      focusTableCell(wrap, at.row, at.col)
    })
    bar.append(btn)
    return btn
  }
  const at = () => {
    const cell = focusedCell(wrap)
    return { row: Number(cell?.dataset.row ?? 0), col: Number(cell?.dataset.col ?? 0) }
  }
  add('Row+', 'Add a row below', () => addTableRow(wrap, at().row, { row: at().row + 1, col: 0 }))
  add('Row−', 'Remove this row', () => removeTableRow(wrap, at().row))
  add('Col+', 'Add a column to the right', () => addTableColumn(wrap, at().col))
  add('Col−', 'Remove this column', () => removeTableColumn(wrap, at().col))
  add('⇤', 'Align this column left', () => alignTableColumn(wrap, at().col, 'left'))
  add('⇔', 'Centre this column', () => alignTableColumn(wrap, at().col, 'center'))
  add('⇥', 'Align this column right', () => alignTableColumn(wrap, at().col, 'right'))
  add('Edit as text', 'Edit the pipes directly', () => editTableAsText(wrap))
  const del = add(
    'Delete',
    'Delete this table (click twice)',
    () => {
      if (del.classList.contains('armed')) {
        deleteTable(wrap)
        return
      }
      del.classList.add('armed')
      del.textContent = 'Delete? ✓'
    },
    'destructive',
  )
  return bar
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/// Enough inline markdown for the cells in the Omarchy manual: code, links,
/// emphasis, highlights, wiki-links. `renderTableCell` still builds a string
/// and this parses it, rather than assembling nodes directly: the renderer's
/// rules are a chain of ordered regex passes over already-escaped text, and
/// nesting (bold inside a link, `**` inside a backtick span) only falls out of
/// running them in that order over one string. A node builder faithful to that
/// would need its own recursive tokenizer and would quietly change which of
/// those overlaps render — so the escaping stays the safety boundary here, and
/// every anchor gets its handler below.
function tableCellNodes(md: string): Array<Node> {
  const html = renderTableCell(md)
  const wrap = document.createElement('span')
  wrap.innerHTML = html
  for (const a of wrap.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')
    // Every anchor swallows its click, whatever the href: an <a> that falls
    // through navigates the whole webview away from the app, and there is no
    // way back from that. Only an http(s) href is worth handing to the opener.
    a.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (!href || !/^https?:\/\//i.test(href)) return
      void invoke('open_external_url', { url: href }).catch((err) =>
        console.error('could not open the link', err),
      )
    })
  }
  return [...wrap.childNodes]
}

function renderTableCell(md: string): string {
  let s = escapeHtml(md)
  s = s.replace(/`([^`]+)`/g, '<code class="envy-code">$1</code>')
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a class="envy-link" href="$2">$1</a>',
  )
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  s = s.replace(/(?<!\w)_(?!_)([^_]+)_(?!_|\w)/g, '<em>$1</em>')
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>')
  s = s.replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (_m, title: string, alias?: string) => {
    const shown = alias || title
    return `<span class="envy-wikilink">${shown}</span>`
  })
  return s
}

const tableDecorations = StateField.define<DecorationSet>({
  create: (state) => buildTableDecorations(state),
  update(value, tr) {
    const modeChanged = tr.effects.some(
      (e) => e.is(setPlainText) || e.is(restyle) || e.is(setEditorFocused),
    )
    if (!tr.docChanged && !tr.selection && !modeChanged) return value.map(tr.changes)
    return buildTableDecorations(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

function buildTableDecorations(state: EditorState): DecorationSet {
  if (state.field(plainTextField, false)) return Decoration.none
  const ranges: Range<Decoration>[] = []
  for (const block of blocksFor(state.doc).tables) {
    if (!shouldReplaceRange(state, block.from, block.to)) continue
    ranges.push(
      Decoration.replace({ widget: new TableWidget(block), block: true }).range(block.from, block.to),
    )
  }
  return Decoration.set(ranges, true)
}

/// Fenced code, as the same HTML the Omarchy manual produces: `<pre><code>`
/// with the language class, no fence markers. Click to put the caret in the
/// source and edit.
class FenceWidget extends WidgetType {
  constructor(readonly block: FenceBlock) {
    super()
  }
  eq(other: FenceWidget) {
    return other.block.src === this.block.src && other.block.from === this.block.from
  }
  get estimatedHeight() {
    const lines = this.block.body ? this.block.body.split('\n').length : 1
    return 32 + lines * 22
  }
  toDOM(view: EditorView) {
    // A `div`, not `<pre>`: WebKit flattens `<pre>` inside CodeMirror's
    // contenteditable, which is why a real pre never kept its padding or
    // fill. The wrap is the panel; the inner div is `white-space: pre`.
    const wrap = document.createElement('div')
    wrap.className = 'envy-md-pre-wrap'
    const pre = document.createElement('div')
    pre.className = 'envy-md-pre'
    const code = document.createElement('code')
    if (this.block.lang) code.className = `language-${this.block.lang}`
    code.textContent = this.block.body
    pre.append(code)
    wrap.append(pre)
    // Pin the panel to the editor's content width so a long line cannot
    // stretch `.cm-content` and turn the whole note into a horizontal
    // scroller. ResizeObserver keeps it honest when the pane is dragged.
    const fit = () => {
      const w = view.contentDOM.clientWidth
      if (w > 0) wrap.style.width = `${w}px`
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(view.contentDOM)
    fenceFitters.set(wrap, ro)
    wrap.onmousedown = (e) => {
      const t = e.currentTarget as HTMLElement
      // Clicks on the overflow scrollbar have to scroll, not collapse the
      // widget back to source.
      if (e.offsetX >= t.clientWidth || e.offsetY >= t.clientHeight) return
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.block.bodyFrom }, scrollIntoView: true })
      view.focus()
    }
    return wrap
  }
  destroy(dom: HTMLElement) {
    const ro = fenceFitters.get(dom)
    if (ro) {
      ro.disconnect()
      fenceFitters.delete(dom)
    }
  }
  ignoreEvent(event: Event) {
    if (event.type === 'mousedown' || event.type === 'click' || event.type === 'scroll') return true
    // Horizontal wheel stays on the panel; vertical wheel still scrolls the note.
    if (event.type === 'wheel') {
      const e = event as WheelEvent
      return e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)
    }
    return false
  }
}

const fenceFitters = new WeakMap<HTMLElement, ResizeObserver>()

const fenceDecorations = StateField.define<DecorationSet>({
  create: (state) => buildFenceDecorations(state),
  update(value, tr) {
    const modeChanged = tr.effects.some(
      (e) => e.is(setPlainText) || e.is(restyle) || e.is(setEditorFocused),
    )
    if (!tr.docChanged && !tr.selection && !modeChanged) return value.map(tr.changes)
    return buildFenceDecorations(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

function buildFenceDecorations(state: EditorState): DecorationSet {
  if (state.field(plainTextField, false)) return Decoration.none
  const ranges: Range<Decoration>[] = []
  for (const block of blocksFor(state.doc).fences) {
    if (!shouldReplaceRange(state, block.from, block.to)) continue
    ranges.push(
      Decoration.replace({ widget: new FenceWidget(block), block: true }).range(block.from, block.to),
    )
  }
  return Decoration.set(ranges, true)
}

/// Embed widgets, as a StateField rather than part of the view plugin.
///
/// Not a stylistic choice: CodeMirror rejects block decorations supplied by a
/// plugin outright ("Block decorations may not be specified via plugins"),
/// because a block changes the document's line layout and the viewport is
/// measured from that layout — a plugin that both reads the viewport and
/// changes line heights would be defining its own input.
///
/// The practical consequence is that this scans the whole document rather than
/// just the visible range. That's affordable here in a way it wouldn't be for
/// the inline styling: embeds are rare, and the scan is one regex pass rather
/// than the twenty-odd the styler runs.
const embedDecorations = StateField.define<DecorationSet>({
  create: (state) => buildEmbedDecorations(state),
  update(value, tr) {
    const modeChanged = tr.effects.some((e) => e.is(setPlainText))
    if (!tr.docChanged && !modeChanged) return value.map(tr.changes)
    return buildEmbedDecorations(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

/// One `![[…]]` marker: its body, the text it was written as, and the end of
/// the line it sits on (where its block goes — placed after the whole line
/// rather than at the match, so an embed mentioned mid-sentence doesn't cut the
/// sentence in half; the `![[…]]` stays ordinary text, styled as a link).
interface EmbedHit {
  body: string
  raw: string
  lineTo: number
}

/// The marker scan, memoized on the document.
///
/// It used to materialise the entire note as one string and run a global regex
/// over it on every keystroke, which is O(document) of pure allocation for a
/// result that changes on maybe one keystroke in a thousand. Two things fix it:
/// the scan walks lines instead of one giant string (a marker is line-local —
/// the same assumption the inline styler and `wikiLinkRangeAt` already make),
/// and `Text` is immutable, so the last document's hits can be handed straight
/// back when the field is rebuilt for anything other than an edit.
///
/// The hits are host-independent on purpose: the widgets are rebuilt from them
/// each time, so a changed embed host is picked up without invalidating this.
let embedScanCache: { doc: Text; hits: EmbedHit[] } | null = null

function embedHits(doc: Text): EmbedHit[] {
  if (embedScanCache && embedScanCache.doc === doc) return embedScanCache.hits
  const hits: EmbedHit[] = []
  const iter = doc.iterLines()
  let pos = 0
  while (!iter.next().done) {
    const line = iter.value
    // The `includes` is the whole point of scanning by line: almost every line
    // has no marker at all, and this rejects it without touching the regex.
    if (line.includes('![[')) {
      for (const m of line.matchAll(P.embed)) {
        hits.push({ body: m[1], raw: m[0], lineTo: pos + line.length })
      }
    }
    // Every line break is a single character in a CodeMirror document.
    pos += line.length + 1
  }
  embedScanCache = { doc, hits }
  return hits
}

function buildEmbedDecorations(state: EditorState): DecorationSet {
  if (!state.facet(allowEmbeds) || state.field(plainTextField, false)) return Decoration.none
  const host = state.facet(embedHost)
  const hostNoteId = host?.currentNoteId() ?? null

  const ranges: Range<Decoration>[] = []
  for (const hit of embedHits(state.doc)) {
    const title = wikiLinkTarget(hit.body)
    if (!title) continue
    // An image extension makes it an attachment, rendered as a picture; anything
    // else is a note transclusion. The single `isImageTarget` split keeps this
    // in step with envy-core's is_image_attachment.
    const widget = isImageTarget(title)
      ? new ImageEmbedWidget(parseImageEmbed(hit.body), hit.raw, host)
      : new EmbedWidget(title, host, hostNoteId)
    ranges.push(Decoration.widget({ widget, block: true, side: 1 }).range(hit.lineTo))
  }
  return Decoration.set(ranges, true)
}

const stylerPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate) {
      // Selection changes matter as much as doc changes — the reveal-on-cursor
      // rule above is driven entirely by where the cursor is. A query change
      // arrives as a bare effect with no doc or selection change at all, so it
      // has to be checked for explicitly or the highlights never appear.
      const queryChanged = update.transactions.some((tr) =>
        tr.effects.some(
          (e) => e.is(setSearchQuery) || e.is(setPlainText) || e.is(restyle),
        ),
      )
      // Focus is an input to the reveal rule now, so gaining or losing it has
      // to redecorate — otherwise markers stay revealed after clicking away.
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        queryChanged
      ) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

/// The whole styling layer: inline marks from a view plugin (viewport-scoped,
/// because that's where the cost is) and embed/table/fence blocks from state
/// fields (because CodeMirror requires it).
export const envyStyler = [
  editorFocusedField,
  EditorView.focusChangeEffect.of((_state, focusing) => setEditorFocused.of(focusing)),
  embedDecorations,
  tableDecorations,
  fenceDecorations,
  stylerPlugin,
]
