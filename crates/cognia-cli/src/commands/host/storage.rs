//! Offline accounting for the Host data directory, independent of the brain/RPC.

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, Metadata, ReadDir};
use std::io;
use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

const MIN_FREE_BYTES: u64 = 256 * 1024 * 1024;
const WARN_FREE_PERCENT: u64 = 10;
const OWNERS: &[&str] = &[
    "front-door",
    "companion-signaling",
    "companion-idempotency",
    "companion",
    "provider-profiles",
    "agent-sessions",
    "jobs",
    "secrets",
    "brain-durability",
    "task-workspaces",
    "task-executions",
    "task-blobs",
    "git-mirrors",
    "backups",
    "other",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct VolumeSpace {
    free_bytes: u64,
    total_bytes: u64,
}

#[derive(Debug, Serialize)]
struct WalkIssue {
    // A display string: serializing a non-UTF-8 Path fails, and json! panics on it.
    path: String,
    operation: &'static str,
    error: String,
}

#[derive(Debug)]
struct Inventory {
    bytes_by_owner: BTreeMap<&'static str, u64>,
    total_bytes: u64,
    files: u64,
    symlinks: u64,
    duplicate_files: u64,
    vanished_entries: u64,
    issues: Vec<WalkIssue>,
}

fn read_directory(path: &Path) -> io::Result<ReadDir> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::other("entry is no longer a directory"));
    }
    // The remaining replacement window is accepted because this diagnostic only reads sizes.
    fs::read_dir(path)
}

impl Inventory {
    fn new() -> Self {
        Self {
            bytes_by_owner: OWNERS.iter().map(|owner| (*owner, 0)).collect(),
            total_bytes: 0,
            files: 0,
            symlinks: 0,
            duplicate_files: 0,
            vanished_entries: 0,
            issues: Vec::new(),
        }
    }

    fn issue(&mut self, path: &Path, operation: &'static str, error: io::Error) {
        if error.kind() == io::ErrorKind::NotFound {
            self.vanished_entries += 1;
        } else {
            self.issues.push(WalkIssue {
                path: path.display().to_string(),
                operation,
                error: error.to_string(),
            });
        }
    }

    fn add_bytes(&mut self, path: &Path, bytes: u64) {
        *self.bytes_by_owner.entry(owner(path)).or_default() += bytes;
        self.total_bytes += bytes;
    }
}

// main.rs opens SqliteAppStore and SecurityStore on the SAME file. This
// includes the collaboration/identity projection; it cannot be split by table
// without counting SQLite pages twice. Include SQLite's transient side files.
fn sqlite_file(path: &Path, database: &str) -> bool {
    let database = Path::new(database);
    if path.parent() != database.parent() {
        return false;
    }
    let name = path.file_name().and_then(|name| name.to_str());
    let expected = database.file_name().and_then(|name| name.to_str());
    name.zip(expected).is_some_and(|(name, expected)| {
        name == expected
            || matches!(name.strip_prefix(expected), Some("-wal" | "-shm" | "-journal"))
    })
}

fn owner(path: &Path) -> &'static str {
    // cognia-server/persons.rs gives each brain its own data-dir partition.
    let partition = path.strip_prefix("persons").ok().and_then(|tail| {
        let mut components = tail.components();
        components.next()?;
        Some(components.as_path())
    });
    let path = partition.unwrap_or(path);
    for (database, owner) in [
        ("cognia-server.sqlite", "front-door"),
        ("companion-signaling.sqlite", "companion-signaling"),
        ("companion-idempotency.sqlite", "companion-idempotency"),
        (".cognia/provider-profiles.sqlite", "provider-profiles"),
        ("cognia/agent-sessions.sqlite", "agent-sessions"),
        ("cognia/jobs.sqlite", "jobs"),
    ] {
        if sqlite_file(path, database) {
            return owner;
        }
    }
    // Writers: cli/src/serve/persistence/backend.ts, TaskWorkspaceService::open
    // and WorkspaceStore::open, cognia-git's mirror_root, companion/backup.rs.
    // Specific workspace owners must precede the general service directory.
    for (root, owner) in [
        ("serve/durability", "brain-durability"),
        ("task-workspaces/mirrors", "git-mirrors"),
        ("task-workspaces/executions", "task-executions"),
        ("task-workspaces/blobs", "task-blobs"),
        ("task-workspaces", "task-workspaces"),
        ("backups", "backups"),
        // cognia-jobs JobOutput writes job logs and their rotations here.
        ("cognia/jobs", "jobs"),
        ("cognia/companion", "companion"),
        ("companion", "companion"),
    ] {
        if path.starts_with(root) {
            return owner;
        }
    }
    // cognia-secrets::secret_store::headless_store_path / DATA_DIR_MASTER_KEY_FILE.
    if path == Path::new("cognia/secret-store.enc") || path == Path::new("master.key") {
        return "secrets";
    }
    // SecurityStore::write_pre_migration_backup keeps this beside the database.
    if path == Path::new("cognia-server.sqlite.pre-suspend.bak") {
        return "backups";
    }
    "other"
}

