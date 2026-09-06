//! Port of `NoteStore.swift`'s folder scan and CRUD.
//!
//! The Index is one folder. Singular by design: Envy used to support several
//! folders merged into one list, but that flexibility mostly bought confusion
//! (which folder does a new note land in, what does "move to folder" mean,
//! does a search span all of them) for a feature almost nobody used across
//! more than one.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use fancy_regex::Regex;
use rayon::prelude::*;

use crate::filename::{
    available_attachment_name, sanitize_attachment_name, sanitize_title, unique_filename,
};
use crate::interlinks::{interlinks_with, Interlinks, TitleMatcher};
use crate::note::Note;
use crate::search::INBOX_FOLDER_NAME;

pub const TEMPLATES_FOLDER_NAME: &str = "Templates";

/// The vault's single image store: one visible `Attachments/` folder at the
/// Index root, holding every pasted or dropped image. Deliberately not
/// dot-hidden — cloud-sync clients routinely skip dot-folders, which would
/// strand the images away from the notes that reference them. Because it's
/// visible it has to be excluded from the note scan and the folder list by
/// name. Mirrors the Mac's `NoteStore.attachmentsFolderName`.
pub const ATTACHMENTS_FOLDER_NAME: &str = "Attachments";

/// A folder's own `.trash` subfolder is where `delete` sends notes first,
/// ahead of the real Recycle Bin — not one `Trash/` at the Index's top level,
/// but one hidden `.trash` sibling per folder a note actually lives in. That's
/// what makes restore trivial: a trashed note's parent folder always *is* the
/// folder it came from, so no "original location" bookkeeping is needed and it
/// survives app restarts for free. Being dot-prefixed also means it's never
/// scanned, and it can never collide with a real folder the user named
/// "Trash".
pub const TRASH_FOLDER_NAME: &str = ".trash";

/// The Mac's trash: one visible `Trash/` at the Index root (1.8.3 made it
/// visible so sync clients carry it). Linux keeps the per-folder `.trash`
/// layout above and does not read or write this folder — but an Index synced
/// from a Mac will have one, and its contents are deleted notes, not live
/// ones. So it is excluded from the note scan and the folder list by name
/// like the other service folders, and is reserved as a folder name.
pub const MAC_TRASH_FOLDER_NAME: &str = "Trash";

/// A visible service folder at the Index root for Envy's vault-bound derived
/// state — data that belongs to *this* collection of notes and travels with
/// it across machines (the Kindle import ledger today). Visible, not a
/// dot-folder, for the same sync reason as `Attachments/`. Not notes, so the
/// scan and the folder list exclude it by name. Mirrors the Mac's
/// `NoteStore.dataFolderName`.
pub const DATA_FOLDER_NAME: &str = "Envy Data";

/// The root-level folders that are Envy's own rather than the user's: never
/// scanned for notes, never listed as a folder, never a rename target.
const SERVICE_FOLDER_NAMES: [&str; 4] = [
    TEMPLATES_FOLDER_NAME,
    ATTACHMENTS_FOLDER_NAME,
    MAC_TRASH_FOLDER_NAME,
    DATA_FOLDER_NAME,
];

/// A template is a plain `.md` file in the Index's `Templates/` subfolder —
/// never a `Note`. The scan skips descending into `Templates/` even when
/// subfolders are included, so templates are never visible to
/// search/list/backlinks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteTemplate {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

/// What applying one watched path did to the note list — the difference
/// between "a note's text moved" and "a note appeared or disappeared", which
/// is what decides whether the title-derived caches survive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathChange {
    None,
    Content,
    Set,
}

pub struct NoteStore {
    directory: PathBuf,
    include_subfolders: bool,
    notes: Vec<Note>,
    trashed: Vec<Note>,
    /// The most recently deleted note(s). A single delete or a whole bulk
    /// delete counts as one action for undo, so this holds everything from the
    /// last `delete` call together — not a full history stack. Replaced (not
    /// appended to) by the next delete, and cleared once restored.
    last_deleted: Vec<(Note, PathBuf)>,
    /// The folder list, which is a recursive `read_dir` of the whole Index —
    /// 7.7 ms at 30,000 notes, paid by the footer's vault counts, the folder
    /// catalog, and every folder picker. The folders only change when Envy or
    /// the watcher says they did, so it is computed on first ask and dropped
    /// by `invalidate_caches`.
    folders: OnceLock<Vec<String>>,
    /// The suggested-links automaton over every title; see
    /// [`crate::interlinks::TitleMatcher`]. Cached and invalidated alongside
    /// the folder list.
    title_matcher: OnceLock<TitleMatcher>,
}

impl NoteStore {
    pub fn open(directory: impl Into<PathBuf>, include_subfolders: bool) -> std::io::Result<Self> {
        let mut store = Self::open_unscanned(directory, include_subfolders)?;
        store.reload();
        Ok(store)
    }

