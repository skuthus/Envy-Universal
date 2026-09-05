//! A control socket, so a compositor keybind can do what the bar icon does.
//!
//! Wayland has no app-registered global hotkeys, so "summon" has to be a
//! Hyprland bind that runs a command. That command is `envynote --toggle`:
//! it hands the verb to the running instance over this socket and exits, or,
//! with nothing listening, carries on and becomes the instance. The socket
//! lives in `$XDG_RUNTIME_DIR` (per-user, 0700), and the only things it
//! understands are the verbs below.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::tray::on_main;
use crate::{toggle_pinned_window, toggle_window};

pub fn socket_path() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR").map(|d| PathBuf::from(d).join("envy-control.sock"))
}

/// Sends one verb to a running Envy. `false` when none is listening (or it
/// didn't answer), which is the caller's cue to launch instead.
pub fn send(verb: &str) -> bool {
    let Some(path) = socket_path() else { return false };
    let Ok(mut stream) = UnixStream::connect(&path) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(format!("{verb}\n").as_bytes()).is_err() {
        return false;
    }
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).is_ok() && reply.trim() == "ok"
}

/// Starts listening. A stale socket file from a crashed instance is removed
/// first; a live one (a second instance) is left alone and this one simply
/// doesn't serve.
pub fn serve(app: &AppHandle) {
    let Some(path) = socket_path() else { return };
    if UnixStream::connect(&path).is_ok() {
        return;
    }
    let _ = std::fs::remove_file(&path);
    let Ok(listener) = UnixListener::bind(&path) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().map_while(Result::ok) {
            handle(&app, stream);
        }
    });
}

/// Shows the main window and hands the frontend an event to act on — the
/// window has to exist and be visible before an editor can open in it.
fn summon_with(app: &AppHandle, event: &str, payload: Option<String>) {
    let Some(w) = app.get_webview_window("main") else { return };
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    let _ = w.emit(event, payload);
}

fn handle(app: &AppHandle, stream: UnixStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut reader = BufReader::new(&stream);
    let mut line = String::new();
    // Verbs are a few bytes; anything longer is not a client of ours.
    if reader.read_line(&mut line).is_err() || line.len() > 64 {
        return;
    }
    let ok = match line.trim() {
        // The keybind's verb: exactly the bar icon's left click, minus the
        // pinned-note substitution — the Mac's summon key always means the
        // main window, and the pinned note has its own bind.
        "toggle" => {
            on_main(app, |app| {
                if let Some(w) = app.get_webview_window("main") {
                    toggle_window(&w);
                }
            });
            true
        }
        "show" => {
            on_main(app, |app| {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            });
            true
        }
        "pinned" => {
            on_main(app, |app| toggle_pinned_window(app));
            true
        }
        // `envynote config edit`: the file opens in Envy's own editor, so
        // the window has to be up first.
        "edit-config" => {
            on_main(app, |app| summon_with(app, "edit-config", None));
            true
        }
        // `envynote theme export <name>`: only the running app knows what
        // the *resolved* theme is — the Omarchy-derived colours, the Envious
        // face, and any overlay — so it writes the file, not the CLI.
        verb if verb.starts_with("export-theme ") => {
            let name = verb["export-theme ".len()..].trim().to_string();
            let valid = crate::themes::is_valid_name(&name);
            if valid {
                on_main(app, move |app| {
                    summon_with(app, "export-theme", Some(name.clone()))
                });
            }
            valid
        }
        _ => false,
    };
    let mut stream = stream;
    let _ = stream.write_all(if ok { b"ok\n" } else { b"unknown\n" });
}
