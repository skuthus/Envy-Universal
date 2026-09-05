//! The bar icon — Linux's counterpart to the Mac's menu bar item.
//!
//! Registered straight over D-Bus as a StatusNotifierItem (via `ksni`) rather
//! than through Tauri's tray support, for one reason: Omarchy's bar resolves
//! tray icons by *theme name*, and Tauri's tray hands it a raw file path,
//! which the bar draws as an empty slot. Naming our own icon also lets it end
//! in `-symbolic`, which the bar recolours to its text colour the way it does
//! its own audio/network/battery glyphs — the same job `isTemplate` does for
//! the Mac's status item.
//!
//! The icon is the Mac's hand-drawn eye in one colour, filled solid with the
//! iris punched out to the bar behind it: open while the main window shows,
//! squinting while only the pinned note shows, a lid line while both are
//! hidden. Every icon file is written at launch (and rewritten when
//! the theme changes) into a private icon-theme directory, in the bar's own
//! text colour, so bars that don't recolour symbolic icons still get a solid
//! eye that matches.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;

use ksni::blocking::{Handle, TrayMethods};
use ksni::menu::{CheckmarkItem, MenuItem, StandardItem, SubMenu};
use tauri::{AppHandle, Emitter, Manager};
use tiny_skia::{BlendMode, FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Stroke, Transform};

use crate::{
    create_and_pin, persisted_keep_on_top, run_update_check, toggle_keep_on_top,
    toggle_pinned_window, toggle_window, AppState, PINNED_WINDOW,
};

/// The three lid positions, mirroring the Mac's `EyeState`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Eye {
    Open,
    Squint,
    Closed,
}

impl Eye {
    const ALL: [Eye; 3] = [Eye::Open, Eye::Squint, Eye::Closed];

    fn icon_name(self) -> &'static str {
        match self {
            Eye::Open => "envy-open-symbolic",
            Eye::Squint => "envy-squint-symbolic",
            Eye::Closed => "envy-closed-symbolic",
        }
    }
}

pub struct EnvyTray {
    app: AppHandle,
    eye: Eye,
    /// Where this generation's icon files live. A fresh directory per theme
    /// change, because hosts cache images by URL: rewriting the same file in a
    /// new colour would leave the old colour on screen until relaunch, while a
    /// new theme path is announced (`NewIconThemePath`) and reloaded.
    theme_dir: PathBuf,
    colour: [u8; 3],
}

impl ksni::Tray for EnvyTray {
    fn id(&self) -> String {
        // The id the bar widget looks the item up by, and the tray files its
        // hide choice under; see `install_bar_widget`.
        "envy".into()
    }

    fn title(&self) -> String {
        "Envy".into()
    }

    fn icon_theme_path(&self) -> String {
        self.theme_dir.to_string_lossy().into_owned()
    }

    fn icon_name(&self) -> String {
        self.eye.icon_name().into()
    }