    /// Opens the Index folder without reading notes. The window can come up
    /// while a background `reload` / `open` walks the files.
    pub fn open_unscanned(
        directory: impl Into<PathBuf>,
        include_subfolders: bool,
    ) -> std::io::Result<Self> {
        let directory = directory.into();
        fs::create_dir_all(&directory)?;
        // Resolved once, so every note's id/path and any future watch agree on
        // one path form.
        let directory = dunce::canonicalize(&directory).unwrap_or(directory);
        Ok(Self {
            directory,
            include_subfolders,
            notes: Vec::new(),
            trashed: Vec::new(),
            last_deleted: Vec::new(),
            folders: OnceLock::new(),
            title_matcher: OnceLock::new(),
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Whether writing to `target` stays inside the Index. Checked before every
    /// rename/write/delete this store performs on a note- or folder-derived
    /// path — see `writes_inside`.
    fn contains(&self, target: &Path) -> bool {
        writes_inside(target, &self.directory)
    }

    /// The io-returning twin of `contains`, for the callers that report a
    /// refusal as an error rather than a `None`.
    fn guard_write(&self, target: &Path) -> std::io::Result<()> {
        if self.contains(target) {
            return Ok(());
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "that path is outside the Index",
        ))
    }

    pub fn notes(&self) -> &[Note] {
        &self.notes
    }

    pub fn trashed_notes(&self) -> &[Note] {
        &self.trashed
    }

    pub fn can_restore_last_deleted(&self) -> bool {
        !self.last_deleted.is_empty()
    }

    pub fn set_include_subfolders(&mut self, include: bool) {
        if include == self.include_subfolders {
            return;
        }
        self.include_subfolders = include;
        self.reload();
    }

    /// Re-reads the Index, reusing every note whose file is untouched.
    ///
    /// A reload fires on any settled change under the folder — an external
    /// edit, a `git pull`, a sync client landing one file. Re-reading all N
    /// files each time (while holding the store lock, so search and every other
    /// command block behind it) made a one-note change cost the whole vault.
    /// Instead we diff the on-disk paths and modification times against the
    /// notes we already hold: unchanged notes move across as-is, keeping their
    /// populated derived caches, and only new or actually-changed files are
    /// read from disk. The first load has no previous notes, so it reads
    /// everything exactly as before.
    pub fn reload(&mut self) {
        let previous = std::mem::take(&mut self.notes);
        self.notes = scan_directory_reusing(&self.directory, self.include_subfolders, previous);
        self.invalidate_caches();
        self.refresh_trashed();
    }

    /// Applies one settled watcher batch by touching only the files it names.
    ///
    /// `reload` is already incremental about *reading* — it re-reads only the
    /// files whose mtime moved — but it still walks the whole tree, rebuilds
    /// the path map, re-sorts every note and re-walks every `.trash` folder.
    /// At 30,000 notes that is 66 ms for a one-character edit in one file,
    /// with the store lock held the whole time, so search and the note list
    /// block behind it.
    ///
    /// This does the same job for the far more common shape of change: a short
    /// list of `.md` files, each of which is stat-ed and read (or dropped) on
    /// its own. Anything that could have changed the *shape* of the Index —
    /// a directory created, removed or renamed, a path from outside it, an
    /// empty list, or a batch big enough that a full rescan is cheaper anyway
    /// — falls back to `reload`, which is always correct.
    pub fn reload_paths(&mut self, paths: &[PathBuf]) {
        /// Past this many files in one settled burst — a sync client landing a
        /// folder, a `git pull` — one tree walk beats N stats plus a re-sort
        /// per file.
        const MAX_INCREMENTAL: usize = 200;

        if paths.is_empty() || paths.len() > MAX_INCREMENTAL {
            return self.reload();
        }
        // Deleting a note leaves a file under `.trash`; nothing else the
        // watcher reports touches the trash list, so it is re-walked only when
        // one of these paths is actually in there.
        let mut touches_trash = false;
        let mut changed = false;
        let mut set_changed = false;
        for path in paths {
            if path.components().any(|c| c.as_os_str() == TRASH_FOLDER_NAME) {
                touches_trash = true;
                continue;
            }
            if !is_markdown(path) || !path.starts_with(&self.directory) {
                // A directory event (no extension) means notes may have
                // arrived or left en masse, and a path outside the Index means
                // our idea of where the vault is disagrees with the watcher's.
                return self.reload();
            }
            match self.apply_one_path(path) {
                Ok(change) => {
                    changed |= change != PathChange::None;
                    set_changed |= change == PathChange::Set;
                }
                // The path is a directory now, or unreadable in a way a stat
                // can't explain — neither is something to guess at.
                Err(()) => return self.reload(),
            }
        }
        if changed {
            // Newest first, the order every caller of `notes()` relies on.
            self.notes.sort_by_key(|n| std::cmp::Reverse(n.modified));
        }
        if set_changed {
            // Only the title automaton: a `.md` event cannot have changed the
            // folder list (a folder event takes the full-reload path above),
            // and an in-place edit cannot have changed a title, which is the
            // file's own name.
            self.title_matcher = OnceLock::new();
        }
        if touches_trash {
            self.refresh_trashed();
        }
    }

    /// Re-reads, inserts or drops the single note at `path`. `Err(())` when
    /// the caller should fall back to a full reload.
    fn apply_one_path(&mut self, path: &Path) -> Result<PathChange, ()> {
        let existing = self.notes.iter().position(|n| n.url() == path);
        let metadata = match fs::metadata(path) {
            Ok(m) if m.is_file() => m,
            // A file that isn't there any more: the note goes with it. That
            // covers a delete and the "from" half of a rename alike.
            Err(_) => {
                return Ok(match existing {
                    Some(i) => {
                        self.notes.remove(i);
                        PathChange::Set
                    }
                    None => PathChange::None,
                })
            }
            Ok(_) => return Err(()),
        };
        // The scan's own rules decide whether this file is a note at all —
        // a `.md` under `Templates/`, or in a subfolder with subfolder
        // scanning off, is not one.
        if !self.scan_would_include(path) {
            return Ok(match existing {
                Some(i) => {
                    self.notes.remove(i);
                    PathChange::Set
                }
                None => PathChange::None,
            });
        }
        let modified = metadata.modified().unwrap_or_else(|_| SystemTime::now());
        if let Some(i) = existing {
            if self.notes[i].modified == modified {
                return Ok(PathChange::None);
            }
        }
        let Ok(content) = fs::read_to_string(path) else {
            // Readable a moment ago, not now — a sync client mid-write. Leave
            // the note we hold rather than dropping it.
            return Ok(PathChange::None);
        };
        let note = Note::new(path.to_path_buf(), content, modified);
        Ok(match existing {
            Some(i) => {
                self.notes[i] = note;
                PathChange::Content
            }
            None => {
                self.notes.push(note);
                PathChange::Set
            }
        })
    }

    /// Whether a full scan of the Index would have picked this file up — the
    /// same exclusions `note_paths` applies, asked one path at a time.
    fn scan_would_include(&self, path: &Path) -> bool {
        let Ok(relative) = path.strip_prefix(&self.directory) else {
            return false;
        };
        let mut folders: Vec<&std::ffi::OsStr> =
            relative.components().map(|c| c.as_os_str()).collect();
        // The last component is the file itself, not a folder.
        folders.pop();
        // The scan skips hidden files and never descends into a hidden
        // folder — which is what keeps `.trash` out without naming it.
        if is_hidden(path) || folders.iter().any(|f| f.to_string_lossy().starts_with('.')) {
            return false;
        }
        if folders
            .first()
            .is_some_and(|f| SERVICE_FOLDER_NAMES.contains(&f.to_string_lossy().as_ref()))
        {
            return false;
        }
        // With subfolders off only the root and `Inbox/` are read; see
        // `note_paths` for why the Inbox is the exception.
        self.include_subfolders
            || folders.is_empty()
            || (folders.len() == 1 && folders[0] == INBOX_FOLDER_NAME)
    }

    /// Drops everything derived from the *set* of notes and folders. Called
    /// wherever a note or folder is created, renamed, moved or removed —
    /// never for a plain content edit, which can move neither.
    fn invalidate_caches(&mut self) {
        self.folders = OnceLock::new();
        self.title_matcher = OnceLock::new();
    }

    fn refresh_trashed(&mut self) {
        self.trashed = scan_trashed_notes(&self.directory);
    }

    // --- CRUD ---------------------------------------------------------------

    pub fn create(&mut self, title: &str) -> std::io::Result<Note> {
        self.create_in(title, self.directory.clone())
    }

    /// The folder this note sits in, relative to the Index root, or `None` for
    /// a note at the root.
    ///
    /// `Inbox/` also returns `None`: a fleeting note already has its own amber
    /// dot, and "unfiled" outranks a folder category, so it never wears a
    /// folder colour instead.
    pub fn subfolder_path(&self, note: &Note) -> Option<String> {
        subfolder_path(note, &self.directory)
    }

    /// Every folder under the Index that could hold notes, relative to the
    /// root, sorted.
    ///
    /// The service folders (`Templates/`, `Attachments/`, the Mac's `Trash/`,
    /// `Envy Data/`) and `Inbox/` are excluded along with everything beneath
    /// them — none is a place you file a note, and each already means
    /// something else. Hidden folders are skipped wholesale, which is what
    /// keeps `.trash` out without needing its own case.
    pub fn subfolders(&self) -> Vec<String> {
        self.folder_list().to_vec()
    }

    /// The cached folder list. See the `folders` field for why it is cached
    /// rather than walked on every ask.
    fn folder_list(&self) -> &[String] {
        self.folders
            .get_or_init(|| scan_subfolders(&self.directory))
    }

    /// The interlink footer for `note`, over the cached title automaton.
    pub fn interlinks(&self, note: &Note) -> Interlinks {
        let matcher = self.title_matcher.get_or_init(|| {
            let candidates: Vec<(&str, &str)> =
                self.notes.iter().map(|n| (n.id(), n.title())).collect();
            TitleMatcher::new(&candidates)
        });
        interlinks_with(note, &self.notes, matcher)
    }

    /// Moves a note into `subfolder` (relative to the Index root), or to the
    /// root when it is `None` or empty. Creates the destination on demand.
    ///
    /// The title is always unchanged — a move that would collide with a
    /// same-named note in the destination is **refused** (returns `None`)
    /// rather than silently de-duped to "Foo (2)", so `[[links]]` pointing at
    /// either note keep resolving to what they meant. Returns the note at its
    /// new location, or `None` if the move failed. A note already in that
    /// folder is returned untouched rather than treated as an error. Mirrors
    /// the Mac's `moveNote(_:toSubfolder:)` (1.8.1 "Safer moves").
    pub fn move_note(&mut self, id: &str, subfolder: Option<&str>) -> Option<Note> {
        self.move_note_inner(id, subfolder, false)
    }

    /// The move shared by `move_note` and `submit_from_inbox` — the Mac's
    /// `moveNote(_:toSubfolder:filingFromInbox:)`.
    fn move_note_inner(
        &mut self,
        id: &str,
        subfolder: Option<&str>,
        filing_from_inbox: bool,
    ) -> Option<Note> {
        let note = self.notes.iter().find(|n| n.id() == id)?.clone();
        // A `None`/empty subfolder means "move to the root"; a named one is
        // sanitized so a `../` can't move the note outside the vault (an
        // unusable path refuses the move rather than escaping).
        let trimmed = subfolder.unwrap_or("").trim_matches(['/', ' ']);
        let target_dir = if trimmed.is_empty() {
            self.directory.clone()
        } else {
            self.directory.join(sanitized_subfolder(trimmed)?)
        };
        if note.url().parent() == Some(target_dir.as_path()) {
            return Some(note);
        }

        // Both ends of the move have to resolve inside the Index: `target_dir`
        // is built from frontend text and `note.url()` can be stale, so neither
        // is taken on trust before a file is moved.
        if !self.contains(&target_dir) {
            return None;
        }
        fs::create_dir_all(&target_dir).ok()?;
        let destination = target_dir.join(unique_filename(note.title(), &target_dir));
        // `unique_filename` de-dups a collision to "Foo (2)" — but for a *move*
        // that's a silent title change with no single right answer: half the
        // vault's [[Foo]] links would start resolving to whichever Foo
        // remained. Refusing keeps every link intact; the note stays put.
        // Compared against the sanitized base, NOT the raw title — a title can
        // legally carry characters filenames rewrite to "-", and that
        // deterministic difference is not a collision (it used to be misread
        // as one, which made colon-titled notes refuse to move at all).
        //
        // A note filed from the Inbox is exempt: it has no incoming links yet,
        // so there's nothing to protect — it takes the "Foo (2)" name and files
        // rather than refusing.
        if !filing_from_inbox {
            let stem = destination.file_stem()?.to_string_lossy();
            if stem != sanitize_title(note.title()) {
                return None;
            }
        }
        if !self.contains(note.url()) || !self.contains(&destination) {
            return None;
        }
        fs::rename(note.url(), &destination).ok()?;

        let moved = Note::new(destination, note.content().to_string(), note.modified);
        if let Some(i) = self.notes.iter().position(|n| n.id() == id) {
            self.notes[i] = moved.clone();
        }
        self.invalidate_caches();
        // Sanitization can still change the title ("What?" → "What-"). That's
        // deterministic, not ambiguous — so rewrite the vault's references the
        // same way `rename` does, and links keep working. Skipped when filing
        // from the Inbox: the note has no incoming links, and a collision
        // rename to "Foo (2)" must not rewrite a same-named note's existing
        // [[Foo]] links to point at the newcomer.
        if !filing_from_inbox && moved.title() != note.title() {
            self.update_wiki_link_references(note.title(), moved.title());
        }
        Some(moved)
    }

    /// Every folder, paired with how many notes clicking it would show — the
    /// rows of the `folder:` browse catalog. Most-populated first, ties
    /// alphabetical.
    ///
    /// The count is exact-or-descendant, not direct membership: clicking a row
    /// runs `folder:"Name"`, which matches the folder *and everything nested
    /// inside it*, so `Projects` counts a note in `Projects/Work` too. That is
    /// the 1.8.8 rule that a row's count equals what clicking it shows — a note
    /// deliberately counts toward every folder that contains it.
    pub fn folder_counts(&self) -> Vec<(String, usize)> {
        let paths: Vec<String> = self.notes.iter().filter_map(|n| self.subfolder_path(n)).collect();
        let mut rows: Vec<(String, usize)> = self
            .folder_list()
            .iter()
            .map(|folder| {
                let descendant = format!("{folder}/");
                let count = paths
                    .iter()
                    .filter(|p| **p == *folder || p.starts_with(&descendant))
                    .count();
                (folder.clone(), count)
            })
            .collect();
        rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        rows
    }

    /// Every tag in the vault, paired with how many notes carry it — the rows of
    /// the `tag:` browse catalog. Most-used first, ties alphabetical.
    pub fn tag_counts(&self) -> Vec<(String, usize)> {
        use std::collections::HashMap;
        let mut counts: HashMap<String, usize> = HashMap::new();
        for note in &self.notes {
            for tag in note.tags() {
                *counts.entry(tag.clone()).or_default() += 1;
            }
        }
        let mut rows: Vec<(String, usize)> = counts.into_iter().collect();
        rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        rows
    }

    /// Renames a subfolder, carrying every note inside it (and every nested
    /// folder) along. Returns the folder's new relative path, or `None` if the
    /// rename was refused.
    ///
    /// The title of each note is untouched — only the folder it sits in changes
    /// — so `[[links]]` pointing at any of them still resolve, which is why this
    /// needs no link rewriting. Adding a `/` to the new path re-files the folder
    /// under another (`Work` → `Archive/Work`), since the path *is* the folder's
    /// place. Renaming onto an existing folder, or to (or from) a reserved name,
    /// is refused.
    pub fn rename_folder(&mut self, old_path: &str, new_path_raw: &str) -> Option<String> {
        // Each `/`-segment is sanitized the way a filename is (`:` → `-`) and
        // any `.`/`..` is rejected, so a typed path can't traverse out of the
        // vault; `/` itself stays the separator. The old path is guarded the
        // same way so neither side can point outside.
        let new_path = sanitized_subfolder(new_path_raw)?;
        sanitized_subfolder(old_path)?;
        if new_path == old_path {
            return None;
        }

        // Neither end may be a reserved folder — those are Envy's own, not the
        // user's to rename into or out of. Checked on the first segment, since
        // that is the one that would collide with a service folder at the root.
        let reserved = [
            TEMPLATES_FOLDER_NAME,
            INBOX_FOLDER_NAME,
            TRASH_FOLDER_NAME,
            MAC_TRASH_FOLDER_NAME,
            ATTACHMENTS_FOLDER_NAME,
            DATA_FOLDER_NAME,
        ];
        let first_segment = |p: &str| p.split('/').next().unwrap_or("").to_string();
        let new_first = first_segment(&new_path);
        let old_first = first_segment(old_path);
        if reserved.iter().any(|r| r.eq_ignore_ascii_case(&new_first))
            || reserved.iter().any(|r| r.eq_ignore_ascii_case(&old_first))
        {
            return None;
        }

        let old_url = self.directory.join(old_path);
        let new_url = self.directory.join(&new_path);
        // Belt-and-suspenders: both endpoints must resolve inside the vault.
        if !is_contained(&old_url, &self.directory) || !is_contained(&new_url, &self.directory) {
            return None;
        }
        if !old_url.is_dir() {
            return None;
        }
        // A rename that only changes case is the folder onto itself on a
        // case-insensitive filesystem, so the "already exists" guard must not
        // fire for it.
        let case_only = new_path.to_lowercase() == old_path.to_lowercase();
        if !case_only && new_url.exists() {
            return None;
        }

        // The lexical check above can't see a symlinked component; this one
        // resolves both ends for real before a whole folder is moved.
        if !self.contains(&old_url) || !self.contains(&new_url) {
            return None;
        }
        if let Some(parent) = new_url.parent() {
            fs::create_dir_all(parent).ok()?;
        }
        fs::rename(&old_url, &new_url).ok()?;

        // Re-home every note that lived under the old folder. Index-based so the
        // note can be read and replaced without overlapping borrows.
        for i in 0..self.notes.len() {
            let Ok(rel) = self.notes[i].url().strip_prefix(&old_url) else {
                continue;
            };
            let moved_url = new_url.join(rel);
            let content = self.notes[i].content().to_string();
            let modified = self.notes[i].modified;
            self.notes[i] = Note::new(moved_url, content, modified);
        }
        self.invalidate_caches();
        Some(new_path)
    }

    /// Renames a tag across every note that carries it, rewriting the `#tag`
    /// text in each file. Merges when the new name already exists — the notes
    /// simply come to carry the surviving tag, and a note that had both ends up
    /// with one.
    ///
    /// The match is the same word-boundary rule the styler and search use, so
    /// `#work` is renamed without touching `#workshop` or a `#` mid-word, and
    /// the file's modified time is preserved so a rename doesn't jump thirty
    /// notes to the top of a date sort.
    pub fn rename_tag(&mut self, old_name: &str, new_name: &str) {
        let old = old_name.to_lowercase();
        let new = sanitize_tag_name(new_name);
        if new.is_empty() || new == old {
            return;
        }
        // Tags are `[A-Za-z0-9_-]` only, so `old` carries no regex metacharacters
        // and needs no escaping. The look-around is the same boundary guard
        // `Note`'s own tag pattern uses.
        let pattern = format!(r"(?i)(?<![\w#]){}(?![A-Za-z0-9_-])", format_args!("#{old}"));
        let Ok(re) = Regex::new(&pattern) else {
            return;
        };
        let replacement = format!("#{new}");

        for i in 0..self.notes.len() {
            if !self.notes[i].tags().contains(&old) {
                continue;
            }
            let content = self.notes[i].content().to_string();
            let updated = replace_all(&re, &content, &replacement);
            if updated == content {
                continue;
            }
            let url = self.notes[i].url().to_path_buf();
            let modified = self.notes[i].modified;
            // Never write through a note whose path resolves outside the Index.
            if !self.contains(&url) {
                continue;
            }
            if fs::write(&url, updated.as_bytes()).is_err() {
                continue;
            }
            // Keep the modified time, so a tag rename isn't seen as an edit.
            let _ = set_modified(&url, modified);
            self.notes[i] = Note::new(url, updated, modified);
        }
    }

    /// Splits a selection into the title and body of the note it becomes — the
    /// "one idea per note" move, applied to text already written.
    ///
    /// The title is the selection's first non-empty line when that line is
    /// short enough to read as a name, and the rest of the selection becomes
    /// the body, so a note doesn't repeat its own title. When the first line is
    /// too long to serve as one, the title becomes a truncation of it and the
    /// *entire* selection is kept as the body: a shortened title is a summary,
    /// not a copy, so dropping the line it came from would lose words someone
    /// wrote.
    ///
    /// Leading Markdown markers are stripped from the title, so extracting a
    /// heading or a bullet doesn't bake punctuation into a filename, while the
    /// body keeps them exactly as typed.
    pub fn extracted_title_and_body(selection: &str) -> (String, String) {
        const MAX_TITLE: usize = 60;
        let whole = selection.trim().to_string();
        let lines: Vec<&str> = selection.split('\n').collect();

        let Some(first) = lines.iter().position(|l| !l.trim().is_empty()) else {
            return ("Untitled".to_string(), whole);
        };
        let candidate = strip_leading_markers(lines[first].trim());
        if candidate.is_empty() {
            return ("Untitled".to_string(), whole);
        }

        // Counted in characters, not bytes — a 60-character title of accented
        // or CJK text is still a 60-character title.
        if candidate.chars().count() <= MAX_TITLE {
            let body = lines[first + 1..].join("\n").trim().to_string();
            return (sanitize_extracted_title(&candidate), body);
        }

        // Too long for a name: the title summarises and the body keeps
        // everything, including the line the title came from.
        let mut truncated = String::new();
        for word in candidate.split(' ') {
            if truncated.chars().count() + word.chars().count() + 1 > MAX_TITLE {
                break;
            }
            if !truncated.is_empty() {
                truncated.push(' ');
            }
            truncated.push_str(word);
        }
        if truncated.is_empty() {
            truncated = candidate.chars().take(MAX_TITLE).collect();
        }
        (sanitize_extracted_title(&truncated), whole)
    }

    /// Captures a fleeting note. Creates `Inbox/` on demand, so the feature
    /// works without anyone making the folder by hand first.
    pub fn create_inbox_note(&mut self, title: &str) -> std::io::Result<Note> {
        let dir = self.directory.join(INBOX_FOLDER_NAME);
        fs::create_dir_all(&dir)?;
        self.create_in(title, dir)
    }

    /// Creates a note directly inside `subfolder` (a path relative to the Index
    /// root), making the folder if it doesn't exist. Backs the `Folder/Title`
    /// quick-create — the Mac's `store.create(title:inSubfolder:)`. The path is
    /// sanitized so a `../` component can't create or write outside the vault;
    /// an unusable path (empty, slash-only, or traversing) just falls back to
    /// the root, as the Mac's does.
    pub fn create_in_subfolder(&mut self, title: &str, subfolder: &str) -> std::io::Result<Note> {
        let dir = match sanitized_subfolder(subfolder) {
            Some(safe) => self.directory.join(safe),
            None => self.directory.clone(),
        };
        fs::create_dir_all(&dir)?;
        self.create_in(title, dir)
    }

    fn create_in(&mut self, title: &str, dir: PathBuf) -> std::io::Result<Note> {
        let path = dir.join(unique_filename(title, &dir));
        // `dir` is sanitized, but a symlinked component can still land the file
        // outside the vault — resolve it before creating anything.
        self.guard_write(&path)?;
        fs::write(&path, "")?;
        let note = Note::new(path, "", SystemTime::now());
        self.notes.insert(0, note.clone());
        self.invalidate_caches();
        Ok(note)
    }

    /// The note whose title matches `query` exactly, case-insensitively —
    /// the same comparison `Note::wiki_links` lowercases its targets with, so
    /// a link resolves here exactly when it registers as a backlink there.
    pub fn exact_title_match(&self, query: &str) -> Option<&Note> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return None;
        }
        self.notes.iter().find(|n| n.lowercased_title() == q)
    }

