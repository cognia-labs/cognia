//! Replacing a managed execution directory's contents with a snapshot.
//!
//! A restore used to empty the directory and then write the snapshot into it,
//! so a failure partway (a blob that would not read, a full disk) left the
//! directory half rebuilt with the previous contents already gone. Here the
//! snapshot is built in a staging directory first and swapped in only when it
//! is complete; the previous contents are moved aside, not deleted, until the
//! swap has finished, so a failure at any point puts them back.

use crate::snapshot::{materialize, WorkspaceSnapshot};
use std::{
    collections::HashMap,
    ffi::OsString,
    fs,
    path::Path,
};
use uuid::Uuid;

/// Make `execution_root` hold exactly `snapshot`, keeping its `.git`.
///
/// On failure the directory is as it was. If even putting it back failed, the
/// error names the two sibling directories that still hold the previous and
/// the new contents, and neither is deleted.
pub(crate) fn replace_worktree_contents(
    execution_root: &Path,
    snapshot: &WorkspaceSnapshot,
    blobs: &HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    // Siblings of the root are on its filesystem, so every move is a rename.
    let parent = execution_root
        .parent()
        .ok_or_else(|| format!("execution root has no parent: {}", execution_root.display()))?;
    let id = Uuid::now_v7();
    let staged = parent.join(format!(".cognia-restore-{id}"));
    let previous = parent.join(format!(".cognia-replaced-{id}"));

    if let Err(error) = materialize(&staged, snapshot, blobs) {
        let _ = fs::remove_dir_all(&staged);
        return Err(error);
    }
    let incoming = match top_level(&staged) {
        Ok(names) => names,
        Err(error) => {
            let _ = fs::remove_dir_all(&staged);
            return Err(error);
        }
    };
    // `.git` stays where it is unless the snapshot brings its own.
    let outgoing = top_level(execution_root).map(|names| {
        names
            .into_iter()
            .filter(|name| name != ".git" || incoming.iter().any(|new| new == ".git"))
            .collect::<Vec<_>>()
    });
    let swapped = outgoing
        .and_then(|outgoing| {
            fs::create_dir(&previous)
                .map_err(|error| format!("create {}: {error}", previous.display()))?;
            Ok(outgoing)
        })
        .map_err(SwapFailure::RolledBack)
        .and_then(|outgoing| swap(execution_root, &staged, &previous, &outgoing, &incoming));
    match swapped {
        Ok(()) => {
            // The swap is done; what is left beside the root is disposable.
            let _ = fs::remove_dir_all(&previous);
            let _ = fs::remove_dir_all(&staged);
            Ok(())
        }
        Err(SwapFailure::RolledBack(error)) => {
            let _ = fs::remove_dir_all(&previous);
            let _ = fs::remove_dir_all(&staged);
            Err(error)
        }
        Err(SwapFailure::Stranded(error)) => Err(format!(
            "{error}; the directory is partly replaced: its previous contents are in {} and the new ones in {}",
            previous.display(),
            staged.display()
        )),
    }
}

enum SwapFailure {
    /// The directory is as it was before the swap.
    RolledBack(String),
    /// Putting it back failed too; both sibling directories are kept.
    Stranded(String),
}

/// Move `outgoing` from the root into `previous`, then `incoming` from
/// `staged` into the root. Any failure reverses the moves already made.
fn swap(
    root: &Path,
    staged: &Path,
    previous: &Path,
    outgoing: &[OsString],
    incoming: &[OsString],
) -> Result<(), SwapFailure> {
    let mut moved_out = Vec::new();
    let mut moved_in = Vec::new();
    let failure = 'moves: {
        for name in outgoing {
            if let Err(error) = move_entry(&root.join(name), &previous.join(name)) {
                break 'moves error;
            }
            moved_out.push(name);
        }
        for name in incoming {
            if let Err(error) = move_entry(&staged.join(name), &root.join(name)) {
                break 'moves error;
            }
            moved_in.push(name);
        }
        return Ok(());
    };
    // Undo in reverse: new entries leave first, then the old ones return. The
    // undo is not subject to failure injection, only to the filesystem.
    let undone = moved_in
        .iter()
        .rev()
        .map(|name| (root.join(name), staged.join(name)))
        .chain(
            moved_out
                .iter()
                .rev()
                .map(|name| (previous.join(name), root.join(name))),
        )
        .try_for_each(|(from, to)| {
            fs::rename(&from, &to)
                .map_err(|error| format!("could not move {} back: {error}", from.display()))
        });
    Err(match undone {
        Ok(()) => SwapFailure::RolledBack(failure),
        Err(undo_error) => SwapFailure::Stranded(format!("{failure}; {undo_error}")),
    })
}

fn move_entry(from: &Path, to: &Path) -> Result<(), String> {
    failpoint::before_move()?;
    fs::rename(from, to)
        .map_err(|error| format!("move {} to {}: {error}", from.display(), to.display()))
}