    /// For hosts that ignore `IconThemePath` entirely.
    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        [22, 32]
            .into_iter()
            .filter_map(|size| {
                let px = render_eye(self.eye, size, self.colour)?;
                Some(ksni::Icon {
                    width: size as i32,
                    height: size as i32,
                    data: argb_network_order(&px),
                })
            })
            .collect()
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip {
            title: "Envy".into(),
            ..Default::default()
        }
    }

    /// Left click. With a note pinned, a click opens *it* rather than
    /// summoning the app — that substitution is the whole feature. Without
    /// one, the click falls back to showing Envy.
    fn activate(&mut self, _x: i32, _y: i32) {
        on_main(&self.app, |app| {
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

    /// Implemented (even as a no-op) on purpose: ksni only re-reads `menu`
    /// when the menu is about to open if this hook exists, and the menu
    /// reflects things that change while the app runs — the template list
    /// and whether anything is pinned.
    fn menu_about_to_show(&mut self) {}

    fn menu(&self) -> Vec<MenuItem<Self>> {
        let app = &self.app;
        let templates: Vec<envy_core::NoteTemplate> = app
            .try_state::<AppState>()
            .map(|s| s.store.lock().unwrap().templates())
            .unwrap_or_default();
        let is_pinned = app
            .try_state::<AppState>()
            .map(|s| s.pinned_note.lock().unwrap().is_some())
            .unwrap_or(false);

        let template_items: Vec<MenuItem<Self>> = if templates.is_empty() {
            // Present but disabled, so the feature is discoverable before any
            // template exists rather than the entry simply vanishing.
            vec![StandardItem {
                label: "No Templates".into(),
                enabled: false,
                ..Default::default()
            }
            .into()]
        } else {
            templates
                .into_iter()
                .map(|t| {
                    let path = t.path.to_string_lossy().into_owned();
                    StandardItem {
                        label: t.name.clone(),
                        activate: Box::new(move |tray: &mut Self| {
                            let path = path.clone();
                            on_main(&tray.app, move |app| create_and_pin(app, Some(&path)))
                        }),
                        ..Default::default()
                    }
                    .into()
                })
                .collect()
        };

        vec![
            StandardItem {
                label: "New Note".into(),
                activate: Box::new(|tray: &mut Self| on_main(&tray.app, |app| summon(app, "new-note"))),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "New Pinned Note".into(),
                activate: Box::new(|tray: &mut Self| on_main(&tray.app, |app| create_and_pin(app, None))),
                ..Default::default()
            }
            .into(),
            SubMenu {
                label: "New Pinned Note from Template".into(),
                submenu: template_items,
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "Unpin Note".into(),
                enabled: is_pinned,
                activate: Box::new(|tray: &mut Self| on_main(&tray.app, unpin)),
                ..Default::default()
            }
            .into(),
            MenuItem::Separator,
            // Checkmark reflects the current state, same as the Mac's
            // status-menu item.
            // Hyprland pins floating windows only, so the item is greyed out
            // while Envy is tiled; the setting itself is kept either way.
            CheckmarkItem {
                label: "Keep Envy on Top".into(),
                checked: persisted_keep_on_top(app),
                enabled: crate::config::floating(),
                activate: Box::new(|tray: &mut Self| on_main(&tray.app, toggle_keep_on_top)),
                ..Default::default()
            }
            .into(),
            // The bar widget's own setting, kept in its shell.json entry where
            // Omarchy keeps every widget's settings. Off, the eye is only in
            // the bar while Envy runs; on, a dim eye stays as a launcher.
            CheckmarkItem {
                label: "Show Eye in Bar When Closed".into(),
                checked: bar_show_when_closed(),
                activate: Box::new(|tray: &mut Self| {
                    set_bar_show_when_closed(!bar_show_when_closed());
                    let app = tray.app.clone();
                    on_main(&tray.app, move |_| refresh(&app));
                }),
                ..Default::default()
            }
            .into(),
            // The Mac's File → Import from Kindle. The frontend owns the
            // enabled flag and the title/body preferences, so it decides
            // between importing and opening Settings.
            StandardItem {
                label: "Import from Kindle".into(),
                activate: Box::new(|tray: &mut Self| {
                    on_main(&tray.app, |app| summon(app, "import-from-kindle"))
                }),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "Settings…".into(),
                activate: Box::new(|tray: &mut Self| on_main(&tray.app, |app| summon(app, "open-settings"))),
                ..Default::default()
            }
            .into(),
            // The Mac carries "Check for Updates…" as a menu command beside
            // the automatic background check.
            StandardItem {
                label: "Check for Updates…".into(),
                activate: Box::new(|tray: &mut Self| {
                    let handle = tray.app.clone();
                    tauri::async_runtime::spawn(run_update_check(handle, true));
                }),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "Quit Envy".into(),
                activate: Box::new(|tray: &mut Self| {
                    // The panel may still be up; its place is worth keeping.
                    crate::remember_pinned_geometry(&tray.app);
                    tray.app.exit(0)
                }),
                ..Default::default()
            }
            .into(),
        ]
    }
}

/// Runs a click or menu action on the GTK main thread. Actions arrive on
/// ksni's own service thread, and several of them end in `refresh`, which
/// asks that same service to update — a wait on itself that timed out the
/// D-Bus call and left "New Pinned Note" half done. The main thread is also
/// where Tauri wants windows built.
pub(crate) fn on_main(app: &AppHandle, action: impl FnOnce(&AppHandle) + Send + 'static) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || action(&handle));
}

/// Brings the main window forward and hands the frontend an event to act on.
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

static TRAY: OnceLock<Handle<EnvyTray>> = OnceLock::new();
static GENERATION: AtomicU32 = AtomicU32::new(0);

/// Registers the item and starts following the windows. Called once from
/// setup, on the main thread (the GTK signal hookup below needs it).
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let colour = bar_text_colour();
    let theme_dir = write_icon_theme(app, colour)?;
    let tray = EnvyTray {
        app: app.clone(),
        eye: current_eye(app),
        theme_dir,
        colour,
    };
    let handle = tray.spawn()?;
    let _ = TRAY.set(handle);

    if let Some(w) = app.get_webview_window("main") {
        follow_window(app, &w);
        crate::hyprland::float_when_mapped(&w, crate::config::floating, Some(crate::config::keep_on_top));
    }
    follow_hyprland(app);
    install_bar_widget(app);
    Ok(())
}

/// Re-reads everything the item reflects — lid position, menu contents — and
/// pushes it to the host. The one call every state change funnels through.
pub fn refresh(app: &AppHandle) {
    let eye = current_eye(app);
    if let Some(handle) = TRAY.get() {
        handle.update(|t| t.eye = eye);
    }
}

/// The theme changed: redraw every icon in the new bar colour and point the
/// host at the new directory.
pub fn refresh_icons(app: &AppHandle) {
    let Some(handle) = TRAY.get() else { return };
    let colour = bar_text_colour();
    let Ok(dir) = write_icon_theme(app, colour) else { return };
    let previous = handle.update(|t| {
        t.colour = colour;
        std::mem::replace(&mut t.theme_dir, dir)
    });
    if let Some(old) = previous {
        let _ = std::fs::remove_dir_all(old);
    }
}

/// Open while the main window is on screen, squinting while only the pinned
/// note is, closed otherwise — the Mac's `updateStatusItemIcon`.
///
/// "On screen" is GTK's word (mapped, not minimised) and, on Hyprland, the
/// compositor's too: the summon bind parks the window on a special workspace
/// instead of hiding it, which GTK cannot see.
fn current_eye(app: &AppHandle) -> Eye {
    let on_screen = hypr_visible_titles();
    let visible = |label: &str| {
        let Some(w) = app.get_webview_window(label) else { return false };
        if !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
            return false;
        }
        match &on_screen {
            Some(titles) => {
                let title = w.title().unwrap_or_default();
                titles.iter().any(|t| *t == title)
            }
            None => true,
        }
    };
    if visible("main") {
        Eye::Open
    } else if visible(PINNED_WINDOW) {
        Eye::Squint
    } else {
        Eye::Closed
    }
}

