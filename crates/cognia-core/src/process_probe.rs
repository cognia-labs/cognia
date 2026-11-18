//! Bounded probes of an external program: `node --version`, the Bun identity
//! script, a Python interpreter's `--version`.
//!
//! A probe asks a program a question it should answer at once. Each one must
//! be bounded in two places: the program may not answer (a GUI app, a shim
//! waiting on something), and a launcher may exit while a descendant still
//! holds its stdout open, which would block the read after it. So a probe
//! runs in its own process group, gets a deadline, and has its group killed
//! before its output is collected.

use std::ffi::OsStr;
use std::fmt;
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use wait_timeout::ChildExt;

/// Why a probe produced no output.
#[derive(Debug)]
pub enum ProbeError {
    /// The program could not be started.
    Spawn(std::io::Error),
    /// It did not exit before the deadline. It has been killed.
    TimedOut(Duration),
    /// Waiting for it or collecting its output failed.
    Wait(std::io::Error),
}

impl fmt::Display for ProbeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(error) => write!(formatter, "could not start: {error}"),
            Self::TimedOut(timeout) => {
                write!(
                    formatter,
                    "no answer within {} seconds",
                    timeout.as_secs_f64()
                )
            }
            Self::Wait(error) => write!(formatter, "waiting failed: {error}"),
        }
    }
}

impl std::error::Error for ProbeError {}

/// A command that opens no console window on Windows. For probes and for the
/// helper processes they need (`taskkill`).
pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

/// Run `command` as a probe: stdin closed, in its own process group, killed
/// with whatever it started if it has not exited within `timeout`. The caller
/// chooses what happens to stdout and stderr (piped to read them, null to
/// ignore them). A non-zero exit is not an error here; the caller reads it
/// from the returned status.
pub fn run_probe(mut command: Command, timeout: Duration) -> Result<Output, ProbeError> {
    command.stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(ProbeError::Spawn)?;
    match child.wait_timeout(timeout) {
        Ok(Some(_)) => {}
        Ok(None) => {
            terminate_process_tree(&mut child);
            let _ = child.wait();
            return Err(ProbeError::TimedOut(timeout));
        }
        Err(error) => {
            terminate_process_tree(&mut child);
            let _ = child.wait();
            return Err(ProbeError::Wait(error));
        }
    }
    // A launcher can exit while a descendant still holds stdout open. Reap its
    // process group before collecting output, so EOF is bounded too.
    terminate_process_tree(&mut child);
    child.wait_with_output().map_err(ProbeError::Wait)
}

fn terminate_process_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        // The probe starts in its own process group, so a shim cannot leave a
        // descendant behind after the deadline expires.
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        if let Ok(mut taskkill) = background_command("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            if !matches!(taskkill.wait_timeout(Duration::from_secs(1)), Ok(Some(_))) {
                let _ = taskkill.kill();
                let _ = taskkill.wait();
            }
        }
    }
    let _ = child.kill();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::time::Instant;

    fn script(dir: &tempfile::TempDir, body: &str) -> PathBuf {
        let path = dir.path().join("probe");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn piped(path: &PathBuf) -> Command {
        let mut command = background_command(path);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        command
    }

    #[test]
    fn collects_both_streams_and_the_status() {
        let dir = tempfile::tempdir().unwrap();
        let path = script(&dir, "echo out; echo err >&2; exit 3");
        let output = run_probe(piped(&path), Duration::from_secs(5)).unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "out\n");
        assert_eq!(String::from_utf8_lossy(&output.stderr), "err\n");
        assert_eq!(output.status.code(), Some(3));
    }

    #[test]
    fn a_missing_program_does_not_start() {
        let command = piped(&PathBuf::from("/definitely/not/a/probe"));
        assert!(matches!(
            run_probe(command, Duration::from_secs(1)),
            Err(ProbeError::Spawn(_))
        ));
    }

    #[test]
    fn a_hanging_program_is_killed_at_the_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let path = script(&dir, "sleep 30");
        let started = Instant::now();
        assert!(matches!(
            run_probe(piped(&path), Duration::from_millis(50)),
            Err(ProbeError::TimedOut(_))
        ));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_descendant_holding_stdout_does_not_block_the_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = script(&dir, "sleep 30 &\necho done");
        let started = Instant::now();
        let output = run_probe(piped(&path), Duration::from_secs(5)).unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "done\n");
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
