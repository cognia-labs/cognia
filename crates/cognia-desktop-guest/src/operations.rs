//! Recipe-8 workload operations. The root control worker owns admission; this
//! module handles content only after the existing acceptance boundary admits it.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs::{File, OpenOptions};
#[cfg(target_os = "linux")]
use std::io::Read;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::Path;

pub(crate) const HOME: &str = "/home/cua";
pub(crate) const CONTROL_SOCKET: &str = "/run/cognia-desktop/control.sock";
pub(crate) const CHUNK_LIMIT: usize = 64 * 1024;
/// Per-connection file transport bounds, not total workload data-volume limits.
/// Exec output is separately bounded and is not charged to these counters;
/// WP11's Host accounting owns volume limits across operations/connections.
pub(crate) const FILE_LIMIT: u64 = 8 * 1024 * 1024;
/// Combined file-read/file-write transport bytes on one control connection.
pub(crate) const SESSION_LIMIT: u64 = 32 * 1024 * 1024;
pub(crate) const TEXT_LIMIT: usize = 1024 * 1024;
pub(crate) const OUTPUT_LIMIT: usize = 1024 * 1024;
pub(crate) const TIMEOUT_LIMIT_MS: u64 = 60_000;
// JSON can expand a UTF-8 text byte into six bytes (and binary into four).
pub(crate) const FRAME_LIMIT: usize = 6 * TEXT_LIMIT + 8192;

fn refused() -> io::Error {
    io::Error::other("workload operation refused")
}

