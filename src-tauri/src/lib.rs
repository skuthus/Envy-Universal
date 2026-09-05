//! The Tauri shell. Owns one `NoteStore` and exposes it to the frontend.
//!
//! Deliberately thin: every decision about what a note *means* lives in
//! `envy-core`, which knows nothing about Tauri or a UI. This layer only
//! serializes across the boundary.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use envy_core::{IndexWatcher, NoteStore, SearchContext, SortField, SortSpec};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

pub mod config;
#[cfg(target_os = "linux")]
mod control;
#[cfg(target_os = "linux")]
mod hyprland;
#[cfg(target_os = "linux")]
mod kindle_mtp;
#[cfg(target_os = "linux")]
mod omarchy;
pub mod themes;
mod tray;

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
mod hyprland {
    use tauri::{AppHandle, Manager, WebviewWindow};

    #[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    pub struct Geometry {
        pub x: i64,
        pub y: i64,
        pub w: i64,
        pub h: i64,
    }

    pub fn apply(_: bool) {}
    pub fn apply_floating(_: &AppHandle) {}
    pub fn apply_pinned(_: &AppHandle) {}
    pub fn float_when_mapped(_: &WebviewWindow, _: fn() -> bool, _: Option<fn() -> bool>) {}
    pub fn place_when_floating(_: String, _: Geometry) {}
    pub fn geometry(_: &str) -> Option<Geometry> {
        None
    }

    #[tauri::command]
    pub fn main_window_fullscreen(app: AppHandle) -> bool {
        app.get_webview_window("main")
            .and_then(|w| w.is_fullscreen().ok())
            .unwrap_or(false)
    }
}

#[cfg(not(target_os = "linux"))]
mod omarchy {
    use std::collections::HashMap;

    use serde::Serialize;
    use tauri::AppHandle;

    #[derive(Debug, Clone, Serialize, PartialEq, Eq)]
    pub struct OmarchyAppearance {
        pub colors: HashMap<String, String>,
        pub font: String,
        pub theme: Option<String>,
    }

    #[tauri::command]
    pub fn omarchy_appearance() -> OmarchyAppearance {
        OmarchyAppearance {
            colors: HashMap::new(),
            font: "Cascadia Code".into(),
            theme: None,
        }
    }

    pub fn spawn_watcher(_: AppHandle) {}
}

#[cfg(not(target_os = "linux"))]
mod kindle_mtp {
    pub fn is_uri(_: &str) -> bool {
        false
    }
    pub fn detect() -> Option<String> {
        None
    }
    pub fn read(_: &str, _: usize) -> Result<Vec<u8>, String> {
        Err("MTP Kindle import is not available on Windows.".into())
    }
}

/// `envynote --toggle` and friends: see `control`.
pub fn control_send(verb: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        control::send(verb)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = verb;
        false
    }
}

/// A note as the frontend sees it. The store's `Note` isn't serialized
/// directly — its derived values are lazy and private, and the UI wants them
/// resolved (title, preview, due) rather than the raw content alone.
#[derive(Serialize)]
pub struct NoteDto {
    id: String,
    title: String,
    preview: String,
    /// Only sent for the note actually open in the editor — shipping every
    /// note's full text to the frontend on every keystroke would defeat the
    /// point of the lazy cache in the first place.
    content: Option<String>,
    #[serde(rename = "modifiedMs")]
    modified_ms: u64,
    due: Option<String>,
    #[serde(rename = "dueCount")]
    due_count: usize,
    tags: Vec<String>,
    #[serde(rename = "isInbox")]
    is_inbox: bool,
    #[serde(rename = "aiProvenance")]
    ai_provenance: String,
    #[serde(rename = "hasUncheckedTask")]
    has_unchecked_task: bool,
    /// The folder this note sits in, relative to the Index root, or null at the
    /// root — what the list's folder dot is coloured by. Computed here rather
    /// than derived from `id` in the frontend so the rule for it lives in one
    /// place, next to the move that depends on it.
    subfolder: Option<String>,
}

impl NoteDto {
    /// `root` is the Index directory, needed for `subfolder`. Taken as a path
    /// rather than the store because most callers are mid-mutation and cannot
    /// lend it out again.
    fn from_note(note: &envy_core::Note, with_content: bool, root: &Path) -> Self {
        Self {
            subfolder: envy_core::subfolder_path(note, root),
            id: note.id().to_string(),
            title: note.title().to_string(),
            preview: note.preview().to_string(),
            content: with_content.then(|| note.content().to_string()),
            modified_ms: note
                .modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            due: note.due().map(|d| d.to_string()),
            due_count: note.due_date_count(),
            tags: note.tags().iter().cloned().collect(),
            // With the Inbox turned off a note in `Inbox/` is just a note in a
            // folder — no amber dot, no fleeting banner.
            is_inbox: inbox_enabled() && envy_core::search::is_inbox_note(note),
            ai_provenance: format!("{:?}", note.ai_provenance()).to_lowercase(),
            has_unchecked_task: note.has_unchecked_task(),
        }
    }
}

/// Whether the Inbox feature is on (Mac 1.10.0 "Turn off the Inbox"),
/// mirrored from the frontend's settings. Process-wide rather than a field on
/// `AppState` because `NoteDto::from_note` — which every command that returns
/// a note goes through — has no state handle, and threading one through would
/// change its signature at every call site.
static INBOX_ENABLED: AtomicBool = AtomicBool::new(true);

fn inbox_enabled() -> bool {
    INBOX_ENABLED.load(Ordering::Relaxed)
}

#[tauri::command]
fn set_inbox_enabled(on: bool) {
    INBOX_ENABLED.store(on, Ordering::Relaxed);
}

pub struct AppState {
    pub(crate) store: Mutex<NoteStore>,
    /// The note pinned to the tray, if any.
    ///
    /// Held here because the tray click handler runs in Rust and has to decide
    /// what to open before any window exists. Durable storage stays in the
    /// frontend alongside the list pins — this is a cache the frontend fills
    /// on boot, not a second source of truth.
    pub(crate) pinned_note: Mutex<Option<String>>,
    /// Envy's own writes trip the watcher exactly like an external edit would.
    /// Suppressing a brief window after each one stops a redundant rescan —
    /// and, more importantly, stops a reload landing on top of text the user
    /// is still typing. This is `markInternalWrite` on the Mac.
    suppress_until: Arc<Mutex<Instant>>,
    /// Held only to keep the watch alive; dropping it stops the watcher.
    _watcher: Mutex<Option<IndexWatcher>>,
    /// Registered global shortcuts, keyed by the shortcut's own id, so the
    /// handler dispatches by lookup rather than re-testing chords it would
    /// then have to keep in step with the frontend's list.
    global_shortcuts: Mutex<std::collections::HashMap<u32, String>>,
    /// The `{{date}}` pattern, mirrored from the frontend's settings.
    ///
    /// Needed here because the tray's "New Pinned Note from Template" builds a
    /// note without any window involved, so it cannot ask the frontend what
    /// format to use.
    template_date_format: Mutex<String>,
    /// Pop-out windows: their label → the note id each one shows. A window's
    /// label can't carry the id (an id is a file path, full of characters a
    /// label forbids), so the page asks for its note through this map. Dead
    /// entries are swept lazily whenever a new pop-out is made.
    popouts: Mutex<std::collections::HashMap<String, String>>,
}

/// Translates the Mac's date tokens to chrono's strftime.
///
/// Deliberately a small fixed set — the same five the Settings pane documents
/// (`yyyy MM dd MMMM EEEE`) — rather than a general pattern language. Longest
/// first, or `MM` consumes the front of `MMMM`.
fn date_pattern_to_strftime(pattern: &str) -> String {
    pattern
        .replace("yyyy", "%Y")
        .replace("MMMM", "%B")
        .replace("EEEE", "%A")
        .replace("MM", "%m")
        .replace("dd", "%d")
}

/// 12-hour clock without a leading zero (`8:30 AM`). chrono's `%-I` does that
/// on Unix and is rejected on Windows, so the trim is done in Rust.
fn format_template_time(now: chrono::DateTime<chrono::Local>) -> String {
    let raw = now.format("%I:%M %p").to_string();
    raw.strip_prefix('0').unwrap_or(&raw).to_string()
}

#[tauri::command]
fn set_template_date_format(pattern: String, state: State<AppState>) {
    *state.template_date_format.lock().unwrap() = pattern;
}

/// How long after one of Envy's own writes the watcher stays ignored.
///
/// This has to outlast the watcher's own debounce (400 ms in `watcher.rs`),
/// or the suppression is a race it usually loses: the write lands, the
/// debounce waits 400 ms for the burst to settle, and by the time the reload
/// fires the 500 ms window has all but closed — a save under any filesystem
/// or scheduling latency at all would slip through and reload the store on
/// top of text still being typed. 1500 ms leaves a full second of margin past
/// the debounce while staying far shorter than the pause anyone would notice
/// before an *external* edit shows up.
const SUPPRESS_WINDOW: Duration = Duration::from_millis(1500);

impl AppState {
    fn mark_internal_write(&self) {
        *self.suppress_until.lock().unwrap() = Instant::now() + SUPPRESS_WINDOW;
    }
}

fn default_index_directory() -> PathBuf {
    // %USERPROFILE%\Documents\Envy — the Windows equivalent of the Mac's
    // ~/Documents/Envy.
    dirs::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Envy")
}

/// Where the chosen Index path *used* to be remembered: a plain file under the
/// app's config directory holding one path. `vault` in `~/.config/envy/config.md`
/// is the record now; this is read once, to migrate it, and then left alone so
/// a downgrade still finds it.
fn index_path_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("index-path"))
}

/// The Index to open on launch: the one the config names, or the default.
///
/// Read before any window exists, so the right vault opens straight away
/// rather than opening the default and switching afterwards. Keeps the Mac's
/// self-heal: a missing or empty record resolves to the default *and* is
/// written back, so the file always names a real choice after the first run.
fn persisted_index_directory(app: &tauri::AppHandle) -> PathBuf {
    if let Some(dir) = config::vault() {
        return dir;
    }
    let fallback = default_index_directory();
    save_index_directory(app, &fallback);
    fallback
}

/// Records `dir` as the Index to open next time — through the config file, so
/// Settings → Change Location… and an agent editing `vault` are the same
/// change. Best-effort: a failure here costs the persistence, not the switch.
fn save_index_directory(app: &tauri::AppHandle, dir: &Path) {
    config::set_owned(
        app,
        "",
        "vault",
        serde_json::Value::String(dir.to_string_lossy().into_owned()),
    );
}

// --- Keep Envy on Top --------------------------------------------------------
// Whether the main window floats above other apps' windows. The Windows
// equivalent of the Mac's keepMainWindowOnTop UserDefault: toggled from the
// tray menu, persisted in the app config dir, and re-applied on launch. Only
// the main window — the pinned-note popover already floats on its own.

/// The pre-config record, kept only so `config::init` can migrate it.
fn keep_on_top_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("keep-on-top"))
}

pub(crate) fn persisted_keep_on_top(_app: &tauri::AppHandle) -> bool {
    config::keep_on_top()
}

fn save_keep_on_top(app: &tauri::AppHandle, on: bool) {
    config::set_owned(app, "system", "keep_on_top", serde_json::Value::Bool(on));
}

/// What `apply_keep_on_top` last set. The window has no reliable read-back
/// across platforms, and re-applying on every config change would emit a
/// `keep-on-top-changed` the frontend would act on for nothing.
static KEEP_ON_TOP_APPLIED: AtomicBool = AtomicBool::new(false);

/// Whether the main window floated the last time the config was applied;
/// the tray menu's Keep on Top item depends on it.
static FLOATING_APPLIED: AtomicBool = AtomicBool::new(true);

