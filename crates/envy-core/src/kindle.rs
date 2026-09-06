//! Kindle highlights import — a port of the Mac's `KindleClippings.swift`,
//! `KindleLedger.swift`, and `NoteStore.writeImportedNote`.
//!
//! Parses a Kindle's `My Clippings.txt` — the append-only plain-text file
//! every e-ink Kindle keeps of your highlights, typed notes, and bookmarks —
//! into structured records, and turns those into fleeting notes.
//!
//! Format, per record (separated by a line of ten `=`):
//!
//! ```text
//! Book Title (Author)
//! - Your Highlight on page 92 | Location 1387-1390 | Added on ...
//! (blank line)
//! the highlighted text
//! ==========
//! ```
//!
//! Parsing keys off structure (the `-` metadata line, the `|` separators,
//! the numbers) rather than English words wherever possible, so a Kindle in
//! another language still yields usable records: an unrecognizable type with
//! body text is treated as a highlight rather than dropped.
//!
//! **The ledger is synced between machines** (it lives inside the Index, in
//! `Envy Data/`), so [`Record::key`] must be byte-identical to the Mac's:
//! the SHA-256 hex of `"<type>|<book lowercased>|<location ?? page ?? ?>|<text>"`.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use fancy_regex::Regex;
use sha2::{Digest, Sha256};

use crate::filename;

/// The Index's folder for vault-bound derived state — data that belongs to
/// *this* collection of notes and should travel with it across machines (the
/// Kindle import ledger today). Visible, not a dot-folder: cloud clients skip
/// hidden items, so a hidden ledger would look synced while never leaving one
/// machine. `NoteStore.dataFolderName` on the Mac.
pub use crate::store::DATA_FOLDER_NAME;

const LEDGER_FILENAME: &str = "kindle-imported.json";

/// The Kindle's own name for the file, inside its `documents/` folder.
pub const CLIPPINGS_FILENAME: &str = "My Clippings.txt";

/// The most records one import will take from a Clippings file. A heavily used
/// Kindle produces a few thousand; anything far past that is the wrong file
/// (or a crafted one), and every record costs a note written to disk.
pub const MAX_RECORDS_PER_IMPORT: usize = 20_000;

// MARK: - Records

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordType {
    Highlight,
    Note,
    Bookmark,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub book: String,
    pub author: Option<String>,
    pub kind: RecordType,
    pub page: Option<u64>,
    pub location_start: Option<u64>,
    pub location_end: Option<u64>,
    pub text: String,
    /// A typed note whose location falls inside this highlight's range —
    /// Kindle stores them as separate records; pairing reunites the
    /// commentary with its passage.
    pub attached_note: Option<String>,
}

impl Record {
    /// Stable identity for the imported-ledger: same book, same place,
    /// same words → same key, across runs and file growth. Deliberately
    /// excludes the attached note, which has its own key — a note typed
    /// *after* a highlight was imported must not make the highlight look
    /// new again.
    pub fn key(&self) -> String {
        let position = match (self.location_start, self.page) {
            (Some(loc), _) => loc.to_string(),
            (None, Some(page)) => page.to_string(),
            (None, None) => "?".to_string(),
        };
        let kind = if self.kind == RecordType::Note { "note" } else { "highlight" };
        let basis = format!("{kind}|{}|{position}|{}", self.book.to_lowercase(), self.text);
        let digest = Sha256::digest(basis.as_bytes());
        digest.iter().map(|b| format!("{b:02x}")).collect()
    }
}

fn page_regex() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)page (\d+)").unwrap())
}

fn location_regex() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)location[s]? (\d+)(?:-(\d+))?").unwrap())
}

/// The first match's `group` as an integer — `None` when absent or, as with
/// Swift's `Int()`, when the digits don't fit.
fn first_int(regex: &Regex, group: usize, text: &str) -> Option<u64> {
    let captures = regex.captures(text).ok().flatten()?;
    captures.get(group)?.as_str().parse().ok()
}

/// Splits `Title (Author)` — the *last* parenthetical is the author, so a
/// title containing parens of its own survives.
pub fn split_title_line(line: &str) -> (String, Option<String>) {
    let trimmed = line.trim();
    let Some(open) = trimmed.ends_with(')').then(|| trimmed.rfind('(')).flatten() else {
        return (trimmed.to_string(), None);
    };
    let book = trimmed[..open].trim();
    let author = trimmed[open + 1..trimmed.len() - 1].trim();
    if book.is_empty() {
        return (trimmed.to_string(), None);
    }
    (
        book.to_string(),
        (!author.is_empty()).then(|| author.to_string()),
    )
}