/// Hooks the window's GTK map/unmap signals so the eye follows every show and
/// hide, whichever side (Rust, the frontend, the compositor) caused it. Safe
/// to call from any thread; the hookup itself runs on the GTK thread.
pub fn follow_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    use gtk::prelude::WidgetExt;
    let app = app.clone();
    let window = window.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Ok(gtk_window) = window.gtk_window() else { return };
        // Deferred to the next main-loop turn, never run inside the signal.
        // Closing a window unmaps it from within Tauri's close handling, which
        // holds its window table borrowed while the GTK window is disposed; a
        // `refresh` right then asks that table for the main window, hits the
        // borrow, and panics — and a panic inside a GTK signal handler cannot
        // unwind, so the whole app aborted. An idle callback runs after the
        // close has finished and sees a consistent table.
        let on_map = app.clone();
        gtk_window.connect_map(move |_| {
            let app = on_map.clone();
            gtk::glib::idle_add_local_once(move || refresh(&app));
        });
        let on_unmap = app.clone();
        gtk_window.connect_unmap(move |_| {
            let app = on_unmap.clone();
            gtk::glib::idle_add_local_once(move || refresh(&app));
        });
    });
}

// --- Hyprland -----------------------------------------------------------------
// The summon bind (`linux/hyprland-envy.lua`) slides the main window in and
// out on a special workspace. The window stays mapped either way, so the eye
// has to ask the compositor which of Envy's windows are actually showing, and
// follow its event stream so it closes when the scratchpad goes away.

fn hypr_socket(name: &str) -> Option<PathBuf> {
    let signature = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").ok()?;
    let runtime = std::env::var("XDG_RUNTIME_DIR").ok()?;
    Some(PathBuf::from(runtime).join("hypr").join(signature).join(name))
}

pub(crate) fn hypr_query(command: &str) -> Option<String> {
    use std::io::{Read, Write};
    let mut stream = std::os::unix::net::UnixStream::connect(hypr_socket(".socket.sock")?).ok()?;
    stream.write_all(command.as_bytes()).ok()?;
    let mut out = String::new();
    stream.read_to_string(&mut out).ok()?;
    Some(out)
}

/// Titles of this process's windows that Hyprland is showing right now: on a
/// monitor's active workspace, or on its open special workspace. `None` off
/// Hyprland (or when it can't be asked), so the caller falls back to GTK.
fn hypr_visible_titles() -> Option<Vec<String>> {
    let clients: serde_json::Value = serde_json::from_str(&hypr_query("j/clients")?).ok()?;
    let monitors: serde_json::Value = serde_json::from_str(&hypr_query("j/monitors")?).ok()?;
    let shown: Vec<i64> = monitors
        .as_array()?
        .iter()
        .flat_map(|m| [m.pointer("/activeWorkspace/id"), m.pointer("/specialWorkspace/id")])
        .flatten()
        .filter_map(|v| v.as_i64())
        .collect();
    let pid = u64::from(std::process::id());
    let flag = |c: &serde_json::Value, key: &str, default: bool| c.get(key).and_then(|v| v.as_bool()).unwrap_or(default);
    Some(
        clients
            .as_array()?
            .iter()
            .filter(|c| c.get("pid").and_then(|p| p.as_u64()) == Some(pid))
            .filter(|c| flag(c, "mapped", true) && !flag(c, "hidden", false))
            .filter(|c| {
                c.pointer("/workspace/id")
                    .and_then(|i| i.as_i64())
                    .map_or(true, |id| shown.contains(&id))
            })
            .filter_map(|c| c.get("title").and_then(|t| t.as_str()).map(String::from))
            .collect(),
    )
}

/// Re-evaluates the eye on every compositor event that can change what is
/// on screen. A no-op off Hyprland.
fn follow_hyprland(app: &AppHandle) {
    use std::io::BufRead;
    let Some(path) = hypr_socket(".socket2.sock") else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(stream) = std::os::unix::net::UnixStream::connect(path) else { return };
        for line in std::io::BufReader::new(stream).lines().map_while(Result::ok) {
            let event = line.split(">>").next().unwrap_or("");
            if matches!(
                event,
                "activespecial"
                    | "activespecialv2"
                    | "workspace"
                    | "workspacev2"
                    | "focusedmon"
                    | "focusedmonv2"
                    | "movewindow"
                    | "movewindowv2"
                    | "openwindow"
                    | "closewindow"
                    | "minimized"
            ) {
                refresh(&app);
            }
        }
    });
}

