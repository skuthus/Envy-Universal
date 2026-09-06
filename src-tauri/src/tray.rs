//! Tray icon. Linux uses a StatusNotifierItem (Omarchy/Wayland); Windows uses
//! Tauri's tray, which is a Win32 notify-icon.

#[cfg(target_os = "linux")]
#[path = "tray_linux.rs"]
mod imp;

#[cfg(windows)]
#[path = "tray_windows.rs"]
mod imp;

pub use imp::*;
