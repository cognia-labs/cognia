//! A Python plugin pinned with uv (ENV02, ADR-0258).
//!
//! A plugin whose root holds both `pyproject.toml` and `uv.lock` is locked:
//! the lock, not the manifest's `pythonDependencies`, says what its
//! environment holds, and only uv can reproduce it exactly
//! (`uv sync --locked`). There is no fallback to an unlocked install: without
//! uv the plugin is `needs-uv`. A locked plugin always gets its own
//! environment, because a shared one cannot meet one plugin's lock exactly.
//!
//! A `wheels/` directory beside the lock means the plugin installs offline: uv
//! runs with `--offline`, so a package the bundle lacks fails the preparation
//! instead of being downloaded. The wheels are found through the lock itself.
//! A lock made with `[tool.uv] find-links = ["wheels"]` records them as its
//! source (`source = { registry = "wheels" }`, relative to the project); a
//! lock made against PyPI records PyPI URLs, and uv installs exactly those
//! whatever `--find-links` says at sync time (checked with uv 0.11). So the
//! Host passes no `--find-links`, and the plugin-dev docs tell authors to lock
//! against the bundle.
//!
//! The environment records the sha256 of the lock it was synced from, so a
//! package update or rollback that changes the lock makes it stale.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tokio::process::Command;

use super::readiness::FailureCause;

/// The project file uv reads the plugin's requirements from.
pub const PYPROJECT_FILE: &str = "pyproject.toml";
/// The lock `uv sync --locked` installs.
pub const LOCK_FILE: &str = "uv.lock";
/// Bundled wheels; its presence makes the install offline.
pub const WHEELS_DIR: &str = "wheels";

/// Far larger than any real lock; a bigger file is not read.
const LOCK_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// What uv prints when `--locked` finds the lock out of date with
/// `pyproject.toml` (uv 0.11: "The lockfile at `uv.lock` needs to be updated,
/// but `--locked` was provided.").
const LOCK_OUT_OF_DATE: &str = "needs to be updated, but `--locked` was provided";

/// What uv prints for a distribution it could not obtain (uv 0.11:
/// "Failed to download `six==1.16.0`"). Offline, that is a package the bundle
/// does not provide.
const FAILED_DOWNLOAD: &str = "Failed to download `";

/// A plugin's uv lock, as found in its root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginLock {
    /// The plugin root, which is the uv project.
    pub project_dir: PathBuf,
    /// sha256 of `uv.lock`, hex.
    pub digest: String,
    /// The packages the lock pins (`name==version`), the plugin's own project
    /// excluded. A universal lock lists every platform's packages, so this is
    /// what the install may fetch, not exactly what it will. Empty when the
    /// lock does not parse; uv then reports why it cannot sync.
    pub packages: Vec<String>,
    /// Whether the plugin bundles its wheels and installs offline.
    pub offline: bool,
}

/// Find the plugin's lock. `Ok(None)` for a plugin without one (no
/// `pyproject.toml` or no `uv.lock`); `Err` when the lock is there but cannot
/// be read, which a preparation could not get past either.
pub fn detect_lock(plugin_root: &Path) -> Result<Option<PluginLock>, String> {
    let Some(lock) = entry_metadata(plugin_root, LOCK_FILE)? else {
        return Ok(None);
    };
    if entry_metadata(plugin_root, PYPROJECT_FILE)?.is_none() {
        return Ok(None);
    }
    if lock.len() > LOCK_MAX_BYTES {
        return Err(format!(
            "{LOCK_FILE} is {} bytes, more than the {LOCK_MAX_BYTES} read",
            lock.len()
        ));
    }
    let bytes = crate::contained_path::read_existing_plugin_file(plugin_root, LOCK_FILE)
        .map_err(|error| format!("{LOCK_FILE}: {error}"))?;
    let offline = entry_metadata(plugin_root, WHEELS_DIR)?.is_some_and(|wheels| wheels.is_dir());
    Ok(Some(PluginLock {
        project_dir: plugin_root.to_path_buf(),
        digest: hex::encode(Sha256::digest(&bytes)),
        packages: locked_packages(&bytes),
        offline,
    }))
}