    /// Follows a `[[wiki-link]]`: returns the note it points at, creating it if
    /// it doesn't exist yet.
    ///
    /// A link-created note always lands in the Index proper, never `Inbox/`,
    /// even when "new notes start in the Inbox" is on — the same carve-out the
    /// Mac makes for links and templates alike. Both are *already placed*: you
    /// said where this note belongs by linking to it from somewhere, so
    /// routing it through a capture queue would be asking a question you've
    /// already answered.
    pub fn open_or_create_link(&mut self, target: &str) -> std::io::Result<Note> {
        if let Some(found) = self.exact_title_match(target) {
            return Ok(found.clone());
        }
        let dir = self.directory.clone();
        self.create_in(target, dir)
    }

    pub fn save(&mut self, note: &Note) -> std::io::Result<()> {
        self.guard_write(note.url())?;
        fs::write(note.url(), note.content())?;
        if let Some(existing) = self.notes.iter_mut().find(|n| n.id() == note.id()) {
            existing.set_content(note.content());
            existing.modified = SystemTime::now();
        }
        Ok(())
    }

    /// Renames a note and rewrites every `[[link]]` and `![[embed]]` pointing
    /// at it across the Index, so nothing breaks.
    pub fn rename(&mut self, note: &Note, new_title: &str) -> std::io::Result<Note> {
        let trimmed = new_title.trim();
        if trimmed.is_empty() || trimmed == note.title() {
            return Ok(note.clone());
        }
        let dir = note.url().parent().unwrap_or(&self.directory).to_path_buf();

        // A case-only change ("test" → "Test") collides with the file itself
        // on a case-insensitive volume, so asking for a free name would hand
        // back "Test (2)". Move straight to the new spelling instead.
        let new_path = if trimmed.eq_ignore_ascii_case(note.title()) {
            dir.join(format!("{}.md", sanitize_title(trimmed)))
        } else {
            dir.join(unique_filename(trimmed, &dir))
        };

        self.guard_write(note.url())?;
        self.guard_write(&new_path)?;
        fs::rename(note.url(), &new_path)?;
        let renamed = Note::new(new_path, note.content(), SystemTime::now());
        if let Some(slot) = self.notes.iter_mut().find(|n| n.id() == note.id()) {
            *slot = renamed.clone();
        }
        self.invalidate_caches();
        self.update_wiki_link_references(note.title(), renamed.title());
        Ok(renamed)
    }

    /// After a rename, rewrite every `[[old]]` / `![[old]]` reference to point
    /// at the new title. Matching is case-insensitive (the same way a
    /// wiki-link resolves) and an embed's leading `!` is preserved.
    ///
    /// A reference-only rewrite **keeps each note's modified date**, both in
    /// memory and on disk, so renaming a widely-linked note doesn't shove all
    /// its referrers to the top of a date-sorted list — the user renamed one
    /// note, they didn't edit thirty others.
    fn update_wiki_link_references(&mut self, old_title: &str, new_title: &str) {
        if old_title.eq_ignore_ascii_case(new_title) {
            return;
        }
        let old_lower = old_title.to_lowercase();
        // Group 2 captures any alias or heading suffix so it survives the
        // rewrite: `[[Old|yesterday's notes]]` becomes `[[New|yesterday's
        // notes]]`, not `[[New]]`. Without it a rename would silently discard
        // the words the author actually wrote into their sentence.
        let pattern = format!(
            r"(?i)(!?)\[\[[ \t]*{}[ \t]*((?:#|\|)[^\[\]]*)?\]\]",
            fancy_regex::escape(old_title)
        );
        let Ok(re) = fancy_regex::Regex::new(&pattern) else {
            return;
        };
        let replacement = format!("${{1}}[[{new_title}${{2}}]]");

        // Candidates come from the wiki-links cache, so only notes that
        // actually reference the old title are touched.
        let ids: Vec<String> = self
            .notes
            .iter()
            .filter(|n| n.wiki_links().contains(&old_lower))
            .map(|n| n.id().to_string())
            .collect();

        for id in ids {
            let Some(idx) = self.notes.iter().position(|n| n.id() == id) else {
                continue;
            };
            let content = self.notes[idx].content().to_string();
            let updated = re.replace_all(&content, replacement.as_str()).into_owned();
            if updated == content {
                continue;
            }
            let path = self.notes[idx].url().to_path_buf();
            let original_modified = self.notes[idx].modified;
            if !self.contains(&path) || fs::write(&path, &updated).is_err() {
                continue;
            }
            // Restore the modification time the rewrite just clobbered.
            let _ = set_modified(&path, original_modified);
            self.notes[idx].set_content(updated);
            self.notes[idx].modified = original_modified;
        }
    }

    pub fn delete(&mut self, notes_to_delete: &[Note]) {
        if notes_to_delete.is_empty() {
            return;
        }
        let mut trashed = Vec::new();
        for note in notes_to_delete {
            let Some(parent) = note.url().parent() else {
                continue;
            };
            let trash_dir = parent.join(TRASH_FOLDER_NAME);
            // A note whose path resolves outside the Index is not ours to move.
            if !self.contains(note.url()) || !self.contains(&trash_dir) {
                continue;
            }
            if fs::create_dir_all(&trash_dir).is_err() {
                continue;
            }
            let destination = trash_dir.join(unique_filename(note.title(), &trash_dir));
            if !self.contains(&destination) {
                continue;
            }
            if fs::rename(note.url(), &destination).is_ok() {
                trashed.push((note.clone(), destination));
            }
        }
        // Only the notes whose move actually succeeded leave the list — a note
        // whose trash move failed is still sitting on disk, and dropping it
        // from the UI anyway would make it vanish until the next full reload.
        let deleted_ids: Vec<&str> = trashed.iter().map(|(n, _)| n.id()).collect();
        self.notes.retain(|n| !deleted_ids.contains(&n.id()));
        self.last_deleted = trashed;
        self.invalidate_caches();
        self.refresh_trashed();
    }

    /// Moves the most recently deleted note(s) back out of `.trash` to their
    /// original location. A note whose original location has since been reused
    /// — a new note created with the same filename — is silently skipped
    /// rather than overwriting it or failing loudly.
    pub fn restore_last_deleted(&mut self) -> Vec<Note> {
        if self.last_deleted.is_empty() {
            return Vec::new();
        }
        let mut restored = Vec::new();
        for (note, trashed_path) in std::mem::take(&mut self.last_deleted) {
            if note.url().exists() {
                continue;
            }
            if !self.contains(&trashed_path) || !self.contains(note.url()) {
                continue;
            }
            if fs::rename(&trashed_path, note.url()).is_ok() {
                restored.push(note);
            }
        }
        self.notes.extend(restored.iter().cloned());
        self.invalidate_caches();
        self.refresh_trashed();
        restored
    }

    /// Restores an arbitrary trashed note — unlike `restore_last_deleted`,
    /// which only remembers the most recent delete and only for this process,
    /// this works for anything currently in any `.trash` subfolder.
    pub fn restore_from_trash(&mut self, note: &Note) -> Option<Note> {
        let trash_dir = note.url().parent()?;
        let original_dir = trash_dir.parent()?;
        let destination = original_dir.join(unique_filename(note.title(), original_dir));
        if !self.contains(note.url()) || !self.contains(&destination) {
            return None;
        }
        fs::rename(note.url(), &destination).ok()?;
        let restored = Note::new(destination, note.content(), note.modified);
        self.notes.push(restored.clone());
        self.invalidate_caches();
        self.refresh_trashed();
        Some(restored)
    }

    /// Sends a single trashed note to the Recycle Bin rather than erasing it,
    /// so nothing the app does is ever truly unrecoverable — the Mac's
    /// deleteFromTrash moves the file to the macOS Trash the same way.
    pub fn delete_from_trash(&mut self, note: &Note) {
        if self.contains(note.url()) {
            let _ = trash::delete(note.url());
        }
        self.refresh_trashed();
    }

    /// Empties every `.trash` subfolder into the Recycle Bin in one go — the
    /// second, slower stage of deletion, driven on a schedule by the app layer.
    /// Recycled, not erased, matching the Mac's emptyTrash (trashItem).
    pub fn empty_trash(&mut self) {
        let dirs: Vec<PathBuf> = all_trash_directories(&self.directory)
            .into_iter()
            .filter(|d| self.contains(d))
            .collect();
        let _ = trash::delete_all(&dirs);
        self.refresh_trashed();
    }

    // --- Attachments --------------------------------------------------------

    /// The vault's single `Attachments/` folder. Not created here — the writers
    /// make it on demand, so merely resolving a path never leaves an empty
    /// folder behind.
    /// The largest file that may be copied into `Attachments/`. Well past any
    /// real screenshot or photo, small enough that a mis-drop of a disk image
    /// fails fast rather than duplicating gigabytes into the vault.
    pub const MAX_ATTACHMENT_BYTES: u64 = 64 * 1024 * 1024;

    pub fn attachments_dir(&self) -> PathBuf {
        self.directory.join(ATTACHMENTS_FOLDER_NAME)
    }

    /// Resolves a bare attachment filename (already parsed out of `![[…]]`,
    /// before any `|size`) to its path. No existence check — the renderer
    /// decides what a missing file looks like.
    ///
    /// The name is untrusted note text, so it is contained to a single leaf
    /// inside `Attachments/`: any directory parts are stripped and `.`/`..`
    /// refused, so a crafted embed like `![[../../secret.png]]` can never
    /// resolve outside the folder (which would otherwise let merely opening a
    /// note read, open, reveal, or even move an arbitrary file). Mirrors the
    /// Mac's `attachmentURL(forName:)`.
    pub fn attachment_path(&self, name: &str) -> PathBuf {
        self.attachments_dir().join(attachment_leaf(name))
    }

    /// Writes raw image bytes as `base.ext`, de-duped, returning the stored
    /// filename. Creates `Attachments/` on demand. This is the clipboard-paste
    /// path, where `base` is always "Pasted image" (so `Pasted image.png`,
    /// `Pasted image (2).png`, …), matching the Mac's `saveAttachment`.
    pub fn save_attachment(&self, bytes: &[u8], base: &str, ext: &str) -> std::io::Result<String> {
        let dir = self.attachments_dir();
        // The extension decides what the vault ends up holding, so it is held
        // to the same list the renderer will show — otherwise the paste handler
        // (or anything reaching the command behind it) could drop a `.desktop`
        // or a `.sh` into a folder people open from the app.
        let name = format!("{base}.{ext}");
        if !crate::note::is_image_attachment(&name) {
            return Err(not_an_image());
        }
        fs::create_dir_all(&dir)?;
        let name = available_attachment_name(&name, &dir);
        fs::write(dir.join(&name), bytes)?;
        Ok(name)
    }

