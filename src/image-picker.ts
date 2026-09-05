//! The Insert Image picker — a grid of every image already in the vault, so one
//! can be re-inserted by sight rather than by remembering a name like "Pasted
//! image 3.png". Mirrors the Mac's ImageAttachmentPicker. Shared by every window
//! that lets you insert an image; the caller passes what to do with the pick (drop
//! `![[name]]` into that window's editor) and guards on whether a note is open.

import { invoke } from '@tauri-apps/api/core'
import { attachmentUrl, releaseAttachmentUrl } from './styler'
import { returnFocusFromDialog } from './prompt-modal'

const pickerEl = document.getElementById('image-picker')!
const filterEl = document.getElementById('image-picker-filter') as HTMLInputElement
const gridEl = document.getElementById('image-picker-grid')!
const emptyEl = document.getElementById('image-picker-empty')!
let names: string[] = []
/// Which cache entries this grid is holding open. The thumbnails come from the
/// same reference-counted store the editor's `![[image]]` widgets use, so a
/// picture that is already on screen costs the picker nothing — and a grid that
/// is rebuilt or closed lets go rather than revoking a URL still in use.
let held: string[] = []
// Filtering rebuilds the grid; a bumped generation makes a slow thumbnail load
// from a superseded build (or after close) drop its result instead of leaking.
let gen = 0
let onPick: (name: string) => void = () => {}

export async function openImagePicker(pick: (name: string) => void) {
  onPick = pick
  names = await invoke<string[]>('list_image_attachments')
  filterEl.value = ''
  buildGrid('')
  pickerEl.classList.remove('hidden')
  filterEl.focus()
}

function closeImagePicker() {
  if (pickerEl.classList.contains('hidden')) return
  gen++
  pickerEl.classList.add('hidden')
  gridEl.replaceChildren()
  releaseHeld()
}

function releaseHeld() {
  for (const name of held) releaseAttachmentUrl(name)
  held = []
}

function matches(filter: string): string[] {
  const needle = filter.trim().toLowerCase()
  return needle ? names.filter((n) => n.toLowerCase().includes(needle)) : names
}

function buildGrid(filter: string) {
  const build = ++gen
  releaseHeld()
  gridEl.replaceChildren()
  const found = matches(filter)
  if (found.length === 0) {
    emptyEl.textContent =
      names.length === 0
        ? 'No images yet. Drag or paste a picture into a note first.'
        : 'No matches.'
    emptyEl.classList.remove('hidden')
    return
  }
  emptyEl.classList.add('hidden')
  for (const name of found) {
    const cell = document.createElement('button')
    cell.type = 'button'
    cell.className = 'image-picker-cell'
    const thumb = document.createElement('div')
    thumb.className = 'thumb'
    const img = document.createElement('img')
    img.alt = name
    img.loading = 'lazy'
    thumb.append(img)
    const label = document.createElement('div')
    label.className = 'name'
    label.textContent = name
    cell.append(thumb, label)
    cell.addEventListener('click', () => pick(name))
    // Roving tab stop: the grid as a whole is one stop, so Tab goes filter →
    // grid → out, and the arrows (or j/k) move between thumbnails. A <button>
    // already answers Return and Space with a click, so choosing needs no key
    // handling of its own.
    cell.tabIndex = gridEl.childElementCount === 0 ? 0 : -1
    gridEl.append(cell)
    held.push(name)
    void attachmentUrl(name, (n) =>
      invoke<ArrayBuffer>('read_attachment', { name: n }).catch(() => null),
    ).then((url) => {
      // Superseded build or closed: the ref was already handed back by
      // `releaseHeld`, so nothing to do but drop the answer.
      if (build !== gen || !url) return
      img.src = url
    })
  }
}

function cells(): HTMLElement[] {
  return [...gridEl.querySelectorAll<HTMLElement>('.image-picker-cell')]
}

/// Moves the single tab stop to `to` and focuses it, clamped to the grid.
function focusCell(to: number) {
  const all = cells()
  if (all.length === 0) return
  const at = Math.max(0, Math.min(all.length - 1, to))
  for (const c of all) c.tabIndex = c === all[at] ? 0 : -1
  all[at].focus()
  all[at].scrollIntoView({ block: 'nearest' })
}

function pick(name: string) {
  closeImagePicker()
  onPick(name)
}

filterEl.addEventListener('input', () => buildGrid(filterEl.value))
filterEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    // Return inserts the first match — the quick path when you half-remember the
    // name; otherwise click a thumbnail.
    e.preventDefault()
    const first = matches(filterEl.value)[0]
    if (first) pick(first)
  } else if (e.key === 'ArrowDown') {
    // Down steps out of the box and into the pictures.
    e.preventDefault()
    focusCell(0)
  }
})
// Escape closes from anywhere in the dialog, in the capture phase: bound only to
// the filter box it was unreachable the moment focus moved to a thumbnail, and
// capture also keeps the editor's own Escape from firing underneath.
pickerEl.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    closeImagePicker()
    // Dismissing from a thumbnail would otherwise leave focus on an element
    // that has just been removed, and the next key would go nowhere.
    returnFocusFromDialog()
  },
  true,
)
gridEl.addEventListener('keydown', (e) => {
  const all = cells()
  const at = all.indexOf(e.target as HTMLElement)
  if (at < 0) return
  // Cells wrap, so a row is however many share the first one's top edge.
  const cols = all.filter((c) => c.offsetTop === all[0].offsetTop).length || 1
  const step =
    e.key === 'ArrowRight' || e.key === 'l' ? 1
    : e.key === 'ArrowLeft' || e.key === 'h' ? -1
    : e.key === 'ArrowDown' || e.key === 'j' ? cols
    : e.key === 'ArrowUp' || e.key === 'k' ? -cols
    : 0
  if (step === 0) return
  e.preventDefault()
  focusCell(at + step)
})
pickerEl.addEventListener('click', (e) => {
  if (e.target === pickerEl) closeImagePicker() // click the backdrop to dismiss
})
