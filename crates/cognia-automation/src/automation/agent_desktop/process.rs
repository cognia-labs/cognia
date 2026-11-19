//! Bounded, cancellable CLI children. No shell, global process lookup or replay.
use super::protocol::{self, Delivery, Envelope};
use crate::automation::{
    execution::Admission,
    types::{AutomationError, Result},
};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant};

const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const STDERR_LIMIT: usize = 64 * 1024;

struct OwnedChild(std::process::Child, Arc<AtomicBool>);
impl std::ops::Deref for OwnedChild {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let pid = self.0.id();
        let closed = match self.0.try_wait() {
            Ok(None) => terminate(&mut self.0, pid),
            Ok(Some(_)) => group_absent(pid),
            Err(_) => false,
        };
        if !closed {
            self.1.store(true, Ordering::SeqCst);
        }
    }
}

pub struct ExecutorLease {
    file: File,
}

impl ExecutorLease {
    pub fn acquire() -> Result<Self> {
        let directory = crate::automation::persist::dir().ok_or_else(protocol::incompatible)?;
        std::fs::create_dir_all(&directory).map_err(|_| protocol::incompatible())?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(directory.join("desktop-executor.lock"))
            .map_err(|_| protocol::incompatible())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let stat = file.metadata().map_err(|_| protocol::incompatible())?;
            if !stat.is_file()
                || stat.uid() != unsafe { libc::geteuid() }
                || stat.mode() & 0o077 != 0
                || stat.nlink() != 1
            {
                return Err(protocol::incompatible());
            }
        }
        fs2::FileExt::try_lock_exclusive(&file).map_err(|_| AutomationError::PermissionDenied {
            reason: "automation executor lease is held; old execution has not settled".into(),
        })?;
        Ok(Self { file })
    }
}

pub struct CliFailure {
    pub error: AutomationError,
    pub delivery: Delivery,
}
impl CliFailure {
    fn before(error: AutomationError) -> Self {
        Self {
            error,
            delivery: Delivery::NotDelivered,
        }
    }
    fn after(error: AutomationError) -> Self {
        Self {
            error,
            delivery: Delivery::Uncertain,
        }
    }
}

pub struct Client {
    binary: PathBuf,
    digest: String,
    lease: Arc<ExecutorLease>,
    pub quarantined: Arc<AtomicBool>,
}

