//! Times the operations that happen on a keystroke, against a real vault.
//!
//! Run with: cargo run --release --example bench -- "<path to a vault>"
//!
//! Add `--json` for the machine-readable form the perf gate reads: one JSON
//! object of medians, which `scripts/perf-check.sh` diffs against
//! `scripts/perf-baseline.json`. The human table stays the default, because
//! that is what you read when a number moved and you want to know why.
//!
//! Release only. A debug build measures the absence of optimisation, not the
//! code — the regex engine and the parallel scan are both several times slower
//! without it, and a number from a debug run would be misleading in the
//! direction that makes you fix the wrong thing.

use std::path::{Path, PathBuf};
use std::time::Instant;

use envy_core::{interlinks_for, NoteStore, SearchContext};

fn time<T>(label: &str, iterations: u32, mut f: impl FnMut() -> T) -> T {
    // One warm run first, so the figure reflects steady state rather than
    // whatever the first call had to fault in.
    let mut last = f();
    let start = Instant::now();
    for _ in 0..iterations {
        last = f();
    }
    let per = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iterations);
    println!("{label:<44} {per:>8.2} ms");
    last
}

fn main() {
    let mut json = false;
    let mut dir: Option<String> = None;
    for arg in std::env::args().skip(1) {
        if arg == "--json" {
            json = true;
        } else if !arg.starts_with("--") {
            dir = Some(arg);
        }
    }
    let dir = dir.unwrap_or_else(|| r"D:\Documents\Envy Benchmark".to_string());

    if json {
        return run_json(&dir);
    }
    run_human(&dir);
}

// --- the machine-readable gate ------------------------------------------------

/// The 5 timed samples an op is judged on, reduced to their median. The mean
/// would let one scheduler hiccup fail a build; the median needs three of five
/// runs to be slow before it moves, which is the shape of a real regression.
fn median_ms(mut f: impl FnMut()) -> f64 {
    const SAMPLES: usize = 5;
    f(); // warm
    let mut runs = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let start = Instant::now();
        f();
        runs.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    runs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    runs[SAMPLES / 2]
}

/// Same, for an op that cannot be warmed because the thing it costs *is* the
/// cold path — each sample gets its own store.
fn median_cold_ms(mut f: impl FnMut()) -> f64 {
    const SAMPLES: usize = 5;
    let mut runs = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let start = Instant::now();
        f();
        runs.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    runs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    runs[SAMPLES / 2]
}

/// Peak resident set of this process, from `/proc/self/status`' `VmHWM` —
/// the high-water mark, so it reports the worst moment of the run rather than
/// whatever happens to be resident at the end.
fn peak_rss_mb() -> f64 {
    let Ok(status) = std::fs::read_to_string("/proc/self/status") else {
        return 0.0;
    };
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            let kb: f64 = rest
                .split_whitespace()
                .next()
                .and_then(|n| n.parse().ok())
                .unwrap_or(0.0);
            return kb / 1024.0;
        }
    }
    0.0
}

/// What the frontend actually receives per row.
///
/// `NoteDto` itself lives in `src-tauri`, which this crate cannot see, so this
/// is the same field set rebuilt from the core's public note accessors — the
/// number is an approximation of the real payload, close enough to catch a
/// field quietly growing tenfold, not a byte-exact copy of what the IPC sends.
#[derive(serde::Serialize)]
struct BenchNoteDto {
    id: String,
    title: String,
    preview: String,
    modified_ms: u64,
    due: Option<String>,
    due_count: usize,
    tags: Vec<String>,
    is_inbox: bool,
    ai_provenance: String,
    has_unchecked_task: bool,
    subfolder: Option<String>,
}

impl BenchNoteDto {
    fn from_note(note: &envy_core::Note, root: &Path) -> Self {
        Self {
            id: note.id().to_string(),
            title: note.title().to_string(),
            preview: note.preview().to_string(),
            modified_ms: note
                .modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            due: note.due().map(|d| d.to_string()),
            due_count: note.due_date_count(),
            tags: note.tags().iter().cloned().collect(),
            is_inbox: envy_core::search::is_inbox_note(note),
            ai_provenance: format!("{:?}", note.ai_provenance()),
            has_unchecked_task: note.has_unchecked_task(),
            subfolder: envy_core::subfolder_path(note, root),
        }
    }
}

