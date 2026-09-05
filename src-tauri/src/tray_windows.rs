//! Windows tray: Tauri's notify-icon, with the same eye and menu as Linux.
//!
//! Linux registers a StatusNotifierItem over D-Bus because Omarchy's bar
//! ignores Tauri's tray path. Windows has no such host, so the stock tray is
//! the right one: left click summons, right click opens the menu.

use std::sync::OnceLock;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tiny_skia::{FillRule, LineCap, LineJoin, Mask, Paint, PathBuilder, Pixmap, Stroke, Transform};

use crate::{
    create_and_pin, persisted_keep_on_top, run_update_check, toggle_keep_on_top,
    toggle_pinned_window, toggle_window, AppState, PINNED_WINDOW,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Eye {
    Open,
    Squint,
    Closed,
}

static TRAY: OnceLock<TrayIcon> = OnceLock::new();

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if TRAY.get().is_some() {
        return Ok(());
    }
    let menu = build_menu(app)?;
    let icon = eye_image(current_eye(app)).unwrap_or_else(|| {
        app.default_window_icon()
            .cloned()
            .expect("the bundle carries a default icon")
    });
    let tray = TrayIconBuilder::with_id("envy")
        .icon(icon)
        .tooltip("Envy")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                on_main(app, |app| {
                    let pinned = app
                        .try_state::<AppState>()
                        .and_then(|s| s.pinned_note.lock().unwrap().clone());
                    if pinned.is_some() {
                        toggle_pinned_window(app);
                    } else if let Some(w) = app.get_webview_window("main") {
                        toggle_window(&w);
                    }
                });
            }
        })
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref().to_string();
            let app = app.clone();
            on_main(&app, move |app| handle_menu(app, &id));
        })
        .build(app)?;
    let _ = TRAY.set(tray);
    if let Some(w) = app.get_webview_window("main") {
        follow_window(app, &w);
    }
    Ok(())
}

pub fn refresh(app: &AppHandle) {
    let Some(tray) = TRAY.get() else { return };
    if let Ok(menu) = build_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
    refresh_eye(app);
}

#[allow(dead_code)]
pub fn refresh_icons(app: &AppHandle) {
    refresh_eye(app);
}

fn refresh_eye(app: &AppHandle) {
    let Some(tray) = TRAY.get() else { return };
    let eye = current_eye(app);
    static LAST: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(255);
    let code = eye as u8;
    if LAST.swap(code, std::sync::atomic::Ordering::Relaxed) == code {
        return;
    }
    if let Some(icon) = eye_image(eye) {
        let _ = tray.set_icon(Some(icon));
    }
}

pub fn follow_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    let app = app.clone();
    let _ = window.on_window_event(move |event| {
        use tauri::WindowEvent::*;
        // Not Moved/Resized: those fire continuously while dragging and used
        // to rebuild the tray menu and spawn `reg` on every pixel.
        match event {
            Destroyed | Focused(_) => refresh_eye(&app),
            _ => {}
        }
    });
}

pub(crate) fn on_main(app: &AppHandle, action: impl FnOnce(&AppHandle) + Send + 'static) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || action(&handle));
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "new-note" => summon(app, "new-note"),
        "new-pinned" => create_and_pin(app, None),
        "unpin" => unpin(app),
        "keep-on-top" => toggle_keep_on_top(app),
        "import-kindle" => summon(app, "import-from-kindle"),
        "settings" => summon(app, "open-settings"),
        "check-updates" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(run_update_check(handle, true));
        }
        "quit" => app.exit(0),
        other if other.starts_with("template:") => {
            create_and_pin(app, Some(other.trim_start_matches("template:")));
        }
        _ => {}
    }
}

fn summon(app: &AppHandle, event: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = w.emit(event, ());
    }
}

fn unpin(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        *state.pinned_note.lock().unwrap() = None;
    }
    if let Some(w) = app.get_webview_window(PINNED_WINDOW) {
        let _ = w.hide();
    }
    let _ = app.emit("pinned-note-changed", ());
    refresh(app);
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let templates: Vec<envy_core::NoteTemplate> = app
        .try_state::<AppState>()
        .map(|s| s.store.lock().unwrap().templates())
        .unwrap_or_default();
    let is_pinned = app
        .try_state::<AppState>()
        .map(|s| s.pinned_note.lock().unwrap().is_some())
        .unwrap_or(false);

    let new_note = MenuItem::with_id(app, "new-note", "New Note", true, None::<&str>)?;
    let new_pinned = MenuItem::with_id(app, "new-pinned", "New Pinned Note", true, None::<&str>)?;
    let unpin = MenuItem::with_id(app, "unpin", "Unpin Note", is_pinned, None::<&str>)?;
    let keep = CheckMenuItem::with_id(
        app,
        "keep-on-top",
        "Keep Envy on Top",
        true,
        persisted_keep_on_top(app),
        None::<&str>,
    )?;
    let kindle = MenuItem::with_id(app, "import-kindle", "Import from Kindle", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Envy", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;

    let template_items: Vec<MenuItem<tauri::Wry>> = if templates.is_empty() {
        vec![MenuItem::with_id(
            app,
            "no-templates",
            "No Templates",
            false,
            None::<&str>,
        )?]
    } else {
        templates
            .into_iter()
            .map(|t| {
                let id = format!(
                    "template:{}",
                    t.path.to_string_lossy().replace('\\', "/")
                );
                MenuItem::with_id(app, id, t.name, true, None::<&str>)
            })
            .collect::<Result<Vec<_>, _>>()?
    };

    let template_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        template_items.iter().map(|i| i as _).collect();
    let templates_menu = Submenu::with_items(
        app,
        "New Pinned Note from Template",
        true,
        &template_refs,
    )?;

    Menu::with_items(
        app,
        &[
            &new_note,
            &new_pinned,
            &templates_menu,
            &unpin,
            &sep,
            &keep,
            &kindle,
            &settings,
            &updates,
            &quit,
        ],
    )
}

