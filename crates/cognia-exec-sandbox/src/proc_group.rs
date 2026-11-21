//! Cross-platform process-tree helpers for spawned commands and external agents.
//!
//! On Unix a spawned child is placed in its own process group at spawn
//! (`process_group(0)` → pgid == child pid) and the whole group is signalled on
//! termination (`killpg`). On Windows:
//! - [`windows_job::WindowsJobChild`] launches commands suspended inside a
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` Job Object before resuming the leader,
//!   so grandchildren cannot escape tree termination or hold inherited pipe
//!   handles open past timeout/exit/cancellation.
//! - [`kill_process_group`] issues a bounded `taskkill /PID <pid> /T /F`
//!   fallback for callers that hold only a raw PID without a Job Object handle.

use std::collections::BTreeMap;
use std::time::Duration;
use tokio::process::Command;

/// Configure `cmd` so the spawned child leads its own process group. No-op on
/// non-Unix platforms (use [`windows_job::WindowsJobChild`] when strict
/// tree-level lifecycle control is required on Windows).
pub fn apply_process_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        // 0 → a new group whose id equals the child's pid; mirrors std's
        // `CommandExt::process_group` and is honored by tokio's `Command`.
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
}

/// Terminate the process tree led by `pid`.
///
/// - On Unix: sends `SIGKILL` to the process group led by `pid`. Best-effort:
///   an already-reaped group (`ESRCH`) is ignored.
/// - On Windows: runs a bounded `taskkill /PID <pid> /T /F` without opening a
///   console window. Callers that need death confirmation even after the leader
///   exits should spawn inside [`windows_job::WindowsJobChild`] instead.
pub fn kill_process_group(pid: Option<u32>) {
    #[cfg(unix)]
    {
        if let Some(pid) = pid {
            // SAFETY: `killpg` is async-signal-safe and takes no Rust state.
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(pid) = pid {
            use std::os::windows::process::CommandExt;
            use std::process::Stdio;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            if let Ok(mut taskkill) = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                let deadline = std::time::Instant::now() + Duration::from_secs(1);
                loop {
                    match taskkill.try_wait() {
                        Ok(Some(_)) => break,
                        Ok(None) if std::time::Instant::now() < deadline => {
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        _ => {
                            let _ = taskkill.kill();
                            let _ = taskkill.wait();
                            break;
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
    }
}

/// Stop an owned Unix process group from a blocking context and wait until
/// `killpg(pid, 0)` reports `ESRCH` or `budget` elapses. Returns `true` when
/// disappearance of the group was positively confirmed.
#[cfg(unix)]
pub fn kill_process_group_and_wait_blocking(pid: Option<u32>, budget: Duration) -> bool {
    let Some(pid) = pid else {
        return true;
    };
    kill_process_group(Some(pid));
    let deadline = std::time::Instant::now() + budget;
    loop {
        // SAFETY: signal zero probes only the group we created for this run.
        if unsafe { libc::killpg(pid as libc::pid_t, 0) } != 0 {
            return std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Stop an owned Unix group and positively observe its disappearance before
/// its writable workspace can be reset or released. Signalling alone is not
/// evidence that a background writer has finished.
#[cfg(unix)]
pub async fn kill_process_group_and_wait(pid: Option<u32>, budget: Duration) -> Result<(), String> {
    let Some(pid) = pid else {
        return Ok(());
    };
    kill_process_group(Some(pid));
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        // SAFETY: signal zero probes only the group we created for this run.
        if unsafe { libc::killpg(pid as libc::pid_t, 0) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            return Err(format!("process group stop could not be observed: {error}"));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("process group {pid} stop is unproven"));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Build the `cmd.exe` command line for a Windows shell script.
///
/// `/S /C "..."` unconditionally strips only the outer quote pair and passes
/// the inner command string verbatim to `cmd.exe`, preserving embedded quotes,
/// pipelines, and compound operators. `/D` disables AutoRun registry hooks for
/// isolated executions.
pub fn windows_shell_command_line(cmd: &str, inherit_environment: bool) -> String {
    if inherit_environment {
        format!("cmd.exe /S /C \"{cmd}\"")
    } else {
        format!("cmd.exe /D /S /C \"{cmd}\"")
    }
}

/// Merge ambient and explicit environment variables using Windows'
/// case-insensitive variable name semantics, sorted case-insensitively as
/// required by `CreateProcessW(..., CREATE_UNICODE_ENVIRONMENT)`.
pub fn build_windows_env_pairs(
    inherited: impl IntoIterator<Item = (String, String)>,
    overlays: &BTreeMap<String, String>,
    inherit_environment: bool,
) -> Vec<(String, String)> {
    let mut merged: BTreeMap<String, (String, String)> = BTreeMap::new();
    if inherit_environment {
        for (key, value) in inherited {
            merged.insert(key.to_ascii_uppercase(), (key, value));
        }
    }
    for (key, value) in overlays {
        merged.insert(key.to_ascii_uppercase(), (key.clone(), value.clone()));
    }
    merged.into_values().collect()
}

#[cfg(windows)]
pub mod windows_job {
    use super::{build_windows_env_pairs, windows_shell_command_line};
    use std::collections::BTreeMap;
    use std::fs::File;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::path::Path;
    use std::time::{Duration, Instant};

    use windows::core::{BOOL, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::Security::SECURITY_ATTRIBUTES;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Pipes::CreatePipe;
    use windows::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES,
        STARTUPINFOEXW, STARTUPINFOW,
    };

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    // SAFETY: Win32 HANDLEs owned exclusively by a single struct can move across threads.
    unsafe impl Send for OwnedHandle {}

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn build_env_block(pairs: &[(String, String)]) -> Vec<u16> {
        let mut block = Vec::new();
        for (key, value) in pairs {
            block.extend(wide(&format!("{key}={value}")));
        }
        if block.is_empty() {
            block.push(0);
        }
        block.push(0);
        block
    }

    fn anonymous_pipe(child_reads: bool) -> Result<(OwnedHandle, OwnedHandle), String> {
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: BOOL(1),
        };
        let mut read = HANDLE::default();
        let mut write = HANDLE::default();
        unsafe { CreatePipe(&mut read, &mut write, Some(&sa), 0) }
            .map_err(|error| format!("CreatePipe failed: {error}"))?;
        let read = OwnedHandle(read);
        let write = OwnedHandle(write);
        let parent = if child_reads { write.0 } else { read.0 };
        unsafe { SetHandleInformation(parent, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)) }
            .map_err(|error| format!("SetHandleInformation failed: {error}"))?;
        Ok((read, write))
    }

    struct HandleList {
        _storage: Vec<usize>,
        pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
    }

    impl Drop for HandleList {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.pointer);
            }
        }
    }

    impl HandleList {
        fn new(handles: &[HANDLE]) -> Result<Self, String> {
            let mut bytes = 0usize;
            unsafe {
                let _ = InitializeProcThreadAttributeList(None, 1, None, &mut bytes);
            }
            if bytes == 0 {
                return Err("attribute list size unavailable".into());
            }
            let mut storage = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
            let pointer = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast());
            unsafe { InitializeProcThreadAttributeList(Some(pointer), 1, None, &mut bytes) }
                .map_err(|error| format!("initialize handle list failed: {error}"))?;
            let list = Self {
                _storage: storage,
                pointer,
            };
            unsafe {
                UpdateProcThreadAttribute(
                    pointer,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    Some(handles.as_ptr().cast()),
                    std::mem::size_of_val(handles),
                    None,
                    None,
                )
            }
            .map_err(|error| format!("set handle list failed: {error}"))?;
            Ok(list)
        }
    }

    /// A Windows shell command owned by a `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
    /// Job Object, assigned while suspended before any grandchild can spawn.
    pub struct WindowsJobChild {
        job: Option<OwnedHandle>,
        process: OwnedHandle,
        pub stdout: Option<File>,
        pub stderr: Option<File>,
    }

    impl WindowsJobChild {
        pub fn spawn_shell(
            cmd: &str,
            cwd: &Path,
            environment: &BTreeMap<String, String>,
            inherit_environment: bool,
        ) -> Result<Self, String> {
            let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
                .map_err(|error| format!("CreateJobObjectW failed: {error}"))?;
            let job = OwnedHandle(job);

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            }
            .map_err(|error| format!("SetInformationJobObject failed: {error}"))?;

            let (out_read, out_write) = anonymous_pipe(false)?;
            let (err_read, err_write) = anonymous_pipe(false)?;
            let (stdin_read, stdin_write) = anonymous_pipe(true)?;
            drop(stdin_write);

            let inherited_handles = [stdin_read.0, out_write.0, err_write.0];
            let handle_list = HandleList::new(&inherited_handles)?;

            let comspec = std::env::var_os("ComSpec")
                .map(std::path::PathBuf::from)
                .filter(|path| path.is_file());
            let app_wide = comspec.as_ref().map(|path| wide(&path.to_string_lossy()));
            let mut cmdline = wide(&windows_shell_command_line(cmd, inherit_environment));
            let cwd_wide = wide(&cwd.to_string_lossy());
            let pairs = build_windows_env_pairs(
                std::env::vars_os()
                    .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))),
                environment,
                inherit_environment,
            );
            let env_block = build_env_block(&pairs);

            let si = STARTUPINFOEXW {
                StartupInfo: STARTUPINFOW {
                    cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
                    dwFlags: STARTF_USESTDHANDLES,
                    hStdOutput: out_write.0,
                    hStdError: err_write.0,
                    hStdInput: stdin_read.0,
                    ..Default::default()
                },
                lpAttributeList: handle_list.pointer,
            };
            let mut pi = PROCESS_INFORMATION::default();

            unsafe {
                CreateProcessW(
                    app_wide
                        .as_ref()
                        .map_or(PCWSTR::null(), |buf| PCWSTR(buf.as_ptr())),
                    Some(PWSTR(cmdline.as_mut_ptr())),
                    None,
                    None,
                    true,
                    CREATE_SUSPENDED
                        | CREATE_NO_WINDOW
                        | CREATE_UNICODE_ENVIRONMENT
                        | EXTENDED_STARTUPINFO_PRESENT,
                    Some(env_block.as_ptr().cast()),
                    PCWSTR(cwd_wide.as_ptr()),
                    &si.StartupInfo,
                    &mut pi,
                )
            }
            .map_err(|error| format!("spawn shell: {error}"))?;

            let process = OwnedHandle(pi.hProcess);
            let thread = OwnedHandle(pi.hThread);

            if let Err(error) = unsafe { AssignProcessToJobObject(job.0, process.0) } {
                unsafe {
                    let _ = TerminateProcess(process.0, 1);
                }
                return Err(format!("AssignProcessToJobObject failed: {error}"));
            }
            if unsafe { ResumeThread(thread.0) } == u32::MAX {
                let error = windows::core::Error::from_thread();
                unsafe {
                    let _ = TerminateProcess(process.0, 1);
                }
                return Err(format!("ResumeThread failed: {error}"));
            }
            drop(thread);
            drop(out_write);
            drop(err_write);
            drop(stdin_read);

            let stdout = unsafe { File::from_raw_handle(out_read.0 .0) };
            std::mem::forget(out_read);
            let stderr = unsafe { File::from_raw_handle(err_read.0 .0) };
            std::mem::forget(err_read);

            Ok(Self {
                job: Some(job),
                process,
                stdout: Some(stdout),
                stderr: Some(stderr),
            })
        }

        /// Wait up to `slice` for the leader process to exit. Returns
        /// `Ok(Some(code))` when exited, `Ok(None)` when still running.
        pub fn wait_slice(&self, slice: Duration) -> Result<Option<i32>, String> {
            let millis = slice.as_millis().min(u32::MAX as u128 - 1) as u32;
            let wait = unsafe { WaitForSingleObject(self.process.0, millis) };
            if wait == WAIT_OBJECT_0 {
                let mut code: u32 = 0;
                unsafe { GetExitCodeProcess(self.process.0, &mut code) }
                    .map_err(|error| format!("GetExitCodeProcess failed: {error}"))?;
                Ok(Some(code as i32))
            } else if wait == WAIT_TIMEOUT {
                Ok(None)
            } else {
                Err(format!("WaitForSingleObject returned 0x{:x}", wait.0))
            }
        }

        /// Terminate every process in the Job Object (including descendants
        /// surviving after the leader exited) and wait within `budget` until
        /// `ActiveProcesses == 0` and the leader handle signals, then close the
        /// Job Object. Returns `true` when full tree termination was confirmed.
        pub fn terminate_tree_and_wait(&mut self, budget: Duration) -> bool {
            let deadline = Instant::now() + budget;
            if let Some(job) = &self.job {
                unsafe {
                    let _ = TerminateJobObject(job.0, 1);
                }
            }
            unsafe {
                let _ = TerminateProcess(self.process.0, 1);
            }

            let mut confirmed = false;
            if let Some(job) = &self.job {
                loop {
                    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
                    let ok = unsafe {
                        QueryInformationJobObject(
                            Some(job.0),
                            JobObjectBasicAccountingInformation,
                            &mut accounting as *mut _ as *mut core::ffi::c_void,
                            std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                            None,
                        )
                    };
                    if ok.is_ok() && accounting.ActiveProcesses == 0 {
                        confirmed = true;
                        break;
                    }
                    if Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            let millis = remaining.as_millis().min(u32::MAX as u128 - 1) as u32;
            let leader_reaped =
                unsafe { WaitForSingleObject(self.process.0, millis) } == WAIT_OBJECT_0;
            // Closing the kill-on-close Job Object guarantees any straggler
            // is terminated even if the query loop timed out.
            self.job.take();
            confirmed && leader_reaped
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kill_process_group_none_is_noop() {
        // Must not panic for a process that never started / has no pid.
        kill_process_group(None);
    }

    #[test]
    fn windows_shell_command_line_preserves_quotes_and_isolation_switch() {
        assert_eq!(
            windows_shell_command_line("echo \"hi\"", true),
            "cmd.exe /S /C \"echo \"hi\"\""
        );
        assert_eq!(
            windows_shell_command_line("mise install", false),
            "cmd.exe /D /S /C \"mise install\""
        );
    }

    #[test]
    fn windows_env_pairs_merge_case_insensitively_and_respect_isolation() {
        let overlays = BTreeMap::from([
            ("PATH".into(), "C:\\override".into()),
            ("APP_ENV".into(), "test".into()),
        ]);
        let inherited = vec![
            ("Path".into(), "C:\\Windows".into()),
            ("SystemRoot".into(), "C:\\Windows".into()),
        ];
        let merged = build_windows_env_pairs(inherited.clone(), &overlays, true);
        assert_eq!(
            merged,
            vec![
                ("APP_ENV".into(), "test".into()),
                ("PATH".into(), "C:\\override".into()),
                ("SystemRoot".into(), "C:\\Windows".into()),
            ]
        );
        let isolated = build_windows_env_pairs(inherited, &overlays, false);
        assert_eq!(
            isolated,
            vec![
                ("APP_ENV".into(), "test".into()),
                ("PATH".into(), "C:\\override".into()),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn blocking_confirmed_stop_reaps_a_group_after_leader_exits() {
        use std::os::unix::process::CommandExt;
        let mut cmd = std::process::Command::new("sh");
        cmd.arg("-c")
            .arg("sleep 30 </dev/null >/dev/null 2>&1 &")
            .process_group(0);
        let mut child = cmd.spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(kill_process_group_and_wait_blocking(
            Some(pid),
            Duration::from_secs(2)
        ));
        assert_ne!(unsafe { libc::killpg(pid as libc::pid_t, 0) }, 0);
        assert!(kill_process_group_and_wait_blocking(None, Duration::ZERO));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn confirmed_stop_reaps_a_group_after_its_leader_exits() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("sleep 30 </dev/null >/dev/null 2>&1 &")
            .kill_on_drop(true);
        apply_process_group(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let pid = child.id();
        child.wait().await.unwrap();
        kill_process_group_and_wait(pid, Duration::from_secs(2))
            .await
            .unwrap();
        assert_ne!(unsafe { libc::killpg(pid.unwrap() as libc::pid_t, 0) }, 0);
        kill_process_group_and_wait(None, Duration::ZERO)
            .await
            .unwrap();
    }

    #[test]
    fn apply_process_group_is_callable() {
        let mut cmd = Command::new("echo");
        apply_process_group(&mut cmd);
        // No assertion beyond "does not panic": the effect is observable only in
        // a spawned child, exercised by the Unix-gated test below.
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_process_group_terminates_grandchild() {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, BufReader};

        // Parent shell spawns a long-lived grandchild (sleep) in the same group,
        // prints its pid, then waits. Killing the group must take the grandchild
        // down too — the whole point of process-group cleanup.
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("sleep 30 & echo $!; wait")
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        apply_process_group(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");
        let pid = child.id();

        let stdout = child.stdout.take().expect("stdout");
        let mut lines = BufReader::new(stdout).lines();
        let line = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
            .await
            .expect("read grandchild pid in time")
            .expect("line ok")
            .expect("some line");
        let grandchild: i32 = line.trim().parse().expect("pid parse");

        kill_process_group(pid);
        let _ = child.wait().await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        // signal 0 → existence probe; non-zero (ESRCH) means it's gone.
        let alive = unsafe { libc::kill(grandchild as libc::pid_t, 0) } == 0;
        assert!(
            !alive,
            "grandchild {grandchild} should have been killed with the group"
        );
    }
}
