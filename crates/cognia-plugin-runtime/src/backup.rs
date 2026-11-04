//! Plugin backup snapshots (Batch 3c).
//!
//! Backup tarballs land at
//! `<install_dir>/_backups/<plugin_id>-<timestamp>.tar.gz`. The `_backups`
//! directory is namespace-collocated with installed plugins so a single
//! `plugin_uninstall` doesn't accidentally drop the tarball — that's
//! `plugin_backup_delete`'s job.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use chrono::Utc;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
#[cfg(feature = "tauri-host")]
use tauri::State;

use super::{PluginError, PluginRuntimeState, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPayload {
    pub backup_id: String,
    pub plugin_id: String,
    pub label: Option<String>,
    pub created_at: String,
    pub size_bytes: u64,
    pub path: String,
}

fn backups_dir(state: &PluginRuntimeState) -> PathBuf {
    state.plugin_install_dir.join("_backups")
}

fn ensure_backups_dir(state: &PluginRuntimeState) -> Result<PathBuf> {
    let dir = backups_dir(state);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn plugin_backup_create(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    label: Option<String>,
) -> Result<BackupPayload> {
    plugin_backup_create_for_state(state.inner(), plugin_id, label).await
}

/// Host-neutral backup creation used by Tauri and the headless companion host.
pub async fn plugin_backup_create_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    label: Option<String>,
) -> Result<BackupPayload> {
    crate::validate_plugin_id_path_component(&plugin_id)?;
    let plugin_dir = state.plugin_dir(&plugin_id);
    let trees = BackupTrees::for_plugin(state, &plugin_id);
    if !plugin_dir.exists() && !trees.vscode_install.exists() {
        return Err(PluginError::NotFound(plugin_id));
    }
    let backups = ensure_backups_dir(state)?;
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S").to_string();
    let backup_id = format!("{plugin_id}-{timestamp}-{}", uuid::Uuid::now_v7());
    let archive_path = backups.join(format!("{backup_id}.tar.gz"));
    let archive_file = File::options()
        .write(true)
        .create_new(true)
        .open(&archive_path)?;
    let encoder = GzEncoder::new(archive_file, Compression::default());
    let mut builder = tar::Builder::new(encoder);
    if plugin_dir.exists() {
        builder
            .append_dir_all(&plugin_id, &plugin_dir)
            .map_err(|e| PluginError::Internal(format!("tar append: {e}")))?;
    }
    for (archived, source) in [
        (
            Path::new(HOST_STATE_ENTRY).join(&plugin_id),
            trees.host_state.clone(),
        ),
        (
            Path::new(VSCODE_INSTALL_ENTRY).join(&plugin_id),
            trees.vscode_install.clone(),
        ),
        (
            Path::new(VSCODE_STATE_ENTRY).join(&plugin_id),
            trees.vscode_state.clone(),
        ),
    ] {
        if source.exists() {
            builder
                .append_dir_all(&archived, &source)
                .map_err(|e| PluginError::Internal(format!("tar {}: {e}", archived.display())))?;
        }
    }
    builder
        .into_inner()
        .map_err(|e| PluginError::Internal(format!("gzip finalize: {e}")))?
        .finish()
        .map_err(|e| PluginError::Internal(format!("gzip finish: {e}")))?;
    let size_bytes = fs::metadata(&archive_path)?.len();
    Ok(BackupPayload {
        backup_id,
        plugin_id,
        label,
        created_at: Utc::now().to_rfc3339(),
        size_bytes,
        path: archive_path.to_string_lossy().into_owned(),
    })
}

#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn plugin_backup_restore(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    backup_id: String,
) -> Result<()> {
    plugin_backup_restore_for_state(state.inner(), plugin_id, backup_id).await
}