/// Raises or lowers the main window's always-on-top flag, and tells the
/// frontend the new state so it can suppress hide-on-focus-loss while on — a
/// window pinned on top that vanishes the moment you click away would fight
/// itself. Mirrors the Mac, where keepOnTop suppresses the same auto-hide.
fn apply_keep_on_top(app: &tauri::AppHandle, on: bool) {
    KEEP_ON_TOP_APPLIED.store(on, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window("main") {
        // GTK's keep-above is an X11 hint the Wayland backend ignores, so on
        // Hyprland the real work is the compositor's pin, done below.
        let _ = w.set_always_on_top(on);
        hyprland::apply_pinned(app);
        // Windows leaves a de-topmost'd window at the top of the normal stack,
        // so it is restacked by hand there. On Linux the compositor owns
        // z-order: clearing always-on-top is the whole job.
        #[cfg(windows)]
        if !on {
            lower_below_foreground(&w);
        }
        let _ = w.emit("keep-on-top-changed", on);
    }
}

/// After the topmost flag is cleared, drop the window behind whatever's now in
/// front. Windows leaves a de-topmost'd window at the top of the *non*-topmost
/// stack, so turning keep-on-top off from another app would leave Envy still
/// sitting over it — nothing appears to happen. The Mac sets `.level = .normal`
/// and the unfocused window naturally falls behind the active app; this mirrors
/// that by re-inserting the window just under the current foreground window.
/// A no-op when Envy itself is in front (e.g. toggled from its own window).
#[cfg(windows)]
fn lower_below_foreground(w: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    let Ok(hwnd) = w.hwnd() else { return };
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() || fg == hwnd {
            return;
        }
        let _ = SetWindowPos(
            hwnd,
            Some(fg),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// Flips the on-top state, persists it, applies it, and refreshes the tray
/// checkmark — the one action both the tray menu item and the global shortcut
/// trigger, so the two can't drift.
pub(crate) fn toggle_keep_on_top(app: &tauri::AppHandle) {
    let on = !persisted_keep_on_top(app);
    save_keep_on_top(app, on);
    apply_keep_on_top(app, on);
    refresh_tray_menu(app);
}

#[tauri::command(async)]
fn index_directory(state: State<AppState>) -> String {
    state
        .store
        .lock()
        .unwrap()
        .directory()
        .to_string_lossy()
        .into_owned()
}

/// Everything that decides *which* notes the list shows and in what order.
///
/// One struct rather than six arguments because `search` and `search_ids` have
/// to agree on it exactly — a page fetched under one spec and an id list
/// fetched under another would disagree about what row 4,000 is.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchSpec {
    query: String,
    /// "name" | "date" | "due" — the list header's field. Anything else falls
    /// back to date, the frontend's own default.
    sort_field: String,
    sort_ascending: bool,
    /// The pinned note ids, in the frontend's set. Pins live in localStorage,
    /// so the backend can only know them by being told; they come with the
    /// request rather than being pushed separately so a page can never be
    /// ordered by a stale pin set.
    pinned: Vec<String>,
    /// "Show fleeting notes in the main list", off. Applied here rather than
    /// in the frontend now that the list arrives a page at a time — filtering
    /// a page after it arrives would leave short pages and a wrong total.
    hide_inbox: bool,
}

/// One page of the list, plus how long the list actually is.
///
/// The command used to return a `NoteDto` for every match: 19.3 MB of JSON on
/// a 30,000-note vault, on every debounced keystroke, of which the virtualized
/// list ever displayed about thirty rows. `total` is what the scrollbar and
/// the row indices need; the rows themselves are fetched as they are scrolled
/// to.
#[derive(Serialize)]
struct SearchPage {
    notes: Vec<NoteDto>,
    total: usize,
}

impl SearchSpec {
    fn sort(&self) -> SortSpec {
        SortSpec {
            field: match self.sort_field.as_str() {
                "name" => SortField::Name,
                "due" => SortField::Due,
                _ => SortField::Date,
            },
            ascending: self.sort_ascending,
        }
    }
}

/// Runs the query and hands back the ordered hits, inbox filter applied.
///
/// Filtering after the sort rather than before is deliberate: dropping
/// elements from an ordered vector leaves it ordered, and doing it here keeps
/// the rule ("what the Inbox setting hides") in the shell, next to the setting
/// it mirrors, rather than in the core's query language.
fn ordered_hits<'a>(
    notes: &'a [envy_core::Note],
    spec: &SearchSpec,
    root: &Path,
) -> Vec<&'a envy_core::Note> {
    let mut ctx = SearchContext::now();
    ctx.inbox_enabled = inbox_enabled();
    let hits = envy_core::filtered_sorted(
        notes,
        &spec.query,
        &ctx,
        Some(root),
        Some(spec.sort()),
        &spec.pinned,
    );
    if !spec.hide_inbox {
        return hits;
    }
    hits.into_iter()
        .filter(|n| !envy_core::search::is_inbox_note(n))
        .collect()
}

#[tauri::command(async)]
fn search(spec: SearchSpec, offset: usize, limit: usize, state: State<AppState>) -> SearchPage {
    let store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let hits = ordered_hits(store.notes(), &spec, &root);
    SearchPage {
        total: hits.len(),
        notes: hits
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|n| NoteDto::from_note(n, false, &root))
            .collect(),
    }
}

/// Just the ids, in the same order `search` pages over.
///
/// What a whole-list operation needs — selecting a range that spans rows no
/// page has fetched, or finding where one note sits in the order — without
/// paying for a `NoteDto` per note. An id is a path, so this is roughly a
/// tenth of the bytes and none of the derived-value work.
#[tauri::command(async)]
fn search_ids(spec: SearchSpec, state: State<AppState>) -> Vec<String> {
    let store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    ordered_hits(store.notes(), &spec, &root)
        .into_iter()
        .map(|n| n.id().to_string())
        .collect()
}

/// Resolves a wiki-link title to a note, without creating one.
///
/// Separate from `open_link`, which creates on miss. An embed pointing at a
/// note that doesn't exist should say so, not quietly bring one into being
/// every time the host note is rendered.
#[tauri::command(async)]
fn resolve_title(title: String, state: State<AppState>) -> Option<NoteDto> {
    let store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .exact_title_match(&title)
        .map(|n| NoteDto::from_note(n, true, &root))
}

#[tauri::command(async)]
fn read_note(id: String, state: State<AppState>) -> Option<NoteDto> {
    let store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .notes()
        .iter()
        .find(|n| n.id() == id)
        .map(|n| NoteDto::from_note(n, true, &root))
}

/// Returns the saved note as the store now sees it.
///
/// Returning it rather than `()` is what keeps the list and the due pill
/// honest. Everything the UI shows about a note besides its text — the due
/// date and its urgency, the tags, the AI badge, whether it still has an
/// unchecked task — is derived from the content that was just written, and a
/// save is the one moment all of it can change at once. The watcher can't
/// cover this: writing suppresses it precisely so a reload can't land on top
/// of someone's typing, so the write that changes a due date is exactly the
/// write the watcher is deaf to.
#[tauri::command]
fn save_note(id: String, content: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let Some(mut note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    note.set_content(content);
    store.save(&note).map_err(|e| e.to_string())?;
    store
        .notes()
        .iter()
        .find(|n| n.id() == id)
        .map(|n| NoteDto::from_note(n, false, &root))
        .ok_or_else(|| format!("note {id} vanished during save"))
}

#[tauri::command]
fn create_note(title: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .create(&title)
        .map(|n| NoteDto::from_note(&n, true, &root))
        .map_err(|e| e.to_string())
}

/// Creates a note inside an existing subfolder — the `Folder/Title` quick-create
/// from the search box. The frontend only calls this once it has matched the
/// folder against a real subfolder, so an unknown folder never reaches here.
#[tauri::command]
fn create_note_in_subfolder(
    title: String,
    subfolder: String,
    state: State<AppState>,
) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .create_in_subfolder(&title, &subfolder)
        .map(|n| NoteDto::from_note(&n, true, &root))
        .map_err(|e| e.to_string())
}

/// Splits a selection off into a note of its own, returning it so the caller
/// can leave a `[[link]]` where the text used to be.
///
/// `in_inbox` follows wherever new notes go, so extracting obeys the same
/// setting as writing one from scratch.
#[tauri::command]
fn extract_to_note(
    selection: String,
    in_inbox: bool,
    state: State<AppState>,
) -> Result<NoteDto, String> {
    let (title, body) = NoteStore::extracted_title_and_body(&selection);
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let mut note = if in_inbox {
        store.create_inbox_note(&title)
    } else {
        store.create(&title)
    }
    .map_err(|e| e.to_string())?;
    // Saved only when there is something to save — an extraction whose title
    // used up the whole selection leaves a note with just its name, and writing
    // an empty body over that is pointless work.
    if !body.is_empty() {
        note.set_content(body);
        store.save(&note).map_err(|e| e.to_string())?;
    }
    Ok(NoteDto::from_note(&note, true, &root))
}