// --- Icon files ---------------------------------------------------------------

/// Writes the three eyes as an icon theme the host can search: a `hicolor`
/// tree with PNGs at the usual sizes plus an SVG, and the same files flat in
/// the root for hosts (GTK) that look there. Returns the directory.
fn write_icon_theme(app: &AppHandle, colour: [u8; 3]) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst);
    let base = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("envy"))
        .join("tray-icons");
    // Anything left over from a previous run is stale.
    if generation == 0 {
        let _ = std::fs::remove_dir_all(&base);
    }
    let dir = base.join(format!("{}-{generation}", std::process::id()));
    let sizes = [16u32, 22, 24, 32, 48];

    let mut index = String::from("[Icon Theme]\nName=Envy\nComment=Envy bar icon\nDirectories=scalable/apps");
    for s in sizes {
        index.push_str(&format!(",{s}x{s}/apps"));
    }
    index.push_str("\n\n[scalable/apps]\nSize=32\nMinSize=8\nMaxSize=512\nType=Scalable\nContext=Applications\n");
    for s in sizes {
        index.push_str(&format!("\n[{s}x{s}/apps]\nSize={s}\nType=Fixed\nContext=Applications\n"));
    }
    let hicolor = dir.join("hicolor");
    std::fs::create_dir_all(hicolor.join("scalable/apps"))?;
    std::fs::write(hicolor.join("index.theme"), index)?;

    for eye in Eye::ALL {
        let name = eye.icon_name();
        let svg = eye_svg(eye, colour);
        std::fs::write(hicolor.join("scalable/apps").join(format!("{name}.svg")), &svg)?;
        std::fs::write(dir.join(format!("{name}.svg")), &svg)?;
        for s in sizes {
            let Some(px) = render_eye(eye, s, colour) else { continue };
            let png = px.encode_png()?;
            let sized = hicolor.join(format!("{s}x{s}/apps"));
            std::fs::create_dir_all(&sized)?;
            std::fs::write(sized.join(format!("{name}.png")), &png)?;
            if s == 32 {
                std::fs::write(dir.join(format!("{name}.png")), &png)?;
            }
        }
    }
    Ok(dir)
}

// The Mac draws the eye on an 18pt canvas; these are its points with y
// flipped to run downwards. The lower rim is shared by all three states so
// the lid closes onto the same line it sits on when open.
const CANVAS: f32 = 18.0;
const CORNER_L: (f32, f32) = (2.5, 9.0);
const CORNER_R: (f32, f32) = (15.5, 9.0);
const LOWER_L: (f32, f32) = (6.0, 13.7);
const LOWER_R: (f32, f32) = (12.0, 13.7);
const UPPER_L: (f32, f32) = (6.0, 4.3);
const UPPER_R: (f32, f32) = (12.0, 4.3);
const SQUINT_L: (f32, f32) = (6.0, 8.4);
const SQUINT_R: (f32, f32) = (12.0, 8.4);
const IRIS: (f32, f32, f32) = (9.0, 9.2, 2.375);
const LINE: f32 = 2.0;
/// The Mac's canvas leaves menu-bar margins around the eye; the bar's own
/// glyphs fill more of their box, so the eye is enlarged about the canvas
/// centre to sit at their size (the owner's eye: 1.2 read slightly big).
const ZOOM: f32 = 1.14;

/// Where a canvas point lands after the zoom.
fn zoomed(p: f32) -> f32 {
    (p - CANVAS / 2.0) * ZOOM + CANVAS / 2.0
}

/// Three decimals: enough for an 18-unit canvas, and it keeps float noise
/// like `1.5000005` out of the SVG files, which are committed.
fn tidy(v: f32) -> f32 {
    (v * 1000.0).round() / 1000.0
}

fn lens_path(eye: Eye) -> Option<tiny_skia::Path> {
    let mut pb = PathBuilder::new();
    pb.move_to(CORNER_L.0, CORNER_L.1);
    pb.cubic_to(LOWER_L.0, LOWER_L.1, LOWER_R.0, LOWER_R.1, CORNER_R.0, CORNER_R.1);
    match eye {
        Eye::Closed => {}
        Eye::Open => {
            pb.cubic_to(UPPER_R.0, UPPER_R.1, UPPER_L.0, UPPER_L.1, CORNER_L.0, CORNER_L.1);
            pb.close();
        }
        Eye::Squint => {
            pb.cubic_to(SQUINT_R.0, SQUINT_R.1, SQUINT_L.0, SQUINT_L.1, CORNER_L.0, CORNER_L.1);
            pb.close();
        }
    }
    pb.finish()
}

