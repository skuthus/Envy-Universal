//! Envy's settings file: `~/.config/envy/config.md`.
//!
//! Every setting the app has lives in one markdown file with a single ```toml
//! fence in it. Markdown rather than plain toml so the file opens in Envy's
//! own editor and reads like a note, and one fence rather than a whole-file
//! parse so the prose around it is free — a user (or an agent) can explain
//! their own choices in it without breaking anything.
//!
//! `config/schema.json` is the only place a key is defined. Nothing here
//! hardcodes a key list: defaults, validation and the CLI's `config check`
//! all walk the embedded schema, so adding a setting there is the whole job.
//!
//! Writes preserve the file. `toml_edit` keeps comments, key order and
//! formatting through a GUI change, and the prose outside the fence is spliced
//! back untouched — the user's file stays the user's file.

use std::collections::HashMap;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};

use crate::themes::{self, ThemeFileDto};

// --- Where things live -------------------------------------------------------

/// `~/.config/envy` — deliberately not the Tauri app-config dir
/// (`app.envynote.linux`), which is a bundle identifier no one would think to
/// type. This path is part of the documented interface: agents and the skill
/// name it directly.
pub fn dir() -> PathBuf {
    dirs::config_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("envy")
}

/// `~/.config/envy`, for the "open folder" buttons.
pub fn config_dir() -> PathBuf {
    dir()
}

pub fn config_path() -> PathBuf {
    dir().join("config.md")
}

pub fn themes_dir() -> PathBuf {
    dir().join("themes")
}

/// Expands a leading `~` — the config file is written by hand, and a path in
/// it is far more likely to be typed as `~/Notes` than spelled out.
pub fn expand_tilde(raw: &str) -> PathBuf {
    let raw = raw.trim();
    if raw == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(raw));
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(raw)
}

// --- The schema --------------------------------------------------------------

/// The schema is compiled in rather than read from disk: `envynote config
/// check` has to work from an installed binary, where the repo is not around,
/// and a schema that could go missing at runtime would need a second answer
/// for what "valid" means.
const SCHEMA_JSON: &str = include_str!("../../config/schema.json");

#[derive(Deserialize)]
pub struct Schema {
    tables: Vec<SchemaTable>,
    maps: Vec<SchemaMap>,
    pub theme_tokens: ThemeTokens,
}

#[derive(Deserialize)]
struct SchemaTable {
    /// The toml table name; empty for the top-level keys.
    table: String,
    keys: Vec<SchemaKey>,
}

#[derive(Deserialize)]
struct SchemaKey {
    key: String,
    #[serde(rename = "type")]
    ty: String,
    default: Value,
    #[serde(default)]
    values: Option<Vec<Value>>,
    #[serde(default)]
    min: Option<f64>,
    #[serde(default)]
    max: Option<f64>,
}

#[derive(Deserialize)]
struct SchemaMap {
    table: String,
    value_type: String,
}

#[derive(Deserialize)]
pub struct ThemeTokens {
    pub meta: Vec<ThemeToken>,
    pub colors: Vec<ThemeToken>,
}

#[derive(Deserialize)]
pub struct ThemeToken {
    pub key: String,
    #[serde(default, rename = "type")]
    pub ty: Option<String>,
    #[serde(default)]
    pub values: Option<Vec<Value>>,
}

pub fn schema() -> &'static Schema {
    static SCHEMA: OnceLock<Schema> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(SCHEMA_JSON).expect("config/schema.json is compiled in and valid")
    })
}

// --- The markdown fence ------------------------------------------------------

/// The byte range of the settings fence's *body*, if the file has one.
///
/// The first ```toml fence wins; a second one is prose as far as this is
/// concerned. An unterminated fence runs to the end of the file rather than
/// counting as "no fence" — regenerating over a half-written fence would be a
/// worse answer than reading what is there.
pub(crate) fn fence_body(text: &str) -> Option<Range<usize>> {
    let mut offset = 0usize;
    let mut start: Option<usize> = None;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        match start {
            None => {
                if trimmed == "```toml" {
                    start = Some(offset + line.len());
                }
            }
            Some(begin) => {
                if trimmed == "```" {
                    return Some(begin..offset);
                }
            }
        }
        offset += line.len();
    }
    start.map(|begin| begin..text.len())
}

/// Puts `body` back in the file's fence, or — when the file has no fence —
/// appends one after whatever prose is already there. Nothing is ever
/// discarded: a file an agent has written notes into keeps them.
fn with_fence_body(text: &str, body: &str) -> String {
    let body = if body.is_empty() || body.ends_with('\n') {
        body.to_string()
    } else {
        format!("{body}\n")
    };
    match fence_body(text) {
        Some(range) => {
            let mut out = String::with_capacity(text.len() + body.len());
            out.push_str(&text[..range.start]);
            out.push_str(&body);
            out.push_str(&text[range.end..]);
            out
        }
        None => {
            let prose = text.trim_end();
            if prose.is_empty() {
                format!("{}\n```toml\n{body}```\n", HEADER.trim_end())
            } else {
                format!("{prose}\n\n```toml\n{body}```\n")
            }
        }
    }
}

/// The prose the file is created with. Short on purpose: the reference lives
/// in the skill, and a wall of comments here is a wall to scroll past.
const HEADER: &str = "\
# Envy settings

Edit here or in Settings; both stay in sync. Keys are documented in the envy
skill (`settings.md`); `envynote config check` validates this file.

";

// --- Values ------------------------------------------------------------------

