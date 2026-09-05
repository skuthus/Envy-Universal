//! Settings → Import → Kindle: the frontend half of the Kindle highlights
//! importer. The parsing, the ledger and the note writing live in
//! `envy_core::kindle`; this file owns the preferences (the config file's
//! `[kindle]` table), the Settings controls, and the two ways an
//! import starts — the buttons here and the tray's "Import from Kindle",
//! which behaves like the Mac's File-menu command: with the feature on and a
//! Kindle plugged in it imports straight away, otherwise it opens Settings so
//! the user can finish setting up or pick the file by hand.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openFilePicker } from '@tauri-apps/plugin-dialog'
import { alertModal, confirmModal } from './prompt-modal'
import { getBool, getString, set as setConfig } from './config'

type TitleReference = 'page' | 'location' | 'both' | 'none'

interface KindleImportSummary {
  imported: number
  alreadyImported: number
}

interface KindleProgress {
  done: number
  total: number
}

// The keys of the config file's `[kindle]` table. The two "omit" flags are
// stored in the negative, as they were on the Mac, so an unset key means
// "included" — the default.
const TABLE = 'kindle'
const ENABLED_KEY = 'enabled'
const TITLE_REFERENCE_KEY = 'title_reference'
const OMIT_AUTHOR_KEY = 'omit_author'
const OMIT_LOCATION_KEY = 'omit_location'

function flag(key: string): boolean {
  return getBool(TABLE, key)
}

