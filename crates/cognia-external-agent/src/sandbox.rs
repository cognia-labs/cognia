//! Mandatory sandbox wrapper for the **desktop** external-agent spawn path.
//!
//! ADR-0077 states that Cognia "never falls back to an unsandboxed process",
//! and ADR-0119 restates it for Pi. Until this module existed that guarantee
//! held only on the CLI host: `cli/src/runtime/external/sandbox-launcher.ts`
//! rewrites every spawn into `cognia-external-agent-launcher … -- <command>`,
//! while the Tauri command called [`crate::exec_backend::spawn_with_events`]
//! directly — no launcher, no policy, inherited env.
//!
//! The gap was not a caller-trust question. `SpawnPolicy`'s own docstring
//! reasons that "on the desktop the surface never existed (the WebView calls
//! the Tauri command locally)", which is true of *who asks for* the spawn and
//! irrelevant to *what the spawned agent then does*: the agent is the untrusted
//! party, it runs a model, and that model has `bash`.
//!
//! This module is the Rust port of the TypeScript launcher wrapper. The two are
//! deliberately duplicated rather than shared — the desktop cannot call into
//! the CLI's Node code. Both read each engine's state roots from the same
//! generated launch table ([`crate::launch_descriptor`]), so a root cannot be
//! present in one and missing from the other.
//!
//! What this module does NOT do is confine the working directory to the
//! workspaces root the way [`crate::presets::SpawnPolicy`] does. That
//! confinement exists because a *remote* client picks the headless cwd; on the
//! desktop the cwd comes from `agent.config.process.cwd`, a path the local user
//! typed into settings. Desktop confinement is instead enforced by the
//! launcher's own `--cwd` / `--writable` scope, which is the same mechanism the
//! CLI relies on.

use std::path::{Path, PathBuf};

use super::launch_descriptor::{state_file_roots, state_writable_roots};
use super::process::{ExternalAgentSpawnConfig, ExternalAgentSandboxPolicy, SandboxNetworkMode, SandboxReadableScope};

/// Explicit launcher override. Same variable the CLI honours, so a developer
/// pointing one host at a freshly built launcher points both.
pub const LAUNCHER_ENV: &str = "COGNIA_EXTERNAL_AGENT_LAUNCHER";

/// Why a spawn was refused. Every variant is a refusal — there is no variant
/// that means "continue unsandboxed", which is the point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxError {
    /// Not macOS or Linux: no Seatbelt, no bubblewrap, no sandbox.
    UnsupportedPlatform(String),
    /// The launcher binary is missing or not executable.
    LauncherUnavailable(String),
    /// The launcher needs a concrete directory to scope the sandbox to.
    MissingCwd,
    /// No home directory to derive agent state roots from.
    MissingHome,
    InvalidPolicy(String),
    /// An engine's relocated state root is empty, unscopable, or leaves the
    /// launch's own state ([`crate::launch_descriptor::relocated_state`]).
    InvalidStateRoot(String),
    /// The configuration asked for a private state root
    /// ([`crate::state_isolation`]) and it could not be provided. Refusing is
    /// the only safe answer: launching anyway would hand the agent the user's
    /// own login.
    StateIsolation(String),
}

impl SandboxError {
    /// Stable reason code for the renderer, matching the one ADR-0119 names.
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::StateIsolation(_) => "state_isolation_failed",
            _ => "sandbox_unavailable",
        }
    }
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedPlatform(os) => write!(
                f,
                "External agents are not available on {os}: they require a strict sandbox \
                 (macOS Seatbelt or Linux bubblewrap), and Cognia never runs them unsandboxed."
            ),
            Self::LauncherUnavailable(command) => write!(
                f,
                "Can't launch \"{command}\": the external-agent sandbox launcher is unavailable. \
                 Cognia only runs external agents inside a strict sandbox and never falls back to \
                 an unsandboxed process. Reinstall the desktop app, or point \
                 {LAUNCHER_ENV} at a built launcher."
            ),
            Self::MissingCwd => write!(
                f,
                "The external-agent sandbox requires a working directory; set one on the agent \
                 before starting a session."
            ),
            Self::InvalidPolicy(reason) => write!(f, "Invalid external-agent sandbox policy: {reason}"),
            Self::InvalidStateRoot(reason) => write!(f, "{reason}"),
            Self::MissingHome => write!(
                f,
                "The external-agent sandbox could not determine this user's home directory."
            ),
            Self::StateIsolation(reason) => write!(
                f,
                "This agent configuration uses its own isolated state, which could not be \
                 prepared: {reason}"
            ),
        }
    }
}

impl std::error::Error for SandboxError {}

/// Can this platform host external agents at all? Fails closed off macOS/Linux.
///
/// Takes the OS as a parameter rather than reading `cfg!` so every branch is
/// reachable from a test on any host.
pub fn sandbox_supports_os(os: &str) -> bool {
    matches!(os, "macos" | "linux")
}

/// Platform-correct launcher filename.
pub fn launcher_file_name(os: &str) -> &'static str {
    if os == "windows" {
        "cognia-external-agent-launcher.exe"
    } else {
        "cognia-external-agent-launcher"
    }
}

/// Strip a Windows executable suffix and lower-case, matching the CLI's
/// `command.toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "")`.
pub(crate) fn base_command(command: &str) -> String {
    let lower = command.trim().to_ascii_lowercase();
    for suffix in [".exe", ".cmd", ".bat"] {
        if let Some(stripped) = lower.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }
    lower
}

/// Host-owned hint transported through the existing spawn configuration.
/// It is consumed here and never reaches the external agent's environment.
pub const EXTRA_WRITABLE_ROOTS_ENV: &str = "COGNIA_AGENT_WRITABLE_ROOTS";
pub const EXTRA_WRITABLE_CEILING_ENV: &str = "COGNIA_AGENT_WRITABLE_CEILING";

/// Recheck explicit Codex roots against the native filesystem floor. Invalid
/// entries are dropped with a reason, including symlink aliases of deny roots.
pub fn extra_writable_roots(config: &ExternalAgentSpawnConfig) -> Vec<PathBuf> {
    let Some(raw) = config.env.get(EXTRA_WRITABLE_ROOTS_ENV) else {
        return Vec::new();
    };
    if !crate::launch_descriptor::accepts_extra_writable_roots(&config.command, &config.args) {
        log::warn!("[sandbox] ignoring extra writable roots for {}", config.command);
        return Vec::new();
    }
    let entries = match serde_json::from_str::<Vec<String>>(raw) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!("[sandbox] ignoring malformed Codex writable roots: {error}");
            return Vec::new();
        }
    };
    let ceiling = match config.env.get(EXTRA_WRITABLE_CEILING_ENV) {
        None => None,
        Some(raw) => match serde_json::from_str::<Vec<PathBuf>>(raw).ok()
            .and_then(|roots| cognia_exec_sandbox::paths::safe_canonicalize_all(&roots).ok()) {
            Some(roots) => Some(roots),
            None => {
                log::warn!("[sandbox] ignoring Codex writable roots: invalid session writable ceiling");
                return Vec::new();
            }
        },
    };
    let mut forbidden = cognia_exec_sandbox::protected::system_forbidden_roots();
    if let Some(data) = crate::state_isolation::host_agent_state_data_dir() {
        forbidden.push(data.join("cognia"));
    }
    let resolved: Vec<PathBuf> = forbidden.iter()
        .filter_map(|root| cognia_exec_sandbox::paths::safe_canonicalize(root).ok())
        .collect();
    forbidden.extend(resolved);
    let mut accepted = Vec::new();
    for entry in entries {
        match cognia_exec_sandbox::paths::safe_canonicalize(Path::new(&entry)) {
            Ok(root) if !cognia_exec_sandbox::protected::is_forbidden_writable(&root, &forbidden)
                && ceiling.as_ref().is_none_or(|roots| roots.iter().any(|ceiling| root.starts_with(ceiling))) => {
                if !accepted.contains(&root) {
                    accepted.push(root);
                }
            }
            Ok(_) => log::warn!("[sandbox] dropping Codex writable root {entry:?}: forbidden system/app-data root or outside the canonical session writable ceiling"),
            Err(error) => log::warn!("[sandbox] dropping Codex writable root {entry:?}: {error}"),
        }
    }
    accepted
}

/// Narrow host directory exposed inside the sandbox for the tool-host socket.
///
/// Port of `toolHostRuntimeDir` (cli/src/agent/tool-host/protocol.ts). Linux
/// mounts `/tmp` as a private tmpfs inside the sandbox, so a broker socket in
/// the temp root would be unreachable; binding this one directory keeps the
/// rest of the host temp tree hidden. Stage 2 puts a socket here on desktop.
pub fn tool_host_runtime_dir(temp_root: &Path, uid: Option<u32>) -> PathBuf {
    let suffix = uid
        .map(|value| value.to_string())
        .unwrap_or_else(|| "user".to_string());
    temp_root.join(format!("cognia-toolhost-{suffix}"))
}

/// Build the launcher argv.
///
/// Shape is fixed by `crates/cognia-exec-sandbox/src/bin/cognia-external-agent-launcher.rs`:
/// `--cwd <dir> (--writable <root>)* (--readable <root>)* [--network] -- <command> <args…>`.
pub fn build_sandbox_launcher_args(
    command: &str,
    args: &[String],
    cwd: &str,
    home: &Path,
    tool_host_dir: &Path,
) -> Vec<String> {
    build_sandbox_launcher_args_with_policy(command, args, cwd, home, tool_host_dir, &Default::default())
}

pub fn build_sandbox_launcher_args_with_policy(
    command: &str,
    args: &[String],
    cwd: &str,
    home: &Path,
    tool_host_dir: &Path,
    policy: &ExternalAgentSandboxPolicy,
) -> Vec<String> {
    let mut writable = vec![PathBuf::from(cwd)];
    writable.extend(state_writable_roots(command, args, home));
    writable.push(tool_host_dir.to_path_buf());

    let mut out = vec!["--cwd".to_string(), cwd.to_string()];
    for root in &writable {
        out.push("--writable".to_string());
        out.push(root.to_string_lossy().into_owned());
    }
    if policy.readable_scope == SandboxReadableScope::Workspace {
        out.push("--workspace-readable".into());
        for root in workspace_toolchain_readable_roots(command, home) {
            out.extend(["--readable".into(), root.to_string_lossy().into_owned()]);
        }
    } else {
        out.extend(["--readable".into(), home.to_string_lossy().into_owned()]);
    }
    for file in crate::launch_descriptor::hidden_files(command, args, Path::new(cwd), home) {
        out.push("--deny-readable".into());
        out.push(file.to_string_lossy().into_owned());
    }
    out.extend(sandbox_network_args(policy));
    out.push("--".to_string());
    out.push(command.to_string());
    out.extend(args.iter().cloned());
    out
}

/// Policy flags are deliberately independent of platform and bot isolation.
fn sandbox_network_args(policy: &ExternalAgentSandboxPolicy) -> Vec<String> {
    match policy.network {
        SandboxNetworkMode::Full => vec!["--network".into()],
        SandboxNetworkMode::Off => vec![],
        SandboxNetworkMode::Allowlist => policy.allowed_hosts.iter()
            .flat_map(|host| ["--network-allow".into(), host.clone()]).collect(),
    }
}

/// Resolve the actual executable and its install prefix, without opening home.
/// System loader roots are supplied by LaunchScope; state/workspace roots are writable.
fn workspace_toolchain_readable_roots(command: &str, home: &Path) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = [".local/bin", ".cargo/bin", ".rustup/toolchains", ".gitconfig", ".config/git"]
        .iter().map(|relative| home.join(relative)).collect();
    if base_command(command) == "npx" { roots.push(home.join(".npm")); }
    let canonical_home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let broad_roots = [home.to_path_buf(), home.join(".local"), home.join(".cargo"),
        canonical_home.clone(), canonical_home.join(".local"), canonical_home.join(".cargo")];
    // npm/native wrappers may depend on Node even when the selected command is a script.
    for binary in [command, "node"] {
        if let Some(found) = super::command_resolver::resolve_command_path(binary) {
            for executable in [Some(found.clone()), std::fs::canonicalize(&found).ok()].into_iter().flatten() {
                if let Some(parent) = executable.parent() {
                    let prefix = executable.ancestors().find(|dir| dir.file_name().is_some_and(|name| name == "node_modules"))
                        .or_else(|| if parent.file_name().is_some_and(|name| name == "bin") { parent.parent() } else { Some(parent) });
                    let prefix = prefix.map(|prefix| if broad_roots.iter().any(|root| root == prefix) { parent } else { prefix });
                    if let Some(prefix) = prefix.filter(|prefix| *prefix != home && *prefix != Path::new("/")) {
                        if !roots.iter().any(|root| root == prefix) { roots.push(prefix.to_path_buf()); }
                    }
                }
            }
        }
    }
    roots
}

/// Env key naming plugin Pi package directories (JSON array of absolute paths)
/// that a Pi session must be able to read. Set by the renderer's Pi adapter
/// (`PI_PACKAGE_ROOTS_ENV` in `pi-rpc-client.ts`, ADR-0210).
///
/// The value is a REQUEST, never a grant: it rides the reviewed
/// `COGNIA_TOOLHOST_` prefix, so anything that can set a spawn env could name
/// any path here. [`pi_package_readable_roots`] therefore keeps only entries
/// that resolve to an existing directory nested under the plugin install root
/// the HOST derives (never the renderer), and the remote spawn policy drops
/// the key outright (`SpawnPolicy::validate`).
pub const PI_PACKAGE_ROOTS_ENV: &str = "COGNIA_TOOLHOST_PI_PACKAGE_ROOTS";

/// Where the desktop app installs plugins: `<data dir>/cognia/plugins`, the
/// directory `src-tauri/src/lib.rs` hands `PluginRuntimeState`
/// (`dirs::data_dir()`): `~/Library/Application Support` on macOS,
/// `$XDG_DATA_HOME` (when absolute) or `~/.local/share` on Linux. Pure, so the
/// rule is testable without touching the developer's home.
pub fn desktop_plugin_install_root(
    os: &str,
    home: Option<&Path>,
    xdg_data_home: Option<&Path>,
) -> Option<PathBuf> {
    // Only the sandboxed platforms mount plugin packages at all.
    if !sandbox_supports_os(os) {
        return None;
    }
    let data_dir = crate::state_isolation::agent_state_data_dir(os, home, xdg_data_home, None)?;
    Some(data_dir.join("cognia").join("plugins"))
}