fn current_eye(app: &AppHandle) -> Eye {
    let visible = |label: &str| {
        let Some(w) = app.get_webview_window(label) else {
            return false;
        };
        w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)
    };
    if visible("main") {
        Eye::Open
    } else if visible(PINNED_WINDOW) {
        Eye::Squint
    } else {
        Eye::Closed
    }
}

fn eye_image(eye: Eye) -> Option<Image<'static>> {
    let px = render_eye(eye, 32, tray_colour())?;
    let png = px.encode_png().ok()?;
    Image::from_bytes(&png).ok().map(|i| i.to_owned())
}

/// Light glyph on a dark taskbar (Windows 11 default), dark glyph otherwise.
fn tray_colour() -> [u8; 3] {
    static COLOUR: OnceLock<[u8; 3]> = OnceLock::new();
    *COLOUR.get_or_init(|| {
        let light = std::process::Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                "/v",
                "SystemUsesLightTheme",
            ])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.contains("0x1"))
            .unwrap_or(false);
        if light {
            [0x22, 0x22, 0x22]
        } else {
            [0xEE, 0xEE, 0xEE]
        }
    })
}

// The Mac draws the eye on an 18pt canvas; these are its points with y
// flipped to run downwards. Shared with the Linux tray.
const CANVAS: f32 = 18.0;
const CORNER_L: (f32, f32) = (2.5, 9.0);
const CORNER_R: (f32, f32) = (15.5, 9.0);
const LOWER_L: (f32, f32) = (6.0, 13.7);
const LOWER_R: (f32, f32) = (12.0, 13.7);
const UPPER_L: (f32, f32) = (6.0, 4.3);
const UPPER_R: (f32, f32) = (12.0, 4.3);
const SQUINT_L: (f32, f32) = (6.0, 8.4);
const SQUINT_R: (f32, f32) = (12.0, 8.4);
const IRIS: (f32, f32, f32) = (9.0, 9.2, 2.5);
const LINE: f32 = 2.0;

fn lens_path(eye: Eye) -> Option<tiny_skia::Path> {
    let mut pb = PathBuilder::new();
    pb.move_to(CORNER_L.0, CORNER_L.1);
    pb.cubic_to(
        LOWER_L.0, LOWER_L.1, LOWER_R.0, LOWER_R.1, CORNER_R.0, CORNER_R.1,
    );
    match eye {
        Eye::Closed => {}
        Eye::Open => {
            pb.cubic_to(
                UPPER_R.0, UPPER_R.1, UPPER_L.0, UPPER_L.1, CORNER_L.0, CORNER_L.1,
            );
            pb.close();
        }
        Eye::Squint => {
            pb.cubic_to(
                SQUINT_R.0, SQUINT_R.1, SQUINT_L.0, SQUINT_L.1, CORNER_L.0, CORNER_L.1,
            );
            pb.close();
        }
    }
    pb.finish()
}

fn render_eye(eye: Eye, size: u32, colour: [u8; 3]) -> Option<Pixmap> {
    let mut pixmap = Pixmap::new(size, size)?;
    let scale = size as f32 / CANVAS;
    let transform = Transform::from_scale(scale, scale);
    let mut paint = Paint::default();
    paint.set_color_rgba8(colour[0], colour[1], colour[2], 255);
    paint.anti_alias = true;

    let lens = lens_path(eye)?;
    if eye != Eye::Closed {
        let mut mask = Mask::new(size, size)?;
        mask.fill_path(&lens, FillRule::Winding, true, transform);
        let iris = PathBuilder::from_circle(IRIS.0, IRIS.1, IRIS.2)?;
        pixmap.fill_path(&iris, &paint, FillRule::Winding, transform, Some(&mask));
    }
    let stroke = Stroke {
        width: LINE,
        line_cap: LineCap::Round,
        line_join: LineJoin::Round,
        ..Default::default()
    };
    pixmap.stroke_path(&lens, &paint, &stroke, transform, None);
    Some(pixmap)
}