/// Raw records in file order — bookmarks and empty-bodied records dropped,
/// no collapse or pairing yet (see [`parse`]).
fn raw_records(raw: &str) -> Vec<Record> {
    // Kindle writes UTF-8 with a BOM and CRLF line endings.
    let cleaned = raw
        .replace('\u{FEFF}', "")
        .replace("\r\n", "\n")
        .replace('\r', "\n");

    let mut records = Vec::new();
    for block in cleaned.split("==========") {
        let lines: Vec<&str> = block.split('\n').collect();
        let Some(title_index) = lines.iter().position(|l| !l.trim().is_empty()) else {
            continue;
        };
        if title_index + 1 >= lines.len() {
            continue;
        }
        let metadata = lines[title_index + 1].trim();
        if !metadata.starts_with('-') {
            continue;
        }

        let lowered = metadata.to_lowercase();
        let kind = if lowered.contains("bookmark") {
            RecordType::Bookmark
        } else if lowered.contains("note") {
            RecordType::Note
        } else {
            // "highlight", or a language we don't recognize — a body below
            // decides whether it's worth keeping either way.
            RecordType::Highlight
        };
        if kind == RecordType::Bookmark {
            continue;
        }

        let text = lines
            .get(title_index + 2..)
            .unwrap_or(&[])
            .join("\n")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }

        let (book, author) = split_title_line(lines[title_index]);
        let location_start = first_int(location_regex(), 1, metadata);
        records.push(Record {
            book,
            author,
            kind,
            page: first_int(page_regex(), 1, metadata),
            location_start,
            location_end: first_int(location_regex(), 2, metadata).or(location_start),
            text,
            attached_note: None,
        });
    }
    records
}

/// Swift's `String.count` counts grapheme clusters; `chars().count()` counts
/// scalars. The two only differ on combining sequences, and the comparison
/// here is between one highlight and its own re-drawn edges, so the ordering
/// they induce agrees in practice.
fn text_len(s: &str) -> usize {
    s.chars().count()
}

fn overlaps(candidate: &Record, book: &str, start: u64, end: u64) -> bool {
    candidate.book == book
        && matches!(
            (candidate.location_start, candidate.location_end),
            (Some(cs), Some(ce)) if cs <= end && ce >= start
        )
}

/// The full parse: raw records, then three refinements. (1) Boundary-nudge
/// collapse — adjusting a highlight's edges appends a fresh overlapping
/// record, so among same-book highlights with intersecting location ranges
/// only the longest text survives. (2) Autosave collapse — the Kindle saves
/// a typed note's every-few-seconds state as its own record at the same
/// anchor, so one note becomes a ladder of keystroke snapshots ("marc",
/// "marc andre", …); same book + same anchor is that one note being edited,
/// so only the last (most complete) survives. (3) Note pairing — a typed
/// note whose location falls inside a highlight's range attaches to it; the
/// rest stay standalone.
pub fn parse(raw: &str) -> Vec<Record> {
    let mut all = raw_records(raw);
    all.truncate(MAX_RECORDS_PER_IMPORT);
    let (raw_highlights, raw_notes): (Vec<Record>, Vec<Record>) = all
        .into_iter()
        .partition(|r| r.kind == RecordType::Highlight);

    // (1) Later duplicates replace earlier ones when longer, in place —
    // keeping first-seen order either way.
    //
    // Candidates are bucketed by book rather than scanned as one list. An
    // overlap needs an equal book, so the first same-book overlap in insertion
    // order is exactly what a scan of the whole vec found — but a file of many
    // books no longer compares every record against every earlier one, which
    // is what made a large Clippings file take minutes rather than seconds.
    let mut highlights: Vec<Record> = Vec::new();
    let mut by_book: HashMap<String, Vec<usize>> = HashMap::new();
    for record in raw_highlights {
        let existing = match (record.location_start, record.location_end) {
            (Some(start), Some(end)) => by_book.get(&record.book).and_then(|indices| {
                indices
                    .iter()
                    .copied()
                    .find(|&i| overlaps(&highlights[i], &record.book, start, end))
            }),
            _ => None,
        };
        match existing {
            Some(i) => {
                if text_len(&record.text) > text_len(&highlights[i].text) {
                    highlights[i] = record;
                }
            }
            None => {
                by_book.entry(record.book.clone()).or_default().push(highlights.len());
                highlights.push(record);
            }
        }
    }

    // (2) A typed note on an ebook anchors to a single Location, and the
    // Kindle edits it in place — re-emitting at that same Location — so a
    // later record at the same book + Location supersedes the earlier one,
    // keeping first-seen order; the autosave ladder collapses to its final
    // rung. Collapse ONLY location-anchored notes: page-only content (PDFs
    // and personal documents, where records carry a page but no Location)
    // can hold many genuinely distinct notes on one page, so those must
    // never collapse into each other.
    // Book + Location is an exact key, so this is a map lookup rather than a
    // scan of everything kept so far.
    let mut notes: Vec<Record> = Vec::new();
    let mut note_at: HashMap<(String, u64), usize> = HashMap::new();
    for note in raw_notes {
        let key = note.location_start.map(|location| (note.book.clone(), location));
        match key.as_ref().and_then(|k| note_at.get(k).copied()) {
            Some(i) => notes[i] = note,
            None => {
                if let Some(k) = key {
                    note_at.insert(k, notes.len());
                }
                notes.push(note);
            }
        }
    }

    // (3)
    let mut standalone = Vec::new();
    for note in notes {
        let host = note.location_start.and_then(|location| {
            by_book.get(&note.book).and_then(|indices| {
                indices
                    .iter()
                    .copied()
                    .find(|&i| overlaps(&highlights[i], &note.book, location, location))
            })
        });
        match host {
            Some(i) => {
                let attached = &mut highlights[i].attached_note;
                *attached = Some(match attached.take() {
                    Some(existing) => format!("{existing}\n{}", note.text),
                    None => note.text,
                });
            }
            None => standalone.push(note),
        }
    }
    highlights.extend(standalone);
    highlights
}