/// Opens a link from a note in the default browser.
///
/// The scheme is checked rather than trusted. This opens whatever a note's text
/// says, and a note can be written by anything — synced in, pasted, or edited
/// outside Envy — so restricting it to http and https keeps a file:// or a
/// shell-adjacent scheme in someone's notes from becoming a way to launch
/// things by clicking a link that looked ordinary.
#[tauri::command]
fn open_external_url(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let lowered = url.to_lowercase();
    if !lowered.starts_with("http://") && !lowered.starts_with("https://") {
        return Err(format!("refusing to open a non-web link: {url}"));
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Saves pasted image bytes into `Attachments/`, returning the stored filename
/// for the editor to drop into an `![[…]]`. `base`/`ext` are fixed by the paste
/// handler ("Pasted image"/"png"). The internal-write mark keeps our own write
/// from bouncing back through the file watcher as an outside change.
#[tauri::command]
fn save_attachment(
    bytes: Vec<u8>,
    base: String,
    ext: String,
    state: State<AppState>,
) -> Result<String, String> {
    state.mark_internal_write();
    state
        .store
        .lock()
        .unwrap()
        .save_attachment(&bytes, &base, &ext)
        .map_err(|e| e.to_string())
}

/// Copies a dropped image file into `Attachments/`, returning the stored
/// filename. The original file is left where it was.
#[tauri::command]
fn copy_attachment(path: String, state: State<AppState>) -> Result<String, String> {
    state.mark_internal_write();
    state
        .store
        .lock()
        .unwrap()
        .copy_attachment(std::path::Path::new(&path))
        .map_err(|e| e.to_string())
}

/// An attachment the UI may read, open or reveal, resolved to a real path.
///
/// `name` comes out of note text, so `attachment_path` already contains it to
/// a single leaf inside `Attachments/`. What is left is the folder itself: a
/// symlink planted in it would otherwise let a crafted `![[…]]` hand any file
/// on the disk to the system opener. So the name has to read as an image, the
/// path has to be a regular file, and where it really resolves to has to still
/// be inside the attachments folder.
fn resolved_attachment(name: &str, state: &State<AppState>) -> Result<PathBuf, String> {
    if !envy_core::note::is_image_attachment(name) {
        return Err("that isn't an image attachment".to_string());
    }
    let (dir, path) = {
        let store = state.store.lock().unwrap();
        (store.attachments_dir(), store.attachment_path(name))
    };
    if !std::fs::metadata(&path).map(|m| m.is_file()).unwrap_or(false) {
        return Err("no such image".to_string());
    }
    let dir = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    let path = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !path.starts_with(&dir) {
        return Err("that image is outside the vault".to_string());
    }
    Ok(path)
}

/// The raw bytes of an attachment, for rendering it inline. Returned as an IPC
/// response (an ArrayBuffer on the JS side), not a JSON number array, so a
/// multi-megabyte image doesn't pay serialization overhead on every restyle.
#[tauri::command(async)]
fn read_attachment(name: String, state: State<AppState>) -> Result<tauri::ipc::Response, String> {
    let path = resolved_attachment(&name, &state)?;
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

/// Opens an attachment in the system default app — the click-the-filename
/// action, matching the Mac handing the image to Preview.
#[tauri::command]
fn open_attachment(
    name: String,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = resolved_attachment(&name, &state)?;
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Renames an attachment file and rewrites every `![[…]]` reference to it across
/// the vault, returning the final (de-duped) name. The reference rewrites touch
/// note files, so the caller refreshes the open note afterwards.
#[tauri::command]
fn rename_attachment(
    old_name: String,
    new_name: String,
    state: State<AppState>,
) -> Result<String, String> {
    state.mark_internal_write();
    state
        .store
        .lock()
        .unwrap()
        .rename_attachment(&old_name, &new_name)
        .ok_or_else(|| "Could not rename the image.".to_string())
}

/// Selects an attachment in a new Explorer window — the "Reveal in Explorer"
/// menu item, matching the Mac's activateFileViewerSelecting.
#[tauri::command]
fn reveal_attachment(name: String, state: State<AppState>) -> Result<(), String> {
    let path = resolved_attachment(&name, &state)?;
    reveal_path(&path)
}

/// Every image already in the vault, newest first — the Insert Image picker
/// reads bytes for each with `read_attachment` to show a thumbnail.
#[tauri::command(async)]
fn list_image_attachments(state: State<AppState>) -> Vec<String> {
    state.store.lock().unwrap().image_attachments()
}

/// Every folder under the Index a note could be filed into, for the "Move to"
/// menu. Walked fresh each time the menu opens rather than cached — folders
/// change from outside Envy as easily as from within it.
#[tauri::command(async)]
fn list_subfolders(state: State<AppState>) -> Vec<String> {
    state.store.lock().unwrap().subfolders()
}

/// Files a note into `subfolder`, or to the Index root when it is null.
///
/// A real file move, so the category is on disk and portable. The title is
/// untouched, which is what keeps `[[links]]` pointing at it working — and why
/// a move onto a name already taken in the destination is refused with a
/// readable error rather than quietly renamed.
#[tauri::command]
fn move_note_to_subfolder(
    id: String,
    subfolder: Option<String>,
    state: State<AppState>,
) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let Some(title) = store.notes().iter().find(|n| n.id() == id).map(|n| n.title().to_string())
    else {
        return Err(format!("no note with id {id}"));
    };
    let target = subfolder.as_deref().unwrap_or("").trim_matches(['/', ' ']);
    if !target.is_empty() && envy_core::store::sanitized_subfolder(target).is_none() {
        return Err("That folder name can't be used.".to_string());
    }
    store
        .move_note(&id, subfolder.as_deref())
        .map(|n| NoteDto::from_note(&n, false, &root))
        .ok_or_else(|| format!("A note named \u{201c}{title}\u{201d} already exists in that folder."))
}

/// One row of a browse catalog: a folder or tag name, and how many notes it
/// holds.
#[derive(Serialize)]
struct CatalogRow {
    name: String,
    count: usize,
}

/// The `folder:` catalog — every folder with its note count, most-used first.
#[tauri::command(async)]
fn folder_catalog(state: State<AppState>) -> Vec<CatalogRow> {
    state
        .store
        .lock()
        .unwrap()
        .folder_counts()
        .into_iter()
        .map(|(name, count)| CatalogRow { name, count })
        .collect()
}

/// The `tag:` catalog — every tag with its note count, most-used first.
#[tauri::command(async)]
fn tag_catalog(state: State<AppState>) -> Vec<CatalogRow> {
    state
        .store
        .lock()
        .unwrap()
        .tag_counts()
        .into_iter()
        .map(|(name, count)| CatalogRow { name, count })
        .collect()
}

/// Renames a folder across the vault, carrying every note inside it. Returns the
/// folder's new relative path, or an error if the rename was refused (a reserved
/// or already-taken name, or an empty target).
#[tauri::command]
fn rename_folder(
    old_path: String,
    new_path: String,
    state: State<AppState>,
) -> Result<String, String> {
    state.mark_internal_write();
    state
        .store
        .lock()
        .unwrap()
        .rename_folder(&old_path, &new_path)
        .ok_or_else(|| {
            "That name is already taken, reserved, or empty.".to_string()
        })
}

/// Renames a tag across every note that carries it, merging when the new name
/// already exists.
#[tauri::command]
fn rename_tag(old_name: String, new_name: String, state: State<AppState>) {
    state.mark_internal_write();
    state.store.lock().unwrap().rename_tag(&old_name, &new_name);
}

/// Follows a `[[wiki-link]]`, creating the target note if it doesn't exist —
/// which is most of what makes linking feel immediate rather than clerical.
#[tauri::command]
fn open_link(target: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .open_or_create_link(&target)
        .map(|n| NoteDto::from_note(&n, true, &root))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_note(id: String, title: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let Some(note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    store
        .rename(&note, &title)
        .map(|n| NoteDto::from_note(&n, true, &root))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_note(id: String, state: State<AppState>) -> Result<(), String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let Some(note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    store.delete(&[note]);
    Ok(())
}

/// Notes currently sitting in any `.trash` folder, filtered by the text typed
/// after `trash:`. An empty fragment matches everything, the same way
/// `template:` shows every template until you narrow it.
///
/// Content is included: the trash preview shows the note's text, and a trashed
/// note is not in `notes()`, so `read_note` cannot reach it.
#[tauri::command(async)]
fn trashed_notes(fragment: String, state: State<AppState>) -> Vec<NoteDto> {
    let needle = fragment.trim().to_lowercase();
    let store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .trashed_notes()
        .iter()
        .filter(|n| needle.is_empty() || n.lowercased_title().contains(&needle))
        .map(|n| NoteDto::from_note(n, true, &root))
        .collect()
}

#[tauri::command]
fn restore_from_trash(id: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let Some(note) = store.trashed_notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no trashed note with id {id}"));
    };
    store
        .restore_from_trash(&note)
        .map(|n| NoteDto::from_note(&n, false, &root))
        .ok_or_else(|| "could not restore the note".to_string())
}

#[tauri::command]
fn delete_from_trash(id: String, state: State<AppState>) -> Result<(), String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let Some(note) = store.trashed_notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no trashed note with id {id}"));
    };
    store.delete_from_trash(&note);
    Ok(())
}

/// Reveals one of the Index's own folders. `which` is "index", "templates" or
/// "trash" — the trash folder is the one beside the Index root, which is where
/// top-level deletions land.
#[tauri::command]
fn reveal_folder(which: String, state: State<AppState>) -> Result<(), String> {
    let dir = state.store.lock().unwrap().directory().to_path_buf();
    let path = match which.as_str() {
        "templates" => dir.join("Templates"),
        "trash" => dir.join(".trash"),
        // The two live outside the vault: the settings file's folder and the
        // theme files beside it.
        "config" => config::config_dir(),
        "themes" => config::themes_dir(),
        _ => dir,
    };
    // Created on demand: Explorer cannot show a folder that doesn't exist yet,
    // and neither Templates/ nor .trash/ exists until first used.
    let _ = std::fs::create_dir_all(&path);
    open_directory(&path)
}

/// Re-points the store at a different folder.
#[tauri::command]
fn set_index_directory(
    path: String,
    include_subfolders: bool,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let count = open_index(&app, &state, &path, include_subfolders)?;
    // Remembered for next launch, so the choice sticks rather than resetting to
    // the default folder every restart.
    save_index_directory(&app, Path::new(&path));
    Ok(count)
}

/// Opens `path` as the Index and re-points the watcher at it. Shared by the
/// Change Location… command and by the config watcher, so a `vault` edited in
/// the file lands exactly the same way as one chosen in Settings.
fn open_index(
    app: &tauri::AppHandle,
    state: &State<AppState>,
    path: &str,
    include_subfolders: bool,
) -> Result<usize, String> {
    // The root has no parent, and scanning it would walk the whole machine —
    // as would an empty path, which resolves to the working directory. A path
    // that exists but isn't a folder can't hold notes either.
    let chosen = Path::new(path);
    if chosen.parent().is_none() {
        return Err("Choose a folder, not the whole filesystem.".to_string());
    }
    if chosen.exists() && !chosen.is_dir() {
        return Err("That is a file, not a folder.".to_string());
    }
    let store = NoteStore::open(path, include_subfolders).map_err(|e| e.to_string())?;
    let count = store.notes().len();
    let watched = store.directory().to_path_buf();
    *state.store.lock().unwrap() = store;
    // The old watcher is still pointed at the previous folder; replacing it is
    // what makes external edits in the new one register at all.
    let handle = app.clone();
    let suppress = Arc::clone(&state.suppress_until);
    let watcher = envy_core::watch_path(watched, move |paths| {
        if std::time::Instant::now() < *suppress.lock().unwrap() {
            return;
        }
        let Some(s) = handle.try_state::<AppState>() else { return };
        s.store.lock().unwrap().reload_paths(paths);
        let _ = handle.emit("index-changed", ());
    })
    .ok();
    *state._watcher.lock().unwrap() = watcher;
    Ok(count)
}

/// Re-applies the keys Rust owns after the config file changes under it — an
/// agent editing it, `$EDITOR`, or Envy's own editor through
/// `config_write_text`. The frontend re-applies its own half from the same
/// `config-changed` event; this is the half no window can do.
pub(crate) fn apply_config_owned(app: &tauri::AppHandle) {
    apply_autostart(app);
    hyprland::apply(config::hyprland_bind());
    hyprland::apply_floating(app);
    let on = config::keep_on_top();
    if KEEP_ON_TOP_APPLIED.swap(on, Ordering::Relaxed) != on {
        apply_keep_on_top(app, on);
        refresh_tray_menu(app);
    }
    // The tray's Keep on Top item is greyed out while tiled, so a change to
    // `system.tiled` redraws the menu too.
    let floating = config::floating();
    if FLOATING_APPLIED.swap(floating, Ordering::Relaxed) != floating {
        refresh_tray_menu(app);
    }
    register_global_shortcuts(app, config::global_shortcuts());

    // A vault named in the file is the same instruction as Change Location…,
    // so it re-points the store rather than waiting for a restart.
    let Some(wanted) = config::vault() else { return };
    let Some(state) = app.try_state::<AppState>() else { return };
    let current = state.store.lock().unwrap().directory().to_path_buf();
    let same = dunce_canonical(&wanted) == dunce_canonical(&current);
    if same {
        return;
    }
    // The store has no accessor for it, and the config is the truth anyway.
    let include_subfolders = config::include_subfolders();
    if open_index(app, &state, &wanted.to_string_lossy(), include_subfolders).is_ok() {
        let _ = app.emit("index-changed", ());
    }
}

/// Paths compare by what they resolve to: `~/Notes` and `/home/x/Notes` are
/// the same folder, and only one of them is what the store recorded.
fn dunce_canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[tauri::command]
fn empty_trash(state: State<AppState>) -> usize {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let count = store.trashed_notes().len();
    store.empty_trash();
    count
}

/// Deletes several notes as one action.
///
/// One call rather than a loop of `delete_note`, because the store treats a
/// single `delete` as one undo step — `restore_last_deleted` brings the whole
/// batch back. Looping would leave only the last note restorable.
#[tauri::command]
fn delete_notes(ids: Vec<String>, state: State<AppState>) -> Result<usize, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let notes: Vec<_> = store
        .notes()
        .iter()
        .filter(|n| ids.iter().any(|i| i == n.id()))
        .cloned()
        .collect();
    let count = notes.len();
    store.delete(&notes);
    Ok(count)
}

#[tauri::command]
fn restore_last_deleted(state: State<AppState>) -> Vec<NoteDto> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    store
        .restore_last_deleted()
        .iter()
        .map(|n| NoteDto::from_note(n, false, &root))
        .collect()
}

#[derive(Serialize)]
pub struct TemplateDto {
    id: String,
    name: String,
}

/// Templates whose name contains `fragment`. An empty fragment (just
/// "template:" typed so far) matches everything, the same way `tag:` shows
/// everything until you narrow it.
#[tauri::command(async)]
fn list_templates(fragment: String, state: State<AppState>) -> Vec<TemplateDto> {
    let needle = fragment.trim().to_lowercase();
    state
        .store
        .lock()
        .unwrap()
        .templates()
        .into_iter()
        .filter(|t| needle.is_empty() || t.name.to_lowercase().contains(&needle))
        .map(|t| TemplateDto {
            id: t.path.to_string_lossy().into_owned(),
            name: t.name,
        })
        .collect()
}

/// Creates a note from a template, with the tokens substituted.
///
/// An explicit action rather than a side effect of opening a template to look
/// at it — the Mac makes the same split, and browsing your templates should
/// not litter the Index with notes.
#[tauri::command]
fn create_note_from_template(
    path: String,
    title: String,
    state: State<AppState>,
) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let Some(template) = store.templates().into_iter().find(|t| t.path.to_string_lossy() == path)
    else {
        return Err("no such template".to_string());
    };
    let now = chrono::Local::now();
    let pattern = state.template_date_format.lock().unwrap().clone();
    store
        .create_from_template(
            &title,
            &template,
            &now.format(&date_pattern_to_strftime(&pattern)).to_string(),
            &format_template_time(now),
        )
        .map(|n| NoteDto::from_note(&n, true, &root))
        .map_err(|e| e.to_string())
}

/// The template `path` names, or an error.
///
/// `path` is whatever the frontend sent and both commands below use it
/// directly, so it is matched against the store's own list rather than
/// trusted — the same check `create_note_from_template` makes. The editor
/// only ever opens a template the picker listed, and there is no "new
/// template" flow, so a path that isn't already a template is refused rather
/// than created.
fn template_path(path: &str, state: &State<AppState>) -> Result<PathBuf, String> {
    state
        .store
        .lock()
        .unwrap()
        .templates()
        .into_iter()
        .find(|t| t.path.to_string_lossy() == path)
        .map(|t| t.path)
        .ok_or_else(|| "no such template".to_string())
}

