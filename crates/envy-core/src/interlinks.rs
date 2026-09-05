//! The notes connected to the one you're reading.
//!
//! Three relationships, which the footer shows as three columns:
//!
//! - **Links** — notes this one points *out* to via `[[Title]]`.
//! - **Backlinks** — notes that point *at* this one.
//! - **Suggested** — other notes mentioned by name in this one's text but not
//!   linked yet, each a click away from being wired up.
//!
//! Suggested is the only one that reads the note's prose rather than its
//! resolved link set, and it is deliberately conservative: a mention only
//! counts on word boundaries, outside code, and outside an existing link.
//! Anything looser produces suggestions for fragments of longer words, which
//! is worse than missing one.

use std::collections::HashMap;
use std::sync::LazyLock;

use aho_corasick::{AhoCorasick, MatchKind};
use fancy_regex::Regex;

use crate::note::Note;

/// A note on the other end of a link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterlinkRef {
    pub id: String,
    pub title: String,
}

/// An unlinked mention, and the one occurrence a click would wrap.
///
/// Offsets are **UTF-16 code units**, not bytes. The editor that consumes
/// these is JavaScript, whose string indices are UTF-16, and handing it byte
/// offsets would silently misplace the wrap the moment a note contains a
/// non-ASCII character — an em dash, an accent, an emoji.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestion {
    pub title: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Interlinks {
    pub links: Vec<InterlinkRef>,
    pub backlinks: Vec<InterlinkRef>,
    pub suggested: Vec<Suggestion>,
}

impl Interlinks {
    pub fn count(&self) -> usize {
        self.links.len() + self.backlinks.len() + self.suggested.len()
    }

    pub fn is_empty(&self) -> bool {
        self.count() == 0
    }
}

static WIKI_LINK_FULL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!?\[\[[^\[\]]+\]\]").unwrap());
static INLINE_CODE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`\n]+`").unwrap());
static FENCED_CODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^```[^\n]*\n[\s\S]*?\n```[ \t]*$").unwrap());

fn ranges_of(re: &Regex, text: &str) -> Vec<(usize, usize)> {
    re.find_iter(text)
        .filter_map(|m| m.ok())
        .map(|m| (m.start(), m.end()))
        .collect()
}

fn overlaps(ranges: &[(usize, usize)], start: usize, end: usize) -> bool {
    ranges.iter().any(|&(a, b)| start < b && end > a)
}

/// Byte offset → UTF-16 code unit offset. See `Suggestion`.
fn utf16_offset(text: &str, byte_offset: usize) -> usize {
    text[..byte_offset].encode_utf16().count()
}

fn is_word_byte(text: &str, byte_index: usize) -> bool {
    text[byte_index..]
        .chars()
        .next()
        .is_some_and(|c| c.is_alphanumeric())
}

/// Whether the character *ending* at `byte_index` is alphanumeric.
fn prev_is_word(text: &str, byte_index: usize) -> bool {
    text[..byte_index]
        .chars()
        .next_back()
        .is_some_and(|c| c.is_alphanumeric())
}

/// One candidate note, as the suggestion pass sees it.
struct TitleEntry {
    id: String,
    /// The title as a suggestion would name it — trimmed, original case.
    title: String,
    /// Which automaton pattern this title lowercases to, or `None` for a
    /// title that can never be suggested (empty, or one whose lowercase
    /// changes byte length — see [`TitleMatcher`]).
    pattern: Option<usize>,
}

/// Every note title in the Index, prepared to be found in one pass over one
/// note's text.
///
/// This used to be a loop: lowercase each of the N titles, then substring-scan
/// the note for it. That is N scans of the same text per lookup, and at 30,000
/// notes it cost 36 ms for a well-linked note — on the Interlinks footer, which
/// redraws as you move between notes. An Aho-Corasick automaton finds all N at
/// once in a single pass, and since it depends only on the *set* of titles it
/// can be built once per Index instead of once per lookup (`NoteStore` caches
/// one and drops it when a note is created, renamed or deleted).
///
/// The matching rule is unchanged, and deliberately so: the automaton's
/// patterns are the same lowercased titles the loop searched for, run against
/// the same lowercased text, with the same word-boundary, code-span and
/// existing-link checks applied to each hit and the same "first qualifying
/// occurrence only" stop.
pub struct TitleMatcher {
    ac: AhoCorasick,
    entries: Vec<TitleEntry>,
}

