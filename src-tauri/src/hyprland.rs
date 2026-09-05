//! The Hyprland side of the summon: one line in the user's bindings file.
//!
//! Wayland has no app-registered global hotkeys, so Ctrl+Alt+Return only works
//! as a compositor bind, and the float rule that makes Envy a centred panel
//! lives in the same Lua file (`linux/hyprland-envy.lua`, installed to
//! `/usr/share/envy`). Loading that file takes one `pcall(dofile, ...)` line
//! in `~/.config/hypr/bindings.lua`. The `system.hyprland_bind` setting puts
//! that line there and takes it away again; nothing here runs unless the
//! setting is toggled or disagrees with the file at launch.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Marks the line as ours. Only a line carrying it is ever removed: a user
/// who wrote their own `dofile` line, the way the README first described, keeps
/// it whatever the setting says.
const MARKER: &str = "-- managed by Envy Settings";

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

pub fn bindings_file() -> Option<PathBuf> {
    home().map(|h| h.join(".config/hypr/bindings.lua"))
}

/// The Lua file to load: the package's copy, else the checkout's.
pub fn lua_source() -> Option<PathBuf> {
    let packaged = PathBuf::from("/usr/share/envy/hyprland-envy.lua");
    if packaged.is_file() {
        return Some(packaged);
    }
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../linux/hyprland-envy.lua");
    checkout.is_file().then(|| checkout.canonicalize().unwrap_or(checkout))
}

fn managed_line(source: &Path) -> String {
    format!("pcall(dofile, \"{}\") {MARKER}", source.display())
}

/// Whether any line loads the Envy file, ours or the user's own.
pub fn mentions_envy(text: &str) -> bool {
    text.lines().any(|l| l.contains("hyprland-envy.lua") && !l.trim_start().starts_with("--"))
}

fn has_managed_line(text: &str) -> bool {
    text.lines().any(|l| l.contains(MARKER))
}

/// The bindings file as it should read with the setting `wanted`, or `None`
/// when nothing needs to change.
pub fn updated(text: &str, wanted: bool, source: &Path) -> Option<String> {
    if wanted {
        if mentions_envy(text) {
            return None;
        }
        let mut out = text.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("\n-- Envy: Ctrl+Alt+Return shows/hides the note app; Ctrl+Alt+C centres it.\n");
        out.push_str(&managed_line(source));
        out.push('\n');
        Some(out)
    } else {
        if !has_managed_line(text) {
            return None;
        }
        let mut kept: Vec<&str> = text
            .lines()
            .filter(|l| !l.contains(MARKER) && !l.starts_with("-- Envy: Ctrl+Alt+Return shows/hides"))
            .collect();
        // The blank line that set our block apart goes with it.
        while kept.last().is_some_and(|l| l.trim().is_empty()) {
            kept.pop();
        }
        let mut out = kept.join("\n");
        if !out.is_empty() {
            out.push('\n');
        }
        Some(out)
    }
}