/// Rasterises one eye at `size` pixels square in a single colour: the lens
/// filled solid with the iris cleared out of it (a hole, so the bar shows
/// through), then the rim stroked on top so the lid stays whole where it
/// crosses the iris in a squint — the same iris partway hidden, not a
/// smaller one. A closed eye is only its lower lid.
fn render_eye(eye: Eye, size: u32, colour: [u8; 3]) -> Option<Pixmap> {
    let mut pixmap = Pixmap::new(size, size)?;
    let scale = size as f32 / CANVAS;
    let shift = scale * zoomed(0.0);
    let transform = Transform::from_row(scale * ZOOM, 0.0, 0.0, scale * ZOOM, shift, shift);
    let mut paint = Paint::default();
    paint.set_color_rgba8(colour[0], colour[1], colour[2], 255);
    paint.anti_alias = true;

    let lens = lens_path(eye)?;
    if eye != Eye::Closed {
        pixmap.fill_path(&lens, &paint, FillRule::Winding, transform, None);
        let iris = PathBuilder::from_circle(IRIS.0, IRIS.1, IRIS.2)?;
        let mut clear = Paint::default();
        clear.blend_mode = BlendMode::Clear;
        clear.anti_alias = true;
        pixmap.fill_path(&iris, &clear, FillRule::Winding, transform, None);
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

/// The same eye as an SVG, the zoom done by the viewBox. Kept to what Qt's SVG renderer (the bar widget)
/// draws reliably: no masks or clip paths, just an even-odd fill of the lens
/// with the iris as an inner subpath, and the rim stroked over it. In a
/// squint the iris subpath is only the part of the disc below the lid
/// (cut on a chord that the lid's stroke then covers), so nothing of the
/// iris shows above the lid.
fn eye_svg(eye: Eye, colour: [u8; 3]) -> String {
    let hex = format!("#{:02x}{:02x}{:02x}", colour[0], colour[1], colour[2]);
    let rim = format!(
        "M{} {} C{} {} {} {} {} {}",
        CORNER_L.0, CORNER_L.1, LOWER_L.0, LOWER_L.1, LOWER_R.0, LOWER_R.1, CORNER_R.0, CORNER_R.1
    );
    let upper = match eye {
        Eye::Closed => None,
        Eye::Open => Some((UPPER_R, UPPER_L)),
        Eye::Squint => Some((SQUINT_R, SQUINT_L)),
    };
    let lens = match upper {
        Some((r, l)) => format!(
            "{rim} C{} {} {} {} {} {}Z",
            r.0, r.1, l.0, l.1, CORNER_L.0, CORNER_L.1
        ),
        None => rim,
    };
    let (cx, cy, r) = IRIS;
    let iris = match eye {
        Eye::Closed => String::new(),
        Eye::Open => format!(
            "M{} {} A{r} {r} 0 1 0 {} {}A{r} {r} 0 1 0 {} {}Z",
            cx - r, cy, cx + r, cy, cx - r, cy
        ),
        Eye::Squint => {
            // The lid runs level with its control points across the iris;
            // the chord sits there, under the stroke.
            let chord = SQUINT_L.1 + (CORNER_L.1 - SQUINT_L.1) * 0.25;
            let half = (r * r - (chord - cy) * (chord - cy)).sqrt();
            let chord = tidy(chord);
            format!("M{} {chord} A{r} {r} 0 1 0 {} {chord}Z", tidy(cx - half), tidy(cx + half))
        }
    };
    let fill = if iris.is_empty() {
        String::new()
    } else {
        format!(r#"<path d="{lens} {iris}" fill="{hex}" fill-rule="evenodd"/>"#)
    };
    let origin = tidy(CANVAS / 2.0 - CANVAS / 2.0 / ZOOM);
    let side = tidy(CANVAS / ZOOM);
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="{origin} {origin} {side} {side}" width="{side}" height="{side}">{fill}<path d="{lens}" fill="none" stroke="{hex}" stroke-width="{LINE}" stroke-linecap="round" stroke-linejoin="round"/></svg>"#
    )
}

/// tiny-skia keeps premultiplied RGBA; the StatusNotifierItem spec wants
/// straight ARGB with the bytes in network (big-endian) order.
fn argb_network_order(pixmap: &Pixmap) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixmap.pixels().len() * 4);
    for p in pixmap.pixels() {
        let c = p.demultiply();
        out.extend_from_slice(&[c.alpha(), c.red(), c.green(), c.blue()]);
    }
    out
}

// --- Omarchy ------------------------------------------------------------------

/// The colour the bar draws its own glyphs in: the theme's `[bar] text` from
/// `shell.toml`, else the palette foreground, else the shell's built-in
/// default. Used for the files and the pixmap so a bar that doesn't recolour
/// symbolic icons still matches.
fn bar_text_colour() -> [u8; 3] {
    let theme = dirs::home_dir().map(|h| h.join(".local/state/omarchy/current/theme"));
    let from_shell = theme
        .as_ref()
        .and_then(|t| std::fs::read_to_string(t.join("shell.toml")).ok())
        .and_then(|text| toml_section_value(&text, "bar", "text"));
    let from_palette = theme
        .as_ref()
        .and_then(|t| std::fs::read_to_string(t.join("colors.toml")).ok())
        .and_then(|text| crate::omarchy::parse_colors_toml(&text).remove("foreground"));
    from_shell
        .or(from_palette)
        .and_then(|hex| parse_hex(&hex))
        .unwrap_or([0xca, 0xcc, 0xcc])
}