/// The fence parsed as JSON, exactly as written — no defaults filled in. The
/// frontend layers the schema's defaults over this; keeping the file's own
/// content distinguishable is what lets a key be *unset* rather than "set to
/// the value that happens to be the default today".
pub(crate) fn parse_body(body: &str) -> (Map<String, Value>, Option<String>) {
    match toml::from_str::<Value>(body) {
        Ok(Value::Object(map)) => (map, None),
        Ok(_) => (Map::new(), Some("the toml block is not a table".to_string())),
        Err(e) => (
            Map::new(),
            Some(format!("cannot parse the toml block: {}", first_line(&e.to_string()))),
        ),
    }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

// --- Shortcut chords ---------------------------------------------------------

/// Every remappable shortcut id, from `SHORTCUT_SPECS` in `src/shortcut-specs.ts`.
///
/// Copied rather than shared because the frontend's list is TypeScript and
/// this has to work in a binary with no frontend loaded — `envynote config
/// check` is the whole point. The copy cannot drift: a test below parses
/// `src/shortcut-specs.ts` and fails if the two lists differ.
const SHORTCUT_IDS: [&str; 37] = [
    "summonApp",
    "showPinnedNote",
    "unpinFromTray",
    "keepOnTop",
    "jumpToSearch",
    "clearSearch",
    "newFromTemplate",
    "extractToNote",
    "insertImage",
    "insertTable",
    "deleteNote",
    "restoreDeletedNote",
    "togglePin",
    "pinToTray",
    "toggleLayout",
    "toggleInterlinks",
    "togglePlainTextMode",
    "centerWindow",
    "openSettings",
    "focusNextArea",
    "focusPreviousArea",
    "bold",
    "italic",
    "followLink",
    "peekLink",
    "toggleCheckbox",
    "retireDue",
    "emojiForLink",
    "popOut",
    "toggleSplit",
    "switchPane",
    "flipSplit",
    "moveToFolder",
    "toggleHelp",
    "zoomIn",
    "zoomOut",
    "actualSize",
];

/// The key names a chord may end in, beyond a single character. These are
/// `KeyboardEvent.key` values, because that is what `eventToBinding` in
/// `src/shortcuts.ts` builds a binding out of — a chord written any other way
/// (`Down` for `ArrowDown`, `Return` for `Enter`) can never match an event.
const KEY_NAMES: [&str; 15] = [
    "Enter",
    "Tab",
    "Escape",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Space",
];

/// The spellings people reach for that the frontend would never produce.
/// Named so the problem can say what to write instead.
const KEY_ALIASES: [(&str, &str); 10] = [
    ("down", "ArrowDown"),
    ("up", "ArrowUp"),
    ("left", "ArrowLeft"),
    ("right", "ArrowRight"),
    ("return", "Enter"),
    ("esc", "Escape"),
    ("del", "Delete"),
    ("pgup", "PageUp"),
    ("pgdn", "PageDown"),
    ("spacebar", "Space"),
];

/// A chord in the one form the app compares against: modifiers in the fixed
/// order Ctrl, Alt, Shift, then the key. `Err` is for a chord that cannot be
/// written at all here, not one that is merely spelled differently.
fn canonical_chord(raw: &str) -> Result<String, String> {
    let segments: Vec<&str> = raw.split('+').collect();
    let (mut ctrl, mut alt, mut shift) = (false, false, false);
    let mut index = 0;
    while index + 1 < segments.len() {
        match segments[index].trim().to_ascii_lowercase().as_str() {
            "ctrl" | "control" => ctrl = true,
            "alt" | "option" => alt = true,
            "shift" => shift = true,
            "meta" | "super" | "cmd" | "command" | "win" => {
                return Err("uses Meta/Super, which Envy cannot bind; use Ctrl, Alt or Shift"
                    .to_string())
            }
            _ => break,
        }
        index += 1;
    }
    // Whatever is left is the key, `+` included: "Ctrl++" is a real chord.
    let key = segments[index..].join("+");
    let key = key.trim();
    if key.is_empty() {
        return Err("has no key".to_string());
    }
    let key = if key.chars().count() == 1 {
        // Single characters normalise to upper case, so Shift does not change
        // a chord's identity.
        key.to_uppercase()
    } else if let Some(name) = KEY_NAMES.iter().find(|n| n.eq_ignore_ascii_case(key)) {
        (*name).to_string()
    } else if let Some((_, name)) = KEY_ALIASES
        .iter()
        .find(|(alias, _)| alias.eq_ignore_ascii_case(key))
    {
        (*name).to_string()
    } else if is_function_key(key) {
        key.to_uppercase()
    } else {
        return Err(format!("ends in `{key}`, which is not a key name"));
    };
    let mut out = String::new();
    if ctrl {
        out.push_str("Ctrl+");
    }
    if alt {
        out.push_str("Alt+");
    }
    if shift {
        out.push_str("Shift+");
    }
    out.push_str(&key);
    Ok(out)
}

fn is_function_key(key: &str) -> bool {
    let Some(number) = key.strip_prefix(['F', 'f']) else {
        return false;
    };
    matches!(number.parse::<u8>(), Ok(n) if (1..=24).contains(&n))
}

// --- Validation --------------------------------------------------------------

/// Everything wrong with a config file, in plain sentences meant to be printed
/// by `config check` and shown in Envy's footer. Never fatal: a bad value is
/// reported and the default is used, because a settings file that refuses to
/// load would take the app down with it.
pub fn validate(values: &Map<String, Value>) -> Vec<String> {
    let schema = schema();
    let mut problems = Vec::new();

    for (name, value) in values {
        // A top-level scalar is a root key; a table is a table.
        let table = schema.tables.iter().find(|t| &t.table == name);
        let map = schema.maps.iter().find(|m| &m.table == name);
        match value {
            Value::Object(entries) => {
                if let Some(table) = table {
                    for (key, value) in entries {
                        match table.keys.iter().find(|k| &k.key == key) {
                            Some(spec) => check_key(&mut problems, &format!("{name}.{key}"), spec, value),
                            None => problems.push(format!("unknown key `{name}.{key}`")),
                        }
                    }
                } else if let Some(map) = map {
                    for (key, value) in entries {
                        // Map tables take any key — except `[shortcuts]`,
                        // where a key is an id the app has to know or the
                        // line does nothing at all.
                        if map.table == "shortcuts" && !SHORTCUT_IDS.contains(&key.as_str()) {
                            problems.push(format!("unknown shortcut `{name}.{key}`"));
                            continue;
                        }
                        check_scalar(
                            &mut problems,
                            &format!("{name}.{key}"),
                            &map.value_type,
                            None,
                            None,
                            None,
                            value,
                        );
                    }
                } else {
                    problems.push(format!("unknown table `[{name}]`"));
                }
            }
            _ => {
                let root = schema.tables.iter().find(|t| t.table.is_empty());
                match root.and_then(|t| t.keys.iter().find(|k| &k.key == name)) {
                    Some(spec) => check_key(&mut problems, name, spec, value),
                    None => problems.push(format!("unknown key `{name}`")),
                }
            }
        }
    }
    problems
}

fn check_key(problems: &mut Vec<String>, path: &str, spec: &SchemaKey, value: &Value) {
    check_scalar(
        problems,
        path,
        &spec.ty,
        spec.values.as_deref(),
        spec.min,
        spec.max,
        value,
    );
}

fn check_scalar(
    problems: &mut Vec<String>,
    path: &str,
    ty: &str,
    values: Option<&[Value]>,
    min: Option<f64>,
    max: Option<f64>,
    value: &Value,
) {
    match ty {
        "bool" => {
            if !value.is_boolean() {
                problems.push(format!("{path}: expected true or false, found {}", show(value)));
            }
        }
        "int" => match value.as_i64() {
            Some(n) => check_range(problems, path, n as f64, min, max),
            None => problems.push(format!("{path}: expected a whole number, found {}", show(value))),
        },
        "number" => match value.as_f64() {
            Some(n) => check_range(problems, path, n, min, max),
            None => problems.push(format!("{path}: expected a number, found {}", show(value))),
        },
        "enum" => {
            let allowed = values.unwrap_or(&[]);
            if !allowed.iter().any(|v| v == value) {
                problems.push(format!(
                    "{path}: {} is not one of {}",
                    show(value),
                    allowed.iter().map(show).collect::<Vec<_>>().join(", ")
                ));
            }
        }
        // A theme is one of the built-in faces or the stem of a theme file, so
        // anything slug-shaped is allowed — the file may not exist yet.
        "theme" => match value.as_str() {
            Some(name) => {
                let built_in = values.unwrap_or(&[]).iter().any(|v| v.as_str() == Some(name));
                if !built_in && !themes::is_valid_name(name) {
                    problems.push(format!(
                        "{path}: {} is neither a built-in theme nor a theme file name \
                         (lowercase letters, digits and dashes)",
                        show(value)
                    ));
                }
            }
            None => problems.push(format!("{path}: expected a theme name, found {}", show(value))),
        },
        "chord" => match value.as_str() {
            Some(text) => match canonical_chord(text) {
                Ok(chord) if chord == text => {}
                Ok(chord) => problems.push(format!(
                    "{path}: \"{text}\" should be written \"{chord}\""
                )),
                Err(why) => problems.push(format!("{path}: \"{text}\" {why}")),
            },
            None => problems.push(format!(
                "{path}: expected a chord like \"Ctrl+Alt+N\", found {}",
                show(value)
            )),
        },
        "color" => match value.as_str() {
            Some(text) if is_hex_colour(text) => {}
            _ => problems.push(format!("{path}: expected a colour like \"#7aa2f7\", found {}", show(value))),
        },
        // string, path, chord, emoji: the shape beyond "some text" is the
        // frontend's business (a chord it cannot bind, an emoji that is a
        // word) and not worth failing a file over.
        _ => {
            if !value.is_string() {
                problems.push(format!("{path}: expected text, found {}", show(value)));
            }
        }
    }
}

fn check_range(problems: &mut Vec<String>, path: &str, n: f64, min: Option<f64>, max: Option<f64>) {
    let low = min.map(|m| n < m).unwrap_or(false);
    let high = max.map(|m| n > m).unwrap_or(false);
    if low || high {
        let range = match (min, max) {
            (Some(a), Some(b)) => format!("between {} and {}", trim_number(a), trim_number(b)),
            (Some(a), None) => format!("at least {}", trim_number(a)),
            (None, Some(b)) => format!("at most {}", trim_number(b)),
            (None, None) => return,
        };
        problems.push(format!("{path}: {} is out of range, expected {range}", trim_number(n)));
    }
}

fn trim_number(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn show(value: &Value) -> String {
    match value {
        Value::String(s) => format!("\"{s}\""),
        other => other.to_string(),
    }
}

/// `#rrggbb` or `#rrggbbaa`. Theme colours end up inside a stylesheet, so the
/// same rule `omarchy.rs` applies to Omarchy's palette applies here.
pub fn is_hex_colour(value: &str) -> bool {
    let Some(hex) = value.strip_prefix('#') else {
        return false;
    };
    (hex.len() == 6 || hex.len() == 8) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

// --- Reading and writing -----------------------------------------------------

/// What the frontend gets for the whole config: the file's own values, what is
/// wrong with them, and where it lives.
#[derive(Serialize, Clone)]
pub struct ConfigDto {
    pub path: String,
    pub values: Map<String, Value>,
    pub problems: Vec<String>,
    /// True only for the launch that created the file, which is the frontend's
    /// cue to migrate its localStorage settings in.
    pub fresh: bool,
}

/// A theme selection naming a file that is not there: the app falls back to
/// the Envious face, which looks like the setting being ignored. Checked
/// against the filesystem rather than in `validate`, which is pure so the
/// tests and `config check` agree wherever the file happens to live.
fn missing_theme(values: &Map<String, Value>, exists: impl Fn(&str) -> bool) -> Option<String> {
    let name = values.get("appearance")?.get("theme")?.as_str()?;
    let built_in = schema()
        .tables
        .iter()
        .find(|t| t.table == "appearance")?
        .keys
        .iter()
        .find(|k| k.key == "theme")?
        .values
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .any(|v| v.as_str() == Some(name));
    if built_in || !themes::is_valid_name(name) || exists(name) {
        // A name that isn't a slug is already reported by `validate`; saying
        // it twice helps nobody.
        return None;
    }
    Some(format!(
        "appearance.theme: there is no theme file named `{name}.md` in {}",
        themes_dir().display()
    ))
}

/// Set when this launch created config.md. A process-wide flag rather than a
/// return value because several windows may each call `config_load`, and every
/// one of them wants the same answer.
static FRESH: AtomicBool = AtomicBool::new(false);

pub fn read_text() -> String {
    std::fs::read_to_string(config_path()).unwrap_or_default()
}

pub fn load() -> ConfigDto {
    let text = read_text();
    let body = fence_body(&text).map(|r| text[r].to_string());
    let (values, syntax) = match &body {
        Some(body) => parse_body(body),
        None => (Map::new(), None),
    };
    let mut problems: Vec<String> = syntax.into_iter().collect();
    problems.extend(validate(&values));
    problems.extend(missing_theme(&values, |name| {
        themes_dir().join(format!("{name}.md")).is_file()
    }));
    ConfigDto {
        path: config_path().to_string_lossy().into_owned(),
        values,
        problems,
        fresh: FRESH.load(Ordering::Relaxed),
    }
}

/// Writes `text` as the whole file. Marks the write as Envy's own so the
/// watcher does not report it back as an external edit.
fn write_text(text: &str) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    mark_internal_write(&CONFIG_SUPPRESS);
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
}

/// Deep-merges `patch` into the fence, preserving everything else about the
/// file. A JSON `null` deletes the key it names — the only way to say "unset
/// this" over a wire where a missing key means "leave it alone".
pub fn merge(patch: &Value) -> Result<ConfigDto, String> {
    let updated = patched_text(&read_text(), patch)?;
    write_text(&updated)?;
    Ok(load())
}

/// The file with `patch` merged into its fence. Pure, so the awkward cases —
/// a file with no fence, a comment above a key being changed — are testable
/// without a config directory.
fn patched_text(text: &str, patch: &Value) -> Result<String, String> {
    let Some(patch) = patch.as_object() else {
        return Err("expected an object of settings".to_string());
    };
    let body = fence_body(text).map(|r| &text[r]).unwrap_or("");
    let mut doc: toml_edit::DocumentMut = body
        .parse()
        .map_err(|e| format!("cannot parse the toml block: {}", first_line(&format!("{e}"))))?;
    merge_into_table(doc.as_table_mut(), patch);
    Ok(with_fence_body(text, &doc.to_string()))
}

fn merge_into_table(table: &mut toml_edit::Table, patch: &Map<String, Value>) {
    for (key, value) in patch {
        match value {
            Value::Null => {
                table.remove(key);
            }
            Value::Object(entries) => {
                // Tables are created as they are needed, and a value that was
                // a scalar becomes a table rather than fighting it.
                if !table.get(key).map(|i| i.is_table_like()).unwrap_or(false) {
                    table.insert(key, toml_edit::Item::Table(toml_edit::Table::new()));
                }
                if let Some(sub) = table.get_mut(key).and_then(|i| i.as_table_mut()) {
                    merge_into_table(sub, entries);
                }
            }
            scalar => {
                if let Some(v) = to_toml_value(scalar) {
                    // Assigning through the existing item keeps its decor —
                    // the comment above it and the spacing around the `=`.
                    match table.get_mut(key) {
                        Some(item) if item.is_value() => *item = toml_edit::Item::Value(v),
                        _ => {
                            table.insert(key, toml_edit::Item::Value(v));
                        }
                    }
                }
            }
        }
    }
}

fn to_toml_value(value: &Value) -> Option<toml_edit::Value> {
    Some(match value {
        Value::Bool(b) => (*b).into(),
        Value::String(s) => s.as_str().into(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.into()
            } else {
                n.as_f64()?.into()
            }
        }
        Value::Array(items) => {
            let mut array = toml_edit::Array::new();
            for item in items {
                array.push(to_toml_value(item)?);
            }
            array.into()
        }
        _ => return None,
    })
}

/// The file a fresh install starts with: the header prose and every default
/// that is worth writing down, so opening it shows what can be changed rather
/// than an empty block.
fn default_file() -> String {
    let mut body = String::new();
    for table in &schema().tables {
        let mut lines = Vec::new();
        for key in &table.keys {
            // An empty default says "unset" (appearance.font_family), and
            // writing `font_family = ""` would read as a deliberate choice.
            if key.default.as_str().map(|s| s.is_empty()).unwrap_or(false) {
                continue;
            }
            if let Some(value) = to_toml_value(&key.default) {
                lines.push(format!("{} = {}", key.key, value.to_string().trim()));
            }
        }
        if lines.is_empty() {
            continue;
        }
        if !table.table.is_empty() {
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str(&format!("[{}]\n", table.table));
        }
        for line in lines {
            body.push_str(&line);
            body.push('\n');
        }
    }
    format!("{HEADER}```toml\n{body}```\n")
}

// --- Watching ----------------------------------------------------------------

/// How long after one of Envy's own writes a change to these files is ignored.
/// Long enough to outlast the debounce below, short enough that a real edit
/// landing right after a GUI change is still noticed. Same idea as
/// `SUPPRESS_WINDOW` in lib.rs, on a much quieter file.
const SUPPRESS_WINDOW: Duration = Duration::from_millis(700);

/// The burst wait. Editors save in several syscalls (truncate, write, rename)
/// and each one is an event; 150 ms is long enough to see them as one save and
/// short enough that a change feels live.
const DEBOUNCE: Duration = Duration::from_millis(150);

static CONFIG_SUPPRESS: Mutex<Option<Instant>> = Mutex::new(None);
static THEMES_SUPPRESS: Mutex<Option<Instant>> = Mutex::new(None);

fn mark_internal_write(stamp: &Mutex<Option<Instant>>) {
    *stamp.lock().unwrap() = Some(Instant::now() + SUPPRESS_WINDOW);
}

fn suppressed(stamp: &Mutex<Option<Instant>>) -> bool {
    stamp.lock().unwrap().map(|until| Instant::now() < until).unwrap_or(false)
}

pub fn mark_themes_write() {
    mark_internal_write(&THEMES_SUPPRESS);
}

/// Watches the config directory and the themes directory for edits made
/// anywhere else — an agent, `$EDITOR`, another Envy window — and tells every
/// window what changed. Non-recursive: nothing below these two directories is
/// ours.
pub fn spawn_watcher(app: AppHandle) {
    use notify::{RecursiveMode, Watcher};

    static WATCHING: AtomicBool = AtomicBool::new(false);
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }

    let (tx, rx) = std::sync::mpsc::channel::<Vec<PathBuf>>();
    let Ok(mut watcher) = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        // Only a change to what the file says counts. inotify also reports
        // every open and read as an Access event, and this module reads the
        // file each time it reports a change, so reacting to those would make
        // the watcher wake itself up forever.
        use notify::event::ModifyKind;
        use notify::EventKind;
        let relevant = matches!(
            event.kind,
            EventKind::Create(_)
                | EventKind::Remove(_)
                | EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Name(_) | ModifyKind::Any)
        );
        if !relevant {
            return;
        }
        let _ = tx.send(event.paths);
    }) else {
        return;
    };
    if watcher.watch(&dir(), RecursiveMode::NonRecursive).is_err() {
        return;
    }
    let _ = watcher.watch(&themes_dir(), RecursiveMode::NonRecursive);

    std::thread::spawn(move || {
        // Held for the life of the thread; dropping it stops the watch.
        let _watcher = watcher;
        let config = config_path();
        let themes = themes_dir();
        // What the file said the last time it was announced: an editor that
        // rewrites an identical file, or a save that only touched mtime, is
        // not a change anyone needs to re-apply.
        let mut announced = std::fs::read_to_string(&config).unwrap_or_default();
        while let Ok(first) = rx.recv() {
            let mut batch = first;
            while let Ok(more) = rx.recv_timeout(DEBOUNCE) {
                batch.extend(more);
            }
            let touched_config = batch.iter().any(|p| p == &config);
            let touched_themes = batch.iter().any(|p| p.starts_with(&themes) && p != &themes);
            let text_now = if touched_config {
                std::fs::read_to_string(&config).unwrap_or_default()
            } else {
                String::new()
            };
            let config_changed = touched_config && text_now != announced;
            if config_changed && !suppressed(&CONFIG_SUPPRESS) {
                announced = text_now;
                let _ = app.emit("config-changed", load());
                // The keys Rust owns are not the frontend's to re-apply.
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || crate::apply_config_owned(&handle));
            }
            if touched_themes && !suppressed(&THEMES_SUPPRESS) {
                let _ = app.emit("themes-changed", themes::list());
            }
        }
    });
}