// MARK: - Note shaping

/// Which locator, if any, a highlight's title carries after the quote words —
/// the user's choice (Settings → Import). `Page` and `Location` each fall
/// back to the other when the book lacks the preferred one (a Kindle
/// highlight nearly always has a location, rarely a page), so the title is
/// never left bare unless `None` is chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TitleReference {
    #[default]
    Page,
    Location,
    Both,
    None,
}

impl TitleReference {
    /// The setting's stored form; anything unrecognized is the default,
    /// `Page` — matching the hand-written convention this feature automates.
    pub fn from_setting(raw: &str) -> Self {
        match raw {
            "location" => Self::Location,
            "both" => Self::Both,
            "none" => Self::None,
            _ => Self::Page,
        }
    }
}

/// The "p92" / "loc. 210" / "p92 · loc. 210" fragment for a record under the
/// chosen reference, or `None` when there's nothing to show.
fn reference_string(record: &Record, reference: TitleReference) -> Option<String> {
    let page = record.page.map(|p| format!("p{p}"));
    let location = record.location_start.map(|l| format!("loc. {l}"));
    match reference {
        TitleReference::None => None,
        TitleReference::Page => page.or(location),
        TitleReference::Location => location.or(page),
        TitleReference::Both => {
            let parts: Vec<String> = [page, location].into_iter().flatten().collect();
            (!parts.is_empty()).then(|| parts.join(" · "))
        }
    }
}

/// "first few words of the quote, p92" — the title convention. Up to
/// `word_limit` words, capped near 48 characters at a word boundary (one
/// word minimum, hard-clipped if that single word is itself huge), then the
/// chosen locator.
pub fn title(record: &Record, reference: TitleReference) -> String {
    title_with_limit(record, reference, 5)
}

fn title_with_limit(record: &Record, reference: TitleReference, word_limit: usize) -> String {
    let mut words: Vec<&str> = Vec::new();
    let mut length = 0;
    for word in record.text.split_whitespace() {
        if words.len() >= word_limit {
            break;
        }
        let count = text_len(word);
        if !words.is_empty() && length + count + 1 > 48 {
            break;
        }
        words.push(word);
        length += count + if words.len() > 1 { 1 } else { 0 };
    }
    let mut lead = words.join(" ");
    if text_len(&lead) > 48 {
        lead = lead.chars().take(48).collect();
    }
    if lead.is_empty() {
        lead = "Kindle highlight".to_string();
    }

    match reference_string(record, reference) {
        Some(reference) => format!("{lead}, {reference}"),
        None => lead,
    }
}

/// The fleeting note's body. A highlight is a blockquote with its attribution
/// (the book as a [[link]], dimmed until a book note exists, at which point
/// interlink: makes a per-book hub); a typed note is your own words, so it
/// stays plain. Deliberately no auto-tag — tagging is the user's call at
/// review time, not the importer's.
pub fn note_body(record: &Record, include_author: bool, include_location: bool) -> String {
    // Link through the same sanitizer note filenames use, so the link's
    // target matches the note you'd create by clicking it — otherwise a book
    // with a colon (most subtitles) links to "Book: Sub" while the created
    // file becomes "Book- Sub", the two never resolve, and the per-book
    // interlink: hub never forms. The book link is always present (it's the
    // hub); the author and location are the user's to omit (Settings →
    // Import).
    let mut attribution = format!("[[{}]]", filename::sanitize_title(&record.book));
    if include_author {
        if let Some(author) = &record.author {
            attribution.push_str(&format!(", {author}"));
        }
    }
    // "p92", matching the title's format (not "p. 92").
    if let Some(page) = record.page {
        attribution.push_str(&format!(" · p{page}"));
    }
    if include_location {
        if let Some(start) = record.location_start {
            let range = match record.location_end {
                Some(end) if end != start => format!("{start}-{end}"),
                _ => start.to_string(),
            };
            attribution.push_str(&format!(" · loc. {range}"));
        }
    }

    if record.kind == RecordType::Note {
        return format!("{}\n\n{attribution}\n", record.text);
    }
    let quoted: Vec<String> = record.text.split('\n').map(|l| format!("> {l}")).collect();
    let mut body = format!("{}\n", quoted.join("\n"));
    if let Some(note) = &record.attached_note {
        body.push_str(&format!("\n**My note:** {note}\n"));
    }
    body.push_str(&format!("\n{attribution}\n"));
    body
}

// MARK: - Ledger

/// The record of which Kindle highlights have already been imported into a
/// vault, so re-importing an append-only `My Clippings.txt` only ever adds
/// what's new. Vault-bound derived state: it lives inside the Index (in
/// `Envy Data/`) so it's per-vault and travels with the vault across machines
/// via whatever syncs it — not a preference, not per-machine. Just a set of
/// record fingerprints (see [`Record::key`]), stored as a JSON array.
pub mod ledger {
    use super::*;

    pub fn path(index_directory: &Path) -> PathBuf {
        index_directory.join(DATA_FOLDER_NAME).join(LEDGER_FILENAME)
    }

    pub fn decode(path: &Path) -> Option<BTreeSet<String>> {
        let data = std::fs::read(path).ok()?;
        let keys: Vec<String> = serde_json::from_slice(&data).ok()?;
        Some(keys.into_iter().collect())
    }

