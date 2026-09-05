//! The security invariants, pinned at the public store API — the same surface
//! the Tauri commands call.
//!
//! `store.rs` unit-tests these rules against its private helpers
//! (`guard_write`, `contains`, `writes_inside`). This file re-states them from
//! outside the crate, so a refactor that keeps the helpers passing while
//! quietly dropping a call to one of them still fails. Each test says which
//! attack it prevents; if you change one, change the attack description too or
//! the test has stopped meaning anything.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use envy_core::filename::sanitize_title;
use envy_core::store::sanitized_subfolder;
use envy_core::{Note, NoteStore};
use tempfile::TempDir;

/// A vault holding `files`, opened with subfolder scanning off — the same
/// helper shape `store.rs`'s own tests use.
fn store_with(files: &[(&str, &str)]) -> (TempDir, NoteStore) {
    let dir = tempfile::tempdir().unwrap();
    for (rel, content) in files {
        let path = dir.path().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
    }
    let store = NoteStore::open(dir.path(), false).unwrap();
    (dir, store)
}

fn titles(store: &NoteStore) -> Vec<String> {
    let mut t: Vec<String> = store.notes().iter().map(|n| n.title().to_string()).collect();
    t.sort();
    t
}

/// Whether `path` really lands inside `base`, symlinks and `..` resolved.
fn resolves_inside(path: &Path, base: &Path) -> bool {
    let base = dunce::canonicalize(base).unwrap_or_else(|_| base.to_path_buf());
    let parent = path.parent().unwrap_or(path);
    let parent = dunce::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    parent.starts_with(&base)
}

// --- (a) attachment names ------------------------------------------------------

/// Prevents: `![[../../.ssh/id_rsa]]` in a note body resolving to a real file
/// outside the vault, which merely opening that note would then read, reveal
/// or (via rename) move.
#[test]
fn attachment_names_always_resolve_to_a_leaf_inside_attachments() {
    let (_d, store) = store_with(&[("A.md", "x")]);
    let attachments = store.attachments_dir();

    for name in [
        "../secret.png",
        "../../../../etc/passwd",
        "..\\..\\windows\\system32\\config",
        "/etc/shadow",
        "/absolute/path/pic.png",
        "sub/dir/pic.png",
        ".",
        "..",
        "",
        "./../pic.png",
    ] {
        let resolved = store.attachment_path(name);
        assert_eq!(
            resolved.parent(),
            Some(attachments.as_path()),
            "{name:?} escaped Attachments/ (resolved to {resolved:?})"
        );
        let leaf = resolved.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            leaf != "." && leaf != ".." && !leaf.contains('/') && !leaf.contains('\\'),
            "{name:?} kept a traversing leaf {leaf:?}"
        );
    }
}

// --- (b) symlinks ---------------------------------------------------------------

/// Prevents: dropping an `Inbox` symlink into a vault pulling somebody else's
/// notes into the list — where a save or a delete would then write through it.
#[cfg(unix)]
#[test]
fn a_symlinked_inbox_is_not_scanned() {
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("Secret.md"), "not yours").unwrap();
    let (dir, _store) = store_with(&[("Real.md", "x")]);
    std::os::unix::fs::symlink(outside.path(), dir.path().join("Inbox")).unwrap();

    let store = NoteStore::open(dir.path(), true).unwrap();
    assert_eq!(titles(&store), vec!["Real"]);
}

/// Prevents: a symlinked `.trash` taking the folder it points at with it when
/// the trash is emptied, which erases files the vault never owned.
#[cfg(unix)]
#[test]
fn a_symlinked_trash_is_not_scanned() {
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("Deleted.md"), "not yours").unwrap();
    let (dir, _store) = store_with(&[("Real.md", "x")]);
    std::os::unix::fs::symlink(outside.path(), dir.path().join(".trash")).unwrap();

    let store = NoteStore::open(dir.path(), false).unwrap();
    assert!(store.trashed_notes().is_empty(), "a symlinked .trash was scanned");
}

