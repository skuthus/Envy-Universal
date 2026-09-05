//! First paint on Windows has to be a real HWND, not WebView2.
//!
//! wry creates the tao window, then a child `WRY_WEBVIEW` that covers it with
//! a null background, then blocks the UI thread on
//! `CreateCoreWebView2EnvironmentWithOptions` + `wait_with_pump`. Until that
//! returns the user sees nothing — unlike macOS (NSWindow maps immediately)
//! and Linux (GtkWindow maps before WebKit finishes).
//!
//! We put an Envy-colored Win32 window on screen in the first milliseconds,
//! then create the WebView2 environment on this same thread (so the splash
//! keeps painting while Edge starts). wry's later `CreateCoreWebView2…` call
//! reuses that browser process. The splash is destroyed once Tauri's window
//! exists.

use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::mpsc;
use std::time::Instant;

use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2Environment,
        ICoreWebView2EnvironmentOptions,
    },
    CoreWebView2EnvironmentOptions, CreateCoreWebView2EnvironmentCompletedHandler,
};
use windows::{
    core::{w, HSTRING, PCWSTR},
    Win32::{
        Foundation::{COLORREF, E_POINTER, E_UNEXPECTED, HWND, LPARAM, LRESULT, RECT, WPARAM},
        Globalization::{GetUserDefaultUILanguage, LCIDToLocaleName, LOCALE_ALLOW_NEUTRAL_NAMES},
        Graphics::Gdi::{
            BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, RedrawWindow, HDC,
            PAINTSTRUCT, RDW_ERASE, RDW_INVALIDATE, RDW_UPDATENOW,
        },
        System::{
            Com::{CoInitializeEx, COINIT_APARTMENTTHREADED},
            LibraryLoader::GetModuleHandleW,
            Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE},
        },
        UI::{
            HiDpi::{
                GetDpiForSystem, GetDpiForWindow, SetProcessDpiAwarenessContext,
                DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetSystemMetrics,
                LoadIconW, RegisterClassExW, SetForegroundWindow, SetWindowPos, ShowWindow,
                CS_DROPSHADOW, CS_HREDRAW, CS_VREDRAW, IDI_APPLICATION, SM_CXSCREEN, SM_CYSCREEN,
                SWP_NOACTIVATE, SWP_NOZORDER, SW_SHOW, WM_DESTROY, WM_ERASEBKGND, WM_PAINT,
                WNDCLASSEXW, WS_CLIPCHILDREN, WS_EX_APPWINDOW, WS_POPUP, WS_VISIBLE,
            },
        },
    },
};

const CLASS: PCWSTR = w!("EnvyBoot");
const TITLE: PCWSTR = w!("Envy");
/// Envious dark, BGR for GDI (`#1d1e1f`).
const BG: u32 = 0x001F_1E1D;
/// Search-bar strip, BGR (`#262626`).
const BAR: u32 = 0x0026_2626;
/// wry's default additional args plus autoplay (wry `WebViewAttributes::autoplay` defaults on).
const WRY_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

static SPLASH: AtomicIsize = AtomicIsize::new(0);

/// Held so the Edge browser process we started stays alive until wry attaches.
/// The COM object is STA-affine; we only touch it on the UI thread.
#[allow(dead_code)] // held so the Edge process we started is not torn down
struct HeldEnv(ICoreWebView2Environment);
unsafe impl Send for HeldEnv {}
unsafe impl Sync for HeldEnv {}
static ENV: std::sync::Mutex<Option<HeldEnv>> = std::sync::Mutex::new(None);

pub fn show_and_prewarm() {
    let t0 = Instant::now();
    if other_instance_running() {
        return;
    }
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    match show_splash() {
        Ok(()) => crate::runtime_log(&format!(
            "splash visible in {}ms",
            t0.elapsed().as_millis()
        )),
        Err(e) => {
            crate::runtime_log(&format!("splash failed: {e}"));
            return;
        }
    }
    match prewarm_environment() {
        Ok(()) => crate::runtime_log(&format!(
            "webview2 env ready in {}ms",
            t0.elapsed().as_millis()
        )),
        Err(e) => crate::runtime_log(&format!("webview2 prewarm failed: {e}")),
    }
}

pub fn dismiss() {
    let raw = SPLASH.swap(0, Ordering::SeqCst);
    if raw == 0 {
        return;
    }
    unsafe {
        let _ = DestroyWindow(HWND(raw as *mut _));
    }
    crate::runtime_log("splash dismissed");
}

fn other_instance_running() -> bool {
    unsafe {
        match OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, w!("app.envynote.windows-sim")) {
            Ok(h) => {
                let _ = windows::Win32::Foundation::CloseHandle(h);
                true
            }
            Err(_) => false,
        }
    }
}