// Streaming DFS holds one iterator per ancestor, with no recursion or entry
// cutoff. An unreadable directory ends just that descent and is reported.
fn inventory<F>(root: &Path, mut before_open: F) -> Inventory
where
    F: FnMut(&Path) -> io::Result<()>,
{
    let mut inventory = Inventory::new();
    let mut stack = match before_open(root).and_then(|()| read_directory(root)) {
        Ok(entries) => vec![(root.to_path_buf(), entries)],
        Err(error) => {
            inventory.issue(root, "read-directory", error);
            return inventory;
        }
    };
    let mut seen = HashSet::new();
    let mut directories = HashSet::new();
    if let Some(identity) = fs::symlink_metadata(root)
        .ok()
        .and_then(|metadata| file_identity(&metadata))
    {
        directories.insert(identity);
    }
    while let Some((directory, entries)) = stack.last_mut() {
        let entry = match entries.next() {
            Some(Ok(entry)) => entry,
            Some(Err(error)) => {
                let path = directory.clone();
                inventory.issue(&path, "read-entry", error);
                // An iterator may repeatedly return the same I/O error.
                stack.pop();
                continue;
            }
            None => {
                stack.pop();
                continue;
            }
        };
        let path = entry.path();
        let relative = path.strip_prefix(root).unwrap_or(&path);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                inventory.issue(relative, "metadata", error);
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            inventory.symlinks += 1;
            inventory.add_bytes(relative, metadata.len());
        } else if metadata.is_dir() {
            if let Some(identity) = file_identity(&metadata) {
                if !directories.insert(identity) {
                    continue;
                }
            }
            match before_open(&path).and_then(|()| read_directory(&path)) {
                Ok(entries) => stack.push((path, entries)),
                Err(error) => inventory.issue(relative, "read-directory", error),
            }
        } else {
            if metadata.is_file() {
                if let Some(identity) = file_identity(&metadata) {
                    if !seen.insert(identity) {
                        inventory.duplicate_files += 1;
                        continue;
                    }
                }
                inventory.files += 1;
            }
            inventory.add_bytes(relative, metadata.len());
        }
    }
    inventory
}

#[cfg(unix)]
fn file_identity(metadata: &Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn file_identity(_: &Metadata) -> Option<(u64, u64)> {
    None
}

fn space_status(volume: VolumeSpace) -> &'static str {
    if volume.free_bytes < MIN_FREE_BYTES {
        "fail"
    } else if volume.total_bytes == 0
        || u128::from(volume.free_bytes) * 100
            < u128::from(volume.total_bytes) * u128::from(WARN_FREE_PERCENT)
    {
        "warn"
    } else {
        "ok"
    }
}

fn check_status(volume: Option<VolumeSpace>, complete: bool) -> &'static str {
    match volume.map(space_status) {
        Some("fail") => "fail",
        Some("ok") if complete => "ok",
        _ => "warn",
    }
}

fn readable_bytes(bytes: u64) -> String {
    for (unit, size) in [("TiB", 1_u64 << 40), ("GiB", 1 << 30), ("MiB", 1 << 20)] {
        if bytes >= size {
            return format!("{:.1} {unit}", bytes as f64 / size as f64);
        }
    }
    format!("{bytes} B")
}

pub(super) fn check(data_dir: &Path) -> Value {
    check_with_capacity(data_dir, volume_space)
}