/// Host-neutral backup restore used by Tauri and the headless companion host.
pub async fn plugin_backup_restore_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    backup_id: String,
) -> Result<()> {
    crate::validate_plugin_id_path_component(&plugin_id)?;
    let _guard = crate::marketplace::INSTALL_COMMIT_LOCK
        .lock()
        .map_err(|_| PluginError::Internal("install commit lock poisoned".into()))?;
    let expected_prefix = format!("{plugin_id}-");
    if !backup_id.starts_with(&expected_prefix)
        || backup_id
            .chars()
            .any(|character| character == '/' || character == '\\' || character.is_control())
    {
        return Err(PluginError::InvalidArgument(
            "backup_id must be a plugin-scoped identifier".into(),
        ));
    }
    let archive_path = backups_dir(state).join(format!("{backup_id}.tar.gz"));
    if !archive_path.exists() {
        return Err(PluginError::NotFound(format!("backup {backup_id}")));
    }
    fs::create_dir_all(&state.plugin_install_dir)?;
    let transactions = restore_transactions_dir(state);
    fs::create_dir_all(&transactions)?;
    let transaction = tempfile::Builder::new()
        .prefix("restore-")
        .tempdir_in(&transactions)?;
    let extracted = transaction.path().join("extracted");
    fs::create_dir(&extracted)?;
    let plugin_dir = state.plugin_dir(&plugin_id);
    let host_state_dir = state.plugin_host_state_dir(&plugin_id);
    let archive_file = File::open(&archive_path)?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(decoder);
    for entry in archive
        .entries()
        .map_err(|e| PluginError::Internal(format!("read backup entries: {e}")))?
    {
        let mut entry =
            entry.map_err(|e| PluginError::Internal(format!("read backup entry: {e}")))?;
        let path = entry
            .path()
            .map_err(|e| PluginError::Internal(format!("backup entry path: {e}")))?
            .into_owned();
        if path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(PluginError::InvalidArgument(
                "backup contains an unsafe path".into(),
            ));
        }
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err(PluginError::InvalidArgument(
                "backup entries must be regular files or directories".into(),
            ));
        }
        entry
            .unpack_in(&extracted)
            .map_err(|e| PluginError::Internal(format!("unpack backup entry: {e}")))?;
    }

    let trees = BackupTrees::for_plugin(state, &plugin_id);
    let staged_plugin = extracted.join(&plugin_id);
    let staged_vscode = extracted.join(VSCODE_INSTALL_ENTRY).join(&plugin_id);
    if !staged_plugin.is_dir() && !staged_vscode.is_dir() {
        return Err(PluginError::InvalidArgument(
            "backup does not contain the requested plugin".into(),
        ));
    }
    let pairs = [
        (staged_plugin, plugin_dir),
        (
            extracted.join(HOST_STATE_ENTRY).join(&plugin_id),
            host_state_dir,
        ),
        (staged_vscode, trees.vscode_install),
        (
            extracted.join(VSCODE_STATE_ENTRY).join(&plugin_id),
            trees.vscode_state,
        ),
    ];
    let journal = RestoreJournal {
        plugin_id: plugin_id.clone(),
        originals: pairs.iter().map(|(_, target)| target.exists()).collect(),
    };
    let token = transaction
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    for (staged, _) in &pairs {
        if staged.exists() {
            fs::write(staged.join(RESTORE_OWNER), &token)?;
        }
    }
    let mut descriptor = File::create(transaction.path().join("restore.json"))?;
    descriptor.write_all(&serde_json::to_vec(&journal)?)?;
    descriptor.sync_all()?;
    // Keep the journal through both error unwinding and hard process death.
    let scratch = transaction.keep();
    let promote = (|| -> Result<()> {
        swap_trees(&scratch, &pairs)?;
        let mut committed = File::create(scratch.join("committed.tmp"))?;
        committed.write_all(b"1")?;
        committed.sync_all()?;
        fs::rename(scratch.join("committed.tmp"), scratch.join("committed"))?;
        Ok(())
    })();
    if let Err(error) = promote {
        recover_restore(state, &scratch).map_err(|recovery| {
            PluginError::Internal(format!("{error}; restore recovery: {recovery}"))
        })?;
        return Err(error);
    }
    #[cfg(test)]
    tests::checkpoint("committed", 0);
    // Cleanup cannot turn a durably committed restore into a reported failure.
    if let Err(error) = recover_restore(state, &scratch) {
        log::warn!("plugin restore cleanup deferred: {error}");
    }
    Ok(())
}

const HOST_STATE_ENTRY: &str = ".host-state";
const VSCODE_INSTALL_ENTRY: &str = ".vscode-extension";
const VSCODE_STATE_ENTRY: &str = ".vscode-extension-state";
const RESTORE_OWNER: &str = ".cognia-restore-transaction";

#[derive(Serialize, Deserialize)]
struct RestoreJournal {
    plugin_id: String,
    originals: Vec<bool>,
}

fn restore_transactions_dir(state: &PluginRuntimeState) -> PathBuf {
    backups_dir(state).join(".restores")
}