    /// Every image in `Attachments/`, newest first — for the Insert Image
    /// picker, so a picture is chosen by sight rather than by an unmemorable
    /// filename. Mirrors the Mac's `imageAttachments()`.
    pub fn image_attachments(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.attachments_dir()) else {
            return Vec::new();
        };
        let mut images: Vec<(String, SystemTime)> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                if !crate::note::is_image_attachment(&name) {
                    return None;
                }
                let modified = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                Some((name, modified))
            })
            .collect();
        images.sort_by(|a, b| b.1.cmp(&a.1));
        images.into_iter().map(|(name, _)| name).collect()
    }

    /// Renames an attachment file and rewrites every `![[old…]]` reference to it
    /// across the vault, returning the final (de-duped) name — or `None` if the
    /// file is missing or the move fails. Each referring note keeps its modified
    /// time, so renaming a widely-used image doesn't reshuffle a date-sorted
    /// list. Mirrors the Mac's `renameAttachment` + `updateAttachmentReferences`.
    pub fn rename_attachment(&mut self, old_name: &str, new_name: &str) -> Option<String> {
        let dir = self.attachments_dir();
        // Contain the source: `old_name` is untrusted note text, and a rename
        // moves the file, so a `../` source must never point outside the folder
        // (that would relocate an arbitrary file into the vault).
        let old_path = self.attachment_path(old_name);
        if !is_contained(&old_path, &dir)
            || old_path.parent() != Some(dir.as_path())
            || !old_path.exists()
        {
            return None;
        }
        // A rename to the same name (only case or whitespace differing) is a
        // no-op — checked before de-dup, or the file being renamed would itself
        // look like a collision and bump the name to "(2)".
        if sanitize_attachment_name(new_name).eq_ignore_ascii_case(old_name) {
            return Some(old_name.to_string());
        }
        let final_name = available_attachment_name(new_name, &dir);
        let destination = dir.join(&final_name);
        if !self.contains(&old_path) || !self.contains(&destination) {
            return None;
        }
        fs::rename(&old_path, destination).ok()?;
        self.update_attachment_references(old_name, &final_name);
        Some(final_name)
    }

    /// Rewrites `![[old]]`, `![[old|size]]`, and `![[old|size|caption]]` to point
    /// at `new_name` in every note that references the old attachment, keeping
    /// the `|size|caption` suffix and each note's modified time. The twin of
    /// `update_wiki_link_references`, but embed-only (the leading `!` is
    /// required) and never touching note links.
    fn update_attachment_references(&mut self, old_name: &str, new_name: &str) {
        // Group 1 captures the `|size|caption` suffix so it survives the rewrite.
        let pattern = format!(
            r"(?i)!\[\[[ \t]*{}[ \t]*(\|[^\[\]]*)?\]\]",
            fancy_regex::escape(old_name)
        );
        let Ok(re) = fancy_regex::Regex::new(&pattern) else {
            return;
        };
        let replacement = format!("![[{new_name}${{1}}]]");
        let old_lower = old_name.to_lowercase();

        // Only notes that actually reference the old name — the embed target is
        // in the wiki-links cache the same as any `[[link]]`.
        let ids: Vec<String> = self
            .notes
            .iter()
            .filter(|n| n.wiki_links().contains(&old_lower))
            .map(|n| n.id().to_string())
            .collect();

        for id in ids {
            let Some(idx) = self.notes.iter().position(|n| n.id() == id) else {
                continue;
            };
            let content = self.notes[idx].content().to_string();
            let updated = re.replace_all(&content, replacement.as_str()).into_owned();
            if updated == content {
                continue;
            }
            let path = self.notes[idx].url().to_path_buf();
            let original_modified = self.notes[idx].modified;
            if !self.contains(&path) || fs::write(&path, &updated).is_err() {
                continue;
            }
            let _ = set_modified(&path, original_modified);
            self.notes[idx].set_content(updated);
            self.notes[idx].modified = original_modified;
        }
    }

    /// Copies an external file into `Attachments/`, de-duped, returning the
    /// stored filename. The original is left where it was — the drag-and-drop
    /// path, matching the Mac's `copyAttachment` (a copy, not a move).
    pub fn copy_attachment(&self, source: &Path) -> std::io::Result<String> {
        let dir = self.attachments_dir();
        let original = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "attachment".to_string());
        // A drop hands us whatever path the desktop gives it, so the source is
        // checked before anything is copied in: an image by name, a plain file
        // rather than a directory or a device (reading `/dev/zero` never ends),
        // and small enough that a stray drop can't fill the disk.
        if !crate::note::is_image_attachment(&original) {
            return Err(not_an_image());
        }
        let meta = fs::metadata(source)?;
        if !meta.is_file() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "that isn't a file"));
        }
        if meta.len() > Self::MAX_ATTACHMENT_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "that image is larger than 64 MB",
            ));
        }
        fs::create_dir_all(&dir)?;
        let name = available_attachment_name(&original, &dir);
        fs::copy(source, dir.join(&name))?;
        Ok(name)
    }

    // --- Templates ----------------------------------------------------------

    pub fn templates(&self) -> Vec<NoteTemplate> {
        let dir = self.directory.join(TEMPLATES_FOLDER_NAME);
        let Ok(entries) = fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut out: Vec<NoteTemplate> = entries
            .filter_map(|e| e.ok())
            // A template is read and written back by path, so a symlinked one
            // would make either reach any file on disk.
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|e| e.path())
            .filter(|p| is_markdown(p))
            .map(|path| NoteTemplate {
                id: path.to_string_lossy().into_owned(),
                name: path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path,
            })
            .collect();
        out.sort_by_key(|t| t.name.to_lowercase());
        out
    }

    /// Creates a note from a template, substituting the template tokens.
    ///
    /// `date_text` is caller-formatted rather than decided here, so the app's
    /// own date-format setting applies — this crate stays UI-agnostic and
    /// doesn't own a preferred date style.
    ///
    /// The *title* is substituted too, before it's used, so a template named
    /// "Daily Notes {{date}}" produces a note titled with today's actual date
    /// rather than the literal token. An empty title falls back to the
    /// template's own name.
    pub fn create_from_template(
        &mut self,
        title: &str,
        template: &NoteTemplate,
        date_text: &str,
        time_text: &str,
    ) -> std::io::Result<Note> {
        let trimmed = title.trim();
        let raw_base = if trimmed.is_empty() { &template.name } else { trimmed };
        let base = apply_template_tokens(raw_base, raw_base, date_text, time_text);

        let path = self.directory.join(unique_filename(&base, &self.directory));
        let raw = fs::read_to_string(&template.path).unwrap_or_default();
        let content = apply_template_tokens(&raw, &base, date_text, time_text);

        self.guard_write(&path)?;
        fs::write(&path, &content)?;
        let note = Note::new(path, content, SystemTime::now());
        self.notes.insert(0, note.clone());
        self.invalidate_caches();
        Ok(note)
    }

    /// Turns a note into a template — a plain move into `Templates/`, which
    /// drops it out of `notes` since the scan never treats that folder as
    /// notes. The text is untouched: a template is just a note that lives
    /// somewhere else.
    pub fn convert_to_template(&mut self, note: &Note) -> Option<NoteTemplate> {
        let dir = self.directory.join(TEMPLATES_FOLDER_NAME);
        fs::create_dir_all(&dir).ok()?;
        let path = dir.join(unique_filename(note.title(), &dir));
        if !self.contains(note.url()) || !self.contains(&path) {
            return None;
        }
        fs::rename(note.url(), &path).ok()?;
        self.notes.retain(|n| n.id() != note.id());
        self.invalidate_caches();
        Some(NoteTemplate {
            id: path.to_string_lossy().into_owned(),
            name: path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path,
        })
    }

    /// Files a fleeting note into the Index proper — a plain move out of
    /// `Inbox/`, to the root by default or straight into `subfolder` (created
    /// on demand). The note's text is untouched, so nothing about having been
    /// fleeting survives in the file.
    ///
    /// A thin wrapper over the move, with the Inbox exemption: a fleeting note
    /// whose title collides with one already in the destination still files,
    /// as "Foo (2)", rather than refusing — it has no incoming links to
    /// protect. Mirrors the Mac's `submitFromInbox(_:toSubfolder:)`.
    pub fn submit_from_inbox(&mut self, note: &Note, subfolder: Option<&str>) -> Option<Note> {
        if !crate::search::is_inbox_note(note) {
            return None;
        }
        self.move_note_inner(note.id(), subfolder, true)
    }
}

/// A small fixed set of tokens — plain string replacement, not any kind of
/// scripting, so a template stays a plain markdown file readable by any other
/// editor too.
fn apply_template_tokens(text: &str, title: &str, date_text: &str, time_text: &str) -> String {
    text.replace("{{date}}", date_text)
        .replace("{{time}}", time_text)
        .replace("{{title}}", title)
}

/// The folder `note` sits in, relative to `root`, or `None` at the root.
///
/// A free function as well as a method because most callers hold the store
/// mutably at the point they need this and cannot borrow it again.
pub fn subfolder_path(note: &Note, root: &Path) -> Option<String> {
    let parent = note.url().parent()?;
    let relative = parent.strip_prefix(root).ok()?;
    if relative.as_os_str().is_empty() {
        return None;
    }
    // Separators are normalised so a stored colour keys the same whichever way
    // the path was built — the key is a plain relative path, not a platform one.
    let relative = relative.to_string_lossy().replace('\\', "/");
    (relative != INBOX_FOLDER_NAME).then_some(relative)
}

/// Drops a leading heading/bullet/quote/number/checkbox marker from a line, so
/// extracting "## Ideas" or "- [ ] Ship it" names the note for what it says
/// rather than for the punctuation in front of it.
fn strip_leading_markers(line: &str) -> String {
    let mut s = line.trim_start_matches(['#', '>']).trim().to_string();
    for bullet in ["- ", "* ", "+ "] {
        if let Some(rest) = s.strip_prefix(bullet) {
            s = rest.to_string();
            break;
        }
    }
    // An ordered-list marker, "12. ".
    if let Some(dot) = s.find('.') {
        let (digits, rest) = s.split_at(dot);
        if !digits.is_empty()
            && digits.chars().all(|c| c.is_ascii_digit())
            && rest.starts_with(". ")
        {
            s = rest[2..].to_string();
        }
    }
    // A task checkbox left over once the bullet is gone.
    for box_ in ["[ ] ", "[x] ", "[X] "] {
        if let Some(rest) = s.strip_prefix(box_) {
            s = rest.to_string();
            break;
        }
    }
    s.trim().to_string()
}

/// The Mac's own narrow rule for an extracted title: only the two characters
/// that would change what path the name means. Deliberately *not*
/// `filename::sanitize_title`, which is the full Windows-legal treatment —
/// that still runs afterwards when the file is actually created, so this stays
/// a faithful port rather than quietly sanitising more than the Mac does and
/// producing a different title from the same selection.
fn sanitize_extracted_title(s: &str) -> String {
    let cleaned = s.replace(['/', ':'], "-").trim().to_string();
    if cleaned.is_empty() {
        "Untitled".to_string()
    } else {
        cleaned
    }
}