/// A template is a plain `.md` file, so this is a plain read — deliberately
/// not routed through the note store, which never treats one as a note.
#[tauri::command(async)]
fn read_template(path: String, state: State<AppState>) -> Result<String, String> {
    let path = template_path(&path, &state)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_template(path: String, content: String, state: State<AppState>) -> Result<(), String> {
    let path = template_path(&path, &state)?;
    // Templates live inside The Index, so writing one trips the watcher just
    // like a note does.
    state.mark_internal_write();
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// How many notes are waiting in `Inbox/`.
///
/// Counted across every note rather than the filtered list, so the badge shows
/// the size of the backlog and not of whatever happens to be on screen.
/// Every tag in use, for the search box's ghost-text completion.
///
/// Sorted by how often each is used rather than alphabetically: completing to
/// the tag you reach for most is right far more often than completing to the
/// one that happens to start with an early letter.
#[tauri::command(async)]
fn all_tags(state: State<AppState>) -> Vec<String> {
    let store = state.store.lock().unwrap();
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for note in store.notes() {
        for tag in note.tags() {
            *counts.entry(tag.clone()).or_default() += 1;
        }
    }
    let mut tags: Vec<_> = counts.into_iter().collect();
    tags.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    tags.into_iter().map(|(t, _)| t).collect()
}

/// Every note's title, newest first — for the search box's autofill of the
/// title-taking operators (`link:`, `interlink:`, `title:`). The store already
/// holds notes in modified-descending order, so this is just a projection.
#[tauri::command(async)]
fn all_titles(state: State<AppState>) -> Vec<String> {
    state
        .store
        .lock()
        .unwrap()
        .notes()
        .iter()
        .map(|n| n.title().to_string())
        .collect()
}

#[tauri::command(async)]
fn inbox_count(state: State<AppState>) -> usize {
    if !inbox_enabled() {
        return 0;
    }
    state
        .store
        .lock()
        .unwrap()
        .notes()
        .iter()
        .filter(|n| envy_core::search::is_inbox_note(n))
        .count()
}

/// Whole-vault totals for the footer: every loaded note (fleeting ones
/// included; Templates and Trash never load) and the subfolder count. Both are
/// cheap reads. Mirrors the Mac's vaultCountsLabel inputs — the folder count is
/// only *shown* when subfolder scanning is on, which the frontend decides.
#[derive(Serialize)]
struct VaultCounts {
    notes: usize,
    folders: usize,
}

/// The remembered on-top state, for the frontend to suppress hide-on-focus-loss
/// while it's on.
#[tauri::command]
fn keep_on_top(app: tauri::AppHandle) -> bool {
    persisted_keep_on_top(&app)
}

#[tauri::command(async)]
fn vault_counts(state: State<AppState>) -> VaultCounts {
    let store = state.store.lock().unwrap();
    VaultCounts {
        notes: store.notes().len(),
        folders: store.subfolders().len(),
    }
}

/// Files a fleeting note into the Index proper — a plain move out of `Inbox/`,
/// to the root or straight into `subfolder` when one is given. The note's text
/// is untouched, so nothing about having been fleeting survives in the file.
#[tauri::command]
fn submit_from_inbox(
    id: String,
    subfolder: Option<String>,
    state: State<AppState>,
) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let Some(note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    store
        .submit_from_inbox(&note, subfolder.as_deref())
        .map(|n| NoteDto::from_note(&n, true, &root))
        .ok_or_else(|| "that note is not in the Inbox".to_string())
}

/// Captures a fleeting note — or, with the Inbox turned off, a plain note at
/// the root: the capture shortcut keeps working, it just has nowhere fleeting
/// to put things.
#[tauri::command]
fn create_inbox_note(title: String, state: State<AppState>) -> Result<NoteDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let root = store.directory().to_path_buf();
    let created = if inbox_enabled() {
        store.create_inbox_note(&title)
    } else {
        store.create(&title)
    };
    created
        .map(|n| NoteDto::from_note(&n, true, &root))
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct InterlinkRefDto {
    id: String,
    title: String,
}

#[derive(Serialize)]
pub struct SuggestionDto {
    title: String,
    /// UTF-16 offsets, so the editor can use them as string indices directly.
    start: usize,
    end: usize,
}

#[derive(Serialize)]
pub struct InterlinksDto {
    links: Vec<InterlinkRefDto>,
    backlinks: Vec<InterlinkRefDto>,
    suggested: Vec<SuggestionDto>,
}

#[tauri::command(async)]
fn interlinks(id: String, state: State<AppState>) -> InterlinksDto {
    let store = state.store.lock().unwrap();
    let Some(note) = store.notes().iter().find(|n| n.id() == id) else {
        return InterlinksDto {
            links: Vec::new(),
            backlinks: Vec::new(),
            suggested: Vec::new(),
        };
    };
    let result = store.interlinks(note);
    let to_dto = |r: &envy_core::InterlinkRef| InterlinkRefDto {
        id: r.id.clone(),
        title: r.title.clone(),
    };
    InterlinksDto {
        links: result.links.iter().map(to_dto).collect(),
        backlinks: result.backlinks.iter().map(to_dto).collect(),
        suggested: result
            .suggested
            .iter()
            .map(|s| SuggestionDto {
                title: s.title.clone(),
                start: s.start,
                end: s.end,
            })
            .collect(),
    }
}

#[tauri::command(async)]
fn can_restore(state: State<AppState>) -> bool {
    state.store.lock().unwrap().can_restore_last_deleted()
}

#[tauri::command]
fn set_include_subfolders(include: bool, state: State<AppState>) -> usize {
    let mut store = state.store.lock().unwrap();
    store.set_include_subfolders(include);
    store.notes().len()
}

/// Opens The Index in Explorer. The folder being an ordinary folder of
/// ordinary files is the whole premise, so making it one click away matters
/// more than it would in an app that owned its storage.
#[tauri::command]
fn reveal_index(state: State<AppState>) -> Result<(), String> {
    let dir = state.store.lock().unwrap().directory().to_path_buf();
    open_directory(&dir)
}

/// One installed font family, for the Settings picker.
#[derive(serde::Serialize)]
struct FontFamily {
    name: String,
    mono: bool,
}

/// Installed font families, monospace ones flagged so the picker can put them
/// first. Linux asks fontconfig (`fc-list`). Windows returns the families
/// every machine actually has, plus any others named in config.md which the
/// picker keeps as their own entry.
#[cfg(target_os = "linux")]
#[tauri::command]
fn font_families() -> Result<Vec<FontFamily>, String> {
    let out = std::process::Command::new("fc-list")
        .args(["--format", "%{family[0]}\t%{spacing}\n"])
        .output()
        .map_err(|e| format!("fc-list could not run: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut seen = std::collections::BTreeMap::<String, bool>::new();
    for line in text.lines() {
        let (name, spacing) = line.split_once('\t').unwrap_or((line, ""));
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        // fontconfig: 100 is mono, 110 charcell; 90 (dual) is not fixed-pitch
        // in the way an editor wants. A family with any monospace face counts.
        let mono = matches!(spacing.trim(), "100" | "110");
        let entry = seen.entry(name.to_string()).or_insert(false);
        *entry = *entry || mono;
    }
    Ok(seen
        .into_iter()
        .map(|(name, mono)| FontFamily { name, mono })
        .collect())
}

#[cfg(windows)]
#[tauri::command]
fn font_families() -> Result<Vec<FontFamily>, String> {
    const FONTS: &[(&str, bool)] = &[
        ("Cascadia Code", true),
        ("Cascadia Mono", true),
        ("Consolas", true),
        ("Courier New", true),
        ("Lucida Console", true),
        ("JetBrains Mono", true),
        ("Fira Code", true),
        ("Segoe UI", false),
        ("Segoe UI Variable Text", false),
        ("Calibri", false),
        ("Cambria", false),
        ("Georgia", false),
        ("Times New Roman", false),
        ("Arial", false),
        ("Verdana", false),
        ("Tahoma", false),
        ("Sitka Text", false),
        ("Bahnschrift", false),
        ("Aptos", false),
    ];
    Ok(FONTS
        .iter()
        .map(|(name, mono)| FontFamily {
            name: (*name).to_string(),
            mono: *mono,
        })
        .collect())
}

/// Opens a folder in the user's file manager. Explorer on Windows; on Linux
/// `xdg-open`, which hands the directory to whatever the desktop has
/// registered for `inode/directory` — deliberately not nautilus / thunar /
/// dolphin by name.
#[cfg(windows)]
fn open_directory(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn open_directory(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Opens Explorer with one note selected — the Mac's "Open in Finder".
///
/// `explorer /select,<path>` returns a non-zero exit code even when it works,
/// which is long-standing Windows behaviour rather than a failure, so the
/// status is deliberately not checked.
///
/// The command line is built with `raw_arg`, not `arg`, on purpose. `arg`
/// quotes any value containing a space, which for a vault like
/// `D:\Documents\Envy Benchmark\Note.md` yields `explorer "/select,D:\…\Note.md"`
/// — the whole switch wrapped in one pair of quotes. Explorer can't parse that
/// and silently opens the user's Documents folder instead of selecting the
/// file. The form it actually wants is `/select,"<path>"`: the switch bare, only
/// the path quoted. `raw_arg` appends exactly that, byte for byte.
/// Selects `path` in a new Explorer window. `raw_arg`, not `arg`, for the
/// reason spelled out on `reveal_note`: the switch stays bare and only the path
/// is quoted, so a vault path with spaces still selects the file.
#[cfg(windows)]
fn reveal_path(path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("explorer")
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Selects `path` in the user's file manager — the Linux "Show in Folder".
///
/// Tries the FreeDesktop `org.freedesktop.FileManager1.ShowItems` D-Bus call
/// first, which every mainstream file manager (Nautilus, Thunar, Dolphin,
/// Nemo, …) implements and which actually *selects* the file rather than just
/// opening its folder. If no file manager answers on the session bus, falls
/// back to `xdg-open` on the parent directory, which at least lands the user in
/// the right place. Neither path names a specific file manager.
#[cfg(not(windows))]
fn reveal_path(path: &std::path::Path) -> Result<(), String> {
    let uri = file_uri(path);
    let shown = std::process::Command::new("dbus-send")
        .args([
            "--session",
            "--print-reply",
            "--dest=org.freedesktop.FileManager1",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItems",
        ])
        .arg(format!("array:string:{uri}"))
        .arg("string:")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if shown {
        return Ok(());
    }
    let parent = path.parent().unwrap_or(path);
    open_directory(parent)
}

/// `file://` URI for a local path, percent-encoding everything RFC 3986 does
/// not allow unescaped in a path segment. Spaces and `#` in note titles are
/// the common cases — an unescaped `#` would be read as a fragment.
#[cfg(not(windows))]
fn file_uri(path: &std::path::Path) -> String {
    use std::os::unix::ffi::OsStrExt;
    let mut out = String::from("file://");
    for &b in path.as_os_str().as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[tauri::command]
fn reveal_note(id: String, state: State<AppState>) -> Result<(), String> {
    let path = {
        let store = state.store.lock().unwrap();
        // Trash is searched too: "Reveal in Explorer" is offered on trashed
        // notes as well, and those are not in `notes()`.
        store
            .notes()
            .iter()
            .chain(store.trashed_notes().iter())
            .find(|n| n.id() == id)
            .map(|n| n.url().to_path_buf())
            .ok_or_else(|| format!("no note with id {id}"))?
    };
    reveal_path(&path)
}

#[tauri::command]
fn convert_to_template(id: String, state: State<AppState>) -> Result<TemplateDto, String> {
    state.mark_internal_write();
    let mut store = state.store.lock().unwrap();
    let Some(note) = store.notes().iter().find(|n| n.id() == id).cloned() else {
        return Err(format!("no note with id {id}"));
    };
    store
        .convert_to_template(&note)
        .map(|t| TemplateDto {
            id: t.path.to_string_lossy().into_owned(),
            name: t.name,
        })
        .ok_or_else(|| "could not move the note into Templates".to_string())
}

/// Re-reads the Index from disk. Called on window focus for now — the file
/// watcher will make this automatic, but until then focusing the window after
/// editing a note elsewhere is enough to pick the change up.
#[tauri::command]
fn reload(state: State<AppState>) -> usize {
    let mut store = state.store.lock().unwrap();
    store.reload();
    store.notes().len()
}

/// Parses a binding like "Ctrl+Alt+Shift+P" into a Shortcut.
///
/// The string form comes from the frontend, which is where remapping happens;
/// this is the one place it becomes an OS registration.
fn parse_shortcut(binding: &str) -> Option<tauri_plugin_global_shortcut::Shortcut> {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

    let mut mods = Modifiers::empty();
    let mut code = None;
    for part in binding.split('+') {
        match part.trim() {
            "Ctrl" => mods |= Modifiers::CONTROL,
            "Alt" => mods |= Modifiers::ALT,
            "Shift" => mods |= Modifiers::SHIFT,
            "Enter" => code = Some(Code::Enter),
            "Space" => code = Some(Code::Space),
            "Backspace" => code = Some(Code::Backspace),
            "ArrowDown" => code = Some(Code::ArrowDown),
            "ArrowUp" => code = Some(Code::ArrowUp),
            "ArrowLeft" => code = Some(Code::ArrowLeft),
            "ArrowRight" => code = Some(Code::ArrowRight),
            other if other.len() == 1 => {
                let c = other.chars().next().unwrap().to_ascii_uppercase();
                code = match c {
                    'A'..='Z' => Some(letter_code(c)),
                    '0'..='9' => Some(digit_code(c)),
                    ',' => Some(Code::Comma),
                    '.' => Some(Code::Period),
                    '-' => Some(Code::Minus),
                    '=' => Some(Code::Equal),
                    _ => None,
                };
            }
            _ => {}
        }
    }
    code.map(|c| Shortcut::new(if mods.is_empty() { None } else { Some(mods) }, c))
}

fn letter_code(c: char) -> tauri_plugin_global_shortcut::Code {
    use tauri_plugin_global_shortcut::Code::*;
    const LETTERS: [tauri_plugin_global_shortcut::Code; 26] = [
        KeyA, KeyB, KeyC, KeyD, KeyE, KeyF, KeyG, KeyH, KeyI, KeyJ, KeyK, KeyL, KeyM, KeyN, KeyO,
        KeyP, KeyQ, KeyR, KeyS, KeyT, KeyU, KeyV, KeyW, KeyX, KeyY, KeyZ,
    ];
    LETTERS[(c as u8 - b'A') as usize]
}

fn digit_code(c: char) -> tauri_plugin_global_shortcut::Code {
    use tauri_plugin_global_shortcut::Code::*;
    const DIGITS: [tauri_plugin_global_shortcut::Code; 10] = [
        Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9,
    ];
    DIGITS[(c as u8 - b'0') as usize]
}

/// Re-registers the global shortcuts after a remap.
///
/// Everything is unregistered first: leaving the old chord live would mean a
/// remap adds a binding rather than moves one, and the previous one would keep
/// firing with no way to find out why.
#[tauri::command]
fn set_global_shortcuts(
    summon: String,
    show_pinned: String,
    unpin: String,
    keep_on_top: String,
    app: tauri::AppHandle,
) -> Vec<String> {
    register_global_shortcuts(
        &app,
        [
            ("summonApp".to_string(), summon),
            ("showPinnedNote".to_string(), show_pinned),
            ("unpinFromTray".to_string(), unpin),
            ("keepOnTop".to_string(), keep_on_top),
        ]
        .into_iter()
        .collect(),
    )
}

/// Registers the four compositor-level chords, replacing whatever was
/// registered before. Shared by the frontend's command and by the startup and
/// config-change paths, which seed the same four from `[shortcuts]` in the
/// file — so a chord set in the config works before any window exists.
pub(crate) fn register_global_shortcuts(
    app: &tauri::AppHandle,
    bindings: std::collections::HashMap<String, String>,
) -> Vec<String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let Some(state) = app.try_state::<AppState>() else {
        return Vec::new();
    };
    // Re-registering unchanged chords would drop them with the compositor for
    // an instant, and this is called on every settings change now. The last
    // answer is remembered rather than recomputed.
    {
        let last = LAST_GLOBAL_SHORTCUTS.lock().unwrap();
        if let Some(previous) = last.as_ref() {
            if previous.bindings == bindings {
                return previous.failed.clone();
            }
        }
    }
    let _ = app.global_shortcut().unregister_all();
    let mut failed = Vec::new();
    let mut registry = state.global_shortcuts.lock().unwrap();
    registry.clear();

    let bindings_copy = bindings.clone();
    for (id, binding) in bindings {
        let Some(shortcut) = parse_shortcut(&binding) else {
            failed.push(binding);
            continue;
        };
        // Registered individually so one clash doesn't cost the others.
        if app.global_shortcut().register(shortcut).is_err() {
            failed.push(binding.clone());
        }
        // Keyed by the shortcut's own id so the handler can dispatch by
        // lookup rather than by re-testing modifier combinations it would
        // then have to keep in step with the frontend's list.
        registry.insert(shortcut.id(), id.to_string());
    }
    *LAST_GLOBAL_SHORTCUTS.lock().unwrap() = Some(RegisteredShortcuts {
        bindings: bindings_copy,
        failed: failed.clone(),
    });
    failed
}

/// The chords last handed to the compositor, and what failed, so an
/// unchanged set is a no-op with the same answer.
struct RegisteredShortcuts {
    bindings: std::collections::HashMap<String, String>,
    failed: Vec<String>,
}

static LAST_GLOBAL_SHORTCUTS: Mutex<Option<RegisteredShortcuts>> = Mutex::new(None);

/// The summon hotkey.
///
/// `Ctrl+Alt+Enter` is the Windows spelling of the Mac's `⌥⌘↩`: ⌘ maps to
/// Ctrl and ⌥ to Alt, so the shape of the chord is preserved rather than the
/// literal keys. Registration is best-effort — another app may already own the
/// combination, and a note-taking app failing to launch over a hotkey clash
/// would be a poor trade. It is not yet remappable; that needs the shortcuts
/// settings surface.
fn setup_global_hotkey(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::ShortcutState;

    let handle = app.clone();
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, shortcut, event| {
                // Fire on press only; without this each chord toggles twice
                // per use and lands back where it started.
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                // Dispatched by lookup rather than by re-testing chords here,
                // so remapping needs no change on this side at all.
                let action = handle.try_state::<AppState>().and_then(|s| {
                    s.global_shortcuts.lock().unwrap().get(&shortcut.id()).cloned()
                });
                match action.as_deref() {
                    Some("summonApp") => {
                        if let Some(window) = handle.get_webview_window("main") {
                            toggle_window(&window);
                        }
                    }
                    Some("showPinnedNote") => toggle_pinned_window(&handle),
                    Some("keepOnTop") => toggle_keep_on_top(&handle),
                    Some("unpinFromTray") => {
                        if let Some(state) = handle.try_state::<AppState>() {
                            *state.pinned_note.lock().unwrap() = None;
                        }
                        if let Some(w) = handle.get_webview_window(PINNED_WINDOW) {
                            let _ = w.hide();
                        }
                        let _ = handle.emit("pinned-note-changed", ());
                        refresh_tray_menu(&handle);
                    }
                    _ => {}
                }
            })
            .build(),
    )?;
    // Nothing is registered here. The frontend calls set_global_shortcuts on
    // boot with whatever bindings are stored, so defaults and remaps take the
    // same path and cannot drift apart.
    Ok(())
}

/// Writes the verified installer to a temp file and starts it *after* this
/// process has had a few seconds to disappear.
///
/// The delay is the whole point, and it exists because of a bug that shipped.
/// `download_and_install` launches the installer and immediately calls
/// `std::process::exit(0)`, so the two race. The installer runs passive, and
/// its check for a running Envy only kills-and-waits when it actually *finds*
/// one — mid-exit it frequently finds nothing and goes straight to copying.
/// The copy then hits an executable Windows still has locked, and because the
/// generated NSIS script sets no `SetOverwrite`, the default `AllowSkipFiles`
/// means a silent install *skips the unwritable file and carries on*. No error,
/// no abort. The script then writes the registry with the new version.
///
/// The result is an install that reports success while leaving the old binary
/// in place, so the app offers the same update on every launch, forever.
/// Observed twice on a real install: registry 0.1.3, binary 0.1.2.
///
/// Waiting removes the race rather than narrowing it. `ping` rather than
/// `timeout`, because `timeout` reads the console and fails outright when there
/// is not one — which is exactly the case for a detached process.
#[cfg(windows)]
fn launch_installer_after_exit(bytes: &[u8], version: &str) -> std::io::Result<()> {
    let installer = std::env::temp_dir().join(format!("Envy_{version}_x64-setup.exe"));
    std::fs::write(&installer, bytes)?;

    // `/P /R` is passive-with-restart, the same pair Tauri's own passive mode
    // passes, and `/UPDATE` tells the script this is an upgrade rather than a
    // fresh install.
    let mut command = std::process::Command::new("cmd");
    command.arg("/C").arg(format!(
        "ping -n 5 127.0.0.1 >nul & \"{}\" /P /R /UPDATE",
        installer.display()
    ));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW only — and *not* DETACHED_PROCESS. A detached cmd has
        // no console to inherit, so it allocates its own — a real, visible one.
        // That window could be clicked into QuickEdit "select" mode, which halts
        // the console mid-`ping`, so the installer after the `&` never ran (the
        // update just sat on a frozen "Select ping…" window). CREATE_NO_WINDOW
        // gives cmd a hidden console instead: nothing to show, nothing to click,
        // nothing to freeze. A child process outlives its parent regardless, so
        // dropping DETACHED_PROCESS costs nothing — the installer still runs
        // after this app exits.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()?;
    Ok(())
}

/// Looks for a newer release and, if the user agrees, installs it and restarts.
///
/// `manual` is the difference between the check the app runs at launch and the
/// one the menu command runs: only the latter reports finding nothing. A
/// background check that announced "no updates" every launch would be noise,
/// but a menu command that appeared to do nothing at all would look broken.
///
/// Note that shipping the public key is only half of what makes updates
/// possible. The installed build also has to actually perform this check —
/// a release that never asks will never discover its successor no matter what
/// key it was signed against.
#[cfg(windows)]
pub(crate) async fn run_update_check(app: tauri::AppHandle, manual: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    use tauri_plugin_updater::UpdaterExt;

    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };

    match found {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let (tx, rx) = std::sync::mpsc::channel();
            app.dialog()
                .message(format!(
                    "Envy {version} is available.\n\nInstall it now? Envy will restart."
                ))
                .title("Update Available")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Install".into(),
                    "Later".into(),
                ))
                .show(move |install| {
                    let _ = tx.send(install);
                });
            // The dialog answers on another thread, so this waits for the click
            // rather than racing past it. Safe here because this only ever runs
            // inside a spawned task, never on the thread driving the UI.
            if rx.recv().unwrap_or(false) {
                // No progress or total-length handling: this is a ~10MB
                // download, and a progress bar is worth building when there is
                // somewhere in the interface to put one.
                // Downloaded and launched in two steps rather than through
                // `download_and_install`, which does both and cannot be made to
                // wait. See `launch_installer_after_exit`.
                //
                // `download` is where the signature is checked, so nothing is
                // weakened by taking the bytes and running the installer here —
                // they arrive already verified against the key compiled into
                // this build.
                let staged = match update.download(|_, _| {}, || {}).await {
                    Ok(bytes) => launch_installer_after_exit(&bytes, &version)
                        .map_err(|e| e.to_string()),
                    Err(e) => Err(e.to_string()),
                };
                match staged {
                    // The installer is waiting for this process to go away.
                    Ok(()) => app.exit(0),
                    Err(e) => {
                        app.dialog()
                            .message(format!("The update could not be installed.\n\n{e}"))
                            .kind(MessageDialogKind::Error)
                            .title("Update Failed")
                            .blocking_show();
                    }
                }
            }
        }
        Ok(None) => {
            if manual {
                app.dialog()
                    .message("Envy is up to date.")
                    .title("No Updates")
                    .blocking_show();
            }
        }
        Err(e) => {
            // A failed background check is not worth interrupting anyone for —
            // being offline is the usual cause, and it will try again next
            // launch. A check the user explicitly asked for does need an answer.
            if manual {
                app.dialog()
                    .message(format!("Could not check for updates.\n\n{e}"))
                    .kind(MessageDialogKind::Error)
                    .title("Update Check Failed")
                    .blocking_show();
            } else {
                eprintln!("background update check failed: {e}");
            }
        }
    }

    // A check ran to completion (found nothing, failed, or the user deferred an
    // install) — tell the frontend so it can stamp "last checked". Fires for
    // every path here, so a tray-triggered check updates the label too. Not
    // reached when an install starts, since that exits the process first.
    let _ = app.emit("update-checked", ());
}

/// Linux builds have no in-app updater: a release is a GitHub tag plus the
/// pacman repository built from it. A check asks GitHub for the newest release
/// tag, compares it with this build, and hands the update command to a
/// terminal — `sudo` needs one, and the transcript belongs there anyway.
/// There is no automatic check on Linux; `manual == false` is a no-op, so
/// nothing runs at launch and nothing phones home unasked.
#[cfg(not(windows))]
pub(crate) async fn run_update_check(app: tauri::AppHandle, manual: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if !manual {
        return;
    }
    let current = env!("CARGO_PKG_VERSION");
    let latest = tauri::async_runtime::spawn_blocking(latest_release_version)
        .await
        .unwrap_or_else(|e| Err(e.to_string()));
    match latest {
        Ok(latest) if version_newer(&latest, current) => {
            let exe = std::env::current_exe().unwrap_or_default();
            match update_command(&exe) {
                Some(cmd) => {
                    let (tx, rx) = std::sync::mpsc::channel();
                    app.dialog()
                        .message(format!(
                            "Envy {latest} is available (this is {current}).\n\n\
                             Open a terminal and run:\n\n    {cmd}"
                        ))
                        .title("Update Available")
                        .buttons(MessageDialogButtons::OkCancelCustom(
                            "Open Terminal".into(),
                            "Later".into(),
                        ))
                        .show(move |go| {
                            let _ = tx.send(go);
                        });
                    // Same shape as the Windows path: the dialog answers on
                    // another thread, and this only ever runs in a spawned task.
                    if rx.recv().unwrap_or(false) {
                        if let Err(e) = open_terminal_with(&cmd) {
                            app.dialog()
                                .message(format!("Could not open a terminal.\n\n{e}\n\nRun it yourself:\n\n    {cmd}"))
                                .kind(MessageDialogKind::Error)
                                .title("No Terminal")
                                .blocking_show();
                        }
                    }
                }
                None => {
                    app.dialog()
                        .message(format!(
                            "Envy {latest} is available (this is {current}).\n\n{}",
                            linux_update_advice(&exe)
                        ))
                        .title("Update Available")
                        .blocking_show();
                }
            }
        }
        Ok(latest) => {
            let note = if version_newer(current, &latest) {
                format!("Envy {current} is newer than the latest release, {latest}.")
            } else {
                format!("Envy {current} is the latest release.")
            };
            app.dialog().message(note).title("No Updates").blocking_show();
        }
        Err(e) => {
            app.dialog()
                .message(format!("Could not check GitHub for updates.\n\n{e}"))
                .kind(MessageDialogKind::Error)
                .title("Update Check Failed")
                .blocking_show();
        }
    }
    // Stamps "last checked" in Settings, whichever way it went.
    let _ = app.emit("update-checked", ());
}

#[cfg(not(windows))]
const RELEASES_API: &str = "https://api.github.com/repos/skuthus/Envy-Linux/releases/latest";

/// The newest release tag on GitHub, without its `v`. `releases/latest`
/// skips drafts, pre-releases and the `repo` release that carries the pacman
/// database (published with `--latest=false`), so it is exactly the version
/// the pacman repository serves. Through curl rather than an HTTP crate: it
/// is on every Arch install, and this is one request a person asked for.
#[cfg(not(windows))]
fn latest_release_version() -> Result<String, String> {
    let out = std::process::Command::new("curl")
        .args([
            "-fsSL",
            "--max-time",
            "15",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            concat!("User-Agent: envynote/", env!("CARGO_PKG_VERSION")),
            RELEASES_API,
        ])
        .output()
        .map_err(|e| format!("curl could not run: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "GitHub did not answer.".to_string()
        } else {
            err
        });
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("unexpected answer from GitHub: {e}"))?;
    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "GitHub's answer named no release.".to_string())?;
    Ok(tag.trim_start_matches('v').to_string())
}