impl TitleMatcher {
    /// `candidates` is `(note id, title)` in Index order — the order
    /// suggestions come back in.
    pub fn new(candidates: &[(&str, &str)]) -> Self {
        let mut patterns: Vec<String> = Vec::new();
        let mut pattern_of: HashMap<String, usize> = HashMap::new();
        let mut entries: Vec<TitleEntry> = Vec::with_capacity(candidates.len());

        for (id, raw_title) in candidates {
            let title = raw_title.trim();
            // Lowercasing can change byte lengths for some scripts, so a
            // match's offsets only index back into the original text when the
            // lowered title is the same length — which it is for the
            // overwhelming majority. When it isn't, the title is dropped
            // rather than reported at a wrong range: a missing suggestion is a
            // far smaller harm than a click that wraps the wrong span of
            // someone's note.
            let lower = title.to_lowercase();
            let pattern = if title.is_empty() || lower.len() != title.len() {
                None
            } else {
                Some(*pattern_of.entry(lower.clone()).or_insert_with(|| {
                    patterns.push(lower);
                    patterns.len() - 1
                }))
            };
            entries.push(TitleEntry {
                id: (*id).to_string(),
                title: title.to_string(),
                pattern,
            });
        }

        // `Standard` is what `find_overlapping_iter` requires, and overlapping
        // is what a title that is a substring of another needs: with "Art" and
        // "Artwork" both in the Index, a leftmost-first automaton would report
        // only one of them at a shared position.
        let ac = AhoCorasick::builder()
            .match_kind(MatchKind::Standard)
            .build(&patterns)
            // Only reachable at pattern counts far past any real vault; an
            // Index that large loses suggestions rather than failing to open.
            .unwrap_or_else(|_| AhoCorasick::new(Vec::<String>::new()).expect("empty automaton"));
        Self { ac, entries }
    }

    /// Titles mentioned in `text` but not linked. One result per title — the
    /// first occurrence that qualifies, matching the Mac's `break` after a
    /// hit. The note doing the mentioning is excluded by its own `self_id`.
    pub fn suggestions_in(&self, text: &str, self_id: &str) -> Vec<Suggestion> {
        if text.is_empty() || self.entries.is_empty() {
            return Vec::new();
        }
        let lower_text = text.to_lowercase();
        // Same length rule as for a title, for the same reason: without it the
        // offsets below would not index into `text`.
        if lower_text.len() != text.len() {
            return Vec::new();
        }
        let linked = ranges_of(&WIKI_LINK_FULL_RE, text);
        let mut code = ranges_of(&FENCED_CODE_RE, text);
        code.extend(ranges_of(&INLINE_CODE_RE, text));

        // Sparse rather than one slot per title: a note mentions a handful of
        // the Index, not tens of thousands of it.
        let mut found: HashMap<usize, (usize, usize)> = HashMap::new();
        // Where a pattern's next candidate may start, after a rejected match —
        // the `from = end.max(start + 1)` the per-title loop used, kept so a
        // title that overlaps itself is walked exactly as it was.
        let mut resume: HashMap<usize, usize> = HashMap::new();

        for hit in self.ac.find_overlapping_iter(&lower_text) {
            let pattern = hit.pattern().as_usize();
            let (start, end) = (hit.start(), hit.end());
            if found.contains_key(&pattern) || start < *resume.get(&pattern).unwrap_or(&0) {
                continue;
            }
            let before_word = start > 0 && prev_is_word(text, start);
            let after_word = end < text.len() && is_word_byte(text, end);
            if !before_word
                && !after_word
                && !overlaps(&linked, start, end)
                && !overlaps(&code, start, end)
            {
                found.insert(pattern, (utf16_offset(text, start), utf16_offset(text, end)));
            } else {
                resume.insert(pattern, end.max(start + 1));
            }
        }

        self.entries
            .iter()
            .filter(|e| e.id != self_id)
            .filter_map(|e| {
                let (start, end) = *found.get(&e.pattern?)?;
                Some(Suggestion {
                    title: e.title.clone(),
                    start,
                    end,
                })
            })
            .collect()
    }
}

/// Titles mentioned in `text` but not linked, against a one-off matcher.
///
/// The shape callers without an Index-wide cache use — the automaton is built
/// and thrown away, which is the right trade only when `candidates` is small.
pub fn suggested_links(text: &str, candidates: &[(&str, &str)]) -> Vec<Suggestion> {
    if candidates.is_empty() {
        return Vec::new();
    }
    TitleMatcher::new(candidates).suggestions_in(text, "")
}