/// Prevents: a symlinked `.md` being listed as a note, then saved, renamed or
/// trashed *through the link* — writing wherever it pointed.
#[cfg(unix)]
#[test]
fn a_symlinked_note_is_not_scanned() {
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("Secret.md");
    fs::write(&target, "not yours").unwrap();
    let (dir, _store) = store_with(&[("Real.md", "x")]);
    std::os::unix::fs::symlink(&target, dir.path().join("Linked.md")).unwrap();

    let store = NoteStore::open(dir.path(), false).unwrap();
    assert_eq!(titles(&store), vec!["Real"]);
}

// --- (c) writes that resolve outside the Index ----------------------------------

/// Prevents: a stale in-memory note or a frontend-supplied id naming a path
/// outside the vault, turning save/rename/delete into arbitrary file writes.
#[test]
fn save_rename_and_delete_refuse_a_note_outside_the_index() {
    let (_d, mut store) = store_with(&[("Real.md", "x")]);
    let outside = tempfile::tempdir().unwrap();
    let victim = outside.path().join("Victim.md");
    fs::write(&victim, "original").unwrap();

    let forged = Note::new(victim.clone(), "overwritten", SystemTime::now());

    assert!(store.save(&forged).is_err(), "save wrote outside the Index");
    assert!(store.rename(&forged, "Renamed").is_err(), "rename moved a file outside");
    store.delete(std::slice::from_ref(&forged));

    assert!(victim.exists(), "delete trashed a file outside the Index");
    assert_eq!(fs::read_to_string(&victim).unwrap(), "original");
}

/// Prevents: a symlinked folder inside the vault laundering an outside path
/// past a purely lexical containment check — the write resolves for real.
#[cfg(unix)]
#[test]
fn a_write_through_a_symlinked_folder_is_refused() {
    let (dir, mut store) = store_with(&[("Real.md", "x")]);
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("Victim.md"), "original").unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("Linked")).unwrap();

    let through_link = dir.path().join("Linked").join("Victim.md");
    let forged = Note::new(through_link, "overwritten", SystemTime::now());

    assert!(store.save(&forged).is_err(), "save followed a symlinked folder out");
    assert_eq!(
        fs::read_to_string(outside.path().join("Victim.md")).unwrap(),
        "original"
    );
}

/// Prevents: `move_note(id, Some("../.."))` filing a note into a folder
/// outside the Index, where the vault would then lose track of it entirely.
#[test]
fn a_move_into_a_traversing_subfolder_never_leaves_the_index() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("Real.md"), "x").unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let mut store = NoteStore::open(dir.path(), true).unwrap();
    let id = store.notes()[0].id().to_string();

    for escape in ["../escape", "../../escape", "..", "./../escape", "Projects/../../out"] {
        let moved = store.move_note(&id, Some(escape));
        let landed: PathBuf = match moved {
            Some(note) => note.url().to_path_buf(),
            None => continue,
        };
        assert!(
            resolves_inside(&landed, &root),
            "{escape:?} filed the note at {landed:?}, outside {root:?}"
        );
    }
    assert!(!root.parent().unwrap().join("escape").exists());
}

// --- (d) attachments coming in from outside -------------------------------------

/// Prevents: a drag-and-drop (or anything reaching the command behind it)
/// dropping a `.desktop`, a `.sh` or a disk image into a folder people open
/// from the app.
#[test]
fn copy_attachment_refuses_a_non_image() {
    let (_d, store) = store_with(&[("A.md", "x")]);
    let outside = tempfile::tempdir().unwrap();
    let payload = outside.path().join("payload.desktop");
    fs::write(&payload, "[Desktop Entry]\nExec=rm -rf ~\n").unwrap();

    assert!(store.copy_attachment(&payload).is_err());
    assert!(!store.attachments_dir().join("payload.desktop").exists());
}

