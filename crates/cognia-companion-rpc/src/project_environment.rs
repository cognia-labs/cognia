use crate::shell::{ShellResult, shell_exec_with_env_timeout_cap};
use cognia_exec_sandbox::types::{NetworkPolicy, SandboxCommand, SandboxPolicy};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

const DEFAULT_KEYRING_NAMESPACE: &str = "project-environment";
const DEFAULT_TIMEOUT_SECS: u64 = 30;
// Bootstrap may use up to one hour plus five seconds for cleanup.
const MAX_TIMEOUT_SECS: u64 = 60 * 60 + 5;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentKeyringReference {
    pub variable: String,
    pub keyring_ref: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum EnvironmentScript {
    // Prefer the snapshot over the safe fallback script sent for older Hosts.
    Mise {
        mise: MiseInstallSnapshot,
    },
    Structured {
        default: String,
        #[serde(default, rename = "byOs")]
        by_os: BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct MiseInstallSnapshot {
    config: String,
    lockfile: Option<String>,
}

const MISE_INSTALL_POSIX: &str = r#"if ! command -v mise >/dev/null 2>&1; then echo "cognia-setup-notice:miseMissing"; exit 0; fi
if [ "$(mise settings get safe 2>/dev/null)" != "true" ]; then echo "cognia-setup-notice:miseNoSafeMode"; exit 0; fi
exec mise install"#;
const MISE_INSTALL_WINDOWS: &str = r#"(where mise >nul 2>nul || (echo cognia-setup-notice:miseMissing& exit /b 0)) && (for /f "delims=" %S in ('mise settings get safe 2^>nul') do @if /i "%S"=="true" (mise install & exit /b)) & echo cognia-setup-notice:miseNoSafeMode"#;

impl EnvironmentScript {
    fn resolve_for(&self, os: &str) -> String {
        match self {
            Self::Structured { default, by_os } => by_os
                .get(os)
                .map(String::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(default)
                .trim()
                .to_string(),
            Self::Mise { .. } => if os == "windows" {
                MISE_INSTALL_WINDOWS
            } else {
                MISE_INSTALL_POSIX
            }
            .to_owned(),
        }
    }
}

impl MiseInstallSnapshot {
    fn stage(&self) -> Result<tempfile::TempDir, String> {
        let mut builder = tempfile::Builder::new();
        builder.prefix("cognia-mise-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let staged = builder
            .tempdir()
            .map_err(|error| format!("create mise staging directory: {error}"))?;
        // Keep the snapshot in project scope. Global configs are exempt from
        // mise's project safe-mode restrictions.
        std::fs::write(staged.path().join("mise.toml"), &self.config)
            .map_err(|error| format!("stage approved mise config: {error}"))?;
        if let Some(lockfile) = &self.lockfile {
            std::fs::write(staged.path().join("mise.lock"), lockfile)
                .map_err(|error| format!("stage approved mise lockfile: {error}"))?;
        }
        Ok(staged)
    }
}

fn mise_install_environment(stage: &Path) -> Result<BTreeMap<String, String>, String> {
    // Preserve the Host's tool discovery, install location and download
    // plumbing. All other inherited settings and project variables stay out.
    let mut env: BTreeMap<_, _> = [
        "PATH",
        "HOME",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "SystemRoot",
        "PATHEXT",
        "TMP",
        "TEMP",
        "TMPDIR",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "MISE_DATA_DIR",
        "MISE_CACHE_DIR",
        "MISE_STATE_DIR",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ]
    .into_iter()
    .filter_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| (name.to_owned(), value))
    })
    .collect();
    let parent = stage
        .parent()
        .ok_or("mise staging directory has no parent")?;
    let ceiling = std::env::join_paths([parent])
        .map_err(|error| format!("invalid mise configuration ceiling: {error}"))?;
    env.extend(
        [
            ("MISE_SAFE", "1"),
            ("MISE_NO_HOOKS", "1"),
            ("MISE_ENV", ""),
            ("MISE_AUTO_ENV", "0"),
            ("MISE_ENV_CONF_D", "0"),
        ]
        .map(|(name, value)| (name.to_owned(), value.to_owned())),
    );
    for (name, path) in [
        ("MISE_CONFIG_DIR", stage.join("global")),
        ("MISE_SYSTEM_CONFIG_DIR", stage.join("system")),
        ("MISE_GLOBAL_CONFIG_FILE", stage.join("global/config.toml")),
        ("MISE_SYSTEM_CONFIG_FILE", stage.join("system/config.toml")),
        ("MISE_CEILING_PATHS", PathBuf::from(ceiling)),
    ] {
        env.insert(
            name.into(),
            path.into_os_string()
                .into_string()
                .map_err(|_| "mise staging path is not UTF-8")?,
        );
    }
    Ok(env)
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentNetworkMode {
    Off,
    Allowlist,
    #[default]
    On,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentPolicy {
    #[serde(default)]
    pub required_runtime_capabilities: Vec<String>,
    #[serde(default)]
    pub allowed_domains: Vec<String>,
    pub require_sandbox: Option<bool>,
    pub network: Option<EnvironmentNetworkMode>,
    #[serde(rename = "cacheKey")]
    pub _cache_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionHost {
    Local,
    Cloud,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EffectiveEnvironmentPolicy {
    require_sandbox: bool,
    network: EnvironmentNetworkPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum EnvironmentNetworkPolicy {
    Off,
    Allowlist { hosts: Vec<String> },
    On,
}

fn effective_policy(
    policy: Option<EnvironmentPolicy>,
    host: ExecutionHost,
) -> EffectiveEnvironmentPolicy {
    let policy = policy.unwrap_or_default();
    let mode = policy.network.unwrap_or_else(|| {
        if !policy.allowed_domains.is_empty() {
            EnvironmentNetworkMode::Allowlist
        } else if host == ExecutionHost::Cloud {
            EnvironmentNetworkMode::Off
        } else {
            EnvironmentNetworkMode::On
        }
    });
    let require_sandbox = host == ExecutionHost::Cloud
        || policy.require_sandbox.unwrap_or(false)
        || mode != EnvironmentNetworkMode::On
        || !policy.allowed_domains.is_empty()
        || policy
            .required_runtime_capabilities
            .iter()
            .any(|capability| capability == "sandbox");
    let network = match mode {
        EnvironmentNetworkMode::Off => EnvironmentNetworkPolicy::Off,
        EnvironmentNetworkMode::Allowlist if policy.allowed_domains.is_empty() => {
            EnvironmentNetworkPolicy::Off
        }
        EnvironmentNetworkMode::Allowlist => EnvironmentNetworkPolicy::Allowlist {
            hosts: policy.allowed_domains,
        },
        EnvironmentNetworkMode::On => EnvironmentNetworkPolicy::On,
    };
    EffectiveEnvironmentPolicy {
        require_sandbox,
        network,
    }
}

fn valid_environment_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte == b'_' || byte.is_ascii_alphanumeric() && (index > 0 || !byte.is_ascii_digit())
        })
}

fn resolve_keyring_ref(value: &str) -> (&str, &str) {
    value
        .split_once(':')
        .filter(|(namespace, credential)| !namespace.is_empty() && !credential.is_empty())
        .unwrap_or((DEFAULT_KEYRING_NAMESPACE, value))
}

fn redact(mut value: String, secrets: &[String]) -> String {
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        value = value.replace(secret, "[REDACTED]");
    }
    value
}

fn shell_argv(script: String, inherit_environment: bool) -> Vec<String> {
    if cfg!(target_os = "windows") {
        let mut args = vec!["cmd".into()];
        if !inherit_environment {
            args.push("/D".into());
        }
        args.extend(["/C".into(), script]);
        args
    } else {
        vec!["sh".into(), "-c".into(), script]
    }
}

fn sandbox_network(policy: EnvironmentNetworkPolicy) -> NetworkPolicy {
    match policy {
        EnvironmentNetworkPolicy::Off => NetworkPolicy::Off,
        EnvironmentNetworkPolicy::Allowlist { hosts } => NetworkPolicy::Allowlist { hosts },
        EnvironmentNetworkPolicy::On => NetworkPolicy::On,
    }
}

/// Packaged sidecars are beside the host executable; development helpers
/// live in the same workspace target tree. Existing caller PATH comes last.
fn bootstrap_search_path(inherited: Option<std::ffi::OsString>) -> std::ffi::OsString {
    let mut paths = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            paths.push(parent.to_path_buf());
        }
    }
    if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        paths.push(root.join("target/debug"));
        paths.push(root.join("target/release"));
    }
    if let Some(inherited) = inherited {
        paths.extend(std::env::split_paths(&inherited));
    }
    std::env::join_paths(paths).unwrap_or_default()
}