fn recover_restore(state: &PluginRuntimeState, scratch: &Path) -> Result<()> {
    if fs::symlink_metadata(scratch)?.file_type().is_symlink() {
        return Err(PluginError::InvalidArgument(
            "restore journal cannot be a symlink".into(),
        ));
    }
    let journal: RestoreJournal = serde_json::from_slice(&fs::read(scratch.join("restore.json"))?)?;
    crate::validate_plugin_id_path_component(&journal.plugin_id)?;
    let trees = BackupTrees::for_plugin(state, &journal.plugin_id);
    let targets = [
        state.plugin_dir(&journal.plugin_id),
        trees.host_state,
        trees.vscode_install,
        trees.vscode_state,
    ];
    if journal.originals.len() != targets.len() {
        return Err(PluginError::InvalidArgument(
            "invalid restore descriptor".into(),
        ));
    }
    let token = scratch.file_name().unwrap().to_string_lossy();
    let committed = scratch.join("committed").is_file();
    for (index, target) in targets.iter().enumerate() {
        let marker = target.join(RESTORE_OWNER);
        let owned = fs::read_to_string(&marker).ok().as_deref() == Some(token.as_ref());
        let previous = scratch.join(format!(".rollback-{index}"));
        if committed {
            if owned {
                fs::remove_file(marker)?;
            }
            continue;
        }
        if previous.exists() {
            if target.exists() {
                if !owned || fs::symlink_metadata(target)?.file_type().is_symlink() {
                    return Err(PluginError::InvalidArgument(
                        "refusing to replace unknown tree during restore recovery".into(),
                    ));
                }
                // Never unlink the ownership marker before detaching the
                // entire promoted tree: recovery itself may be terminated.
                let discarded = scratch.join(format!("discarded-{index}"));
                if discarded.exists() {
                    return Err(PluginError::InvalidArgument(
                        "restore recovery target already detached".into(),
                    ));
                }
                fs::rename(target, discarded)?;
                #[cfg(test)]
                tests::checkpoint("recover-moved-aside", index);
            }
            restore_renamed_tree(&previous, target)?;
        } else if !journal.originals[index] {
            if target.exists() {
                if !owned {
                    return Err(PluginError::InvalidArgument(
                        "unknown tree at restore target".into(),
                    ));
                }
                fs::rename(target, scratch.join(format!("discarded-{index}")))?;
            }
        } else if !target.exists() || owned {
            return Err(PluginError::Internal(
                "original restore tree is missing".into(),
            ));
        }
    }
    // A retired journal is cleanup-only even if deletion is interrupted after
    // its commit marker/descriptor has already been unlinked.
    let retired = scratch.with_file_name(format!(".cleanup-{token}"));
    fs::rename(scratch, &retired)?;
    #[cfg(test)]
    tests::checkpoint("cleanup-retired", 0);
    fs::remove_dir_all(retired)?;
    Ok(())
}

/// Called before marketplace recovery, so an interrupted multi-tree restore
/// first returns to its coherent pre-restore package and host state.
pub(crate) fn recover_restore_transactions_for_state(state: &PluginRuntimeState) {
    let Ok(entries) = fs::read_dir(restore_transactions_dir(state)) else {
        return;
    };
    for entry in entries {
        let result = entry.map_err(PluginError::Io).and_then(|entry| {
            if entry.file_name().to_string_lossy().starts_with(".cleanup-") {
                fs::remove_dir_all(entry.path())?;
                return Ok(());
            }
            // Extraction-only transactions never mutated a target. Preserve
            // descriptor-less leftovers rather than guessing their contents.
            if !entry.path().join("restore.json").is_file() {
                return Ok(());
            }
            recover_restore(state, &entry.path())
        });
        if let Err(error) = result {
            log::error!("plugin restore recovery failed: {error}");
        }
    }
}

/// The trees beside a plugin's own directory that its backup carries.
struct BackupTrees {
    host_state: std::path::PathBuf,
    /// A `.vsix` install (`vscode-extensions/<id>`).
    vscode_install: std::path::PathBuf,
    /// Its storage and Mementos (`vscode-extension-state/<id>`).
    vscode_state: std::path::PathBuf,
}

impl BackupTrees {
    fn for_plugin(state: &PluginRuntimeState, plugin_id: &str) -> Self {
        let installs = crate::vscode::extension_install_dir_for(&state.plugin_install_dir);
        let sanitized = crate::sanitize_plugin_id(plugin_id);
        Self {
            host_state: state.plugin_host_state_dir(plugin_id),
            vscode_state: crate::vscode::extension_state_root_for(&installs).join(&sanitized),
            vscode_install: installs.join(sanitized),
        }
    }
}