/// The names directly under `dir`, in a stable order.
fn top_level(dir: &Path) -> Result<Vec<OsString>, String> {
    let mut names = fs::read_dir(dir)
        .map_err(|error| format!("read {}: {error}", dir.display()))?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|error| format!("read {} entry: {error}", dir.display()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    Ok(names)
}

/// Test-only failure injection: the n-th move (counting from zero) fails.
#[cfg(test)]
mod failpoint {
    use std::cell::Cell;

    thread_local! {
        static FAIL_AT: Cell<Option<usize>> = const { Cell::new(None) };
        static MOVES: Cell<usize> = const { Cell::new(0) };
    }

    pub(super) fn arm(nth: Option<usize>) {
        FAIL_AT.with(|fail| fail.set(nth));
        MOVES.with(|moves| moves.set(0));
    }

    pub(super) fn before_move() -> Result<(), String> {
        let nth = MOVES.with(|moves| moves.replace(moves.get() + 1));
        if FAIL_AT.with(Cell::get) == Some(nth) {
            return Err(format!("injected move failure #{nth}"));
        }
        Ok(())
    }
}

#[cfg(not(test))]
mod failpoint {
    #[inline(always)]
    pub(super) fn before_move() -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::{EntryKind, SnapshotEntry};
    use std::{collections::BTreeMap, path::PathBuf};
    use tempfile::TempDir;

    /// Any stable key does: the snapshot and the blob map only have to agree.
    fn hash(bytes: &[u8]) -> String {
        format!("blob-{}", String::from_utf8_lossy(bytes))
    }

    fn snapshot_of(
        files: &[(&str, EntryKind, &[u8])],
    ) -> (WorkspaceSnapshot, HashMap<String, Vec<u8>>) {
        let mut snapshot = WorkspaceSnapshot::default();
        let mut blobs = HashMap::new();
        for (path, kind, bytes) in files {
            blobs.insert(hash(bytes), bytes.to_vec());
            snapshot.entries.insert(
                path.to_string(),
                SnapshotEntry {
                    path: path.to_string(),
                    kind: kind.clone(),
                    hash: hash(bytes),
                    size: bytes.len() as u64,
                    mode: None,
                    binary: false,
                    media_type: "text/plain".into(),
                    sensitive: false,
                },
            );
        }
        (snapshot, blobs)
    }

    /// Every path under `root` with what it holds, so two states compare whole.
    fn tree(root: &Path) -> BTreeMap<String, String> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let name = path.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                let metadata = fs::symlink_metadata(&path).unwrap();
                if metadata.file_type().is_symlink() {
                    let target = fs::read_link(&path).unwrap();
                    out.insert(name, format!("link:{}", target.display()));
                } else if metadata.is_dir() {
                    out.insert(name, "dir".into());
                    walk(root, &path, out);
                } else {
                    out.insert(name, format!("file:{}", fs::read_to_string(&path).unwrap()));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, root, &mut out);
        out
    }

    fn siblings(root: &Path) -> Vec<OsString> {
        fs::read_dir(root.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect()
    }

    /// A parent holding one execution root with a `.git`, tracked files, a
    /// nested directory and a file the snapshot does not know about.
    fn seeded() -> (TempDir, PathBuf) {
        let parent = TempDir::new().unwrap();
        let root = parent.path().join("run");
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::write(root.join(".git"), "gitdir: elsewhere").unwrap();
        fs::write(root.join("keep.txt"), "old keep").unwrap();
        fs::write(root.join("src/deep/a.rs"), "old a").unwrap();
        fs::write(root.join("extra.txt"), "not in the snapshot").unwrap();
        (parent, root)
    }

    #[test]
    fn a_restore_replaces_the_contents_and_keeps_git() {
        let (_parent, root) = seeded();
        let (snapshot, blobs) = snapshot_of(&[
            ("keep.txt", EntryKind::File, b"new keep"),
            ("src/b.rs", EntryKind::File, b"new b"),
            ("link", EntryKind::Symlink, b"keep.txt"),
        ]);
        replace_worktree_contents(&root, &snapshot, &blobs).unwrap();
        assert_eq!(
            tree(&root),
            BTreeMap::from([
                (".git".to_string(), "file:gitdir: elsewhere".to_string()),
                ("keep.txt".to_string(), "file:new keep".to_string()),
                ("link".to_string(), "link:keep.txt".to_string()),
                ("src".to_string(), "dir".to_string()),
                ("src/b.rs".to_string(), "file:new b".to_string()),
            ])
        );
        assert_eq!(siblings(&root), [OsString::from("run")]);
    }

    #[test]
    fn a_snapshot_that_cannot_be_built_leaves_the_directory_untouched() {
        let (_parent, root) = seeded();
        let before = tree(&root);
        let (snapshot, mut blobs) = snapshot_of(&[
            ("keep.txt", EntryKind::File, b"new keep"),
            ("src/b.rs", EntryKind::File, b"new b"),
        ]);
        blobs.remove(&hash(b"new b"));
        let error = replace_worktree_contents(&root, &snapshot, &blobs).unwrap_err();
        assert!(error.contains("missing blob"), "{error}");
        assert_eq!(tree(&root), before);
        assert_eq!(siblings(&root), [OsString::from("run")]);
    }

    #[test]
    fn a_swap_that_fails_at_any_move_puts_the_previous_contents_back() {
        // Three entries move out (keep.txt, src, extra.txt) and two move in.
        for nth in 0..5 {
            let (_parent, root) = seeded();
            let before = tree(&root);
            let (snapshot, blobs) = snapshot_of(&[
                ("keep.txt", EntryKind::File, b"new keep"),
                ("src/b.rs", EntryKind::File, b"new b"),
            ]);
            failpoint::arm(Some(nth));
            let error = replace_worktree_contents(&root, &snapshot, &blobs).unwrap_err();
            failpoint::arm(None);
            assert!(error.contains("injected move failure"), "move {nth}: {error}");
            assert_eq!(tree(&root), before, "move {nth}");
            assert_eq!(siblings(&root), [OsString::from("run")], "move {nth}");
        }
    }

    #[test]
    fn an_empty_snapshot_empties_the_directory_but_for_git() {
        let (_parent, root) = seeded();
        let (snapshot, blobs) = snapshot_of(&[]);
        replace_worktree_contents(&root, &snapshot, &blobs).unwrap();
        assert_eq!(
            tree(&root),
            BTreeMap::from([(".git".to_string(), "file:gitdir: elsewhere".to_string())])
        );
    }
}