/// Every spelling of the host's forbidden readable roots: the literal list
/// plus its canonical form (`/var` → `/private/var`, `/tmp` → `/private/tmp`
/// on macOS), so a canonicalized candidate cannot slip past a textual match.
fn forbidden_readable_spellings() -> Vec<PathBuf> {
    let mut roots = cognia_exec_sandbox::protected::forbidden_readable_roots();
    #[cfg(unix)]
    for extra in ["/private/var", "/private/tmp", "/private/etc"] {
        roots.push(PathBuf::from(extra));
    }
    let canonical: Vec<PathBuf> = roots
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect();
    roots.extend(canonical);
    roots
}

/// Read-only roots for plugin Pi packages, validated so the list can only ever
/// NARROWLY add reads. An entry survives only when ALL of these hold:
///
///   - the command is Pi (the same base-name rule as the state roots);
///   - it canonicalizes (symlinks resolved) to an existing directory;
///   - that directory is strictly nested under `plugin_install_root`, the
///     host-derived plugin store (itself canonicalized) — so the app store's
///     other contents, the home directory and every system path are out;
///   - the part below the plugin store names no protected entry (`.ssh`,
///     `.git`, keychains, …);
///   - it is not, and is not under or above, a forbidden readable root
///     (`/var`, `/run`, `/tmp`, … in every spelling);
///   - it is not nested under any `--deny-readable` root the wrapper emits
///     (Bot-isolated home, gateway-task deny list, the task-home parent): the
///     launcher re-opens a readable nested under a deny, so emitting one would
///     undo that deny;
///   - it is not, and is not under or above, a `--writable` root the wrapper
///     emits. Validation canonicalizes HERE and the launcher binds by PATH
///     later (`--ro-bind-try <path>` under bubblewrap), so a directory the
///     agent can write is one a sandboxed agent could swap for a symlink
///     between this check and a sibling spawn's bind. Refusing every overlap
///     with a writable root closes that window without changing the launcher.
///     (The stronger option is binding an `O_PATH | O_NOFOLLOW` descriptor
///     with bubblewrap's `--ro-bind-fd`, which the launcher does not do today.)
///
/// A Bot-isolated spawn (`COGNIA_BOT_ISOLATION=1`) gets no package roots at
/// all — whatever the plugin store's location, even outside the hidden home
/// (`XDG_DATA_HOME`) — matching ADR-0210 and the adapter's `bot-isolation`
/// refusal.
///
/// Every dropped entry, and an unparseable value, is logged with its reason.
pub fn pi_package_readable_roots(
    config: &ExternalAgentSpawnConfig,
    plugin_install_root: Option<&Path>,
    deny_roots: &[PathBuf],
    writable_roots: &[PathBuf],
) -> Vec<PathBuf> {
    let Some(raw) = config.env.get(PI_PACKAGE_ROOTS_ENV) else {
        return Vec::new();
    };
    if config.env.get("COGNIA_BOT_ISOLATION").map(String::as_str) == Some("1") {
        log::warn!("[sandbox] ignoring {PI_PACKAGE_ROOTS_ENV} on a Bot-isolated spawn");
        return Vec::new();
    }
    if !crate::launch_descriptor::takes_pi_packages(&config.command, &config.args) {
        log::warn!(
            "[sandbox] ignoring {PI_PACKAGE_ROOTS_ENV} on a non-Pi spawn ({})",
            config.command
        );
        return Vec::new();
    }
    let entries = match serde_json::from_str::<Vec<String>>(raw) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!("[sandbox] ignoring malformed {PI_PACKAGE_ROOTS_ENV}: {error}");
            return Vec::new();
        }
    };
    let Some(store) = plugin_install_root.and_then(|root| std::fs::canonicalize(root).ok()) else {
        if !entries.is_empty() {
            log::warn!(
                "[sandbox] ignoring {PI_PACKAGE_ROOTS_ENV}: the plugin install root is unknown \
                 or does not exist on this host"
            );
        }
        return Vec::new();
    };
    let forbidden = forbidden_readable_spellings();
    let mut denies: Vec<PathBuf> = deny_roots.to_vec();
    denies.extend(
        deny_roots
            .iter()
            .filter_map(|deny| std::fs::canonicalize(deny).ok()),
    );
    let mut writables: Vec<PathBuf> = writable_roots.to_vec();
    writables.extend(
        writable_roots
            .iter()
            .filter_map(|root| std::fs::canonicalize(root).ok()),
    );

    let mut roots: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let reject = |reason: &str| {
            log::warn!("[sandbox] dropping Pi package root {entry:?}: {reason}");
        };
        let requested = PathBuf::from(&entry);
        if !requested.is_absolute() {
            reject("not an absolute path");
            continue;
        }
        let canonical = match std::fs::canonicalize(&requested) {
            Ok(path) => path,
            Err(_) => {
                reject("does not resolve");
                continue;
            }
        };
        if !canonical.is_dir() {
            reject("not a directory");
            continue;
        }
        let Ok(below_store) = canonical.strip_prefix(&store) else {
            reject("not inside the plugin install root");
            continue;
        };
        if below_store.as_os_str().is_empty() {
            reject("is the plugin install root itself");
            continue;
        }
        if cognia_exec_sandbox::protected::is_protected_anywhere(below_store) {
            reject("names a protected path");
            continue;
        }
        if cognia_exec_sandbox::protected::is_forbidden_readable(&canonical, &forbidden) {
            reject("is a forbidden readable root");
            continue;
        }
        if denies.iter().any(|deny| canonical.starts_with(deny)) {
            reject("is under a root this sandbox denies");
            continue;
        }
        if writables
            .iter()
            .any(|writable| canonical.starts_with(writable) || writable.starts_with(&canonical))
        {
            reject("overlaps a root this sandbox can write");
            continue;
        }
        if !roots.contains(&canonical) {
            roots.push(canonical);
        }
    }
    roots
}

/// Host facts the wrapper needs. A trait so tests can drive every branch
/// (unsupported platform, missing launcher, file-vs-dir state roots) without
/// touching the real filesystem or the developer's home directory.
pub trait SandboxHost {
    fn os(&self) -> &str;
    fn home(&self) -> Option<PathBuf>;
    fn temp_dir(&self) -> PathBuf;
    fn uid(&self) -> Option<u32>;
    fn launcher_candidates(&self) -> Vec<PathBuf>;
    fn is_executable(&self, candidate: &Path) -> bool;
    fn ensure_dir(&self, candidate: &Path);
    fn ensure_file(&self, candidate: &Path);
    /// The host-derived plugin install root (see
    /// [`desktop_plugin_install_root`]); `None` when unknown, which disables
    /// plugin Pi package mounts entirely.
    fn plugin_install_root(&self) -> Option<PathBuf> {
        None
    }
    /// The per-user data directory configuration state roots live under
    /// (see [`crate::state_isolation::agent_state_data_dir`]); `None` when
    /// unknown, which refuses every isolated launch.
    fn agent_state_data_dir(&self) -> Option<PathBuf> {
        None
    }
    /// This host's live upstream proxy policy for an allowlisted launch's
    /// filtering proxy (see [`cognia_exec_sandbox::net_proxy::UPSTREAM_POLICY_ENV`]).
    /// `Ok(None)` lets the launcher derive one from the agent's environment;
    /// `Err` (a blocked policy) refuses the launch.
    fn upstream_proxy_policy(&self) -> Result<Option<String>, String> {
        cognia_exec_sandbox::net_proxy::host_upstream_policy()
    }
}

/// The real desktop host.
pub struct DesktopSandboxHost;

impl DesktopSandboxHost {
    fn current_os() -> &'static str {
        if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else {
            "unsupported"
        }
    }
}

impl SandboxHost for DesktopSandboxHost {
    fn os(&self) -> &str {
        Self::current_os()
    }

    fn home(&self) -> Option<PathBuf> {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
    }

    fn temp_dir(&self) -> PathBuf {
        std::env::temp_dir()
    }

    fn agent_state_data_dir(&self) -> Option<PathBuf> {
        let env_path = |name: &str| {
            std::env::var_os(name)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        crate::state_isolation::agent_state_data_dir(
            self.os(),
            self.home().as_deref(),
            env_path("XDG_DATA_HOME").as_deref(),
            env_path("APPDATA").as_deref(),
        )
    }

    fn plugin_install_root(&self) -> Option<PathBuf> {
        desktop_plugin_install_root(
            self.os(),
            self.home().as_deref(),
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .as_deref(),
        )
    }

    #[cfg(unix)]
    fn uid(&self) -> Option<u32> {
        // SAFETY: `getuid` takes no arguments, cannot fail, and touches no
        // memory we own.
        Some(unsafe { libc::getuid() })
    }

    #[cfg(not(unix))]
    fn uid(&self) -> Option<u32> {
        None
    }

    /// Mirrors `resolve_server_binary` in `src-tauri/src/terminal_host_bridge.rs`:
    /// the packaged sidecar lands next to the app executable, and a repo
    /// checkout falls back to the shared `target/` directory.
    fn launcher_candidates(&self) -> Vec<PathBuf> {
        let name = launcher_file_name(self.os());
        let mut candidates = Vec::new();
        if let Some(explicit) = std::env::var_os(LAUNCHER_ENV) {
            let path = PathBuf::from(explicit);
            if !path.as_os_str().is_empty() {
                candidates.push(path);
            }
        }
        if let Ok(current) = std::env::current_exe() {
            if let Some(parent) = current.parent() {
                candidates.push(parent.join(name));
            }
        }
        if let Some(root) = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|crates| crates.parent())
        {
            candidates.push(root.join("target").join("release").join(name));
            candidates.push(root.join("target").join("debug").join(name));
        }
        candidates
    }