// --- The agent skill ---------------------------------------------------------

/// Where the packaged skill lives, or the checkout's copy when running from
/// the build tree.
pub fn skill_source() -> Option<PathBuf> {
    let packaged = PathBuf::from("/usr/share/envy/agents/skills/envy");
    if packaged.is_dir() {
        return Some(packaged);
    }
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../agents/skills/envy");
    checkout.is_dir().then(|| checkout.canonicalize().unwrap_or(checkout))
}

/// Links the skill into the two places agents look, on every launch.
///
/// Only ever creates a link where there is nothing, or where the link is
/// dangling (an old install's path). A real directory, or a symlink the user
/// pointed somewhere else, is left exactly as it is — this is their agent
/// configuration, not ours.
#[cfg(unix)]
pub fn install_skill() {
    let Some(source) = skill_source() else { return };
    let Some(home) = dirs::home_dir() else { return };
    for target in [home.join(".claude/skills/envy"), home.join(".agents/skills/envy")] {
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let points_at = std::fs::read_link(&target).unwrap_or_default();
                if points_at == source {
                    continue;
                }
                // Dangling: the target of the link is gone, so it is ours to
                // repair. A link that resolves is somebody's choice.
                if target.exists() {
                    continue;
                }
                let _ = std::fs::remove_file(&target);
            }
            Ok(_) => continue,
            Err(_) => {}
        }
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::os::unix::fs::symlink(&source, &target);
    }
}