    /// The vault ledger, empty when there isn't one yet.
    pub fn load(index_directory: &Path) -> BTreeSet<String> {
        decode(&path(index_directory)).unwrap_or_default()
    }

    /// Wipes the ledger so the next import re-offers every highlight — for
    /// redoing imports with a changed title format, or recovering an Inbox
    /// you cleared. (Already-imported notes you kept aren't touched; you'd
    /// just get fresh copies of anything no longer present.)
    pub fn clear(index_directory: &Path) {
        let _ = std::fs::remove_file(path(index_directory));
    }

    pub fn save(keys: &BTreeSet<String>, index_directory: &Path) {
        let target = path(index_directory);
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(data) = serde_json::to_vec(keys) {
            let _ = write_atomically(&target, &data);
        }
    }
}

/// Write-then-rename, so a reader (a sync client, the watcher) never sees a
/// half-written file — the Mac's `.atomic` write option.
fn write_atomically(target: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&temp, data)?;
    if let Err(e) = std::fs::rename(&temp, target) {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }
    Ok(())
}

// MARK: - Writing notes

/// Writes a note straight to disk without a live store — the running app's
/// file-watcher (or an explicit reload) then surfaces it the same way it
/// would any external edit. Reuses the same filename disambiguation as
/// hand-made notes (" (2)", " (3)"…), so imported notes sit beside them
/// indistinguishably. `NoteStore.writeImportedNote` on the Mac.
///
/// Returns the file it wrote, or `None` if the write failed.
pub fn write_imported_note(
    title: &str,
    content: &str,
    date: SystemTime,
    directory: &Path,
) -> Option<PathBuf> {
    let _ = std::fs::create_dir_all(directory);
    let path = filename::available_path(title, directory);
    write_atomically(&path, content.as_bytes()).ok()?;
    // Stamp the modification date — that's what the list sorts on. (The Mac
    // stamps creation too; Linux filesystems don't expose a settable one.)
    let stamp = filetime::FileTime::from_system_time(date);
    let _ = filetime::set_file_times(&path, stamp, stamp);
    Some(path)
}

// MARK: - Import

#[derive(Debug, Clone, Copy)]
pub struct ImportOptions {
    pub title_reference: TitleReference,
    pub include_author: bool,
    pub include_location: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ImportSummary {
    pub imported: usize,
    pub already_imported: usize,
}

/// Parses `raw`, writes a fleeting note into `<index>/Inbox/` for every
/// record whose key isn't in the ledger, and records the newly written keys.
/// The whole file is scanned every time (it's append-only and small); only
/// new records cost anything. `progress(done, total)` is called after each
/// write.
pub fn import_clippings(
    raw: &str,
    index_directory: &Path,
    options: ImportOptions,
    mut progress: impl FnMut(usize, usize),
) -> ImportSummary {
    let parsed = parse(raw);
    let mut keys = ledger::load(index_directory);
    let fresh: Vec<&Record> = parsed.iter().filter(|r| !keys.contains(&r.key())).collect();
    let already_imported = parsed.len() - fresh.len();
    if fresh.is_empty() {
        return ImportSummary { imported: 0, already_imported };
    }

    let inbox = index_directory.join(crate::search::INBOX_FOLDER_NAME);
    let total = fresh.len();
    let mut written = 0;
    for (index, record) in fresh.iter().enumerate() {
        let wrote = write_imported_note(
            &title(record, options.title_reference),
            &note_body(record, options.include_author, options.include_location),
            SystemTime::now(),
            &inbox,
        );
        if wrote.is_some() {
            written += 1;
            keys.insert(record.key());
        }
        progress(index + 1, total);
    }
    ledger::save(&keys, index_directory);
    ImportSummary { imported: written, already_imported }
}

// MARK: - Device detection

/// `dir/name`, tolerating a case difference in `name` — a Kindle's
/// `documents` folder has been seen both ways across firmware and mounters.
fn child_ignore_case(dir: &Path, name: &str) -> Option<PathBuf> {
    let exact = dir.join(name);
    if exact.exists() {
        return Some(exact);
    }
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name))
        .map(|e| e.path())
}

/// The mounted Kindle's Clippings file, if one is available under any of
/// `roots` — any mount carrying `documents/My Clippings.txt` counts, rather
/// than trusting its volume name. Hidden entries are skipped.
pub fn find_clippings_under(roots: &[PathBuf]) -> Option<PathBuf> {
    for root in roots {
        let Ok(mounts) = std::fs::read_dir(root) else {
            continue;
        };
        let mut mounts: Vec<PathBuf> = mounts
            .filter_map(|e| e.ok())
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .map(|e| e.path())
            .collect();
        mounts.sort();
        for mount in mounts {
            let Some(documents) = child_ignore_case(&mount, "documents") else {
                continue;
            };
            if let Some(file) = child_ignore_case(&documents, CLIPPINGS_FILENAME) {
                if file.is_file() {
                    return Some(file);
                }
            }
        }
    }
    None
}