/// Brings the bindings file in line with the setting and reloads Hyprland
/// when it changed. A missing bindings file is created only to turn the
/// setting on; turning it off with no file is nothing to do.
pub fn apply(wanted: bool) {
    let (Some(file), Some(source)) = (bindings_file(), lua_source()) else { return };
    let text = match std::fs::read_to_string(&file) {
        Ok(t) => t,
        Err(_) if wanted && file.parent().is_some_and(|d| d.is_dir()) => String::new(),
        Err(_) => return,
    };
    let Some(next) = updated(&text, wanted, &source) else { return };
    if std::fs::write(&file, next).is_ok() {
        let _ = std::process::Command::new("hyprctl")
            .arg("reload")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src() -> PathBuf {
        PathBuf::from("/usr/share/envy/hyprland-envy.lua")
    }

    #[test]
    fn adds_one_marked_line_and_removes_only_it() {
        let base = "o.bind(\"SUPER + Q\", \"Quit\", hl.dsp.killactive())\n";
        let on = updated(base, true, &src()).expect("added");
        assert!(on.starts_with(base));
        assert!(on.contains(MARKER));
        assert!(on.contains("pcall(dofile, \"/usr/share/envy/hyprland-envy.lua\")"));
        // Already there: nothing to do, in either direction of the same state.
        assert!(updated(&on, true, &src()).is_none());
        let off = updated(&on, false, &src()).expect("removed");
        assert_eq!(off, base);
        assert!(updated(&off, false, &src()).is_none());
    }

    #[test]
    fn leaves_a_hand_written_line_alone() {
        let theirs = "pcall(dofile, os.getenv(\"HOME\") .. \"/Work/Envy-omarchy/linux/hyprland-envy.lua\")\n";
        // On: theirs already loads the file, so no second copy.
        assert!(updated(theirs, true, &src()).is_none());
        // Off: it is not ours to remove.
        assert!(updated(theirs, false, &src()).is_none());
    }

    #[test]
    fn a_commented_out_mention_does_not_count() {
        let text = "-- pcall(dofile, \"/usr/share/envy/hyprland-envy.lua\")\n";
        assert!(updated(text, true, &src()).is_some());
    }
}

// --- Floating ---------------------------------------------------------------
// `system.tiled` and `system.popout_tiled`. Hyprland decides tiling at
// map time from its rules; Envy's rule (in hyprland-envy.lua) floats the main
// window when the file is loaded. These settings let Envy state the choice
// itself, for the main window and for every pop-out, so it lives in config.md
// and holds with or without the rule.

/// What Hyprland knows about one of this process's windows, found by title.
struct WindowState {
    address: String,
    floating: bool,
    pinned: bool,
}

/// Hyprland's address for one of this process's windows, found by title,
/// and whether it floats and is pinned right now. Titles are the only handle
/// the two sides share: Tauri has no view of the compositor's addresses and
/// Hyprland's selectors take a single criterion.
fn window_state(title: &str) -> Option<WindowState> {
    let pid = std::process::id() as i64;
    let clients: serde_json::Value = serde_json::from_str(&crate::tray::hypr_query("j/clients")?).ok()?;
    clients.as_array()?.iter().find_map(|c| {
        (c.get("pid").and_then(|v| v.as_i64()) == Some(pid)
            && c.get("title").and_then(|v| v.as_str()) == Some(title))
        .then(|| {
            let flag = |k: &str| c.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
            Some(WindowState {
                address: c.get("address").and_then(|v| v.as_str())?.to_string(),
                floating: flag("floating"),
                pinned: flag("pinned"),
            })
        })
        .flatten()
    })
}

/// Where Hyprland has a window: logical position and size, as `hyprctl
/// clients` reports them.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Geometry {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

/// The geometry of one of this process's windows, found by title.
pub fn geometry(title: &str) -> Option<Geometry> {
    let pid = std::process::id() as i64;
    let clients: serde_json::Value = serde_json::from_str(&crate::tray::hypr_query("j/clients")?).ok()?;
    let pair = |v: &serde_json::Value| -> Option<(i64, i64)> {
        let a = v.as_array()?;
        Some((a.first()?.as_i64()?, a.get(1)?.as_i64()?))
    };
    clients.as_array()?.iter().find_map(|c| {
        if c.get("pid").and_then(|v| v.as_i64()) != Some(pid)
            || c.get("title").and_then(|v| v.as_str()) != Some(title)
        {
            return None;
        }
        let (x, y) = pair(c.get("at")?)?;
        let (w, h) = pair(c.get("size")?)?;
        Some(Geometry { x, y, w, h })
    })
}

/// Whether a saved position still lands on a monitor that exists. A layout
/// that changed since (a laptop unplugged from its screen) would otherwise
/// put the window somewhere nobody can see.
fn on_a_monitor(g: &Geometry) -> bool {
    let Some(text) = crate::tray::hypr_query("j/monitors") else { return true };
    let Ok(monitors) = serde_json::from_str::<serde_json::Value>(&text) else { return true };
    let Some(list) = monitors.as_array() else { return true };
    list.iter().any(|m| {
        let num = |k: &str| m.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let scale = if num("scale") > 0.0 { num("scale") } else { 1.0 };
        let (mx, my) = (num("x"), num("y"));
        let (mw, mh) = (num("width") / scale, num("height") / scale);
        (g.x as f64) >= mx && (g.x as f64) < mx + mw && (g.y as f64) >= my && (g.y as f64) < my + mh
    })
}

/// Puts the window with this title back at `g` once Hyprland has it
/// floating. A hidden window is unmapped, and a window shown again is a new
/// client to Hyprland, placed fresh — so "where I left it" has to be
/// re-applied on every show, not just at launch. Polls the way
/// `float_when_mapped` does, since the float itself is still landing.
pub fn place_when_floating(title: String, g: Geometry) {
    if !on_a_monitor(&g) {
        return;
    }
    std::thread::spawn(move || {
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if let Some(state) = window_state(&title) {
                if state.floating {
                    let address = state.address;
                    dispatch_call(&format!(
                        "hl.dsp.window.resize({{ x = {}, y = {}, window = \"address:{address}\" }})",
                        g.w, g.h
                    ));
                    dispatch_call(&format!(
                        "hl.dsp.window.move({{ x = {}, y = {}, window = \"address:{address}\" }})",
                        g.x, g.y
                    ));
                    return;
                }
            }
        }
    });
}

