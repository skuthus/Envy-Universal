//! Hide on focus loss, from the OS's own word on who has the foreground.
//!
//! The frontend hides the main window when its window blurs. On Windows that
//! blur is not the window's: Tauri drops tao's focus events there and
//! synthesises them from the WebView2 controller's GotFocus/LostFocus
//! instead, and on Windows 11 with `hide_on_focus_loss = true` the window
//! simply stayed put when another app was brought to the front — nothing
//! reached `hide_main`, and main-window.json was never written.
//!
//! EVENT_SYSTEM_FOREGROUND is delivered by the system whenever the foreground
//! window changes, whoever owns it. A winner in this process (the pinned
//! note, the tray menu, a pop-out) is not a focus loss — the same rule the
//! frontend reconstructs with anyEnvyWindowFocused(). A winner elsewhere is
//! checked again after the same short grace the frontend gives, because the
//! shell takes the foreground for an instant with windows nobody can see:
//! SearchHost.exe did so four seconds after every launch here, cloaked, and
//! would have hidden Envy on the spot. Only a visible, uncloaked window in
//! another process still holding the foreground after the grace counts.
//!
//! The frontend's own handler stays; where it works the two agree, and
//! hiding a hidden window is a no-op.

use std::ffi::c_void;
use std::sync::OnceLock;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId, IsWindowVisible,
    EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT,
};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// How long a foreign window must keep the foreground before it counts.
/// Matches the frontend's wait before anyEnvyWindowFocused().
const GRACE: Duration = Duration::from_millis(150);

/// Installs the foreground hook. Call once, from the main thread, after the
/// windows exist (`RunEvent::Ready`).
pub fn install(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    // SAFETY: plain Win32 call; the callback is a static fn and APP is set.
    let hook = unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(on_foreground),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        )
    };
    if hook.is_invalid() {
        crate::runtime_log("focus hook: SetWinEventHook failed");
    } else {
        crate::runtime_log("focus hook ready");
    }
}

/// The shell windows a click on the tray icon puts in the foreground. A
/// focus-loss hide must not act on those: the click is about to reach the
/// tray's own toggle, and a window hidden a moment earlier would only be
/// shown again by it, so from the user's side the icon did nothing.
const SHELL_TRAY_CLASSES: [&str; 4] = [
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "NotifyIconOverflowWindow",
    "TopLevelWindowForOverflowXamlIsland",
];

fn class_of(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    // SAFETY: hwnd came from the system; buf is a valid out-buffer.
    let n = unsafe { GetClassNameW(hwnd, &mut buf) } as usize;
    String::from_utf16_lossy(&buf[..n.min(buf.len())])
}

fn is_shell_tray(hwnd: HWND) -> bool {
    let class = class_of(hwnd);
    SHELL_TRAY_CLASSES.contains(&class.as_str())
}

/// Whether the foreground right now is the shell's tray — for `hide_main`,
/// which the frontend's own blur handler calls in the same situation.
pub(crate) fn foreground_is_shell_tray() -> bool {
    // SAFETY: no preconditions.
    let fg = unsafe { GetForegroundWindow() };
    !fg.is_invalid() && is_shell_tray(fg)
}

fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    // SAFETY: hwnd came from the system; pid is a valid out-pointer.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

fn ours(hwnd: HWND) -> bool {
    // SAFETY: no preconditions.
    pid_of(hwnd) == unsafe { GetCurrentProcessId() }
}

/// DWM's cloak state, logged alongside the decision: UWP hosts such as
/// SearchHost keep cloaked top-level windows that can win the foreground
/// without showing, and packaged apps' core windows report as cloaked while
/// their frame is what the user sees.
fn cloaked(hwnd: HWND) -> u32 {
    let mut cloaked = 0u32;
    // SAFETY: hwnd came from the system; the attribute is written into a u32.
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>() as u32,
        )
    }
    .is_ok();
    if ok {
        cloaked
    } else {
        0
    }
}

unsafe extern "system" fn on_foreground(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if ours(hwnd) {
        return;
    }
    let Some(app) = APP.get() else { return };
    let app = app.clone();
    let winner = pid_of(hwnd);
    std::thread::spawn(move || {
        std::thread::sleep(GRACE);
        // SAFETY: no preconditions; may be called from any thread.
        let fg = unsafe { GetForegroundWindow() };
        if fg.is_invalid() || ours(fg) {
            crate::runtime_log(&format!("foreground to pid {winner}, back with us after grace"));
            return;
        }
        let pid = pid_of(fg);
        // SAFETY: fg came from the system.
        let shown = unsafe { IsWindowVisible(fg).as_bool() };
        let cloaked = cloaked(fg);
        let class = class_of(fg);
        crate::runtime_log(&format!(
            "foreground to pid {pid} {class} (visible={shown} cloaked={cloaked})"
        ));
        if !shown || is_shell_tray(fg) {
            return;
        }
        let main = app.clone();
        let _ = main.run_on_main_thread(move || {
            // Same guards as the frontend: the setting, and Keep on Top,
            // which would otherwise fight itself. The in-page Settings
            // overlay is the frontend's to know about and is not guarded here.
            let setting = crate::config::hide_on_focus_loss();
            let on_top = crate::config::keep_on_top();
            let Some(w) = app.get_webview_window("main") else {
                crate::runtime_log("focus hook: no main window");
                return;
            };
            let visible = w.is_visible().unwrap_or(false);
            let minimised = w.is_minimized().unwrap_or(false);
            if !setting || on_top || !visible || minimised {
                crate::runtime_log(&format!(
                    "focus hook: not hiding (hide_on_focus_loss={setting} keep_on_top={on_top} visible={visible} minimised={minimised})"
                ));
                return;
            }
            crate::runtime_log(&format!("focus lost to pid {pid}: hiding main"));
            crate::hide_main_window(&w);
        });
    });
}