/// `key = "value"` under `[section]` in a small TOML file, nothing fancier.
fn toml_section_value(text: &str, section: &str, key: &str) -> Option<String> {
    let mut in_section = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_section = line == format!("[{section}]");
            continue;
        }
        if !in_section || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        if k.trim() == key {
            return Some(v.trim().trim_matches('"').to_string());
        }
    }
    None
}

fn parse_hex(hex: &str) -> Option<[u8; 3]> {
    let h = hex.trim().strip_prefix('#')?;
    if h.len() < 6 || !h.is_char_boundary(6) {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}

// --- Omarchy bar widget -------------------------------------------------------
//
// Omarchy's bar keeps tray items behind a chevron drawer, and the owner wants
// the eye to sit in the bar like the shell's own widgets. So Envy ships a bar
// widget plugin (`linux/omarchy-plugin`, embedded here) that draws this very
// StatusNotifierItem as a first-class icon, and the item itself is hidden from
// the tray widget so it isn't shown twice.

const PLUGIN_ID: &str = "skuthus.envy";
const PLUGIN_FILES: &[(&str, &[u8])] = &[
    ("manifest.json", include_bytes!("../../linux/omarchy-plugin/manifest.json")),
    ("BarWidget.qml", include_bytes!("../../linux/omarchy-plugin/BarWidget.qml")),
    ("eye-open.svg", include_bytes!("../../linux/omarchy-plugin/eye-open.svg")),
    ("eye-squint.svg", include_bytes!("../../linux/omarchy-plugin/eye-squint.svg")),
    ("eye-closed.svg", include_bytes!("../../linux/omarchy-plugin/eye-closed.svg")),
    ("README.md", include_bytes!("../../linux/omarchy-plugin/README.md")),
];

/// Writes `content` only when the file differs, so an unchanged plugin
/// doesn't trip the shell's file watchers on every launch.
fn write_if_changed(path: &std::path::Path, content: &[u8]) -> std::io::Result<bool> {
    if std::fs::read(path).map(|c| c == content).unwrap_or(false) {
        return Ok(false);
    }
    std::fs::write(path, content)?;
    Ok(true)
}

fn omarchy_shell(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("omarchy-shell").args(args).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Installs (or refreshes) the bar widget and, on first launch only, enables
/// it, places it in the bar, and hides the tray copy. Everything after that
/// first launch is the user's: a widget they moved or disabled stays moved or
/// disabled. Does nothing where there is no Omarchy shell.
fn install_bar_widget(app: &AppHandle) {
    let Some(home) = dirs::home_dir() else { return };
    let config = home.join(".config/omarchy");
    if !config.join("shell.json").exists() || which("omarchy-shell").is_none() {
        return;
    }

    let dir = config.join("plugins").join(PLUGIN_ID);
    let upgrade = dir.join("manifest.json").exists();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut code_changed = false;
    for (name, content) in PLUGIN_FILES {
        code_changed |= write_if_changed(&dir.join(name), content).unwrap_or(false);
    }
    let mut changed = code_changed;
    // The widget's "launch Envy" action needs a binary; the installed .desktop
    // entry is optional and the owner runs straight from the build tree.
    if let Ok(exe) = std::env::current_exe() {
        let script = format!("#!/bin/sh\nexec {} \"$@\"\n", shell_quote(&exe.to_string_lossy()));
        let launch = dir.join("launch.sh");
        changed |= write_if_changed(&launch, script.as_bytes()).unwrap_or(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&launch, std::fs::Permissions::from_mode(0o755));
        }
    }
    if code_changed && upgrade {
        // The shell re-reads a changed plugin but keeps the widget instance
        // already in the bar, so new widget code only shows after a restart —
        // the same restart `omarchy update` does. launch.sh is read fresh on
        // every click and never needs one, and a first install creates the
        // slot from the new code anyway.
        let _ = std::process::Command::new("omarchy-restart-shell")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    } else if changed {
        let _ = omarchy_shell(&["shell", "rescanPlugins"]);
    }

    let Some(marker) = app.path().app_config_dir().ok().map(|d| d.join("omarchy-bar")) else {
        return;
    };
    if marker.exists() {
        return;
    }

    // Placement: straight after a hidden-bar chevron when the layout has one
    // (the first always-visible slot), otherwise at the start of the right
    // section. `omarchy bar move` takes it from there.
    let layout = std::fs::read_to_string(config.join("shell.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    let layout_entries: Vec<&serde_json::Value> = layout
        .as_ref()
        .and_then(|v| v.pointer("/bar/layout"))
        .and_then(|l| l.as_object())
        .map(|sections| {
            sections
                .values()
                .filter_map(|entries| entries.as_array())
                .flatten()
                .collect()
        })
        .unwrap_or_default();
    let has_id = |id: &str| {
        layout_entries
            .iter()
            .any(|e| e.get("id").and_then(|i| i.as_str()) == Some(id))
    };
    let placement = if has_id("skuthus.hidden-om-bar") {
        r#"{"after":"skuthus.hidden-om-bar"}"#
    } else {
        r#"{"section":"right","index":0}"#
    };
    // A rescan may still be settling; ask once more if the id is unknown.
    let mut result = omarchy_shell(&["shell", "enablePlugin", PLUGIN_ID, placement]);
    if result.as_deref() == Some("unknown") {
        std::thread::sleep(std::time::Duration::from_millis(500));
        result = omarchy_shell(&["shell", "enablePlugin", PLUGIN_ID, placement]);
    }
    if result.as_deref() != Some("ok") {
        return;
    }

    // Hide the tray's copy: the widget is the icon now. Edited in the file
    // rather than through the shell's IPC, whose argument parser splits on
    // commas and so cannot carry a list. The shell has just written the file
    // itself for enablePlugin; give that write a moment to land, then edit
    // what it wrote — the shell reloads the file on change.
    std::thread::sleep(std::time::Duration::from_millis(400));
    hide_in_tray(&config.join("shell.json"));

    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&marker, "");
}

fn omarchy_shell_json() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("omarchy/shell.json"))
}

