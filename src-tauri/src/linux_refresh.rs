//! WebKitGTK frame pacing on a high-refresh panel.
//!
//! WebKit's default `PreferPageRenderingUpdatesNear60FPS` picks a cadence near
//! 60 Hz even when the display is 120 Hz. On this stack that default does not
//! even land on 60: GTK3 presents at 60 Hz and the extra skip drops
//! `requestAnimationFrame` to ~30 fps, which is what wheel interpolation and
//! the editor both ride on.
//!
//! Turning the preference off lets rAF follow the GTK present rate (~60 Hz
//! here). True 120 Hz would need GTK3 to pace GL-painted windows from the
//! compositor's frame callbacks; on Wayland it never requests them for a
//! window that paints through GL (WebKit does) and falls back to a
//! hard-coded 60 Hz interval. Only a GTK3 patch or a GTK4 shell lifts that.

use std::ffi::{c_char, c_int, CStr};

use webkit2gtk::glib::ObjectType;
use webkit2gtk::{WebView, WebViewExt};

const PREFER_60: &str = "PreferPageRenderingUpdatesNear60FPS";

#[repr(C)]
struct WebKitFeatureList {
    _priv: [u8; 0],
}

#[repr(C)]
struct WebKitFeature {
    _priv: [u8; 0],
}

extern "C" {
    fn webkit_settings_get_all_features() -> *mut WebKitFeatureList;
    fn webkit_feature_list_get(list: *mut WebKitFeatureList, index: usize) -> *mut WebKitFeature;
    fn webkit_feature_list_get_length(list: *mut WebKitFeatureList) -> usize;
    fn webkit_feature_list_unref(list: *mut WebKitFeatureList);
    fn webkit_feature_get_identifier(feature: *mut WebKitFeature) -> *const c_char;
    fn webkit_settings_set_feature_enabled(
        settings: *mut webkit2gtk::ffi::WebKitSettings,
        feature: *mut WebKitFeature,
        enabled: c_int,
    );
}

/// Match page updates to the display instead of forcing ~60 fps.
pub fn unlock(webview: &WebView) {
    let Some(settings) = webview.settings() else {
        return;
    };
    // SAFETY: `settings` is the webview's live WebKitSettings; the FFI
    // walks WebKit's feature list and unrefs it before returning.
    unsafe { disable_prefer_60(settings.as_ptr()) }
}

unsafe fn disable_prefer_60(settings: *mut webkit2gtk::ffi::WebKitSettings) {
    let list = webkit_settings_get_all_features();
    if list.is_null() {
        return;
    }
    let n = webkit_feature_list_get_length(list);
    for i in 0..n {
        let feature = webkit_feature_list_get(list, i);
        if feature.is_null() {
            continue;
        }
        let id = webkit_feature_get_identifier(feature);
        if id.is_null() {
            continue;
        }
        let id = CStr::from_ptr(id);
        if id.to_bytes() == PREFER_60.as_bytes() {
            webkit_settings_set_feature_enabled(settings, feature, 0);
            break;
        }
    }
    webkit_feature_list_unref(list);
}
