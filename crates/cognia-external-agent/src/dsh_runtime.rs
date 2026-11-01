//! Desktop lifecycle for the Cognia-owned DeepSeek Harness runtime.
//!
//! DeepSeek Harness publishes no executable for the transport Cognia drives, so
//! Cognia installs and certifies a runtime home of its own. On CLI/headless the
//! equivalent lives in `cli/src/runtime/external/dsh-installer.ts`; this module
//! is the Tauri arm.
//!
//! Runtime health is decided by `doctorDshRuntime()` in
//! `lib/ai/agent/external/dsh-runtime-install.ts`, which is pure TypeScript and
//! shared by both hosts. Install admission compares the complete channel to a
//! generated snapshot of that package's current certification, avoiding a
//! second Rust capability table while refusing stale or widened manifests.
//!
//! Install is two-phase on purpose: `install` stages and returns the digests,
//! then the renderer builds the channel manifest (it owns the profile and
//! capability vocabulary) and calls `finalize`, which writes the manifest and
//! swaps the tree in. Until `finalize` succeeds the previously certified
//! runtime is still the live one.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Files copied from `packages/agent-dsh/runtime/` into the runtime home.
const RUNTIME_ARTIFACTS: &[&str] = &[
    "package.json",
    "launcher.mjs",
    "host.root.yml",
    "host.sdk-readonly.yml",
    "host.sdk-workspace.yml",
    "host.acp.yml",
];

/// Files whose bytes make up the composition digest, in a stable order.
/// Must stay identical to `COMPOSITION_DIGEST_FILES` in the TypeScript
/// installer, including order.
const COMPOSITION_DIGEST_FILES: &[&str] = &[
    "launcher.mjs",
    "host.root.yml",
    "host.sdk-readonly.yml",
    "host.sdk-workspace.yml",
    "host.acp.yml",
];

const CHANNEL_MANIFEST_FILE: &str = "cognia-channel.json";
const RUNTIME_DIR: &str = "deepseek-harness";
const DSH_HOME_DIR: &str = "dsh-home";
const INSTALL_MARKER: &str = ".cognia-install.json";
const CONTROL_DIR: &str = ".deepseek-harness-control";

/// Facts gathered from disk, handed to the shared TypeScript verdict function.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DshRuntimeFacts {
    pub runtime_home: String,
    pub node_path: String,
    pub default_workspace: String,
    pub parent_env: std::collections::HashMap<String, String>,
    /// The channel manifest as raw JSON, or `None` when nothing is installed.
    pub manifest_json: Option<String>,
    pub lockfile_digest: String,
    pub composition_digest: String,
    pub node_version: String,
    pub platform: String,
    /// Patch layers under `DSH_HOME` that DSH would apply after every bundle
    /// layer. Each is a hole in the certification.
    pub stray_patch_paths: Vec<String>,
    pub has_native_toolchain: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DshInstallDigests {
    pub install_id: String,
    pub lockfile_digest: String,
    pub composition_digest: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallMarker {
    schema_version: u32,
    install_id: String,
    lockfile_digest: String,
    composition_digest: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnershipRecord {
    schema_version: u32,
    pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    child_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nonce_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    boot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retirement_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retired: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    legacy_record: Option<String>,
}

struct OwnershipLease {
    id: String,
    path: PathBuf,
    record: OwnershipRecord,
}

fn ensure_owned_directory(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(format!(
            "DSH ownership directory is not a real directory: {}",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let metadata =
                        std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
                    if metadata.is_dir() && !metadata.file_type().is_symlink() {
                        Ok(())
                    } else {
                        Err("DSH ownership directory was replaced during creation".into())
                    }
                }
                Err(error) => Err(format!("cannot create DSH ownership directory: {error}")),
            }
        }
        Err(error) => Err(format!("cannot inspect DSH ownership directory: {error}")),
    }
}

fn control_directory(data_root: &Path, kind: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(data_root)
        .map_err(|error| format!("cannot create DSH data root: {error}"))?;
    let control = data_root.join(CONTROL_DIR);
    ensure_owned_directory(&control)?;
    let directory = control.join(kind);
    ensure_owned_directory(&directory)?;
    Ok(directory)
}

pub(crate) fn process_lease_directory(data_root: &Path) -> Result<PathBuf, String> {
    control_directory(data_root, "processes")
}

/// Applies to both native workspace policy and every outer sandbox write grant.
pub(crate) fn assert_writable_scope(runtime_home: &Path, writable: &Path) -> Result<(), String> {
    let runtime = cognia_exec_sandbox::paths::safe_canonicalize(runtime_home)
        .map_err(|error| error.to_string())?;
    let writable = cognia_exec_sandbox::paths::safe_canonicalize(writable)
        .map_err(|error| error.to_string())?;
    let control = runtime
        .parent()
        .ok_or("DSH runtime has no owning data root")?
        .join(CONTROL_DIR);
    let overlaps_control = writable.starts_with(&control) || control.starts_with(&writable);
    let overlaps_runtime = writable.starts_with(&runtime) || runtime.starts_with(&writable);
    let state_root = [runtime.join("sessions"), runtime.join(DSH_HOME_DIR)].contains(&writable);
    let reserved_sibling = runtime
        .parent()
        .and_then(|parent| writable.strip_prefix(parent).ok())
        .and_then(|relative| relative.components().next())
        .and_then(|component| component.as_os_str().to_str())
        .is_some_and(|name| {
            name == "deepseek-harness.previous" || name.starts_with("deepseek-harness.staging-")
        });
    if overlaps_control || (overlaps_runtime && !state_root) || reserved_sibling {
        return Err(
            "DSH writable scope overlaps protected runtime code or host-owned control records"
                .into(),
        );
    }
    Ok(())
}

fn publish_json(path: &Path, record: &impl Serialize) -> Result<(), String> {
    publish_json_atomically(path, record, true).map(|_| ())
}

fn publish_json_atomically(
    path: &Path,
    record: &impl Serialize,
    replace: bool,
) -> Result<bool, String> {
    let temporary = path.with_file_name(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut created = false;
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("cannot create DSH ownership record: {error}"))?;
        created = true;
        file.write_all(&serde_json::to_vec(record).map_err(|error| error.to_string())?)
            .map_err(|error| format!("cannot write DSH ownership record: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("cannot flush DSH ownership record: {error}"))?;
        if replace {
            std::fs::rename(&temporary, path)
                .map_err(|error| format!("cannot publish DSH ownership record: {error}"))?;
            Ok(true)
        } else {
            // Linking the fully written file publishes without replacing a shadow
            // another host already attributed to an earlier boot.
            match std::fs::hard_link(&temporary, path) {
                Ok(()) => Ok(true),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
                Err(error) => Err(format!("cannot publish DSH ownership record: {error}")),
            }
        }
    })();
    if created {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

fn current_boot_id() -> Result<String, String> {
    static BOOT_ID: std::sync::OnceLock<Result<String, String>> = std::sync::OnceLock::new();
    BOOT_ID
        .get_or_init(|| {
            #[cfg(target_os = "macos")]
            let value = {
                let output = std::process::Command::new("/usr/sbin/sysctl")
                    .args(["-n", "kern.bootsessionuuid"])
                    .env_clear()
                    .output()
                    .map_err(|error| format!("cannot read DSH kernel boot identity: {error}"))?;
                if !output.status.success() {
                    return Err("cannot read DSH kernel boot identity".into());
                }
                String::from_utf8(output.stdout)
                    .map_err(|_| "invalid DSH kernel boot identity".to_string())?
            };
            #[cfg(target_os = "linux")]
            let value = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
                .map_err(|error| format!("cannot read DSH kernel boot identity: {error}"))?;
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            {
                uuid::Uuid::parse_str(value.trim())
                    .map(|id| id.to_string())
                    .map_err(|_| "invalid DSH kernel boot identity".to_string())
            }
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            Err("DSH kernel boot identity is unavailable on this platform".into())
        })
        .clone()
}

pub(crate) fn pid_is_live(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return true;
        };
        // EPERM and every unknown result preserve ownership; only ESRCH proves death.
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

fn legacy_shadow_path(directory: &Path, legacy_filename: &str) -> PathBuf {
    directory.join(format!(
        "legacy-{}.json",
        hex(Sha256::digest(legacy_filename.as_bytes()))
    ))
}

fn read_ownership_record(path: &Path, kind: &str) -> Result<OwnershipRecord, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect DSH ownership record: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("invalid DSH ownership record".into());
    }
    let record: OwnershipRecord = serde_json::from_slice(
        &std::fs::read(path)
            .map_err(|error| format!("cannot read DSH ownership record: {error}"))?,
    )
    .map_err(|_| "malformed DSH ownership record".to_string())?;
    let invalid_common = record.pid == 0
        || record.child_pid == Some(0)
        || record.nonce_digest.as_ref().is_some_and(|digest| {
            digest.len() != 64
                || !digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
    let invalid_schema = if kind == "maintenance" {
        record.schema_version != 1
            || record
                .operation_id
                .as_ref()
                .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())
    } else {
        match record.schema_version {
            1 => record.legacy_record.is_some(),
            2 => {
                record.retirement_required != Some(true)
                    || record.retired != Some(false)
                    || record.boot_id.as_ref().is_none_or(|id| {
                        uuid::Uuid::parse_str(id).map_or(true, |parsed| parsed.to_string() != *id)
                    })
                    || match &record.legacy_record {
                        Some(filename) => {
                            // A legacy shadow must remain bound to the original
                            // filename even when its source is updated or deleted.
                            !filename.ends_with(".json")
                                || Path::new(filename)
                                    .file_name()
                                    .and_then(|name| name.to_str())
                                    != Some(filename.as_str())
                                || path.parent().is_none_or(|directory| {
                                    legacy_shadow_path(directory, filename) != path
                                })
                        }
                        None => path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.starts_with("legacy-")),
                    }
            }
            _ => true,
        }
    };
    if invalid_common || invalid_schema {
        return Err("invalid DSH ownership record".into());
    }
    Ok(record)
}