    #[cfg(unix)]
    fn is_executable(&self, candidate: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(candidate)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    #[cfg(not(unix))]
    fn is_executable(&self, candidate: &Path) -> bool {
        candidate.is_file()
    }

    fn ensure_dir(&self, candidate: &Path) {
        let _ = std::fs::create_dir_all(candidate);
    }

    fn ensure_file(&self, candidate: &Path) {
        if candidate.exists() {
            return;
        }
        if let Some(parent) = candidate.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(candidate);
    }
}

/// Find the first executable launcher among the candidates.
///
/// Separate from [`wrap_with_sandbox`] so a readiness probe can report whether
/// the desktop can sandbox at all WITHOUT attempting a spawn.
pub fn find_sandbox_launcher(host: &dyn SandboxHost) -> Option<PathBuf> {
    host.launcher_candidates()
        .into_iter()
        .find(|candidate| host.is_executable(candidate))
}

/// Remove every `--writable <root>` pair naming exactly `root`.
fn drop_writable(args: &mut Vec<String>, root: &Path) {
    let root = root.to_string_lossy();
    while let Some(index) = args
        .windows(2)
        .position(|pair| pair[0] == "--writable" && pair[1] == root)
    {
        args.drain(index..index + 2);
    }
}

/// Whether the desktop's OS sandbox launcher wraps `config` before it is
/// handed to a backend.
///
/// A spawn with a runtime environment placement on a backend that routes
/// sandboxes runs in its container (local or remote, ADR-0182/0221), the
/// stronger confinement of the two; wrapping it as well would hand the
/// container a launcher the agent bundle has no entry for. Every other spawn
/// — including a placement on a desktop with no router, which falls back to
/// this host — runs here, so it is wrapped.
pub fn desktop_wrapper_applies(config: &ExternalAgentSpawnConfig, routes_sandboxes: bool) -> bool {
    config.sandbox.is_none() || !routes_sandboxes
}

/// The desktop's spawn hardening after the command allowlist: wrap the launch
/// unless the router will place it (see [`desktop_wrapper_applies`]). A
/// routed spawn keeps its state key: the router strips it for the sandbox and
/// [`desktop_fallback_confinement`] resolves it if the spawn falls back here.
pub fn harden_desktop_spawn(
    config: ExternalAgentSpawnConfig,
    routes_sandboxes: bool,
) -> Result<ExternalAgentSpawnConfig, String> {
    if desktop_wrapper_applies(&config, routes_sandboxes) {
        wrap_with_sandbox(config, &DesktopSandboxHost).map_err(|error| error.to_string())
    } else {
        Ok(config)
    }
}

/// What the desktop's sandbox router runs a fallback through: the same
/// launcher wrap an ordinary desktop spawn gets.
pub fn desktop_fallback_confinement() -> crate::sandbox_routing_backend::FallbackConfinement {
    std::sync::Arc::new(|config| {
        wrap_with_sandbox(config, &DesktopSandboxHost).map_err(|error| error.to_string())
    })
}

/// The command allowlist has already admitted these managed launcher paths.
/// Grant runtime code only for reading, and only the two owned state trees for writing.
fn managed_dsh_sandbox_roots(
    config: &ExternalAgentSpawnConfig,
) -> Result<Option<(PathBuf, [PathBuf; 2])>, SandboxError> {
    let Some(raw_root) = config.env.get("COGNIA_DSH_RUNTIME_HOME") else {
        return Ok(None);
    };
    let invalid = || SandboxError::InvalidPolicy("Invalid managed DeepSeek Harness state paths".into());
    let root = Path::new(raw_root).canonicalize().map_err(|_| invalid())?;
    if Path::new(&config.command).file_name().and_then(|s| s.to_str()) != Some("node")
        || config.args.len() != 2
        || Path::new(&config.args[0]).canonicalize().map_err(|_| invalid())? != root.join("launcher.mjs")
        || !["host.sdk-readonly.yml", "host.sdk-workspace.yml", "host.acp.yml"]
            .iter().any(|name| Path::new(&config.args[1]).canonicalize().ok() == Some(root.join(name)))
    {
        return Err(invalid());
    }
    let state = [root.join("dsh-home"), root.join("sessions")];
    for (key, expected) in ["DSH_HOME", "COGNIA_DSH_SESSION_ROOT"].into_iter().zip(&state) {
        let name = expected.file_name().ok_or_else(invalid)?;
        let requested = config.env.get(key).ok_or_else(invalid)?;
        // Check before creation, then reject a symlink escape after resolution.
        if Path::new(requested) != expected.as_path() && Path::new(requested) != Path::new(raw_root).join(name) {
            return Err(invalid());
        }
        std::fs::create_dir_all(expected).map_err(|_| invalid())?;
        let canonical = expected.canonicalize().map_err(|_| invalid())?;
        if canonical != *expected {
            return Err(invalid());
        }
    }
    Ok(Some((root, state)))
}

/// Rewrite a validated spawn config so the agent runs under the launcher.
///
/// Call this **after** the command allowlist has run: the allowlist requires a
/// bare binary name, and this replaces `command` with the launcher's absolute
/// path. Doing it the other way round would either reject the launcher or
/// admit an arbitrary path as the agent binary.
///
/// A configuration with a private state root (`COGNIA_AGENT_STATE_KEY`, see
/// [`crate::state_isolation`]) is resolved here too, before the Kimi / Cline /
/// Qoder roots are read: the isolated home lands in their env variables, so
/// those rebasings scope the launch to it. The root is granted writable, the
/// runtime's shared default roots leave the writable set and are denied
/// reading.
pub fn wrap_with_sandbox(
    config: ExternalAgentSpawnConfig,
    host: &dyn SandboxHost,
) -> Result<ExternalAgentSpawnConfig, SandboxError> {
    if !sandbox_supports_os(host.os()) {
        return Err(SandboxError::UnsupportedPlatform(host.os().to_string()));
    }
    let launcher = find_sandbox_launcher(host)
        .ok_or_else(|| SandboxError::LauncherUnavailable(config.command.clone()))?;
    let host_home = host.home().ok_or(SandboxError::MissingHome)?;
    let home = crate::gateway_task::task_home(&config.env, &host_home)
        .map_err(|_| SandboxError::MissingHome)?
        .unwrap_or_else(|| host_home.clone());
    let cwd = config
        .cwd
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or(SandboxError::MissingCwd)?;

    let mut config = config;
    crate::dsh_runtime::normalize_managed_launch(&mut config).map_err(SandboxError::InvalidPolicy)?;
    crate::launch_descriptor::apply_platform_args(&config.command, &mut config.args, host.os());
    config.sandbox_policy.validate().map_err(SandboxError::InvalidPolicy)?;
    let bot_isolation = config.env.get("COGNIA_BOT_ISOLATION").map(String::as_str) == Some("1");
    crate::launch_descriptor::check_private_launch(&config.command, &config.args, bot_isolation)
        .map_err(SandboxError::StateIsolation)?;
    crate::process::blank_private_credentials(&mut config);
    let native_bridge_root = crate::native_bridge::registered_native_bridge_root(&config.command, &config.args).map_err(SandboxError::InvalidPolicy)?;
    let crush_bridge = native_bridge_root.is_some() && config.args.get(1).map(String::as_str) == Some("--cognia-crush-bridge");
    let hermes_probe_root = crate::native_bridge::hermes_probe_state_root(&config.command, &config.args, &config.env, host.agent_state_data_dir().as_deref()).map_err(SandboxError::InvalidPolicy)?;
    let isolation = if let Some(root) = &hermes_probe_root {
        config.env.remove(crate::state_isolation::AGENT_STATE_KEY_ENV);
        config.env.insert("HERMES_HOME".into(), root.join("hermes").to_string_lossy().into_owned());
        config.sandbox_policy.readable_scope = SandboxReadableScope::Workspace;
        None
    } else {
        crate::state_isolation::apply_state_isolation(&mut config, host.agent_state_data_dir().as_deref(), &host_home).map_err(SandboxError::StateIsolation)?
    };

    let bot_state = config
        .env
        .get("COGNIA_BOT_STATE_DIR")
        .filter(|_| bot_isolation)
        .map(PathBuf::from);
    if bot_isolation && !bot_state.as_deref().is_some_and(Path::is_absolute) {
        return Err(SandboxError::MissingCwd);
    }
    let relocated = crate::launch_descriptor::relocated_state(
        &crate::launch_descriptor::RelocationInput {
            command: &config.command,
            args: &config.args,
            env: &config.env,
            cwd: config.cwd.as_deref(),
            home: &home,
            private_base: bot_state.as_deref(),
            host_env_applies: !config.env.contains_key(crate::gateway_task::PAYLOAD_ENV),
        },
        |key| std::env::var(key).ok(),
    )
    .map_err(SandboxError::InvalidStateRoot)?;
    let tool_host_dir = tool_host_runtime_dir(&host.temp_dir(), host.uid());
    let state_command = if crush_bridge { "crush" } else { config.command.as_str() };
    let file_roots = state_file_roots(state_command, &config.args, &home);
    for root in relocated
        .as_ref()
        .map(|state| state.writable.clone())
        .unwrap_or_else(|| state_writable_roots(state_command, &config.args, &home))
    {
        // An isolated launch must not (re)create the user's own login roots.
        if isolation
            .as_ref()
            .is_some_and(|plan| plan.shared_roots.contains(&root))
        {
            continue;
        }
        if file_roots.contains(&root) {
            host.ensure_file(&root);
        } else {
            host.ensure_dir(&root);
        }
    }
    host.ensure_dir(&tool_host_dir);

    let mut args = if let Some(state) = &bot_state {
        host.ensure_dir(state);
        vec![
            "--cwd".into(),
            cwd.clone(),
            "--writable".into(),
            state.to_string_lossy().into_owned(),
            "--writable".into(),
            tool_host_dir.to_string_lossy().into_owned(),
            "--".into(),
            config.command.clone(),
        ]
        .into_iter()
        .chain(config.args.clone())
        .collect()
    } else {
        build_sandbox_launcher_args_with_policy(&config.command, &config.args, &cwd, &home, &tool_host_dir, &config.sandbox_policy)
    };
    if bot_isolation {
        let separator = args.iter().position(|arg| arg == "--").expect("target separator");
        args.splice(separator..separator, sandbox_network_args(&config.sandbox_policy));
        // The launcher owns env/keychain confinement too. An old launcher
        // rejects this flag instead of silently running with a weaker policy.
        args.splice(
            0..0,
            [
                "--bot-isolation".to_string(),
                "--deny-readable".to_string(),
                host_home.to_string_lossy().into_owned(),
            ],
        );
        let toolchains = [
            ".nvm",
            ".local/bin",
            ".local/share/pnpm",
            ".bun/bin",
            ".cargo/bin",
            ".rustup/toolchains",
            "Library/pnpm",
        ]
        .map(|relative| host_home.join(relative));
        let programs = crate::launch_descriptor::program_roots(&config.command, &config.args, &host_home);
        for root in toolchains.into_iter().chain(programs) {
            args.splice(0..0, ["--readable".to_string(), root.to_string_lossy().into_owned()]);
        }
    }
    if config.env.contains_key(crate::gateway_task::PAYLOAD_ENV) {
        // All runtime state lives under this task root, not the user's roots.
        args.splice(
            0..0,
            [
                "--writable".to_string(),
                home.to_string_lossy().into_owned(),
            ],
        );
        if config.sandbox_policy.readable_scope == SandboxReadableScope::Home {
        args.splice(
            0..0,
            [
                "--readable".to_string(),
                host_home.to_string_lossy().into_owned(),
            ],
        );
        } else {
            for root in workspace_toolchain_readable_roots(&config.command, &host_home) {
                args.splice(0..0, ["--readable".into(), root.to_string_lossy().into_owned()]);
            }
        }
        // Every engine keeps logins and provider settings in its own roots;
        // a task uses its own, and never reads another task's.
        let denied = crate::launch_descriptor::login_roots(&host_home)
            .into_iter()
            .chain([host_home.join(".local/share/cognia-agent-tasks")]);
        for root in denied {
            args.splice(0..0, ["--deny-readable".to_string(), root.to_string_lossy().into_owned()]);
        }
    }

    // A private state root replaces the runtime's shared default roots. Bot
    // and gateway launches never get here with a plan: both own a private
    // home already and `apply_state_isolation` ignores the key for them.
    if let Some(plan) = &isolation {
        for shared in &plan.shared_roots {
            drop_writable(&mut args, shared);
        }
        args.splice(
            0..0,
            [
                "--writable".to_string(),
                plan.root.to_string_lossy().into_owned(),
            ],
        );
        for denied in &plan.deny_readable {
            args.splice(
                0..0,
                [
                    "--deny-readable".to_string(),
                    denied.to_string_lossy().into_owned(),
                ],
            );
        }
    }

    if crush_bridge {
        for root in state_writable_roots("crush", &[], &home) {
            args.splice(0..0, ["--writable".into(), root.to_string_lossy().into_owned()]);
        }
    }
    for root in native_bridge_root.iter().chain(hermes_probe_root.iter()) {
        args.splice(0..0, ["--readable".into(), root.to_string_lossy().into_owned()]);
    }

    for root in extra_writable_roots(&config) {
        args.splice(0..0, ["--writable".to_string(), root.to_string_lossy().into_owned()]);
    }

    // Plugin Pi packages (ADR-0210): each validated package directory is
    // mounted read-only. Computed after every `--deny-readable` above has been
    // emitted, so no package root can re-open a denied subtree.
    let emitted_denies: Vec<PathBuf> = args
        .windows(2)
        .filter(|pair| pair[0] == "--deny-readable")
        .map(|pair| PathBuf::from(&pair[1]))
        .collect();
    let emitted_writables: Vec<PathBuf> = args
        .windows(2)
        .filter(|pair| pair[0] == "--writable")
        .map(|pair| PathBuf::from(&pair[1]))
        .collect();
    let plugin_store = host.plugin_install_root();
    for root in pi_package_readable_roots(
        &config,
        plugin_store.as_deref(),
        &emitted_denies,
        &emitted_writables,
    ) {
        args.splice(
            0..0,
            [
                "--readable".to_string(),
                root.to_string_lossy().into_owned(),
            ],
        );
    }

    let managed_dsh = managed_dsh_sandbox_roots(&config)?;
    if let Some((runtime, state_roots)) = &managed_dsh {
        let data_root = runtime.parent().ok_or_else(|| {
            SandboxError::InvalidPolicy("DSH runtime has no owning data root".into())
        })?;
        let process_leases = crate::dsh_runtime::process_lease_directory(data_root)
            .map_err(SandboxError::InvalidPolicy)?;
        args.splice(
            0..0,
            [
                "--readable".into(),
                process_leases.to_string_lossy().into_owned(),
            ],
        );
        args.splice(0..0, ["--readable".into(), runtime.to_string_lossy().into_owned()]);
        for root in state_roots {
            args.splice(0..0, ["--writable".into(), root.to_string_lossy().into_owned()]);
        }
    }

    let mut env = config.env.clone();
    if crush_bridge {
        // The private socket child stays in an already mounted, short host temp scope.
        for key in ["TMPDIR", "TMP", "TEMP"] { env.insert(key.into(), tool_host_dir.to_string_lossy().into_owned()); }
    }
    let program = super::command_resolver::resolve_command_path(&config.command);
    if let Some(companion) = program
        .as_deref()
        .map(crate::launch_descriptor::companion_for)
        .transpose()
        .map_err(SandboxError::InvalidPolicy)?
        .flatten()
    {
        // The helper belongs to the release it sits beside: launch that
        // release's canonical executable, never a caller-chosen alias.
        let resolved = program
            .expect("a companion was found for a resolved program")
            .canonicalize()
            .map_err(|error| SandboxError::InvalidPolicy(error.to_string()))?;
        let target = args.iter().position(|arg| arg == "--").expect("target separator") + 1;
        args[target] = resolved.to_string_lossy().into_owned();
        env.insert(companion.env.into(), companion.helper.to_string_lossy().into_owned());
    }
    env.remove(EXTRA_WRITABLE_ROOTS_ENV);
    env.remove(EXTRA_WRITABLE_CEILING_ENV);
    // Only this host supplies the upstream policy, never the caller's env.
    env.remove(cognia_exec_sandbox::net_proxy::UPSTREAM_POLICY_ENV);
    if config.sandbox_policy.network == SandboxNetworkMode::Allowlist {
        if let Some(policy) = host
            .upstream_proxy_policy()
            .map_err(SandboxError::InvalidPolicy)?
        {
            let dir = host.temp_dir().join(format!(
                "cognia-upstream-{}",
                host.uid().map(|uid| uid.to_string()).unwrap_or_else(|| "user".into())
            ));
            let path = cognia_exec_sandbox::net_proxy::write_upstream_policy_file(&dir, &policy)
                .map_err(|error| SandboxError::InvalidPolicy(format!("upstream proxy policy: {error}")))?;
            env.insert(
                cognia_exec_sandbox::net_proxy::UPSTREAM_POLICY_ENV.into(),
                path.to_string_lossy().into_owned(),
            );
        }
    }
    if let Some(state) = &relocated {
        // The relocated root replaces the engine's shared state roots.
        for shared in state_writable_roots(&config.command, &config.args, &home) {
            drop_writable(&mut args, &shared);
        }
        host.ensure_dir(&state.root);
        for root in &state.writable {
            host.ensure_dir(root);
            if !bot_isolation {
                args.splice(0..0, ["--writable".into(), root.to_string_lossy().into_owned()]);
            }
        }
        env.extend(state.env.iter().cloned());
    }
    let temp = match &relocated {
        Some(state) => state.temp.clone(),
        None => crate::launch_descriptor::engine_temp(&config.command, &config.args, &config.env, &home, isolation.is_some()),
    };
    if let Some(temp) = temp.filter(|_| !bot_isolation) {
        host.ensure_dir(&temp);
        for key in ["TMPDIR", "TMP", "TEMP"] {
            env.insert(key.into(), temp.to_string_lossy().into_owned());
        }
    }
    if bot_isolation {
        let state = Path::new(&config.env["COGNIA_BOT_STATE_DIR"]);
        for (key, relative) in [
            ("XDG_DATA_HOME", "data"),
            ("XDG_CACHE_HOME", "cache"),
            ("XDG_STATE_HOME", "state"),
            ("TMPDIR", "tmp"),
            ("TMP", "tmp"),
            ("TEMP", "tmp"),
            ("npm_config_cache", "cache/npm"),
            ("npm_config_store_dir", "cache/pnpm-store"),
            ("pnpm_config_store_dir", "cache/pnpm-store"),
            ("pnpm_config_cache_dir", "cache/pnpm"),
        ] {
            let root = state.join(relative);
            host.ensure_dir(&root);
            env.insert(key.into(), root.to_string_lossy().into_owned());
        }
    }
    if env.contains_key(crate::mcp_config_file::PAYLOAD_ENV) {
        env.insert(crate::mcp_config_file::WRAPPED_ENV.into(), "1".into());
    }
    if let Some((runtime, _)) = &managed_dsh {
        let target = args
            .iter()
            .position(|arg| arg == "--")
            .unwrap_or(args.len());
        for pair in args[..target]
            .windows(2)
            .filter(|pair| pair[0] == "--writable")
        {
            crate::dsh_runtime::assert_writable_scope(runtime, Path::new(&pair[1]))
                .map_err(SandboxError::InvalidPolicy)?;
        }
    }
    Ok(ExternalAgentSpawnConfig {
        command: launcher.to_string_lossy().into_owned(),
        args,
        env,
        ..config
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_openclaude_global_configuration_is_prepared_as_a_file() {
        let host = FakeHost::new("macos");
        wrap_with_sandbox(config("openclaude", &[], Some("/workspace")), &host).unwrap();
        assert!(host.files.borrow().contains(&PathBuf::from("/home/dev/.openclaude.json")));
        assert!(!host.dirs.borrow().contains(&PathBuf::from("/home/dev/.openclaude.json")));
    }

    #[test]
    fn additional_native_state_is_separate_and_relocated_without_shared_grants() {
        let home = Path::new("/home/dev");
        assert_eq!(state_writable_roots("openclaude", &[], home), vec![home.join(".openclaude"), home.join(".openclaude.json")]);
        assert!(!state_writable_roots("not-claude", &[], home).contains(&home.join(".claude")));
        for (command, key, shared) in [("openclaude", "OPENCLAUDE_CONFIG_DIR", ".openclaude"), ("vibe-acp", "VIBE_HOME", ".vibe"), ("mimo", "MIMOCODE_HOME", ".local/share/mimocode"), ("hermes", "HERMES_HOME", ".hermes")] {
            let mut cfg = config(command, &[], Some("/workspace"));
            cfg.env.insert(key.into(), "/owned/native".into());
            let wrapped = wrap_with_sandbox(cfg.clone(), &FakeHost::new("macos")).unwrap();
            assert!(!wrapped.args.contains(&home.join(shared).to_string_lossy().into_owned()));
            assert!(wrapped.args.windows(2).any(|pair| pair == ["--writable", "/owned/native"]));
            assert_eq!(wrapped.env.get(key).map(String::as_str), Some("/owned/native"));
            assert_eq!(wrapped.env["TMPDIR"], "/owned/native/tmp");
            cfg.env.insert(key.into(), "".into());
            assert!(matches!(wrap_with_sandbox(cfg, &FakeHost::new("macos")), Err(SandboxError::InvalidStateRoot(_))));
        }
    }

    #[test]
    fn antigravity_grants_only_its_owned_state_and_artifact_subtrees() {
        for command in ["agy_acp_server.par", "agy_acp_server.exe"] {
            assert_eq!(state_writable_roots(command, &[], Path::new("/home/dev")), [
                PathBuf::from("/home/dev/.gemini/antigravity-acp"),
                PathBuf::from("/home/dev/.gemini/artifacts"),
            ]);
        }
        assert!(state_writable_roots("agy", &[], Path::new("/home/dev")).is_empty());
    }


    #[test]
    fn antigravity_bot_wrapper_refuses_even_when_file_storage_is_requested() {
        let host = FakeHost::new("macos");
        let mut request = config("agy_acp_server.par", &[], Some("/work/project"));
        request.env.insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        request.env.insert("AGY_ACP_FORCE_FILE_STORAGE".into(), "1".into());
        let error = wrap_with_sandbox(request, &host).unwrap_err();
        assert_eq!(error.reason_code(), "state_isolation_failed");
        assert!(error.to_string().contains("native keychain accounts are shared"));
        assert!(host.dirs.borrow().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_wrapper_rebinds_the_companion_and_scopes_custom_state() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let server = temp.path().join("agy_acp_server.par");
        let helper = temp.path().join("localharness_external");
        std::fs::write(&server, "server").unwrap();
        std::fs::write(&helper, "helper").unwrap();
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut request = config(server.to_str().unwrap(), &[], Some("/work/project"));
        request.env.insert("ANTIGRAVITY_HARNESS_PATH".into(), "/untrusted/helper".into());
        request.env.insert("GEMINI_HOME".into(), "/work/selected-gemini".into());
        let wrapped = wrap_with_sandbox(request, &FakeHost::new("macos")).unwrap();
        assert_eq!(wrapped.env["ANTIGRAVITY_HARNESS_PATH"], helper.canonicalize().unwrap().to_string_lossy());
        assert_eq!(wrapped.env["GEMINI_HOME"], "/work/selected-gemini");
        let writable = pairs(&wrapped.args, "--writable");
        assert!(writable.contains(&"/work/selected-gemini/antigravity-acp"));
        assert!(writable.contains(&"/work/selected-gemini/artifacts"));
        assert!(!writable.contains(&"/home/dev/.gemini"));
        assert!(!writable.contains(&"/home/dev/.gemini/antigravity-acp"));
        assert!(!writable.contains(&"/work/selected-gemini"));
        let target = wrapped.args.iter().position(|arg| arg == "--").unwrap() + 1;
        assert_eq!(wrapped.args[target], server.canonicalize().unwrap().to_string_lossy());
    }

    #[test]
    fn managed_dsh_grants_only_its_state_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("deepseek-harness");
        std::fs::create_dir_all(&root).unwrap();
        for name in ["launcher.mjs", "host.sdk-readonly.yml"] {
            std::fs::write(root.join(name), "fixture").unwrap();
        }
        let launcher = root.join("launcher.mjs");
        let composition = root.join("host.sdk-readonly.yml");
        let mut request = config("node", &[launcher.to_str().unwrap(), composition.to_str().unwrap()], Some("/work"));
        for (key, path) in [
            ("COGNIA_DSH_RUNTIME_HOME", root.clone()),
            ("DSH_HOME", root.join("dsh-home")),
            ("COGNIA_DSH_SESSION_ROOT", root.join("sessions")),
        ] {
            request.env.insert(key.into(), path.to_string_lossy().into_owned());
        }
        let wrapped = wrap_with_sandbox(request.clone(), &FakeHost::new("macos")).unwrap();
        for name in ["dsh-home", "sessions"] {
            assert!(wrapped.args.windows(2).any(|p| p[0] == "--writable" && Path::new(&p[1]) == root.join(name).canonicalize().unwrap()));
        }
        assert!(!wrapped.args.windows(2).any(|p| p[0] == "--writable" && Path::new(&p[1]) == root.canonicalize().unwrap()));
        let process_leases = temp.path().join(".deepseek-harness-control/processes");
        let control = process_leases.parent().unwrap().canonicalize().unwrap();
        assert!(
            wrapped.args.windows(2).any(|p| p[0] == "--readable"
                && Path::new(&p[1]) == process_leases.canonicalize().unwrap()),
            "the production launcher must read host-owned process authority"
        );
        assert!(!wrapped.args.windows(2).any(|p| {
            let writable = Path::new(&p[1]);
            p[0] == "--writable"
                && (writable.starts_with(&control) || control.starts_with(writable))
        }));
        let mut broad = request.clone();
        broad.cwd = Some(temp.path().to_string_lossy().into_owned());
        assert!(
            wrap_with_sandbox(broad, &FakeHost::new("macos")).is_err(),
            "workspace cannot grant writes to the control directory or runtime code"
        );
        let sibling = temp.path().join("workspaces/project");
        std::fs::create_dir_all(&sibling).unwrap();
        let mut sibling_request = request.clone();
        sibling_request.cwd = Some(sibling.to_string_lossy().into_owned());
        assert!(wrap_with_sandbox(sibling_request, &FakeHost::new("macos")).is_ok());
        let mut untagged = request.clone();
        untagged.env.clear();
        let derived = wrap_with_sandbox(untagged, &FakeHost::new("macos")).unwrap();
        assert_eq!(Path::new(&derived.env["COGNIA_DSH_RUNTIME_HOME"]), root.canonicalize().unwrap());
        assert!(derived.args.windows(2).any(|pair| pair[0] == "--readable" && Path::new(&pair[1]) == process_leases.canonicalize().unwrap()));
        request.env.insert("DSH_HOME".into(), temp.path().to_string_lossy().into_owned());
        assert!(wrap_with_sandbox(request, &FakeHost::new("macos")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn managed_dsh_rejects_state_symlink_escape() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("deepseek-harness");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        for name in ["launcher.mjs", "host.sdk-readonly.yml"] {
            std::fs::write(root.join(name), "fixture").unwrap();
        }
        std::os::unix::fs::symlink(&outside, root.join("dsh-home")).unwrap();
        let launcher = root.join("launcher.mjs");
        let composition = root.join("host.sdk-readonly.yml");
        let mut request = config("node", &[launcher.to_str().unwrap(), composition.to_str().unwrap()], Some("/work"));
        for (key, path) in [
            ("COGNIA_DSH_RUNTIME_HOME", root.clone()),
            ("DSH_HOME", root.join("dsh-home")),
            ("COGNIA_DSH_SESSION_ROOT", root.join("sessions")),
        ] {
            request.env.insert(key.into(), path.to_string_lossy().into_owned());
        }
        assert!(wrap_with_sandbox(request, &FakeHost::new("macos")).is_err());
    }

    /// The desktop wrapper and a container never both apply, and a placement
    /// nothing will route is wrapped because it falls back to this host.
    #[test]
    fn sandbox_policy_modes_platforms_and_bot_isolation() {
        for os in ["macos", "linux", "windows"] {
            for mode in [SandboxNetworkMode::Full, SandboxNetworkMode::Allowlist, SandboxNetworkMode::Off] {
                for bot in [false, true] {
                    for readable_scope in [SandboxReadableScope::Home, SandboxReadableScope::Workspace] {
                        let host = FakeHost::new(os);
                        let mut cfg = config("codex", &[], Some("/work/project"));
                        cfg.sandbox_policy = ExternalAgentSandboxPolicy {
                            network: mode, allowed_hosts: vec!["api.example.com".into(), "*.example.org".into()], readable_scope,
                        };
                        if bot {
                            cfg.env.insert("COGNIA_BOT_ISOLATION".into(), "1".into());
                            cfg.env.insert("COGNIA_BOT_STATE_DIR".into(), "/work/state".into());
                        }
                        let wrapped = wrap_with_sandbox(cfg, &host);
                        if os == "windows" { assert!(matches!(wrapped, Err(SandboxError::UnsupportedPlatform(_)))); continue; }
                        let args = wrapped.unwrap().args;
                        assert_eq!(args.iter().any(|arg| arg == "--network"), mode == SandboxNetworkMode::Full);
                        assert_eq!(args.windows(2).filter(|pair| pair[0] == "--network-allow").count(), if mode == SandboxNetworkMode::Allowlist { 2 } else { 0 });
                        assert_eq!(args.windows(2).any(|pair| pair == ["--readable", "/home/dev"]), !bot && readable_scope == SandboxReadableScope::Home);
                        assert_eq!(args.iter().any(|arg| arg == "--workspace-readable"), !bot && readable_scope == SandboxReadableScope::Workspace);
                        if bot { assert!(args.windows(2).any(|pair| pair == ["--deny-readable", "/home/dev"])); }
                    }
                }
            }
        }
    }

    #[test]
    fn allowlisted_launch_hands_the_host_upstream_policy_through_a_private_file() {
        let temp = tempfile::tempdir().unwrap();
        let policy = r#"{"mode":"manual","host":"proxy.corp","port":3128,"password":"s3cret"}"#;
        let mut host = FakeHost::new("macos");
        host.temp = Some(temp.path().to_path_buf());
        host.upstream = Some(Ok(Some(policy.to_string())));
        let mut cfg = config("codex", &[], Some("/work/project"));
        cfg.sandbox_policy.network = SandboxNetworkMode::Allowlist;
        cfg.sandbox_policy.allowed_hosts = vec!["api.openai.com".into()];
        // A caller can never point the launcher at a policy of its choosing.
        cfg.env.insert(
            cognia_exec_sandbox::net_proxy::UPSTREAM_POLICY_ENV.into(),
            "/tmp/forged.json".into(),
        );
        let wrapped = wrap_with_sandbox(cfg.clone(), &host).unwrap();
        let path = PathBuf::from(&wrapped.env[cognia_exec_sandbox::net_proxy::UPSTREAM_POLICY_ENV]);
        assert!(path.starts_with(temp.path().join("cognia-upstream-501")));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), policy);
        assert!(
            !wrapped.env.values().any(|value| value.contains("s3cret")),
            "the password travels only inside the file"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }

        // Full network starts no proxy, so no policy is handed over, and a
        // caller-supplied variable is still stripped.
        let mut full = cfg.clone();
        full.sandbox_policy.network = SandboxNetworkMode::Full;
        assert!(!wrap_with_sandbox(full, &host)
            .unwrap()
            .env
            .contains_key(cognia_exec_sandbox::net_proxy::UPSTREAM_POLICY_ENV));

        // A blocked host policy refuses the allowlisted launch.
        host.upstream = Some(Err("blocked".into()));
        assert!(matches!(
            wrap_with_sandbox(cfg, &host),
            Err(SandboxError::InvalidPolicy(_))
        ));
    }

    #[test]
    fn sandbox_workspace_keeps_git_toolchain_and_aider_denies() {
        let mut cfg = config("aider", &[], Some("/work/project"));
        cfg.sandbox_policy.readable_scope = SandboxReadableScope::Workspace;
        cfg.sandbox_policy.network = SandboxNetworkMode::Allowlist;
        let args = wrap_with_sandbox(cfg, &FakeHost::new("linux")).unwrap().args;
        for root in ["/home/dev/.gitconfig", "/home/dev/.config/git", "/home/dev/.cargo/bin"] {
            assert!(args.windows(2).any(|pair| pair == ["--readable", root]));
        }
        assert!(args.windows(2).any(|pair| pair == ["--deny-readable", "/home/dev/.aider.conf.yml"]));
        assert!(!args.iter().any(|arg| arg == "--network" || arg == "--network-allow"));
    }

    #[cfg(unix)]
    #[test]
    fn sandbox_workspace_resolves_symlinked_toolchain_without_reading_local_share() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let modules = home.join(".nvm/versions/node/v22/lib/node_modules");
        let executable = modules.join("agent/bin/agent");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let link = bin.join("codex");
        symlink(&executable, &link).unwrap();
        let roots = workspace_toolchain_readable_roots(link.to_str().unwrap(), home);
        assert!(roots.contains(&bin));
        assert!(roots.contains(&std::fs::canonicalize(modules).unwrap()));
        assert!(!roots.contains(&home.join(".local")));
        assert!(!roots.contains(&std::fs::canonicalize(home.join(".local")).unwrap()));
        assert!(!roots.contains(&home.to_path_buf()));
    }

    #[test]
    fn sandbox_invalid_policy_never_prepares_or_launches() {
        let mut cfg = config("codex", &[], Some("/work/project"));
        cfg.sandbox_policy.allowed_hosts = vec!["https://example.com".into()];
        let host = FakeHost::new("macos");
        assert!(matches!(wrap_with_sandbox(cfg, &host), Err(SandboxError::InvalidPolicy(_))));
        assert!(host.dirs.borrow().is_empty());
    }

    #[test]
    fn the_desktop_wrapper_stands_down_only_for_a_routed_placement() {
        let mut config: ExternalAgentSpawnConfig = serde_json::from_value(serde_json::json!({
            "id": "a", "command": "codex", "args": [], "env": {}, "cwd": "/tmp"
        }))
        .unwrap();
        assert!(desktop_wrapper_applies(&config, false));
        assert!(desktop_wrapper_applies(&config, true));
        config.sandbox = Some(crate::sandbox_routing_backend::SandboxPlacement::Container {
            binding: None,
            hosted_tool_host_lease_ids: Vec::new(),
            provider: None,
            workspace: None,
            spec: serde_json::json!({ "specDigest": "a".repeat(64) }),
            isolation_mandatory: false,
        });
        assert!(desktop_wrapper_applies(&config, false));
        assert!(!desktop_wrapper_applies(&config, true));
        let routed = harden_desktop_spawn(config.clone(), true).expect("a routed spawn passes");
        assert_eq!(routed.command, "codex", "a routed spawn is not rewritten");
    }
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeHost {
        os: String,
        home: Option<PathBuf>,
        candidates: Vec<PathBuf>,
        executable: Vec<PathBuf>,
        dirs: RefCell<Vec<PathBuf>>,
        files: RefCell<Vec<PathBuf>>,
        plugin_root: Option<PathBuf>,
        state_data_dir: Option<PathBuf>,
        temp: Option<PathBuf>,
        upstream: Option<Result<Option<String>, String>>,
    }

    impl FakeHost {
        fn new(os: &str) -> Self {
            Self {
                os: os.to_string(),
                home: Some(PathBuf::from("/home/dev")),
                candidates: vec![PathBuf::from("/opt/launcher")],
                executable: vec![PathBuf::from("/opt/launcher")],
                ..Default::default()
            }
        }
    }

    impl SandboxHost for FakeHost {
        fn os(&self) -> &str {
            &self.os
        }
        fn home(&self) -> Option<PathBuf> {
            self.home.clone()
        }
        fn temp_dir(&self) -> PathBuf {
            self.temp.clone().unwrap_or_else(|| PathBuf::from("/tmp"))
        }
        fn uid(&self) -> Option<u32> {
            Some(501)
        }
        fn upstream_proxy_policy(&self) -> Result<Option<String>, String> {
            self.upstream.clone().unwrap_or(Ok(None))
        }
        fn launcher_candidates(&self) -> Vec<PathBuf> {
            self.candidates.clone()
        }
        fn is_executable(&self, candidate: &Path) -> bool {
            self.executable.iter().any(|item| item == candidate)
        }
        fn ensure_dir(&self, candidate: &Path) {
            self.dirs.borrow_mut().push(candidate.to_path_buf());
        }
        fn ensure_file(&self, candidate: &Path) {
            self.files.borrow_mut().push(candidate.to_path_buf());
        }
        fn plugin_install_root(&self) -> Option<PathBuf> {
            self.plugin_root.clone()
        }
        fn agent_state_data_dir(&self) -> Option<PathBuf> {
            self.state_data_dir.clone()
        }
    }

    fn config(command: &str, args: &[&str], cwd: Option<&str>) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: "agent-1".to_string(),
            command: command.to_string(),
            args: args.iter().map(|value| value.to_string()).collect(),
            env: HashMap::new(),
            cwd: cwd.map(|value| value.to_string()),
            framing: Default::default(),
            sandbox_policy: Default::default(),
            sandbox: None,
        }
    }