/// Approximates `localizedStandardCompare` well enough for a sorted column:
/// case-insensitive, and digit runs compared numerically so "Note 2" precedes
/// "Note 10".
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take_num = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut n = String::new();
                    while let Some(c) = it.peek().copied() {
                        if c.is_ascii_digit() {
                            n.push(c);
                            it.next();
                        } else {
                            break;
                        }
                    }
                    n.trim_start_matches('0').to_string()
                };
                let (nx, ny) = (take_num(&mut ai), take_num(&mut bi));
                match nx.len().cmp(&ny.len()).then_with(|| nx.cmp(&ny)) {
                    std::cmp::Ordering::Equal => {}
                    other => return other,
                }
            }
            (Some(x), Some(y)) => {
                ai.next();
                bi.next();
                let (lx, ly) = (x.to_lowercase().to_string(), y.to_lowercase().to_string());
                match lx.cmp(&ly) {
                    std::cmp::Ordering::Equal => {}
                    other => return other,
                }
            }
        }
    }
}

/// Computes all three relationships for `note` against the whole Index,
/// building a throwaway [`TitleMatcher`]. `NoteStore::interlinks` is the
/// same thing over the cached one, and is what the app calls.
pub fn interlinks_for(note: &Note, all: &[Note]) -> Interlinks {
    let candidates: Vec<(&str, &str)> = all.iter().map(|n| (n.id(), n.title())).collect();
    interlinks_with(note, all, &TitleMatcher::new(&candidates))
}