fn quarantine_observed_record(
    directory: &Path,
    path: &Path,
    record: Option<&OwnershipRecord>,
    boot_id: &str,
) -> Result<OwnershipRecord, String> {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("invalid legacy DSH ownership filename")?;
    let shadow = legacy_shadow_path(directory, filename);
    let quarantine = OwnershipRecord {
        schema_version: 2,
        pid: record.map_or_else(std::process::id, |record| record.pid),
        operation_id: None,
        process_id: record.and_then(|record| record.process_id.clone()),
        child_pid: record.and_then(|record| record.child_pid),
        nonce_digest: None,
        boot_id: Some(boot_id.to_owned()),
        retirement_required: Some(true),
        retired: Some(false),
        legacy_record: Some(filename.to_owned()),
    };
    publish_json_atomically(&shadow, &quarantine, false)?;
    read_ownership_record(&shadow, "processes")
}

fn inspect_process_record(
    directory: &Path,
    path: &Path,
    boot_id: &str,
    read_record: impl FnOnce(&Path) -> Result<OwnershipRecord, String>,
) -> Result<OwnershipRecord, String> {
    match read_record(path) {
        Ok(record) if record.schema_version == 1 => {
            quarantine_observed_record(directory, path, Some(&record), boot_id)
        }
        Ok(record) => Ok(record),
        Err(error) => {
            // An old host can remove/update an already enumerated record before
            // this read. Preserve that observation even when its PID is unknown.
            quarantine_observed_record(directory, path, None, boot_id)?;
            Err(error)
        }
    }
}

fn reject_live_owners(data_root: &Path, kind: &str, own_path: Option<&Path>) -> Result<(), String> {
    let directory = control_directory(data_root, kind)?;
    let boot_id = (kind == "processes").then(current_boot_id).transpose()?;
    let entries = std::fs::read_dir(&directory)
        .map_err(|error| format!("cannot inspect DSH ownership: {error}"))?;
    for entry in entries {
        let path = entry
            .map_err(|error| format!("cannot inspect DSH ownership entry: {error}"))?
            .path();
        if path.extension().and_then(|value| value.to_str()) != Some("json")
            || own_path == Some(path.as_path())
        {
            continue;
        }
        let record = if let Some(boot_id) = &boot_id {
            inspect_process_record(&directory, &path, boot_id, |path| {
                read_ownership_record(path, kind)
            })?
        } else {
            read_ownership_record(&path, kind)?
        };
        if let Some(boot_id) = &boot_id {
            if record.boot_id.as_ref() != Some(boot_id) {
                // The kernel boot UUID proves all processes belonging to this
                // record ended; PID reuse cannot give them current authority.
                continue;
            }
            return Err(
                "DeepSeek Harness has unsettled processes in this boot; restart the operating system before runtime maintenance"
                    .into(),
            );
        }
        if pid_is_live(record.pid) || record.child_pid.is_some_and(pid_is_live) {
            return Err(format!(
                "DeepSeek Harness has a live {kind} owner; wait for it to stop"
            ));
        }
    }
    Ok(())
}

impl OwnershipLease {
    fn publish(
        data_root: &Path,
        kind: &str,
        process_id: Option<&str>,
        nonce: Option<&str>,
    ) -> Result<Self, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let path = control_directory(data_root, kind)?.join(format!("{id}.json"));
        let record = OwnershipRecord {
            schema_version: if kind == "processes" { 2 } else { 1 },
            pid: std::process::id(),
            operation_id: (kind == "maintenance").then(|| id.clone()),
            process_id: process_id.map(str::to_owned),
            child_pid: None,
            nonce_digest: nonce.map(|nonce| hex(Sha256::digest(nonce.as_bytes()))),
            boot_id: (kind == "processes").then(current_boot_id).transpose()?,
            retirement_required: (kind == "processes").then_some(true),
            retired: (kind == "processes").then_some(false),
            legacy_record: None,
        };
        publish_json(&path, &record)?;
        Ok(Self { id, path, record })
    }
}

impl Drop for OwnershipLease {
    fn drop(&mut self) {
        if self.record.child_pid.is_some() {
            // Neither primary exit nor a successful SDK shutdown proves every
            // descendant ended. Only a later kernel boot retires started leases.
            return;
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

fn acquire_maintenance(data_root: &Path) -> Result<OwnershipLease, String> {
    let lease = OwnershipLease::publish(data_root, "maintenance", None, None)?;
    reject_live_owners(data_root, "maintenance", Some(&lease.path))?;
    reject_live_owners(data_root, "processes", None)?;
    Ok(lease)
}

/// The local process host owns admission before any asynchronous launch preparation.
pub struct DshProcessLease(OwnershipLease, String);

impl DshProcessLease {
    pub fn lease_id(&self) -> &str {
        &self.0.id
    }

    pub fn nonce(&self) -> &str {
        &self.1
    }

    pub fn acquire(data_root: &Path, process_id: Option<&str>) -> Result<Self, String> {
        let nonce = uuid::Uuid::new_v4().to_string();
        let lease = OwnershipLease::publish(data_root, "processes", process_id, Some(&nonce))?;
        reject_live_owners(data_root, "maintenance", None)?;
        Ok(Self(lease, nonce))
    }

    pub fn update_child_pid(&mut self, child_pid: u32) -> Result<(), String> {
        if child_pid == 0 {
            return Err("invalid DSH child PID publication".into());
        }
        self.0.record.child_pid = Some(child_pid);
        publish_json(&self.0.path, &self.0.record)
    }

    pub fn release_after_exit(self) {
        // Drop may release an active pending abort, never a started process.
    }
}

pub fn runtime_home(data_root: &Path) -> PathBuf {
    data_root.join(RUNTIME_DIR)
}

/// Identify the executable target, including the host's native sandbox wrapper.
pub(crate) fn invocation_runtime(
    command: &str,
    args: &[String],
) -> Result<Option<PathBuf>, String> {
    let (command, args) = if Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        == Some("cognia-external-agent-launcher")
    {
        let separator = args
            .iter()
            .position(|arg| arg == "--")
            .ok_or("invalid managed sandbox target")?;
        let target = args
            .get(separator + 1)
            .ok_or("missing managed sandbox target")?;
        (target.as_str(), &args[separator + 2..])
    } else {
        (command, args)
    };
    if Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        != Some("node")
        || args
            .first()
            .and_then(|arg| Path::new(arg).file_name())
            .is_none_or(|name| name != "launcher.mjs")
    {
        return Ok(None);
    }
    let invalid = || {
        "DeepSeek Harness requires its exact managed launcher and certified composition".to_string()
    };
    if args.len() != 2 || !Path::new(&args[0]).is_absolute() || !Path::new(&args[1]).is_absolute() {
        return Err(invalid());
    }
    let parent = Path::new(&args[0]).parent().ok_or_else(invalid)?;
    if parent.file_name().is_none_or(|name| name != RUNTIME_DIR) {
        return Err(invalid());
    }
    let metadata = std::fs::symlink_metadata(parent).map_err(|_| invalid())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid());
    }
    let root = parent.canonicalize().map_err(|_| invalid())?;
    let launcher = Path::new(&args[0]).canonicalize().map_err(|_| invalid())?;
    let composition = Path::new(&args[1]).canonicalize().map_err(|_| invalid())?;
    if launcher != root.join("launcher.mjs")
        || ![
            "host.sdk-readonly.yml",
            "host.sdk-workspace.yml",
            "host.acp.yml",
        ]
        .iter()
        .any(|name| composition == root.join(name))
    {
        return Err(invalid());
    }
    Ok(Some(root))
}

/// An environment tag cannot opt into or out of host ownership.
pub(crate) fn normalize_managed_launch(
    config: &mut crate::process::ExternalAgentSpawnConfig,
) -> Result<Option<PathBuf>, String> {
    let runtime = invocation_runtime(&config.command, &config.args)?;
    match &runtime {
        Some(root) => {
            for (key, expected) in [
                ("COGNIA_DSH_RUNTIME_HOME", root.clone()),
                ("DSH_HOME", root.join(DSH_HOME_DIR)),
                ("COGNIA_DSH_SESSION_ROOT", root.join("sessions")),
            ] {
                if let Some(requested) = config.env.get(key) {
                    let requested =
                        cognia_exec_sandbox::paths::safe_canonicalize(Path::new(requested))
                            .map_err(|error| error.to_string())?;
                    if requested != expected {
                        return Err(format!(
                            "managed DSH {key} does not match its certified invocation"
                        ));
                    }
                }
                config
                    .env
                    .insert(key.into(), expected.to_string_lossy().into_owned());
            }
        }
        None if config.env.contains_key("COGNIA_DSH_RUNTIME_HOME") => {
            return Err("managed DSH environment requires a certified launcher invocation".into())
        }
        None => {}
    }
    Ok(runtime)
}

/// The Cognia data root that owns the runtime home on this host.
///
/// `COGNIA_DATA_DIR` first so desktop and headless agree when the user has
/// relocated it; otherwise the app data dir, matching every other Cognia store
/// on desktop (`app_data_dir()/cognia`).
#[cfg(feature = "tauri-host")]
pub fn host_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var("COGNIA_DATA_DIR") {
        if !raw.trim().is_empty() {
            return Ok(PathBuf::from(raw));
        }
    }
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("cognia"))
        .map_err(|error| format!("cannot resolve the app data dir: {error}"))
}