/// `1.0.1` against `1.0.0`, numerically per component. A pre-release suffix
/// (`1.1.0-beta`) counts as its numbers — enough for a version line that
/// only ever moves forward in whole releases.
#[cfg(not(windows))]
fn version_parts(v: &str) -> Vec<u64> {
    v.split(['.', '-'])
        .map_while(|p| p.parse::<u64>().ok())
        .collect()
}

#[cfg(not(windows))]
fn version_newer(candidate: &str, current: &str) -> bool {
    version_parts(candidate) > version_parts(current)
}

/// The update command for where this binary lives. Under `/usr` it came from
/// the package, and `pacman -Sy envynote` upgrades that one package — the form
/// Omarchy's guard allows, since it refuses only a full `-Syu`. Inside a
/// checkout's `target/release` it is the checkout's own build, which updates
/// with the code. Anywhere else there is no command to give.
#[cfg(not(windows))]
fn update_command(exe: &Path) -> Option<String> {
    if exe.starts_with("/usr") {
        return Some("sudo pacman -Sy envynote".to_string());
    }
    let checkout = exe.ancestors().nth(3)?;
    if exe.to_string_lossy().contains("/target/release/") && checkout.join("build.sh").is_file() {
        Some(format!(
            "cd {} && git pull && ./build.sh",
            shell_quote(&checkout.to_string_lossy())
        ))
    } else {
        None
    }
}