fn bootstrap_executable(
    cwd: &std::path::Path,
    variables: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    if !variables.contains_key("COGNIA_BOOTSTRAP_CONFIG") {
        return None;
    }
    let binary = variables
        .get("COGNIA_BOOTSTRAP_BINARY")
        .map(String::as_str)
        .unwrap_or("cognia-bootstrap");
    let name = std::path::Path::new(binary);
    let candidates = if name.is_absolute() {
        vec![name.to_path_buf()]
    } else if name.components().count() > 1 {
        vec![cwd.join(name)]
    } else {
        std::env::split_paths(variables.get("PATH").map(String::as_str).unwrap_or(""))
            .map(|root| root.join(name))
            .collect()
    };
    candidates
        .into_iter()
        .find_map(|candidate| candidate.canonicalize().ok().filter(|path| path.is_file()))
}

async fn execute_on_host<F, R>(
    script: EnvironmentScript,
    cwd: String,
    variables: BTreeMap<String, String>,
    keyring_references: Vec<EnvironmentKeyringReference>,
    policy: Option<EnvironmentPolicy>,
    timeout_secs: Option<u64>,
    host: ExecutionHost,
    resolve_workspace_env: impl FnOnce(cognia_core::workspace_env::WorkspaceEnvQuery) -> R,
    run_sandbox: impl FnOnce(SandboxCommand, SandboxPolicy) -> F,
) -> Result<ShellResult, String>
where
    R: std::future::Future<Output = Result<Option<BTreeMap<String, String>>, String>>,
    F: std::future::Future<
            Output = Result<
                cognia_exec_sandbox::types::SandboxResult,
                cognia_exec_sandbox::types::SandboxError,
            >,
        >,
{
    let staged_mise = match &script {
        EnvironmentScript::Mise { mise } => {
            if !Path::new(&cwd).is_dir() {
                return Err("mise setup requires a workspace directory".into());
            }
            if !variables.is_empty() || !keyring_references.is_empty() {
                return Err(
                    "mise setup does not accept project variables or keyring references".into(),
                );
            }
            Some(mise.stage()?)
        }
        _ => None,
    };
    let script = script.resolve_for(std::env::consts::OS);
    if script.is_empty() {
        return Err(format!(
            "project environment has no script for host OS: {}",
            std::env::consts::OS
        ));
    }

    let mut environment = BTreeMap::new();
    for (name, value) in variables {
        if !valid_environment_name(&name) {
            return Err(format!("invalid environment variable name: {name}"));
        }
        environment.insert(name, value);
    }
    let mut secrets = Vec::new();
    for reference in keyring_references {
        if !valid_environment_name(&reference.variable) {
            return Err(format!(
                "invalid environment variable name: {}",
                reference.variable
            ));
        }
        if environment.contains_key(&reference.variable) {
            return Err(format!(
                "environment variable cannot be plain and keyring-backed: {}",
                reference.variable
            ));
        }
        let (namespace, credential) = resolve_keyring_ref(&reference.keyring_ref);
        let secret = cognia_connectors::keyring::get(namespace, credential)?
            .ok_or_else(|| format!("missing keyring reference: {}", reference.keyring_ref))?;
        environment.insert(reference.variable, secret.clone());
        secrets.push(secret);
    }

    if environment.contains_key("COGNIA_BOOTSTRAP_CONFIG") {
        let inherited = environment
            .remove("PATH")
            .map(std::ffi::OsString::from)
            .or_else(|| std::env::var_os("PATH"));
        environment.insert(
            "PATH".into(),
            bootstrap_search_path(inherited).to_string_lossy().into(),
        );
    }
    // Resolve after renderer variables and keyring values, before either spawn path.
    if let Some(trusted) = resolve_workspace_env(cognia_core::workspace_env::WorkspaceEnvQuery {
        cwd: PathBuf::from(&cwd),
        workspace_id: None,
        namespace: cognia_core::workspace_env::HOST_LOOPBACK_NAMESPACE.into(),
    })
    .await
    .map_err(|error| format!("project environment workspace ports: {error}"))?
    {
        environment.extend(trusted);
    }
    let inherit_environment = staged_mise.is_none();
    let workspace_root = PathBuf::from(&cwd);
    let cwd = if let Some(stage) = &staged_mise {
        let path = stage
            .path()
            .canonicalize()
            .map_err(|error| format!("resolve mise staging directory: {error}"))?;
        environment = mise_install_environment(&path)?;
        path.into_os_string()
            .into_string()
            .map_err(|_| "mise staging path is not UTF-8")?
    } else {
        cwd
    };
    let effective = effective_policy(policy, host);
    let mut result = if !effective.require_sandbox {
        tokio::task::spawn_blocking(move || {
            shell_exec_with_env_timeout_cap(
                script,
                cwd,
                timeout_secs,
                environment,
                MAX_TIMEOUT_SECS,
                inherit_environment,
            )
        })
        .await
        .map_err(|error| format!("project environment worker failed: {error}"))??
    } else {
        let cwd = PathBuf::from(cwd);
        let mut writable = vec![workspace_root];
        if !inherit_environment {
            writable.push(cwd.clone());
        }
        let mut readable = writable.clone();
        if let Some(binary) = bootstrap_executable(&cwd, &environment) {
            readable.push(binary);
        }
        let timeout = timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS);
        let command = SandboxCommand {
            argv: shell_argv(script, inherit_environment),
            cwd: cwd.clone(),
            env: environment,
            stdin: None,
            timeout: Duration::from_secs(timeout),
        };
        let sandbox_policy = SandboxPolicy::Bash {
            writable,
            readable,
            network: sandbox_network(effective.network),
            max_cpu_seconds: timeout.min(u32::MAX as u64) as u32,
            max_memory_mb: 2048,
            max_processes: cognia_exec_sandbox::policy::BASH_DEFAULT_MAX_PROCESSES,
        };
        match run_sandbox(command, sandbox_policy).await {
            Ok(result) => ShellResult {
                stdout: result.stdout,
                stderr: result.stderr,
                exit_code: Some(result.exit_code),
                timed_out: result.timed_out,
                stdout_truncated: false,
                stderr_truncated: false,
            },
            Err(cognia_exec_sandbox::types::SandboxError::Timeout { .. }) => ShellResult {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                timed_out: true,
                stdout_truncated: false,
                stderr_truncated: false,
            },
            Err(error) => return Err(error.to_string()),
        }
    };
    result.stdout = redact(result.stdout, &secrets);
    result.stderr = redact(result.stderr, &secrets);
    Ok(result)
}