fn check_with_capacity<F>(data_dir: &Path, capacity: F) -> Value
where
    F: FnOnce(&Path) -> io::Result<VolumeSpace>,
{
    let root = fs::canonicalize(data_dir);
    let (inventory, volume) = match &root {
        Ok(root) => {
            let mut inventory = inventory(root, |_| Ok(()));
            let volume = match capacity(root) {
                Ok(volume) => Some(volume),
                Err(error) => {
                    inventory.issues.push(WalkIssue {
                        path: root.display().to_string(),
                        operation: "volume-space",
                        error: error.to_string(),
                    });
                    None
                }
            };
            (inventory, volume)
        }
        Err(error) => {
            let mut inventory = Inventory::new();
            inventory.issues.push(WalkIssue {
                path: data_dir.display().to_string(),
                operation: "resolve-data-dir",
                error: error.to_string(),
            });
            (inventory, None)
        }
    };
    let complete = inventory.issues.is_empty() && inventory.vanished_entries == 0;
    let status = if root.is_err() {
        "fail"
    } else {
        check_status(volume, complete)
    };
    let capacity = match volume {
        Some(volume) => format!(
            "{} free / {} total",
            readable_bytes(volume.free_bytes),
            readable_bytes(volume.total_bytes)
        ),
        None => "volume capacity unavailable".to_string(),
    };
    let owners = inventory
        .bytes_by_owner
        .iter()
        .filter(|(_, bytes)| **bytes != 0)
        .map(|(owner, bytes)| format!("{owner}={}", readable_bytes(*bytes)))
        .collect::<Vec<_>>()
        .join(", ");
    let mut summary = format!(
        "{}: {} apparent bytes ({owners}); {capacity}; {} symlinks not followed",
        data_dir.display(),
        readable_bytes(inventory.total_bytes),
        inventory.symlinks
    );
    if !complete {
        summary.push_str(&format!(
            "; incomplete: {} errors, {} vanished entries",
            inventory.issues.len(),
            inventory.vanished_entries
        ));
        for issue in inventory.issues.iter().take(3) {
            summary.push_str(&format!(
                "; {}: {} ({})",
                issue.path,
                issue.operation,
                issue.error
            ));
        }
    }
    json!({
        "name": "storage",
        "status": status,
        "detail": {
            "summary": summary,
            "dataDir": data_dir.display().to_string(),
            "resolvedDataDir": root.ok().map(|root| root.display().to_string()),
            "measurement": "apparent-file-and-symlink-bytes",
            "bytesByOwner": inventory.bytes_by_owner,
            "totalBytes": inventory.total_bytes,
            "files": inventory.files,
            "symlinks": inventory.symlinks,
            "duplicateFiles": inventory.duplicate_files,
            "vanishedEntries": inventory.vanished_entries,
            "complete": complete,
            "issues": inventory.issues,
            "volume": volume,
            "thresholds": {"minFreeBytes": MIN_FREE_BYTES, "warnFreePercent": WARN_FREE_PERCENT}
        }
    })
}