/// The widget's `showWhenClosed` setting, read from its `shell.json` entry.
pub(crate) fn bar_show_when_closed() -> bool {
    let Some(path) = omarchy_shell_json() else { return false };
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    widget_entry_flag(&root, "showWhenClosed")
}

fn widget_entry_flag(root: &serde_json::Value, key: &str) -> bool {
    ["left", "center", "right"].iter().any(|side| {
        root.pointer(&format!("/bar/layout/{side}"))
            .and_then(|s| s.as_array())
            .map(|entries| {
                entries.iter().any(|e| {
                    e.get("id").and_then(|v| v.as_str()) == Some(PLUGIN_ID)
                        && e.get(key).and_then(|v| v.as_bool()) == Some(true)
                })
            })
            .unwrap_or(false)
    })
}

/// Writes the widget's `showWhenClosed` setting into its `shell.json` entry,
/// the way the widget itself would through `updateEntryInline`. The shell
/// hot-reloads the file, so the bar follows at once.
pub(crate) fn set_bar_show_when_closed(on: bool) {
    let Some(path) = omarchy_shell_json() else { return };
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    if set_widget_entry_flag(&mut root, "showWhenClosed", on) {
        if let Ok(pretty) = serde_json::to_string_pretty(&root) {
            let _ = std::fs::write(path, pretty + "\n");
        }
    }
}

fn set_widget_entry_flag(root: &mut serde_json::Value, key: &str, on: bool) -> bool {
    let mut changed = false;
    for side in ["left", "center", "right"] {
        let Some(entries) = root
            .pointer_mut(&format!("/bar/layout/{side}"))
            .and_then(|s| s.as_array_mut())
        else {
            continue;
        };
        for entry in entries.iter_mut() {
            if entry.get("id").and_then(|v| v.as_str()) != Some(PLUGIN_ID) {
                continue;
            }
            let Some(obj) = entry.as_object_mut() else { continue };
            let current = obj.get(key).and_then(|v| v.as_bool()) == Some(true);
            if current != on {
                obj.insert(key.to_string(), serde_json::Value::Bool(on));
                changed = true;
            }
        }
    }
    changed
}

/// Adds "envy" to the tray widget's `hidden` list in `shell.json`, keeping
/// everything else — key order included — exactly as the user had it.
fn hide_in_tray(path: &std::path::Path) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    let mut changed = false;
    for side in ["left", "center", "right"] {
        let Some(entries) = root
            .pointer_mut(&format!("/bar/layout/{side}"))
            .and_then(|s| s.as_array_mut())
        else {
            continue;
        };
        for entry in entries.iter_mut() {
            if entry.get("id").and_then(|v| v.as_str()) != Some("omarchy.tray") {
                continue;
            }
            let Some(obj) = entry.as_object_mut() else { continue };
            let hidden = obj.entry("hidden").or_insert_with(|| serde_json::Value::Array(vec![]));
            if !hidden.is_array() {
                // A stray scalar (the IPC path leaves one) becomes a list.
                let kept = hidden.as_str().map(|s| serde_json::Value::String(s.into()));
                *hidden = serde_json::Value::Array(kept.into_iter().collect());
                changed = true;
            }
            let Some(list) = hidden.as_array_mut() else { continue };
            if !list.iter().any(|v| v.as_str() == Some("envy")) {
                list.push(serde_json::Value::String("envy".into()));
                changed = true;
            }
        }
    }
    if changed {
        if let Ok(pretty) = serde_json::to_string_pretty(&root) {
            let _ = std::fs::write(path, pretty + "\n");
        }
    }
}

