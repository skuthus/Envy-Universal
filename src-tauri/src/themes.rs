//! Theme files: `~/.config/envy/themes/<name>.md`.
//!
//! Same shape as the config — one ```toml fence and free prose — because a
//! theme file's prose *is* the point: it is a sample note, so opening the file
//! in Envy previews the colours it sets. Rust only reads and writes these;
//! resolving a theme (base face, overlay, contrast floors) is the frontend's,
//! next to the stylesheet it builds.
//!
//! Every token is optional and every colour is checked against the same
//! `#rrggbb` rule `omarchy.rs` applies, because these values end up in a
//! stylesheet and a theme file is a plain file anything can write.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::config::{self, is_hex_colour};

/// One theme file as the frontend sees it. `tokens` holds only keys the schema
/// knows with values of the right shape; anything else is reported in
/// `problems` and left out, so applying a theme can never apply junk.
#[derive(Serialize, Clone)]
pub struct ThemeFileDto {
    pub name: String,
    pub path: String,
    pub mode: Option<String>,
    pub tokens: Map<String, Value>,
    pub problems: Vec<String>,
}

/// The file stem is the theme's name, so it has to be a slug: it appears in
/// `appearance.theme`, in the CLI, and as a path segment.
pub fn is_valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The four values of `appearance.theme` that mean something already, so a
/// file by one of these names could never be chosen.
const RESERVED_NAMES: [&str; 4] = ["omarchy", "system", "dark", "light"];

fn path_for(name: &str) -> Result<PathBuf, String> {
    if !is_valid_name(name) {
        return Err("a theme name is lowercase letters, digits and dashes".to_string());
    }
    Ok(config::themes_dir().join(format!("{name}.md")))
}

/// Every theme file, by name. A file that fails to parse is still listed —
/// with its problems — so the user can see it in the dropdown and go fix it,
/// rather than wondering where the theme they just wrote went.
pub fn list() -> Vec<ThemeFileDto> {
    let Ok(entries) = std::fs::read_dir(config::themes_dir()) else {
        return Vec::new();
    };
    let mut themes: Vec<ThemeFileDto> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "md") {
                return None;
            }
            let name = path.file_stem()?.to_string_lossy().into_owned();
            let text = std::fs::read_to_string(&path).ok()?;
            Some(parse(&name, &path, &text))
        })
        .collect();
    themes.sort_by(|a, b| a.name.cmp(&b.name));
    themes
}

pub fn read_text(name: &str) -> Result<String, String> {
    let path = path_for(name)?;
    std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Creates or replaces a theme file — what "Export current theme…" and editing
/// a theme in Envy both end in.
pub fn write_text(name: &str, content: &str) -> Result<ThemeFileDto, String> {
    let path = path_for(name)?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    config::mark_themes_write();
    std::fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(parse(name, &path, content))
}

fn parse(name: &str, path: &std::path::Path, text: &str) -> ThemeFileDto {
    let body = config::fence_body(text).map(|r| text[r].to_string());
    let (raw, syntax) = match &body {
        Some(body) => config::parse_body(body),
        None => (Map::new(), Some("no ```toml block".to_string())),
    };
    let mut problems: Vec<String> = syntax.into_iter().map(|p| format!("{name}.md: {p}")).collect();
    // A file whose name is not a slug can never be selected — `appearance.theme`
    // would not be a valid value — and one named after a built-in face is
    // shadowed by it. Both are worth saying out loud; the file is otherwise
    // perfectly well formed and looks like it should work.
    if !is_valid_name(name) {
        problems.push(format!(
            "{name}.md: the file name must be lowercase letters, digits and dashes \
             for the theme to be selectable"
        ));
    } else if RESERVED_NAMES.contains(&name) {
        problems.push(format!(
            "{name}.md: `{name}` is a built-in theme name; rename the file to select it"
        ));
    }
    let mut tokens = Map::new();
    let schema = &config::schema().theme_tokens;

    for (key, value) in &raw {
        if let Some(meta) = schema.meta.iter().find(|t| &t.key == key) {
            let ok = match value.as_str() {
                Some(text) => match &meta.values {
                    Some(allowed) => allowed.iter().any(|v| v.as_str() == Some(text)),
                    None => true,
                },
                None => false,
            };
            if ok {
                tokens.insert(key.clone(), value.clone());
            } else {
                problems.push(format!("{name}.md: {key} is not a valid value"));
            }
        } else if schema.colors.iter().any(|t| &t.key == key) {
            match value.as_str() {
                Some(text) if is_hex_colour(text) => {
                    tokens.insert(key.clone(), value.clone());
                }
                _ => problems.push(format!(
                    "{name}.md: {key} should be a colour like \"#7aa2f7\""
                )),
            }
        } else {
            problems.push(format!("{name}.md: unknown token `{key}`"));
        }
    }

    ThemeFileDto {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        mode: tokens.get("mode").and_then(|v| v.as_str()).map(str::to_string),
        tokens,
        problems,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dto(text: &str) -> ThemeFileDto {
        parse("sample", std::path::Path::new("/tmp/sample.md"), text)
    }

    #[test]
    fn names_are_slugs() {
        assert!(is_valid_name("tokyo-night"));
        assert!(is_valid_name("42"));
        assert!(!is_valid_name("Tokyo Night"));
        assert!(!is_valid_name("-leading"));
        assert!(!is_valid_name("../escape"));
        assert!(!is_valid_name(""));
    }

    #[test]
    fn reads_tokens_and_the_mode() {
        let theme = dto("# Sample\n\n```toml\nmode = \"dark\"\ntext = \"#c0caf5\"\nfont_size = \"15px\"\n```\n\nA sample note.\n");
        assert_eq!(theme.mode.as_deref(), Some("dark"));
        assert_eq!(theme.tokens.get("text").unwrap(), "#c0caf5");
        assert_eq!(theme.tokens.get("font_size").unwrap(), "15px");
        assert!(theme.problems.is_empty());
    }

    /// A value that isn't a colour never reaches the stylesheet, and the file
    /// still loads with whatever else it got right.
    #[test]
    fn junk_is_dropped_and_reported() {
        let theme = dto("```toml\nmode = \"sideways\"\ntext = \"red; } body {\"\nlink = \"#7aa2f7\"\nnope = \"#000000\"\n```\n");
        assert_eq!(theme.mode, None);
        assert!(!theme.tokens.contains_key("text"));
        assert_eq!(theme.tokens.get("link").unwrap(), "#7aa2f7");
        assert_eq!(theme.problems.len(), 3, "{:?}", theme.problems);
        assert!(theme.problems.iter().any(|p| p.contains("unknown token `nope`")));
    }

    #[test]
    fn an_unselectable_name_is_reported() {
        let theme = parse(
            "Tokyo Night",
            std::path::Path::new("/tmp/Tokyo Night.md"),
            "```toml\nmode = \"dark\"\n```\n",
        );
        assert_eq!(theme.problems.len(), 1);
        assert!(theme.problems[0].contains("lowercase letters"));

        let theme = parse("dark", std::path::Path::new("/tmp/dark.md"), "```toml\nmode = \"dark\"\n```\n");
        assert_eq!(theme.problems.len(), 1);
        assert!(theme.problems[0].contains("built-in theme name"));
    }

    #[test]
    fn a_file_with_no_fence_is_a_problem_not_a_crash() {
        let theme = dto("Just a note about colours.\n");
        assert!(theme.tokens.is_empty());
        assert_eq!(theme.problems.len(), 1);
    }
}