#[cfg(not(unix))]
pub fn install_skill() {
    let Some(source) = skill_source() else { return };
    let Some(home) = dirs::home_dir() else { return };
    for target in [home.join(r".claude\skills\envy"), home.join(r".agents\skills\envy")] {
        if target.exists() {
            continue;
        }
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = copy_dir(&source, &target);
    }
}

#[cfg(not(unix))]
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            let _ = std::fs::copy(entry.path(), to);
        }
    }
    Ok(())
}

// --- Startup -----------------------------------------------------------------

/// Creates the config directory on first launch and migrates the two settings
/// Rust used to keep in files of their own. Called before the store opens,
/// because `vault` decides which folder that is.
///
/// `index_path_file` and `keep_on_top_file` are left on disk after migrating:
/// a user who downgrades still has them, and nothing reads them again once the
/// config has the key.
pub fn init(index_path_file: Option<PathBuf>, keep_on_top_file: Option<PathBuf>) {
    let path = config_path();
    let _ = std::fs::create_dir_all(themes_dir());
    if !path.exists() && std::fs::write(&path, default_file()).is_ok() {
        FRESH.store(true, Ordering::Relaxed);
    }

    let created = FRESH.load(Ordering::Relaxed);
    let current = load().values;
    let mut patch = Map::new();
    // On the launch that creates the file, the old records win over the
    // defaults just written — that *is* the migration. Afterwards they are
    // only consulted for a key the file does not have.
    if created || !current.contains_key("vault") {
        if let Some(old) = index_path_file
            .and_then(|f| std::fs::read_to_string(f).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            patch.insert("vault".into(), Value::String(old));
        }
    }
    let has_keep_on_top = current
        .get("system")
        .and_then(|t| t.get("keep_on_top"))
        .is_some();
    if created || !has_keep_on_top {
        if let Some(old) = keep_on_top_file.and_then(|f| std::fs::read_to_string(f).ok()) {
            let mut system = Map::new();
            system.insert("keep_on_top".into(), Value::Bool(old.trim() == "true"));
            patch.insert("system".into(), Value::Object(system));
        }
    }
    // `list.vault_counts` became the two `[footer]` counts. Carry its value
    // across and drop the old key, so a file written before the split neither
    // loses the choice nor reports an unknown key.
    if let Some(old) = current
        .get("list")
        .and_then(|t| t.get("vault_counts"))
        .and_then(|v| v.as_bool())
    {
        let mut footer = Map::new();
        footer.insert("notes".into(), Value::Bool(old));
        footer.insert("folders".into(), Value::Bool(old));
        patch.insert("footer".into(), Value::Object(footer));
        let mut list = Map::new();
        list.insert("vault_counts".into(), Value::Null);
        patch.insert("list".into(), Value::Object(list));
    }
    // `system.floating` / `system.popout_floating` lived for one afternoon
    // before becoming `tiled` / `popout_tiled`, inverted. Nothing shipped with
    // them; a file that has them just loses them and takes the defaults.
    // `system.show_in_taskbar` went with them: GTK's skip-taskbar hint is
    // X11-only, so on Wayland it never did anything.
    let stale: Vec<&str> = ["floating", "popout_floating", "show_in_taskbar"]
        .into_iter()
        .filter(|k| current.get("system").and_then(|t| t.get(*k)).is_some())
        .collect();
    if !stale.is_empty() {
        let mut system = patch
            .remove("system")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        for k in stale {
            system.insert(k.to_string(), Value::Null);
        }
        patch.insert("system".into(), Value::Object(system));
    }
    // `[updates] check_automatically` gated a launch check that, on Linux,
    // never had anywhere to look. The table goes so an old file neither keeps
    // a dead switch nor reports an unknown table.
    if current.get("updates").is_some() {
        patch.insert("updates".into(), Value::Null);
    }
    if !patch.is_empty() {
        let _ = merge(&Value::Object(patch));
    }
}