/// Runs the command in a terminal window that stays open when it is done.
/// Omarchy's floating-terminal launcher when it is there (logo, the command,
/// a "press any key" — the same frame `omarchy update` itself uses), else
/// the desktop's default terminal with a plain "press Return" at the end.
#[cfg(not(windows))]
fn open_terminal_with(cmd: &str) -> Result<(), String> {
    if which("omarchy-launch-floating-terminal-with-presentation").is_some() {
        std::process::Command::new("omarchy-launch-floating-terminal-with-presentation")
            .arg(cmd)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    } else {
        let script = format!("{cmd}; echo; read -rp 'Press Return to close'");
        let terminal = std::env::var("TERMINAL").unwrap_or_else(|_| "xdg-terminal-exec".to_string());
        std::process::Command::new("setsid")
            .args(["-f", &terminal, "-e", "bash", "-c", &script])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("{terminal}: {e}"))
    }
}

#[cfg(not(windows))]
fn which(program: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|p| p.join(program))
            .find(|p| p.is_file())
    })
}

#[cfg(not(windows))]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The instruction for a binary that has no command to offer: not from the
/// package and not a checkout's release build.
#[cfg(not(windows))]
fn linux_update_advice(exe: &Path) -> String {
    if exe.starts_with("/usr") {
        "Update it with: sudo pacman -Sy envynote".to_string()
    } else {
        "This build came from a checkout, so it updates with the code: pull the repository and run ./build.sh."
            .to_string()
    }
}

#[cfg(all(test, not(windows)))]
mod update_check_tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert!(version_newer("1.0.1", "1.0.0"));
        assert!(version_newer("1.10.0", "1.9.9"));
        assert!(!version_newer("1.0.0", "1.0.0"));
        assert!(!version_newer("0.9.0", "1.0.0"));
        assert!(version_newer("1.1.0-beta", "1.0.0"));
    }

    #[test]
    fn the_command_follows_where_the_binary_lives() {
        assert_eq!(
            update_command(Path::new("/usr/bin/envynote")).as_deref(),
            Some("sudo pacman -Sy envynote")
        );
        assert_eq!(update_command(Path::new("/home/x/Downloads/envynote")), None);
        let here = env!("CARGO_MANIFEST_DIR");
        let checkout = Path::new(here).parent().unwrap();
        let exe = checkout.join("target/release/envynote");
        let cmd = update_command(&exe).expect("a checkout build has a command");
        assert!(cmd.starts_with("cd '"), "{cmd}");
        assert!(cmd.ends_with("&& git pull && ./build.sh"), "{cmd}");
    }
}

/// The frontend's entry point to the same check the tray command and the launch
/// task run — used both for the automatic check at boot (when the setting is on)
/// and the Settings "Check Now" button. `manual` gets the "you're up to date"
/// reassurance; the background check stays silent when it finds nothing.
#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle, manual: bool) {
    run_update_check(app, manual).await;
}

/// Re-applies the bar item after anything it reflects has changed — the menu
/// ("Unpin Note" greys out, a new template appears) and the eye.
fn refresh_tray_menu(app: &tauri::AppHandle) {
    tray::refresh(app);
}

/// Creates a note and pins it to the tray, then shows it — "New Pinned Note"
/// and its template variants. Returns nothing useful; the popover reads the
/// pinned id for itself.
pub(crate) fn create_and_pin(app: &tauri::AppHandle, template_path: Option<&str>) {
    let Some(state) = app.try_state::<AppState>() else { return };
    state.mark_internal_write();

    let created = {
        let mut store = state.store.lock().unwrap();
        match template_path {
            Some(path) => {
                let template = store.templates().into_iter().find(|t| t.path.to_string_lossy() == path);
                match template {
                    // Date and time are formatted here rather than in the
                    // core, which stays UI-agnostic and owns no date style.
                    Some(t) => {
                        let now = chrono::Local::now();
                        let pattern = state.template_date_format.lock().unwrap().clone();
                        store.create_from_template(
                            "",
                            &t,
                            &now.format(&date_pattern_to_strftime(&pattern)).to_string(),
                            &format_template_time(now),
                        )
                    }
                    None => return,
                }
            }
            None => store.create("Untitled"),
        }
    };

    let Ok(note) = created else { return };
    *state.pinned_note.lock().unwrap() = Some(note.id().to_string());
    let _ = app.emit("pinned-note-changed", ());
    refresh_tray_menu(app);
    show_pinned_window(app);
}

/// Show-or-hide, the behaviour the summon hotkey and the tray click share.
///
/// Hiding rather than minimising is deliberate: Envy is meant to be summoned
/// and dismissed, so it should leave the taskbar and Alt-Tab entirely rather
/// than sit there as a minimised window you then have to find.
///
/// The test is *visible*, not visible-and-focused. Whether the window is on
/// screen is the whole question; the app's activation state is a different
/// one. Checking focus broke the tray entirely — clicking a tray icon takes
/// focus away from the window, so by the time this ran the window was never
/// focused and the click could only ever show, never hide.
///
/// A minimised window counts as "not on screen" and is restored rather than
/// hidden, so a window minimised the ordinary way comes back instead of
/// vanishing further.
pub(crate) fn toggle_window(window: &WebviewWindow) {
    let visible = window.is_visible().unwrap_or(false);
    let minimised = window.is_minimized().unwrap_or(false);
    if visible && !minimised {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        // Announces the summon rather than dictating what happens next. Where
        // focus lands is the "Keep focus where it was when summoned" setting,
        // which lives in the frontend, so this used to be an unconditional
        // "focus-search" — which is that setting permanently switched off, and
        // the opposite of the Mac's default.
        let _ = window.emit("summoned", ());
    }
}

pub(crate) const PINNED_WINDOW: &str = "pinned";
/// The panel's window title, which is also how Hyprland is asked about it.
const PINNED_TITLE: &str = "Pinned note";

/// Where the panel was last seen, so it can come back there. The Mac gets
/// this for free from NSWindow's frame autosave; on Wayland a client cannot
/// position itself, so the geometry is read from Hyprland when the panel
/// hides (and at quit) and handed back to Hyprland when it shows.
fn pinned_geometry_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("pinned-window.json"))
}

pub(crate) fn remember_pinned_geometry(app: &tauri::AppHandle) {
    let g = pinned_geometry_now(app);
    let (Some(path), Some(g)) = (pinned_geometry_file(app), g) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(&g) {
        let _ = std::fs::write(path, json);
    }
}

fn pinned_geometry_now(app: &tauri::AppHandle) -> Option<hyprland::Geometry> {
    #[cfg(target_os = "linux")]
    {
        hyprland::geometry(PINNED_TITLE)
    }
    #[cfg(windows)]
    {
        let w = app.get_webview_window(PINNED_WINDOW)?;
        let pos = w.outer_position().ok()?;
        let size = w.outer_size().ok()?;
        Some(hyprland::Geometry {
            x: pos.x as i64,
            y: pos.y as i64,
            w: size.width as i64,
            h: size.height as i64,
        })
    }
}

fn saved_pinned_geometry(app: &tauri::AppHandle) -> Option<hyprland::Geometry> {
    let text = std::fs::read_to_string(pinned_geometry_file(app)?).ok()?;
    serde_json::from_str(&text).ok()
}

fn restore_pinned_geometry(app: &tauri::AppHandle, window: &WebviewWindow) {
    let Some(g) = saved_pinned_geometry(app) else { return };
    #[cfg(target_os = "linux")]
    {
        let _ = window;
        hyprland::place_when_floating(PINNED_TITLE.to_string(), g);
    }
    #[cfg(windows)]
    {
        let _ = window.set_position(tauri::PhysicalPosition::new(g.x as i32, g.y as i32));
        let _ = window.set_size(tauri::PhysicalSize::new(g.w as u32, g.h as u32));
    }
}

/// The panel asks for this just before it hides itself, so what is saved is
/// where the user left it, not where it was created.
#[tauri::command]
fn remember_pinned_window(app: tauri::AppHandle) {
    remember_pinned_geometry(&app);
}

#[tauri::command]
fn pinned_note_id(state: State<AppState>) -> Option<String> {
    state.pinned_note.lock().unwrap().clone()
}

#[tauri::command]
fn set_pinned_note(id: Option<String>, app: tauri::AppHandle, state: State<AppState>) {
    *state.pinned_note.lock().unwrap() = id.clone();
    if id.is_none() {
        if let Some(w) = app.get_webview_window(PINNED_WINDOW) {
            let _ = w.hide();
        }
    }
    // Both windows care: the popover reloads, and the app repaints its pin
    // marks.
    let _ = app.emit("pinned-note-changed", ());
    refresh_tray_menu(&app);
}

/// Brings the main window forward on a specific note — the popover's "Open"
/// button, which is the bridge from glancing to actually working on it.
#[tauri::command]
fn open_in_main_window(id: String, app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = w.emit("open-note", id);
    }
}

/// Creates the popover on first use rather than at launch. It is a window most
/// people will never open, and building it eagerly would cost every user a
/// second webview for a feature they may not use.
pub(crate) fn show_pinned_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(PINNED_WINDOW) {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("pinned-note-changed", ());
        restore_pinned_geometry(app, &w);
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(
        app,
        PINNED_WINDOW,
        tauri::WebviewUrl::App("pinned.html".into()),
    )
    .title(PINNED_TITLE)
    .inner_size(420.0, 460.0)
    .resizable(true)
    // Undecorated and always-on-top so it reads as a panel hanging off the
    // tray rather than a second application window.
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(cfg!(not(windows)))
    .build();
    match built {
        Ok(w) => {
            // `always_on_top` and `skip_taskbar` are X11 hints that Wayland
            // ignores; on Hyprland the panel is floated and pinned instead,
            // so it hangs above every workspace the way the builder intends,
            // and lands centred, a short trip from anywhere.
            hyprland::float_when_mapped(&w, || true, Some(|| true));
            restore_pinned_geometry(app, &w);
            tray::follow_window(app, &w)
        }
        Err(e) => eprintln!("could not open the pinned-note window: {e}"),
    }
}

pub(crate) fn toggle_pinned_window(app: &tauri::AppHandle) {
    match app.get_webview_window(PINNED_WINDOW) {
        Some(w) if w.is_visible().unwrap_or(false) => {
            remember_pinned_geometry(app);
            let _ = w.hide();
        }
        _ => show_pinned_window(app),
    }
}