impl Client {
    pub fn new(
        binary: PathBuf,
        lease: Arc<ExecutorLease>,
        private_directory: &Path,
    ) -> Result<Self> {
        let expected = option_env!("COGNIA_AGENT_DESKTOP_SHA256").unwrap_or("");
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) || expected.len() != 64 {
            return Err(protocol::incompatible());
        }
        let pin: serde_json::Value =
            serde_json::from_str(protocol::PIN).map_err(|_| protocol::incompatible())?;
        let receipt: serde_json::Value = serde_json::from_slice(
            &std::fs::read(binary.with_file_name("receipt.json"))
                .map_err(|_| protocol::incompatible())?,
        )
        .map_err(|_| protocol::incompatible())?;
        if receipt["sourceRevision"] != pin["sourceRevision"]
            || receipt["patchSha256"] != pin["patchSha256"]
            || receipt["profile"] != protocol::PROFILE
            || receipt["sha256"] != expected
        {
            return Err(protocol::incompatible());
        }
        let mut bytes = Vec::new();
        verify_binary(&binary, expected, Some(&mut bytes))?;
        let mut directory = std::fs::DirBuilder::new();
        directory.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory
            .create(private_directory)
            .map_err(|_| protocol::incompatible())?;
        let private_binary = private_directory.join("agent-desktop");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o500).custom_flags(libc::O_NOFOLLOW);
        }
        let mut copy = options
            .open(&private_binary)
            .map_err(|_| protocol::incompatible())?;
        copy.write_all(&bytes)
            .and_then(|_| copy.sync_all())
            .map_err(|_| protocol::incompatible())?;
        drop(copy);
        // The running owner uses this immutable copy, so an application update
        // cannot replace a bundle path between digest verification and exec.
        Ok(Self {
            binary: private_binary,
            digest: expected.into(),
            lease,
            quarantined: Arc::new(AtomicBool::new(false)),
        })
    }

    fn verify(&self) -> Result<()> {
        if self.quarantined.load(Ordering::SeqCst) {
            return Err(protocol::incompatible());
        }
        verify_binary(&self.binary, &self.digest, None)
    }

    pub fn run(
        &self,
        state: &Path,
        command: &str,
        arguments: &[String],
        input: Option<String>,
        admission: &Admission,
    ) -> std::result::Result<Envelope, CliFailure> {
        struct Propagate<'a>(&'a Admission, Arc<AtomicBool>);
        impl Drop for Propagate<'_> {
            fn drop(&mut self) {
                if self.1.load(Ordering::SeqCst) {
                    self.0.quarantine();
                }
            }
        }
        let _propagate = Propagate(admission, self.quarantined.clone());
        if !matches!(
            command,
            "version"
                | "permissions"
                | "list-windows"
                | "snapshot"
                | "click"
                | "set-value"
                | "toggle"
        ) {
            return Err(CliFailure::before(protocol::incompatible()));
        }
        self.verify().map_err(CliFailure::before)?;
        admission.check().map_err(CliFailure::before)?;
        if input
            .as_ref()
            .is_some_and(|text| text.len() > 128 * 1024 || text.contains('\0'))
        {
            return Err(CliFailure::before(protocol::incompatible()));
        }
        std::fs::create_dir_all(state).map_err(|_| CliFailure::before(protocol::incompatible()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(state, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| CliFailure::before(protocol::incompatible()))?;
        }
        let mut program = Command::new(&self.binary);
        program
            .arg(command)
            .args(arguments)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("AGENT_DESKTOP_HOME", state)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::process::CommandExt;
            let descriptor = self.lease.file.as_raw_fd();
            program.env("COGNIA_AUTOMATION_LEASE_FD", descriptor.to_string());
            unsafe {
                program.pre_exec(move || {
                    if libc::setsid() < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    let flags = libc::fcntl(descriptor, libc::F_GETFD);
                    if flags < 0
                        || libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                    {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let journal = state.join("executor.json");
        let mut intent = serde_json::json!({
            "schemaVersion": 1,
            "operationId": uuid::Uuid::new_v4().to_string(),
            "phase": "prepared",
            "command": command,
            "binarySha256": self.digest,
            "preparedAt": crate::automation::commands::now_ms(),
        });
        crate::automation::persist::write_json(&journal, &intent)
            .map_err(|_| CliFailure::before(protocol::incompatible()))?;
        let mut child = admission
            .start(|| {
                let child = OwnedChild(
                    program.spawn().map_err(|_| protocol::incompatible())?,
                    self.quarantined.clone(),
                );
                Ok(child)
            })
            .map_err(CliFailure::before)?;
        let pid = child.id();
        intent["phase"] = "started".into();
        intent["pid"] = pid.into();
        intent["processGroup"] = pid.into();
        intent["startedAt"] = crate::automation::commands::now_ms().into();
        if crate::automation::persist::write_json(&journal, &intent).is_err() {
            if !terminate(&mut child, pid) {
                self.quarantined.store(true, Ordering::SeqCst);
            }
            return Err(CliFailure::after(protocol::incompatible()));
        }
        let overflow = Arc::new(AtomicBool::new(false));
        let stdout = bounded_reader(child.stdout.take(), OUTPUT_LIMIT, overflow.clone());
        let stderr = bounded_reader(child.stderr.take(), STDERR_LIMIT, overflow.clone());
        if let (Some(mut stdin), Some(text)) = (child.stdin.take(), input) {
            std::thread::spawn(move || {
                let _ = stdin.write_all(text.as_bytes());
            });
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        let exit = loop {
            if admission.check().is_err()
                || Instant::now() >= deadline
                || overflow.load(Ordering::SeqCst)
            {
                let terminated = terminate(&mut child, pid);
                let stdout_closed = stdout.recv_timeout(Duration::from_millis(250)).is_ok();
                let stderr_closed = stderr.recv_timeout(Duration::from_millis(250)).is_ok();
                if terminated && stdout_closed && stderr_closed {
                    let _ = std::fs::remove_file(&journal);
                } else {
                    self.quarantined.store(true, Ordering::SeqCst);
                }
                return Err(CliFailure::after(protocol::incompatible()));
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(_) => {
                    // A wait error no longer proves this PID is our child.
                    // Preserve the lease/journal and do not signal a reused ID.
                    self.quarantined.store(true, Ordering::SeqCst);
                    return Err(CliFailure::after(protocol::incompatible()));
                }
            }
        };
        if !group_absent(pid) {
            self.quarantined.store(true, Ordering::SeqCst);
            return Err(CliFailure::after(protocol::incompatible()));
        }
        let output = stdout.recv_timeout(Duration::from_millis(250));
        let error_output = stderr.recv_timeout(Duration::from_millis(250));
        let (output, error_output) = match (output, error_output) {
            (Ok(output), Ok(error_output)) => (output, error_output),
            _ => {
                self.quarantined.store(true, Ordering::SeqCst);
                return Err(CliFailure::after(protocol::incompatible()));
            }
        };
        let _ = std::fs::remove_file(&journal);
        let output = output.map_err(|_| CliFailure::after(protocol::incompatible()))?;
        error_output.map_err(|_| CliFailure::after(protocol::incompatible()))?;
        if overflow.load(Ordering::SeqCst) {
            return Err(CliFailure::after(protocol::incompatible()));
        }
        let envelope = Envelope::parse(&output, command).map_err(CliFailure::after)?;
        if exit.success() != envelope.ok {
            return Err(CliFailure::after(protocol::incompatible()));
        }
        Ok(envelope)
    }
}

/// Hash every executable byte; retain bytes only when creating the private copy.
fn verify_binary(path: &Path, expected: &str, mut copy: Option<&mut Vec<u8>>) -> Result<()> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(path).map_err(|_| protocol::incompatible())?;
    let metadata = file.metadata().map_err(|_| protocol::incompatible())?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
        return Err(protocol::incompatible());
    }
    let mut digest = Sha256::new();
    let mut length = 0usize;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| protocol::incompatible())?;
        if count == 0 {
            break;
        }
        length += count;
        if length > 64 * 1024 * 1024 {
            return Err(protocol::incompatible());
        }
        digest.update(&buffer[..count]);
        if let Some(copy) = copy.as_mut() {
            copy.extend_from_slice(&buffer[..count]);
        }
    }
    if format!("{:x}", digest.finalize()) != expected {
        return Err(protocol::incompatible());
    }
    Ok(())
}