/// A subfolder path relative to the Index root, sanitized for safe use: each
/// component gets the same `:` → `-` rewrite filenames do, empty components
/// (doubled slashes) are dropped, and any `.` or `..` component is rejected
/// outright so a typed or imported path can never traverse out of the vault.
/// `None` when nothing usable remains. Mirrors the Mac's `sanitizedSubfolder`.
///
/// Components are cleaned inline rather than through `sanitize_title`, whose
/// "Untitled" fallback would turn an empty or whitespace component into a real
/// folder — and, unlike [`sanitize_extracted_title`], nothing here falls back.
pub fn sanitized_subfolder(path: &str) -> Option<String> {
    let components: Vec<String> = path
        .split('/')
        .map(|raw| raw.replace(':', "-").trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    if components.is_empty() || components.iter().any(|c| c == "." || c == "..") {
        return None;
    }
    Some(components.join("/"))
}

/// Whether `path` is `base` or somewhere beneath it — the guard against a path
/// escaping the vault via `..`. Both are normalised lexically first, so `..`
/// segments are collapsed before the prefix check (the Mac's
/// `standardizedFileURL` does the same; neither touches the disk).
pub fn is_contained(path: &Path, base: &Path) -> bool {
    let path = lexically_normalized(path);
    let base = lexically_normalized(base);
    path == base || path.starts_with(&base)
}

/// Collapses `.` and `..` components without consulting the filesystem.
fn lexically_normalized(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// The single filename an attachment reference may name: its last path
/// component, with `.`/`..`/empty replaced by U+FFFD so the result still
/// resolves to a (nonexistent) file rather than to the folder itself.
fn attachment_leaf(name: &str) -> String {
    let leaf = name
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    if leaf.is_empty() || leaf == "." || leaf == ".." {
        "\u{FFFD}".to_string()
    } else {
        leaf.to_string()
    }
}

/// Keeps only the characters a tag may contain (`[A-Za-z0-9_-]`), dropping a
/// leading `#`. Matches the Mac's `sanitizedTagName`, so a rename target is held
/// to the same shape a typed tag is.
fn sanitize_tag_name(raw: &str) -> String {
    let body = raw.trim().strip_prefix('#').unwrap_or(raw.trim());
    body.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

/// Replaces every match of `re` in `text` with `replacement`, a fixed string
/// (no capture references). Done by hand because `fancy_regex`'s own
/// replacement helpers are less certain than iterating the matches, and the
/// replacement here never refers to a group.
fn replace_all(re: &Regex, text: &str, replacement: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for m in re.find_iter(text).filter_map(|r| r.ok()) {
        out.push_str(&text[last..m.start()]);
        out.push_str(replacement);
        last = m.end();
    }
    out.push_str(&text[last..]);
    out
}

/// A directory that really is one — `symlink_metadata` rather than `is_dir`,
/// so a symlink pointing at a directory doesn't count. Every walk in this file
/// skips symlinks; the write guards below assume what they found is inside.
fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

/// Whether a write to `target` actually lands inside `root`.
///
/// Resolved for real rather than lexically: a note path can reach us from a
/// stale in-memory note or a frontend id, and a symlinked component anywhere
/// along it would otherwise let a rename, a write or a delete step outside the
/// Index. A target that doesn't exist yet — the destination of a rename, a
/// folder about to be created — is resolved through its nearest existing
/// ancestor, so creating `Projects/Sub/Note.md` from nothing still passes.
fn writes_inside(target: &Path, root: &Path) -> bool {
    let Ok(root) = dunce::canonicalize(root) else {
        return false;
    };
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut probe = target;
    loop {
        if let Ok(base) = dunce::canonicalize(probe) {
            let mut resolved = base;
            for part in tail.iter().rev() {
                resolved.push(part);
            }
            return resolved.starts_with(&root);
        }
        let (Some(name), Some(parent)) = (probe.file_name(), probe.parent()) else {
            return false;
        };
        tail.push(name.to_os_string());
        probe = parent;
    }
}

fn not_an_image() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, "attachments have to be images")
}

fn is_markdown(p: &Path) -> bool {
    p.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

fn is_hidden(p: &Path) -> bool {
    p.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'))
}

fn set_modified(path: &Path, time: SystemTime) -> std::io::Result<()> {
    let f = fs::OpenOptions::new().write(true).open(path)?;
    f.set_modified(time)
}

/// Every `.md` file to treat as a note.
///
/// The Index's own service folders — `Templates/`, `Attachments/`, a
/// Mac-synced `Trash/`, `Envy Data/` — are skipped whether or not subfolder
/// scanning is on: none of them hold notes. Excluded by root-level path, the
/// way the Mac's `notesRecursively` does, so a user folder that merely shares
/// a name deeper down is still scanned. Hidden directories are skipped
/// wholesale, which is what keeps `.trash` invisible without needing its own
/// special case (the same property `skipsHiddenFiles` provides on the Mac).
///
/// `Inbox/` is read even when subfolder scanning is off: it isn't a folder the
/// user made to organise things, it's where captures land, and a fleeting note
/// that only appears if an unrelated setting happens to be enabled is a lost
/// note.
/// Returns each note's modification time alongside its path, taken from the
/// directory entry rather than looked up afterwards.
///
/// This matters more on Windows than the shape of the code suggests. Windows'
/// directory enumeration returns full metadata for every entry as part of the
/// listing, and `DirEntry::file_type`/`DirEntry::metadata` read it straight out
/// of that already-fetched record without touching the disk again. Calling
/// `Path::is_dir()` or `fs::metadata(&path)` instead throws that away and opens
/// the file by path a second time — and a path-based open on Windows is far
/// more expensive than the equivalent `stat` on macOS, because it walks and
/// re-resolves every component of the path.
///
/// Doing it the naive way cost two extra opens per note (one to test whether
/// the entry was a directory, one for the modification date), so scanning
/// 5,000 notes paid 15,000 file opens rather than 5,000. That is the whole
/// reason a reload here was slower than the Mac's, which gets the same data for
/// free by asking for `.contentModificationDateKey` during enumeration.
fn note_paths(directory: &Path, include_subfolders: bool) -> Vec<(PathBuf, SystemTime)> {
    let service: Vec<PathBuf> = SERVICE_FOLDER_NAMES.iter().map(|n| directory.join(n)).collect();
    let mut out = Vec::new();

    fn walk(dir: &Path, service: &[PathBuf], recurse: bool, out: &mut Vec<(PathBuf, SystemTime)>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            // A symlink is skipped rather than followed. It can point anywhere
            // — a folder outside the vault, a note outside it, or a loop back
            // in — and every write below is contained to the Index on the
            // assumption that a note's path genuinely lives under it.
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if !recurse || is_hidden(&path) || service.contains(&path) {
                    continue;
                }
                walk(&path, service, true, out);
            } else if file_type.is_file() && is_markdown(&path) && !is_hidden(&path) {
                let modified = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or_else(|_| SystemTime::now());
                out.push((path, modified));
            }
        }
    }

    walk(directory, &service, include_subfolders, &mut out);

    if !include_subfolders {
        let inbox = directory.join(INBOX_FOLDER_NAME);
        if is_real_dir(&inbox) {
            walk(&inbox, &service, false, &mut out);
        }
    }
    out
}

/// Reads every note under `directory`, newest first.
///
/// Reading each file is its own syscall, and doing that serially means paying
/// each file's latency in turn — measured on the Mac as the dominant cost of a
/// reload with several thousand notes (over a second for 10,000 files on a
/// fast local disk). `rayon` reads them across the available cores instead,
/// which is what `DispatchQueue.concurrentPerform` does there.
pub fn scan_directory(directory: &Path, include_subfolders: bool) -> Vec<Note> {
    let paths = note_paths(directory, include_subfolders);
    let mut notes: Vec<Note> = paths
        .into_par_iter()
        .filter_map(|(path, modified)| {
            let content = fs::read_to_string(&path).ok()?;
            Some(Note::new(path, content, modified))
        })
        .collect();
    notes.sort_by_key(|n| std::cmp::Reverse(n.modified));
    notes
}

/// Like `scan_directory`, but reuses any `Note` from `previous` whose file is
/// still present with the same modification time instead of re-reading it.
///
/// This is what keeps a reload after a single external change from re-reading
/// the whole vault: the on-disk `(path, mtime)` list is cheap (one `read_dir`
/// pass, no file opens — see `note_paths`), so we diff it against the notes we
/// already have. Unchanged files are handed back untouched — derived cache and
/// all — removed files are dropped, and only the new/changed remainder is read,
/// still in parallel. Reduces a one-file edit from N reads to one.
fn scan_directory_reusing(
    directory: &Path,
    include_subfolders: bool,
    previous: Vec<Note>,
) -> Vec<Note> {
    let paths = note_paths(directory, include_subfolders);
    // Index the notes we already hold by path so the diff is O(1) per entry.
    // The paths from `note_paths` are built the same way as each note's `url`
    // (both walk `entry.path()` from the one canonicalized root), so they match.
    let mut prior: HashMap<PathBuf, Note> =
        previous.into_iter().map(|n| (n.url().to_path_buf(), n)).collect();

    let mut reused: Vec<Note> = Vec::new();
    let mut to_read: Vec<(PathBuf, SystemTime)> = Vec::with_capacity(paths.len());
    for (path, modified) in paths {
        match prior.remove(&path) {
            // Same file, same mtime: the note we hold is still current.
            Some(note) if note.modified == modified => reused.push(note),
            // New file, or one whose mtime moved — must (re)read it.
            _ => to_read.push((path, modified)),
        }
    }
    // Anything left in `prior` is a file that no longer exists; dropping the map
    // drops those notes.

    let mut fresh: Vec<Note> = to_read
        .into_par_iter()
        .filter_map(|(path, modified)| {
            let content = fs::read_to_string(&path).ok()?;
            Some(Note::new(path, content, modified))
        })
        .collect();

    reused.append(&mut fresh);
    reused.sort_by_key(|n| std::cmp::Reverse(n.modified));
    reused
}

/// The folder walk behind `NoteStore::subfolders`, lifted out so the cached
/// value has one producer.
fn scan_subfolders(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            // Symlinks skipped, as in the note scan: a folder you can file
            // a note into has to genuinely be inside the Index.
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir || is_hidden(&path) {
                continue;
            }
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if name == INBOX_FOLDER_NAME || SERVICE_FOLDER_NAMES.contains(&name.as_ref()) {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
            walk(&path, root, out);
        }
    }
    walk(root, root, &mut out);
    out.sort();
    out
}

/// Every `.trash` directory anywhere under `directory` — there's one per
/// folder that's ever had a note deleted from it, not just one at the top.
fn all_trash_directories(directory: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            // `file_type` doesn't follow the link, so a `.trash` symlinked out
            // of the vault is never walked — nor emptied into the Recycle Bin.
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if path.file_name().is_some_and(|n| n == TRASH_FOLDER_NAME) {
                out.push(path); // don't descend into trash
            } else {
                walk(&path, out);
            }
        }
    }
    walk(directory, &mut out);
    out
}