/// Opens a note in its own floating window — the "Pop Out" context-menu action.
/// Several can be open at once, one per note; popping a note out again just
/// surfaces its window. A note id is a file path, which a window label can't
/// hold, so the label is a hash of it and the id is stashed in state for the
/// page to read back through `popout_note_id`.
/// Async on purpose: a sync command runs on the main thread, and building a
/// window from there needs the same event loop to start the new webview — the
/// loop ends up waiting on itself and the app freezes (shell appears, page
/// never loads). Async runs this on a worker thread, so `run_on_main_thread`
/// genuinely hands the build to the free loop instead of running it inline.
///
/// `inner_size` is the logical size the caller wants the window to open at —
/// the frontend persists the last size a pop-out was dragged to, so the next
/// one opens the same size, as the Mac's self-persisting peek panel does.
/// Absent that, the last size any pop-out was resized to in this session is
/// used (remembered below off the window's own resize events), and failing
/// both, the default.
#[tauri::command]
async fn pop_out_note(id: String, inner_size: Option<(f64, f64)>, app: tauri::AppHandle) {
    use std::hash::{Hash, Hasher};

    /// Last logical size a pop-out was resized to, session-wide.
    static LAST_POPOUT_SIZE: Mutex<Option<(f64, f64)>> = Mutex::new(None);
    /// The builder's own minimum; anything smaller (or absurdly large, or not
    /// a number) is a stale or corrupt value, not a size to honour.
    fn sane(size: (f64, f64)) -> Option<(f64, f64)> {
        let (w, h) = size;
        (w.is_finite() && h.is_finite() && (240.0..=8192.0).contains(&w) && (160.0..=8192.0).contains(&h))
            .then_some((w, h))
    }

    enum Action {
        Surface(String),
        Create(String, f64),
    }
    // Decide under the lock, then drop it before touching any window.
    let action = {
        let state = app.state::<AppState>();
        let mut popouts = state.popouts.lock().unwrap();
        // Sweep windows that have since closed, so a stale label never shadows a
        // fresh pop-out and the cascade count stays honest.
        popouts.retain(|label, _| app.get_webview_window(label).is_some());
        if let Some(existing) = popouts.iter().find(|(_, nid)| *nid == &id).map(|(l, _)| l.clone()) {
            Action::Surface(existing)
        } else {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            id.hash(&mut hasher);
            let label = format!("popout-{:x}", hasher.finish());
            // Cascade each new one down-and-right, wrapping every 8.
            let step = (popouts.len() % 8) as f64 * 26.0;
            popouts.insert(label.clone(), id.clone());
            Action::Create(label, step)
        }
    };

    match action {
        // Already popped out — surface it rather than opening a second copy.
        Action::Surface(label) => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        Action::Create(label, step) => {
            let handle = app.clone();
            let title = {
                let state = app.state::<AppState>();
                let store = state.store.lock().unwrap();
                store
                    .notes()
                    .iter()
                    .find(|n| n.id() == id)
                    .map(|n| n.title().to_string())
                    .unwrap_or_else(|| "Note".to_string())
            };
            let (width, height) = inner_size
                .and_then(sane)
                .or_else(|| LAST_POPOUT_SIZE.lock().unwrap().and_then(sane))
                .unwrap_or((440.0, 480.0));
            let _ = app.run_on_main_thread(move || {
                let built = tauri::WebviewWindowBuilder::new(
                    &handle,
                    &label,
                    tauri::WebviewUrl::App("popout.html".into()),
                )
                // Blank native title so the Hyprland scratchpad rule
                // (`title = "^Envy$"`) does not swallow pop-outs. No OS
                // chrome: Omarchy windows are dragged with Super, closed
                // with Super+W or Escape.
                // The note's title, so the window reads in the bar and so
                // Hyprland can be asked to float it; it never equals "Envy",
                // which is what the main window's rule matches.
                .title(&title)
                .inner_size(width, height)
                .position(140.0 + step, 120.0 + step)
                .min_inner_size(240.0, 160.0)
                .resizable(true)
                .decorations(false)
                .minimizable(false)
                .maximizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .transparent(cfg!(not(windows)))
                .build();
                match built {
                    Ok(window) => {
                        hyprland::float_when_mapped(&window, config::popout_floating, None);
                        // Remember where the user drags the edges to, so the
                        // next pop-out this session opens the same size even
                        // when the caller passes none. Logical units, the same
                        // the builder takes.
                        let scale = window.scale_factor().unwrap_or(1.0);
                        window.on_window_event(move |event| {
                            if let tauri::WindowEvent::Resized(size) = event {
                                let logical: tauri::LogicalSize<f64> = size.to_logical(scale);
                                *LAST_POPOUT_SIZE.lock().unwrap() =
                                    Some((logical.width, logical.height));
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("could not open pop-out window: {e}");
                        if let Some(s) = handle.try_state::<AppState>() {
                            s.popouts.lock().unwrap().remove(&label);
                        }
                    }
                }
            });
        }
    }
}

/// The note id the calling pop-out window is showing.
#[tauri::command]
fn popout_note_id(window: tauri::WebviewWindow, state: State<AppState>) -> Option<String> {
    state.popouts.lock().unwrap().get(window.label()).cloned()
}

/// Whether the app launches at login.
#[tauri::command]
fn autostart_enabled(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
    // The config is the source of truth for the login item, so the write comes
    // first and the XDG entry follows it — the same order an edit to the file
    // takes through `apply_config_owned`.
    config::set_owned(&app, "system", "autostart", serde_json::Value::Bool(enabled));
    write_autostart(&app, enabled)
}

/// Makes the XDG autostart entry match the config, on launch and on every
/// change to the file. Only touched when it disagrees: the plugin rewrites the
/// entry on `enable`, and doing that every launch is churn for nothing. The
/// path is baked into the entry, so an entry pointing at a binary that no
/// longer exists (a rename, a moved checkout) counts as disagreeing, and so
/// does one pointing at a less permanent build than this one: a package
/// install takes over from a checkout's release build, which takes over from
/// a debug build. The other way round is left alone, so running a dev build
/// or the smoke test does not steal the entry from the real install.
fn apply_autostart(app: &tauri::AppHandle) {
    let wanted = config::autostart();
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    if enabled != wanted || (wanted && autostart_should_move_here()) {
        let _ = write_autostart(app, wanted);
    }
}

/// How permanent a binary's home is: a package (0), a checkout's release
/// build (1), anything else such as a debug build (2).
fn binary_rank(path: &str) -> u8 {
    if path.starts_with("/usr/") {
        0
    } else if path.contains("/target/release/") {
        1
    } else {
        2
    }
}

#[cfg(test)]
mod autostart_rank_tests {
    use super::binary_rank;

    #[test]
    fn package_outranks_release_outranks_debug() {
        assert!(binary_rank("/usr/bin/envynote") < binary_rank("/home/u/w/target/release/envynote"));
        assert!(binary_rank("/home/u/w/target/release/envynote") < binary_rank("/home/u/w/target/debug/envynote"));
        assert_eq!(binary_rank("/tmp/envynote"), binary_rank("/home/u/w/target/debug/envynote"));
    }
}

/// Whether the XDG autostart entry should be rewritten to point at this
/// binary: its `Exec=` target is gone, or ranks below this one.
fn autostart_should_move_here() -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let exe = exe.to_string_lossy();
    // The same place the autostart plugin writes: ~/.config, whatever
    // XDG_CONFIG_HOME says, so the two never disagree about which file.
    let Some(home) = dirs::home_dir() else { return false };
    let Ok(entry) = std::fs::read_to_string(home.join(".config/autostart/Envy.desktop")) else {
        return false;
    };
    let Some(target) = entry.lines().find_map(|l| l.strip_prefix("Exec=")) else { return false };
    // The plugin writes `Exec=<path> <args>`; the path is the first word.
    let target = target.trim().split(' ').next().unwrap_or("").to_string();
    if target == exe {
        return false;
    }
    !std::path::Path::new(&target).exists() || binary_rank(&exe) < binary_rank(&target)
}

fn write_autostart(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

// MARK: - Kindle import

/// What an import did — the two numbers the Settings status line shows.
#[derive(Serialize)]
pub struct KindleImportSummary {
    imported: usize,
    #[serde(rename = "alreadyImported")]
    already_imported: usize,
}

#[derive(Serialize, Clone)]
struct KindleProgress {
    done: usize,
    total: usize,
}

/// The plugged-in Kindle's `My Clippings.txt`: a path when the Kindle mounts
/// as a drive (see `envy_core::kindle::detection_roots` for where Linux is
/// searched), else an `mtp://` URI when the desktop's GIO layer can read it
/// off an MTP Kindle (see `kindle_mtp`).
#[tauri::command(async)]
fn detect_kindle_clippings() -> Option<String> {
    envy_core::kindle::detect_clippings_file()
        .map(|p| p.to_string_lossy().into_owned())
        .or_else(kindle_mtp::detect)
}

/// Imports highlights from `path` — or from the detected Kindle when `None` —
/// into `Inbox/` as fleeting notes, one per record not already in the vault's
/// ledger. Emits `kindle-progress` `{ done, total }` after each note is
/// written. Async so a large first import stays off the main thread.
///
/// `title_reference` is the setting's raw value (`page`, `location`, `both`,
/// `none`); the two booleans are the *include* sense, the inverse of the
/// stored `kindleBodyOmit…` flags.
#[tauri::command]
async fn import_kindle_clippings(
    path: Option<String>,
    title_reference: String,
    include_author: bool,
    include_location: bool,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<KindleImportSummary, String> {
    use envy_core::kindle;

    let source = match path {
        Some(p) => p,
        None => detect_kindle_clippings().ok_or_else(|| {
            "No Kindle detected: plug it in and refresh, or choose the file by hand.".to_string()
        })?,
    };
    // A Clippings file is plain text, a few megabytes at most, and reading one
    // holds it in memory twice (the bytes, then the lossy String) — so a wrong
    // pick (a disk image, a video) is refused rather than swallowed.
    const MAX_CLIPPINGS_BYTES: u64 = 64 * 1024 * 1024;
    let bytes = if kindle_mtp::is_uri(&source) {
        kindle_mtp::read(&source, MAX_CLIPPINGS_BYTES as usize)?
    } else {
        let file = PathBuf::from(&source);
        let size = std::fs::metadata(&file)
            .map_err(|e| format!("Couldn't read the Clippings file: {e}"))?
            .len();
        if size > MAX_CLIPPINGS_BYTES {
            return Err("That file is over 64 MB — it isn't a Kindle Clippings file.".to_string());
        }
        std::fs::read(&file).map_err(|e| format!("Couldn't read the Clippings file: {e}"))?
    };
    let raw = String::from_utf8_lossy(&bytes).into_owned();

    let index = state.store.lock().unwrap().directory().to_path_buf();
    let options = kindle::ImportOptions {
        title_reference: kindle::TitleReference::from_setting(&title_reference),
        include_author,
        include_location,
    };

    // Our own writes, so the watcher's rescan is redundant — though a long
    // import outlasts the suppression window, and a stray rescan mid-way is
    // harmless (the frontend just re-runs its query).
    state.mark_internal_write();
    let summary = kindle::import_clippings(&raw, &index, options, |done, total| {
        let _ = app.emit("kindle-progress", KindleProgress { done, total });
    });
    state.mark_internal_write();
    // Surface the new notes now rather than waiting on the watcher, so the
    // list and the Inbox badge are current the moment the status line says
    // "Imported".
    state.store.lock().unwrap().reload();
    let _ = app.emit("index-changed", ());
    Ok(KindleImportSummary {
        imported: summary.imported,
        already_imported: summary.already_imported,
    })
}

/// Wipes the vault's Kindle ledger so the next import re-offers every
/// highlight. Notes already in the vault aren't touched.
#[tauri::command]
fn forget_kindle_history(state: State<AppState>) -> Result<(), String> {
    let index = state.store.lock().unwrap().directory().to_path_buf();
    envy_core::kindle::ledger::clear(&index);
    let ledger = envy_core::kindle::ledger::path(&index);
    if ledger.exists() {
        return Err(format!("Couldn't remove {}", ledger.display()));
    }
    Ok(())
}

/// Refuses any navigation away from the app's own pages.
///
/// A note holds arbitrary text — a pasted URL, an `<a href>` that survives
/// into the editor — and a webview that follows one keeps the IPC bridge: the
/// remote page would be able to call every `#[tauri::command]` in this file,
/// including the ones that read and write files. External links are handed to
/// the system browser through the opener plugin instead, so nothing
/// legitimate navigates anywhere.
///
/// Registered as a plugin rather than per-window, because the main window is
/// declared in `tauri.conf.json` and never passes through a builder here. The
/// plugin hook runs for every webview the app creates, so the pinned popover
/// and each pop-out are covered by the same rule.
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("envy-navigation-guard")
        .on_navigation(|_webview, url| navigation_allowed(url))
        .build()
}

/// The whole of the rule above, as a plain function of the URL.
///
/// Lifted out of the closure so it can be tested without a webview: the cost
/// of getting this wrong is every `#[tauri::command]` in this file reachable
/// from a remote page, and a rule that can only be exercised by launching the
/// app is a rule nobody exercises. `tauri::Url` is the `url` crate's type.
fn navigation_allowed(url: &tauri::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    match url.scheme() {
        // The bundled frontend: `tauri://localhost` on Linux, the
        // `tauri.localhost` custom-protocol host elsewhere.
        "tauri" => host == "localhost",
        "http" | "https" => {
            host == "tauri.localhost"
                // `npm run tauri dev` serves from Vite — devUrl in
                // tauri.conf.json.
                || (cfg!(debug_assertions) && host == "localhost" && url.port() == Some(1420))
        }
        // WebKitGTK loads a blank page before the real one.
        "about" => url.path() == "blank",
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(navigation_guard())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init());
    // Checks the endpoint in tauri.conf.json and verifies whatever it finds
    // against the public key compiled in beside it. That key is why this has
    // to exist before the first release rather than after: an install that
    // shipped without it has nothing to verify an update with, so it can
    // never update itself — only a manual reinstall fixes it.
    //
    // Do not register tauri-plugin-updater until `plugins.updater` (pubkey +
    // endpoints) is in tauri.conf.json. The plugin panics at launch if that
    // object is missing. Check for Updates still runs; without the plugin it
    // reports that updates are not set up yet.

    builder
        // The window comes back the size and place it was left. macOS gives a
        // WindowGroup this for free through AppKit's state restoration, which is
        // why the Mac has no code for it; Windows has no equivalent, so without
        // this every launch snapped back to the 800x600 in tauri.conf.json.
        //
        // Size, position and maximised only. Deliberately not VISIBLE: this
        // window is hidden rather than closed — by the tray, the summon hotkey
        // and hide-on-focus-loss — so restoring that would mean quitting while
        // hidden opens the app to nothing at all next time, with only the tray
        // to explain where it went.
        //
        // The pinned popover is excluded because its position is not the user's
        // to keep: it is placed against the tray each time it opens, and a
        // remembered position would drag it away from the icon it belongs to.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .with_denylist(&[PINNED_WINDOW])
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // Before anything reads a setting: create ~/.config/envy if it is
            // missing and fold the two files Rust used to keep its own state
            // in (`index-path`, `keep-on-top`) into the config.
            config::init(
                index_path_file(app.handle()),
                keep_on_top_file(app.handle()),
            );
            // The skill teaches agents how to edit that file; linking it is
            // best-effort and never overwrites what the user has there.
            config::install_skill();

            // The Index the user last chose, or the default on a fresh install.
            // A saved path can go unreachable — a folder on a drive that isn't
            // plugged in — so a failure to open it falls back to the default
            // rather than refusing to start. The default itself is created on
            // demand by `open`, so it can't fail the same way.
            let mut dir = persisted_index_directory(app.handle());
            let store = match NoteStore::open(&dir, false) {
                Ok(store) => store,
                Err(_) => {
                    dir = default_index_directory();
                    save_index_directory(app.handle(), &dir);
                    NoteStore::open(&dir, false)?
                }
            };
            // A brand-new Index gets a welcome note, so the first launch isn't
            // an empty window with no hint of what to type. Writing it is the
            // only thing here that changes what a scan would find, so it is
            // also the only thing that costs a second read of the folder —
            // opening the store twice unconditionally meant every launch paid
            // the whole scan twice.
            let mut store = store;
            if store.notes().is_empty() {
                let welcome = dir.join("Welcome to Envy.md");
                if !welcome.exists() {
                    std::fs::write(&welcome, WELCOME_NOTE)?;
                    store.reload();
                }
            }
            seed_sample_templates_if_needed(app.handle(), &dir);

            // No launch update check on Linux: releases come through pacman,
            // and `run_update_check` only ever runs from Check Now or the tray.

            let suppress_until = Arc::new(Mutex::new(Instant::now()));

            let handle = app.handle().clone();
            let suppress = Arc::clone(&suppress_until);
            // The store's own (canonicalized) directory, not `dir`: the paths
            // the watcher reports are built from whatever path it was handed,
            // and `reload_paths` matches them against note urls.
            let watched = store.directory().to_path_buf();
            let watcher = envy_core::watch_path(watched, move |paths| {
                // Envy's own writes trip the watcher too. Skipping them avoids
                // a redundant rescan and, more importantly, avoids reloading
                // over text still being typed.
                if Instant::now() < *suppress.lock().unwrap() {
                    return;
                }
                let Some(state) = handle.try_state::<AppState>() else {
                    return;
                };
                state.store.lock().unwrap().reload_paths(paths);
                // The frontend re-runs its query rather than being handed
                // results, so a reload can't clobber whatever the user has
                // since typed into the search box.
                let _ = handle.emit("index-changed", ());
            })
            .ok();

            app.manage(AppState {
                store: Mutex::new(store),
                pinned_note: Mutex::new(None),
                suppress_until,
                _watcher: Mutex::new(watcher),
                global_shortcuts: Mutex::new(std::collections::HashMap::new()),
                template_date_format: Mutex::new("yyyy-MM-dd".to_string()),
                popouts: Mutex::new(std::collections::HashMap::new()),
            });

            setup_global_hotkey(app.handle())?;
            // Seeded from `[shortcuts]` so a chord set in the config works
            // from the moment the app is up. The frontend calls
            // `set_global_shortcuts` again once it has read its own settings,
            // which lands on the same four bindings.
            register_global_shortcuts(app.handle(), config::global_shortcuts());
            tray::setup(app.handle())?;
            #[cfg(target_os = "linux")]
            control::serve(app.handle());
            // Re-assert the remembered on-top state now the window exists.
            apply_keep_on_top(app.handle(), persisted_keep_on_top(app.handle()));
            apply_autostart(app.handle());
            omarchy::spawn_watcher(app.handle().clone());
            // Edits to config.md and themes/ made anywhere else land as
            // `config-changed` / `themes-changed`.
            config::spawn_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            index_directory,
            search,
            search_ids,
            read_note,
            resolve_title,
            save_note,
            create_note,
            extract_to_note,
            list_subfolders,
            move_note_to_subfolder,
            create_note_in_subfolder,
            folder_catalog,
            tag_catalog,
            rename_folder,
            rename_tag,
            open_external_url,
            open_link,
            rename_note,
            delete_note,
            delete_notes,
            restore_last_deleted,
            can_restore,
            trashed_notes,
            restore_from_trash,
            delete_from_trash,
            empty_trash,
            save_attachment,
            copy_attachment,
            read_attachment,
            open_attachment,
            rename_attachment,
            reveal_attachment,
            list_image_attachments,
            check_for_updates,
            remember_pinned_window,
            reveal_folder,
            set_index_directory,
            set_template_date_format,
            interlinks,
            list_templates,
            create_note_from_template,
            read_template,
            save_template,
            create_inbox_note,
            inbox_count,
            set_inbox_enabled,
            vault_counts,
            keep_on_top,
            all_tags,
            all_titles,
            submit_from_inbox,
            set_include_subfolders,
            reveal_index,
            font_families,
            reveal_note,
            convert_to_template,
            autostart_enabled,
            set_autostart,
            set_global_shortcuts,
            pinned_note_id,
            set_pinned_note,
            open_in_main_window,
            pop_out_note,
            popout_note_id,
            reload,
            detect_kindle_clippings,
            import_kindle_clippings,
            forget_kindle_history,
            omarchy::omarchy_appearance,
            config::config_load,
            config::config_set,
            config::config_read_text,
            hyprland::main_window_fullscreen,
            config::config_write_text,
            config::envy_paths,
            config::themes_list,
            config::theme_read_text,
            config::theme_write_text,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Main and pinned hide to the tray; pop-outs are real windows
                // and should close. Without this, the last hide also quits.
                if window.label() == "main" || window.label() == PINNED_WINDOW {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // None: last window hid. Some: tray Quit / app.exit(code).
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

/// The starter templates seeded into Templates/ on first launch, transcribed
/// from the Mac's `TemplateContent.samples`.
///
/// The Daily Notes template carries `{{date}}` in its *name*, not just its
/// body, so a note made from it is titled "Daily Notes July 11, 2026" straight
/// away rather than leaving a "Daily Notes" to rename by hand every day.
/// `create_from_template` already substitutes the placeholders in both.
const SAMPLE_TEMPLATES: [(&str, &str); 3] = [
    (
        "Daily Notes {{date}}",
        "# {{date}}\n\n## Top Priorities\n-\n\n## Notes\n\n\n## Follow Up\n-",
    ),
    ("To-Do List", "# {{title}}\n\n- [ ]\n- [ ]\n- [ ]"),
    (
        "Study Notes",
        "# {{title}}\n\n## Key Concepts\n\n\n## Questions\n\n\n## Summary\n",
    ),
];

/// Writes the starter templates once, on the first launch that ever runs.
///
/// Gated on a marker file rather than on the Templates folder being empty,
/// which matters: emptiness would put the samples back every time someone
/// deleted them, and deleting a template you did not ask for should stick. The
/// Mac gates on a `hasSeededSampleTemplates` flag for the same reason.
///
/// The marker is written *before* the templates, as the Mac sets its flag
/// before writing too — if a write fails, one missing template is a far better
/// outcome than trying again on every launch forever.
fn seed_sample_templates_if_needed(app: &tauri::AppHandle, dir: &Path) {
    let Ok(config) = app.path().app_config_dir() else {
        return;
    };
    let marker = config.join("seeded-templates");
    if marker.exists() {
        return;
    }
    if std::fs::create_dir_all(&config).is_err() || std::fs::write(&marker, "").is_err() {
        return;
    }
    let templates = dir.join("Templates");
    if std::fs::create_dir_all(&templates).is_err() {
        return;
    }
    for (name, body) in SAMPLE_TEMPLATES {
        let path = templates.join(format!("{name}.md"));
        // Never overwrite: a file already under this name is the user's.
        if !path.exists() {
            let _ = std::fs::write(&path, body);
        }
    }
}

/// The note a brand-new Index starts with: a guide to the whole app, kept as
/// its own Markdown file so it can be read and edited as one, and shipped
/// beside the binary as documentation (`/usr/share/doc/envy`).
const WELCOME_NOTE: &str = include_str!("../welcome.md");


#[cfg(test)]
mod tests {
    use super::navigation_allowed;

    fn allows(raw: &str) -> bool {
        navigation_allowed(&tauri::Url::parse(raw).expect("a parsable URL"))
    }

    /// The app's own pages, and the blank page WebKitGTK loads before them.
    #[test]
    fn the_apps_own_pages_are_allowed() {
        assert!(allows("tauri://localhost/"));
        assert!(allows("tauri://localhost/index.html"));
        assert!(allows("http://tauri.localhost/index.html"));
        assert!(allows("https://tauri.localhost/popout.html"));
        assert!(allows("about:blank"));
    }

    /// A navigation that lands on a remote page keeps the IPC bridge, so the
    /// page could call every command in this file. Nothing off-app may pass.
    #[test]
    fn everything_else_is_denied() {
        assert!(!allows("https://example.com/"));
        // `https:evil.com` is a valid special-scheme URL: it parses with
        // evil.com as the *host*, not the path. A rule written against the
        // string rather than the parsed host would wave it through.
        assert!(!allows("https:evil.com"));
        assert!(!allows("file:///etc/passwd"));
        assert!(!allows("javascript:alert(1)"));
        assert!(!allows("data:text/html,<script>alert(1)</script>"));
        assert!(!allows("tauri://evil.localhost/"));
        assert!(!allows("http://tauri.localhost.evil.com/"));
        assert!(!allows("about:srcdoc"));
    }

    /// The Vite dev server is reachable in a dev build and nowhere else — a
    /// shipped binary must not follow a plain `http://localhost` anywhere.
    /// Written as an equality so it is the correct assertion in both profiles.
    #[test]
    fn the_dev_server_is_debug_only() {
        assert_eq!(allows("http://localhost:1420/"), cfg!(debug_assertions));
        // Never any other port, even in a dev build.
        assert!(!allows("http://localhost:8080/"));
        assert!(!allows("http://localhost/"));
    }

    /// Every command that takes a raw `path: String` from the frontend is on
    /// this list, because each one needs its own containment check before it
    /// touches the filesystem. A new command with a `path` argument fails this
    /// test until somebody has looked at it and added it here deliberately.
    const PATH_TAKING_COMMANDS: [&str; 6] = [
        "read_template",
        "save_template",
        "copy_attachment",
        "import_kindle_clippings",
        "set_index_directory",
        // Found by this test rather than remembered: its path is checked by
        // having to match one `store.templates()` actually enumerated, so it
        // can only ever name a file the store already knows about.
        "create_note_from_template",
    ];

    /// The command names inside `tauri::generate_handler![...]`, one per entry,
    /// with any `module::` qualifier and trailing comma stripped.
    fn registered_commands(source: &str) -> Vec<String> {
        let start = source
            .find("generate_handler![")
            .expect("the invoke handler list");
        let body = &source[start + "generate_handler![".len()..];
        let end = body.find(']').expect("the end of the handler list");
        body[..end]
            .split(',')
            .map(|raw| raw.trim())
            .filter(|raw| !raw.is_empty() && !raw.starts_with("//"))
            .map(|raw| raw.rsplit("::").next().unwrap_or(raw).trim().to_string())
            .collect()
    }

    /// The `#[tauri::command]` functions in this file that declare a
    /// `path: String` parameter, by name.
    fn commands_taking_a_path(source: &str) -> Vec<String> {
        // Kept deliberately dumb: one regex over the whole file, matching a
        // command attribute (with or without `(async)`), then the `fn name`,
        // then that function's parameter list up to the first `)`. Robust to
        // the argument list being wrapped across lines, which several are.
        let re = regex::Regex::new(
            r"#\[tauri::command(?:\([^)]*\))?\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)",
        )
        .expect("a valid pattern");
        re.captures_iter(source)
            .filter(|c| {
                // The parameter named exactly `path` — `old_path`/`new_path`
                // on rename_folder are sanitized folder names, not the raw
                // filesystem paths this list is about.
                c.get(2)
                    .map(|args| {
                        args.as_str()
                            .split(',')
                            .any(|a| a.split_whitespace().collect::<Vec<_>>().join(" ")
                                == "path: String")
                    })
                    .unwrap_or(false)
            })
            .map(|c| c[1].to_string())
            .collect()
    }

    #[test]
    fn only_reviewed_commands_accept_a_raw_path() {
        let source = include_str!("lib.rs");
        let registered = registered_commands(source);
        assert!(registered.len() > 40, "the handler list did not parse: {registered:?}");

        for name in commands_taking_a_path(source) {
            if !registered.contains(&name) {
                continue; // not reachable from the frontend at all
            }
            assert!(
                PATH_TAKING_COMMANDS.contains(&name.as_str()),
                "command `{name}` takes a raw `path: String` from the frontend but is not \
                 on the reviewed allowlist in this test. Give it a containment check \
                 against the Index, then add it to PATH_TAKING_COMMANDS."
            );
        }
    }
}