fn which(program: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|p| p.join(program))
            .find(|p| p.is_file())
    })
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn show_when_closed_flag_round_trips_in_the_widget_entry() {
        let mut root: serde_json::Value = serde_json::from_str(
            r#"{"bar":{"layout":{"right":[{"id":"omarchy.tray"},{"id":"skuthus.envy"}]}}}"#,
        )
        .unwrap();
        assert!(!widget_entry_flag(&root, "showWhenClosed"));
        assert!(set_widget_entry_flag(&mut root, "showWhenClosed", true));
        assert!(widget_entry_flag(&root, "showWhenClosed"));
        // Same value again: nothing to write.
        assert!(!set_widget_entry_flag(&mut root, "showWhenClosed", true));
        assert!(set_widget_entry_flag(&mut root, "showWhenClosed", false));
        assert!(!widget_entry_flag(&root, "showWhenClosed"));
        // The tray entry is never touched.
        assert!(root.pointer("/bar/layout/right/0/showWhenClosed").is_none());
    }

    #[test]
    fn every_eye_renders_something_at_every_size() {
        for eye in Eye::ALL {
            for size in [16u32, 22, 32, 48] {
                let px = render_eye(eye, size, [255, 255, 255]).unwrap();
                let painted = px.pixels().iter().filter(|p| p.alpha() > 0).count();
                assert!(painted > 0, "{eye:?} at {size}px painted nothing");
            }
        }
    }

    #[test]
    fn open_shows_more_than_squint_more_than_closed() {
        let ink = |eye| {
            render_eye(eye, 32, [255, 255, 255])
                .unwrap()
                .pixels()
                .iter()
                .filter(|p| p.alpha() > 0)
                .count()
        };
        assert!(ink(Eye::Open) > ink(Eye::Squint));
        assert!(ink(Eye::Squint) > ink(Eye::Closed));
    }

    #[test]
    fn pixmap_is_straight_argb() {
        let px = render_eye(Eye::Open, 16, [10, 20, 30]).unwrap();
        let data = argb_network_order(&px);
        assert_eq!(data.len(), 16 * 16 * 4);
        let opaque = data.chunks(4).find(|c| c[0] == 255).expect("an opaque pixel");
        assert_eq!(&opaque[1..], &[10, 20, 30]);
    }

    #[test]
    fn reads_bar_text_from_a_shell_toml_section() {
        let text = "[popups]\ntext = \"#111111\"\n[bar]\n# comment\nbackground = \"#000000\"\ntext = \"#ABCDEF\"\n";
        assert_eq!(toml_section_value(text, "bar", "text").as_deref(), Some("#ABCDEF"));
        assert_eq!(parse_hex("#ABCDEF"), Some([0xab, 0xcd, 0xef]));
        assert_eq!(parse_hex("red"), None);
    }

    #[test]
    fn hide_in_tray_appends_to_the_list_and_keeps_the_rest_verbatim() {
        let dir = std::env::temp_dir().join(format!("envy-tray-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("shell.json");
        // Key order and an existing scalar `hidden` (what the shell's IPC path
        // leaves behind) both have to survive.
        std::fs::write(
            &path,
            r#"{"bar":{"layout":{"right":[{"id":"omarchy.tray","hidden":"other"},{"zeta":"x","alpha":"y"}]}},"plugins":[]}"#,
        )
        .unwrap();
        hide_in_tray(&path);
        let text = std::fs::read_to_string(&path).unwrap();
        let root: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            root.pointer("/bar/layout/right/0/hidden").unwrap(),
            &serde_json::json!(["other", "envy"])
        );
        // Not alphabetical: the file must come back in the order it was written.
        assert!(text.find("\"zeta\"").unwrap() < text.find("\"alpha\"").unwrap(), "key order kept");
        hide_in_tray(&path);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text, "second run is a no-op");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn svg_has_the_iris_only_when_the_eye_is_open() {
        assert!(eye_svg(Eye::Open, [0, 0, 0]).contains("evenodd"));
        assert!(eye_svg(Eye::Squint, [0, 0, 0]).contains("evenodd"));
        assert!(!eye_svg(Eye::Closed, [0, 0, 0]).contains("evenodd"));
    }

    #[test]
    fn the_iris_is_a_hole_in_a_solid_eye() {
        // Canvas coordinates to pixels of a 36px render (two per unit).
        let px_of = |p: f32| (zoomed(p) * 2.0) as u32;
        let px = render_eye(Eye::Open, 36, [255, 255, 255]).unwrap();
        let at = |x: f32, y: f32| px.pixel(px_of(x), px_of(y)).unwrap().alpha();
        assert_eq!(at(IRIS.0, IRIS.1), 0, "the iris centre shows the bar");
        assert_eq!(at(IRIS.0, IRIS.1 - IRIS.2 - 1.0), 255, "solid between iris and lid");
        assert_eq!(at(4.5, 9.0), 255, "solid towards the corner");
        assert_eq!(at(CORNER_L.0, CORNER_L.1), 255, "the rim's corner is painted");
        // Squinting, the lid crosses the iris and stays whole.
        let squint = render_eye(Eye::Squint, 36, [255, 255, 255]).unwrap();
        let lid = squint.pixel(px_of(IRIS.0), px_of(SQUINT_L.1)).unwrap().alpha();
        assert_eq!(lid, 255, "the squinting lid is unbroken over the iris");
    }

    #[test]
    fn bar_widget_svgs_are_the_tray_eyes_in_white() {
        for (eye, file) in [
            (Eye::Open, "eye-open.svg"),
            (Eye::Squint, "eye-squint.svg"),
            (Eye::Closed, "eye-closed.svg"),
        ] {
            let shipped = PLUGIN_FILES.iter().find(|(n, _)| *n == file).unwrap().1;
            assert_eq!(
                std::str::from_utf8(shipped).unwrap().trim(),
                eye_svg(eye, [255, 255, 255]),
                "{file} is out of date: regenerate it from eye_svg"
            );
        }
    }
}