/// The security gate is the root-owned 0600 listener plus uid 0. Checking the
/// pathname is an endpoint sanity check, not independent authentication.
pub(crate) fn authorize_control_peer(uid: u32, path: Option<&Path>) -> io::Result<()> {
    if uid != 0 || path != Some(Path::new(CONTROL_SOCKET)) {
        return Err(refused());
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Exec {
        argv: Vec<String>,
        cwd: String,
        timeout_ms: u64,
    },
    FileRead {
        path: String,
        offset: u64,
        length: usize,
    },
    FileWrite {
        path: String,
        offset: u64,
        chunk: Vec<u8>,
        r#final: bool,
    },
    ClipboardGet,
    ClipboardSet {
        text: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecResult {
    pub output: Vec<u8>,
    pub truncated: bool,
    pub timed_out: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ResultValue {
    Exec(ExecResult),
    FileRead { chunk: Vec<u8>, eof: bool },
    FileWrite { bytes: usize, r#final: bool },
    ClipboardGet { text: String },
    ClipboardSet { bytes: usize },
}

/// Closed numeric projection, deliberately separate from the content response.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Audit {
    pub operation: String,
    pub input_bytes: usize,
    pub output_bytes: usize,
    pub path_length: usize,
    pub argv_count: usize,
    pub refused: bool,
}

impl Audit {
    pub(crate) fn validate(&self) -> io::Result<()> {
        if ![
            "exec",
            "file-read",
            "file-write",
            "clipboard-get",
            "clipboard-set",
        ]
        .contains(&self.operation.as_str())
            || self.input_bytes > FRAME_LIMIT
            || self.output_bytes > OUTPUT_LIMIT
            || self.path_length > FRAME_LIMIT
            || self.argv_count > FRAME_LIMIT
        {
            return Err(refused());
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn store(&self) -> io::Result<()> {
        self.validate()?;
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open("/run/cognia-desktop/operations.audit.jsonl")?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != 0
            || metadata.nlink() != 1
            || metadata.mode() & 0o7777 != 0o600
        {
            return Err(refused());
        }
        self.append_to(&mut file, 8 * 1024 * 1024)
    }

    // Only the supervisor writes this protected inode. Rotate to the newest
    // half-window at the size cap, retaining complete records within the last
    // limit bytes. This amortizes compaction instead of copying MiB per record.
    fn append_to(&self, file: &mut File, limit: usize) -> io::Result<()> {
        self.validate()?;
        let mut record = Vec::new();
        write_frame(&mut record, self)?;
        if record.len() > limit { return Err(refused()); }
        let length = file.metadata()?.len();
        if length.saturating_add(record.len() as u64) > limit as u64 {
            let keep = length.min((limit / 2).min(limit - record.len()) as u64) as usize;
            let mut tail = vec![0; keep];
            file.read_exact_at(&mut tail, length - keep as u64)?;
            let start = tail.iter().position(|byte| *byte == b'\n').map_or(tail.len(), |n| n + 1);
            file.set_len(0)?;
            file.write_all_at(&tail[start..], 0)?;
            file.write_all_at(&record, (tail.len() - start) as u64)?;
        } else {
            file.write_all_at(&record, length)?;
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Response {
    pub result: Option<ResultValue>,
    pub error: Option<String>,
    pub audit: Audit,
}

impl Request {
    pub(crate) fn audit(&self) -> Audit {
        let (operation, input_bytes, path_length, argv_count) = match self {
            Self::Exec { argv, cwd, .. } => (
                "exec",
                argv.iter().map(String::len).sum(),
                cwd.len(),
                argv.len(),
            ),
            Self::FileRead { path, .. } => ("file-read", 0, path.len(), 0),
            Self::FileWrite { path, chunk, .. } => ("file-write", chunk.len(), path.len(), 0),
            Self::ClipboardGet => ("clipboard-get", 0, 0, 0),
            Self::ClipboardSet { text } => ("clipboard-set", text.len(), 0, 0),
        };
        Audit {
            operation: operation.into(),
            input_bytes,
            output_bytes: 0,
            path_length,
            argv_count,
            refused: false,
        }
    }

    pub(crate) fn validate(&self) -> io::Result<()> {
        match self {
            Self::Exec {
                argv,
                cwd,
                timeout_ms,
            } => {
                components(cwd, true)?;
                if argv.is_empty()
                    || argv.len() > 256
                    || argv[0].is_empty()
                    || *timeout_ms == 0
                    || argv.iter().map(String::len).sum::<usize>() > 64 * 1024
                    || argv.iter().any(|arg| arg.as_bytes().contains(&0))
                {
                    return Err(refused());
                }
            }
            Self::FileRead {
                path,
                offset,
                length,
            } => {
                components(path, false)?;
                range(*offset, *length, CHUNK_LIMIT)?;
            }
            Self::FileWrite {
                path,
                offset,
                chunk,
                ..
            } => {
                components(path, false)?;
                range(*offset, chunk.len(), CHUNK_LIMIT)?;
            }
            Self::ClipboardGet => (),
            Self::ClipboardSet { text } if text.len() <= TEXT_LIMIT && !text.contains('\0') => (),
            _ => return Err(refused()),
        }
        Ok(())
    }
}

impl Response {
    /// The root worker projects its own request; content-side labels, input
    /// counts and path/argv metadata are never accepted into the root audit.
    pub(crate) fn root_audit(&self, request: &Request) -> Audit {
        let mut audit = request.audit();
        audit.output_bytes = self.audit.output_bytes.min(OUTPUT_LIMIT);
        audit.refused = self.error.is_some();
        audit
    }
}

fn range(offset: u64, length: usize, limit: usize) -> io::Result<()> {
    if length > limit
        || offset
            .checked_add(length as u64)
            .is_none_or(|end| end > FILE_LIMIT)
    {
        return Err(refused());
    }
    Ok(())
}

/// Accept relative paths, or the exact workload-home prefix; never normalize
/// away traversal. Even a harmless-looking `a/../b` is refused.
fn components(path: &str, directory: bool) -> io::Result<Vec<CString>> {
    if path.len() > 4096 || path.contains('\0') {
        return Err(refused());
    }
    let path = if path == HOME {
        ""
    } else {
        path.strip_prefix("/home/cua/").unwrap_or(path)
    };
    if directory && (path.is_empty() || path == ".") {
        return Ok(Vec::new());
    }
    if path.is_empty() {
        return Err(refused());
    }
    path.split('/')
        .map(|part| {
            if matches!(part, "" | "." | "..") {
                return Err(refused());
            }
            CString::new(part).map_err(|_| refused())
        })
        .collect()
}

/// File transport accounting and inode pins belong to one root connection.
/// This is not a cumulative workload-volume ledger; exec output is uncharged.
pub(crate) struct Session {
    home: File,
    transferred: u64,
    // Pin created inodes until the connection ends, preventing inode-reuse from
    // turning the session-created hardlink exception into outside-file access.
    created: BTreeMap<(u64, u64), File>,
    pin_limit: usize,
    fatal: bool,
}

fn pin_limit(soft_limit: u64) -> usize {
    // Leave descriptors for the home walk, pipes, command launch and relay.
    soft_limit.saturating_sub(64).min(1024) as usize
}

#[derive(Debug)]
struct ExecUnavailable;
impl std::fmt::Display for ExecUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("operation_exec_unavailable")
    }
}
impl std::error::Error for ExecUnavailable {}
fn exec_unavailable(_: io::Error) -> io::Error { io::Error::other(ExecUnavailable) }
fn is_exec_unavailable(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|inner| inner.is::<ExecUnavailable>())
}

impl Session {
    fn open(home: &Path) -> io::Result<Self> {
        let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let home = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(home)?;
        Ok(Self {
            home,
            transferred: 0,
            created: BTreeMap::new(),
            pin_limit: pin_limit(limit.rlim_cur),
            fatal: false,
        })
    }

    fn directory(&self, parts: &[CString]) -> io::Result<File> {
        let mut directory = self.home.try_clone()?;
        for part in parts {
            directory = openat(&directory, part, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        }
        Ok(directory)
    }

    fn file(&mut self, path: &str, write: bool) -> io::Result<File> {
        let mut parts = components(path, false)?;
        let name = parts.pop().ok_or_else(refused)?;
        let directory = self.directory(&parts)?;
        let (file, created) = if write && self.created.len() >= self.pin_limit {
            // Existing files remain usable; refuse creation before touching it.
            (openat(&directory, &name, libc::O_RDWR, 0)?, false)
        } else if write {
            match openat(
                &directory,
                &name,
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
                0o600,
            ) {
                Ok(file) => (file, true),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    (openat(&directory, &name, libc::O_RDWR, 0)?, false)
                }
                Err(error) => return Err(error),
            }
        } else {
            (openat(&directory, &name, libc::O_RDONLY, 0)?, false)
        };
        let metadata = file.metadata()?;
        let identity = (metadata.dev(), metadata.ino());
        self.validate_file(&file)?;
        if created {
            self.created.insert(identity, file.try_clone()?);
        }
        Ok(file)
    }

    fn validate_file(&self, file: &File) -> io::Result<()> {
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.len() > FILE_LIMIT
            || metadata.nlink() > 1 && !self.created.contains_key(&(metadata.dev(), metadata.ino()))
        {
            return Err(refused());
        }
        Ok(())
    }

    fn charge(&mut self, bytes: usize) -> io::Result<()> {
        let total = self
            .transferred
            .checked_add(bytes as u64)
            .ok_or_else(refused)?;
        if total > SESSION_LIMIT {
            return Err(refused());
        }
        self.transferred = total;
        Ok(())
    }

    pub(crate) fn handle(&mut self, request: Request) -> Response {
        let mut audit = request.audit();
        let result = request.validate().and_then(|()| self.execute(request));
        match result {
            Ok(result) => {
                audit.output_bytes = match &result {
                    ResultValue::Exec(value) => value.output.len(),
                    ResultValue::FileRead { chunk, .. } => chunk.len(),
                    ResultValue::ClipboardGet { text } => text.len(),
                    _ => 0,
                };
                Response {
                    result: Some(result),
                    error: None,
                    audit,
                }
            }
            Err(error) => {
                audit.refused = true;
                Response {
                    result: None,
                    error: Some(if is_exec_unavailable(&error) {
                        "operation_exec_unavailable"
                    } else { "operation_refused" }.into()),
                    audit,
                }
            }
        }
    }

    fn execute(&mut self, request: Request) -> io::Result<ResultValue> {
        match request {
            Request::FileRead {
                path,
                offset,
                length,
            } => {
                let file = self.file(&path, false)?;
                let mut chunk = vec![0; length];
                let count = file.read_at(&mut chunk, offset)?;
                self.charge(count)?;
                chunk.truncate(count);
                Ok(ResultValue::FileRead {
                    chunk,
                    eof: offset + count as u64 >= file.metadata()?.len(),
                })
            }
            Request::FileWrite {
                path,
                offset,
                chunk,
                r#final,
            } => {
                // Charge before opening/creating anything, including zero-length
                // finalization. No truncation or write happens on quota failure.
                self.charge(chunk.len())?;
                let file = self.file(&path, true)?;
                file.write_all_at(&chunk, offset)?;
                if r#final {
                    file.set_len(offset + chunk.len() as u64)?;
                    file.sync_all()?;
                }
                Ok(ResultValue::FileWrite {
                    bytes: chunk.len(),
                    r#final,
                })
            }
            Request::Exec {
                argv,
                cwd,
                timeout_ms,
            } => {
                let directory = self.directory(&components(&cwd, true)?)?;
                let result = run_exec(&argv, &directory, timeout_ms.min(TIMEOUT_LIMIT_MS));
                self.exec_outcome(result)
            }
            Request::ClipboardGet => {
                let result = clipboard(None)?;
                if result.truncated || result.timed_out || result.exit_code != Some(0) {
                    return Err(refused());
                }
                let text = String::from_utf8(result.output).map_err(|_| refused())?;
                if text.len() > TEXT_LIMIT || text.contains('\0') {
                    return Err(refused());
                }
                Ok(ResultValue::ClipboardGet { text })
            }
            Request::ClipboardSet { text } => {
                let result = clipboard(Some(text.as_bytes()))?;
                if result.timed_out || result.exit_code != Some(0) {
                    return Err(refused());
                }
                Ok(ResultValue::ClipboardSet { bytes: text.len() })
            }
        }
    }

    fn exec_outcome(&mut self, result: io::Result<ExecResult>) -> io::Result<ResultValue> {
        if result.as_ref().is_err_and(|error| !is_exec_unavailable(error)) {
            self.fatal = true;
        }
        result.map(ResultValue::Exec)
    }
}

fn openat(directory: &File, name: &CString, flags: i32, mode: u32) -> io::Result<File> {
    // NONBLOCK is mandatory: opening a FIFO must never wait for another peer.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// Bounded framing is shared by the root relay and workload payload. Read in
/// blocks with fill_buf, rather than a syscall per byte of clipboard text.
pub(crate) fn read_frame(input: &mut impl io::BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    loop {
        let buffer = input.fill_buf()?;
        if buffer.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err(refused())
            };
        }
        let end = buffer.iter().position(|byte| *byte == b'\n').map(|n| n + 1);
        let count = end.unwrap_or(buffer.len());
        if bytes.len() + count > FRAME_LIMIT {
            return Err(refused());
        }
        bytes.extend_from_slice(&buffer[..count]);
        input.consume(count);
        if end.is_some() {
            return Ok(Some(bytes));
        }
    }
}

pub(crate) fn write_frame(output: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| refused())?;
    bytes.push(b'\n');
    if bytes.len() > FRAME_LIMIT {
        return Err(refused());
    }
    output.write_all(&bytes)?;
    output.flush()
}

#[cfg(target_os = "linux")]
pub(crate) fn serve(input: File, mut output: File) -> io::Result<()> {
    // This entry is callable only by acceptance::child_exec after its kernel
    // admission gate. There is deliberately no command-line payload mode.
    if unsafe { libc::getuid() } != 1000
        || unsafe { libc::geteuid() } != 1000
        || !crate::boundary::restricted_status(&std::fs::read_to_string("/proc/self/status")?)
    {
        return Err(refused());
    }
    let mut session = Session::open(Path::new(HOME))?;
    let mut input = io::BufReader::new(input);
    for _ in 0..10_000 {
        let Some(bytes) = read_frame(&mut input)? else {
            return Ok(());
        };
        let request: Request = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        let response = session.handle(request);
        if session.fatal {
            return Err(refused());
        }
        write_frame(&mut output, &response)?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn run_exec(argv: &[String], directory: &File, timeout_ms: u64) -> io::Result<ExecResult> {
    run_exec_with(argv, directory, timeout_ms, pipe, || {
        let child = unsafe { libc::fork() };
        if child < 0 { Err(io::Error::last_os_error()) } else { Ok(child) }
    })
}

#[cfg(target_os = "linux")]
fn run_exec_with(
    argv: &[String], directory: &File, timeout_ms: u64,
    make_pipe: impl FnOnce() -> io::Result<(File, File)>,
    fork: impl FnOnce() -> io::Result<i32>,
) -> io::Result<ExecResult> {
    // A dedicated immutable subreaper owns this exec's orphaned/double-forked
    // descendants; unrelated desktop or clipboard processes are never selected.
    let (mut result_read, result_write) = make_pipe().map_err(exec_unavailable)?;
    let parent = unsafe { libc::getpid() };
    let child = fork().map_err(exec_unavailable)?;
    if child == 0 {
        drop(result_read);
        let result = (|| {
            if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0
                || unsafe { libc::getppid() } != parent
                || unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0
            {
                return Err(refused());
            }
            let mut command = command(argv, directory)?;
            let result =
                collect(&mut command, None, timeout_ms, OUTPUT_LIMIT).or_else(|error| {
                    if matches!(
                        error.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                    ) {
                        Ok(ExecResult {
                            output: Vec::new(),
                            truncated: false,
                            timed_out: false,
                            exit_code: Some(if error.kind() == io::ErrorKind::NotFound {
                                127
                            } else {
                                126
                            }),
                            signal: None,
                        })
                    } else {
                        Err(error)
                    }
                })?;
            reap_descendants()?;
            write_frame(&mut { result_write }, &result)
        })();
        unsafe {
            libc::_exit(if result.is_ok() { 0 } else { 125 });
        }
    }
    drop(result_write);
    let until = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms + 5000);
    let result = (|| {
        let mut bytes = Vec::new();
        loop {
            wait_fd(result_read.as_raw_fd(), until)?;
            let mut buffer = [0; 8192];
            let count = result_read.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
            if bytes.len() > FRAME_LIMIT {
                return Err(refused());
            }
        }
        let mut status = 0;
        if unsafe { libc::waitpid(child, &mut status, 0) } != child || status != 0 {
            return Err(refused());
        }
        serde_json::from_slice(&bytes).map_err(|_| refused())
    })();
    if result.is_err() {
        unsafe {
            libc::kill(child, libc::SIGKILL);
            libc::waitpid(child, std::ptr::null_mut(), 0);
        }
        // A failed lifetime guard cannot be downgraded to an operation refusal.
        // Closing the payload makes the root helper destroy the generation.
        return Err(io::Error::other("operation lifetime guard failed"));
    }
    result
}

#[cfg(not(target_os = "linux"))]
fn run_exec(_: &[String], _: &File, _: u64) -> io::Result<ExecResult> {
    Err(refused())
}

#[cfg(target_os = "linux")]
fn command(argv: &[String], directory: &File) -> io::Result<std::process::Command> {
    use std::os::unix::process::CommandExt;
    let mut command = std::process::Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", HOME)
        .env("USER", "cua")
        .env("LOGNAME", "cua")
        .env("LANG", "C.UTF-8")
        .env("DISPLAY", ":99")
        .env("XDG_RUNTIME_DIR", "/run/user/1000");
    let cwd = directory.try_clone()?;
    let parent = unsafe { libc::getpid() };
    unsafe {
        command.pre_exec(move || {
            if libc::fchdir(cwd.as_raw_fd()) != 0
                || libc::setsid() < 0
                || libc::syscall(libc::SYS_close_range, 3_u32, u32::MAX, 4_u32) != 0
                || libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0
                || libc::getppid() != parent
            {
                return Err(refused());
            }
            Ok(())
        });
    }
    Ok(command)
}

#[cfg(target_os = "linux")]
fn pipe() -> io::Result<(File, File)> {
    let mut fds = [-1; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) })
}

#[cfg(target_os = "linux")]
fn wait_fd(fd: i32, until: std::time::Instant) -> io::Result<()> {
    loop {
        let remaining = until
            .checked_duration_since(std::time::Instant::now())
            .ok_or_else(refused)?;
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe {
            libc::poll(
                &mut poll,
                1,
                remaining.as_millis().max(1).min(i32::MAX as u128) as i32,
            )
        };
        if ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if ready <= 0 || poll.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
            return Err(refused());
        }
        return Ok(());
    }
}

#[cfg(target_os = "linux")]
fn reap_descendants() -> io::Result<()> {
    use std::time::{Duration, Instant};
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        // Freeze each parent before discovering its children. pidfds prevent
        // PID reuse and setsid/double-fork do not escape this subreaper.
        let owner = std::process::id();
        let mut pending = vec![(owner, crate::boundary::start_time(owner)?)];
        let mut pinned = Vec::new();
        while let Some((parent, parent_start)) = pending.pop() {
            if crate::boundary::start_time(parent).ok() != Some(parent_start) {
                continue;
            }
            let path = format!("/proc/{parent}/task/{parent}/children");
            let children = match std::fs::read_to_string(path) {
                Ok(value) => value,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            for pid in children.split_whitespace() {
                let pid: u32 = pid.parse().map_err(|_| refused())?;
                let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                    Ok(value) => value,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error),
                };
                let start = crate::boundary::parse_start_time(&stat)?;
                let observed_parent = stat
                    .rsplit_once(')')
                    .and_then(|(_, fields)| fields.split_whitespace().nth(1))
                    .and_then(|value| value.parse::<u32>().ok())
                    .ok_or_else(refused)?;
                if observed_parent != parent && observed_parent != owner {
                    continue;
                }
                let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
                if raw < 0 {
                    if io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                        continue;
                    }
                    return Err(refused());
                }
                let fd = unsafe { File::from_raw_fd(raw as i32) };
                if crate::boundary::start_time(pid).ok() != Some(start) {
                    continue;
                }
                unsafe {
                    libc::syscall(
                        libc::SYS_pidfd_send_signal,
                        fd.as_raw_fd(),
                        libc::SIGSTOP,
                        std::ptr::null::<libc::siginfo_t>(),
                        0,
                    );
                }
                pinned.push(fd);
                pending.push((pid, start));
                if pinned.len() > 1024 || Instant::now() >= until {
                    return Err(refused());
                }
            }
        }
        for fd in pinned {
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                );
            }
        }
        loop {
            let result = unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) };
            if result > 0 {
                continue;
            }
            if result < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD) {
                return Ok(());
            }
            if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return Err(refused());
            }
            break;
        }
        if Instant::now() >= until {
            return Err(refused());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// One shared pipe preserves the combined stdout/stderr cap. Drain after the
/// cap instead of blocking a verbose child on a full pipe.
#[cfg(target_os = "linux")]
fn collect(
    command: &mut std::process::Command,
    input: Option<&[u8]>,
    timeout_ms: u64,
    limit: usize,
) -> io::Result<ExecResult> {
    use std::os::unix::process::ExitStatusExt;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let (mut read, write) = pipe()?;
    if input.is_some() {
        // xclip's default selection-owner daemon must inherit null output,
        // rather than keeping the bounded collector's EOF pipe open forever.
        command.stdout(Stdio::null()).stderr(Stdio::null());
        drop(write);
    } else {
        command
            .stdout(Stdio::from(write.try_clone()?))
            .stderr(Stdio::from(write));
    }
    let mut child = command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .spawn()?;
    // Drop the command's writer copies before looking for pipe EOF.
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let until = Instant::now() + Duration::from_millis(timeout_ms);
    let result = (|| {
        let flags = unsafe { libc::fcntl(read.as_raw_fd(), libc::F_GETFL) };
        if flags < 0
            || unsafe { libc::fcntl(read.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) }
                != 0
        {
            return Err(refused());
        }
        let mut stdin = child.stdin.take();
        if let Some(stdin) = &stdin {
            let flags = unsafe { libc::fcntl(stdin.as_raw_fd(), libc::F_GETFL) };
            if flags < 0
                || unsafe {
                    libc::fcntl(stdin.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK)
                } != 0
            {
                return Err(refused());
            }
        }
        let mut sent = 0;
        let mut output = Vec::new();
        let mut truncated = false;
        let mut status = None;
        loop {
            if let (Some(bytes), Some(writer)) = (input, &mut stdin) {
                match writer.write(&bytes[sent..]) {
                    Ok(n) => sent += n,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => (),
                    Err(error) => return Err(error),
                }
                if sent == bytes.len() {
                    stdin.take();
                }
            }
            let mut eof = false;
            // Bound work per tick so endless output cannot starve the deadline.
            for _ in 0..16 {
                let mut buffer = [0; 8192];
                match read.read(&mut buffer) {
                    Ok(0) => {
                        eof = true;
                        break;
                    }
                    Ok(n) => {
                        let keep = n.min(limit.saturating_sub(output.len()));
                        output.extend_from_slice(&buffer[..keep]);
                        truncated |= keep != n;
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                }
            }
            if status.is_none() {
                status = child.try_wait()?;
            }
            if let Some(status) = status {
                // Descendants can keep the pipe open. Completion still cleans
                // up the tree; it must never turn into an unbounded read.
                if eof {
                    return Ok(ExecResult {
                        output,
                        truncated,
                        timed_out: false,
                        exit_code: status.code(),
                        signal: status.signal(),
                    });
                }
            }
            if Instant::now() >= until {
                let _ = child.kill();
                let status = child.wait()?;
                return Ok(ExecResult {
                    output,
                    truncated,
                    timed_out: true,
                    exit_code: status.code(),
                    signal: status.signal(),
                });
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

#[cfg(target_os = "linux")]
fn clipboard(text: Option<&[u8]>) -> io::Result<ExecResult> {
    let home = Session::open(Path::new(HOME))?;
    let mut argv = vec![
        "/usr/bin/xclip".into(),
        "-selection".into(),
        "clipboard".into(),
        "-target".into(),
        "UTF8_STRING".into(),
    ];
    argv.push(if text.is_some() { "-in" } else { "-out" }.into());
    let mut command = command(&argv, &home.home)?;
    // xclip's selection owner deliberately persists in the desktop namespace;
    // its daemon closes stdio. Supervisor death kills it with the whole desktop.
    collect(&mut command, text, 5000, TEXT_LIMIT)
}

#[cfg(not(target_os = "linux"))]
fn clipboard(_: Option<&[u8]>) -> io::Result<ExecResult> {
    Err(refused())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn root_audit_uses_forwarded_request_and_bounds_only_workload_output_count() {
        let request = write("private-path", 0, b"secret", true);
        let home = Home::new();
        let mut response = home.session().handle(request.clone());
        response.audit = Audit { operation: "private-content".into(), input_bytes: usize::MAX,
            output_bytes: usize::MAX, path_length: usize::MAX, argv_count: usize::MAX, refused: true };
        let audit = response.root_audit(&request);
        assert_eq!(audit.operation, "file-write");
        assert_eq!(audit.input_bytes, 6);
        assert_eq!(audit.path_length, 12);
        assert_eq!(audit.argv_count, 0);
        assert_eq!(audit.output_bytes, OUTPUT_LIMIT);
        assert!(!audit.refused);
        audit.validate().unwrap();
        assert!(!serde_json::to_string(&audit).unwrap().contains("secret"));
    }

    #[test]
    fn audit_rotation_retains_newest_complete_records_with_bounded_file_size() {
        let home = Home::new();
        let mut file = OpenOptions::new().create_new(true).read(true).write(true)
            .open(home.0.join("audit")).unwrap();
        let mut audit = read("private-path").audit();
        // An already oversized log is also repaired on the first append.
        file.write_all(&vec![b'x'; 8192]).unwrap();
        for count in 0..100 {
            audit.output_bytes = count;
            audit.append_to(&mut file, 1024).unwrap();
            assert!(file.metadata().unwrap().len() <= 1024);
        }
        let bytes = std::fs::read(home.0.join("audit")).unwrap();
        let records: Vec<Audit> = bytes.split(|byte| *byte == b'\n').filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap()).collect();
        assert!(records.len() > 1);
        assert_eq!(records.last().unwrap().output_bytes, 99);
        assert!(records.windows(2).all(|pair| pair[0].output_bytes + 1 == pair[1].output_bytes));
    }

    #[test]
    fn descriptor_pins_reserve_nofile_headroom_and_refuse_without_creating() {
        for (limit, expected) in [(32, 0), (64, 0), (65, 1), (128, 64), (4096, 1024)] {
            assert_eq!(pin_limit(limit), expected);
        }
        let home = Home::new();
        let mut session = home.session();
        let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
        assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) }, 0);
        assert_eq!(session.pin_limit, pin_limit(limit.rlim_cur));
        session.pin_limit = 1;
        assert!(session.handle(write("first", 0, b"x", true)).error.is_none());
        assert!(session.handle(write("second", 0, b"x", true)).error.is_some());
        assert!(!home.0.join("second").exists());
        assert!(session.handle(write("first", 0, b"y", true)).error.is_none());
        assert_eq!(session.created.len(), 1);
        assert!(!session.fatal);
    }

    #[test]
    fn only_post_fork_uncertainty_marks_exec_lifetime_fatal() {
        let home = Home::new();
        let mut session = home.session();
        for code in [libc::EMFILE, libc::EAGAIN] {
            let error = session.exec_outcome(Err(exec_unavailable(io::Error::from_raw_os_error(code))))
                .unwrap_err();
            assert_eq!(error.to_string(), "operation_exec_unavailable");
            assert!(!session.fatal);
        }
        assert!(session.exec_outcome(Err(io::Error::other("operation lifetime guard failed"))).is_err());
        assert!(session.fatal);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pipe_emfile_and_fork_eagain_are_pre_descendant_refusals() {
        let home = Home::new();
        let directory = File::open(&home.0).unwrap();
        let argv = vec!["/bin/true".into()];
        let pipe_error = run_exec_with(&argv, &directory, 1,
            || Err(io::Error::from_raw_os_error(libc::EMFILE)), || panic!("fork must not run"))
            .unwrap_err();
        assert!(is_exec_unavailable(&pipe_error));
        let fork_error = run_exec_with(&argv, &directory, 1, pipe,
            || Err(io::Error::from_raw_os_error(libc::EAGAIN))).unwrap_err();
        assert!(is_exec_unavailable(&fork_error));
    }
    #[test]
    fn only_root_on_the_fixed_control_socket_can_request_operations() {
        assert!(authorize_control_peer(0, Some(Path::new(CONTROL_SOCKET))).is_ok());
        for uid in [1, 1000, 1001, 65534] {
            assert!(authorize_control_peer(uid, Some(Path::new(CONTROL_SOCKET))).is_err());
        }
        for path in [
            None,
            Some(Path::new("/tmp/control.sock")),
            Some(Path::new("/run/cognia-desktop/relay.sock")),
        ] {
            assert!(authorize_control_peer(0, path).is_err());
        }
    }
    struct Home(std::path::PathBuf);
    impl Home {
        fn new() -> Self {
            let path = std::path::Path::new("/tmp")
                .join(format!("cognia-operations-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn session(&self) -> Session {
            Session::open(&self.0).unwrap()
        }
    }
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn read(path: &str) -> Request {
        Request::FileRead {
            path: path.into(),
            offset: 0,
            length: CHUNK_LIMIT,
        }
    }
    fn write(path: &str, offset: u64, chunk: &[u8], final_chunk: bool) -> Request {
        Request::FileWrite {
            path: path.into(),
            offset,
            chunk: chunk.into(),
            r#final: final_chunk,
        }
    }

    #[test]
    fn paths_refuse_every_traversal_and_unrelated_absolute_root() {
        for path in [
            "../x",
            "a/../x",
            "/etc/passwd",
            "a//x",
            "a/./x",
            "a/",
            "",
            "/home/cuax/x",
            "x\0y",
        ] {
            assert!(read(path).validate().is_err(), "{path:?}");
        }
        assert!(components("/home/cua/nested/file", false).is_ok());
        assert!(components(HOME, true).unwrap().is_empty());
        assert!(components(".", true).unwrap().is_empty());
    }

    #[test]
    fn binary_chunks_offsets_finalization_and_quota_are_bounded() {
        let home = Home::new();
        let mut session = home.session();
        assert!(session
            .handle(write("a", 0, &[0, 255], false))
            .error
            .is_none());
        assert!(session.handle(write("a", 2, &[1, 2], true)).error.is_none());
        match session.handle(read("a")).result.unwrap() {
            ResultValue::FileRead { chunk, eof } => {
                assert_eq!(chunk, [0, 255, 1, 2]);
                assert!(eof);
            }
            _ => panic!("wrong response"),
        }
        assert!(session.handle(write("a", 0, b"x", true)).error.is_none());
        assert_eq!(std::fs::read(home.0.join("a")).unwrap(), b"x");
        assert!(session.handle(write("a", 2, b"x", false)).error.is_none());
        assert_eq!(std::fs::read(home.0.join("a")).unwrap(), b"x\0x");
        assert!(session
            .handle(write("a", FILE_LIMIT, b"x", true))
            .error
            .is_some());
        assert!(session
            .handle(write("a", 0, &vec![0; CHUNK_LIMIT + 1], true))
            .error
            .is_some());
        session.transferred = SESSION_LIMIT;
        assert!(session
            .handle(write("untouched", 0, b"x", true))
            .error
            .is_some());
        assert!(!home.0.join("untouched").exists());
        assert!(session.handle(read("a")).error.is_some());
        assert!(home.session().handle(read("a")).error.is_none());
        assert!(Request::FileRead {
            path: "a".into(),
            offset: u64::MAX,
            length: 1
        }
        .validate()
        .is_err());
        let file = File::create(home.0.join("oversized")).unwrap();
        file.set_len(FILE_LIMIT + 1).unwrap();
        assert!(home.session().handle(read("oversized")).error.is_some());
        file.set_len(FILE_LIMIT).unwrap();
        let mut exact = home.session();
        assert!(exact
            .handle(Request::FileRead {
                path: "oversized".into(),
                offset: FILE_LIMIT - 1,
                length: 1
            })
            .error
            .is_none());
        assert!(exact
            .handle(write("oversized", FILE_LIMIT - 1, b"x", true))
            .error
            .is_none());
        exact.transferred = SESSION_LIMIT - 1;
        assert!(exact.handle(write("a", 0, b"x", true)).error.is_none());
        assert_eq!(exact.transferred, SESSION_LIMIT);
        assert!(exact.handle(read("a")).error.is_some());
    }

    #[test]
    fn nofollow_each_component_hardlinks_and_special_files_refuse() {
        use std::os::unix::fs::symlink;
        let home = Home::new();
        let outside = Home::new();
        std::fs::write(outside.0.join("secret"), b"private").unwrap();
        symlink(&outside.0, home.0.join("link")).unwrap();
        symlink(outside.0.join("secret"), home.0.join("leaf")).unwrap();
        std::fs::hard_link(outside.0.join("secret"), home.0.join("hard")).unwrap();
        let fifo = CString::new(home.0.join("fifo").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let (socket, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let socket = File::from(std::os::fd::OwnedFd::from(socket));
        let mut session = home.session();
        assert!(session.validate_file(&socket).is_err());
        assert!(session
            .validate_file(&File::open("/dev/null").unwrap())
            .is_err());
        for path in ["link/secret", "leaf", "hard", "fifo"] {
            assert!(session.handle(read(path)).error.is_some(), "{path}");
            assert!(
                session
                    .handle(write(path, 0, b"changed", true))
                    .error
                    .is_some(),
                "{path}"
            );
        }
        #[cfg(target_os = "linux")]
        {
            let _listener = std::os::unix::net::UnixListener::bind(home.0.join("socket")).unwrap();
            assert!(session.handle(read("socket")).error.is_some());
            assert!(session
                .handle(write("socket", 0, b"x", true))
                .error
                .is_some());
        }
        assert_eq!(std::fs::read(outside.0.join("secret")).unwrap(), b"private");
        assert!(session
            .handle(write("ours", 0, b"ok", true))
            .error
            .is_none());
        std::fs::hard_link(home.0.join("ours"), home.0.join("our-link")).unwrap();
        assert!(session.handle(read("our-link")).error.is_none());
        assert!(home.session().handle(read("our-link")).error.is_some());
        // A device substituted for the home itself cannot enter the dirfd walk.
        assert!(Session::open(Path::new("/dev/null")).is_err());
    }

    #[test]
    fn every_operation_has_content_free_audit_fields_even_on_refusal() {
        let home = Home::new();
        let mut session = home.session();
        let secret = "private-content";
        for request in [
            write("private-path", 0, secret.as_bytes(), true),
            read("private-path"),
            Request::ClipboardSet {
                text: secret.into(),
            },
            Request::ClipboardGet,
            Request::Exec {
                argv: vec![secret.into()],
                cwd: "private-path".into(),
                timeout_ms: 0,
            },
        ] {
            let response = session.handle(request);
            let audit = serde_json::to_value(&response.audit).unwrap();
            response.audit.validate().unwrap();
            let mut frame = Vec::new();
            write_frame(&mut frame, &response).unwrap();
            assert_eq!(audit.as_object().unwrap().len(), 6);
            let bytes = audit.to_string();
            assert!(!bytes.contains(secret));
            assert!(!bytes.contains("private-path"));
            assert_eq!(response.audit.refused, response.error.is_some());
        }
    }

    #[test]
    fn clipboard_utf8_bytes_argv_and_frames_enforce_limits() {
        assert!(Request::ClipboardSet {
            text: "x".repeat(TEXT_LIMIT)
        }
        .validate()
        .is_ok());
        assert!(Request::ClipboardSet {
            text: "界".repeat(TEXT_LIMIT / 3 + 1)
        }
        .validate()
        .is_err());
        assert!(Request::ClipboardSet {
            text: "a\0b".into()
        }
        .validate()
        .is_err());
        for argv in [
            vec![],
            vec!["".into()],
            vec!["x".repeat(65537)],
            vec!["x".into(); 257],
            vec!["x\0".into()],
        ] {
            assert!(Request::Exec {
                argv,
                cwd: ".".into(),
                timeout_ms: 1
            }
            .validate()
            .is_err());
        }
        // Metacharacters remain ordinary argv bytes; there is no shell parser.
        assert!(Request::Exec {
            argv: vec!["/bin/echo".into(), "$(touch x);|*".into()],
            cwd: ".".into(),
            timeout_ms: u64::MAX
        }
        .validate()
        .is_ok());
        assert!(serde_json::from_str::<Request>(
            r#"{"operation":"exec","argv":["x"],"cwd":".","timeoutMs":1,"shell":true}"#
        )
        .is_err());
        assert!(read_frame(&mut io::Cursor::new(vec![b'x'; FRAME_LIMIT + 1])).is_err());
        assert!(read_frame(&mut io::Cursor::new(b"partial")).is_err());
        assert!(read_frame(&mut io::Cursor::new(b"")).unwrap().is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn exec_combines_streams_truncates_and_terminates_detached_descendants() {
        let home = Home::new();
        let session = home.session();
        let argv = vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf out; printf err >&2; yes x | head -c 1100000".into(),
        ];
        let result = run_exec(&argv, &session.home, 5000).unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.output.len(), OUTPUT_LIMIT);
        assert!(result.truncated);
        assert!(result.output.starts_with(b"outerr"));
        let pidfile = home.0.join("pid");
        // POSIX sh only: the test host need not have the image's python3.
        let argv = vec!["/bin/sh".into(), "-c".into(),
            "setsid sleep 30 & echo $! > pid; sleep 30".into()];
        let result = run_exec(&argv, &session.home, 1000).unwrap();
        assert!(result.timed_out);
        let pid: i32 = std::fs::read_to_string(pidfile).unwrap().trim().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn exec_preserves_literal_argv_cwd_and_nonzero_exit_status() {
        let home = Home::new();
        std::fs::create_dir(home.0.join("nested")).unwrap();
        let mut session = home.session();
        let response = session.handle(Request::Exec {
            argv: vec!["/bin/sh".into(), "-c".into(),
                "basename \"$PWD\"; printf '%s\\n' \"$1\"; exit 43".into(),
                "sh".into(), "$(touch injected);|*".into()],
            cwd: "nested".into(), timeout_ms: u64::MAX,
        });
        let Some(ResultValue::Exec(result)) = response.result else {
            panic!("exec failed");
        };
        assert_eq!(result.exit_code, Some(43));
        assert_eq!(result.output, b"nested\n$(touch injected);|*\n");
        assert!(!result.timed_out);
        assert!(!home.0.join("nested/injected").exists());
    }
}