/// One value from the file, by table and key. `table` empty means a root key.
fn value_of(table: &str, key: &str) -> Option<Value> {
    let values = load().values;
    if table.is_empty() {
        values.get(key).cloned()
    } else {
        values.get(table)?.get(key).cloned()
    }
}

/// The vault folder, if the file names one.
pub fn vault() -> Option<PathBuf> {
    value_of("", "vault")
        .and_then(|v| v.as_str().map(expand_tilde))
        .filter(|p| !p.as_os_str().is_empty())
}

pub fn keep_on_top() -> bool {
    value_of("system", "keep_on_top")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Whether the Index scans subfolders. Rust needs it when it re-opens the
/// store after a `vault` change made in the file.
pub fn include_subfolders() -> bool {
    value_of("index", "include_subfolders")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

pub fn autostart() -> bool {
    value_of("system", "autostart")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// `system.tiled`, inverted: the code thinks in "floating".
pub fn floating() -> bool {
    !value_of("system", "tiled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// `system.popout_tiled`, inverted likewise.
pub fn popout_floating() -> bool {
    !value_of("system", "popout_tiled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

pub fn hyprland_bind() -> bool {
    value_of("system", "hyprland_bind")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// The `[shortcuts]` overrides for the four chords Rust registers with the
/// compositor, defaults filled in. The frontend still calls
/// `set_global_shortcuts` once it is up; this is what runs before it.
pub fn global_shortcuts() -> HashMap<String, String> {
    const DEFAULTS: [(&str, &str); 4] = [
        ("summonApp", "Ctrl+Alt+Enter"),
        ("showPinnedNote", "Ctrl+Alt+ArrowDown"),
        ("unpinFromTray", "Ctrl+Alt+Shift+P"),
        ("keepOnTop", "Ctrl+Alt+Shift+T"),
    ];
    let overrides = load().values.get("shortcuts").cloned().unwrap_or(Value::Null);
    DEFAULTS
        .iter()
        .map(|(id, fallback)| {
            let chord = overrides
                .get(id)
                .and_then(|v| v.as_str())
                .unwrap_or(fallback)
                .to_string();
            ((*id).to_string(), chord)
        })
        .collect()
}

/// Writes one of Rust's own keys back to the file — the bar menu's Keep on
/// Top, Change Location…, autostart. The file stays the single truth, and
/// every window is told so its Settings pane matches.
pub fn set_owned(app: &AppHandle, table: &str, key: &str, value: Value) {
    let patch = if table.is_empty() {
        let mut map = Map::new();
        map.insert(key.to_string(), value);
        Value::Object(map)
    } else {
        let mut inner = Map::new();
        inner.insert(key.to_string(), value);
        let mut map = Map::new();
        map.insert(table.to_string(), Value::Object(inner));
        Value::Object(map)
    };
    if let Ok(dto) = merge(&patch) {
        let _ = app.emit("config-changed", dto);
    }
}

// --- Commands ----------------------------------------------------------------

#[tauri::command]
pub fn config_load() -> ConfigDto {
    load()
}

/// A settings change from the GUI. No `config-changed` for it — the window
/// that asked already knows — but the keys Rust owns are still re-applied, so
/// the frontend never has to remember which side of the boundary a setting
/// falls on.
#[tauri::command]
pub fn config_set(values: Value, app: AppHandle) -> Result<ConfigDto, String> {
    let dto = merge(&values)?;
    crate::apply_config_owned(&app);
    Ok(dto)
}

#[tauri::command]
pub fn config_read_text() -> String {
    read_text()
}

/// The whole file, as edited in Envy. Unlike `config_set` this does emit
/// `config-changed`: the editor is one window, and every other window (and
/// Rust's own keys) has to catch up.
#[tauri::command]
pub fn config_write_text(content: String, app: AppHandle) -> Result<ConfigDto, String> {
    write_text(&content)?;
    let dto = load();
    let _ = app.emit("config-changed", dto.clone());
    crate::apply_config_owned(&app);
    Ok(dto)
}

#[derive(Serialize)]
pub struct EnvyPaths {
    config: String,
    themes_dir: String,
    skill: Option<String>,
}

#[tauri::command]
pub fn envy_paths() -> EnvyPaths {
    EnvyPaths {
        config: config_path().to_string_lossy().into_owned(),
        themes_dir: themes_dir().to_string_lossy().into_owned(),
        skill: skill_source().map(|p| p.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub fn themes_list() -> Vec<ThemeFileDto> {
    themes::list()
}

#[tauri::command]
pub fn theme_read_text(name: String) -> Result<String, String> {
    themes::read_text(&name)
}

#[tauri::command]
pub fn theme_write_text(name: String, content: String, app: AppHandle) -> Result<ThemeFileDto, String> {
    let dto = themes::write_text(&name, &content)?;
    // Other windows keep their own list of theme files; a write here is a
    // change there.
    let _ = app.emit("themes-changed", themes::list());
    Ok(dto)
}

// --- CLI ---------------------------------------------------------------------

/// `envynote config …` / `envynote theme …`, handled before anything GTK
/// touches the display: these have to work over ssh and from an agent with no
/// session at all. Returns the exit code when the arguments were ours.
pub fn cli(args: &[String]) -> Option<i32> {
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["config", "path"] => {
            println!("{}", config_path().display());
            Some(0)
        }
        ["config", "check"] => Some(check()),
        ["config", "edit"] => Some(forward("edit-config")),
        // Names plus whatever is wrong with each file: an agent editing a
        // theme has no GUI to show it the problem.
        ["theme", "list"] => {
            for theme in themes::list() {
                println!("{}", theme.name);
                for problem in &theme.problems {
                    println!("  {problem}");
                }
            }
            Some(0)
        }
        ["theme", "check"] => Some(check_themes()),
        ["theme", "export", name] => {
            if !themes::is_valid_name(name) {
                eprintln!("theme export: name must be lowercase letters, digits and dashes");
                return Some(1);
            }
            Some(forward(&format!("export-theme {name}")))
        }
        ["config", ..] | ["theme", ..] => {
            eprintln!(
                "usage: envynote config check|path|edit\n       \
                 envynote theme list|check|export <name>"
            );
            Some(2)
        }
        _ => None,
    }
}

fn check() -> i32 {
    let path = config_path();
    if !path.exists() {
        println!("ok: {} (not created yet; defaults apply)", path.display());
        return 0;
    }
    let dto = load();
    if dto.problems.is_empty() {
        println!("ok: {}", dto.path);
        return 0;
    }
    for problem in &dto.problems {
        println!("{problem}");
    }
    1
}

fn check_themes() -> i32 {
    let themes = themes::list();
    let problems: Vec<&String> = themes.iter().flat_map(|t| &t.problems).collect();
    if problems.is_empty() {
        println!("ok: {} theme files in {}", themes.len(), themes_dir().display());
        return 0;
    }
    for problem in problems {
        println!("{problem}");
    }
    1
}

/// Verbs that need the running app: it owns the window and the resolved theme.
fn forward(verb: &str) -> i32 {
    if crate::control_send(verb) {
        0
    } else {
        eprintln!("envynote: Envy is not running");
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn body_of(text: &str) -> String {
        fence_body(text).map(|r| text[r].to_string()).unwrap_or_default()
    }

    #[test]
    fn reads_the_fence_and_leaves_the_prose_alone() {
        let text = "# Envy settings\n\nSome prose.\n\n```toml\nvault = \"~/Notes\"\n```\n\nMore prose.\n";
        assert_eq!(body_of(text), "vault = \"~/Notes\"\n");
        let updated = with_fence_body(text, "vault = \"~/Other\"\n");
        assert!(updated.starts_with("# Envy settings\n\nSome prose.\n"));
        assert!(updated.ends_with("More prose.\n"));
        assert_eq!(body_of(&updated), "vault = \"~/Other\"\n");
    }

    /// A file with no fence keeps everything it had and gains one at the end,
    /// so an agent's notes are never the price of a settings change.
    #[test]
    fn a_file_without_a_fence_gains_one_after_its_prose() {
        let text = "# My notes about Envy\n\nI like it here.\n";
        assert!(fence_body(text).is_none());
        let updated = with_fence_body(text, "vault = \"~/Notes\"\n");
        assert!(updated.starts_with("# My notes about Envy\n\nI like it here.\n"));
        assert_eq!(body_of(&updated), "vault = \"~/Notes\"\n");
    }

    #[test]
    fn an_unterminated_fence_runs_to_the_end() {
        let text = "```toml\nvault = \"~/Notes\"\n";
        assert_eq!(body_of(text), "vault = \"~/Notes\"\n");
    }

    /// The whole point of `toml_edit`: a GUI change must not eat the comments
    /// or reorder the keys somebody arranged by hand.
    #[test]
    fn merging_preserves_comments_and_order() {
        let body = "# where the notes live\nvault = \"~/Notes\"\n\n[list]\n# rows\ndensity = \"cozy\"\nsort = \"name\"\n";
        let mut doc: toml_edit::DocumentMut = body.parse().unwrap();
        merge_into_table(
            doc.as_table_mut(),
            json!({ "list": { "density": "comfy" } }).as_object().unwrap(),
        );
        let out = doc.to_string();
        assert!(out.contains("# where the notes live"));
        assert!(out.contains("# rows"));
        assert!(out.contains("density = \"comfy\""));
        // Order kept: density still before sort.
        assert!(out.find("density").unwrap() < out.find("sort").unwrap());
    }

    #[test]
    fn a_null_deletes_a_key_and_a_table_is_created_on_demand() {
        let mut doc: toml_edit::DocumentMut = "[list]\ndensity = \"cozy\"\n".parse().unwrap();
        merge_into_table(
            doc.as_table_mut(),
            json!({ "list": { "density": null }, "editor": { "zoom": 1.5 } })
                .as_object()
                .unwrap(),
        );
        let out = doc.to_string();
        assert!(!out.contains("density"));
        assert!(out.contains("zoom = 1.5"));
    }

    fn problems(body: &str) -> Vec<String> {
        let (values, syntax) = parse_body(body);
        let mut all: Vec<String> = syntax.into_iter().collect();
        all.extend(validate(&values));
        all
    }

    #[test]
    fn a_valid_file_has_no_problems() {
        let found = problems(
            "vault = \"~/Notes\"\n\n[list]\ndensity = \"comfy\"\nsort = \"name\"\n\n\
             [trash]\nempty_every = 30\n\n[editor]\nzoom = 1.5\n\n\
             [appearance]\ntheme = \"tokyo-night\"\n\n[shortcuts]\ntogglePin = \"Ctrl+Alt+P\"\n\n\
             [tag_colors]\nwork = \"#7aa2f7\"\n",
        );
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn an_unknown_key_is_a_problem() {
        let found = problems("[list]\ndensty = \"compact\"\n");
        assert_eq!(found, vec!["unknown key `list.densty`".to_string()]);
        let found = problems("[lst]\ndensity = \"compact\"\n");
        assert_eq!(found, vec!["unknown table `[lst]`".to_string()]);
        let found = problems("vaultt = \"~/Notes\"\n");
        assert_eq!(found, vec!["unknown key `vaultt`".to_string()]);
    }

    #[test]
    fn a_value_outside_the_enum_is_a_problem() {
        let found = problems("[list]\ndensity = \"tight\"\n");
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0],
            "list.density: \"tight\" is not one of \"compact\", \"cozy\", \"comfy\""
        );
    }

    #[test]
    fn an_out_of_range_number_is_a_problem() {
        let found = problems("[trash]\nempty_every = 200\n");
        assert_eq!(
            found,
            vec!["trash.empty_every: 200 is out of range, expected between 1 and 99".to_string()]
        );
        let found = problems("[editor]\nzoom = 9.0\n");
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].contains("out of range"));
    }

    #[test]
    fn the_wrong_type_is_a_problem() {
        let found = problems("[list]\nshow_date = \"yes\"\n");
        assert_eq!(
            found,
            vec!["list.show_date: expected true or false, found \"yes\"".to_string()]
        );
    }

    /// A map table takes any key, but its values still have a shape.
    #[test]
    fn map_values_are_checked_but_map_keys_are_not() {
        assert!(problems("[tag_colors]\nanything-at-all = \"#112233\"\n").is_empty());
        let found = problems("[tag_colors]\nwork = \"blue\"\n");
        assert_eq!(found.len(), 1);
        assert!(found[0].contains("expected a colour"));
    }

    /// A chord that is not in the frontend's canonical spelling never matches
    /// a key press, so it is reported with the spelling that would.
    #[test]
    fn a_chord_written_another_way_is_a_problem() {
        assert_eq!(
            problems("[shortcuts]\ntogglePin = \"Alt+Ctrl+P\"\n"),
            vec!["shortcuts.togglePin: \"Alt+Ctrl+P\" should be written \"Ctrl+Alt+P\"".to_string()]
        );
        assert_eq!(
            problems("[shortcuts]\nbold = \"ctrl+b\"\n"),
            vec!["shortcuts.bold: \"ctrl+b\" should be written \"Ctrl+B\"".to_string()]
        );
        assert_eq!(
            problems("[shortcuts]\nfocusNextArea = \"Ctrl+Alt+Down\"\n"),
            vec![
                "shortcuts.focusNextArea: \"Ctrl+Alt+Down\" should be written \"Ctrl+Alt+ArrowDown\""
                    .to_string()
            ]
        );
        let found = problems("[shortcuts]\nbold = \"Meta+B\"\n");
        assert_eq!(found.len(), 1);
        assert!(found[0].contains("Meta/Super"), "{found:?}");
        let found = problems("[shortcuts]\nbold = \"Ctrl+Wiggle\"\n");
        assert_eq!(found.len(), 1);
        assert!(found[0].contains("not a key name"), "{found:?}");
    }

    #[test]
    fn canonical_chords_are_left_alone() {
        for chord in [
            "Ctrl+Alt+Enter",
            "Ctrl+Alt+ArrowDown",
            "Ctrl+Alt+Shift+P",
            "Ctrl+,",
            "Ctrl+=",
            "Ctrl+0",
            "Alt+Backspace",
            "F5",
            "Ctrl+Shift+Space",
        ] {
            assert_eq!(canonical_chord(chord).as_deref(), Ok(chord));
        }
    }

    #[test]
    fn an_unknown_shortcut_id_is_a_problem() {
        assert_eq!(
            problems("[shortcuts]\nnewNote = \"Ctrl+N\"\n"),
            vec!["unknown shortcut `shortcuts.newNote`".to_string()]
        );
    }

    /// The id list is copied from TypeScript, so the copy is checked against
    /// the original every test run.
    #[test]
    fn the_shortcut_ids_match_the_frontends() {
        let source = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/shortcut-specs.ts"),
        )
        .expect("src/shortcut-specs.ts");
        let start = source.find("SHORTCUT_SPECS").expect("the specs array");
        let body = &source[start..];
        let end = body.find("\n]").expect("the end of the specs array");
        let re = regex::Regex::new(r"\{\s*id:\s*'(\w+)'").expect("a valid pattern");
        let ids: Vec<String> = re
            .captures_iter(&body[..end])
            .map(|c| c[1].to_string())
            .collect();
        assert_eq!(ids, SHORTCUT_IDS.to_vec(), "SHORTCUT_IDS is out of date");
    }

    /// Selecting a theme file that isn't there looks exactly like the setting
    /// being ignored, so it is called out.
    #[test]
    fn a_theme_that_names_no_file_is_a_problem() {
        let values = |body: &str| parse_body(body).0;
        assert!(missing_theme(&values("[appearance]\ntheme = \"omarchy\"\n"), |_| false).is_none());
        assert!(missing_theme(&values("[appearance]\ntheme = \"mine\"\n"), |n| n == "mine").is_none());
        let found = missing_theme(&values("[appearance]\ntheme = \"mine\"\n"), |_| false);
        assert!(found.unwrap().contains("no theme file named `mine.md`"));
    }

    #[test]
    fn a_broken_fence_is_reported_not_fatal() {
        let found = problems("vault = \n");
        assert_eq!(found.len(), 1);
        assert!(found[0].starts_with("cannot parse the toml block"));
    }

    /// The generated starter file has to be valid by its own rules, or every
    /// fresh install opens with a footer full of complaints.
    #[test]
    fn the_default_file_validates_and_round_trips() {
        let text = default_file();
        let body = body_of(&text);
        assert!(problems(&body).is_empty(), "{:?}", problems(&body));
        assert!(body.contains("vault = "));
        assert!(body.contains("[appearance]"));
        // No empty-string defaults written out as deliberate choices.
        assert!(!body.contains("font_family"));
    }

    #[test]
    fn every_schema_default_is_a_value_toml_can_hold() {
        for table in &schema().tables {
            for key in &table.keys {
                assert!(
                    to_toml_value(&key.default).is_some(),
                    "{}.{} has a default that is not a toml value",
                    table.table,
                    key.key
                );
            }
        }
    }

    /// A file that predates the fence (or one somebody wrote by hand as notes)
    /// is migrated by gaining a fence, not by being replaced.
    #[test]
    fn patching_a_file_without_a_fence_migrates_it() {
        let text = "# Envy settings\n\nMy own notes.\n";
        let out = patched_text(text, &json!({ "vault": "~/Notes", "system": { "keep_on_top": true } }))
            .unwrap();
        assert!(out.starts_with("# Envy settings\n\nMy own notes.\n"));
        let body = body_of(&out);
        assert!(body.contains("vault = \"~/Notes\""));
        assert!(body.contains("keep_on_top = true"));
        assert!(problems(&body).is_empty(), "{:?}", problems(&body));
        // And a second patch edits the fence it just made rather than adding
        // another one.
        let again = patched_text(&out, &json!({ "vault": "~/Other" })).unwrap();
        assert_eq!(again.matches("```toml").count(), 1);
        assert!(body_of(&again).contains("~/Other"));
    }

    #[test]
    fn tildes_expand_only_at_the_front() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand_tilde("~/Notes"), home.join("Notes"));
        assert_eq!(expand_tilde("/tmp/~/x"), PathBuf::from("/tmp/~/x"));
    }
}