/// Executes a project environment on the local desktop host. The shared
/// implementation also backs Companion/headless RPC; secret values never
/// cross the renderer or remote transport boundary.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn project_environment_execute(
    script: EnvironmentScript,
    cwd: String,
    variables: BTreeMap<String, String>,
    keyring_references: Vec<EnvironmentKeyringReference>,
    policy: Option<EnvironmentPolicy>,
    timeout_secs: Option<u64>,
) -> Result<ShellResult, String> {
    execute_on_host(
        script,
        cwd,
        variables,
        keyring_references,
        policy,
        timeout_secs,
        ExecutionHost::Local,
        cognia_core::workspace_env::resolve_workspace_env_async,
        cognia_exec_sandbox::run_confined,
    )
    .await
}

pub async fn project_environment_execute_cloud(
    script: EnvironmentScript,
    cwd: String,
    variables: BTreeMap<String, String>,
    keyring_references: Vec<EnvironmentKeyringReference>,
    policy: Option<EnvironmentPolicy>,
    timeout_secs: Option<u64>,
) -> Result<ShellResult, String> {
    execute_on_host(
        script,
        cwd,
        variables,
        keyring_references,
        policy,
        timeout_secs,
        ExecutionHost::Cloud,
        cognia_core::workspace_env::resolve_workspace_env_async,
        cognia_exec_sandbox::run_confined,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mise_executes_only_the_approved_snapshot_in_private_project_scope() {
        let workspace = tempfile::tempdir().unwrap();
        let config = "[tools]\nnode = \"24\"\n";
        let lockfile = "approved lockfile";
        std::fs::write(
            workspace.path().join("mise.toml"),
            "[tools]\nnode = \"22\"\n",
        )
        .unwrap();
        std::fs::write(
            workspace.path().join(".mise.toml"),
            "[tools]\nnode = \"20\"\n",
        )
        .unwrap();
        let script = serde_json::from_value(serde_json::json!({
            "default": "echo cognia-setup-notice:miseIsolationUnavailable",
            "mise": { "config": config, "lockfile": lockfile }
        }))
        .unwrap();
        let staging_path = std::sync::Mutex::new(None);
        let result = execute_on_host(
            script,
            workspace.path().to_string_lossy().into(),
            BTreeMap::new(),
            vec![],
            None,
            Some(5),
            ExecutionHost::Cloud,
            |query| {
                assert_eq!(query.cwd, workspace.path());
                async { Ok(Some(workspace_ports())) }
            },
            |command, policy| {
                let stage = &command.cwd;
                assert!(!stage.starts_with(workspace.path()));
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    assert_eq!(
                        std::fs::metadata(stage).unwrap().permissions().mode() & 0o077,
                        0
                    );
                }
                assert_eq!(
                    std::fs::read_to_string(stage.join("mise.toml")).unwrap(),
                    config
                );
                assert_eq!(
                    std::fs::read_to_string(stage.join("mise.lock")).unwrap(),
                    lockfile
                );
                assert!(!stage.join(".mise.toml").exists());
                assert_eq!(command.env["MISE_SAFE"], "1");
                assert_eq!(command.env["MISE_ENV"], "");
                assert_eq!(
                    std::env::split_paths(&command.env["MISE_CEILING_PATHS"]).collect::<Vec<_>>(),
                    vec![stage.parent().unwrap().to_path_buf()]
                );
                for key in [
                    "MISE_CONFIG_DIR",
                    "MISE_GLOBAL_CONFIG_FILE",
                    "MISE_SYSTEM_CONFIG_FILE",
                ] {
                    assert!(Path::new(&command.env[key]).starts_with(stage));
                }
                assert!(!command.env.contains_key("MISE_NODE_VERSION"));
                assert!(!command.env.contains_key("PORT"));
                assert!(
                    command
                        .argv
                        .last()
                        .unwrap()
                        .contains("mise settings get safe")
                );
                assert!(command.argv.last().unwrap().contains("mise install"));
                assert!(matches!(
                    policy, SandboxPolicy::Bash { writable, .. }
                    if writable == [workspace.path().to_path_buf(), stage.clone()]
                ));
                *staging_path.lock().unwrap() = Some(stage.clone());
                std::future::ready(Ok(cognia_exec_sandbox::types::SandboxResult {
                    network: Default::default(),
                    exit_code: 0,
                    stdout: String::new(),
                    stderr: String::new(),
                    duration: Duration::ZERO,
                    timed_out: false,
                    stdout_truncated: false,
                    stderr_truncated: false,
                }))
            },
        )
        .await
        .unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert!(!staging_path.into_inner().unwrap().unwrap().exists());
    }

    fn script(source: String) -> EnvironmentScript {
        EnvironmentScript::Structured {
            default: source,
            by_os: BTreeMap::new(),
        }
    }

    fn workspace_ports() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("PORT".into(), "41000".into()),
            ("COGNIA_PORT".into(), "41000".into()),
            ("COGNIA_PORT_COUNT".into(), "10".into()),
        ])
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn plain_setup_receives_trusted_ports_and_refuses_resolution_errors() {
        let dir = tempfile::tempdir().unwrap();
        let result = execute_on_host(
            script(
                "printf '%s:%s:%s' \"$PORT\" \"$COGNIA_PORT\" \"$COGNIA_PORT_COUNT\"".into(),
            ),
            dir.path().to_string_lossy().into(),
            BTreeMap::from([("PORT".into(), "3000".into())]),
            vec![],
            None,
            Some(5),
            ExecutionHost::Local,
            |query| {
                assert_eq!(query.cwd, dir.path());
                assert_eq!(
                    query.namespace,
                    cognia_core::workspace_env::HOST_LOOPBACK_NAMESPACE
                );
                async {
                    tokio::task::yield_now().await;
                    Ok(Some(workspace_ports()))
                }
            },
            cognia_exec_sandbox::run_confined,
        )
        .await
        .unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "41000:41000:10");

        // No lease leaves the actual child environment unchanged, including
        // any explicitly requested PORT and the host's ambient values.
        for requested_port in [None, Some("3000")] {
            let variables = requested_port
                .map(|port| BTreeMap::from([("PORT".into(), port.into())]))
                .unwrap_or_default();
            let result = execute_on_host(
                script(
                    "printf '%s:%s:%s' \"${PORT-unset}\" \"${COGNIA_PORT-unset}\" \"${COGNIA_PORT_COUNT-unset}\"".into(),
                ),
                dir.path().to_string_lossy().into(),
                variables,
                vec![],
                None,
                Some(5),
                ExecutionHost::Local,
                |_| async { Ok(None) },
                cognia_exec_sandbox::run_confined,
            )
            .await
            .unwrap();
            let ambient = |name| std::env::var(name).unwrap_or_else(|_| "unset".into());
            assert_eq!(result.exit_code, Some(0));
            assert_eq!(
                result.stdout,
                format!(
                    "{}:{}:{}",
                    requested_port
                        .map(str::to_string)
                        .unwrap_or_else(|| ambient("PORT")),
                    ambient("COGNIA_PORT"),
                    ambient("COGNIA_PORT_COUNT"),
                )
            );
        }

        let error = execute_on_host(
            script("touch should-not-spawn".into()),
            dir.path().to_string_lossy().into(),
            BTreeMap::new(),
            vec![],
            None,
            Some(5),
            ExecutionHost::Local,
            |_| async { Err("port range exhausted".into()) },
            cognia_exec_sandbox::run_confined,
        )
        .await
        .unwrap_err();
        assert!(error.contains("port range exhausted"));
        assert!(!dir.path().join("should-not-spawn").exists());
    }

    #[tokio::test]
    async fn sandbox_setup_receives_trusted_ports_or_no_overlay_and_refuses_errors() {
        let dir = tempfile::tempdir().unwrap();
        for resolution in [
            Ok(Some(workspace_ports())),
            Ok(None),
            Err("store unavailable".into()),
        ] {
            let expected = resolution.clone();
            let captured = std::sync::Mutex::new(None);
            let result = execute_on_host(
                script("env".into()),
                dir.path().to_string_lossy().into(),
                if matches!(resolution, Ok(Some(_))) {
                    BTreeMap::from([("PORT".into(), "3000".into())])
                } else {
                    BTreeMap::new()
                },
                vec![],
                None,
                Some(5),
                ExecutionHost::Cloud,
                |_| async { resolution },
                |command, _policy| {
                    *captured.lock().unwrap() = Some(command);
                    std::future::ready(Ok(cognia_exec_sandbox::types::SandboxResult {
                        network: Default::default(),
                        exit_code: 0,
                        stdout: String::new(),
                        stderr: String::new(),
                        duration: Duration::ZERO,
                        timed_out: false,
                        stdout_truncated: false,
                        stderr_truncated: false,
                    }))
                },
            )
            .await;
            let command = captured.into_inner().unwrap();
            match expected {
                Ok(Some(environment)) => {
                    result.unwrap();
                    let command = command.unwrap();
                    assert_eq!(command.cwd, dir.path());
                    assert_eq!(command.env, environment);
                }
                Ok(None) => {
                    result.unwrap();
                    assert!(command.unwrap().env.is_empty());
                }
                Err(reason) => {
                    assert!(result.unwrap_err().contains(&reason));
                    assert!(command.is_none());
                }
            }
        }
    }

    #[test]
    fn bootstrap_sandbox_resolves_only_the_selected_executable() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("bootstrap with spaces");
        std::fs::write(&binary, "binary").unwrap();
        let mut variables = BTreeMap::from([
            ("COGNIA_BOOTSTRAP_CONFIG".into(), "{}".into()),
            (
                "COGNIA_BOOTSTRAP_BINARY".into(),
                "bootstrap with spaces".into(),
            ),
            ("PATH".into(), dir.path().to_string_lossy().into()),
        ]);
        assert_eq!(
            bootstrap_executable(dir.path(), &variables),
            Some(binary.canonicalize().unwrap())
        );
        variables.remove("COGNIA_BOOTSTRAP_CONFIG");
        assert!(bootstrap_executable(dir.path(), &variables).is_none());
    }

    #[test]
    fn bootstrap_path_preserves_caller_search_path() {
        let inherited = PathBuf::from("/custom/bin");
        let path = bootstrap_search_path(Some(inherited.clone().into_os_string()));
        let parts: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(parts.last(), Some(&inherited));
        assert!(MAX_TIMEOUT_SECS >= 600 + 5);
    }

    #[test]
    fn selects_script_for_the_execution_host() {
        let script = EnvironmentScript::Structured {
            default: "portable".into(),
            by_os: BTreeMap::from([
                ("macos".into(), "mac".into()),
                ("linux".into(), "linux".into()),
            ]),
        };
        assert_eq!(script.resolve_for("macos"), "mac");
        assert_eq!(script.resolve_for("windows"), "portable");
    }

    #[test]
    fn cloud_policy_is_sandboxed_and_network_off_by_default() {
        let policy = effective_policy(None, ExecutionHost::Cloud);
        assert!(policy.require_sandbox);
        assert_eq!(policy.network, EnvironmentNetworkPolicy::Off);
    }

    #[test]
    fn cloud_policy_reuses_the_existing_allowlist_shape() {
        let policy = effective_policy(
            Some(EnvironmentPolicy {
                allowed_domains: vec!["api.example.com".into()],
                ..EnvironmentPolicy::default()
            }),
            ExecutionHost::Cloud,
        );
        assert!(policy.require_sandbox);
        assert_eq!(
            policy.network,
            EnvironmentNetworkPolicy::Allowlist {
                hosts: vec!["api.example.com".into()]
            }
        );
    }

    #[test]
    fn local_network_restrictions_always_require_the_sandbox() {
        let network_off = effective_policy(
            Some(EnvironmentPolicy {
                network: Some(EnvironmentNetworkMode::Off),
                require_sandbox: Some(false),
                ..EnvironmentPolicy::default()
            }),
            ExecutionHost::Local,
        );
        assert!(network_off.require_sandbox);
        assert_eq!(network_off.network, EnvironmentNetworkPolicy::Off);

        let allowlist = effective_policy(
            Some(EnvironmentPolicy {
                allowed_domains: vec!["api.example.com".into()],
                require_sandbox: Some(false),
                ..EnvironmentPolicy::default()
            }),
            ExecutionHost::Local,
        );
        assert!(allowlist.require_sandbox);
        assert_eq!(
            allowlist.network,
            EnvironmentNetworkPolicy::Allowlist {
                hosts: vec!["api.example.com".into()]
            }
        );
    }

    #[test]
    fn validates_names_and_redacts_every_secret_occurrence() {
        assert!(valid_environment_name("API_TOKEN"));
        assert!(!valid_environment_name("1TOKEN"));
        assert!(!valid_environment_name("BAD-NAME"));
        assert_eq!(
            redact("token=secret and secret again".into(), &["secret".into()]),
            "token=[REDACTED] and [REDACTED] again"
        );
    }

    #[test]
    fn supports_namespaced_and_default_keyring_references() {
        assert_eq!(resolve_keyring_ref("adapter:token"), ("adapter", "token"));
        assert_eq!(
            resolve_keyring_ref("token"),
            (DEFAULT_KEYRING_NAMESPACE, "token")
        );
    }
}