fn volume_space(path: &Path) -> io::Result<VolumeSpace> {
    Ok(VolumeSpace {
        free_bytes: fs2::available_space(path)?,
        total_bytes: fs2::total_space(path)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path, entries: &[(&str, usize)]) {
        for (path, bytes) in entries {
            let path = root.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, vec![0; *bytes]).unwrap();
        }
    }

    #[test]
    fn groups_host_stores_and_sqlite_sidecars_by_owner() {
        let directory = tempfile::tempdir().unwrap();
        fixture(directory.path(), &[
            ("cognia-server.sqlite", 11),
            ("cognia-server.sqlite-wal", 7),
            ("cognia-server.sqlite-shm", 3),
            ("companion-signaling.sqlite", 13),
            ("companion-idempotency.sqlite-journal", 17),
            (".cognia/provider-profiles.sqlite", 19),
            ("cognia/agent-sessions.sqlite", 23),
            ("cognia/jobs.sqlite", 29),
            ("cognia/jobs/job-1.log", 5),
            ("cognia/jobs/job-1.log.1", 2),
            ("cognia/secret-store.enc", 31),
            ("companion/execution-bindings.json", 37),
            ("cognia/companion/tls.pem", 41),
            ("serve/durability/account/sqlite/store.sqlite", 43),
            ("task-workspaces/task-workspaces.sqlite", 47),
            ("task-workspaces/sources/project/file", 53),
            ("task-workspaces/executions/run/file", 59),
            ("task-workspaces/blobs/hash", 61),
            ("task-workspaces/mirrors/repo.git/objects/pack/data", 67),
            ("backups/volume.cgbk", 71),
            ("cognia-server.sqlite.pre-suspend.bak", 83),
            ("persons/member/serve/durability/member/sqlite/store.sqlite", 73),
            ("persons/member/task-workspaces/blobs/hash", 79),
        ]);
        let report = inventory(directory.path(), |_| Ok(()));
        for (owner, expected) in [
            ("front-door", 21),
            ("companion-signaling", 13),
            ("companion-idempotency", 17),
            ("provider-profiles", 19),
            ("agent-sessions", 23),
            ("jobs", 36),
            ("secrets", 31),
            ("companion", 78),
            ("brain-durability", 116),
            ("task-workspaces", 100),
            ("task-executions", 59),
            ("task-blobs", 140),
            ("git-mirrors", 67),
            ("backups", 154),
            ("other", 0),
        ] {
            assert_eq!(report.bytes_by_owner[owner], expected, "{owner}");
        }
        assert_eq!(report.files, 23);
        assert_eq!(report.total_bytes, report.bytes_by_owner.values().sum::<u64>());
        assert!(report.issues.is_empty());
    }

    #[test]
    fn unknown_files_are_never_dropped_or_matched_by_substring() {
        let directory = tempfile::tempdir().unwrap();
        fixture(directory.path(), &[
            ("unknown.sqlite", 5),
            ("nested/companion-signaling.sqlite", 7),
            ("task-workspaces-old/file", 11),
            ("backups-old/file", 13),
        ]);
        let report = inventory(directory.path(), |_| Ok(()));
        assert_eq!(report.bytes_by_owner["other"], 36);
        assert_eq!(report.total_bytes, 36);
        assert_eq!(report.files, 4);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_outside_inside_and_cycles_are_not_followed() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fixture(directory.path(), &[("task-workspaces/blobs/real", 11)]);
        fixture(outside.path(), &[("large", 100_000)]);
        symlink(outside.path(), directory.path().join("outside")).unwrap();
        symlink(directory.path(), directory.path().join("cycle")).unwrap();
        symlink("task-workspaces/blobs/real", directory.path().join("inside")).unwrap();
        symlink(outside.path().join("missing"), directory.path().join("dangling")).unwrap();
        let link_bytes = ["outside", "cycle", "inside", "dangling"]
            .iter()
            .map(|path| {
                fs::symlink_metadata(directory.path().join(path))
                    .unwrap()
                    .len()
            })
            .sum::<u64>();
        let report = inventory(directory.path(), |_| Ok(()));
        assert_eq!(report.files, 1);
        assert_eq!(report.symlinks, 4);
        assert_eq!(report.bytes_by_owner["task-blobs"], 11);
        assert_eq!(report.bytes_by_owner["other"], link_bytes);
        assert_eq!(report.total_bytes, 11 + link_bytes);
        assert!(report.issues.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn directory_replaced_by_an_outside_symlink_is_not_descended() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fixture(directory.path(), &[("swapped/old", 5), ("backups/kept", 17)]);
        fixture(outside.path(), &[("outside-data", 100_000)]);
        let report = inventory(directory.path(), |path| {
            if path == directory.path().join("swapped") {
                fs::remove_dir_all(path).unwrap();
                symlink(outside.path(), path).unwrap();
            }
            Ok(())
        });
        assert_eq!(report.total_bytes, 17);
        assert_eq!(report.bytes_by_owner["other"], 0);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].path, "swapped");
        assert_eq!(report.issues[0].operation, "read-directory");
    }

    #[test]
    fn unreadable_directory_is_reported_and_siblings_are_counted() {
        let directory = tempfile::tempdir().unwrap();
        fixture(directory.path(), &[("blocked/hidden", 100), ("backups/kept", 17)]);
        let report = inventory(directory.path(), |path| {
            if path == directory.path().join("blocked") {
                // Inject permission denial so this also exercises root/Windows.
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                Ok(())
            }
        });
        assert_eq!(report.total_bytes, 17);
        assert_eq!(report.bytes_by_owner["backups"], 17);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].path, "blocked");
        assert_eq!(report.issues[0].operation, "read-directory");
        let healthy = VolumeSpace {
            free_bytes: 2 * MIN_FREE_BYTES,
            total_bytes: 4 * MIN_FREE_BYTES,
        };
        assert_eq!(check_status(Some(healthy), report.issues.is_empty()), "warn");
    }

    #[test]
    fn vanished_directory_does_not_abort_the_inventory() {
        let directory = tempfile::tempdir().unwrap();
        fixture(directory.path(), &[("vanishing/file", 100), ("backups/kept", 17)]);
        let report = inventory(directory.path(), |path| {
            if path == directory.path().join("vanishing") {
                fs::remove_dir_all(path).unwrap();
            }
            Ok(())
        });
        assert_eq!(report.total_bytes, 17);
        assert_eq!(report.vanished_entries, 1);
        assert!(report.issues.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn hardlinked_files_are_counted_once() {
        let directory = tempfile::tempdir().unwrap();
        fixture(directory.path(), &[("task-workspaces/blobs/real", 19)]);
        fs::hard_link(
            directory.path().join("task-workspaces/blobs/real"),
            directory.path().join("task-workspaces/blobs/alias"),
        )
        .unwrap();
        let report = inventory(directory.path(), |_| Ok(()));
        assert_eq!(report.total_bytes, 19);
        assert_eq!(report.files, 1);
        assert_eq!(report.duplicate_files, 1);
        assert_eq!(report.bytes_by_owner["task-blobs"], 19);
    }

    #[test]
    fn thresholds_have_fatal_floor_and_nonfatal_percentage_warning() {
        for (free_bytes, total_bytes, expected) in [
            (MIN_FREE_BYTES - 1, MIN_FREE_BYTES, "fail"),
            (MIN_FREE_BYTES, MIN_FREE_BYTES, "ok"),
            (MIN_FREE_BYTES, MIN_FREE_BYTES * 20, "warn"),
            (MIN_FREE_BYTES, MIN_FREE_BYTES * 10, "ok"),
            (MIN_FREE_BYTES, 0, "warn"),
            (u64::MAX / 20, u64::MAX, "warn"),
            (u64::MAX, u64::MAX, "ok"),
        ] {
            assert_eq!(
                space_status(VolumeSpace { free_bytes, total_bytes }),
                expected
            );
        }
        let low = VolumeSpace {
            free_bytes: 0,
            total_bytes: MIN_FREE_BYTES,
        };
        assert_eq!(check_status(Some(low), false), "fail");
        assert_eq!(check_status(None, true), "warn");
    }

    #[test]
    fn capacity_failure_is_reported_without_losing_owner_totals() {
        let directory = tempfile::tempdir().unwrap();
        fixture(directory.path(), &[("task-workspaces/blobs/kept", 17)]);
        let report = check_with_capacity(directory.path(), |_| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        });
        assert_eq!(report["status"], "warn");
        assert_eq!(report["detail"]["complete"], false);
        assert_eq!(report["detail"]["bytesByOwner"]["task-blobs"], 17);
        assert_eq!(report["detail"]["totalBytes"], 17);
        assert!(report["detail"]["volume"].is_null());
        assert_eq!(report["detail"]["issues"][0]["operation"], "volume-space");
        assert!(report["detail"]["issues"][0]["error"].as_str().is_some());
        assert!(report["detail"]["summary"]
            .as_str()
            .unwrap()
            .contains("volume capacity unavailable"));
    }

    #[test]
    fn missing_data_directory_has_structured_failure_details() {
        let directory = tempfile::tempdir().unwrap();
        let report = check(&directory.path().join("missing"));
        assert_eq!(report["name"], "storage");
        assert_eq!(report["status"], "fail");
        assert_eq!(report["detail"]["complete"], false);
        assert_eq!(report["detail"]["bytesByOwner"]["other"], 0);
        assert_eq!(
            report["detail"]["issues"][0]["operation"],
            "resolve-data-dir"
        );
        assert_eq!(report["detail"]["thresholds"]["minFreeBytes"], MIN_FREE_BYTES);
    }
}