/// [`interlinks_for`] against a matcher already built over `all`.
pub fn interlinks_with(note: &Note, all: &[Note], titles: &TitleMatcher) -> Interlinks {
    let self_title = note.lowercased_title().to_string();
    let outgoing = note.wiki_links();

    // Backlinks: most recently touched first — the useful order when asking
    // "what has been referring to this lately".
    let mut backlinks: Vec<&Note> = all
        .iter()
        .filter(|n| n.id() != note.id() && n.wiki_links().contains(&self_title))
        .collect();
    backlinks.sort_by_key(|n| std::cmp::Reverse(n.modified));

    // Outgoing links: alphabetical. These are a set the author chose, not a
    // feed, so a stable name order beats recency.
    let mut links: Vec<&Note> = all
        .iter()
        .filter(|n| n.id() != note.id() && outgoing.contains(n.lowercased_title()))
        .collect();
    links.sort_by(|a, b| natural_cmp(a.title(), b.title()));

    let mut suggested = titles.suggestions_in(note.content(), note.id());
    suggested.sort_by(|a, b| natural_cmp(&a.title, &b.title));

    let to_ref = |n: &&Note| InterlinkRef {
        id: n.id().to_string(),
        title: n.title().to_string(),
    };

    Interlinks {
        links: links.iter().map(to_ref).collect(),
        backlinks: backlinks.iter().map(to_ref).collect(),
        suggested,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn note_at(title: &str, content: &str, secs: u64) -> Note {
        Note::new(
            format!("C:/Index/{title}.md"),
            content,
            SystemTime::UNIX_EPOCH + Duration::from_secs(secs),
        )
    }

    fn note(title: &str, content: &str) -> Note {
        note_at(title, content, 0)
    }

    #[test]
    fn outgoing_links_resolve_to_existing_notes() {
        let all = vec![
            note("Source", "see [[Ideas]] and [[Missing Note]]"),
            note("Ideas", "target"),
        ];
        let got = interlinks_for(&all[0], &all);
        assert_eq!(got.links.len(), 1);
        assert_eq!(got.links[0].title, "Ideas");
        // A link to a note that doesn't exist isn't listed — there's nothing
        // to open.
        assert!(got.links.iter().all(|l| l.title != "Missing Note"));
    }

    #[test]
    fn backlinks_are_notes_pointing_here() {
        let all = vec![
            note("Ideas", "the target"),
            note("A", "see [[Ideas]]"),
            note("B", "no links"),
        ];
        let got = interlinks_for(&all[0], &all);
        assert_eq!(got.backlinks.len(), 1);
        assert_eq!(got.backlinks[0].title, "A");
    }

    #[test]
    fn backlinks_are_newest_first() {
        let all = vec![
            note("Ideas", "target"),
            note_at("Older", "[[Ideas]]", 100),
            note_at("Newer", "[[Ideas]]", 900),
        ];
        let got = interlinks_for(&all[0], &all);
        let titles: Vec<&str> = got.backlinks.iter().map(|b| b.title.as_str()).collect();
        assert_eq!(titles, vec!["Newer", "Older"]);
    }

    #[test]
    fn an_alias_link_still_backlinks_to_the_target() {
        let all = vec![
            note("Meeting Notes", "target"),
            note("A", "see [[Meeting Notes|last Tuesday]]"),
        ];
        assert_eq!(interlinks_for(&all[0], &all).backlinks.len(), 1);
    }

    #[test]
    fn a_note_never_links_to_itself() {
        let all = vec![note("Self", "I mention [[Self]] here")];
        let got = interlinks_for(&all[0], &all);
        assert!(got.links.is_empty());
        assert!(got.backlinks.is_empty());
        assert!(got.suggested.is_empty());
    }

    // --- Suggested -----------------------------------------------------------

    #[test]
    fn suggests_an_unlinked_mention() {
        let all = vec![
            note("Source", "I talked about Bauhaus yesterday."),
            note("Bauhaus", "target"),
        ];
        let got = interlinks_for(&all[0], &all);
        assert_eq!(got.suggested.len(), 1);
        assert_eq!(got.suggested[0].title, "Bauhaus");
        assert_eq!(&"I talked about Bauhaus yesterday."[15..22], "Bauhaus");
        assert_eq!((got.suggested[0].start, got.suggested[0].end), (15, 22));
    }

    #[test]
    fn does_not_suggest_what_is_already_linked() {
        let all = vec![
            note("Source", "I read [[Bauhaus]] again."),
            note("Bauhaus", "target"),
        ];
        assert!(interlinks_for(&all[0], &all).suggested.is_empty());
    }

    /// A mention inside a longer word isn't a mention. Without the boundary
    /// check, a note called "Art" would be suggested for every "start",
    /// "party" and "chart" in the Index.
    #[test]
    fn requires_word_boundaries() {
        let all = vec![
            note("Source", "restarting the artwork"),
            note("Art", "target"),
        ];
        assert!(interlinks_for(&all[0], &all).suggested.is_empty());
    }

    #[test]
    fn ignores_mentions_inside_code() {
        let all = vec![
            note("Source", "run `Bauhaus --help`\n\n```\nBauhaus\n```"),
            note("Bauhaus", "target"),
        ];
        assert!(interlinks_for(&all[0], &all).suggested.is_empty());
    }

    /// One title being a substring of another is exactly what a single-pass
    /// multi-pattern matcher can get wrong: "Art" sits inside "Artwork", and a
    /// leftmost-first scan would report only the longer one and lose the
    /// shorter note's suggestion (or vice versa). Both are real mentions here,
    /// and both must be offered.
    #[test]
    fn a_title_inside_another_title_is_still_suggested() {
        let all = vec![
            note("Source", "the Artwork sat beside the Art"),
            note("Artwork", "t"),
            note("Art", "t"),
        ];
        let got = interlinks_for(&all[0], &all);
        let named: Vec<(&str, usize, usize)> = got
            .suggested
            .iter()
            .map(|s| (s.title.as_str(), s.start, s.end))
            .collect();
        // "Art" is rejected inside "Artwork" by the word-boundary rule, so it
        // resolves to the standalone mention at the end.
        assert_eq!(named, vec![("Art", 27, 30), ("Artwork", 4, 11)]);
    }

    #[test]
    fn matches_case_insensitively() {
        let all = vec![note("Source", "about bauhaus"), note("Bauhaus", "t")];
        assert_eq!(interlinks_for(&all[0], &all).suggested.len(), 1);
    }

    /// Only the first qualifying occurrence is offered — one suggestion per
    /// title, matching the Mac's break after a hit.
    #[test]
    fn one_suggestion_per_title() {
        let all = vec![
            note("Source", "Bauhaus here and Bauhaus again"),
            note("Bauhaus", "t"),
        ];
        let got = interlinks_for(&all[0], &all);
        assert_eq!(got.suggested.len(), 1);
        assert_eq!((got.suggested[0].start, got.suggested[0].end), (0, 7));
    }

    /// Offsets are UTF-16 so the JS editor can use them directly. An em dash
    /// is 3 bytes but 1 UTF-16 unit, so a byte offset would land three
    /// characters late.
    #[test]
    fn offsets_are_utf16_not_bytes() {
        let text = "an em—dash then Bauhaus";
        let all = vec![note("Source", text), note("Bauhaus", "t")];
        let got = interlinks_for(&all[0], &all);
        let utf16: Vec<u16> = text.encode_utf16().collect();
        let s = got.suggested[0].start;
        let e = got.suggested[0].end;
        assert_eq!(String::from_utf16(&utf16[s..e]).unwrap(), "Bauhaus");
        assert_ne!(s, text.find("Bauhaus").unwrap(), "byte offset would differ");
    }

    #[test]
    fn counts_and_emptiness() {
        let all = vec![note("Lonely", "nothing here")];
        let got = interlinks_for(&all[0], &all);
        assert!(got.is_empty());
        assert_eq!(got.count(), 0);
    }

    #[test]
    fn natural_order_puts_note_2_before_note_10() {
        assert_eq!(natural_cmp("Note 2", "Note 10"), std::cmp::Ordering::Less);
        assert_eq!(natural_cmp("apple", "Banana"), std::cmp::Ordering::Less);
    }
}
