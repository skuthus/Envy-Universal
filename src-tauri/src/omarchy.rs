//! Live Omarchy appearance: the current theme's `colors.toml` and the
//! system monospace font.
//!
//! Omarchy stages the active theme at `~/.local/state/omarchy/current/theme`
//! and rewrites that directory on every `omarchy theme set`. Font changes
//! land in `~/.config/fontconfig/fonts.conf`. We poll both so a running Envy
//! retints without a restart, matching terminals, the shell, and Obsidian.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const POLL: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OmarchyAppearance {
    pub colors: HashMap<String, String>,
    pub font: String,
    /// The current theme's directory name (`tokyo-night`, or a numeric id for
    /// an Aether-generated theme). It is what a per-theme override file in
    /// `~/.config/envy/themes/` is named after, so the frontend needs it to
    /// find one. `None` when Omarchy is not installed.
    pub theme: Option<String>,
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn colors_toml() -> Option<PathBuf> {
    home().map(|h| h.join(".local/state/omarchy/current/theme/colors.toml"))
}

fn theme_name_file() -> Option<PathBuf> {
    home().map(|h| h.join(".local/state/omarchy/current/theme.name"))
}

fn fontconfig_file() -> Option<PathBuf> {
    home().map(|h| h.join(".config/fontconfig/fonts.conf"))
}

fn file_stamp(path: &Path) -> u128 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn fingerprint() -> String {
    let colors = colors_toml().map(|p| file_stamp(&p)).unwrap_or(0);
    let name = theme_name_file().map(|p| file_stamp(&p)).unwrap_or(0);
    let font = fontconfig_file().map(|p| file_stamp(&p)).unwrap_or(0);
    format!("{colors}:{name}:{font}")
}

/// Flat `key = "value"` parser. Omarchy `colors.toml` files are a list of
/// assignments plus comments — not nested tables — so this is the whole
/// format, not a subset.
pub fn parse_colors_toml(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let mut val = raw.trim();
        if let Some(comment) = val.find('#') {
            // Unquoted trailing comments. Quoted values with a hash inside
            // are handled by the quote strip below running first on the
            // original, so only peel a comment when the value isn't quoted.
            if !val.starts_with('"') {
                val = val[..comment].trim();
            }
        }
        if val.len() >= 2 && val.starts_with('"') && val.ends_with('"') {
            val = &val[1..val.len() - 1];
        }
        out.insert(key.to_string(), val.to_string());
    }
    out
}

/// The keys in a `colors.toml` that carry something other than a colour.
/// `mode`/`theme_type` pick light vs dark in the frontend; every other key is
/// a hex value.
const NON_COLOUR_KEYS: [&str; 2] = ["mode", "theme_type"];

/// `#rrggbb` or `#rrggbbaa`, nothing else.
fn is_hex_colour(value: &str) -> bool {
    let Some(hex) = value.strip_prefix('#') else {
        return false;
    };
    (hex.len() == 6 || hex.len() == 8) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Drops every entry whose value isn't the shape its key promises.
///
/// `colors.toml` is written by Omarchy, but it is still a file on disk that
/// anything can edit — and every value here ends up inside the stylesheet the
/// frontend builds. A value restricted to hex can't close the declaration it
/// sits in and start writing rules of its own.
fn sanitized_colors(colors: HashMap<String, String>) -> HashMap<String, String> {
    colors
        .into_iter()
        .filter(|(key, value)| {
            if NON_COLOUR_KEYS.contains(&key.as_str()) {
                value.chars().all(|c| c.is_ascii_alphabetic())
            } else {
                is_hex_colour(value)
            }
        })
        .collect()
}

/// A font family safe to interpolate into a CSS `font-family`. `fc-match`
/// prints whatever the matched font calls itself, which is not something to
/// paste into a stylesheet unchecked.
fn sanitized_font(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-'))
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "monospace".to_string()
    } else {
        cleaned.to_string()
    }
}