function titleReference(): TitleReference {
  const raw = getString(TABLE, TITLE_REFERENCE_KEY)
  return raw === 'location' || raw === 'both' || raw === 'none' ? raw : 'page'
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

const enabledBox = el<HTMLInputElement>('setting-kindle-enabled')
const referenceSelect = el<HTMLSelectElement>('setting-kindle-title-reference')
const authorBox = el<HTMLInputElement>('setting-kindle-author')
const locationBox = el<HTMLInputElement>('setting-kindle-location')
const detectedEl = el('setting-kindle-detected')
const refreshButton = el<HTMLButtonElement>('setting-kindle-refresh')
const importButton = el<HTMLButtonElement>('setting-kindle-import')
const chooseButton = el<HTMLButtonElement>('setting-kindle-choose')
const forgetButton = el<HTMLButtonElement>('setting-kindle-forget')
const statusEl = el('setting-kindle-status')

/// The detected Clippings file, or null — refreshed when Settings opens (with
/// the feature on) and on the Refresh button, the Mac's two moments.
let clippingsFile: string | null = null
/// One import at a time, whichever button or menu started it.
let busy = false

function setStatus(text: string | null, failed = false) {
  statusEl.hidden = text === null
  statusEl.textContent = text ?? ''
  // The panel's note colour is the secondary grey; a failure reads in the
  // same red the destructive buttons use.
  statusEl.style.color = failed ? 'var(--envy-due-overdue)' : ''
}

/// Everything under the master toggle follows it, as the Mac's sections do,
/// and the action buttons also wait out a running import.
function syncControls() {
  const enabled = enabledBox.checked
  referenceSelect.disabled = !enabled
  authorBox.disabled = !enabled
  locationBox.disabled = !enabled
  refreshButton.disabled = !enabled
  importButton.disabled = !enabled || busy || clippingsFile === null
  chooseButton.disabled = !enabled || busy
  forgetButton.disabled = !enabled || busy
  detectedEl.textContent =
    clippingsFile !== null
      ? 'Kindle detected.'
      : 'No Kindle detected: plug it in and refresh, or choose the file by hand.'
}

async function detect(): Promise<string | null> {
  try {
    clippingsFile = await invoke<string | null>('detect_kindle_clippings')
  } catch {
    clippingsFile = null
  }
  syncControls()
  return clippingsFile
}

/// Runs one import and narrates it on the status line: "Reading Clippings…",
/// "Importing 3 / 12…", then the Mac's finished wording.
async function runImport(path: string | null) {
  if (busy) return
  busy = true
  syncControls()
  setStatus('Reading Clippings…')
  try {
    const summary = await invoke<KindleImportSummary>('import_kindle_clippings', {
      path,
      titleReference: titleReference(),
      includeAuthor: !flag(OMIT_AUTHOR_KEY),
      includeLocation: !flag(OMIT_LOCATION_KEY),
    })
    setStatus(
      summary.imported === 0
        ? `Nothing new (${summary.alreadyImported} already imported).`
        : `Imported ${summary.imported} new · ${summary.alreadyImported} already imported.`,
    )
  } catch (err) {
    setStatus(String(err), true)
  } finally {
    busy = false
    syncControls()
  }
}

async function chooseClippingsFile() {
  const picked = await openFilePicker({
    multiple: false,
    directory: false,
    title: 'Choose My Clippings.txt',
    filters: [{ name: 'Text', extensions: ['txt'] }],
  })
  if (typeof picked === 'string' && picked) await runImport(picked)
}

async function forgetHistory() {
  const ok = await confirmModal(
    'Forget which highlights have been imported? The next import will re-offer every highlight, useful for redoing them with a different title format. Notes already in your vault aren’t touched.',
    'Forget Import History',
  )
  if (!ok) return
  try {
    await invoke('forget_kindle_history')
    setStatus('Import history forgotten.')
  } catch (err) {
    await alertModal(String(err))
  }
}

/// Puts the controls back in step with the config — at startup, and again
/// whenever the file changes underneath us, so an edit made outside Envy shows
/// in the panel rather than being overwritten by a stale checkbox.
export function syncKindleSettings() {
  enabledBox.checked = flag(ENABLED_KEY)
  referenceSelect.value = titleReference()
  authorBox.checked = !flag(OMIT_AUTHOR_KEY)
  locationBox.checked = !flag(OMIT_LOCATION_KEY)
  syncControls()
}

/// Wires the Settings controls and the tray trigger. `openSettings` is the
/// main window's own opener, handed in so the tray path can land the user on
/// this section when there's nothing to import yet.
export function initKindleImport(openSettings: () => void) {
  syncKindleSettings()

  enabledBox.onchange = () => {
    setConfig(TABLE, ENABLED_KEY, enabledBox.checked)
    syncControls()
    if (enabledBox.checked) void detect()
  }
  referenceSelect.onchange = () => {
    setConfig(TABLE, TITLE_REFERENCE_KEY, referenceSelect.value)
  }
  authorBox.onchange = () => {
    setConfig(TABLE, OMIT_AUTHOR_KEY, !authorBox.checked)
  }
  locationBox.onchange = () => {
    setConfig(TABLE, OMIT_LOCATION_KEY, !locationBox.checked)
  }
  refreshButton.onclick = () => void detect()
  importButton.onclick = () => {
    if (clippingsFile !== null) void runImport(clippingsFile)
  }
  chooseButton.onclick = () => void chooseClippingsFile()
  forgetButton.onclick = () => void forgetHistory()

  // A cheap volume scan whenever Settings opens, so a Kindle plugged in
  // before the panel was opened shows as detected without a manual refresh.
  // The panel is shown by dropping its `hidden` class; watching for that
  // keeps this file out of the panel's own open/close code.
  const settingsEl = document.getElementById('settings')
  if (settingsEl) {
    let wasHidden = settingsEl.classList.contains('hidden')
    new MutationObserver(() => {
      const hidden = settingsEl.classList.contains('hidden')
      if (wasHidden && !hidden && enabledBox.checked) void detect()
      wasHidden = hidden
    }).observe(settingsEl, { attributes: true, attributeFilter: ['class'] })
  }

  void listen<KindleProgress>('kindle-progress', (event) => {
    if (busy) setStatus(`Importing ${event.payload.done} / ${event.payload.total}…`)
  })

  // The tray's "Import from Kindle". Import immediately when the feature is
  // on and a Kindle is actually plugged in (the import shows itself as
  // fleeting notes appearing); otherwise open Settings at this section.
  void listen('import-from-kindle', async () => {
    if (flag(ENABLED_KEY) && (await detect()) !== null) {
      await runImport(clippingsFile)
      return
    }
    openSettings()
    document.getElementById('settings-import')?.scrollIntoView({ block: 'start' })
  })
}