/// Where a USB-mounted Kindle appears: drive letters on Windows, the usual
/// removable-media mounts on Linux.
pub fn detection_roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        // Kindles show up as a removable drive, not the system volume. Walking
        // C:\ looking for documents/My Clippings.txt would be both slow and
        // a false-positive magnet.
        let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        (b'A'..=b'Z')
            .map(|c| format!("{}:", c as char))
            .filter(|letter| !letter.eq_ignore_ascii_case(&system))
            .map(|letter| PathBuf::from(format!("{}\\", letter)))
            .filter(|p| p.is_dir())
            .collect()
    }
    #[cfg(not(windows))]
    {
        let user = std::env::var("USER").ok().or_else(|| {
            std::env::var("HOME").ok().and_then(|h| {
                Path::new(&h)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
            })
        });
        let mut roots = Vec::new();
        if let Some(user) = &user {
            roots.push(PathBuf::from("/run/media").join(user));
            roots.push(PathBuf::from("/media").join(user));
        }
        roots.push(PathBuf::from("/media"));
        roots.push(PathBuf::from("/mnt"));
        roots
    }
}

/// The plugged-in Kindle's `My Clippings.txt`, if any.
pub fn detect_clippings_file() -> Option<PathBuf> {
    find_clippings_under(&detection_roots())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The SelfCheck fixture, verbatim: BOM up front, CRLF line endings.
    const SAMPLE: &str = "\u{FEFF}Cultish: The Language of Fanaticism (Montell, Amanda)\r\n\
- Your Highlight on page 92 | Location 1387-1390 | Added on Friday, July 25, 2026\r\n\
\r\n\
the swan suicide support group met on tuesdays\r\n\
==========\r\n\
Cultish: The Language of Fanaticism (Montell, Amanda)\r\n\
- Your Highlight on page 92 | Location 1387-1392 | Added on Friday, July 25, 2026\r\n\
\r\n\
the swan suicide support group met on tuesdays without fail\r\n\
==========\r\n\
Cultish: The Language of Fanaticism (Montell, Amanda)\r\n\
- Your Note on page 92 | Location 1389 | Added on Friday, July 25, 2026\r\n\
\r\n\
reminds me of the moonies study\r\n\
==========\r\n\
Cultish: The Language of Fanaticism (Montell, Amanda)\r\n\
- Your Bookmark on page 100 | Location 1500 | Added on Friday, July 25, 2026\r\n\
\r\n\
==========\r\n\
Deep Work (Newport, Cal)\r\n\
- Your Highlight at location 210-214 | Added on Saturday, July 26, 2026\r\n\
\r\n\
focus is the new IQ\r\n\
==========\r\n\
Deep Work (Newport, Cal)\r\n\
- Your Note at location 900 | Added on Saturday, July 26, 2026\r\n\
\r\n\
a standalone thought far from any highlight\r\n\
==========\r\n";

    fn cultish(records: &[Record]) -> &Record {
        records
            .iter()
            .find(|r| r.kind == RecordType::Highlight && r.book.starts_with("Cultish"))
            .unwrap()
    }

    fn deep_work(records: &[Record]) -> &Record {
        records
            .iter()
            .find(|r| r.kind == RecordType::Highlight && r.book == "Deep Work")
            .unwrap()
    }

    #[test]
    fn nudged_highlight_collapses_to_the_longest() {
        let records = parse(SAMPLE);
        assert_eq!(
            records
                .iter()
                .filter(|r| r.book.starts_with("Cultish") && r.kind == RecordType::Highlight)
                .count(),
            1
        );
        assert!(records.iter().any(|r| r.text.ends_with("without fail")));
    }

    #[test]
    fn bookmark_is_skipped() {
        assert_eq!(parse(SAMPLE).len(), 3);
    }

    #[test]
    fn a_note_inside_a_highlights_range_attaches_to_it() {
        let records = parse(SAMPLE);
        assert_eq!(
            cultish(&records).attached_note.as_deref(),
            Some("reminds me of the moonies study")
        );
    }

    #[test]
    fn a_note_far_from_any_highlight_stays_standalone() {
        let records = parse(SAMPLE);
        assert!(records
            .iter()
            .any(|r| r.kind == RecordType::Note && r.text.starts_with("a standalone")));
    }

    #[test]
    fn author_splits_off_the_last_parenthetical() {
        let records = parse(SAMPLE);
        assert_eq!(records[0].author.as_deref(), Some("Montell, Amanda"));
        assert_eq!(records[0].book, "Cultish: The Language of Fanaticism");
        // A title with parens of its own keeps them.
        assert_eq!(
            split_title_line("Thinking (Fast) and Slow (Kahneman, Daniel)"),
            ("Thinking (Fast) and Slow".to_string(), Some("Kahneman, Daniel".to_string()))
        );
        assert_eq!(split_title_line("No Author Here"), ("No Author Here".to_string(), None));
        assert_eq!(split_title_line("(Just Parens)"), ("(Just Parens)".to_string(), None));
    }

    #[test]
    fn title_is_first_words_plus_page() {
        let records = parse(SAMPLE);
        assert_eq!(
            title(cultish(&records), TitleReference::Page),
            "the swan suicide support group, p92"
        );
    }

    #[test]
    fn pageless_title_falls_back_to_location() {
        let records = parse(SAMPLE);
        assert_eq!(
            title(deep_work(&records), TitleReference::Page),
            "focus is the new IQ, loc. 210"
        );
    }

    #[test]
    fn title_reference_variants() {
        let records = parse(SAMPLE);
        let c = cultish(&records);
        assert_eq!(
            title(c, TitleReference::Location),
            "the swan suicide support group, loc. 1387"
        );
        assert_eq!(
            title(c, TitleReference::Both),
            "the swan suicide support group, p92 · loc. 1387"
        );
        assert_eq!(title(c, TitleReference::None), "the swan suicide support group");
        let d = deep_work(&records);
        assert_eq!(title(d, TitleReference::Page), "focus is the new IQ, loc. 210");
        assert_eq!(title(d, TitleReference::Both), "focus is the new IQ, loc. 210");
        assert_eq!(title(d, TitleReference::None), "focus is the new IQ");
    }

    #[test]
    fn title_caps_near_48_characters_at_a_word_boundary() {
        let long = Record {
            book: "B".into(),
            author: None,
            kind: RecordType::Highlight,
            page: Some(1),
            location_start: None,
            location_end: None,
            text: "supercalifragilistic expialidocious antidisestablishmentarianism words here".into(),
            attached_note: None,
        };
        // 20 + 1 + 14 = 35; adding " antidisestablishmentarianism" (29) would pass 48.
        assert_eq!(
            title(&long, TitleReference::Page),
            "supercalifragilistic expialidocious, p1"
        );
        let huge = Record {
            text: "a".repeat(60),
            ..long.clone()
        };
        assert_eq!(title(&huge, TitleReference::None), "a".repeat(48));
    }

    #[test]
    fn title_reference_setting_parses_with_page_default() {
        assert_eq!(TitleReference::from_setting("page"), TitleReference::Page);
        assert_eq!(TitleReference::from_setting("location"), TitleReference::Location);
        assert_eq!(TitleReference::from_setting("both"), TitleReference::Both);
        assert_eq!(TitleReference::from_setting("none"), TitleReference::None);
        assert_eq!(TitleReference::from_setting(""), TitleReference::Page);
        assert_eq!(TitleReference::from_setting("garbage"), TitleReference::Page);
    }

    #[test]
    fn body_quotes_attaches_the_note_links_the_book_and_adds_no_tag() {
        let records = parse(SAMPLE);
        let body = note_body(cultish(&records), true, true);
        assert!(body.contains("> the swan suicide support group met on tuesdays without fail"));
        assert!(body.contains("**My note:** reminds me of the moonies study"));
        assert!(body.contains(
            "[[Cultish- The Language of Fanaticism]], Montell, Amanda · p92 · loc. 1387-1392"
        ));
        assert!(!body.contains("#quote"));
        assert_eq!(
            body,
            "> the swan suicide support group met on tuesdays without fail\n\
             \n\
             **My note:** reminds me of the moonies study\n\
             \n\
             [[Cultish- The Language of Fanaticism]], Montell, Amanda · p92 · loc. 1387-1392\n"
        );
    }

    #[test]
    fn body_variants() {
        let records = parse(SAMPLE);
        let c = cultish(&records);
        assert!(note_body(c, false, true)
            .contains("[[Cultish- The Language of Fanaticism]] · p92 · loc. 1387-1392"));
        let b = note_body(c, true, false);
        assert!(b.contains("[[Cultish- The Language of Fanaticism]], Montell, Amanda · p92"));
        assert!(!b.contains("loc."));
        assert!(note_body(c, false, false).contains("[[Cultish- The Language of Fanaticism]] · p92"));

        // A typed note stays plain — no blockquote — and a single-location
        // range prints as one number.
        let standalone = records
            .iter()
            .find(|r| r.kind == RecordType::Note && r.book == "Deep Work")
            .unwrap();
        assert_eq!(
            note_body(standalone, true, true),
            "a standalone thought far from any highlight\n\n[[Deep Work]], Newport, Cal · loc. 900\n"
        );
    }

    // The Kindle autosaves a typed note's every-few-seconds state as its own
    // record at the same anchor; a whole ladder should collapse to its final
    // rung — whether the note is standalone or attaches to a highlight, and
    // even when a mid-typing typo breaks strict prefix growth ("andrese" →
    // "andreese" → "andreesen").
    const AUTOSAVE: &str = "Cultish (Montell, Amanda)\r\n\
- Your Highlight on page 26 | Location 328-332 | Added on Tuesday, July 28, 2026\r\n\
\r\n\
the US boasts a particularly consistent relationship with cults\r\n\
==========\r\n\
Cultish (Montell, Amanda)\r\n\
- Your Note on page 26 | Location 330 | Added on Tuesday, July 28, 2026 4:54:39 PM\r\n\
\r\n\
marc\r\n\
==========\r\n\
Cultish (Montell, Amanda)\r\n\
- Your Note on page 26 | Location 330 | Added on Tuesday, July 28, 2026 4:54:45 PM\r\n\
\r\n\
marc andrese\r\n\
==========\r\n\
Cultish (Montell, Amanda)\r\n\
- Your Note on page 26 | Location 330 | Added on Tuesday, July 28, 2026 4:55:07 PM\r\n\
\r\n\
marc andreesen - america is not western\r\n\
==========\r\n\
Sapiens (Harari, Yuval Noah)\r\n\
- Your Note at location 500 | Added on Tuesday, July 28, 2026 5:00:00 PM\r\n\
\r\n\
firs\r\n\
==========\r\n\
Sapiens (Harari, Yuval Noah)\r\n\
- Your Note at location 500 | Added on Tuesday, July 28, 2026 5:00:04 PM\r\n\
\r\n\
first draft of a standalone thought\r\n\
==========\r\n";

    #[test]
    fn an_autosave_ladder_collapses_to_its_final_rung() {
        let autosaved = parse(AUTOSAVE);
        let host = autosaved
            .iter()
            .find(|r| r.kind == RecordType::Highlight && r.book == "Cultish")
            .unwrap();
        assert_eq!(
            host.attached_note.as_deref(),
            Some("marc andreesen - america is not western")
        );
        assert!(!autosaved
            .iter()
            .any(|r| r.kind == RecordType::Note && r.book == "Cultish"));
        assert_eq!(
            autosaved
                .iter()
                .filter(|r| r.kind == RecordType::Note && r.book == "Sapiens")
                .count(),
            1
        );
        assert!(autosaved
            .iter()
            .any(|r| r.kind == RecordType::Note && r.text == "first draft of a standalone thought"));
    }

    // Page-only notes (PDFs / personal docs — a page but no Location) must
    // NOT collapse into each other: two distinct notes on one page are not an
    // autosave ladder. Only Location-anchored notes collapse.
    const PAGE_ONLY: &str = "Doc (Author)\r\n\
- Your Note on page 5 | Added on Tuesday, July 28, 2026\r\n\
\r\n\
remember to cite this\r\n\
==========\r\n\
Doc (Author)\r\n\
- Your Note on page 5 | Added on Tuesday, July 28, 2026\r\n\
\r\n\
a totally different second thought\r\n\
==========\r\n";

    #[test]
    fn two_distinct_notes_on_the_same_page_both_survive() {
        let parsed = parse(PAGE_ONLY);
        let notes: Vec<&Record> = parsed.iter().filter(|r| r.kind == RecordType::Note).collect();
        assert_eq!(notes.len(), 2);
        assert!(notes.iter().any(|r| r.text == "remember to cite this"));
        assert!(notes.iter().any(|r| r.text == "a totally different second thought"));
        // Page-only records key off the page, and title off it too.
        assert_eq!(title(notes[0], TitleReference::Page), "remember to cite this, p5");
        assert_eq!(title(notes[0], TitleReference::Location), "remember to cite this, p5");
    }

    #[test]
    fn keys_are_stable_across_parses() {
        let records = parse(SAMPLE);
        let again = parse(SAMPLE);
        let keys: Vec<String> = records.iter().map(Record::key).collect();
        assert_eq!(again.iter().map(Record::key).collect::<Vec<_>>(), keys);
        // Distinct records, distinct keys.
        let unique: BTreeSet<&String> = keys.iter().collect();
        assert_eq!(unique.len(), keys.len());
    }

    #[test]
    fn an_attached_note_does_not_change_its_highlights_key() {
        let records = parse(SAMPLE);
        let c = cultish(&records);
        let mut without = c.clone();
        without.attached_note = None;
        assert_eq!(without.key(), c.key());
    }

    /// The key's exact bytes: the ledger is synced between machines, so a
    /// Linux import must fingerprint a record exactly as the Mac does.
    /// `echo -n 'highlight|deep work|210|focus is the new IQ' | sha256sum`.
    #[test]
    fn key_is_sha256_of_the_mac_basis() {
        // printf '%s' 'highlight|deep work|210|focus is the new IQ' | sha256sum
        let records = parse(SAMPLE);
        assert_eq!(
            deep_work(&records).key(),
            "8902f8f92d0bb989b23cb7b6cc31505803c22b1ad22f70f1c58de6dd5897a706"
        );
        // A typed note fingerprints under "note"…
        let standalone = records
            .iter()
            .find(|r| r.kind == RecordType::Note && r.book == "Deep Work")
            .unwrap();
        assert_eq!(
            standalone.key(),
            "f6f9310e18f20e5757a93fc02b3a836dc08acafce8afa703ca8a33470765f492"
        );
        // …and a pageless, locationless record under "?", with the book
        // lowercased.
        let bare = Record {
            book: "B".into(),
            author: None,
            kind: RecordType::Highlight,
            page: None,
            location_start: None,
            location_end: None,
            text: "t".into(),
            attached_note: None,
        };
        assert_eq!(
            bare.key(),
            "6ec723caa3e968db690880ed0151dd290a6c6fbedcfc90bfc6f3f212e8099336"
        );
    }

    #[test]
    fn unrecognized_type_with_a_body_is_kept_as_a_highlight() {
        // A Kindle in another language: no "Highlight" word, but structure
        // and a body — keep it.
        let raw = "Libro (Autor)\r\n- Tu subrayado en la página 3 | posición 40-41 | Añadido el lunes\r\n\r\nhola mundo\r\n==========\r\n";
        let records = parse(raw);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, RecordType::Highlight);
        assert_eq!(records[0].text, "hola mundo");
        // Neither locator parsed, so the title is bare and the key uses "?".
        assert_eq!(title(&records[0], TitleReference::Page), "hola mundo");
    }

    #[test]
    fn a_block_without_a_metadata_line_is_dropped() {
        let raw = "Just a line\r\n==========\r\nTitle\r\nnot metadata\r\n\r\nbody\r\n==========\r\n";
        assert!(parse(raw).is_empty());
    }

    #[test]
    fn ledger_round_trips_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path();
        let keys: BTreeSet<String> = ["a", "b"].into_iter().map(String::from).collect();
        ledger::save(&keys, index);
        let expected = index.join("Envy Data/kindle-imported.json");
        assert!(expected.exists(), "ledger writes into the vault's Envy Data folder");
        assert_eq!(ledger::decode(&expected), Some(keys.clone()));
        assert_eq!(ledger::load(index), keys);
        // A JSON array of strings, as the Mac's JSONEncoder writes a Set<String>.
        assert_eq!(std::fs::read_to_string(&expected).unwrap(), r#"["a","b"]"#);

        ledger::clear(index);
        assert!(ledger::load(index).is_empty(), "clear removes the ledger, so a fresh load is empty");
        // Clearing twice is fine.
        ledger::clear(index);
    }

    #[test]
    fn ledger_reads_a_mac_written_file_in_any_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = ledger::path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"["zeta","alpha"]"#).unwrap();
        let loaded = ledger::load(dir.path());
        assert!(loaded.contains("zeta") && loaded.contains("alpha"));
        // Garbage is an empty ledger, not a crash.
        std::fs::write(&path, "not json").unwrap();
        assert!(ledger::load(dir.path()).is_empty());
    }

    #[test]
    fn write_imported_note_disambiguates_and_stamps_the_date() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("Inbox");
        let date = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let first = write_imported_note("Quote: one, p1", "> one\n", date, &inbox).unwrap();
        assert_eq!(first, inbox.join("Quote- one, p1.md"));
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "> one\n");
        let modified = std::fs::metadata(&first).unwrap().modified().unwrap();
        assert_eq!(modified, date);
        let second = write_imported_note("Quote: one, p1", "> two\n", date, &inbox).unwrap();
        assert_eq!(second, inbox.join("Quote- one, p1 (2).md"));
        // No temp files left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&inbox)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn import_writes_only_whats_new_and_remembers_it() {
        let dir = tempfile::tempdir().unwrap();
        let index = dir.path();
        let options = ImportOptions {
            title_reference: TitleReference::Page,
            include_author: true,
            include_location: true,
        };
        let mut ticks = Vec::new();
        let first = import_clippings(SAMPLE, index, options, |d, t| ticks.push((d, t)));
        assert_eq!(first, ImportSummary { imported: 3, already_imported: 0 });
        assert_eq!(ticks, vec![(1, 3), (2, 3), (3, 3)]);
        let inbox = index.join("Inbox");
        assert!(inbox.join("the swan suicide support group, p92.md").exists());
        assert!(inbox.join("focus is the new IQ, loc. 210.md").exists());
        assert!(inbox.join("a standalone thought far from, loc. 900.md").exists());
        assert_eq!(ledger::load(index).len(), 3);

        // Re-import: nothing new, even after the notes are filed elsewhere.
        std::fs::remove_file(inbox.join("focus is the new IQ, loc. 210.md")).unwrap();
        let second = import_clippings(SAMPLE, index, options, |_, _| {});
        assert_eq!(second, ImportSummary { imported: 0, already_imported: 3 });
        assert!(!inbox.join("focus is the new IQ, loc. 210.md").exists());

        // The file grew by one record: only that one comes in.
        let grown = format!(
            "{SAMPLE}Deep Work (Newport, Cal)\r\n- Your Highlight at location 300-301 | Added on Sunday\r\n\r\nnew passage\r\n==========\r\n"
        );
        let third = import_clippings(&grown, index, options, |_, _| {});
        assert_eq!(third, ImportSummary { imported: 1, already_imported: 3 });
        assert!(inbox.join("new passage, loc. 300.md").exists());

        // Forgetting the history re-offers everything.
        ledger::clear(index);
        let fourth = import_clippings(SAMPLE, index, options, |_, _| {});
        assert_eq!(fourth, ImportSummary { imported: 3, already_imported: 0 });
        assert!(inbox.join("the swan suicide support group, p92 (2).md").exists());
    }

    #[test]
    fn detection_finds_clippings_under_a_mount_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("run-media-user");
        std::fs::create_dir_all(root.join("Kindle/documents")).unwrap();
        std::fs::create_dir_all(root.join("USB Stick/photos")).unwrap();
        std::fs::create_dir_all(root.join(".hidden/documents")).unwrap();
        std::fs::write(root.join(".hidden/documents/My Clippings.txt"), "").unwrap();
        assert_eq!(find_clippings_under(&[root.clone()]), None);
        std::fs::write(root.join("Kindle/documents/My Clippings.txt"), "").unwrap();
        let found = find_clippings_under(&[dir.path().join("missing"), root.clone()]).unwrap();
        assert_eq!(
            found.canonicalize().unwrap(),
            root.join("Kindle/documents/My Clippings.txt").canonicalize().unwrap()
        );
        // A differently-cased documents folder still counts.
        let other = dir.path().join("media");
        std::fs::create_dir_all(other.join("KINDLE").join("Documents")).unwrap();
        std::fs::write(
            other.join("KINDLE").join("Documents").join("My Clippings.txt"),
            "",
        )
        .unwrap();
        let found = find_clippings_under(&[other.clone()]).unwrap();
        assert_eq!(
            found.canonicalize().unwrap(),
            other
                .join("KINDLE")
                .join("Documents")
                .join("My Clippings.txt")
                .canonicalize()
                .unwrap()
        );
    }
}