/// Prevents: a mis-drop of a multi-gigabyte file duplicating itself into the
/// vault (and, for a device node, never finishing at all).
#[test]
fn copy_attachment_refuses_a_file_over_the_size_cap() {
    let (_d, store) = store_with(&[("A.md", "x")]);
    let outside = tempfile::tempdir().unwrap();
    let huge = outside.path().join("huge.png");
    // Sparse: `set_len` past the cap costs no disk, and the guard reads the
    // length from the metadata, which is exactly what it is guarding on.
    let file = fs::File::create(&huge).unwrap();
    file.set_len(NoteStore::MAX_ATTACHMENT_BYTES + 1).unwrap();
    drop(file);

    assert!(store.copy_attachment(&huge).is_err());
    assert!(!store.attachments_dir().join("huge.png").exists());
}

/// Prevents: the clipboard-paste path writing an executable or a launcher into
/// `Attachments/` by naming a non-image extension.
#[test]
fn save_attachment_refuses_a_non_image_extension() {
    let (_d, store) = store_with(&[("A.md", "x")]);

    for ext in ["sh", "desktop", "exe", "md", "svg\u{0}"] {
        assert!(
            store.save_attachment(b"payload", "Pasted image", ext).is_err(),
            "save_attachment accepted .{ext}"
        );
    }
    assert!(store.save_attachment(b"\x89PNG", "Pasted image", "png").is_ok());
}

// --- (e) and (f) name sanitising -------------------------------------------------

/// Prevents: a note titled `../../.bashrc` writing its file outside the vault
/// when it is created, renamed or made from a template.
#[test]
fn sanitize_title_strips_path_separators_and_traversal() {
    for raw in ["../../.bashrc", r"..\..\evil", "a/b", "sub/dir/Note", "/etc/passwd"] {
        let safe = sanitize_title(raw);
        assert!(
            !safe.contains('/') && !safe.contains('\\'),
            "{raw:?} kept a separator: {safe:?}"
        );
        assert!(safe != "." && safe != "..", "{raw:?} stayed traversing: {safe:?}");
    }
    // A title that is nothing but traversal has no usable name left at all.
    assert_eq!(sanitize_title(".."), "Untitled");
    assert_eq!(sanitize_title("."), "Untitled");
    // Trailing dots are trimmed too, so nothing is left that names a parent.
    assert_eq!(sanitize_title("../.."), "..-");
}

/// Prevents: a folder name from the frontend (a rename, a "file into…", a
/// template's folder) creating or writing a directory outside the Index.
#[test]
fn subfolder_names_that_traverse_are_rejected() {
    for raw in ["..", "../escape", "a/../../b", "./..", "", "   ", "/"] {
        assert!(
            sanitized_subfolder(raw).is_none() || !sanitized_subfolder(raw).unwrap().contains(".."),
            "{raw:?} survived as {:?}",
            sanitized_subfolder(raw)
        );
    }
    assert_eq!(sanitized_subfolder(".."), None);
    assert_eq!(sanitized_subfolder("../escape"), None);
    assert_eq!(sanitized_subfolder("a/../b"), None);
    // A legitimate nested path still works, or the guard is just breaking things.
    assert_eq!(sanitized_subfolder("Projects/Envy"), Some("Projects/Envy".to_string()));
}

/// Prevents: `create_in_subfolder` with a traversing path writing the new note
/// outside the vault rather than falling back to the root.
#[test]
fn creating_in_a_traversing_subfolder_falls_back_inside_the_index() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    let mut store = NoteStore::open(dir.path(), true).unwrap();

    let note = store.create_in_subfolder("Escaped", "../escape").unwrap();
    assert!(
        resolves_inside(note.url(), &root),
        "note landed at {:?}, outside {root:?}",
        note.url()
    );
    assert!(!root.parent().unwrap().join("escape").exists());
}