/// The Node version the runtime would boot under.
///
/// The preflight verdict compares this against `NODE_MAJOR_REQUIRED`, so an
/// unresolvable `node` must surface as an empty string (which fails preflight
/// with "Node not found") rather than as a command error — the card can then
/// render the real remedy instead of an opaque invoke failure.
pub fn host_node_version() -> String {
    let Some(node) = crate::command_resolver::resolve_command_path("node") else {
        return String::new();
    };
    std::process::Command::new(node)
        .arg("--version")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default()
}

#[cfg(any(feature = "tauri-host", test))]
fn source_dir_from_root(root: &Path) -> Option<PathBuf> {
    // Array-form Tauri resources encode the source's `../` as `_up_/`.
    [root.to_path_buf(), root.join("_up_")]
        .into_iter()
        .map(|base| base.join("packages/agent-dsh/runtime"))
        .find(|candidate| candidate.is_dir())
}

/// Where the shipped `packages/agent-dsh/runtime/` artifacts live on this host.
///
/// Bundled as a Tauri resource in a packaged app; in `tauri dev` the resource
/// dir holds no such folder, so fall back to the repo checkout via the
/// compile-time manifest dir — the same resource-dir-then-manifest-parent
/// pattern `hooks::builtin::builtin_base_dir` uses.
#[cfg(feature = "tauri-host")]
pub fn host_source_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Some(candidate) = source_dir_from_root(&resource_dir) {
            return Ok(candidate);
        }
    }
    if let Some(root) = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
    {
        if let Some(candidate) = source_dir_from_root(root) {
            return Ok(candidate);
        }
    }
    Err(format!(
        "the bundled {RUNTIME_DIR} artifacts were not found in the resource dir"
    ))
}

fn staging_dir(data_root: &Path, install_id: &str) -> Result<PathBuf, String> {
    if uuid::Uuid::parse_str(install_id).is_err() || install_id.len() != 36 {
        return Err("invalid DeepSeek Harness install ID".into());
    }
    Ok(data_root.join(format!("{RUNTIME_DIR}.staging-{install_id}")))
}

fn previous_dir(data_root: &Path) -> PathBuf {
    data_root.join(format!("{RUNTIME_DIR}.previous"))
}

pub fn dsh_home(data_root: &Path) -> PathBuf {
    runtime_home(data_root).join(DSH_HOME_DIR)
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Digest over the composition and launcher bytes.
///
/// Each file contributes its name and length as well as its content, so moving
/// bytes between two compositions cannot produce the same digest. Must stay
/// byte-identical to `computeCompositionDigest` in the TypeScript installer, or
/// a runtime installed on desktop would fail doctor under the CLI.
pub fn compute_composition_digest(dir: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    for name in COMPOSITION_DIGEST_FILES {
        let content =
            std::fs::read(dir.join(name)).map_err(|e| format!("cannot read {name}: {e}"))?;
        hasher.update(name.as_bytes());
        hasher.update(b"\0");
        hasher.update(content.len().to_string().as_bytes());
        hasher.update(b"\0");
        hasher.update(&content);
    }
    Ok(hex(hasher.finalize()))
}

pub fn compute_lockfile_digest(dir: &Path) -> Result<String, String> {
    let content = std::fs::read(dir.join("package-lock.json"))
        .map_err(|e| format!("cannot read package-lock.json: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&content);
    Ok(hex(hasher.finalize()))
}

/// `<os>-<arch>`, matching the spellings upstream's prebuild directories use.
pub fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// Patch layers under `DSH_HOME`.
///
/// A profile `package.json` counts too: its `dependencies` are out-of-tree
/// plugins, which is as much a hole in the certification as a patch file.
pub fn find_stray_patch_layers(dsh_home: &Path) -> Vec<String> {
    let mut found = Vec::new();
    for name in ["cordis.patch.yml", ".env"] {
        let candidate = dsh_home.join(name);
        if std::fs::symlink_metadata(&candidate).is_ok() {
            found.push(candidate.to_string_lossy().into_owned());
        }
    }
    let profiles = dsh_home.join("profiles");
    if let Ok(metadata) = std::fs::symlink_metadata(&profiles) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            found.push(profiles.to_string_lossy().into_owned());
            return found;
        }
    }
    if let Ok(entries) = std::fs::read_dir(&profiles) {
        for entry in entries.flatten() {
            let profile_name = entry.file_name().to_string_lossy().into_owned();
            if profile_name == "node_modules" {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                found.push(entry.path().to_string_lossy().into_owned());
                continue;
            }
            if !kind.is_dir() {
                continue;
            }
            for name in ["cordis.patch.yml", "package.json"] {
                let candidate = entry.path().join(name);
                let Ok(metadata) = std::fs::symlink_metadata(&candidate) else {
                    continue;
                };
                let managed = name == "package.json"
                    && metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && ["cognia-sdk-readonly", "cognia-sdk-workspace", "cognia-acp"]
                        .contains(&profile_name.as_str())
                    && std::fs::read_to_string(&candidate)
                        .ok()
                        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                        == Some(serde_json::json!({
                            "name": profile_name, "private": true, "type": "module",
                            "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-sdk-minimal"], "patchReload": "startup" } }
                        }));
                if !managed {
                    found.push(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    found.sort();
    found
}

/// Whether a C/C++ toolchain is on PATH, for profiles needing a node-pty build.
fn has_native_toolchain() -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        ["cc", "gcc", "clang"]
            .iter()
            .any(|bin| dir.join(bin).exists())
    })
}

/// Gather everything the shared verdict function needs.
///
/// A missing or unreadable digest becomes the literal `"unreadable"` rather than
/// an error: that value can never equal a certified digest, so the TypeScript
/// side reports a mismatch instead of the whole check failing.
pub fn gather_facts(data_root: &Path, node_version: String) -> DshRuntimeFacts {
    let home = runtime_home(data_root);
    let manifest_json = std::fs::read_to_string(home.join(CHANNEL_MANIFEST_FILE)).ok();
    DshRuntimeFacts {
        runtime_home: home.to_string_lossy().into_owned(),
        node_path: crate::command_resolver::resolve_command_path("node")
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        default_workspace: std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        parent_env: ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"]
            .iter()
            .filter_map(|key| {
                std::env::var(key)
                    .ok()
                    .map(|value| (key.to_string(), value))
            })
            .collect(),
        manifest_json,
        lockfile_digest: compute_lockfile_digest(&home).unwrap_or_else(|_| "unreadable".into()),
        composition_digest: compute_composition_digest(&home)
            .unwrap_or_else(|_| "unreadable".into()),
        node_version,
        platform: platform_key(),
        stray_patch_paths: find_stray_patch_layers(&dsh_home(data_root)),
        has_native_toolchain: has_native_toolchain(),
    }
}