/// The entry's own metadata (a link is not followed), `None` when absent.
fn entry_metadata(root: &Path, name: &str) -> Result<Option<std::fs::Metadata>, String> {
    match std::fs::symlink_metadata(root.join(name)) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("stat {name}: {error}")),
    }
}

/// `name==version` for every package the lock pins, the project excluded.
fn locked_packages(bytes: &[u8]) -> Vec<String> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Vec::new();
    };
    let Ok(document) = text.parse::<toml_edit::DocumentMut>() else {
        return Vec::new();
    };
    let Some(packages) = document
        .get("package")
        .and_then(|item| item.as_array_of_tables())
    else {
        return Vec::new();
    };
    let mut pinned: Vec<String> = packages
        .iter()
        .filter(|package| !is_the_project(package))
        .filter_map(|package| {
            let name = package.get("name")?.as_str()?;
            Some(match package.get("version").and_then(|v| v.as_str()) {
                Some(version) => format!("{name}=={version}"),
                None => name.to_string(),
            })
        })
        .collect();
    pinned.sort();
    pinned.dedup();
    pinned
}

/// The plugin's own project, which `--no-install-project` leaves out, or a
/// virtual package, which is never installed.
fn is_the_project(package: &toml_edit::Table) -> bool {
    let Some(source) = package.get("source").and_then(|item| item.as_table_like()) else {
        return false;
    };
    source.get("virtual").is_some()
        || source.get("editable").and_then(|value| value.as_str()) == Some(".")
}

/// `uv sync` into `venv` from the plugin's lock: exactly what it pins, the
/// development group and the plugin's own project left out, offline when it
/// bundles its wheels. `venv` was created by the Host with uv, so `--python`
/// names its own interpreter and uv reuses it.
pub fn sync_command(uv: &str, lock: &PluginLock, venv: &Path) -> Command {
    let mut command = Command::new(uv);
    command
        .arg("sync")
        .arg("--locked")
        .arg("--no-dev")
        .arg("--no-install-project")
        .arg("--no-progress")
        .arg("--project")
        .arg(&lock.project_dir)
        .arg("--python")
        .arg(super::venv::venv_python(venv));
    if lock.offline {
        command.arg("--offline");
    }
    command
        .env("UV_PROJECT_ENVIRONMENT", venv)
        .env("NO_COLOR", "1")
        // An activated environment is not the plugin's, and `--frozen` from
        // the user's shell would contradict `--locked`.
        .env_remove("VIRTUAL_ENV")
        .env_remove("UV_FROZEN");
    command
}

/// Why `uv sync` failed, when its output says. A failed download only means a
/// missing wheel offline; online it is a network or index failure, reported
/// as uv wrote it.
pub fn classify_sync_failure(output: &[String], offline: bool) -> Option<FailureCause> {
    if output.iter().any(|line| line.contains(LOCK_OUT_OF_DATE)) {
        return Some(FailureCause::LockOutOfDate);
    }
    if !offline {
        return None;
    }
    let mut packages: Vec<String> = output
        .iter()
        .filter_map(|line| failed_download(line))
        .collect();
    packages.sort();
    packages.dedup();
    (!packages.is_empty()).then_some(FailureCause::MissingWheels { packages })
}

fn failed_download(line: &str) -> Option<String> {
    let start = line.find(FAILED_DOWNLOAD)? + FAILED_DOWNLOAD.len();
    let rest = &line[start..];
    let end = rest.find('`')?;
    Some(rest[..end].to_string()).filter(|package| !package.is_empty())
}