fn show_splash() -> windows::core::Result<()> {
    unsafe {
        let instance = GetModuleHandleW(PCWSTR::null())?;
        let brush = CreateSolidBrush(COLORREF(BG));
        let icon = LoadIconW(None, IDI_APPLICATION).unwrap_or_default();
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW | CS_DROPSHADOW,
            lpfnWndProc: Some(wndproc),
            hInstance: instance.into(),
            hIcon: icon,
            hbrBackground: brush,
            lpszClassName: CLASS,
            ..Default::default()
        };
        RegisterClassExW(&class);

        let (x, y, w, h) = splash_rect();
        let hwnd = CreateWindowExW(
            WS_EX_APPWINDOW,
            CLASS,
            TITLE,
            WS_POPUP | WS_VISIBLE | WS_CLIPCHILDREN,
            x,
            y,
            w,
            h,
            None,
            None,
            Some(instance.into()),
            None,
        )?;
        SPLASH.store(hwnd.0 as isize, Ordering::SeqCst);
        // CreateWindowEx ran before the HWND had a per-monitor DPI. Resize to
        // 800×600 logical so the splash matches Tauri's default window.
        let dpi = GetDpiForWindow(hwnd).max(96);
        let scale = dpi as f64 / 96.0;
        let w = (800.0 * scale).round() as i32;
        let h = (600.0 * scale).round() as i32;
        let screen_w = GetSystemMetrics(SM_CXSCREEN);
        let screen_h = GetSystemMetrics(SM_CYSCREEN);
        let x = ((screen_w - w) / 2).max(0);
        let y = ((screen_h - h) / 2).max(0);
        let _ = SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = RedrawWindow(
            Some(hwnd),
            None,
            None,
            RDW_INVALIDATE | RDW_UPDATENOW | RDW_ERASE,
        );
        let _ = SetForegroundWindow(hwnd);
        Ok(())
    }
}

fn splash_rect() -> (i32, i32, i32, i32) {
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    // Physical pixels: 800×600 logical at the system DPI. GetSystemMetrics
    // already returns physical size, so scale 800×600 by dpi/96.
    let dpi = unsafe { GetDpiForSystem() };
    let scale = (dpi as f64 / 96.0).max(1.0);
    let w = (800.0 * scale).round() as i32;
    let h = (600.0 * scale).round() as i32;
    let x = ((screen_w - w) / 2).max(0);
    let y = ((screen_h - h) / 2).max(0);
    (x, y, w, h)
}

fn prewarm_environment() -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    // Same folder Tauri forces on Windows when the window config omits
    // `dataDirectory`: `%LOCALAPPDATA%\{identifier}`. WEBVIEW2_USER_DATA_FOLDER
    // is also set; if the loader honours it, both this call and wry's see it.
    let data_directory = dirs::data_local_dir()
        .map(|p| HSTRING::from(p.join("app.envynote.windows").as_path()))
        .unwrap_or_default();

    let options = CoreWebView2EnvironmentOptions::default();
    unsafe {
        options.set_additional_browser_arguments(WRY_BROWSER_ARGS.to_string());
        options.set_are_browser_extensions_enabled(false);
        let lcid = GetUserDefaultUILanguage();
        let mut lang = [0u16; 85];
        LCIDToLocaleName(lcid as u32, Some(&mut lang), LOCALE_ALLOW_NEUTRAL_NAMES);
        options.set_language(String::from_utf16_lossy(&lang));
    }

    let (tx, rx) = mpsc::channel();
    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            PCWSTR::null(),
            &data_directory,
            &ICoreWebView2EnvironmentOptions::from(options),
            &CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
                move |error_code, environment| {
                    let result = (|| {
                        error_code?;
                        environment.ok_or_else(|| windows::core::Error::from(E_POINTER).into())
                    })();
                    tx.send(result)
                        .map_err(|_| windows::core::Error::from(E_UNEXPECTED))
                },
            )),
        )
        .map_err(|e| e.to_string())?;
    }

    let env = webview2_com::wait_with_pump(rx)
        .map_err(|e| e.to_string())?
        .map_err(|e: webview2_com::Error| e.to_string())?;
    *ENV.lock().unwrap() = Some(HeldEnv(env));
    Ok(())
}

unsafe extern "system" fn wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => {
            paint(hwnd, HDC(wparam.0 as *mut _));
            LRESULT(1)
        }
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            paint(hwnd, hdc);
            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        WM_DESTROY => {
            SPLASH.store(0, Ordering::SeqCst);
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn paint(hwnd: HWND, hdc: HDC) {
    let mut rc = RECT::default();
    if unsafe { GetClientRect(hwnd, &mut rc) }.is_err() {
        return;
    }
    unsafe {
        let bg = CreateSolidBrush(COLORREF(BG));
        FillRect(hdc, &rc, bg);
        let _ = DeleteObject(bg.into());
        let bar_h = ((rc.bottom - rc.top).min(42)).max(28);
        let mut bar = rc;
        bar.bottom = bar.top + bar_h;
        let bar_brush = CreateSolidBrush(COLORREF(BAR));
        FillRect(hdc, &bar, bar_brush);
        let _ = DeleteObject(bar_brush.into());
    }
}