/// Stage a new runtime and install its dependencies.
///
/// Leaves the staging tree in place for [`finalize_install`]; the live runtime
/// is untouched until then, so a failure here cannot strand the user without a
/// working runtime.
pub async fn stage_install(
    data_root: &Path,
    source_dir: &Path,
) -> Result<DshInstallDigests, String> {
    let _maintenance = acquire_maintenance(data_root)?;
    for artifact in RUNTIME_ARTIFACTS {
        if !source_dir.join(artifact).exists() {
            return Err(format!("runtime artifact missing from source: {artifact}"));
        }
    }

    let install_id = uuid::Uuid::new_v4().to_string();
    let staging = staging_dir(data_root, &install_id)?;
    std::fs::create_dir(&staging).map_err(|e| format!("cannot create staging dir: {e}"))?;
    for artifact in RUNTIME_ARTIFACTS {
        std::fs::copy(source_dir.join(artifact), staging.join(artifact))
            .map_err(|e| format!("cannot copy {artifact}: {e}"))?;
    }
    // Created up front so the launcher's containment check has a real directory
    // to canonicalize rather than falling back to a lexical path.
    std::fs::create_dir_all(staging.join(DSH_HOME_DIR))
        .map_err(|e| format!("cannot create dsh home: {e}"))?;

    let output = tokio::process::Command::new("npm")
        .args([
            "install",
            // koffi is a hard dependency of dsh-fs-local but is imported only
            // from a Windows-only path, so it is installed and never built.
            // Skipping scripts also removes an arbitrary-code-execution step.
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
        ])
        .current_dir(&staging)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&staging);
            format!("npm could not be started: {e}")
        })?;

    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&staging);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr
            .chars()
            .rev()
            .take(2000)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        return Err(format!(
            "npm install failed; the previous runtime was left in place. {tail}"
        ));
    }

    if !staging.join("package-lock.json").exists() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("npm install produced no package-lock.json; refusing to certify".into());
    }

    let digests = DshInstallDigests {
        install_id: install_id.clone(),
        lockfile_digest: compute_lockfile_digest(&staging)?,
        composition_digest: compute_composition_digest(&staging)?,
    };
    publish_json(
        &staging.join(INSTALL_MARKER),
        &InstallMarker {
            schema_version: 1,
            install_id,
            lockfile_digest: digests.lockfile_digest.clone(),
            composition_digest: digests.composition_digest.clone(),
        },
    )?;
    Ok(digests)
}

/// Write the manifest the renderer built and swap the staged tree in.
pub fn finalize_install(
    data_root: &Path,
    manifest_json: &str,
    install_id: &str,
) -> Result<(), String> {
    let _maintenance = acquire_maintenance(data_root)?;
    let staging = staging_dir(data_root, install_id)?;
    let metadata = std::fs::symlink_metadata(&staging)
        .map_err(|error| format!("no staged runtime to finalize: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("staged runtime must be a real directory".into());
    }
    let marker_path = staging.join(INSTALL_MARKER);
    let marker_metadata = std::fs::symlink_metadata(&marker_path)
        .map_err(|error| format!("staged runtime is not ready: {error}"))?;
    if !marker_metadata.is_file() || marker_metadata.file_type().is_symlink() {
        return Err("invalid staged runtime readiness marker".into());
    }
    let marker: InstallMarker =
        serde_json::from_slice(&std::fs::read(marker_path).map_err(|error| error.to_string())?)
            .map_err(|_| "invalid staged runtime readiness marker".to_string())?;
    let manifest: serde_json::Value =
        serde_json::from_str(manifest_json).map_err(|_| "invalid channel manifest".to_string())?;
    if marker.schema_version != 1
        || marker.install_id != install_id
        || marker.lockfile_digest != compute_lockfile_digest(&staging)?
        || marker.composition_digest != compute_composition_digest(&staging)?
        || manifest
            != certified_channel_manifest(&marker.lockfile_digest, &marker.composition_digest)?
    {
        return Err("staged runtime identity or digests do not match the install request".into());
    }
    std::fs::write(staging.join(CHANNEL_MANIFEST_FILE), manifest_json)
        .map_err(|e| format!("cannot write channel manifest: {e}"))?;
    activate_staging(data_root, &staging, |from, to| std::fs::rename(from, to))
}

fn certified_channel_manifest(
    lockfile_digest: &str,
    composition_digest: &str,
) -> Result<serde_json::Value, String> {
    let mut channel: serde_json::Value = serde_json::from_str(include_str!(
        "../../../protocol/deepseek-harness-channel-certification.json"
    ))
    .map_err(|error| format!("invalid bundled DSH certification policy: {error}"))?;
    channel["lockfileDigest"] = lockfile_digest.into();
    channel["compositionDigest"] = composition_digest.into();
    let upstream = channel["upstreamVersion"]
        .as_str()
        .ok_or("invalid bundled DSH version")?;
    channel["channelId"] = format!(
        "dsh-{upstream}-{}",
        composition_digest
            .get(..8)
            .ok_or("invalid DSH composition digest")?
    )
    .into();
    Ok(channel)
}

fn copy_durable_tree(source: &Path, target: &Path, runtime: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(source)
        .map_err(|error| format!("cannot read durable runtime state: {error}"))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let destination = target.join(entry.file_name());
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_symlink() {
            let resolved = entry
                .path()
                .canonicalize()
                .map_err(|error| format!("cannot validate durable state link: {error}"))?;
            if !resolved.starts_with(runtime) {
                return Err("durable runtime state link escapes the runtime home".into());
            }
            let link = std::fs::read_link(entry.path()).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(link, destination).map_err(|error| error.to_string())?;
            #[cfg(not(unix))]
            return Err(format!(
                "durable runtime symlinks are unsupported: {}",
                link.display()
            ));
        } else if kind.is_dir() {
            std::fs::create_dir(&destination).map_err(|error| error.to_string())?;
            copy_durable_tree(&entry.path(), &destination, runtime)?;
            std::fs::set_permissions(
                &destination,
                entry
                    .metadata()
                    .map_err(|error| error.to_string())?
                    .permissions(),
            )
            .map_err(|error| error.to_string())?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), destination)
                .map_err(|error| format!("cannot preserve durable runtime state: {error}"))?;
        } else {
            return Err("unsupported durable runtime state entry".into());
        }
    }
    Ok(())
}

fn activate_staging(
    data_root: &Path,
    staging: &Path,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let home = runtime_home(data_root);
    let previous = previous_dir(data_root);
    if previous.try_exists().map_err(|error| error.to_string())? {
        ensure_owned_directory(&previous)?;
        if home.try_exists().map_err(|error| error.to_string())? {
            return Err(
                "both live runtime and previous recovery backup exist; refusing to discard either"
                    .into(),
            );
        }
        rename(&previous, &home)
            .map_err(|error| format!("cannot recover previous runtime: {error}"))?;
    }
    if home.exists() {
        ensure_owned_directory(&home)?;
        let canonical_home = home.canonicalize().map_err(|error| error.to_string())?;
        for name in ["sessions", DSH_HOME_DIR] {
            let source = home.join(name);
            match std::fs::symlink_metadata(&source) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    let destination = staging.join(name);
                    if destination
                        .try_exists()
                        .map_err(|error| error.to_string())?
                    {
                        let metadata = std::fs::symlink_metadata(&destination)
                            .map_err(|error| error.to_string())?;
                        if !metadata.is_dir() || metadata.file_type().is_symlink() {
                            return Err("invalid staged durable-state root".into());
                        }
                        std::fs::remove_dir_all(&destination).map_err(|error| error.to_string())?;
                    }
                    std::fs::create_dir(&destination).map_err(|error| error.to_string())?;
                    copy_durable_tree(&source, &destination, &canonical_home)?;
                    std::fs::set_permissions(&destination, metadata.permissions())
                        .map_err(|error| error.to_string())?;
                }
                Ok(_) => return Err("durable runtime state root must be a real directory".into()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("cannot inspect durable runtime state: {error}")),
            }
        }
        rename(&home, &previous).map_err(|e| format!("cannot archive previous: {e}"))?;
    }
    if let Err(error) = rename(staging, &home) {
        // Put the old runtime back rather than leaving the user with none.
        if previous.exists() {
            if let Err(rollback) = rename(&previous, &home) {
                return Err(format!("cannot activate staged runtime: {error}; previous runtime retained for recovery: {rollback}"));
            }
        }
        return Err(format!("cannot activate staged runtime: {error}"));
    }
    let _ = std::fs::remove_dir_all(&previous);
    Ok(())
}