/// Not parallelised like `scan_directory`: trash holds far fewer notes than
/// the whole Index at any given time, so a plain sequential scan is simpler
/// and in practice just as fast.
pub fn scan_trashed_notes(directory: &Path) -> Vec<Note> {
    let mut out = Vec::new();
    for trash_dir in all_trash_directories(directory) {
        let Ok(entries) = fs::read_dir(&trash_dir) else {
            continue;
        };
        for path in entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|e| e.path())
            .filter(|p| is_markdown(p))
        {
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let modified = fs::metadata(&path)
                .and_then(|m| m.modified())
                .unwrap_or_else(|_| SystemTime::now());
            out.push(Note::new(path, content, modified));
        }
    }
    out.sort_by_key(|n| std::cmp::Reverse(n.modified));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use tempfile::TempDir;

    /// The incremental watcher path: one file re-read, one file dropped, and
    /// nothing else in the Index disturbed.
    #[test]
    fn reload_paths_applies_one_file_at_a_time() {
        let (dir, mut store) = store_with(&[("A.md", "first"), ("B.md", "second")]);
        let a = dir.path().join("A.md");
        let b = dir.path().join("B.md");

        // An edit landing from outside Envy.
        fs::write(&a, "first, edited").unwrap();
        // The store canonicalizes its root, so the watcher's paths have to be
        // resolved the same way before they can be matched against note urls.
        let resolved = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        store.reload_paths(&[resolved(&a)]);
        fn by(store: &NoteStore, t: &str) -> Option<Note> {
            store.notes().iter().find(|n| n.title() == t).cloned()
        }
        assert_eq!(by(&store, "A").unwrap().content(), "first, edited");
        assert_eq!(by(&store, "B").unwrap().content(), "second");

        // A file removed outside Envy — `canonicalize` can't resolve a path
        // that no longer exists, so it is resolved before the delete.
        let b_resolved = resolved(&b);
        fs::remove_file(&b).unwrap();
        store.reload_paths(&[b_resolved]);
        assert!(by(&store, "B").is_none());
        assert!(by(&store, "A").is_some());
    }

    /// A directory event, an empty batch, or one too large to be worth
    /// stat-ing file by file all fall back to the full rescan — which must
    /// still see everything.
    #[test]
    fn reload_paths_falls_back_to_a_full_reload() {
        let (dir, mut store) = nested_store_with(&[("A.md", "a")]);
        fs::create_dir_all(dir.path().join("Projects")).unwrap();
        fs::write(dir.path().join("Projects/New.md"), "new").unwrap();

        // The directory itself is what the watcher reports; the note inside it
        // may never get an event of its own.
        store.reload_paths(&[dir.path().join("Projects")]);
        assert!(store.notes().iter().any(|n| n.title() == "New"));

        fs::write(dir.path().join("Later.md"), "later").unwrap();
        store.reload_paths(&[]);
        assert!(store.notes().iter().any(|n| n.title() == "Later"));
    }

    #[test]
    fn subfolders_exclude_the_folders_that_already_mean_something() {
        let (dir, store) = store_with(&[
            ("Root.md", "x"),
            ("Projects/A.md", "x"),
            ("Projects/Work/B.md", "x"),
            ("Templates/T.md", "x"),
            ("Inbox/Fleeting.md", "x"),
            (".trash/Gone.md", "x"),
            ("Attachments/pic.png", "x"),
            // A Mac-synced vault's own service folders.
            ("Trash/Work/Old.md", "x"),
            ("Envy Data/kindle.json", "x"),
        ]);
        let _ = &dir;
        assert_eq!(store.subfolders(), vec!["Projects", "Projects/Work"]);
    }

    #[test]
    fn subfolder_path_is_relative_and_skips_inbox() {
        let (dir, store) = nested_store_with(&[
            ("Root.md", "x"),
            ("Projects/Work/Deep.md", "x"),
            ("Inbox/Fleeting.md", "x"),
        ]);
        let _ = &dir;
        let by = |t: &str| store.notes().iter().find(|n| n.title() == t).unwrap().clone();
        assert_eq!(store.subfolder_path(&by("Root")), None);
        assert_eq!(
            store.subfolder_path(&by("Deep")),
            Some("Projects/Work".to_string())
        );
        // A fleeting note keeps its own dot rather than wearing a folder colour.
        assert_eq!(store.subfolder_path(&by("Fleeting")), None);
    }

    #[test]
    fn moving_a_note_keeps_its_title_so_links_still_resolve() {
        let (dir, mut store) = store_with(&[("Ideas.md", "body"), ("Hub.md", "see [[Ideas]]")]);
        let id = store
            .notes()
            .iter()
            .find(|n| n.title() == "Ideas")
            .unwrap()
            .id()
            .to_string();

        let moved = store.move_note(&id, Some("Projects")).unwrap();
        assert_eq!(moved.title(), "Ideas");
        assert_eq!(moved.content(), "body");
        assert!(dir.path().join("Projects/Ideas.md").exists());
        assert!(!dir.path().join("Ideas.md").exists());
        assert_eq!(store.subfolder_path(&moved), Some("Projects".to_string()));

        // Back to the root.
        let back = store.move_note(moved.id(), None).unwrap();
        assert_eq!(store.subfolder_path(&back), None);
        assert!(dir.path().join("Ideas.md").exists());
    }

    #[test]
    fn moving_into_the_same_folder_is_a_no_op() {
        let (dir, mut store) = nested_store_with(&[("Projects/A.md", "x")]);
        let _ = &dir;
        let id = store.notes()[0].id().to_string();
        let same = store.move_note(&id, Some("Projects")).unwrap();
        assert_eq!(same.id(), id);
    }

    /// Mac 1.8.1 "Safer moves": a move onto a taken name is refused, not
    /// silently renamed to "A (2)" — either outcome would change what half
    /// the vault's [[A]] links point at.
    #[test]
    fn moving_onto_a_taken_name_is_refused() {
        let (dir, mut store) =
            nested_store_with(&[("A.md", "root copy"), ("Projects/A.md", "folder copy")]);
        let root_id = store
            .notes()
            .iter()
            .find(|n| n.url().parent() == Some(dir.path()))
            .unwrap()
            .id()
            .to_string();
        assert!(store.move_note(&root_id, Some("Projects")).is_none());
        // Both notes are exactly where they were.
        assert_eq!(fs::read_to_string(dir.path().join("A.md")).unwrap(), "root copy");
        assert_eq!(
            fs::read_to_string(dir.path().join("Projects/A.md")).unwrap(),
            "folder copy"
        );
        assert!(!dir.path().join("Projects/A (2).md").exists());
        assert!(store.notes().iter().any(|n| n.id() == root_id));
        // The collision check is case-insensitive, like the filesystems are.
        let (dir, mut store) = nested_store_with(&[("b.md", "x"), ("Projects/B.md", "y")]);
        let id = store.notes().iter().find(|n| n.title() == "b").unwrap().id().to_string();
        assert!(store.move_note(&id, Some("Projects")).is_none());
        assert!(dir.path().join("b.md").exists());
    }

    /// A note filed from the Inbox has no incoming links to protect, so it
    /// takes the "(2)" name and files rather than refusing.
    #[test]
    fn filing_from_inbox_is_exempt() {
        let (dir, mut store) =
            store_with(&[("Journal.md", "kept"), ("Inbox/Journal.md", "fleeting")]);
        let fleeting = store
            .notes()
            .iter()
            .find(|n| crate::search::is_inbox_note(n))
            .unwrap()
            .clone();
        let filed = store.submit_from_inbox(&fleeting, None).unwrap();
        assert_eq!(filed.title(), "Journal (2)");
        assert!(!crate::search::is_inbox_note(&filed));
        assert!(dir.path().join("Journal (2).md").exists());
        assert!(!dir.path().join("Inbox/Journal.md").exists());
        // The note already at the root is untouched.
        assert_eq!(fs::read_to_string(dir.path().join("Journal.md")).unwrap(), "kept");
    }

    /// Sanitization can still change a title on the way ("What?" is a legal
    /// filename here but not on Windows). That's deterministic, not a
    /// collision, so the move goes ahead and references follow, as on rename.
    #[test]
    #[cfg(unix)]
    fn moving_a_note_whose_title_sanitizes_rewrites_its_links() {
        let (dir, mut store) = store_with(&[("What?.md", "x"), ("Hub.md", "see [[What?]]")]);
        let id = store.notes().iter().find(|n| n.title() == "What?").unwrap().id().to_string();
        let moved = store.move_note(&id, Some("Projects")).unwrap();
        assert_eq!(moved.title(), "What-");
        assert_eq!(
            fs::read_to_string(dir.path().join("Hub.md")).unwrap(),
            "see [[What-]]"
        );
    }

    /// A `../` in the destination refuses the move rather than escaping the
    /// vault (Mac 1.10.0 "Security").
    #[test]
    fn moving_into_a_traversing_subfolder_is_refused() {
        let (dir, mut store) = store_with(&[("A.md", "x")]);
        let id = store.notes()[0].id().to_string();
        assert!(store.move_note(&id, Some("../outside")).is_none());
        assert!(store.move_note(&id, Some("Work/../../outside")).is_none());
        assert!(dir.path().join("A.md").exists());
        assert!(!dir.path().parent().unwrap().join("outside").exists());
    }

    #[test]
    fn moving_creates_the_destination_folder() {
        let (dir, mut store) = store_with(&[("A.md", "x")]);
        let id = store.notes()[0].id().to_string();
        let moved = store.move_note(&id, Some("Brand/New")).unwrap();
        assert!(dir.path().join("Brand/New").is_dir());
        assert_eq!(store.subfolder_path(&moved), Some("Brand/New".to_string()));
    }

    // --- Folder & tag catalogs (1.8.8) --------------------------------------

    #[test]
    fn folder_counts_are_exact_or_descendant_most_used_first() {
        let (dir, store) = nested_store_with(&[
            ("Root.md", "x"),
            ("Projects/A.md", "x"),
            ("Projects/B.md", "x"),
            ("Projects/Work/C.md", "x"),
            ("Archive/D.md", "x"),
        ]);
        let _ = &dir;
        // A row's count equals what clicking it shows: folder:"Projects" is
        // exact-or-descendant, so Projects counts A, B *and* the nested Work/C
        // = 3. Work counts C = 1, Archive counts D = 1. Ordered most-used
        // first, ties alphabetical.
        assert_eq!(
            store.folder_counts(),
            vec![
                ("Projects".to_string(), 3),
                ("Archive".to_string(), 1),
                ("Projects/Work".to_string(), 1),
            ]
        );
    }

    #[test]
    fn tag_counts_are_most_used_first() {
        let (dir, store) = store_with(&[
            ("A.md", "#rust #tools"),
            ("B.md", "#rust here"),
            ("C.md", "#tools and #rust"),
        ]);
        let _ = &dir;
        assert_eq!(
            store.tag_counts(),
            vec![("rust".to_string(), 3), ("tools".to_string(), 2)]
        );
    }

    #[test]
    fn rename_folder_carries_nested_notes_and_leaves_titles_alone() {
        let (dir, mut store) = nested_store_with(&[
            ("Work/Sprint.md", "body"),
            ("Work/Deep/Note.md", "x"),
            ("Hub.md", "see [[Sprint]]"),
        ]);
        let out = store.rename_folder("Work", "Active");
        assert_eq!(out, Some("Active".to_string()));
        assert!(dir.path().join("Active/Sprint.md").exists());
        assert!(dir.path().join("Active/Deep/Note.md").exists());
        assert!(!dir.path().join("Work").exists());
        // The title never changed, so the link still resolves.
        let sprint = store.notes().iter().find(|n| n.title() == "Sprint").unwrap();
        assert_eq!(store.subfolder_path(sprint), Some("Active".to_string()));
    }

    #[test]
    fn rename_folder_can_refile_under_another_with_a_slash() {
        let (dir, mut store) = nested_store_with(&[("Work/A.md", "x")]);
        let out = store.rename_folder("Work", "Archive/Work");
        assert_eq!(out, Some("Archive/Work".to_string()));
        assert!(dir.path().join("Archive/Work/A.md").exists());
    }

    #[test]
    fn rename_folder_refuses_reserved_and_duplicate_targets() {
        let (dir, mut store) = nested_store_with(&[("Work/A.md", "x"), ("Taken/B.md", "x")]);
        let _ = &dir;
        // Onto a reserved name.
        assert_eq!(store.rename_folder("Work", "Templates"), None);
        assert_eq!(store.rename_folder("Work", "Inbox"), None);
        assert_eq!(store.rename_folder("Work", "Trash"), None);
        assert_eq!(store.rename_folder("Work", "Envy Data"), None);
        assert_eq!(store.rename_folder("Work", "envy data/Sub"), None);
        // Onto a folder that already exists.
        assert_eq!(store.rename_folder("Work", "Taken"), None);
        // No-op / empty targets.
        assert_eq!(store.rename_folder("Work", "Work"), None);
        assert_eq!(store.rename_folder("Work", "   "), None);
        // Work is still where it was.
        assert!(dir.path().join("Work/A.md").exists());
    }

    #[test]
    fn rename_folder_refuses_traversal_on_either_side() {
        let (dir, mut store) = nested_store_with(&[("Work/A.md", "x")]);
        assert_eq!(store.rename_folder("Work", "../Escaped"), None);
        assert_eq!(store.rename_folder("Work", "Ok/../../Escaped"), None);
        assert_eq!(store.rename_folder("../Work", "Elsewhere"), None);
        assert!(dir.path().join("Work/A.md").exists());
        assert!(!dir.path().parent().unwrap().join("Escaped").exists());
    }

    // --- Path safety (Mac 1.10.0 "Security") --------------------------------

    #[test]
    fn sanitized_subfolder_rejects_traversal_and_cleans_components() {
        // A legit nested path passes through.
        assert_eq!(
            sanitized_subfolder("Work/Retro notes").as_deref(),
            Some("Work/Retro notes")
        );
        // Doubled slashes collapse.
        assert_eq!(sanitized_subfolder("Work//Sub").as_deref(), Some("Work/Sub"));
        // A component's colon is rewritten.
        assert_eq!(sanitized_subfolder("Work:X/Sub").as_deref(), Some("Work-X/Sub"));
        // A `..` component is refused, wherever it sits.
        assert_eq!(sanitized_subfolder("../../etc"), None);
        assert_eq!(sanitized_subfolder(".."), None);
        assert_eq!(sanitized_subfolder("Work/../../etc"), None);
        // An empty path is None.
        assert_eq!(sanitized_subfolder("/ /"), None);
    }

    #[test]
    fn is_contained_keeps_a_resolved_path_within_the_base() {
        let base = Path::new("/tmp/TheIndex/Attachments");
        // A leaf inside the base is contained.
        assert!(is_contained(&base.join("photo.png"), base));
        // The base itself is contained.
        assert!(is_contained(base, base));
        // A ../ escape is not.
        assert!(!is_contained(&base.join("../../secret.png"), base));
        // Nor is a sibling folder.
        assert!(!is_contained(Path::new("/tmp/TheIndex/Other/x"), base));
    }

    /// A symlink can point anywhere, so the scan never follows one. Otherwise
    /// dropping an `Inbox` link into a vault would pull somebody else's notes
    /// into the list — and every write in this file assumes a note's path
    /// really is under the Index.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_inbox_is_not_scanned() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("Secret.md"), "not yours").unwrap();
        let (dir, _store) = store_with(&[("Real.md", "x")]);
        std::os::unix::fs::symlink(outside.path(), dir.path().join("Inbox")).unwrap();

        let store = NoteStore::open(dir.path(), false).unwrap();
        assert_eq!(titles(&store), vec!["Real"]);
    }

    /// `.trash` is emptied into the Recycle Bin wholesale, so a symlinked one
    /// would take the folder it points at with it.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_trash_is_ignored() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("Deleted.md"), "not yours").unwrap();
        let (dir, _store) = store_with(&[("Real.md", "x")]);
        std::os::unix::fs::symlink(outside.path(), dir.path().join(".trash")).unwrap();

        let store = NoteStore::open(dir.path(), false).unwrap();
        assert!(store.trashed_notes().is_empty());
        assert!(all_trash_directories(dir.path()).is_empty());
    }

    /// Same rule for a single file: a symlinked note would be saved, renamed
    /// and trashed through the link, writing wherever it pointed.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_note_in_the_root_is_skipped() {
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("Secret.md");
        fs::write(&target, "not yours").unwrap();
        let (dir, _store) = store_with(&[("Real.md", "x")]);
        std::os::unix::fs::symlink(&target, dir.path().join("Linked.md")).unwrap();

        let store = NoteStore::open(dir.path(), false).unwrap();
        assert_eq!(titles(&store), vec!["Real"]);
    }

    #[test]
    fn rename_tag_rewrites_on_word_boundaries_only() {
        let (dir, mut store) = store_with(&[
            ("A.md", "About #work today"),
            ("B.md", "A #workshop note, not the same"),
            ("C.md", "email a#work is not a tag"),
        ]);
        let _ = &dir;
        store.rename_tag("work", "job");
        let content = |t: &str| {
            store
                .notes()
                .iter()
                .find(|n| n.title() == t)
                .unwrap()
                .content()
                .to_string()
        };
        assert_eq!(content("A"), "About #job today");
        // #workshop and a#work are untouched.
        assert_eq!(content("B"), "A #workshop note, not the same");
        assert_eq!(content("C"), "email a#work is not a tag");
    }

    #[test]
    fn rename_tag_merges_into_an_existing_tag() {
        let (dir, mut store) = store_with(&[
            ("Both.md", "#old and #new"),
            ("OnlyOld.md", "just #old"),
        ]);
        let _ = &dir;
        store.rename_tag("old", "new");
        let tags_of = |t: &str| {
            let n = store.notes().iter().find(|n| n.title() == t).unwrap();
            let mut v: Vec<String> = n.tags().iter().cloned().collect();
            v.sort();
            v
        };
        // The note that had both now carries a single #new (tags dedup).
        assert_eq!(tags_of("Both"), vec!["new".to_string()]);
        assert_eq!(tags_of("OnlyOld"), vec!["new".to_string()]);
    }

    #[test]
    fn rename_tag_preserves_the_modified_time() {
        let (dir, mut store) = store_with(&[("A.md", "#old note")]);
        let before = fs::metadata(dir.path().join("A.md")).unwrap().modified().unwrap();
        store.rename_tag("old", "new");
        let after = fs::metadata(dir.path().join("A.md")).unwrap().modified().unwrap();
        assert_eq!(before, after, "a tag rename must not look like an edit");
    }

    fn extracted(s: &str) -> (String, String) {
        NoteStore::extracted_title_and_body(s)
    }

    #[test]
    fn extract_takes_the_first_line_as_the_title() {
        let (title, body) = extracted("Ship the report\nby Friday\nwith numbers");
        assert_eq!(title, "Ship the report");
        // The title's own line is dropped, so the note doesn't repeat itself.
        assert_eq!(body, "by Friday\nwith numbers");
    }

    #[test]
    fn extract_skips_leading_blank_lines() {
        let (title, body) = extracted("\n\n  Real title\nbody here");
        assert_eq!(title, "Real title");
        assert_eq!(body, "body here");
    }

    #[test]
    fn extract_strips_markdown_markers_from_the_title_only() {
        assert_eq!(extracted("## Ideas\n- one").0, "Ideas");
        assert_eq!(extracted("- [ ] Ship it\nnotes").0, "Ship it");
        assert_eq!(extracted("> A quote\nrest").0, "A quote");
        assert_eq!(extracted("12. Numbered thing\nrest").0, "Numbered thing");
        assert_eq!(extracted("* Starred\nrest").0, "Starred");
        // The body keeps its markers exactly as typed.
        assert_eq!(extracted("## Ideas\n- one").1, "- one");
    }

    /// A shortened title is a summary, not a copy — so the line it came from
    /// stays in the body rather than being lost.
    #[test]
    fn extract_keeps_everything_when_the_title_must_be_truncated() {
        let long = "a".repeat(80);
        let selection = format!("{long}\ntail");
        let (title, body) = extracted(&selection);
        assert_eq!(title.chars().count(), 60);
        assert_eq!(body, selection.trim());
    }

    #[test]
    fn extract_truncates_on_a_word_boundary_when_it_can() {
        let selection = "The quick brown fox jumps over the lazy dog and then keeps running onward forever";
        let (title, _) = extracted(selection);
        assert!(title.chars().count() <= 60, "{title:?}");
        // Broken between words, not mid-word.
        assert!(!title.ends_with(' '));
        assert!(selection.starts_with(&title), "{title:?}");
    }

    #[test]
    fn extract_falls_back_to_untitled() {
        assert_eq!(extracted("").0, "Untitled");
        assert_eq!(extracted("   \n\n  ").0, "Untitled");
        // A line that is nothing but markers leaves no name behind.
        assert_eq!(extracted("###\nbody").0, "Untitled");
    }

    /// Only the two characters that would change what path the name means,
    /// matching the Mac. The full Windows-legal treatment happens later, when
    /// the file is actually created.
    #[test]
    fn extract_replaces_path_separators_in_the_title() {
        assert_eq!(extracted("Q1/Q2: results\nbody").0, "Q1-Q2- results");
    }

    fn store_with(files: &[(&str, &str)]) -> (TempDir, NoteStore) {
        let dir = tempfile::tempdir().unwrap();
        for (rel, content) in files {
            let path = dir.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
        }
        let store = NoteStore::open(dir.path(), false).unwrap();
        (dir, store)
    }

    /// Same, but with subfolder scanning on — folder features are only
    /// meaningful when notes inside folders are actually listed.
    fn nested_store_with(files: &[(&str, &str)]) -> (TempDir, NoteStore) {
        let dir = tempfile::tempdir().unwrap();
        for (rel, content) in files {
            let path = dir.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
        }
        let store = NoteStore::open(dir.path(), true).unwrap();
        (dir, store)
    }

    fn titles(store: &NoteStore) -> Vec<String> {
        let mut t: Vec<String> = store.notes().iter().map(|n| n.title().to_string()).collect();
        t.sort();
        t
    }

    // --- Scanning -----------------------------------------------------------

    #[test]
    fn scan_reads_markdown_and_ignores_everything_else() {
        let (_d, store) = store_with(&[
            ("One.md", "first"),
            ("Two.md", "second"),
            ("notes.txt", "not a note"),
            ("image.png", "not a note"),
        ]);
        assert_eq!(titles(&store), vec!["One", "Two"]);
    }

    #[test]
    fn templates_are_never_notes() {
        let (_d, store) = store_with(&[("Real.md", "x"), ("Templates/Daily.md", "y")]);
        assert_eq!(titles(&store), vec!["Real"]);
        assert_eq!(store.templates().len(), 1);
        assert_eq!(store.templates()[0].name, "Daily");
    }

    #[test]
    fn trash_is_invisible_to_the_scan() {
        let (_d, store) = store_with(&[("Real.md", "x"), (".trash/Deleted.md", "y")]);
        assert_eq!(titles(&store), vec!["Real"]);
        // But it is visible as trash.
        assert_eq!(store.trashed_notes().len(), 1);
    }

    /// A vault synced from a Mac carries a visible `Trash/` (its deleted notes)
    /// and `Envy Data/` (its import ledger). Neither holds live notes, so the
    /// scan skips them like `Templates/` — while a user folder that merely
    /// shares the name deeper down is still a folder.
    #[test]
    fn mac_trash_and_envy_data_are_never_notes() {
        let (_d, store) = nested_store_with(&[
            ("Real.md", "x"),
            ("Trash/Deleted.md", "y"),
            ("Trash/Work/Older.md", "y"),
            ("Envy Data/Note-like.md", "z"),
            ("Projects/Trash/Kept.md", "w"),
        ]);
        assert_eq!(titles(&store), vec!["Kept", "Real"]);
        // Nothing of the Mac's Trash/ is mistaken for Linux trash either.
        assert!(store.trashed_notes().is_empty());
    }

    /// Inbox is read even with subfolder scanning off — a fleeting note that
    /// only appears when an unrelated setting is enabled is a lost note.
    #[test]
    fn inbox_is_read_even_when_subfolders_are_off() {
        let (_d, store) = store_with(&[("Filed.md", "x"), ("Inbox/Fleeting.md", "y")]);
        assert_eq!(titles(&store), vec!["Filed", "Fleeting"]);
    }

    #[test]
    fn other_subfolders_are_skipped_unless_enabled() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Projects")).unwrap();
        fs::write(dir.path().join("Top.md"), "x").unwrap();
        fs::write(dir.path().join("Projects/Nested.md"), "y").unwrap();

        let flat = NoteStore::open(dir.path(), false).unwrap();
        assert_eq!(titles(&flat), vec!["Top"]);

        let deep = NoteStore::open(dir.path(), true).unwrap();
        assert_eq!(titles(&deep), vec!["Nested", "Top"]);
    }

    // --- CRUD ---------------------------------------------------------------

    #[test]
    fn create_makes_a_file_and_disambiguates() {
        let (dir, mut store) = store_with(&[]);
        let a = store.create("Ideas").unwrap();
        assert_eq!(a.title(), "Ideas");
        assert!(dir.path().join("Ideas.md").exists());

        // The Mac's " (2)" shape, so the same collision names the same file on
        // every platform.
        let b = store.create("Ideas").unwrap();
        assert_eq!(b.title(), "Ideas (2)");
    }

    #[test]
    fn create_sanitizes_a_windows_illegal_title() {
        let (dir, mut store) = store_with(&[]);
        // Legal on macOS, impossible on Windows.
        let note = store.create("What? *now*").unwrap();
        assert_eq!(note.title(), "What- -now-");
        assert!(dir.path().join("What- -now-.md").exists());
    }

    #[test]
    fn save_writes_content_to_disk() {
        let (dir, mut store) = store_with(&[("A.md", "old")]);
        let mut note = store.notes()[0].clone();
        note.set_content("new");
        store.save(&note).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("A.md")).unwrap(), "new");
        assert_eq!(store.notes()[0].content(), "new");
    }

    /// Every derived value is cached per `(url, content)` pair, so a save has
    /// to leave the stored note with a *fresh* cache or the list keeps
    /// reporting the old due date, tags and badges forever. Removing a due
    /// token is the case that fails most visibly — the pill outlives the text
    /// that justified it.
    #[test]
    fn saving_recomputes_derived_values() {
        let (_d, mut store) = store_with(&[("A.md", "ship it @01-05-26 #alpha")]);
        let jan5 = NaiveDate::from_ymd_opt(2026, 1, 5).unwrap();
        assert_eq!(store.notes()[0].due(), Some(jan5));
        assert!(store.notes()[0].tags().contains("alpha"));

        // Change the date.
        let mut note = store.notes()[0].clone();
        note.set_content("ship it @02-09-26 #beta");
        store.save(&note).unwrap();
        assert_eq!(
            store.notes()[0].due(),
            Some(NaiveDate::from_ymd_opt(2026, 2, 9).unwrap())
        );
        assert!(store.notes()[0].tags().contains("beta"));
        assert!(!store.notes()[0].tags().contains("alpha"));

        // Remove it entirely.
        let mut note = store.notes()[0].clone();
        note.set_content("ship it, no date now");
        store.save(&note).unwrap();
        assert_eq!(store.notes()[0].due(), None);
        assert_eq!(store.notes()[0].due_date_count(), 0);
        assert!(store.notes()[0].tags().is_empty());
    }

    // --- Rename and link rewriting -----------------------------------------

    #[test]
    fn rename_moves_the_file() {
        let (dir, mut store) = store_with(&[("Old.md", "body")]);
        let note = store.notes()[0].clone();
        let renamed = store.rename(&note, "New").unwrap();
        assert_eq!(renamed.title(), "New");
        assert!(dir.path().join("New.md").exists());
        assert!(!dir.path().join("Old.md").exists());
    }

    #[test]
    fn rename_rewrites_links_and_embeds_across_the_index() {
        let (dir, mut store) = store_with(&[
            ("Old.md", "target"),
            ("Ref.md", "see [[Old]] and embed ![[Old]]"),
        ]);
        let note = store
            .notes()
            .iter()
            .find(|n| n.title() == "Old")
            .unwrap()
            .clone();
        store.rename(&note, "New").unwrap();

        let rewritten = fs::read_to_string(dir.path().join("Ref.md")).unwrap();
        assert_eq!(rewritten, "see [[New]] and embed ![[New]]");
    }

    /// `[[Old|yesterday's notes]]` must become `[[New|yesterday's notes]]`,
    /// not `[[New]]` — otherwise a rename silently discards the words the
    /// author wrote into their sentence.
    #[test]
    fn rename_preserves_aliases_and_heading_refs() {
        let (dir, mut store) = store_with(&[
            ("Old.md", "target"),
            ("Ref.md", "[[Old|yesterday's notes]] and [[Old#Agenda]]"),
        ]);
        let note = store
            .notes()
            .iter()
            .find(|n| n.title() == "Old")
            .unwrap()
            .clone();
        store.rename(&note, "New").unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("Ref.md")).unwrap(),
            "[[New|yesterday's notes]] and [[New#Agenda]]"
        );
    }

    #[test]
    fn rename_matches_links_case_insensitively() {
        let (dir, mut store) = store_with(&[("Old.md", "t"), ("Ref.md", "see [[old]]")]);
        let note = store
            .notes()
            .iter()
            .find(|n| n.title() == "Old")
            .unwrap()
            .clone();
        store.rename(&note, "New").unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("Ref.md")).unwrap(),
            "see [[New]]"
        );
    }

    /// The user renamed one note; they didn't edit thirty others. A
    /// reference-only rewrite must keep each referrer's modified date, or
    /// renaming a widely-linked note shoves every referrer to the top of a
    /// date-sorted list.
    #[test]
    fn rewriting_a_reference_does_not_bump_the_referrers_modified_date() {
        let (_d, mut store) = store_with(&[("Old.md", "t"), ("Ref.md", "see [[Old]]")]);
        let before = store
            .notes()
            .iter()
            .find(|n| n.title() == "Ref")
            .unwrap()
            .modified;

        let note = store
            .notes()
            .iter()
            .find(|n| n.title() == "Old")
            .unwrap()
            .clone();
        store.rename(&note, "New").unwrap();

        let after = store
            .notes()
            .iter()
            .find(|n| n.title() == "Ref")
            .unwrap()
            .modified;
        assert_eq!(before, after);
    }

    #[test]
    fn case_only_rename_does_not_disambiguate_into_a_new_name() {
        let (dir, mut store) = store_with(&[("test.md", "x")]);
        let note = store.notes()[0].clone();
        let renamed = store.rename(&note, "Test").unwrap();
        // Not "Test (2)" — the collision is with the file itself.
        assert_eq!(renamed.title(), "Test");
        assert!(dir.path().join("Test.md").exists());
    }

    #[test]
    fn creating_from_a_template_substitutes_tokens() {
        let (dir, mut store) = store_with(&[(
            "Templates/Daily.md",
            "# {{title}}\n\nWritten {{date}} at {{time}}.\n",
        )]);
        let template = store.templates()[0].clone();

        let note = store
            .create_from_template("Monday", &template, "2026-07-25", "9:30 AM")
            .unwrap();

        assert_eq!(note.title(), "Monday");
        assert_eq!(note.content(), "# Monday\n\nWritten 2026-07-25 at 9:30 AM.\n");
        assert!(dir.path().join("Monday.md").exists());
        // It lands in the Index, not in Templates/.
        assert!(!dir.path().join("Templates/Monday.md").exists());
    }

    /// An empty title falls back to the template's own name — and the *title*
    /// is substituted before use, so a template called "Daily {{date}}"
    /// produces a note named for today rather than the literal token.
    #[test]
    fn an_untitled_note_takes_the_templates_name_with_tokens_resolved() {
        let (dir, mut store) = store_with(&[("Templates/Daily {{date}}.md", "body {{title}}")]);
        let template = store.templates()[0].clone();

        let note = store
            .create_from_template("", &template, "2026-07-25", "9:30 AM")
            .unwrap();

        assert_eq!(note.title(), "Daily 2026-07-25");
        assert_eq!(note.content(), "body Daily 2026-07-25");
        assert!(dir.path().join("Daily 2026-07-25.md").exists());
    }

    #[test]
    fn converting_a_note_to_a_template_moves_it_out_of_the_index() {
        let (dir, mut store) = store_with(&[("Meeting.md", "## Agenda\n\n-"), ("Other.md", "x")]);
        let note = store
            .notes()
            .iter()
            .find(|n| n.title() == "Meeting")
            .unwrap()
            .clone();

        let template = store.convert_to_template(&note).unwrap();
        assert_eq!(template.name, "Meeting");
        assert!(dir.path().join("Templates/Meeting.md").exists());
        assert!(!dir.path().join("Meeting.md").exists());
        // Gone from the note list, present as a template.
        assert_eq!(titles(&store), vec!["Other"]);
        assert_eq!(store.templates().len(), 1);
        // The text is untouched — a template is just a note living elsewhere.
        assert_eq!(
            fs::read_to_string(dir.path().join("Templates/Meeting.md")).unwrap(),
            "## Agenda\n\n-"
        );
    }

    // --- Trash --------------------------------------------------------------

    #[test]
    fn delete_moves_to_trash_and_restore_brings_it_back() {
        let (dir, mut store) = store_with(&[("A.md", "body"), ("B.md", "other")]);
        let a = store
            .notes()
            .iter()
            .find(|n| n.title() == "A")
            .unwrap()
            .clone();

        store.delete(&[a]);
        assert_eq!(titles(&store), vec!["B"]);
        assert!(!dir.path().join("A.md").exists());
        assert!(dir.path().join(".trash/A.md").exists());
        assert_eq!(store.trashed_notes().len(), 1);
        assert!(store.can_restore_last_deleted());

        let restored = store.restore_last_deleted();
        assert_eq!(restored.len(), 1);
        assert_eq!(titles(&store), vec!["A", "B"]);
        assert!(dir.path().join("A.md").exists());
        assert!(store.trashed_notes().is_empty());
    }

    /// A bulk delete is one action for undo purposes.
    #[test]
    fn a_bulk_delete_restores_as_one_action() {
        let (_d, mut store) = store_with(&[("A.md", "x"), ("B.md", "y"), ("C.md", "z")]);
        let doomed: Vec<Note> = store
            .notes()
            .iter()
            .filter(|n| n.title() != "C")
            .cloned()
            .collect();
        store.delete(&doomed);
        assert_eq!(titles(&store), vec!["C"]);
        store.restore_last_deleted();
        assert_eq!(titles(&store), vec!["A", "B", "C"]);
    }

    /// Only notes whose trash move succeeded leave the list. A note whose file
    /// is already gone (or whose rename fails) stays listed rather than
    /// silently vanishing until the next full reload — the Mac's `delete(_:)`
    /// retains by the trashed set for the same reason.
    #[test]
    fn delete_keeps_a_note_whose_move_failed() {
        let (dir, mut store) = store_with(&[("A.md", "x"), ("B.md", "y")]);
        let doomed: Vec<Note> = store.notes().to_vec();
        // A's file disappears under us before the delete runs.
        fs::remove_file(dir.path().join("A.md")).unwrap();

        store.delete(&doomed);
        assert_eq!(titles(&store), vec!["A"]);
        assert!(dir.path().join(".trash/B.md").exists());
        assert!(!dir.path().join(".trash/A.md").exists());
        // And undo only knows about what was actually trashed.
        assert_eq!(store.restore_last_deleted().len(), 1);
        assert_eq!(titles(&store), vec!["A", "B"]);
    }

    /// A note whose original location has been reused is skipped rather than
    /// overwriting the new occupant.
    #[test]
    fn restore_skips_a_note_whose_slot_was_reused() {
        let (dir, mut store) = store_with(&[("A.md", "original")]);
        let a = store.notes()[0].clone();
        store.delete(&[a]);
        fs::write(dir.path().join("A.md"), "a different note").unwrap();

        let restored = store.restore_last_deleted();
        assert!(restored.is_empty());
        assert_eq!(
            fs::read_to_string(dir.path().join("A.md")).unwrap(),
            "a different note"
        );
    }

    #[test]
    fn save_attachment_writes_and_dedups() {
        let (dir, store) = store_with(&[("A.md", "x")]);
        let first = store.save_attachment(b"one", "Pasted image", "png").unwrap();
        let second = store.save_attachment(b"two", "Pasted image", "png").unwrap();
        assert_eq!(first, "Pasted image.png");
        assert_eq!(second, "Pasted image (2).png");
        assert!(dir.path().join("Attachments/Pasted image.png").exists());
        assert_eq!(
            fs::read(store.attachment_path(&second)).unwrap(),
            b"two".to_vec()
        );
    }

    #[test]
    fn copy_attachment_keeps_the_original_and_preserves_the_name() {
        let (dir, store) = store_with(&[("A.md", "x")]);
        let source = dir.path().join("photo.jpg");
        fs::write(&source, b"jpegbytes").unwrap();
        let stored = store.copy_attachment(&source).unwrap();
        assert_eq!(stored, "photo.jpg");
        assert!(source.exists()); // a copy, not a move
        assert!(dir.path().join("Attachments/photo.jpg").exists());
    }

    #[test]
    fn rename_attachment_moves_the_file_and_rewrites_references() {
        let (dir, mut store) = nested_store_with(&[
            ("A.md", "look ![[old.png|400]] here"),
            ("sub/B.md", "and ![[old.png]] again"),
            ("C.md", "no image, untouched"),
        ]);
        fs::create_dir_all(dir.path().join("Attachments")).unwrap();
        fs::write(dir.path().join("Attachments/old.png"), b"img").unwrap();

        let final_name = store.rename_attachment("old.png", "new.png").unwrap();
        assert_eq!(final_name, "new.png");
        assert!(!dir.path().join("Attachments/old.png").exists());
        assert!(dir.path().join("Attachments/new.png").exists());
        // The size suffix survives; every referencing note is rewritten.
        assert_eq!(
            fs::read_to_string(dir.path().join("A.md")).unwrap(),
            "look ![[new.png|400]] here"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("sub/B.md")).unwrap(),
            "and ![[new.png]] again"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("C.md")).unwrap(),
            "no image, untouched"
        );
    }

    /// An embed's name is untrusted note text: `![[../../secret.png]]` must
    /// resolve to a leaf inside `Attachments/`, never outside it.
    #[test]
    fn attachment_path_is_contained_to_a_leaf_in_attachments() {
        let (dir, store) = store_with(&[]);
        let attachments = dir.path().join("Attachments");
        assert_eq!(store.attachment_path("photo.png"), attachments.join("photo.png"));
        assert_eq!(
            store.attachment_path("../../secret.png"),
            attachments.join("secret.png")
        );
        assert_eq!(store.attachment_path("sub/dir/pic.png"), attachments.join("pic.png"));
        // `.`/`..`/empty never resolve to the folder itself.
        for bad in ["..", ".", "", "../"] {
            let p = store.attachment_path(bad);
            assert_eq!(p.parent(), Some(attachments.as_path()), "{bad:?}");
            assert_ne!(p, attachments, "{bad:?}");
        }
    }

    /// A rename moves a file, so a source that isn't a leaf inside
    /// `Attachments/` must be refused rather than relocating a note into it.
    #[test]
    fn rename_attachment_refuses_a_source_outside_attachments() {
        let (dir, mut store) = store_with(&[("A.md", "x")]);
        assert_eq!(store.rename_attachment("../A.md", "stolen.md"), None);
        assert!(dir.path().join("A.md").exists());
        assert!(!dir.path().join("Attachments/stolen.md").exists());
    }

    #[test]
    fn attachments_folder_is_not_a_note_or_a_listed_folder() {
        let (_dir, mut store) =
            nested_store_with(&[("Real.md", "x"), ("Attachments/pic.png", "notanote")]);
        // The image never becomes a note...
        assert_eq!(titles(&store), vec!["Real"]);
        store.reload();
        assert_eq!(titles(&store), vec!["Real"]);
        // ...and Attachments/ never shows up as a user folder.
        assert!(!store.subfolders().iter().any(|f| f == "Attachments"));
    }

    #[test]
    fn empty_trash_removes_everything() {
        let (dir, mut store) = store_with(&[("A.md", "x")]);
        let a = store.notes()[0].clone();
        store.delete(&[a]);
        assert_eq!(store.trashed_notes().len(), 1);

        store.empty_trash();
        assert!(store.trashed_notes().is_empty());
        assert!(!dir.path().join(".trash").exists());
    }

    #[test]
    fn restore_from_trash_returns_it_to_its_own_folder() {
        let (dir, mut store) = store_with(&[("Inbox/Fleeting.md", "x")]);
        let note = store.notes()[0].clone();
        store.delete(&[note]);
        assert!(dir.path().join("Inbox/.trash/Fleeting.md").exists());

        let trashed = store.trashed_notes()[0].clone();
        let restored = store.restore_from_trash(&trashed).unwrap();
        // Back to Inbox/, not the Index root — the trash folder's parent *is*
        // the folder it came from.
        assert_eq!(restored.url().parent().unwrap().file_name().unwrap(), "Inbox");
    }

    // --- Inbox --------------------------------------------------------------

    #[test]
    fn submit_moves_a_fleeting_note_into_the_index() {
        let (dir, mut store) = store_with(&[("Inbox/Captured.md", "a thought")]);
        let note = store.notes()[0].clone();
        let filed = store.submit_from_inbox(&note, None).unwrap();

        assert_eq!(filed.url().parent().unwrap(), dir.path());
        assert!(dir.path().join("Captured.md").exists());
        assert!(!dir.path().join("Inbox/Captured.md").exists());
        // The text is untouched — nothing about having been fleeting survives.
        assert_eq!(filed.content(), "a thought");
    }

    #[test]
    fn submit_refuses_a_note_that_is_not_fleeting() {
        let (_d, mut store) = store_with(&[("Filed.md", "x")]);
        let note = store.notes()[0].clone();
        assert!(store.submit_from_inbox(&note, None).is_none());
        assert!(store.submit_from_inbox(&note, Some("Projects")).is_none());
    }

    /// Mac 1.8.4: submit can file straight into a chosen folder, creating it
    /// on demand.
    #[test]
    fn submit_files_straight_into_a_subfolder() {
        let (dir, mut store) = nested_store_with(&[("Inbox/Filed Deep.md", "another")]);
        let note = store.notes()[0].clone();
        let filed = store.submit_from_inbox(&note, Some("Projects/Work")).unwrap();
        assert!(dir.path().join("Projects/Work/Filed Deep.md").exists());
        assert!(!crate::search::is_inbox_note(&filed));
        assert_eq!(store.subfolder_path(&filed), Some("Projects/Work".to_string()));
    }

    #[test]
    fn consecutive_inbox_submits_to_the_same_folder_both_land() {
        let (dir, mut store) = nested_store_with(&[]);
        let first = store.create_inbox_note("First Thought").unwrap();
        let second = store.create_inbox_note("Second Thought").unwrap();
        assert!(store.submit_from_inbox(&first, Some("Projects")).is_some());
        assert!(store.submit_from_inbox(&second, Some("Projects")).is_some());
        assert!(dir.path().join("Projects/First Thought.md").exists());
        assert!(dir.path().join("Projects/Second Thought.md").exists());
    }

    #[test]
    fn create_inbox_note_makes_the_folder_on_demand() {
        let (dir, mut store) = store_with(&[]);
        assert!(!dir.path().join("Inbox").exists());
        let note = store.create_inbox_note("Thought").unwrap();
        assert!(crate::search::is_inbox_note(&note));
        assert!(dir.path().join("Inbox/Thought.md").exists());
    }

    #[test]
    fn create_in_subfolder_files_the_note_and_makes_the_folder() {
        let (dir, mut store) = nested_store_with(&[]);
        let note = store.create_in_subfolder("Retro", "Projects/Work").unwrap();
        assert!(dir.path().join("Projects/Work/Retro.md").exists());
        // And it comes back scoped to that folder, so a caller can colour it.
        assert_eq!(
            subfolder_path(&note, dir.path()),
            Some("Projects/Work".to_string())
        );
    }

    #[test]
    fn create_in_subfolder_with_no_folder_lands_at_the_root() {
        let (dir, mut store) = nested_store_with(&[]);
        store.create_in_subfolder("Loose", "  ").unwrap();
        assert!(dir.path().join("Loose.md").exists());
    }

    /// An unusable (traversing) subfolder falls back to the root, the way the
    /// Mac's `create(title:inSubfolder:)` does, rather than escaping the vault.
    #[test]
    fn create_in_subfolder_falls_back_to_the_root_on_traversal() {
        let (dir, mut store) = nested_store_with(&[]);
        let note = store.create_in_subfolder("Safe", "../Escaped").unwrap();
        assert_eq!(note.url().parent(), Some(dir.path()));
        assert!(dir.path().join("Safe.md").exists());
        assert!(!dir.path().parent().unwrap().join("Escaped").exists());
    }
}