fn bounded_reader<R: Read + Send + 'static>(
    reader: Option<R>,
    limit: usize,
    overflow: Arc<AtomicBool>,
) -> mpsc::Receiver<std::io::Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let result = (|| {
            if let Some(mut reader) = reader {
                let mut chunk = [0u8; 8192];
                loop {
                    let count = reader.read(&mut chunk)?;
                    if count == 0 {
                        break;
                    }
                    if output.len() + count > limit {
                        overflow.store(true, Ordering::SeqCst);
                        break;
                    }
                    output.extend_from_slice(&chunk[..count]);
                }
            }
            Ok(output)
        })();
        let _ = sender.send(result);
    });
    receiver
}

fn terminate(child: &mut std::process::Child, pid: u32) -> bool {
    match child.try_wait() {
        Ok(None) => {}
        Ok(Some(_)) => return group_absent(pid),
        Err(_) => return false,
    }
    cognia_exec_sandbox::proc_group::kill_process_group(Some(pid));
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_millis(1500);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => return false,
        }
    }
    #[cfg(unix)]
    {
        while Instant::now() < deadline {
            if group_absent(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn group_absent(pid: u32) -> bool {
    #[cfg(unix)]
    {
        (unsafe { libc::kill(-(pid as i32), 0) }) != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streamed_executable_check_and_private_copy_use_the_same_complete_digest() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("candidate");
        let bytes = vec![7u8; 128 * 1024 + 1];
        let expected = format!("{:x}", Sha256::digest(&bytes));
        std::fs::write(&path, &bytes).unwrap();
        verify_binary(&path, &expected, None).unwrap();
        let mut copy = Vec::new();
        verify_binary(&path, &expected, Some(&mut copy)).unwrap();
        assert_eq!(copy, bytes);
        std::fs::write(&path, b"changed executable").unwrap();
        assert!(verify_binary(&path, &expected, None).is_err());
        assert!(verify_binary(&path, &expected, Some(&mut Vec::new())).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn executable_check_does_not_follow_a_symlink() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let link = directory.path().join("link");
        std::fs::write(&source, b"candidate").unwrap();
        std::os::unix::fs::symlink(source, &link).unwrap();
        let expected = format!("{:x}", Sha256::digest(b"candidate"));
        assert!(verify_binary(&link, &expected, None).is_err());
    }

    #[test]
    fn output_is_bounded_without_echoing_sensitive_bytes() {
        let overflow = Arc::new(AtomicBool::new(false));
        let result = bounded_reader(
            Some(std::io::Cursor::new(vec![1; OUTPUT_LIMIT + 1])),
            OUTPUT_LIMIT,
            overflow.clone(),
        )
        .recv()
        .unwrap()
        .unwrap();
        assert!(overflow.load(Ordering::SeqCst));
        assert!(result.len() <= OUTPUT_LIMIT);
    }
}