fn dispatch_call(call: &str) {
    let _ = std::process::Command::new("hyprctl")
        .arg("dispatch")
        .arg(call)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Runs one window dispatcher against an address. Failures are Hyprland's to
/// report; there is nothing to do about one here.
fn dispatch(verb: &str, address: &str) {
    let _ = std::process::Command::new("hyprctl")
        .arg("dispatch")
        .arg(format!("hl.dsp.window.{verb}({{ action = \"toggle\", window = \"address:{address}\" }})"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Floats or tiles the window with this title, if Hyprland is showing it.
/// Asks first and only ever toggles: the dispatcher's "set" flipped the
/// window every time it was called, so every settings change floated or
/// tiled Envy in turn. Comparing with the live state makes the call a no-op
/// whenever the window already is what the setting says.
/// Returns whether Hyprland knew the window at all, so a caller acting on a
/// window that is still being registered can try again.
pub fn set_floating(title: &str, floating: bool) -> bool {
    let Some(state) = window_state(title) else { return false };
    if state.floating != floating {
        dispatch("float", &state.address);
    }
    true
}

/// Pins or unpins the window with this title: Hyprland's pin keeps a window
/// above the others and on every workspace, which is what "Keep on Top"
/// means on a compositor where GTK's keep-above is an X11-only hint. Only a
/// floating window can be pinned, so a tiled one is left alone (the tray
/// item is greyed out while `system.tiled` is on). Toggles only when the
/// live state disagrees, like `set_floating`, and returns whether Hyprland
/// knew the window.
pub fn set_pinned(title: &str, pinned: bool) -> bool {
    let Some(state) = window_state(title) else { return false };
    if state.pinned != pinned && (state.floating || !pinned) {
        dispatch("pin", &state.address);
    }
    true
}

/// Applies the settings once the window is mapped — the moment Hyprland knows
/// it — on the next main-loop turn, never inside the GTK signal itself.
/// `floating` says whether the window should float; `pinned`, if given,
/// whether it should then be kept on top. Both are read at map time, not
/// now, so a window hidden and shown again follows the current setting.
pub fn float_when_mapped(window: &tauri::WebviewWindow, floating: fn() -> bool, pinned: Option<fn() -> bool>) {
    use gtk::prelude::WidgetExt;
    let window = window.clone();
    let app = window.app_handle().clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(gtk_window) = window.gtk_window() else { return };
        let title = window.title().unwrap_or_default();
        // Hyprland registers the client a moment after GTK maps the surface,
        // and how long a moment varies; poll until it is there, then act
        // once. Bounded so a window that never shows up (closed straight
        // away) does not keep a timer alive.
        let apply = move |title: String| {
            let attempts = std::cell::Cell::new(0u32);
            gtk::glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
                attempts.set(attempts.get() + 1);
                if set_floating(&title, floating()) {
                    // The float dispatch has landed by the time hyprctl
                    // returns, so the pin sees the window as it now is.
                    if let Some(pinned) = pinned {
                        set_pinned(&title, pinned());
                    }
                    gtk::glib::ControlFlow::Break
                } else if attempts.get() >= 30 {
                    gtk::glib::ControlFlow::Break
                } else {
                    gtk::glib::ControlFlow::Continue
                }
            });
        };
        // A pop-out is built and shown in one step, so by the time this hook
        // runs (a main-loop turn later) its map signal has already fired and
        // will not fire again. Act now for that case; the signal covers a
        // window that is hidden and shown again later, like the main one.
        if gtk_window.is_mapped() {
            apply(title.clone());
        }
        gtk_window.connect_map(move |_| apply(title.clone()));
    });
}

/// Re-applies both settings to every open window: the main one and each
/// pop-out. Run when the config changes. Tiling a pinned window unpins it
/// and floating it again does not pin it back, so the main window's pin is
/// re-applied after its float.
pub fn apply_floating(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        let floating = if label == "main" {
            crate::config::floating()
        } else if label.starts_with("popout-") {
            crate::config::popout_floating()
        } else {
            continue;
        };
        if let Ok(title) = window.title() {
            if set_floating(&title, floating) && label == "main" {
                set_pinned(&title, crate::config::keep_on_top());
            }
        }
    }
}

/// Pins or unpins the main window to match `system.keep_on_top`. A tiled
/// window cannot be pinned; the setting then waits for the window to float.
pub fn apply_pinned(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(title) = window.title() {
            set_pinned(&title, crate::config::keep_on_top());
        }
    }
}

/// Whether the main window is full screen, as the compositor sees it.
///
/// Asked of Hyprland rather than GTK: on a tiling compositor GTK's
/// "maximized" state is set on windows that are merely tiled, and Tauri's
/// own fullscreen flag only knows about fullscreen the app itself requested,
/// so the footer clock's "only in full screen" never hid the clock. Off
/// Hyprland, the app's own flag is all there is.
#[tauri::command]
pub fn main_window_fullscreen(app: AppHandle) -> bool {
    let pid = std::process::id() as i64;
    let from_hyprland = crate::tray::hypr_query("j/clients")
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|clients| {
            clients.as_array()?.iter().find_map(|c| {
                (c.get("pid").and_then(|v| v.as_i64()) == Some(pid)
                    && c.get("title").and_then(|v| v.as_str()) == Some("Envy"))
                .then(|| c.get("fullscreen").and_then(|v| v.as_i64()).unwrap_or(0) != 0)
            })
        });
    from_hyprland.unwrap_or_else(|| {
        app.get_webview_window("main")
            .and_then(|w| w.is_fullscreen().ok())
            .unwrap_or(false)
    })
}