    #[test]
    fn codex_explicit_writable_roots_reach_wrapper_and_hint_is_consumed() {
        let mut request = config("codex", &["app-server"], Some("/work"));
        request.env.insert(EXTRA_WRITABLE_ROOTS_ENV.into(),
            serde_json::json!(["/work/extra", "relative", "/", "/etc", "/work/extra"]).to_string());
        let wrapped = wrap_with_sandbox(request, &FakeHost::new("macos")).unwrap();
        let roots: Vec<&str> = wrapped.args.windows(2)
            .filter(|pair| pair[0] == "--writable")
            .map(|pair| pair[1].as_str()).collect();
        assert_eq!(roots.iter().filter(|root| **root == "/work/extra").count(), 1);
        assert!(!roots.contains(&"relative"));
        assert!(!roots.contains(&"/"));
        assert!(!roots.contains(&"/etc"));
        assert!(!wrapped.env.contains_key(EXTRA_WRITABLE_ROOTS_ENV));
    }

    #[test]
    fn codex_writable_roots_cannot_name_app_data_or_another_runtime() {
        let mut request = config("codex", &[], Some("/work"));
        let app_data = crate::state_isolation::host_agent_state_data_dir().unwrap().join("cognia");
        request.env.insert(EXTRA_WRITABLE_ROOTS_ENV.into(),
            serde_json::json!([app_data.to_string_lossy()]).to_string());
        assert!(extra_writable_roots(&request).is_empty());
        request.command = "pi".into();
        request.env.insert(EXTRA_WRITABLE_ROOTS_ENV.into(), "[\"/work/extra\"]".into());
        assert!(extra_writable_roots(&request).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn codex_extra_roots_cannot_escape_the_session_ceiling_through_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(workspace.join("inside")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, workspace.join("escape")).unwrap();
        let mut request = config("codex", &[], Some("/work"));
        request.env.insert(EXTRA_WRITABLE_ROOTS_ENV.into(),
            serde_json::json!([workspace.join("inside"), workspace.join("escape")]).to_string());
        request.env.insert(EXTRA_WRITABLE_CEILING_ENV.into(),
            serde_json::json!([workspace]).to_string());
        assert_eq!(extra_writable_roots(&request), vec![std::fs::canonicalize(workspace.join("inside")).unwrap()]);
        let wrapped = wrap_with_sandbox(request, &FakeHost::new("macos")).unwrap();
        assert!(!wrapped.env.contains_key(EXTRA_WRITABLE_CEILING_ENV));
    }

    #[test]
    fn supports_only_macos_and_linux() {
        assert!(sandbox_supports_os("macos"));
        assert!(sandbox_supports_os("linux"));
        assert!(!sandbox_supports_os("windows"));
        assert!(!sandbox_supports_os("unsupported"));
    }

    #[test]
    fn aider_hides_implicit_configuration_and_only_accepts_model_environment() {
        let args = build_sandbox_launcher_args(
            "aider",
            &[],
            "/work/project/sub",
            Path::new("/home/user"),
            Path::new("/tmp/toolhost"),
        );
        let denied: Vec<_> = args
            .windows(2)
            .filter(|pair| pair[0] == "--deny-readable")
            .map(|pair| pair[1].as_str())
            .collect();
        for file in [
            "/home/user/.aider.conf.yml",
            "/work/project/sub/.env",
            "/work/project/.aider.conf.yml",
            "/.aider.model.metadata.json",
            "/home/user/.aider/oauth-keys.env",
        ] {
            assert!(denied.contains(&file));
        }
    }

    #[test]
    fn launcher_file_name_is_platform_correct() {
        assert_eq!(
            launcher_file_name("windows"),
            "cognia-external-agent-launcher.exe"
        );
        assert_eq!(
            launcher_file_name("macos"),
            "cognia-external-agent-launcher"
        );
    }

    #[test]
    fn grok_rebases_state_and_temp_and_disables_hosted_updates() {
        let host = FakeHost::new("macos");
        let mut input = config("grok", &["agent", "--no-leader", "stdio"], Some("/work"));
        input.env.extend([
            ("GROK_HOME".into(), "state/../grok".into()),
            ("GROK_DISABLE_AUTOUPDATER".into(), "0".into()),
            ("GROK_CHANGELOG_OFFLINE".into(), "0".into()),
        ]);
        let wrapped = wrap_with_sandbox(input, &host).unwrap();
        assert_eq!(wrapped.env["GROK_HOME"], "/work/grok");
        assert_eq!(wrapped.env["GROK_DISABLE_AUTOUPDATER"], "1");
        assert_eq!(wrapped.env["GROK_CHANGELOG_OFFLINE"], "1");
        for key in ["TMPDIR", "TMP", "TEMP"] {
            assert_eq!(wrapped.env[key], "/work/grok/tmp");
        }
        assert!(pairs(&wrapped.args, "--writable").contains(&"/work/grok"));
        assert!(!pairs(&wrapped.args, "--writable").contains(&"/home/dev/.grok"));
        assert!(!pairs(&wrapped.args, "--writable").contains(&"/tmp/sessions"));
        assert_eq!(
            state_writable_roots("grok", &[], Path::new("/home/dev")),
            [PathBuf::from("/home/dev/.grok")]
        );
        assert!(state_writable_roots("not-grok", &[], Path::new("/home/dev")).is_empty());
    }

    #[test]
    fn grok_isolated_wrapper_preserves_the_credential_opt_out_after_consuming_state_key() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        for explicit in [None, Some("explicit-fixture"), Some("")] {
            let mut original = config("grok", &["agent", "--no-leader", "stdio"], Some("/work"));
            original.env.insert(
                crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
                "grok-env".into(),
            );
            if let Some(value) = explicit {
                original.env.insert("XAI_API_KEY".into(), value.into());
            }
            let wrapped = wrap_with_sandbox(original, &host).unwrap();
            assert!(!wrapped
                .env
                .contains_key(crate::state_isolation::AGENT_STATE_KEY_ENV));
            assert_eq!(wrapped.env["XAI_API_KEY"], explicit.unwrap_or(""));
        }
    }

