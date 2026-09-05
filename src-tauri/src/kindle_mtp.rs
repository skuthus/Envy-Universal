//! Kindles that speak MTP instead of mounting as a drive (every Paperwhite
//! since 2021, and the rest of the current line-up).
//!
//! The desktop's GIO layer (gvfs) sees such a device as an `mtp://` volume
//! and can read files straight off it, no FUSE mount needed. `gio` is glib's
//! own command-line tool, so it is on any machine that can run a GTK app,
//! and shelling out to it keeps the MTP stack — libmtp, udev, the volume
//! monitor — out of Envy's process. Everything here is best-effort: a
//! missing `gio`, an unmounted device, or a Kindle with no Clippings file all
//! come back as "no Kindle", and the drive-mount path stays the first answer.

use std::process::Command;

/// A Clippings location this module produced, as opposed to a file path.
pub fn is_uri(source: &str) -> bool {
    source.starts_with("mtp://")
}

/// The Clippings file on a plugged-in MTP Kindle, as a `gio` URI, if any.
pub fn detect() -> Option<String> {
    for root in mtp_roots() {
        if let Some(uri) = clippings_under(&root) {
            return Some(uri);
        }
    }
    None
}

/// Reads the file at an `mtp://` URI. The size cap matches the drive path's:
/// a Clippings file is a few megabytes at most, and anything bigger is not
/// one.
pub fn read(uri: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    let out = Command::new("gio")
        .args(["cat", uri])
        .output()
        .map_err(|e| format!("Couldn't read the Kindle: gio could not run ({e})"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("Couldn't read the Kindle: {err}"));
    }
    if out.stdout.len() > max_bytes {
        return Err("That file is over 64 MB — it isn't a Kindle Clippings file.".to_string());
    }
    Ok(out.stdout)
}

/// Every mounted `mtp://` root GIO lists. A Kindle that is plugged in but
/// not yet mounted is mounted first: GIO only mounts an MTP volume when
/// something asks, and nothing else on the desktop necessarily has.
fn mtp_roots() -> Vec<String> {
    let listing = gio(&["mount", "-li"]).unwrap_or_default();
    let mut roots = mtp_roots_in(&listing);
    if roots.is_empty() {
        for uri in activation_roots_in(&listing) {
            // Failure here just means "still not mounted", which the empty
            // result below already says.
            let _ = gio(&["mount", &uri]);
        }
        roots = mtp_roots_in(&gio(&["mount", "-l"]).unwrap_or_default());
    }
    roots
}

/// `Mount(N): <name> -> mtp://…/` lines, deduplicated.
fn mtp_roots_in(listing: &str) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    for line in listing.lines() {
        let Some((_, rest)) = line.split_once("-> ") else { continue };
        let uri = rest.trim();
        if uri.starts_with("mtp://") && !roots.iter().any(|r| r == uri) {
            roots.push(uri.to_string());
        }
    }
    roots
}

/// `activation_root=mtp://…/` from `gio mount -li`, for volumes not mounted.
fn activation_roots_in(listing: &str) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    for line in listing.lines() {
        let Some((_, rest)) = line.trim().split_once("activation_root=") else { continue };
        let uri = rest.trim();
        if uri.starts_with("mtp://") && !roots.iter().any(|r| r == uri) {
            roots.push(uri.to_string());
        }
    }
    roots
}

/// `<root><storage>/documents/My Clippings.txt`, found case-insensitively
/// one level at a time — a Kindle's folder is `documents`, but the search
/// mirrors the drive path's tolerance rather than assuming.
fn clippings_under(root: &str) -> Option<String> {
    for storage in gio_list(root) {
        let storage_uri = join(root, &storage);
        let Some(documents) = gio_list(&storage_uri)
            .into_iter()
            .find(|n| n.eq_ignore_ascii_case("documents"))
        else {
            continue;
        };
        let documents_uri = join(&storage_uri, &documents);
        if let Some(file) = gio_list(&documents_uri)
            .into_iter()
            .find(|n| n.eq_ignore_ascii_case(envy_core::kindle::CLIPPINGS_FILENAME))
        {
            return Some(join(&documents_uri, &file));
        }
    }
    None
}

fn join(base: &str, name: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

fn gio_list(uri: &str) -> Vec<String> {
    gio(&["list", uri])
        .map(|out| out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

fn gio(args: &[&str]) -> Option<String> {
    let out = Command::new("gio").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTING: &str = "\
Volume(0): Kindle Paperwhite
  Type: GProxyVolume (GProxyVolumeMonitorMTP)
  activation_root=mtp://Amazon_Kindle_Paperwhite_GN433X074287030G/
  Mount(0): Kindle Paperwhite -> mtp://Amazon_Kindle_Paperwhite_GN433X074287030G/
    Type: GProxyShadowMount (GProxyVolumeMonitorMTP)
Mount(1): mtp -> mtp://Amazon_Kindle_Paperwhite_GN433X074287030G/
  Type: GDaemonMount
Mount(2): sftp -> sftp://example.org/
";

    #[test]
    fn mounted_mtp_roots_are_found_once() {
        assert_eq!(
            mtp_roots_in(LISTING),
            vec!["mtp://Amazon_Kindle_Paperwhite_GN433X074287030G/".to_string()]
        );
    }

    #[test]
    fn activation_roots_name_unmounted_volumes() {
        assert_eq!(
            activation_roots_in(LISTING),
            vec!["mtp://Amazon_Kindle_Paperwhite_GN433X074287030G/".to_string()]
        );
    }

    #[test]
    fn uris_join_without_doubling_the_slash() {
        assert_eq!(join("mtp://x/", "Internal Storage"), "mtp://x/Internal Storage");
        assert_eq!(join("mtp://x/Internal Storage", "documents"), "mtp://x/Internal Storage/documents");
        assert!(is_uri("mtp://x/"));
        assert!(!is_uri("/run/media/me/Kindle/documents/My Clippings.txt"));
    }
}