/// The error a failed locked preparation reports. The cause is also recorded
/// for the readiness reply, which the app words in the user's language.
pub fn sync_failure_message(cause: Option<&FailureCause>, detail: &str) -> String {
    match cause {
        Some(FailureCause::LockOutOfDate) => format!(
            "{LOCK_FILE} does not match {PYPROJECT_FILE}, so uv refused to install from it; \
             the plugin's author needs to run `uv lock` and publish the plugin again"
        ),
        Some(FailureCause::MissingWheels { packages }) => format!(
            "this plugin installs offline from its bundled wheels, which lack {}; \
             nothing was downloaded",
            packages.join(", ")
        ),
        None => detail.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const LOCK: &str = r#"version = 1
revision = 3
requires-python = ">=3.9"

[[package]]
name = "demo-plugin"
version = "0.1.0"
source = { virtual = "." }
dependencies = [{ name = "six" }]

[[package]]
name = "six"
version = "1.16.0"
source = { registry = "wheels" }
wheels = [{ path = "six-1.16.0-py2.py3-none-any.whl" }]

[[package]]
name = "colorama"
version = "0.4.6"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "member"
version = "0.2.0"
source = { editable = "packages/member" }
"#;

    fn plugin(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new().unwrap();
        for (name, body) in files {
            std::fs::write(dir.path().join(name), body).unwrap();
        }
        dir
    }

    fn args(command: &Command) -> Vec<String> {
        command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn a_plugin_is_locked_only_with_both_files() {
        assert_eq!(detect_lock(plugin(&[]).path()), Ok(None));
        assert_eq!(detect_lock(plugin(&[(LOCK_FILE, LOCK)]).path()), Ok(None));
        assert_eq!(
            detect_lock(plugin(&[(PYPROJECT_FILE, "[project]\n")]).path()),
            Ok(None)
        );
        let dir = plugin(&[(PYPROJECT_FILE, "[project]\n"), (LOCK_FILE, LOCK)]);
        let lock = detect_lock(dir.path()).unwrap().expect("locked");
        assert_eq!(lock.project_dir, dir.path());
        assert!(!lock.offline);
    }

    #[test]
    fn the_lock_lists_what_it_pins_without_the_project() {
        let dir = plugin(&[(PYPROJECT_FILE, "[project]\n"), (LOCK_FILE, LOCK)]);
        let lock = detect_lock(dir.path()).unwrap().unwrap();
        assert_eq!(
            lock.packages,
            vec!["colorama==0.4.6", "member==0.2.0", "six==1.16.0"]
        );
    }

    #[test]
    fn the_digest_follows_the_lock_bytes() {
        let first = plugin(&[(PYPROJECT_FILE, "[project]\n"), (LOCK_FILE, LOCK)]);
        let same = plugin(&[
            (PYPROJECT_FILE, "[project]\nname = \"x\"\n"),
            (LOCK_FILE, LOCK),
        ]);
        let other = plugin(&[
            (PYPROJECT_FILE, "[project]\n"),
            (LOCK_FILE, "version = 1\n"),
        ]);
        let digest = |dir: &TempDir| detect_lock(dir.path()).unwrap().unwrap().digest;
        assert_eq!(digest(&first), digest(&same));
        assert_ne!(digest(&first), digest(&other));
        assert_eq!(digest(&first).len(), 64);
    }

    #[test]
    fn a_lock_that_does_not_parse_still_locks_the_plugin() {
        let dir = plugin(&[(PYPROJECT_FILE, "[project]\n"), (LOCK_FILE, "[[package]\n")]);
        let lock = detect_lock(dir.path()).unwrap().expect("still locked");
        assert!(lock.packages.is_empty());
    }

    #[test]
    fn a_wheels_directory_makes_it_offline() {
        let dir = plugin(&[(PYPROJECT_FILE, "[project]\n"), (LOCK_FILE, LOCK)]);
        std::fs::write(dir.path().join(WHEELS_DIR), "not a directory").unwrap();
        assert!(!detect_lock(dir.path()).unwrap().unwrap().offline);
        std::fs::remove_file(dir.path().join(WHEELS_DIR)).unwrap();
        std::fs::create_dir(dir.path().join(WHEELS_DIR)).unwrap();
        assert!(detect_lock(dir.path()).unwrap().unwrap().offline);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_lock_is_refused_rather_than_followed() {
        let outside = plugin(&[(LOCK_FILE, LOCK)]);
        let dir = plugin(&[(PYPROJECT_FILE, "[project]\n")]);
        std::os::unix::fs::symlink(outside.path().join(LOCK_FILE), dir.path().join(LOCK_FILE))
            .unwrap();
        assert!(detect_lock(dir.path()).is_err());
    }

    #[test]
    fn the_sync_installs_exactly_the_lock_into_the_plugins_environment() {
        let lock = PluginLock {
            project_dir: PathBuf::from("/plugins/demo"),
            digest: "d".into(),
            packages: vec![],
            offline: false,
        };
        let venv = Path::new("/python/venvs/demo");
        let command = sync_command("/bin/uv", &lock, venv);
        let python = super::super::venv::venv_python(venv);
        assert_eq!(command.as_std().get_program(), "/bin/uv");
        assert_eq!(
            args(&command),
            vec![
                "sync".to_string(),
                "--locked".into(),
                "--no-dev".into(),
                "--no-install-project".into(),
                "--no-progress".into(),
                "--project".into(),
                "/plugins/demo".into(),
                "--python".into(),
                python.to_string_lossy().into_owned(),
            ]
        );
        let envs: Vec<(String, Option<String>)> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert!(envs.contains(&(
            "UV_PROJECT_ENVIRONMENT".into(),
            Some("/python/venvs/demo".into())
        )));
        assert!(envs.contains(&("VIRTUAL_ENV".into(), None)));
        assert!(envs.contains(&("UV_FROZEN".into(), None)));

        let offline = PluginLock {
            offline: true,
            ..lock
        };
        let args = args(&sync_command("uv", &offline, venv));
        assert_eq!(args.last().map(String::as_str), Some("--offline"));
        assert!(!args.iter().any(|arg| arg == "--find-links"));
    }

    #[test]
    fn an_out_of_date_lock_is_named_online_and_offline() {
        let output = vec![
            "Resolved 2 packages in 4ms".to_string(),
            "The lockfile at `uv.lock` needs to be updated, but `--locked` was provided. \
             To update the lockfile, run `uv lock`."
                .to_string(),
        ];
        for offline in [false, true] {
            assert_eq!(
                classify_sync_failure(&output, offline),
                Some(FailureCause::LockOutOfDate)
            );
        }
    }

    #[test]
    fn offline_failed_downloads_are_the_missing_wheels() {
        let output = vec![
            "  × Failed to download `tinydep==1.0.0`".to_string(),
            "  ├─▶ Failed to read from the distribution cache".to_string(),
            "  × Failed to download `six==1.16.0`".to_string(),
            "  × Failed to download `six==1.16.0`".to_string(),
        ];
        assert_eq!(
            classify_sync_failure(&output, true),
            Some(FailureCause::MissingWheels {
                packages: vec!["six==1.16.0".into(), "tinydep==1.0.0".into()]
            })
        );
        // Online, a failed download is the network's, not the bundle's.
        assert_eq!(classify_sync_failure(&output, false), None);
        assert_eq!(
            classify_sync_failure(&["error: something else".to_string()], true),
            None
        );
    }

    #[test]
    fn failure_messages_say_what_to_do() {
        assert!(sync_failure_message(Some(&FailureCause::LockOutOfDate), "x").contains("uv lock"));
        let missing = FailureCause::MissingWheels {
            packages: vec!["a==1".into(), "b==2".into()],
        };
        assert!(sync_failure_message(Some(&missing), "x").contains("a==1, b==2"));
        assert_eq!(
            sync_failure_message(None, "uv failed (exit 2)"),
            "uv failed (exit 2)"
        );
    }
}