pub fn omarchy_font() -> String {
    let output = std::process::Command::new("fc-match")
        .args(["monospace", "-f", "%{family}\n"])
        .output()
        .ok();
    let Some(output) = output else {
        return "monospace".into();
    };
    String::from_utf8(output.stdout)
        .ok()
        .and_then(|s| {
            s.lines()
                .next()
                .map(|line| line.split(',').next().unwrap_or(line).trim().to_string())
        })
        .map(|s| sanitized_font(&s))
        .unwrap_or_else(|| "monospace".into())
}

/// The theme's own name, as Omarchy stages it. Restricted to the slug shape a
/// theme file can be named after: the value crosses into the frontend, which
/// uses it to build a path, and `theme.name` is a plain file anything can
/// write.
fn current_theme_slug() -> Option<String> {
    let raw = theme_name_file().and_then(|p| std::fs::read_to_string(p).ok())?;
    let slug = raw.trim().to_ascii_lowercase();
    crate::themes::is_valid_name(&slug).then_some(slug)
}

pub fn read_appearance() -> OmarchyAppearance {
    let colors = colors_toml()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|text| sanitized_colors(parse_colors_toml(&text)))
        .unwrap_or_default();
    OmarchyAppearance {
        colors,
        font: omarchy_font(),
        theme: current_theme_slug(),
    }
}

#[tauri::command]
pub fn omarchy_appearance() -> OmarchyAppearance {
    read_appearance()
}

/// One watcher for the process. `setup` can be called once; tests shouldn't
/// start a second poller.
static WATCHING: AtomicBool = AtomicBool::new(false);

pub fn spawn_watcher(app: AppHandle) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let mut last_fp = fingerprint();
        let mut last = read_appearance();
        loop {
            thread::sleep(POLL);
            let fp = fingerprint();
            if fp == last_fp {
                continue;
            }
            last_fp = fp;
            let next = read_appearance();
            if next == last {
                continue;
            }
            last = next.clone();
            let _ = app.emit("omarchy-appearance", next);
            crate::tray::refresh_icons(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{parse_colors_toml, sanitized_colors, sanitized_font};

    #[test]
    fn parses_omarchy_colors_toml() {
        let text = r###"
# Generated by Aether for Omarchy v4.
mode = "dark"

accent = "#5280c7"
background = "#05080e"
foreground = "#d2d9e4"
red = "#7da3e0"
"###;
        let map = parse_colors_toml(text);
        assert_eq!(map.get("mode").unwrap(), "dark");
        assert_eq!(map.get("accent").unwrap(), "#5280c7");
        assert_eq!(map.get("background").unwrap(), "#05080e");
        assert_eq!(map.get("red").unwrap(), "#7da3e0");
    }

    /// The theme file ends up in a stylesheet, so anything that isn't a hex
    /// colour is dropped rather than passed through — an edited `colors.toml`
    /// must not be able to inject CSS.
    #[test]
    fn drops_values_that_are_not_colours() {
        let text = r###"
mode = "dark"
accent = "#5280c7"
alpha = "#5280c7ff"
short = "#abc"
injected = "red; } body { display: none"
"###;
        let map = sanitized_colors(parse_colors_toml(text));
        assert_eq!(map.get("accent").unwrap(), "#5280c7");
        assert_eq!(map.get("alpha").unwrap(), "#5280c7ff");
        assert_eq!(map.get("mode").unwrap(), "dark");
        assert!(map.get("short").is_none());
        assert!(map.get("injected").is_none());
    }

    #[test]
    fn font_family_keeps_only_name_characters() {
        assert_eq!(sanitized_font("JetBrains Mono"), "JetBrains Mono");
        assert_eq!(sanitized_font("Mono\"; content: url(x)"), "Mono content urlx");
        assert_eq!(sanitized_font("\";"), "monospace");
    }
}
