//! Opt-in JavaScript runtimes for the brain and sidecar only.
//!
//! Keep this separate from `node_runtime`: native bridges and other Node-only
//! children must continue to receive the verified Node executable.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use wait_timeout::ChildExt;

const BUN_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const BUN_IDENTITY_SCRIPT: &str =
    "process.stdout.write('cognia-bun:' + (process.versions.bun || 'not-bun'))";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeError(String);

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for RuntimeError {}
impl From<String> for RuntimeError {
    fn from(message: String) -> Self {
        Self(message)
    }
}
impl From<&str> for RuntimeError {
    fn from(message: &str) -> Self {
        Self(message.to_owned())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeKind {
    Node,
    Bun,
}

impl RuntimeKind {
    /// Host-provided environment is authoritative for either supervised role.
    pub fn launch_args(self) -> &'static [&'static str] {
        match self {
            Self::Node => &[],
            Self::Bun => &["--no-env-file"],
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum RuntimeRole {
    Brain,
    Sidecar,
}

impl RuntimeRole {
    pub fn env_name(self) -> &'static str {
        match self {
            Self::Brain => "COGNIA_BRAIN_RUNTIME",
            Self::Sidecar => "COGNIA_SIDECAR_RUNTIME",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JavaScriptRuntime {
    pub kind: RuntimeKind,
    pub executable: PathBuf,
    pub version: String,
}

#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub preference: RuntimeKind,
    pub bun_executable: PathBuf,
}

impl RuntimeConfig {
    pub fn parse(
        preference: Option<&str>,
        bun_executable: Option<PathBuf>,
    ) -> Result<Self, RuntimeError> {
        let preference = match preference.unwrap_or("node").trim() {
            "node" => RuntimeKind::Node,
            "bun" => RuntimeKind::Bun,
            value => {
                return Err(
                    format!("unknown JavaScript runtime {value:?}; expected node or bun").into(),
                )
            }
        };
        Ok(Self {
            preference,
            bun_executable: bun_executable.unwrap_or_else(|| PathBuf::from("bun")),
        })
    }

    pub fn from_env(role: RuntimeRole) -> Result<Self, RuntimeError> {
        let preference = match std::env::var(role.env_name()) {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => None,
            Err(_) => return Err(format!("{} must be UTF-8", role.env_name()).into()),
        };
        let bun_executable = std::env::var_os("COGNIA_BUN_EXECUTABLE").map(PathBuf::from);
        if bun_executable
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
        {
            return Err("COGNIA_BUN_EXECUTABLE must be an absolute path".into());
        }
        Self::parse(preference.as_deref(), bun_executable)
    }

    /// `None` keeps the host's existing Node selection and validation path.
    pub fn preferred_bun(&self) -> Result<Option<JavaScriptRuntime>, RuntimeError> {
        if self.preference == RuntimeKind::Node {
            return Ok(None);
        }
        self.probe_bun(BUN_PROBE_TIMEOUT).map(Some)
    }

    fn probe_bun(&self, timeout: Duration) -> Result<JavaScriptRuntime, RuntimeError> {
        let executable = if self.bun_executable.is_absolute() {
            self.bun_executable.canonicalize().ok()
        } else {
            std::env::var_os("PATH").and_then(|paths| {
                std::env::split_paths(&paths).find_map(|directory| {
                    let candidate = directory.join(if cfg!(windows) { "bun.exe" } else { "bun" });
                    candidate.canonicalize().ok().filter(|path| path.is_file())
                })
            })
        }
        .ok_or("Bun probe failed: executable could not be resolved")?;
        let mut command = std::process::Command::new(&executable);
        command
            .args(["--eval", BUN_IDENTITY_SCRIPT, "--no-env-file"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Bun probe failed: {error}"))?;
        match child.wait_timeout(timeout) {
            Ok(Some(_)) => {}
            result => {
                crate::node_runtime::terminate_probe_process_tree(&mut child);
                let _ = child.wait();
                return Err(match result {
                    Ok(None) => "Bun probe timed out".into(),
                    Err(error) => format!("Bun probe wait failed: {error}").into(),
                    _ => unreachable!(),
                });
            }
        }
        // A launcher can exit while a descendant still holds stdout open.
        // Reap its process group before collecting output, so EOF is bounded too.
        crate::node_runtime::terminate_probe_process_tree(&mut child);
        let output = child
            .wait_with_output()
            .map_err(|error| error.to_string())?;
        let version = String::from_utf8_lossy(&output.stdout);
        let version = version
            .trim()
            .strip_prefix("cognia-bun:")
            .filter(|_| output.status.success())
            .ok_or("Bun probe did not return a valid runtime identity")?;
        let parts: Vec<_> = version.split('.').map(str::parse::<u64>).collect();
        let supported = matches!(parts.as_slice(), [Ok(major), Ok(minor), Ok(patch)]
            if (*major, *minor, *patch) >= (1, 4, 0));
        if !supported {
            return Err("Bun 1.4.0 or newer is required".into());
        }
        Ok(JavaScriptRuntime {
            kind: RuntimeKind::Bun,
            executable,
            version: version.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_remains_default_and_does_not_probe_bun() {
        let config = RuntimeConfig::parse(None, Some("/missing/bun".into())).unwrap();
        assert_eq!(config.preference, RuntimeKind::Node);
        assert_eq!(config.preferred_bun().unwrap(), None);
        assert!(RuntimeConfig::parse(Some("deno"), None).is_err());
    }

    #[test]
    fn roles_have_independent_opt_in_settings() {
        assert_eq!(RuntimeRole::Brain.env_name(), "COGNIA_BRAIN_RUNTIME");
        assert_eq!(RuntimeRole::Sidecar.env_name(), "COGNIA_SIDECAR_RUNTIME");
    }

    #[test]
    fn launch_policy_keeps_node_flags_empty_and_host_environment_authoritative() {
        assert!(RuntimeKind::Node.launch_args().is_empty());
        assert_eq!(RuntimeKind::Bun.launch_args(), ["--no-env-file"]);
    }

    #[test]
    fn actual_bun_uses_only_the_explicit_host_environment() {
        let Some(bun) = std::env::var_os("COGNIA_TEST_BUN") else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env.local"),
            "COGNIA_DOTENV_FIXTURE=unexpected\n",
        )
        .unwrap();
        let output = std::process::Command::new(&bun)
                .args(RuntimeKind::Bun.launch_args())
                .args(["--eval", "if(process.env.COGNIA_DOTENV_FIXTURE)throw Error('ambient dotenv loaded');process.stdout.write('host-env-only')"])
                .env_remove("COGNIA_DOTENV_FIXTURE")
                .current_dir(dir.path())
                .output()
                .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout), "host-env-only");
    }

    #[cfg(unix)]
    #[test]
    fn bun_opt_in_validates_identity_and_minimum_version() {
        let _guard = crate::node_runtime::EXECUTABLE_SCRIPT_LOCK.lock().unwrap();
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("bun with spaces");
        std::fs::write(&executable, "#!/bin/sh\nprintf 'cognia-bun:1.4.0'\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = RuntimeConfig::parse(Some("bun"), Some(executable.clone()))
            .unwrap()
            .preferred_bun()
            .unwrap()
            .expect("Bun opt-in must select Bun");
        assert_eq!(runtime.kind, RuntimeKind::Bun);
        assert_eq!(runtime.executable, executable.canonicalize().unwrap());
        assert_eq!(runtime.version, "1.4.0");
        for output in [
            "cognia-bun:1.3.9",
            "cognia-bun:not-bun",
            "v26.3.1",
            "cognia-bun:1.4.0-beta",
        ] {
            std::fs::write(&executable, format!("#!/bin/sh\nprintf '{output}'\n")).unwrap();
            assert!(
                RuntimeConfig::parse(Some("bun"), Some(executable.clone()))
                    .unwrap()
                    .preferred_bun()
                    .is_err(),
                "accepted {output}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn missing_or_hanging_bun_returns_a_bounded_fallback_reason() {
        let _guard = crate::node_runtime::EXECUTABLE_SCRIPT_LOCK.lock().unwrap();
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("bun");
        let config = RuntimeConfig::parse(Some("bun"), Some(executable.clone())).unwrap();
        assert!(config
            .preferred_bun()
            .unwrap_err()
            .to_string()
            .contains("probe failed"));
        std::fs::write(&executable, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let started = std::time::Instant::now();
        assert!(config
            .probe_bun(Duration::from_millis(30))
            .unwrap_err()
            .to_string()
            .contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
        std::fs::write(
            &executable,
            "#!/bin/sh\nsleep 30 &\nprintf 'cognia-bun:1.4.0'\nexit 0\n",
        )
        .unwrap();
        let started = std::time::Instant::now();
        config
            .probe_bun(Duration::from_millis(500))
            .expect("exited launcher must not leave its stdout reader blocked");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "inherited stdout exceeded the probe deadline"
        );
    }
}