    #[test]
    fn grok_bot_rejects_empty_and_escaping_state_before_provisioning() {
        for selected in ["", "   ", "/work/state/../escape", "/home/dev/.grok"] {
            let host = FakeHost::new("macos");
            let mut input = config("grok", &["agent", "--no-leader", "stdio"], Some("/work"));
            input.env.extend([
                ("COGNIA_BOT_ISOLATION".into(), "1".into()),
                ("COGNIA_BOT_STATE_DIR".into(), "/work/state".into()),
                ("GROK_HOME".into(), selected.into()),
            ]);
            assert!(matches!(
                wrap_with_sandbox(input, &host),
                Err(SandboxError::InvalidStateRoot(_))
            ));
            assert!(host.dirs.borrow().is_empty());
        }
    }

    #[test]
    fn pi_gets_its_session_store_as_a_writable_root() {
        let roots = state_writable_roots("pi", &[], Path::new("/home/dev"));
        assert_eq!(roots, vec![PathBuf::from("/home/dev/.pi")]);
    }

    #[cfg(unix)]
    #[test]
    fn kimi_bot_rejects_symlinked_state_escape_before_directory_provisioning() {
        let owned = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), owned.path().join("escape")).unwrap();
        let host = FakeHost::new("macos");
        let mut input = config("kimi", &["acp"], Some("/work"));
        input.env.extend([
            ("COGNIA_BOT_ISOLATION".into(), "1".into()),
            (
                "COGNIA_BOT_STATE_DIR".into(),
                owned.path().to_string_lossy().into_owned(),
            ),
            (
                "KIMI_CODE_HOME".into(),
                owned
                    .path()
                    .join("escape/new")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ]);
        assert!(matches!(
            wrap_with_sandbox(input, &host),
            Err(SandboxError::InvalidStateRoot(_))
        ));
        assert!(host.dirs.borrow().is_empty());
    }

    #[test]
    fn minimax_scopes_directory_aliases_and_image_temp() {
        let host = FakeHost::new("macos");
        for (selected, fallback, expected) in [
            ("", "", "/home/dev/.minimax"),
            ("/owned/minimax", "/ignored", "/owned/minimax"),
            ("", "state/../minimax", "/work/minimax"),
        ] {
            let mut input = config("mcode", &["acp"], Some("/work"));
            input.env.insert("MINIMAX_DATA_DIR".into(), selected.into());
            input.env.insert("MAVIS_DATA_DIR".into(), fallback.into());
            let wrapped = wrap_with_sandbox(input, &host).unwrap();
            assert_eq!(wrapped.env["MINIMAX_DATA_DIR"], expected);
            assert_eq!(wrapped.env["MAVIS_DATA_DIR"], expected);
            assert_eq!(wrapped.env["TMPDIR"], format!("{expected}/tmp"));
            assert!(wrapped
                .args
                .windows(2)
                .any(|pair| pair == ["--writable", expected]));
            if expected != "/home/dev/.minimax" {
                assert!(!wrapped.args.iter().any(|arg| arg == "/home/dev/.minimax"));
            }
        }
        let mut input = config("mcode", &["acp"], Some("/work"));
        input.env = HashMap::from([
            ("COGNIA_BOT_ISOLATION".into(), "1".into()),
            ("COGNIA_BOT_STATE_DIR".into(), "/owned".into()),
            ("MINIMAX_DATA_DIR".into(), "/outside".into()),
        ]);
        assert!(matches!(
            wrap_with_sandbox(input, &host),
            Err(SandboxError::InvalidStateRoot(_))
        ));
    }

    #[test]
    fn kimi_scopes_native_state_temp_and_update_lifecycle() {
        let host = FakeHost::new("macos");
        for (selected, expected) in [
            ("state/../kimi", "/work/kimi"),
            (" state ", "/work/ state "),
            ("/isolated/kimi", "/isolated/kimi"),
        ] {
            let mut input = config("kimi", &["acp"], Some("/work"));
            input.env.insert("KIMI_CODE_HOME".into(), selected.into());
            input
                .env
                .insert("KIMI_CODE_NO_AUTO_UPDATE".into(), "0".into());
            input
                .env
                .insert("KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT".into(), "1".into());
            let wrapped = wrap_with_sandbox(input, &host).unwrap();
            assert_eq!(wrapped.env["KIMI_CODE_HOME"], expected);
            assert_eq!(wrapped.env["TMPDIR"], format!("{expected}/tmp"));
            assert_eq!(wrapped.env["KIMI_CODE_NO_AUTO_UPDATE"], "1");
            assert_eq!(wrapped.env["KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT"], "0");
            assert!(wrapped
                .args
                .windows(2)
                .any(|pair| pair == ["--writable", expected]));
            assert!(!wrapped
                .args
                .windows(2)
                .any(|pair| pair == ["--writable", "/home/dev/.kimi-code"]));
        }
        assert_eq!(
            state_writable_roots("kimi", &[], Path::new("/home/dev")),
            vec![PathBuf::from("/home/dev/.kimi-code")]
        );
    }

    #[test]
    fn kimi_bot_rejects_empty_and_escaping_state_and_retains_owned_temp() {
        let host = FakeHost::new("macos");
        for selected in ["", "   ", "/work/state/../escape", "/home/dev/.kimi-code"] {
            let mut input = config("kimi", &["acp"], Some("/work"));
            input.env.extend([
                ("COGNIA_BOT_ISOLATION".into(), "1".into()),
                ("COGNIA_BOT_STATE_DIR".into(), "/work/state".into()),
                ("KIMI_CODE_HOME".into(), selected.into()),
            ]);
            assert!(matches!(
                wrap_with_sandbox(input, &host),
                Err(SandboxError::InvalidStateRoot(_))
            ));
        }
        let mut input = config("kimi", &["acp"], Some("/work"));
        input.env.extend([
            ("COGNIA_BOT_ISOLATION".into(), "1".into()),
            ("COGNIA_BOT_STATE_DIR".into(), "/work/state".into()),
            ("KIMI_CODE_HOME".into(), "/work/state/kimi".into()),
        ]);
        let wrapped = wrap_with_sandbox(input, &host).unwrap();
        assert_eq!(wrapped.env["KIMI_CODE_HOME"], "/work/state/kimi");
        // A private launch's temp is always its own state's.
        assert_eq!(wrapped.env["TMPDIR"], "/work/state/tmp");
        assert!(!wrapped.args.iter().any(|arg| arg == "/home/dev/.kimi-code"));
    }

    #[test]
    fn cline_scopes_actual_acp_config_and_disables_updates() {
        let host = FakeHost::new("macos");
        let mut input = config("cline", &["--acp", "--config", "state"], Some("/work"));
        input.env.insert("CLINE_DIR".into(), "/ignored".into());
        let wrapped = wrap_with_sandbox(input, &host).unwrap();
        assert!(wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--writable", "/work/state"]));
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--writable", "/home/dev/.cline"]));
        assert_eq!(wrapped.env["CLINE_DIR"], "/work/state");
        assert_eq!(wrapped.env["TMPDIR"], "/work/state/tmp");
        assert_eq!(wrapped.env["CLINE_NO_AUTO_UPDATE"], "1");
        assert_eq!(
            state_writable_roots("cline", &[], Path::new("/home/dev")),
            vec![PathBuf::from("/home/dev/.cline")]
        );
    }
    #[test]
    fn cline_bot_cannot_escape_owned_state_or_use_ignored_data_flag() {
        let host = FakeHost::new("macos");
        let mut input = config("cline", &["--acp"], Some("/work"));
        input.env.extend([
            ("COGNIA_BOT_ISOLATION".into(), "1".into()),
            ("COGNIA_BOT_STATE_DIR".into(), "/work/state".into()),
            ("CLINE_DIR".into(), "/work/state/../escape".into()),
        ]);
        assert!(matches!(
            wrap_with_sandbox(input, &host),
            Err(SandboxError::InvalidStateRoot(_))
        ));
        let input = config(
            "cline",
            &["--acp", "--data-dir", "/work/state"],
            Some("/work"),
        );
        assert!(matches!(
            wrap_with_sandbox(input, &host),
            Err(SandboxError::InvalidStateRoot(_))
        ));
    }

    #[test]
    fn qoder_custom_state_is_scoped_without_writing_the_default_login_root() {
        let home = Path::new("/home/dev");
        assert_eq!(
            state_writable_roots("qoder", &["--acp".into()], home),
            vec![home.join(".qoder")]
        );
        let mut input = config(
            "qoder",
            &["--acp", "--config-dir", "state"],
            Some("/work/project"),
        );
        input
            .env
            .insert("QODER_CONFIG_DIR".into(), "/ignored".into());
        let wrapped = wrap_with_sandbox(input, &FakeHost::new("macos")).unwrap();
        assert_eq!(wrapped.env["QODER_CONFIG_DIR"], "/work/project/state");
        assert_eq!(wrapped.env["TMPDIR"], "/work/project/state/tmp");
        assert!(wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--writable", "/work/project/state"]));
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--writable", "/home/dev/.qoder"]));
    }

    #[test]
    fn qoder_bot_config_cannot_escape_owned_state() {
        let mut input = config("qoder", &["--acp"], Some("/work"));
        input.env.insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        input
            .env
            .insert("COGNIA_BOT_STATE_DIR".into(), "/work/state".into());
        input
            .env
            .insert("QODER_CONFIG_DIR".into(), "/work/state/../outside".into());
        assert!(matches!(
            wrap_with_sandbox(input, &FakeHost::new("macos")),
            Err(SandboxError::InvalidStateRoot(_))
        ));
    }

    #[test]
    fn qoder_bot_exposes_host_programs_without_the_login_root() {
        let mut input = config("qoder", &["--acp"], Some("/work"));
        input.env.insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        input
            .env
            .insert("COGNIA_BOT_STATE_DIR".into(), "/work/state".into());
        let wrapped = wrap_with_sandbox(input, &FakeHost::new("macos")).unwrap();
        for root in ["/home/dev/.qoder/entry", "/home/dev/.qoder/bin"] {
            assert!(wrapped
                .args
                .windows(2)
                .any(|pair| pair == ["--readable", root]));
        }
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--readable", "/home/dev/.qoder"]));
        assert_eq!(wrapped.env["QODER_CONFIG_DIR"], "/work/state/.qoder");
    }

    #[test]
    fn goose_gets_its_config_data_and_state_on_both_unix_platforms() {
        let home = Path::new("/home/dev");
        assert_eq!(
            state_writable_roots("goose", &["acp".into()], home),
            vec![
                home.join(".config/goose"),
                home.join(".local/share/goose"),
                home.join(".local/state/goose"),
                home.join("Library/Application Support/Block/goose"),
            ]
        );
        assert_eq!(
            state_writable_roots("npx", &["-y".into(), "goose-adapter".into()], home),
            vec![home.join(".npm")]
        );
    }

    #[test]
    fn devin_gets_its_config_sessions_and_cache_without_matching_other_commands() {
        assert_eq!(
            state_writable_roots("mcode", &["acp".into()], Path::new("/home/dev")),
            vec![PathBuf::from("/home/dev/.minimax")]
        );
        assert!(state_writable_roots("not-mcode", &[], Path::new("/home/dev")).is_empty());
        assert_eq!(
            state_writable_roots("devin", &["acp".into()], Path::new("/home/dev")),
            vec![
                PathBuf::from("/home/dev/.config/devin"),
                PathBuf::from("/home/dev/.local/share/devin"),
                PathBuf::from("/home/dev/.cache/devin"),
            ]
        );
        assert_eq!(
            state_writable_roots(
                "npx",
                &["-y".into(), "devin-adapter".into()],
                Path::new("/home/dev"),
            ),
            vec![PathBuf::from("/home/dev/.npm")]
        );
    }

    #[test]
    fn npx_package_decides_the_state_root_not_npx() {
        // Vehicle is Qwen because it is still launched through npx; `pi-acp`,
        // which this used to use, was removed with the ACP bridge (ADR-0119).
        let args = vec!["-y".to_string(), "@qwen-code/qwen-code".to_string()];
        let roots = state_writable_roots("npx", &args, Path::new("/home/dev"));
        assert!(roots.contains(&PathBuf::from("/home/dev/.qwen")));
        assert!(roots.contains(&PathBuf::from("/home/dev/.npm")));
    }

    /// `pi` must match on the base command, never as a substring: the native
    /// binary is the only Pi launch left, and an `npx` package that merely
    /// contains "pi" must not inherit Pi's session store.
    #[test]
    fn pi_state_root_does_not_leak_to_an_npx_package_containing_pi() {
        let args = vec!["-y".to_string(), "pi-acp".to_string()];
        let roots = state_writable_roots("npx", &args, Path::new("/home/dev"));
        assert!(!roots.contains(&PathBuf::from("/home/dev/.pi")));
    }

    #[test]
    fn windows_suffix_is_stripped_before_matching() {
        let roots = state_writable_roots("Codex.EXE", &[], Path::new("/home/dev"));
        assert_eq!(roots, vec![PathBuf::from("/home/dev/.codex")]);
    }

    #[test]
    fn opencode_gets_its_config_and_session_store() {
        // Neither launcher had an OpenCode rule, so `opencode serve` ran with
        // its session database outside the sandbox scope: writes failed
        // silently and `--session-id` resume started over every time.
        let roots = state_writable_roots("opencode", &[], Path::new("/home/dev"));
        assert_eq!(
            roots,
            vec![
                PathBuf::from("/home/dev/.config/opencode"),
                PathBuf::from("/home/dev/.local/share/opencode"),
            ]
        );
    }

    #[test]
    fn copilot_does_not_inherit_pis_state_directory() {
        // "copilot" contains "pi", which is why the Pi rule matches the exact
        // target rather than a substring.
        let roots = state_writable_roots("copilot", &[], Path::new("/home/dev"));
        assert!(!roots.contains(&PathBuf::from("/home/dev/.pi")));
    }

    #[test]
    fn tool_host_dir_falls_back_when_uid_is_unavailable() {
        assert_eq!(
            tool_host_runtime_dir(Path::new("/tmp"), Some(501)),
            PathBuf::from("/tmp/cognia-toolhost-501")
        );
        assert_eq!(
            tool_host_runtime_dir(Path::new("/tmp"), None),
            PathBuf::from("/tmp/cognia-toolhost-user")
        );
    }

    #[test]
    fn launcher_args_scope_cwd_state_and_toolhost_then_pass_the_target_through() {
        let args = build_sandbox_launcher_args(
            "pi",
            &["--mode".to_string(), "rpc".to_string()],
            "/work/project",
            Path::new("/home/dev"),
            Path::new("/tmp/cognia-toolhost-501"),
        );
        assert_eq!(
            args,
            vec![
                "--cwd",
                "/work/project",
                "--writable",
                "/work/project",
                "--writable",
                "/home/dev/.pi",
                "--writable",
                "/tmp/cognia-toolhost-501",
                "--readable",
                "/home/dev",
                "--network",
                "--",
                "pi",
                "--mode",
                "rpc",
            ]
        );
    }

    #[test]
    fn wrap_replaces_the_command_with_the_launcher_and_keeps_id_env_cwd() {
        let host = FakeHost::new("macos");
        let mut original = config("pi", &["--mode", "rpc"], Some("/work/project"));
        original
            .env
            .insert("ANTHROPIC_API_KEY".to_string(), "secret".to_string());

        let wrapped = wrap_with_sandbox(original, &host).expect("sandbox wrap");

        assert_eq!(wrapped.command, "/opt/launcher");
        assert_eq!(wrapped.id, "agent-1");
        assert_eq!(wrapped.cwd.as_deref(), Some("/work/project"));
        assert_eq!(
            wrapped.env.get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("secret")
        );
        // The real agent survives after the `--` separator.
        let separator = wrapped.args.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(&wrapped.args[separator + 1..], ["pi", "--mode", "rpc"]);
    }

    #[test]
    fn goose_temp_is_scoped_even_when_ambient_temp_or_custom_state_is_set() {
        let host = FakeHost::new("macos");
        let mut original = config("goose", &["acp"], Some("/work/project"));
        original.env.insert("TMPDIR".into(), "/ambient/tmp".into());
        original
            .env
            .insert("GOOSE_PATH_ROOT".into(), "/untrusted".into());
        let wrapped = wrap_with_sandbox(original, &host).expect("sandbox wrap");
        for key in ["TMPDIR", "TMP", "TEMP"] {
            assert_eq!(wrapped.env[key], "/home/dev/.local/state/goose/tmp");
        }
        assert!(host
            .dirs
            .borrow()
            .contains(&PathBuf::from("/home/dev/.local/state/goose/tmp")));
        assert!(!wrapped
            .args
            .iter()
            .any(|arg| arg == "/ambient/tmp" || arg == "/untrusted"));
    }

    #[test]
    fn goose_absolute_binary_keeps_isolated_temp_and_keyring_inside_its_configuration() {
        let data = tempfile::tempdir().unwrap();
        let mut host = FakeHost::new("macos");
        host.state_data_dir = Some(data.path().to_path_buf());
        let mut original = config("/opt/goose", &["acp"], Some("/work/project"));
        original.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "goose-private".into(),
        );
        original
            .env
            .insert("GOOSE_DISABLE_KEYRING".into(), "0".into());
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        let root = data.path().join("cognia/external-agents/goose-private");
        for key in ["TMPDIR", "TMP", "TEMP"] {
            assert_eq!(
                wrapped.env[key],
                root.join("goose/state/tmp").to_string_lossy()
            );
        }
        assert_eq!(wrapped.env["GOOSE_DISABLE_KEYRING"], "1");
        assert!(pairs(&wrapped.args, "--writable").contains(&root.to_str().unwrap()));
        for shared in [
            "/home/dev/.config/goose",
            "/home/dev/.local/share/goose",
            "/home/dev/.local/state/goose",
        ] {
            assert!(!pairs(&wrapped.args, "--writable").contains(&shared));
            assert!(pairs(&wrapped.args, "--deny-readable").contains(&shared));
        }
    }

    /// A real directory tree for the Pi package root tests. Created under the
    /// workspace `target/` dir rather than the OS temp dir: `/tmp` and `/var`
    /// (macOS temp lives in `/private/var`) are forbidden readable roots, so a
    /// fixture there could never exercise the accepting path.
    struct PiRootsFixture {
        _tmp: tempfile::TempDir,
        base: PathBuf,
    }

    impl PiRootsFixture {
        fn new() -> Self {
            let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/cognia-external-agent-test-fixtures");
            std::fs::create_dir_all(&parent).unwrap();
            let tmp = tempfile::tempdir_in(&parent).unwrap();
            let base = std::fs::canonicalize(tmp.path()).unwrap();
            Self { _tmp: tmp, base }
        }
        fn dir(&self, relative: &str) -> PathBuf {
            let path = self.base.join(relative);
            std::fs::create_dir_all(&path).unwrap();
            path
        }
    }

    fn pi_roots_config(command: &str, entries: serde_json::Value) -> ExternalAgentSpawnConfig {
        let mut cfg = config(command, &["--mode", "rpc"], Some("/work/project"));
        cfg.env
            .insert(PI_PACKAGE_ROOTS_ENV.into(), entries.to_string());
        cfg
    }

    #[test]
    fn desktop_plugin_install_root_matches_the_app_plugin_store() {
        let home = Path::new("/Users/dev");
        assert_eq!(
            desktop_plugin_install_root("macos", Some(home), None),
            Some(PathBuf::from(
                "/Users/dev/Library/Application Support/cognia/plugins"
            ))
        );
        assert_eq!(
            desktop_plugin_install_root("linux", Some(Path::new("/home/dev")), None),
            Some(PathBuf::from("/home/dev/.local/share/cognia/plugins"))
        );
        assert_eq!(
            desktop_plugin_install_root(
                "linux",
                Some(Path::new("/home/dev")),
                Some(Path::new("/data/xdg"))
            ),
            Some(PathBuf::from("/data/xdg/cognia/plugins"))
        );
        // A relative XDG_DATA_HOME is ignored, as `dirs` does.
        assert_eq!(
            desktop_plugin_install_root(
                "linux",
                Some(Path::new("/home/dev")),
                Some(Path::new("rel"))
            ),
            Some(PathBuf::from("/home/dev/.local/share/cognia/plugins"))
        );
        assert_eq!(
            desktop_plugin_install_root("windows", Some(home), None),
            None
        );
        assert_eq!(desktop_plugin_install_root("macos", None, None), None);
    }

    #[test]
    fn pi_package_roots_keep_only_existing_dirs_inside_the_plugin_store() {
        let fx = PiRootsFixture::new();
        let store = fx.dir("data/cognia/plugins");
        let latex = fx.dir("data/cognia/plugins/latex-workbench");
        let file = store.join("latex-workbench/README.md");
        std::fs::write(&file, "x").unwrap();
        let other_app_data = fx.dir("data/cognia/secrets");
        let ssh = fx.dir("data/cognia/plugins/evil/.ssh");
        let cfg = pi_roots_config(
            "pi",
            serde_json::json!([
                latex,
                latex,
                format!("{}/../latex-workbench", store.join("evil").display()),
                "relative/dir",
                store,
                other_app_data,
                file,
                ssh,
                store.join("missing"),
            ]),
        );
        assert_eq!(
            pi_package_readable_roots(&cfg, Some(&store), &[], &[]),
            vec![latex.clone()]
        );
        // No host-derived store → nothing is mounted at all.
        assert!(pi_package_readable_roots(&cfg, None, &[], &[]).is_empty());
        assert!(pi_package_readable_roots(&cfg, Some(&fx.base.join("nope")), &[], &[]).is_empty());
    }

    #[test]
    fn pi_package_roots_resolve_symlinks_before_checking_containment() {
        let fx = PiRootsFixture::new();
        let store = fx.dir("data/cognia/plugins");
        let home = fx.dir("home");
        let link = store.join("looks-like-a-plugin");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&home, &link).unwrap();
        #[cfg(unix)]
        {
            let cfg = pi_roots_config("pi", serde_json::json!([link]));
            assert!(pi_package_readable_roots(&cfg, Some(&store), &[], &[]).is_empty());
        }
    }

    #[test]
    fn pi_package_roots_refuse_malformed_values_and_non_pi_commands() {
        let fx = PiRootsFixture::new();
        let store = fx.dir("data/cognia/plugins");
        let latex = fx.dir("data/cognia/plugins/latex-workbench");
        let mut malformed = config("pi", &[], Some("/work"));
        malformed
            .env
            .insert(PI_PACKAGE_ROOTS_ENV.into(), "{not json".into());
        assert!(pi_package_readable_roots(&malformed, Some(&store), &[], &[]).is_empty());
        let object = pi_roots_config("pi", serde_json::json!({ "root": latex }));
        assert!(pi_package_readable_roots(&object, Some(&store), &[], &[]).is_empty());

        // `pi.exe` and `PI` are Pi under the wrapper's base-name rule (the same
        // one that grants Pi its state root); anything else is ignored.
        for command in ["pi.exe", "PI", "pi"] {
            let cfg = pi_roots_config(command, serde_json::json!([latex]));
            assert_eq!(
                pi_package_readable_roots(&cfg, Some(&store), &[], &[]),
                vec![latex.clone()],
                "{command}"
            );
        }
        for command in ["codex", "copilot", "pip"] {
            let cfg = pi_roots_config(command, serde_json::json!([latex]));
            assert!(
                pi_package_readable_roots(&cfg, Some(&store), &[], &[]).is_empty(),
                "{command}"
            );
        }
    }

    #[test]
    fn pi_package_roots_never_name_a_forbidden_readable_root() {
        // Even if the host store itself were mis-derived onto a system path,
        // nothing under a forbidden readable root is admitted.
        for system in ["/var/run", "/var", "/tmp", "/etc"] {
            let store = PathBuf::from(system);
            if !store.exists() {
                continue;
            }
            let cfg = pi_roots_config("pi", serde_json::json!([store]));
            assert!(
                pi_package_readable_roots(&cfg, Some(Path::new("/")), &[], &[]).is_empty(),
                "{system}"
            );
        }
    }

    #[test]
    fn pi_package_roots_under_an_emitted_deny_are_dropped() {
        let fx = PiRootsFixture::new();
        let home = fx.dir("home");
        let store = fx.dir("home/.codex/plugins");
        let pkg = fx.dir("home/.codex/plugins/latex");
        let cfg = pi_roots_config("pi", serde_json::json!([pkg]));
        assert_eq!(
            pi_package_readable_roots(&cfg, Some(&store), &[], &[]),
            vec![pkg.clone()]
        );
        assert!(
            pi_package_readable_roots(&cfg, Some(&store), &[home.join(".codex")], &[]).is_empty()
        );
        assert!(pi_package_readable_roots(&cfg, Some(&store), &[home], &[]).is_empty());
    }

    /// L1: a package root that overlaps a writable root (under it, or
    /// containing it) is dropped — the agent could swap a writable directory
    /// for a symlink between validation and the bind.
    #[test]
    fn pi_package_roots_overlapping_a_writable_root_are_dropped() {
        let fx = PiRootsFixture::new();
        let store = fx.dir("data/cognia/plugins");
        let pkg = fx.dir("data/cognia/plugins/latex");
        let inner = fx.dir("data/cognia/plugins/latex/work");
        let cfg = pi_roots_config("pi", serde_json::json!([pkg]));
        // Writable at the package dir, above it, or below it: all refused.
        for writable in [pkg.clone(), store.clone(), inner.clone()] {
            assert!(
                pi_package_readable_roots(&cfg, Some(&store), &[], std::slice::from_ref(&writable))
                    .is_empty(),
                "{}",
                writable.display()
            );
        }
        // An unrelated writable root leaves it alone.
        assert_eq!(
            pi_package_readable_roots(&cfg, Some(&store), &[], &[fx.dir("work/project")]),
            vec![pkg.clone()]
        );

        // Wrapper level: the agent's cwd inside the package makes it writable,
        // so the package is not also mounted as a readable root.
        let host = FakeHost {
            plugin_root: Some(store.clone()),
            home: Some(fx.dir("home")),
            ..FakeHost::new("macos")
        };
        let mut wrapped_cfg = config("pi", &["--mode", "rpc"], Some(inner.to_str().unwrap()));
        wrapped_cfg.env.insert(
            PI_PACKAGE_ROOTS_ENV.into(),
            serde_json::json!([pkg]).to_string(),
        );
        let wrapped = wrap_with_sandbox(wrapped_cfg, &host).unwrap();
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair[0] == "--readable" && Path::new(&pair[1]) == pkg));
    }

    /// L3: Bot isolation mounts no package roots, even when the plugin store
    /// sits OUTSIDE the hidden home (an absolute `XDG_DATA_HOME`).
    #[test]
    fn pi_package_roots_are_never_mounted_for_a_bot_isolated_spawn() {
        let fx = PiRootsFixture::new();
        let xdg = fx.dir("xdg-data");
        let store =
            desktop_plugin_install_root("linux", Some(&fx.base.join("home")), Some(&xdg)).unwrap();
        std::fs::create_dir_all(&store).unwrap();
        let pkg = fx.dir("xdg-data/cognia/plugins/latex");
        assert!(store.starts_with(&xdg) && !store.starts_with(fx.base.join("home")));

        let mut cfg = pi_roots_config("pi", serde_json::json!([pkg]));
        assert_eq!(
            pi_package_readable_roots(&cfg, Some(&store), &[], &[]),
            vec![pkg.clone()]
        );
        cfg.env.insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        assert!(pi_package_readable_roots(&cfg, Some(&store), &[], &[]).is_empty());

        // And through the wrapper, where nothing else would have denied it.
        let host = FakeHost {
            plugin_root: Some(store.clone()),
            home: Some(fx.dir("home")),
            ..FakeHost::new("linux")
        };
        cfg.env.insert(
            "COGNIA_BOT_STATE_DIR".into(),
            fx.dir("bot-state").display().to_string(),
        );
        let wrapped = wrap_with_sandbox(cfg, &host).unwrap();
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair[0] == "--readable" && Path::new(&pair[1]) == pkg));
    }

    /// Wrapper-level invariant: whatever the mode, no `--readable` that the
    /// Pi package list contributes lands under any `--deny-readable` the
    /// wrapper emits, and a package root is never writable.
    #[test]
    fn wrapped_pi_package_roots_never_reopen_a_denied_subtree() {
        let fx = PiRootsFixture::new();
        let home = fx.dir("home");
        let store = fx.dir("home/Library/Application Support/cognia/plugins");
        let pkg = fx.dir("home/Library/Application Support/cognia/plugins/latex");
        let task_store = fx.dir("home/.local/share/cognia-agent-tasks/plugins");
        let task_pkg = fx.dir("home/.local/share/cognia-agent-tasks/plugins/latex");

        let readables = |args: &[String]| -> Vec<String> {
            args.windows(2)
                .filter(|pair| pair[0] == "--readable")
                .map(|pair| pair[1].clone())
                .collect()
        };
        let denies = |args: &[String]| -> Vec<PathBuf> {
            args.windows(2)
                .filter(|pair| pair[0] == "--deny-readable")
                .map(|pair| PathBuf::from(&pair[1]))
                .collect()
        };

        let modes: Vec<(&str, HashMap<String, String>)> = vec![
            ("default", HashMap::new()),
            (
                "bot",
                HashMap::from([
                    ("COGNIA_BOT_ISOLATION".to_string(), "1".to_string()),
                    (
                        "COGNIA_BOT_STATE_DIR".to_string(),
                        fx.dir("bot-state").display().to_string(),
                    ),
                ]),
            ),
            (
                "gateway",
                HashMap::from([(
                    crate::gateway_task::PAYLOAD_ENV.to_string(),
                    serde_json::json!({"taskId":"t1","runtime":"pi","binding":{},"files":{}})
                        .to_string(),
                )]),
            ),
        ];
        for (mode, env) in modes {
            for store_override in [None, Some(task_store.clone())] {
                let host = FakeHost {
                    plugin_root: store_override.clone().or(Some(store.clone())),
                    home: Some(home.clone()),
                    ..FakeHost::new("macos")
                };
                let candidate = if store_override.is_some() {
                    &task_pkg
                } else {
                    &pkg
                };
                let mut base = config("pi", &["--mode", "rpc"], Some("/work/project"));
                base.env.extend(env.clone());
                let without = wrap_with_sandbox(base.clone(), &host).unwrap();
                let mut with_roots = base;
                with_roots.env.insert(
                    PI_PACKAGE_ROOTS_ENV.into(),
                    serde_json::json!([candidate]).to_string(),
                );
                let wrapped = wrap_with_sandbox(with_roots, &host).unwrap();
                let before = readables(&without.args);
                let added: Vec<String> = readables(&wrapped.args)
                    .into_iter()
                    .filter(|path| !before.contains(path))
                    .collect();
                for path in &added {
                    for deny in denies(&wrapped.args) {
                        assert!(
                            !Path::new(path).starts_with(&deny),
                            "{mode}: {path} re-opens denied {}",
                            deny.display()
                        );
                    }
                }
                assert!(!wrapped
                    .args
                    .windows(2)
                    .any(|pair| pair[0] == "--writable" && Path::new(&pair[1]) == candidate));
                match (mode, store_override.is_some()) {
                    // Default mode: the package is mounted.
                    ("default", _) => assert_eq!(added, vec![candidate.display().to_string()]),
                    // Bot isolation denies the whole home; the store is under it.
                    ("bot", _) => assert!(added.is_empty(), "{mode}"),
                    // A gateway task denies the task-home parent.
                    ("gateway", true) => assert!(added.is_empty(), "{mode}"),
                    ("gateway", false) => {
                        assert_eq!(added, vec![candidate.display().to_string()])
                    }
                    _ => unreachable!(),
                }
            }
        }
    }

    #[test]
    fn gateway_task_hides_every_supported_runtime_native_state() {
        let host = FakeHost::new("macos");
        let mut original = config("kimi", &["acp"], Some("/work/project"));
        original.env.insert(
            crate::gateway_task::PAYLOAD_ENV.into(),
            serde_json::json!({"taskId":"kimi-task","runtime":"kimi","binding":{},"files":{}})
                .to_string(),
        );
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        for relative in [
            ".codex",
            ".kimi-code",
            ".kimi",
            ".copilot",
            ".config/goose",
            ".local/share/goose",
            ".local/state/goose",
            ".aider",
        ] {
            let denied = format!("/home/dev/{relative}");
            assert!(
                wrapped
                    .args
                    .windows(2)
                    .any(|pair| pair[0] == "--deny-readable" && pair[1] == denied),
                "{relative}"
            );
        }
    }

    #[test]
    fn bot_launch_hides_home_and_uses_owned_state() {
        let host = FakeHost::new("macos");
        let mut original = config("devin", &["acp"], Some("/work/project"));
        original
            .env
            .insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        original
            .env
            .insert("COGNIA_BOT_STATE_DIR".into(), "/work/state".into());
        original.env.insert("TMPDIR".into(), "/ambient/tmp".into());
        original
            .env
            .insert("pnpm_config_store_dir".into(), "/ambient/store".into());
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        assert!(wrapped.args.iter().any(|arg| arg == "--bot-isolation"));
        assert!(wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--deny-readable", "/home/dev"]));
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--readable", "/home/dev"]));
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--writable", "/home/dev/.local/share/devin"]));
        assert_eq!(wrapped.env["XDG_DATA_HOME"], "/work/state/data");
        for key in ["TMPDIR", "TMP", "TEMP"] {
            assert_eq!(wrapped.env[key], "/work/state/tmp");
        }
        assert_eq!(wrapped.env["npm_config_cache"], "/work/state/cache/npm");
        assert_eq!(
            wrapped.env["npm_config_store_dir"],
            "/work/state/cache/pnpm-store"
        );
        assert_eq!(
            wrapped.env["pnpm_config_store_dir"],
            "/work/state/cache/pnpm-store"
        );
        assert_eq!(
            wrapped.env["pnpm_config_cache_dir"],
            "/work/state/cache/pnpm"
        );
        for directory in ["tmp", "cache/npm", "cache/pnpm-store", "cache/pnpm"] {
            assert!(host
                .dirs
                .borrow()
                .contains(&PathBuf::from("/work/state").join(directory)));
        }
    }

    #[test]
    fn wrap_attests_devin_configuration_after_policy_even_for_custom_launcher_paths() {
        let host = FakeHost::new("macos");
        let mut original = config("devin", &["acp"], Some("/work/project"));
        original
            .env
            .insert(crate::mcp_config_file::PAYLOAD_ENV.into(), "[]".into());
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        assert_eq!(wrapped.command, "/opt/launcher");
        assert_eq!(wrapped.env[crate::mcp_config_file::WRAPPED_ENV], "1");
        assert_eq!(wrapped.env[crate::mcp_config_file::PAYLOAD_ENV], "[]");
    }

    #[test]
    fn wrap_pre_creates_state_roots_choosing_file_or_directory() {
        let host = FakeHost::new("linux");
        let original = config("claude", &[], Some("/work/project"));
        wrap_with_sandbox(original, &host).expect("sandbox wrap");

        let dirs = host.dirs.borrow();
        let files = host.files.borrow();
        assert!(dirs.contains(&PathBuf::from("/home/dev/.claude")));
        assert!(dirs.contains(&PathBuf::from("/tmp/cognia-toolhost-501")));
        assert!(files.contains(&PathBuf::from("/home/dev/.claude.json")));
        assert!(files.contains(&PathBuf::from("/home/dev/.claude.json.backup")));
        assert!(!dirs.contains(&PathBuf::from("/home/dev/.claude.json")));
    }

    #[test]
    fn wrap_refuses_unsupported_platform() {
        let host = FakeHost::new("windows");
        let error = wrap_with_sandbox(config("pi", &[], Some("/work")), &host).unwrap_err();
        assert_eq!(error, SandboxError::UnsupportedPlatform("windows".into()));
        assert_eq!(error.reason_code(), "sandbox_unavailable");
        assert!(error.to_string().contains("never runs them unsandboxed"));
    }

    #[test]
    fn wrap_refuses_when_no_launcher_is_executable() {
        let mut host = FakeHost::new("macos");
        host.executable.clear();
        let error = wrap_with_sandbox(config("pi", &[], Some("/work")), &host).unwrap_err();
        assert_eq!(error, SandboxError::LauncherUnavailable("pi".into()));
        assert!(error.to_string().contains(LAUNCHER_ENV));
    }

    #[test]
    fn wrap_refuses_a_missing_or_blank_cwd() {
        let host = FakeHost::new("macos");
        assert_eq!(
            wrap_with_sandbox(config("pi", &[], None), &host).unwrap_err(),
            SandboxError::MissingCwd
        );
        assert_eq!(
            wrap_with_sandbox(config("pi", &[], Some("   ")), &host).unwrap_err(),
            SandboxError::MissingCwd
        );
    }

    #[test]
    fn wrap_refuses_without_a_home_directory() {
        let mut host = FakeHost::new("macos");
        host.home = None;
        assert_eq!(
            wrap_with_sandbox(config("pi", &[], Some("/work")), &host).unwrap_err(),
            SandboxError::MissingHome
        );
    }

    #[test]
    fn find_launcher_picks_the_first_executable_candidate() {
        let mut host = FakeHost::new("macos");
        host.candidates = vec![
            PathBuf::from("/missing/launcher"),
            PathBuf::from("/opt/launcher"),
        ];
        assert_eq!(
            find_sandbox_launcher(&host),
            Some(PathBuf::from("/opt/launcher"))
        );
    }

    // ── Per-configuration state roots (ADR-0216) ────────────────────────────

    fn isolated_host(data: &Path) -> FakeHost {
        FakeHost {
            state_data_dir: Some(data.to_path_buf()),
            ..FakeHost::new("macos")
        }
    }

    fn pairs<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
        args.windows(2)
            .filter(|pair| pair[0] == flag)
            .map(|pair| pair[1].as_str())
            .collect()
    }

    #[test]
    fn isolated_codex_writes_only_its_own_root_and_cannot_read_the_shared_login() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut original = config(
            "npx",
            &["-y", "@zed-industries/codex-acp"],
            Some("/work/project"),
        );
        original.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "cfg-1".into(),
        );
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        let root = data.path().join("cognia/external-agents/cfg-1");
        let writable = pairs(&wrapped.args, "--writable");
        assert!(writable.contains(&root.to_str().unwrap()), "{writable:?}");
        assert!(!writable.contains(&"/home/dev/.codex"), "{writable:?}");
        // npx's own cache is not a login root and stays writable.
        assert!(writable.contains(&"/home/dev/.npm"));
        assert!(pairs(&wrapped.args, "--deny-readable").contains(&"/home/dev/.codex"));
        assert_eq!(
            wrapped.env["CODEX_HOME"],
            root.join("codex").to_string_lossy()
        );
        assert!(!wrapped
            .env
            .contains_key(crate::state_isolation::AGENT_STATE_KEY_ENV));
        // The shared login root is never pre-created for an isolated launch.
        assert!(!host
            .dirs
            .borrow()
            .contains(&PathBuf::from("/home/dev/.codex")));
        let separator = wrapped.args.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(wrapped.args[separator + 1], "npx");
    }

    #[test]
    fn isolated_claude_never_creates_or_writes_the_shared_json_files() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut original = config("claude-agent-acp", &[], Some("/work/project"));
        original.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "c".into(),
        );
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        let writable = pairs(&wrapped.args, "--writable");
        let denied = pairs(&wrapped.args, "--deny-readable");
        for shared in [
            "/home/dev/.claude",
            "/home/dev/.claude.json",
            "/home/dev/.claude.json.backup",
        ] {
            assert!(!writable.contains(&shared), "{shared}");
            assert!(denied.contains(&shared), "{shared}");
        }
        assert!(host.files.borrow().is_empty());
        assert!(wrapped.env["CLAUDE_CONFIG_DIR"].ends_with("external-agents/c/claude"));
    }

    #[test]
    fn isolated_kimi_cline_and_qoder_rebase_onto_the_private_root() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        for (command, env_key, shared, sub) in [
            ("kimi", "KIMI_CODE_HOME", "/home/dev/.kimi-code", "kimi"),
            ("grok", "GROK_HOME", "/home/dev/.grok", "grok"),
            ("cline", "CLINE_DIR", "/home/dev/.cline", "cline"),
            ("qoder", "QODER_CONFIG_DIR", "/home/dev/.qoder", "qoder"),
        ] {
            let mut original = config(command, &["--acp"], Some("/work/project"));
            original.env.insert(
                crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
                format!("{command}-cfg"),
            );
            // A caller value for the owned key never wins.
            original
                .env
                .insert(env_key.into(), "/somewhere/else".into());
            let wrapped = wrap_with_sandbox(original, &host).unwrap();
            let own = data
                .path()
                .join("cognia/external-agents")
                .join(format!("{command}-cfg"))
                .join(sub);
            assert_eq!(wrapped.env[env_key], own.to_string_lossy(), "{command}");
            let writable = pairs(&wrapped.args, "--writable");
            assert!(!writable.contains(&shared), "{command}: {writable:?}");
            assert!(!writable.contains(&"/somewhere/else"), "{command}");
            // Temp lands inside the isolated home too.
            assert!(
                wrapped.env["TMPDIR"].starts_with(own.to_str().unwrap()),
                "{command}"
            );
        }
    }

    #[test]
    fn isolated_qoder_keeps_its_login_root_readable() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut original = config("qoder", &["--acp"], Some("/work/project"));
        original.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "q".into(),
        );
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        assert!(!pairs(&wrapped.args, "--deny-readable").contains(&"/home/dev/.qoder"));
    }

    #[test]
    fn isolated_opencode_maps_xdg_homes_into_the_root() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut original = config("opencode", &["acp"], Some("/work/project"));
        original.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "oc".into(),
        );
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        let root = data.path().join("cognia/external-agents/oc");
        assert_eq!(
            wrapped.env["XDG_DATA_HOME"],
            root.join("data").to_string_lossy()
        );
        assert_eq!(
            wrapped.env["XDG_STATE_HOME"],
            root.join("state").to_string_lossy()
        );
        assert_eq!(
            wrapped.env["XDG_CACHE_HOME"],
            root.join("cache").to_string_lossy()
        );
        let writable = pairs(&wrapped.args, "--writable");
        for shared in [
            "/home/dev/.config/opencode",
            "/home/dev/.local/share/opencode",
        ] {
            assert!(!writable.contains(&shared));
            assert!(pairs(&wrapped.args, "--deny-readable").contains(&shared));
        }
    }

    #[test]
    fn isolated_launch_refuses_unsupported_runtimes_bad_keys_and_unknown_data_dirs() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut gemini = config("gemini", &["--acp"], Some("/work/project"));
        gemini.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "g".into(),
        );
        let error = wrap_with_sandbox(gemini, &host).unwrap_err();
        assert_eq!(
            error,
            SandboxError::StateIsolation("state isolation unsupported for gemini".into())
        );
        assert_eq!(error.reason_code(), "state_isolation_failed");

        let mut bad = config("codex", &[], Some("/work/project"));
        bad.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "../../etc".into(),
        );
        assert!(matches!(
            wrap_with_sandbox(bad, &host),
            Err(SandboxError::StateIsolation(_))
        ));

        let no_data = FakeHost::new("macos");
        let mut codex = config("codex", &[], Some("/work/project"));
        codex.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "c".into(),
        );
        assert!(matches!(
            wrap_with_sandbox(codex, &no_data),
            Err(SandboxError::StateIsolation(_))
        ));
    }

    #[test]
    fn bot_isolation_wins_over_a_state_key() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut original = config("codex", &[], Some("/work/project"));
        original.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "cfg".into(),
        );
        original
            .env
            .insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        original
            .env
            .insert("COGNIA_BOT_STATE_DIR".into(), "/work/state".into());
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        assert!(!wrapped
            .env
            .contains_key(crate::state_isolation::AGENT_STATE_KEY_ENV));
        assert!(!wrapped.env.contains_key("CODEX_HOME"));
        assert!(pairs(&wrapped.args, "--writable").contains(&"/work/state"));
        assert!(!data.path().join("cognia").exists());
    }

    #[test]
    fn gateway_task_wins_over_a_state_key() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut original = config("codex", &[], Some("/work/project"));
        original.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "cfg".into(),
        );
        original.env.insert(
            crate::gateway_task::PAYLOAD_ENV.into(),
            serde_json::json!({"taskId":"t1","runtime":"codex","binding":{},"files":{}})
                .to_string(),
        );
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        assert!(!wrapped
            .env
            .contains_key(crate::state_isolation::AGENT_STATE_KEY_ENV));
        assert!(!wrapped.env.contains_key("CODEX_HOME"));
        assert!(!data.path().join("cognia").exists());
    }
}
