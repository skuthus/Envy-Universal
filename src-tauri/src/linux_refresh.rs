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
//!
//! The feature APIs are Since: 2.42. The webkit2gtk crate's floor stops at
//! `v2_40`, so the symbols are resolved with `dlsym` and the unlock is a
//! no-op on older libraries instead of an undefined-symbol crash at start.

use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::OnceLock;

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

type GetAllFeatures = unsafe extern "C" fn() -> *mut WebKitFeatureList;
type FeatureListGet = unsafe extern "C" fn(*mut WebKitFeatureList, usize) -> *mut WebKitFeature;
type FeatureListLen = unsafe extern "C" fn(*mut WebKitFeatureList) -> usize;
type FeatureListUnref = unsafe extern "C" fn(*mut WebKitFeatureList);
type FeatureIdentifier = unsafe extern "C" fn(*mut WebKitFeature) -> *const c_char;
type SetFeatureEnabled = unsafe extern "C" fn(
    *mut webkit2gtk::ffi::WebKitSettings,
    *mut WebKitFeature,
    c_int,
);

struct FeatureFfi {
    get_all: GetAllFeatures,
    list_get: FeatureListGet,
    list_len: FeatureListLen,
    list_unref: FeatureListUnref,
    identifier: FeatureIdentifier,
    set_enabled: SetFeatureEnabled,
}

#[link(name = "dl")]
extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

/// Linux's `RTLD_DEFAULT`: search the global scope (already-loaded WebKit).
const RTLD_DEFAULT: *mut c_void = std::ptr::null_mut();

unsafe fn load_sym<T>(name: &CStr) -> Option<T> {
    debug_assert_eq!(
        std::mem::size_of::<T>(),
        std::mem::size_of::<*mut c_void>(),
        "dlsym result must be pointer-sized"
    );
    let p = dlsym(RTLD_DEFAULT, name.as_ptr());
    if p.is_null() {
        None
    } else {
        // SAFETY: caller passes a C function-pointer type matching `name`'s ABI;
        // size matches a pointer on this platform.
        Some(std::ptr::read(&p as *const *mut c_void as *const T))
    }
}

fn feature_ffi() -> Option<&'static FeatureFfi> {
    static FFI: OnceLock<Option<FeatureFfi>> = OnceLock::new();
    FFI.get_or_init(|| {
        // SAFETY: `dlsym` with RTLD_DEFAULT looks up symbols in the process;
        // each cast matches WebKitGTK 2.42+'s C ABI for that name.
        unsafe {
            Some(FeatureFfi {
                get_all: load_sym(c"webkit_settings_get_all_features")?,
                list_get: load_sym(c"webkit_feature_list_get")?,
                list_len: load_sym(c"webkit_feature_list_get_length")?,
                list_unref: load_sym(c"webkit_feature_list_unref")?,
                identifier: load_sym(c"webkit_feature_get_identifier")?,
                set_enabled: load_sym(c"webkit_settings_set_feature_enabled")?,
            })
        }
    })
    .as_ref()
}

/// Match page updates to the display instead of forcing ~60 fps.
pub fn unlock(webview: &WebView) {
    let Some(settings) = webview.settings() else {
        return;
    };
    let Some(ffi) = feature_ffi() else {
        return;
    };
    // SAFETY: `settings` is the webview's live WebKitSettings; the FFI
    // walks WebKit's feature list and unrefs it before returning.
    unsafe { disable_prefer_60(ffi, settings.as_ptr()) }
}

unsafe fn disable_prefer_60(
    ffi: &FeatureFfi,
    settings: *mut webkit2gtk::ffi::WebKitSettings,
) {
    let list = (ffi.get_all)();
    if list.is_null() {
        return;
    }
    let n = (ffi.list_len)(list);
    for i in 0..n {
        let feature = (ffi.list_get)(list, i);
        if feature.is_null() {
            continue;
        }
        let id = (ffi.identifier)(feature);
        if id.is_null() {
            continue;
        }
        let id = CStr::from_ptr(id);
        if id.to_bytes() == PREFER_60.as_bytes() {
            (ffi.set_enabled)(settings, feature, 0);
            break;
        }
    }
    (ffi.list_unref)(list);
}