pub fn remove_runtime(data_root: &Path, active_session_count: u32) -> Result<(), String> {
    let _maintenance = acquire_maintenance(data_root)?;
    if active_session_count > 0 {
        return Err(format!(
            "refusing to remove the runtime while {active_session_count} session(s) are still using it"
        ));
    }
    let mut owned_paths = vec![runtime_home(data_root), previous_dir(data_root)];
    for entry in std::fs::read_dir(data_root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_prefix("deepseek-harness.staging-"))
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok() && id.len() == 36)
        {
            owned_paths.push(entry.path());
        }
    }
    for path in owned_paths {
        match std::fs::remove_dir_all(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("cannot remove DeepSeek Harness runtime: {error}")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_dir_resolves_direct_and_tauri_parent_resource_layouts() {
        for prefix in ["", "_up_"] {
            let root = tempfile::tempdir().unwrap();
            let source = root.path().join(prefix).join("packages/agent-dsh/runtime");
            std::fs::create_dir_all(&source).unwrap();
            seed_source(&source);
            assert_eq!(source_dir_from_root(root.path()), Some(source));
        }
    }

    #[test]
    fn source_dir_is_absent_without_the_managed_runtime_payload() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(source_dir_from_root(root.path()), None);
    }

    #[test]
    fn package_owned_source_contains_every_install_artifact() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let source = source_dir_from_root(&root).expect("package-owned DSH runtime source");
        for artifact in RUNTIME_ARTIFACTS {
            assert!(source.join(artifact).is_file(), "missing {artifact}");
        }
    }

    fn seed_source(dir: &Path) {
        for artifact in RUNTIME_ARTIFACTS {
            std::fs::write(dir.join(artifact), format!("# {artifact}\n")).unwrap();
        }
    }

    #[test]
    fn host_node_version_is_empty_or_a_v_prefixed_version() {
        // The preflight verdict treats "" as "Node not found" and parses the
        // major out of anything else, so those are the only two shapes allowed
        // to escape this helper — never a raw command error.
        let version = host_node_version();
        assert!(
            version.is_empty() || version.starts_with('v'),
            "unexpected node version shape: {version:?}"
        );
        assert!(!version.contains('\n'), "version must be trimmed");
    }

    #[test]
    fn composition_digest_is_stable_and_content_sensitive() {
        let tmp = tempfile::tempdir().unwrap();
        seed_source(tmp.path());
        let first = compute_composition_digest(tmp.path()).unwrap();
        assert_eq!(first, compute_composition_digest(tmp.path()).unwrap());

        std::fs::write(tmp.path().join("host.sdk-readonly.yml"), "# tampered\n").unwrap();
        assert_ne!(first, compute_composition_digest(tmp.path()).unwrap());
    }

    #[test]
    fn composition_digest_distinguishes_content_moved_between_files() {
        // Name and length are folded in, so a byte swap cannot collide.
        let tmp = tempfile::tempdir().unwrap();
        seed_source(tmp.path());
        std::fs::write(tmp.path().join("host.sdk-readonly.yml"), "AB").unwrap();
        std::fs::write(tmp.path().join("host.sdk-workspace.yml"), "").unwrap();
        let first = compute_composition_digest(tmp.path()).unwrap();

        std::fs::write(tmp.path().join("host.sdk-readonly.yml"), "").unwrap();
        std::fs::write(tmp.path().join("host.sdk-workspace.yml"), "AB").unwrap();
        assert_ne!(first, compute_composition_digest(tmp.path()).unwrap());
    }

    #[test]
    fn composition_digest_matches_the_typescript_installer() {
        // Both hosts must agree byte-for-byte, or a runtime installed on desktop
        // fails doctor under the CLI. Fixture values are the sha256 of the
        // documented framing: name \0 length \0 content, per file, in order.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("launcher.mjs"), "a").unwrap();
        std::fs::write(tmp.path().join("host.root.yml"), "root").unwrap();
        std::fs::write(tmp.path().join("host.sdk-readonly.yml"), "b").unwrap();
        std::fs::write(tmp.path().join("host.sdk-workspace.yml"), "c").unwrap();
        std::fs::write(tmp.path().join("host.acp.yml"), "d").unwrap();

        let mut expected = Sha256::new();
        for (name, content) in [
            ("launcher.mjs", "a"),
            ("host.root.yml", "root"),
            ("host.sdk-readonly.yml", "b"),
            ("host.sdk-workspace.yml", "c"),
            ("host.acp.yml", "d"),
        ] {
            expected.update(name.as_bytes());
            expected.update(b"\0");
            expected.update(content.len().to_string().as_bytes());
            expected.update(b"\0");
            expected.update(content.as_bytes());
        }
        assert_eq!(
            compute_composition_digest(tmp.path()).unwrap(),
            hex(expected.finalize())
        );
    }

    #[test]
    fn platform_key_uses_upstream_prebuild_spellings() {
        let key = platform_key();
        assert!(key.contains('-'), "expected <os>-<arch>, got {key}");
        assert!(!key.starts_with("macos"), "macos must be spelled darwin");
    }

    #[test]
    fn stray_patch_layers_are_found_at_home_and_profile_level() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        assert!(find_stray_patch_layers(home).is_empty());

        std::fs::write(home.join("cordis.patch.yml"), "- id: evil\n").unwrap();
        let profile = home.join("profiles").join("sneaky");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("cordis.patch.yml"), "").unwrap();
        // A profile package.json declares out-of-tree plugin dependencies.
        std::fs::write(profile.join("package.json"), "{}").unwrap();

        assert_eq!(find_stray_patch_layers(home).len(), 3);
    }

    #[test]
    fn unrelated_files_are_not_reported_as_patch_layers() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("notes.txt"), "hello").unwrap();
        assert!(find_stray_patch_layers(tmp.path()).is_empty());
    }

    #[test]
    fn managed_profile_manifests_remain_healthy_after_first_launch() {
        let tmp = tempfile::tempdir().unwrap();
        for profile in ["cognia-sdk-readonly", "cognia-sdk-workspace", "cognia-acp"] {
            let dir = tmp.path().join("profiles").join(profile);
            std::fs::create_dir_all(&dir).unwrap();
            let manifest = serde_json::json!({
                "name": profile, "private": true, "type": "module",
                "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-sdk-minimal"], "patchReload": "startup"}}
            });
            std::fs::write(dir.join("package.json"), manifest.to_string()).unwrap();
        }
        assert!(find_stray_patch_layers(tmp.path()).is_empty());
        let modified = tmp.path().join("profiles/cognia-acp/package.json");
        std::fs::write(&modified, "{}").unwrap();
        assert_eq!(
            find_stray_patch_layers(tmp.path()),
            vec![modified.to_string_lossy().into_owned()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_manifests_and_profiles_are_not_certified() {
        let tmp = tempfile::tempdir().unwrap();
        let profile = tmp.path().join("profiles/cognia-acp");
        std::fs::create_dir_all(&profile).unwrap();
        let target = tmp.path().join("approved.json");
        std::fs::write(&target, serde_json::json!({
            "name": "cognia-acp", "private": true, "type": "module",
            "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-sdk-minimal"], "patchReload": "startup"}}
        }).to_string()).unwrap();
        std::os::unix::fs::symlink(&target, profile.join("package.json")).unwrap();
        assert_eq!(find_stray_patch_layers(tmp.path()).len(), 1);
        std::os::unix::fs::symlink(&profile, tmp.path().join("profiles/cognia-sdk-readonly"))
            .unwrap();
        assert_eq!(find_stray_patch_layers(tmp.path()).len(), 2);
    }

    #[test]
    fn facts_report_unreadable_digests_instead_of_failing() {
        // "unreadable" can never equal a certified digest, so the shared verdict
        // function reports a mismatch rather than the check blowing up.
        let tmp = tempfile::tempdir().unwrap();
        let facts = gather_facts(tmp.path(), "v26.0.0".into());
        assert_eq!(facts.lockfile_digest, "unreadable");
        assert_eq!(facts.composition_digest, "unreadable");
        assert!(facts.manifest_json.is_none());
        assert_eq!(
            facts.runtime_home,
            runtime_home(tmp.path()).to_string_lossy()
        );
        assert!(!facts.default_workspace.is_empty());
        assert!(facts
            .parent_env
            .keys()
            .all(|key| ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"].contains(&key.as_str())));
    }

    #[test]
    fn stage_install_rejects_a_source_missing_an_artifact() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("src");
        std::fs::create_dir_all(&source).unwrap();
        seed_source(&source);
        std::fs::remove_file(source.join("launcher.mjs")).unwrap();

        let err = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(stage_install(tmp.path(), &source))
            .unwrap_err();
        assert!(err.contains("launcher.mjs"), "{err}");
    }

    #[test]
    fn finalize_refuses_without_a_staged_tree() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(finalize_install(tmp.path(), "{}", &uuid::Uuid::new_v4().to_string()).is_err());
    }

    fn seed_ready_stage(data_root: &Path) -> (String, PathBuf, String) {
        let install_id = uuid::Uuid::new_v4().to_string();
        let staging = staging_dir(data_root, &install_id).unwrap();
        std::fs::create_dir_all(&staging).unwrap();
        seed_source(&staging);
        std::fs::write(staging.join("package-lock.json"), "lock").unwrap();
        let marker = InstallMarker {
            schema_version: 1,
            install_id: install_id.clone(),
            lockfile_digest: compute_lockfile_digest(&staging).unwrap(),
            composition_digest: compute_composition_digest(&staging).unwrap(),
        };
        let manifest =
            certified_channel_manifest(&marker.lockfile_digest, &marker.composition_digest)
                .unwrap()
                .to_string();
        publish_json(&staging.join(INSTALL_MARKER), &marker).unwrap();
        (install_id, staging, manifest)
    }

    #[test]
    fn finalize_preserves_native_sessions_and_profile_state() {
        let tmp = tempfile::tempdir().unwrap();
        let home = runtime_home(tmp.path());
        std::fs::create_dir_all(home.join("sessions")).unwrap();
        std::fs::create_dir_all(home.join("dsh-home/profiles/cognia-acp")).unwrap();
        std::fs::write(home.join("sessions/conversation.jsonl"), "native-history").unwrap();
        std::fs::write(
            home.join("dsh-home/profiles/cognia-acp/package.json"),
            "profile-state",
        )
        .unwrap();
        let (install_id, _, manifest) = seed_ready_stage(tmp.path());
        finalize_install(tmp.path(), &manifest, &install_id).unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join("sessions/conversation.jsonl")).unwrap(),
            "native-history"
        );
        assert_eq!(
            std::fs::read_to_string(home.join("dsh-home/profiles/cognia-acp/package.json"))
                .unwrap(),
            "profile-state"
        );
    }

    #[test]
    fn remove_rejects_a_host_owned_pending_process_even_when_renderer_reports_zero() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(runtime_home(tmp.path())).unwrap();
        let leases = tmp.path().join(".deepseek-harness-control/processes");
        std::fs::create_dir_all(&leases).unwrap();
        std::fs::write(leases.join("pending.json"), serde_json::json!({"schemaVersion":1,"pid":std::process::id(),"processId":"pending-spawn"}).to_string()).unwrap();
        assert!(remove_runtime(tmp.path(), 0).is_err());
        assert!(runtime_home(tmp.path()).exists());
    }

    #[test]
    fn finalize_writes_the_manifest_and_activates_the_staged_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let (install_id, staging, manifest) = seed_ready_stage(tmp.path());

        finalize_install(tmp.path(), &manifest, &install_id).unwrap();

        let home = runtime_home(tmp.path());
        assert!(home.join("launcher.mjs").exists());
        assert_eq!(
            std::fs::read_to_string(home.join(CHANNEL_MANIFEST_FILE)).unwrap(),
            manifest
        );
        assert!(!staging.exists());
        assert!(!previous_dir(tmp.path()).exists());
    }

    #[test]
    fn finalize_replaces_an_existing_runtime() {
        let tmp = tempfile::tempdir().unwrap();
        let home = runtime_home(tmp.path());
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("marker"), "old").unwrap();

        let (install_id, _, manifest) = seed_ready_stage(tmp.path());

        finalize_install(tmp.path(), &manifest, &install_id).unwrap();
        assert!(!home.join("marker").exists());
        assert!(home.join("launcher.mjs").exists());
    }

    #[test]
    fn remove_refuses_while_sessions_are_live() {
        // Removing under a live session would strand a running subprocess whose
        // composition had just been deleted.
        let tmp = tempfile::tempdir().unwrap();
        let home = runtime_home(tmp.path());
        std::fs::create_dir_all(&home).unwrap();

        assert!(remove_runtime(tmp.path(), 2).is_err());
        assert!(home.exists());

        remove_runtime(tmp.path(), 0).unwrap();
        assert!(!home.exists());
    }

    #[test]
    fn remove_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(remove_runtime(tmp.path(), 0).is_ok());
        assert!(remove_runtime(tmp.path(), 0).is_ok());
    }

    #[test]
    fn finalize_requires_the_exact_ready_install_and_recomputed_digests() {
        let root = tempfile::tempdir().unwrap();
        let (id, staging, manifest) = seed_ready_stage(root.path());
        assert!(finalize_install(root.path(), &manifest, "../escape").is_err());
        assert!(
            finalize_install(root.path(), &manifest, &uuid::Uuid::new_v4().to_string()).is_err()
        );
        assert!(finalize_install(root.path(), "{}", &id).is_err());
        let marker = staging.join(INSTALL_MARKER);
        let original = std::fs::read(&marker).unwrap();
        std::fs::remove_file(&marker).unwrap();
        assert!(finalize_install(root.path(), &manifest, &id).is_err());
        std::fs::write(&marker, original).unwrap();
        std::fs::write(staging.join("launcher.mjs"), "tampered").unwrap();
        assert!(finalize_install(root.path(), &manifest, &id).is_err());
        assert!(staging.exists());
        assert!(!runtime_home(root.path()).exists());
    }

    #[test]
    fn finalize_rejects_incomplete_stale_or_widened_channel_certification() {
        for mutation in ["incomplete", "stale", "unsafe-profile", "extra-field"] {
            let root = tempfile::tempdir().unwrap();
            let (id, staging, manifest) = seed_ready_stage(root.path());
            let mut manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
            match mutation {
                "incomplete" => {
                    manifest.as_object_mut().unwrap().remove("profiles");
                }
                "stale" => manifest["conformanceSuiteVersion"] = "old-suite".into(),
                "unsafe-profile" => {
                    manifest["profiles"] = serde_json::json!([{"profileId":"cognia-sdk-readonly","compositionFile":"dsh-home/evil.yml","capabilities":{"transport":"acp","interactiveApproval":true}}])
                }
                _ => manifest["unexpectedAuthority"] = true.into(),
            }
            assert!(
                finalize_install(root.path(), &manifest.to_string(), &id).is_err(),
                "accepted {mutation} channel certification"
            );
            assert!(staging.exists());
            assert!(!runtime_home(root.path()).exists());
        }
    }

    #[test]
    fn explicit_remove_invalidates_ready_installs_before_delayed_finalize() {
        let root = tempfile::tempdir().unwrap();
        let (id, _, manifest) = seed_ready_stage(root.path());
        remove_runtime(root.path(), 0).unwrap();
        assert!(
            finalize_install(root.path(), &manifest, &id).is_err(),
            "a delayed finalize resurrected an explicitly removed runtime"
        );
        assert!(!runtime_home(root.path()).exists());
    }

    #[test]
    fn writable_scope_protects_staged_dependency_trees_and_previous_recovery() {
        let root = tempfile::tempdir().unwrap();
        for relative in [
            "deepseek-harness.previous/node_modules",
            "deepseek-harness.staging-550e8400-e29b-41d4-a716-446655440000/node_modules",
        ] {
            let writable = root.path().join(relative);
            std::fs::create_dir_all(&writable).unwrap();
            assert!(
                assert_writable_scope(&runtime_home(root.path()), &writable).is_err(),
                "reserved runtime code was writable: {relative}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn dsh_root_symlink_is_rejected_when_deriving_unconfigured_managed_launch() {
        let data = tempfile::tempdir().unwrap();
        let target = data.path().join("workspaces/evil/deepseek-harness");
        std::fs::create_dir_all(&target).unwrap();
        for name in ["launcher.mjs", "host.sdk-readonly.yml"] {
            std::fs::write(target.join(name), "fixture").unwrap();
        }
        let alias = data.path().join("deepseek-harness");
        std::os::unix::fs::symlink(target, &alias).unwrap();
        let args = [
            alias.join("launcher.mjs"),
            alias.join("host.sdk-readonly.yml"),
        ]
        .map(|path| path.to_string_lossy().into_owned());
        assert!(invocation_runtime("node", &args).is_err());
    }

    #[test]
    fn independent_ready_stages_finalize_by_identity_and_explicit_remove_invalidates_all() {
        let root = tempfile::tempdir().unwrap();
        let (first_id, first, first_manifest) = seed_ready_stage(root.path());
        let (second_id, second, second_manifest) = seed_ready_stage(root.path());
        std::fs::write(first.join("identity"), "first").unwrap();
        std::fs::write(second.join("identity"), "second").unwrap();
        finalize_install(root.path(), &first_manifest, &first_id).unwrap();
        assert!(second.exists());
        assert_eq!(
            std::fs::read_to_string(runtime_home(root.path()).join("identity")).unwrap(),
            "first"
        );
        assert!(finalize_install(root.path(), &first_manifest, &first_id).is_err());
        assert!(second.exists());
        finalize_install(root.path(), &second_manifest, &second_id).unwrap();
        assert_eq!(
            std::fs::read_to_string(runtime_home(root.path()).join("identity")).unwrap(),
            "second"
        );
        let (_, third, _) = seed_ready_stage(root.path());
        remove_runtime(root.path(), 0).unwrap();
        assert!(
            !third.exists(),
            "explicit removal invalidates all prior staged installs"
        );
    }

    #[test]
    fn activation_failure_restores_runtime_and_durable_state() {
        let root = tempfile::tempdir().unwrap();
        let home = runtime_home(root.path());
        std::fs::create_dir_all(home.join("sessions")).unwrap();
        std::fs::write(home.join("sessions/history.jsonl"), "old-history").unwrap();
        std::fs::write(home.join("identity"), "old-runtime").unwrap();
        let (_, staging, _) = seed_ready_stage(root.path());
        let error = activate_staging(root.path(), &staging, |from, to| {
            if from == staging {
                return Err(std::io::Error::other("fixture activation failure"));
            }
            std::fs::rename(from, to)
        })
        .unwrap_err();
        assert!(error.contains("fixture activation failure"));
        assert_eq!(
            std::fs::read_to_string(home.join("identity")).unwrap(),
            "old-runtime"
        );
        assert_eq!(
            std::fs::read_to_string(home.join("sessions/history.jsonl")).unwrap(),
            "old-history"
        );
        assert!(staging.exists());
        assert!(!previous_dir(root.path()).exists());
    }

    #[test]
    fn failed_rollback_preserves_the_only_backup_and_next_attempt_recovers_it() {
        let root = tempfile::tempdir().unwrap();
        let home = runtime_home(root.path());
        std::fs::create_dir_all(home.join("sessions")).unwrap();
        std::fs::write(home.join("sessions/history.jsonl"), "sole-history").unwrap();
        let (id, staging, manifest) = seed_ready_stage(root.path());
        assert!(activate_staging(root.path(), &staging, |from, to| {
            if from == staging || from == previous_dir(root.path()) {
                return Err(std::io::Error::other("fixture rename failure"));
            }
            std::fs::rename(from, to)
        })
        .is_err());
        assert!(!home.exists());
        assert!(previous_dir(root.path())
            .join("sessions/history.jsonl")
            .exists());
        finalize_install(root.path(), &manifest, &id).unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join("sessions/history.jsonl")).unwrap(),
            "sole-history"
        );
    }

    #[test]
    fn ambiguous_previous_backup_is_never_deleted_on_retry() {
        let root = tempfile::tempdir().unwrap();
        for directory in [runtime_home(root.path()), previous_dir(root.path())] {
            std::fs::create_dir_all(directory.join("sessions")).unwrap();
            std::fs::write(directory.join("sessions/history.jsonl"), "preserve-me").unwrap();
        }
        let (id, _, manifest) = seed_ready_stage(root.path());
        assert!(finalize_install(root.path(), &manifest, &id).is_err());
        assert!(previous_dir(root.path())
            .join("sessions/history.jsonl")
            .exists());
        assert!(runtime_home(root.path())
            .join("sessions/history.jsonl")
            .exists());
    }

    #[test]
    fn pending_and_live_process_leases_block_every_maintenance_operation() {
        let root = tempfile::tempdir().unwrap();
        let (id, _, manifest) = seed_ready_stage(root.path());
        let mut lease = DshProcessLease::acquire(root.path(), Some("pending")).unwrap();
        assert!(remove_runtime(root.path(), 0).is_err());
        assert!(finalize_install(root.path(), &manifest, &id).is_err());
        assert!(tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(stage_install(root.path(), root.path()))
            .unwrap_err()
            .contains("unsettled processes"));
        lease.update_child_pid(std::process::id()).unwrap();
        assert!(acquire_maintenance(root.path()).is_err());
        lease.release_after_exit();
        assert!(acquire_maintenance(root.path()).is_err());
    }

    #[test]
    fn maintenance_blocks_process_admission_and_other_operations_without_removing_their_records() {
        let root = tempfile::tempdir().unwrap();
        let maintenance = acquire_maintenance(root.path()).unwrap();
        assert!(DshProcessLease::acquire(root.path(), Some("denied")).is_err());
        assert!(acquire_maintenance(root.path()).is_err());
        assert!(maintenance.path.exists());
        assert_eq!(
            std::fs::read_dir(control_directory(root.path(), "processes").unwrap())
                .unwrap()
                .count(),
            0
        );
        drop(maintenance);
        assert!(DshProcessLease::acquire(root.path(), None).is_ok());
    }

    #[test]
    fn process_lease_proof_keeps_only_a_hash_on_disk_and_rotates_per_launch() {
        let root = tempfile::tempdir().unwrap();
        let first = DshProcessLease::acquire(root.path(), Some("first")).unwrap();
        let second = DshProcessLease::acquire(root.path(), Some("second")).unwrap();
        assert_ne!(first.lease_id(), second.lease_id());
        assert_ne!(first.nonce(), second.nonce());
        let raw = std::fs::read_to_string(
            root.path()
                .join(CONTROL_DIR)
                .join("processes")
                .join(format!("{}.json", first.lease_id())),
        )
        .unwrap();
        let record: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            record["nonceDigest"],
            hex(Sha256::digest(first.nonce().as_bytes()))
        );
        assert!(!raw.contains(first.nonce()));
        assert!(!raw.contains(second.nonce()));
        assert_eq!(record["schemaVersion"], 2);
        assert_eq!(record["bootId"], current_boot_id().unwrap());
        assert_eq!(record["retirementRequired"], true);
        assert_eq!(record["retired"], false);
    }

    #[cfg(unix)]
    fn exited_process_pid() -> u32 {
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        pid
    }

    #[cfg(unix)]
    #[test]
    fn process_lease_same_boot_owner_death_does_not_prove_retirement() {
        let dead_pid = exited_process_pid();
        for started in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let lease = DshProcessLease::acquire(root.path(), Some("crashed-host")).unwrap();
            let mut record: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&lease.0.path).unwrap()).unwrap();
            record["pid"] = dead_pid.into();
            if started {
                record["childPid"] = dead_pid.into();
            }
            std::fs::write(&lease.0.path, record.to_string()).unwrap();
            std::mem::forget(lease); // A crashed host never runs Drop.
            assert!(
                acquire_maintenance(root.path()).is_err(),
                "dead primary PIDs cannot certify descendants or an interrupted pending spawn"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn process_lease_release_after_primary_exit_keeps_unsettled_authority() {
        let root = tempfile::tempdir().unwrap();
        let mut lease = DshProcessLease::acquire(root.path(), None).unwrap();
        let path = lease.0.path.clone();
        lease.update_child_pid(exited_process_pid()).unwrap();
        lease.release_after_exit();
        assert!(path.exists(), "primary exit alone must retain the lease");
        assert!(acquire_maintenance(root.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn process_lease_verified_previous_boot_can_be_recovered() {
        let root = tempfile::tempdir().unwrap();
        let directory = control_directory(root.path(), "processes").unwrap();
        std::fs::write(
            directory.join("previous-boot.json"),
            serde_json::json!({
                "schemaVersion": 2, "pid": std::process::id(),
                "bootId": uuid::Uuid::new_v4().to_string(),
                "retirementRequired": true, "retired": false
            })
            .to_string(),
        )
        .unwrap();
        assert!(
            acquire_maintenance(root.path()).is_ok(),
            "verified previous-boot records cannot own a process in this boot"
        );
    }

    #[cfg(unix)]
    #[test]
    fn process_lease_retirement_claim_is_unsupported_and_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let directory = control_directory(root.path(), "processes").unwrap();
        std::fs::write(
            directory.join("unproved-retirement.json"),
            serde_json::json!({
                "schemaVersion": 2, "pid": exited_process_pid(),
                "bootId": current_boot_id().unwrap(),
                "retirementRequired": true, "retired": true
            })
            .to_string(),
        )
        .unwrap();
        assert!(
            acquire_maintenance(root.path()).is_err(),
            "this host has no complete-tree retirement proof protocol"
        );
    }

    #[test]
    fn process_lease_pending_abort_removes_only_its_own_record() {
        let root = tempfile::tempdir().unwrap();
        let first = DshProcessLease::acquire(root.path(), Some("cancelled")).unwrap();
        let second = DshProcessLease::acquire(root.path(), Some("pending")).unwrap();
        let first_path = first.0.path.clone();
        let second_path = second.0.path.clone();
        drop(first);
        assert!(!first_path.exists());
        assert!(second_path.exists());
        assert!(acquire_maintenance(root.path()).is_err());
        drop(second);
        assert!(acquire_maintenance(root.path()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn process_lease_legacy_quarantine_survives_old_host_deletion() {
        let root = tempfile::tempdir().unwrap();
        let directory = control_directory(root.path(), "processes").unwrap();
        let legacy = directory.join("old-host.json");
        std::fs::write(
            &legacy,
            serde_json::json!({"schemaVersion": 1, "pid": exited_process_pid()}).to_string(),
        )
        .unwrap();
        assert!(acquire_maintenance(root.path()).is_err());
        std::fs::remove_file(legacy).unwrap();
        assert!(
            acquire_maintenance(root.path()).is_err(),
            "a legacy host's cleanup cannot remove its observed quarantine"
        );
    }

    #[test]
    fn process_lease_observed_record_disappearance_cannot_erase_its_quarantine() {
        let root = tempfile::tempdir().unwrap();
        let directory = control_directory(root.path(), "processes").unwrap();
        let observed = directory.join("observed-before-read.json");
        std::fs::write(&observed, "unknown process record").unwrap();
        let boot = current_boot_id().unwrap();
        let result = inspect_process_record(&directory, &observed, &boot, |path| {
            std::fs::remove_file(path).unwrap();
            read_ownership_record(path, "processes")
        });
        assert!(result.is_err());
        assert!(!observed.exists());
        let shadow = legacy_shadow_path(&directory, "observed-before-read.json");
        assert!(
            shadow.exists(),
            "an observed owner must keep its boot guard"
        );
        let quarantine = read_ownership_record(&shadow, "processes").unwrap();
        assert_eq!(quarantine.pid, std::process::id());
        assert_eq!(quarantine.boot_id.as_deref(), Some(boot.as_str()));
        assert_eq!(quarantine.retired, Some(false));
        assert!(acquire_maintenance(root.path()).is_err());

        let mut previous_boot: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&shadow).unwrap()).unwrap();
        previous_boot["bootId"] = uuid::Uuid::new_v4().to_string().into();
        std::fs::write(&shadow, previous_boot.to_string()).unwrap();
        std::fs::write(&observed, "unreadable schema").unwrap();
        assert!(
            inspect_process_record(&directory, &observed, &boot, |path| {
                read_ownership_record(path, "processes")
            })
            .is_err()
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&shadow).unwrap()).unwrap(),
            previous_boot,
            "an unreadable original cannot rebase a verified prior-boot shadow"
        );
        std::fs::remove_file(observed).unwrap();
        assert!(acquire_maintenance(root.path()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn process_lease_invalid_boot_and_retirement_flags_fail_closed() {
        for (key, invalid) in [
            ("schemaVersion", serde_json::json!(3)),
            ("bootId", serde_json::Value::Null),
            ("bootId", serde_json::json!("unknown-boot")),
            ("retirementRequired", serde_json::json!(false)),
            ("retirementRequired", serde_json::Value::Null),
            ("retired", serde_json::json!(true)),
            ("retired", serde_json::Value::Null),
        ] {
            let root = tempfile::tempdir().unwrap();
            let directory = control_directory(root.path(), "processes").unwrap();
            let path = directory.join("invalid-proof.json");
            let mut record = serde_json::json!({
                "schemaVersion": 2, "pid": exited_process_pid(),
                "bootId": uuid::Uuid::new_v4().to_string(),
                "retirementRequired": true, "retired": false
            });
            record[key] = invalid;
            std::fs::write(&path, record.to_string()).unwrap();
            assert!(acquire_maintenance(root.path()).is_err(), "{record}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn process_lease_legacy_quarantine_recovers_only_after_verified_boot_change() {
        let root = tempfile::tempdir().unwrap();
        let directory = control_directory(root.path(), "processes").unwrap();
        let legacy = directory.join("old-host.json");
        std::fs::write(
            &legacy,
            serde_json::json!({"schemaVersion": 1, "pid": exited_process_pid()}).to_string(),
        )
        .unwrap();
        assert!(acquire_maintenance(root.path()).is_err());
        let shadow = legacy_shadow_path(&directory, "old-host.json");
        let mut quarantine: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&shadow).unwrap()).unwrap();
        quarantine["bootId"] = uuid::Uuid::new_v4().to_string().into();
        std::fs::write(&shadow, quarantine.to_string()).unwrap();
        assert!(acquire_maintenance(root.path()).is_ok());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&shadow).unwrap()).unwrap(),
            quarantine,
            "a prior-boot shadow is never overwritten by a later legacy observation"
        );
        std::fs::write(&shadow, "{}").unwrap();
        assert!(acquire_maintenance(root.path()).is_err());
    }

    #[test]
    fn racing_process_and_maintenance_admission_never_both_acquire_authority() {
        for _ in 0..12 {
            let root = tempfile::tempdir().unwrap();
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
            let maintenance = {
                let path = root.path().to_path_buf();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    acquire_maintenance(&path)
                })
            };
            let process = {
                let path = root.path().to_path_buf();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    DshProcessLease::acquire(&path, Some("race"))
                })
            };
            barrier.wait();
            let maintenance = maintenance.join().unwrap();
            let process = process.join().unwrap();
            assert!(!(maintenance.is_ok() && process.is_ok()));
            drop(maintenance);
            drop(process);
            assert!(acquire_maintenance(root.path()).is_ok());
        }
    }

    #[cfg(unix)]
    #[test]
    fn previous_boot_records_are_ignored_but_malformed_records_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let dead_pid = child.id();
        child.wait().unwrap();
        let directory = control_directory(root.path(), "processes").unwrap();
        let dead = directory.join("dead.json");
        std::fs::write(
            &dead,
            serde_json::json!({
                "schemaVersion": 2, "pid": dead_pid, "bootId": uuid::Uuid::new_v4().to_string(),
                "retirementRequired": true, "retired": false
            })
            .to_string(),
        )
        .unwrap();
        assert!(acquire_maintenance(root.path()).is_ok());
        assert!(
            dead.exists(),
            "a different owner never reclaims unique records"
        );
        let malformed = directory.join("malformed.json");
        std::fs::write(&malformed, "{").unwrap();
        assert!(acquire_maintenance(root.path()).is_err());
        std::fs::remove_file(malformed).unwrap();
        std::fs::write(
            &dead,
            serde_json::json!({
                "schemaVersion": 2, "pid": dead_pid, "childPid": std::process::id(),
                "bootId": current_boot_id().unwrap(), "retirementRequired": true, "retired": false
            })
            .to_string(),
        )
        .unwrap();
        assert!(
            acquire_maintenance(root.path()).is_err(),
            "a live child outlives its dead parent owner"
        );
    }

    #[cfg(unix)]
    #[test]
    fn durable_internal_module_links_survive_but_root_and_external_links_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let home = runtime_home(root.path());
        std::fs::create_dir_all(home.join("dsh-home/profiles")).unwrap();
        std::fs::create_dir_all(home.join("node_modules")).unwrap();
        std::os::unix::fs::symlink(
            home.join("node_modules"),
            home.join("dsh-home/profiles/node_modules"),
        )
        .unwrap();
        let (id, staging, manifest) = seed_ready_stage(root.path());
        std::fs::create_dir_all(staging.join("node_modules")).unwrap();
        finalize_install(root.path(), &manifest, &id).unwrap();
        assert!(
            std::fs::symlink_metadata(home.join("dsh-home/profiles/node_modules"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        std::os::unix::fs::symlink(root.path(), home.join("dsh-home/unsafe-link")).unwrap();
        let (id, _, manifest) = seed_ready_stage(root.path());
        assert!(finalize_install(root.path(), &manifest, &id).is_err());
        std::fs::remove_file(home.join("dsh-home/unsafe-link")).unwrap();
        std::os::unix::fs::symlink(root.path(), home.join("sessions")).unwrap();
        assert!(finalize_install(root.path(), &manifest, &id).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_control_roots_cannot_redirect_ownership() {
        let root = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(target.path(), root.path().join(CONTROL_DIR)).unwrap();
        assert!(DshProcessLease::acquire(root.path(), None).is_err());
        assert!(remove_runtime(root.path(), 0).is_err());
        assert_eq!(std::fs::read_dir(target.path()).unwrap().count(), 0);
    }
}