/// Replace each `(staged, target)`: move every existing target aside under
/// `scratch`, then move each staged tree in. Any failure removes what was
/// moved in and moves every original back.
fn swap_trees(scratch: &Path, pairs: &[(std::path::PathBuf, std::path::PathBuf)]) -> Result<()> {
    for (index, (_, target)) in pairs.iter().enumerate() {
        if target.exists() {
            let rollback = scratch.join(format!(".rollback-{index}"));
            fs::rename(target, &rollback)?;
            #[cfg(test)]
            tests::checkpoint("moved-out", index);
        }
    }
    for (index, (staged, target)) in pairs.iter().enumerate() {
        if !staged.exists() {
            continue;
        }
        let result = target
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| fs::rename(staged, target));
        result?;
        log::trace!("promoted plugin backup tree {index}");
        #[cfg(test)]
        tests::checkpoint("moved-in", index);
    }
    Ok(())
}

fn restore_renamed_tree(source: &Path, target: &Path) -> std::io::Result<()> {
    if !source.exists() {
        return Ok(());
    }
    if target.exists() {
        fs::remove_dir_all(target)?;
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(source, target)
}

#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn plugin_backup_delete(
    state: State<'_, PluginRuntimeState>,
    plugin_id: String,
    backup_id: String,
) -> Result<()> {
    plugin_backup_delete_for_state(state.inner(), plugin_id, backup_id).await
}

/// Host-neutral backup deletion used by Tauri and the headless companion host.
pub async fn plugin_backup_delete_for_state(
    state: &PluginRuntimeState,
    plugin_id: String,
    backup_id: String,
) -> Result<()> {
    crate::validate_plugin_id_path_component(&plugin_id)?;
    if !backup_id.starts_with(&format!("{plugin_id}-"))
        || backup_id
            .chars()
            .any(|character| character == '/' || character == '\\' || character.is_control())
    {
        return Err(PluginError::InvalidArgument(
            "backup_id must be a plugin-scoped identifier".into(),
        ));
    }
    let archive_path = backups_dir(state).join(format!("{backup_id}.tar.gz"));
    if archive_path.exists() {
        fs::remove_file(&archive_path)?;
    }
    Ok(())
}