fn run_json(dir: &str) {
    let root = PathBuf::from(dir);

    // Cold open: its own store per sample, since a warm one measures nothing.
    // Subfolders on, unlike the human table's default — the gate should judge
    // the whole vault, not just the notes that happen to sit at the root.
    let mut cold: Option<NoteStore> = None;
    let cold_open = median_cold_ms(|| {
        cold = Some(NoteStore::open(dir, true).expect("open the vault"));
    });
    let mut store = cold.take().expect("a store");

    // The watcher's common case: one note edited outside Envy, one path in.
    let victim = store.notes().first().expect("a note").url().to_path_buf();
    let mut nudge = 0u64;
    let reload_one_file = median_ms(|| {
        nudge += 1;
        let body = std::fs::read_to_string(&victim).unwrap_or_default();
        let _ = std::fs::write(&victim, format!("{body}\n<!-- {nudge} -->"));
        store.reload_paths(std::slice::from_ref(&victim));
    });

    let ctx = SearchContext::now();
    let notes = store.notes();
    let search = |query: &str| {
        median_ms(|| {
            envy_core::filtered(notes, query, &ctx, Some(&root));
        })
    };
    let search_1char = search("a");
    let search_word = search("bauhaus");
    let search_8_terms = search("press, ink, paper, grid, poster, letter, colour, type");

    // The first page the list paints, serialized exactly as the IPC would.
    let hits = envy_core::filtered(notes, "", &ctx, Some(&root));
    let page: Vec<BenchNoteDto> = hits
        .iter()
        .take(300)
        .map(|n| BenchNoteDto::from_note(n, &root))
        .collect();
    let page_bytes = serde_json::to_vec(&page).map(|v| v.len()).unwrap_or(0);

    // The footer recomputes this on every note switch; the hub is the worst case.
    let hub = notes
        .iter()
        .max_by_key(|n| n.wiki_links().len())
        .expect("a note");
    let interlinks_hub = median_ms(|| {
        interlinks_for(hub, notes).count();
    });

    let folder_counts = median_ms(|| {
        store.folder_counts();
    });

    println!(
        "{{\"cold_open\":{cold_open:.3},\
\"reload_one_file\":{reload_one_file:.3},\
\"search_1char\":{search_1char:.3},\
\"search_word\":{search_word:.3},\
\"search_8_terms\":{search_8_terms:.3},\
\"search_page0_serialize_bytes\":{page_bytes},\
\"interlinks_hub\":{interlinks_hub:.3},\
\"folder_counts\":{folder_counts:.3},\
\"peak_rss_mb\":{:.3}}}",
        peak_rss_mb()
    );
}

// --- the human table ----------------------------------------------------------

fn run_human(dir: &str) {
    println!("vault: {dir}\n");

    let start = Instant::now();
    let mut store = NoteStore::open(dir, false).expect("open the vault");
    let open_ms = start.elapsed().as_secs_f64() * 1000.0;
    println!("{:<44} {open_ms:>8.2} ms", "cold open (scan + read every file)");
    println!("notes: {}\n", store.notes().len());

    time("reload (warm, OS cache hot)", 5, || store.reload());

    let ctx = SearchContext::now();
    let notes = store.notes();

    println!();
    for query in [
        "",
        "press",
        "bauhaus",
        "the quick brown",
        "\"deckle edge\"",
        "tag:design",
        "-tag:draft",
        "due:overdue",
        "due:week",
        "todo:",
        "link:\"Bauhaus Notes 0000\"",
        "orphan:",
        "ai:created",
        "inbox:",
        "folder:",
        "ghost:",
        "title:notes",
        "press, ink, paper",
    ] {
        let label = if query.is_empty() { "(empty query)" } else { query };
        time(&format!("search {label:?}"), 20, || {
            envy_core::filtered(notes, query, &ctx, Some(std::path::Path::new(dir))).len()
        });
    }

    println!();
    // The footer computes this for whichever note is open, so it runs on every
    // note switch — and "suggested" scans the whole corpus for mentions.
    let hub = notes
        .iter()
        .max_by_key(|n| n.wiki_links().len())
        .expect("a note");
    println!(
        "interlinks target: {:?} ({} outgoing links)",
        hub.title(),
        hub.wiki_links().len()
    );
    time("interlinks (links + backlinks + suggested)", 5, || {
        let r = interlinks_for(hub, notes);
        r.count()
    });

    println!();
    // Derived values are cached per note, so the first touch is the expensive
    // one. This is what a cold search pays.
    //
    // Deliberately NOT run through `time()`: that does an untimed warm-up call
    // before it starts the clock, which for a memoized value means it measures
    // the cached second touch. It reported 0.05 ms for work that actually costs
    // ~120 ms. Each of these gets its own store so the caches are genuinely
    // cold, and each is measured once, because there is only ever one first
    // touch.
    let once = |label: &str, f: &dyn Fn(&NoteStore) -> usize| {
        let fresh = NoteStore::open(dir, false).expect("reopen");
        let start = Instant::now();
        let n = f(&fresh);
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        println!("{label:<44} {ms:>8.2} ms  ({n})");
    };
    once("first touch: folded content", &|s| {
        s.notes().iter().filter(|n| n.folded_content().contains("the")).count()
    });
    once("first touch: tags", &|s| {
        s.notes().iter().map(|n| n.tags().len()).sum()
    });
    once("first touch: due dates", &|s| {
        s.notes().iter().filter(|n| n.due().is_some()).count()
    });
    once("first touch: previews (the list body)", &|s| {
        s.notes().iter().map(|n| n.preview().len()).sum()
    });
}