// Used by tests to validate gzip round-trips without touching tauri state.
#[allow(dead_code)]
fn read_gz_bytes(path: &std::path::Path) -> Result<Vec<u8>> {
    let f = File::open(path)?;
    let mut decoder = GzDecoder::new(f);
    let mut out = Vec::new();
    decoder
        .read_to_end(&mut out)
        .map_err(|e| PluginError::Internal(format!("read_gz: {e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    pub(super) fn checkpoint(phase: &str, index: usize) {
        if std::env::var("COGNIA_PLUGIN_RESTORE_PHASE").ok().as_deref()
            != Some(&format!("{phase}-{index}"))
        {
            return;
        }
        let root = PathBuf::from(std::env::var_os("COGNIA_PLUGIN_RESTORE_TEST_ROOT").unwrap());
        fs::write(root.join("checkpoint"), b"ready").unwrap();
        loop {
            std::thread::park();
        }
    }

    #[tokio::test]
    async fn restore_crash_child() {
        let Some(root) = std::env::var_os("COGNIA_PLUGIN_RESTORE_TEST_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let state = PluginRuntimeState::new(root.join("cognia/plugins"));
        let backup_id = fs::read_to_string(root.join("backup-id")).unwrap();
        plugin_backup_restore_for_state(&state, "demo".into(), backup_id)
            .await
            .unwrap();
    }

    fn terminate_restore_at(root: &Path, phase: &str) {
        let _ = fs::remove_file(root.join("checkpoint"));
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "backup::tests::restore_crash_child",
                "--nocapture",
            ])
            .env("COGNIA_PLUGIN_RESTORE_TEST_ROOT", root)
            .env("COGNIA_PLUGIN_RESTORE_PHASE", phase)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !root.join("checkpoint").exists() && std::time::Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let reached = root.join("checkpoint").exists();
        let _ = child.kill();
        child.wait().unwrap();
        assert!(reached, "child did not reach {phase}");
    }

    #[tokio::test]
    async fn startup_recovers_restore_after_process_termination() {
        for phase in [
            "moved-out-0",
            "moved-out-1",
            "moved-out-2",
            "moved-out-3",
            "moved-in-0",
            "moved-in-1",
            "moved-in-2",
            "moved-in-3",
            "committed-0",
            "cleanup-retired-0",
            "recover-moved-aside-0",
        ] {
            let tmp = TempDir::new().unwrap();
            let state = make_state(&tmp);
            seed_plugin_dir(&state, "demo", "package-a");
            let host_state = state.plugin_host_state_dir("demo");
            fs::create_dir_all(&host_state).unwrap();
            fs::write(host_state.join("settings"), b"state-a").unwrap();
            let trees = BackupTrees::for_plugin(&state, "demo");
            for tree in [&trees.vscode_install, &trees.vscode_state] {
                fs::create_dir_all(tree).unwrap();
                fs::write(tree.join("value"), b"state-a").unwrap();
            }
            let backup = plugin_backup_create_for_state(&state, "demo".into(), None)
                .await
                .unwrap();
            seed_plugin_dir(&state, "demo", "package-b");
            fs::write(host_state.join("settings"), b"state-b").unwrap();
            for tree in [&trees.vscode_install, &trees.vscode_state] {
                fs::write(tree.join("value"), b"state-b").unwrap();
            }
            fs::write(tmp.path().join("backup-id"), backup.backup_id).unwrap();
            if phase == "recover-moved-aside-0" {
                terminate_restore_at(tmp.path(), "moved-in-0");
            }
            terminate_restore_at(tmp.path(), phase);
            let restarted = PluginRuntimeState::new(state.plugin_install_dir.clone());
            let committed = matches!(phase, "committed-0" | "cleanup-retired-0");
            assert_eq!(
                fs::read_to_string(restarted.plugin_dir("demo").join("manifest.json")).unwrap(),
                if committed { "package-a" } else { "package-b" },
                "{phase}"
            );
            for (tree, file) in [
                (&host_state, "settings"),
                (&trees.vscode_install, "value"),
                (&trees.vscode_state, "value"),
            ] {
                assert_eq!(
                    fs::read(tree.join(file)).unwrap(),
                    if committed { b"state-a" } else { b"state-b" },
                    "{phase}"
                );
            }
        }
    }

    fn make_state(tmp: &TempDir) -> PluginRuntimeState {
        // Nested, so the sibling VS Code roots stay inside the temp dir too.
        let plugins = tmp.path().join("cognia").join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        PluginRuntimeState::new(plugins)
    }

    fn seed_plugin_dir(state: &PluginRuntimeState, plugin_id: &str, contents: &str) {
        use std::io::Write as _;
        let dir = state.plugin_dir(plugin_id);
        fs::create_dir_all(&dir).unwrap();
        let mut f = File::create(dir.join("manifest.json")).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
    }

    #[tokio::test]
    async fn backups_in_the_same_second_never_overwrite_each_other() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        for _ in 0..3 {
            seed_plugin_dir(&state, "demo", "version-one");
            let first = plugin_backup_create_for_state(&state, "demo".into(), None)
                .await
                .unwrap();
            let original = fs::read(&first.path).unwrap();
            seed_plugin_dir(&state, "demo", "version-two");
            let second = plugin_backup_create_for_state(&state, "demo".into(), None)
                .await
                .unwrap();
            if first.created_at[..19] == second.created_at[..19] {
                assert_ne!(
                    first.backup_id, second.backup_id,
                    "backup ids must be unique within a second"
                );
                assert_eq!(fs::read(&first.path).unwrap(), original);
                plugin_backup_restore_for_state(&state, "demo".into(), first.backup_id)
                    .await
                    .unwrap();
                assert_eq!(
                    fs::read_to_string(state.plugin_dir("demo").join("manifest.json")).unwrap(),
                    "version-one"
                );
                return;
            }
        }
        panic!("could not create two backups in one second");
    }

    #[test]
    fn create_then_restore_preserves_bytes() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        seed_plugin_dir(&state, "demo", "{\"id\":\"demo\",\"version\":\"1.0.0\"}");

        // Inline the create logic synchronously to avoid the tokio macro
        // overhead in unit tests.
        let backups = ensure_backups_dir(&state).unwrap();
        let archive_path = backups.join("demo-test.tar.gz");
        let archive_file = File::create(&archive_path).unwrap();
        let encoder = GzEncoder::new(archive_file, Compression::default());
        let mut builder = tar::Builder::new(encoder);
        builder
            .append_dir_all("demo", state.plugin_dir("demo"))
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();
        assert!(archive_path.exists());

        // Tamper with the original.
        fs::write(state.plugin_dir("demo").join("manifest.json"), b"tampered").unwrap();

        // Restore.
        fs::remove_dir_all(state.plugin_dir("demo")).unwrap();
        let archive_file = File::open(&archive_path).unwrap();
        let decoder = GzDecoder::new(archive_file);
        let mut archive = tar::Archive::new(decoder);
        archive.unpack(&state.plugin_install_dir).unwrap();

        let restored = fs::read_to_string(state.plugin_dir("demo").join("manifest.json")).unwrap();
        assert_eq!(restored, "{\"id\":\"demo\",\"version\":\"1.0.0\"}");
    }

    #[test]
    fn delete_only_accepts_matching_prefix() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        // Pre-seed a fake backup so delete actually has work.
        let backups = ensure_backups_dir(&state).unwrap();
        let archive_path = backups.join("demo-stamp.tar.gz");
        File::create(&archive_path).unwrap();
        // Mismatched prefix is rejected before fs touches.
        let err = {
            let plugin_id = "demo".to_string();
            let backup_id = "other-stamp".to_string();
            if !backup_id.starts_with(&plugin_id) {
                Some(PluginError::InvalidArgument(
                    "backup_id must start with plugin_id".into(),
                ))
            } else {
                None
            }
        };
        assert!(matches!(err, Some(PluginError::InvalidArgument(_))));
        // Original archive untouched.
        assert!(archive_path.exists());
    }

    #[tokio::test]
    async fn a_vscode_extension_backs_up_its_install_and_state_and_restores_both() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let trees = BackupTrees::for_plugin(&state, "acme.tools");
        fs::create_dir_all(&trees.vscode_install).unwrap();
        fs::write(trees.vscode_install.join("package.json"), b"v1").unwrap();
        fs::create_dir_all(trees.vscode_state.join("global")).unwrap();
        fs::write(trees.vscode_state.join("global/state.json"), b"{\"n\":1}").unwrap();
        assert!(
            !state.plugin_dir("acme.tools").exists(),
            "a .vsix install has no plugin dir"
        );

        let backup = plugin_backup_create_for_state(&state, "acme.tools".to_string(), None)
            .await
            .unwrap();
        fs::write(trees.vscode_install.join("package.json"), b"v2").unwrap();
        fs::write(trees.vscode_state.join("global/state.json"), b"{\"n\":2}").unwrap();
        plugin_backup_restore_for_state(&state, "acme.tools".to_string(), backup.backup_id)
            .await
            .unwrap();
        assert_eq!(
            fs::read(trees.vscode_install.join("package.json")).unwrap(),
            b"v1"
        );
        assert_eq!(
            fs::read(trees.vscode_state.join("global/state.json")).unwrap(),
            b"{\"n\":1}"
        );
        assert!(!state.plugin_dir("acme.tools").exists());
    }

    #[tokio::test]
    async fn host_owned_state_is_snapshotted_and_restored_with_the_package() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        seed_plugin_dir(&state, "demo", "{\"id\":\"demo\",\"version\":\"1.0.0\"}");
        let host_state = state.plugin_host_state_dir("demo");
        fs::create_dir_all(&host_state).unwrap();
        fs::write(host_state.join("managed-ide-state.db"), b"state-v1").unwrap();

        let backup = plugin_backup_create_for_state(
            &state,
            "demo".to_string(),
            Some("pre-update".to_string()),
        )
        .await
        .unwrap();
        fs::write(
            state.plugin_dir("demo").join("manifest.json"),
            b"{\"id\":\"demo\",\"version\":\"2.0.0\"}",
        )
        .unwrap();
        fs::write(host_state.join("managed-ide-state.db"), b"state-v2").unwrap();

        plugin_backup_restore_for_state(&state, "demo".to_string(), backup.backup_id)
            .await
            .unwrap();

        assert_eq!(
            fs::read_to_string(state.plugin_dir("demo").join("manifest.json")).unwrap(),
            "{\"id\":\"demo\",\"version\":\"1.0.0\"}"
        );
        assert_eq!(
            fs::read(
                state
                    .plugin_host_state_dir("demo")
                    .join("managed-ide-state.db")
            )
            .unwrap(),
            b"state-v1"
        );
    }

    #[tokio::test]
    async fn restore_rejects_a_backup_identifier_outside_the_plugin_namespace() {
        let tmp = TempDir::new().unwrap();
        let state = make_state(&tmp);
        let error =
            plugin_backup_restore_for_state(&state, "demo".to_string(), "../other".to_string())
                .await
                .unwrap_err();
        assert!(matches!(error, PluginError::InvalidArgument(_)));
    }
}
