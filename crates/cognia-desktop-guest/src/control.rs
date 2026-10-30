//! Fixed root-only handoff endpoint. The supervisor retains request authority
//! and launch lifetime; a direct child handles bounded transfer and promotion.
use crate::{
    acceptance, boundary, operations, promotion,
    protocol::{self, invalid, Manifest, Receipt, Report, Request},
};
use cognia_exec_sandbox::importer::ImportLaunch;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub(crate) const SOCKET: &str = operations::CONTROL_SOCKET;
const OPERATION_IDLE: Duration = Duration::from_secs(30);
fn budget_available(operations: bool, handoffs: usize, sessions: usize) -> bool {
    if operations { sessions < 10_000 } else { handoffs < 100 }
}
fn peer(socket: &UnixStream) -> io::Result<libc::ucred> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut size,
        )
    } != 0
        || size as usize != std::mem::size_of::<libc::ucred>()
        || credentials.uid != 0
    {
        return Err(invalid());
    }
    Ok(credentials)
}

/// The root-only 0600 listener and uid 0 enforce authority. The fixed pathname
/// is an endpoint sanity check, not an additional authentication factor.
fn operation_peer(socket: &UnixStream) -> io::Result<libc::ucred> {
    let credentials = peer(socket)?;
    operations::authorize_control_peer(credentials.uid, socket.local_addr()?.as_pathname())?;
    Ok(credentials)
}

fn root_identity() -> io::Result<()> {
    if unsafe { libc::geteuid() } != 0
        || unsafe { libc::getuid() } != 0
        || unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0
    {
        return Err(invalid());
    }
    Ok(())
}
fn duplicate(fd: i32) -> io::Result<OwnedFd> {
    let fd = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
fn timeout(socket: &UnixStream, deadline: Instant) -> io::Result<()> {
    socket.set_write_timeout(Some(
        deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(invalid)?
            .min(Duration::from_secs(30)),
    ))
}

/// envd transport only. The root supervisor, not this CLI, authorizes promotion.
pub(crate) fn forward() -> io::Result<()> {
    root_identity()?;
    let fd = unsafe { libc::fcntl(0, libc::F_DUPFD_CLOEXEC, 10) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut input = unsafe { File::from_raw_fd(fd) };
    let header = protocol::read_line(
        &mut input,
        protocol::HEADER_LIMIT,
        Instant::now() + Duration::from_secs(30),
    )?;
    let request: Request = serde_json::from_slice(&header).map_err(|_| invalid())?;
    let manifest = request.validate()?;
    let deadline = request.deadline()?;
    let mut socket = UnixStream::connect(SOCKET)?;
    peer(&socket)?;
    timeout(&socket, deadline)?;
    socket.write_all(&header)?;
    let total = manifest.bundle_bytes + manifest.files.iter().map(|file| file.bytes).sum::<u64>();
    let mut remaining = total;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let read = protocol::read_some(&mut input, &mut buffer[..limit], deadline)?;
        if read == 0 {
            return Err(invalid());
        }
        timeout(&socket, deadline)?;
        socket.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    if protocol::read_some(&mut input, &mut buffer[..1], deadline)? != 0 {
        return Err(invalid());
    }
    socket.shutdown(Shutdown::Write)?;
    let bytes = protocol::read_line(&mut socket, protocol::RECEIPT_LIMIT, deadline)?;
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if receipt.receipt_version != 3
        || receipt.operation_id != request.operation_id
        || receipt.manifest_digest != request.manifest_digest
        || receipt.commit != manifest.commit
        || receipt.source_tree_sha256 != manifest.source_tree_sha256
        || receipt.source_file_count != manifest.source_file_count
        || receipt.source_bytes != manifest.source_bytes
        || !protocol::canonical_uuid(&receipt.boundary_generation)
        || receipt.workspace != format!("/workspace/{}/workspace", request.operation_id)
        || receipt.launched != request.launch.is_some()
    {
        return Err(invalid());
    }
    std::io::stdout().write_all(&bytes)
}

struct Pending {
    child: Child,
    report: UnixStream,
    client: UnixStream,
    client_pidfd: OwnedFd,
    buffer: Vec<u8>,
    request: Option<Request>,
    prepared: bool,
    importer_boundary: Option<cognia_desktop_guest::observation::ProcessBoundaryReport>,
    eof: bool,
    deadline: Instant,
    operation_session: bool,
    closing: Option<Instant>,
}
impl Pending {
    fn end_session(&mut self) {
        if self.closing.is_none() {
            // Wake an idle reader or a writer whose Host disappeared. Keep the
            // worker alive while it drains the current bounded exec and proves
            // helper/payload termination via OperationsComplete.
            let _ = self.client.shutdown(Shutdown::Both);
            self.closing = Some(Instant::now() + Duration::from_secs(90));
        }
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        kill_and_reap(&mut self.child);
    }
}
pub(crate) struct Control {
    listener: UnixListener,
    pending: Option<Pending>,
    jobs: Vec<acceptance::AcceptanceJob>,
    completed: usize,
    operation_sessions: usize,
}
impl Drop for Control {
    fn drop(&mut self) {
        self.pending.take();
        self.jobs.clear();
        if self.listener.local_addr().ok().and_then(|addr| addr.as_pathname().map(std::path::PathBuf::from))
            .is_some_and(|path| path == std::path::Path::new(SOCKET)) {
            let _ = std::fs::remove_file(SOCKET);
        }
    }
}
impl Control {
    pub(crate) fn bind() -> io::Result<Self> {
        let listener = UnixListener::bind(SOCKET)?;
        std::fs::set_permissions(SOCKET, std::fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok(Self {
            listener,
            pending: None,
            jobs: Vec::new(),
            completed: 0,
            operation_sessions: 0,
        })
    }
    pub(crate) fn tick(&mut self, boundary: &boundary::Boundary) -> io::Result<()> {
        for job in &mut self.jobs {
            job.check()?;
        }
        match self.listener.accept() {
            Ok((client, _)) if self.pending.is_none() => {
                // Before admission no workload can exist. Resource exhaustion
                // or a rejected peer closes this connection, not the desktop.
                let attempt = (|| -> io::Result<Pending> {
                    let client_pid = peer(&client)?.pid;
                    let raw_pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, client_pid, 0) };
                    if raw_pidfd < 0 {
                        return Err(invalid());
                    }
                    let client_pidfd = unsafe { OwnedFd::from_raw_fd(raw_pidfd as i32) };
                    let (report, worker_report) = UnixStream::pair()?;
                    report.set_nonblocking(true)?;
                    let client_fd = duplicate(client.as_raw_fd())?;
                    let report_fd = duplicate(worker_report.as_raw_fd())?;
                    // Reserve low descriptor holes before std::process creates its exec pipe.
                    let reservations = [
                        duplicate_low(client.as_raw_fd())?,
                        duplicate_low(client.as_raw_fd())?,
                    ];
                    let parent = unsafe { libc::getpid() };
                    let mut command = Command::new("/usr/local/bin/cognia-desktop-guest");
                    command
                        .arg("handoff-worker")
                        .env_clear()
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());
                    unsafe {
                        command.pre_exec(move || {
                            let _held = &reservations;
                            if libc::syscall(libc::SYS_close_range, 3_u32, u32::MAX, 4_u32) != 0
                                || libc::dup2(client_fd.as_raw_fd(), 3) < 0
                                || libc::dup2(report_fd.as_raw_fd(), 4) < 0
                                || libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) != 0
                                || libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0
                                || libc::getppid() != parent
                            {
                                return Err(invalid());
                            }
                            Ok(())
                        });
                    }
                    let child = command.spawn()?;
                    drop(command);
                    drop(worker_report);
                    Ok(Pending {
                        child,
                        report,
                        client,
                        client_pidfd,
                        buffer: Vec::new(),
                        request: None,
                        prepared: false,
                        importer_boundary: None,
                        eof: false,
                        deadline: Instant::now() + Duration::from_secs(30),
                        operation_session: false,
                        closing: None,
                    })
                })();
                if let Ok(pending) = attempt { self.pending = Some(pending); }
            }
            // Refuse an extra connection without disturbing the active job or
            // skipping its lifetime monitor on this tick.
            Ok(_) => (),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => (),
            Err(error) => return Err(error),
        }
        let Some(pending) = &mut self.pending else {
            return Ok(());
        };
        let mut alive = libc::pollfd {
            fd: pending.client_pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let polled = unsafe { libc::poll(&mut alive, 1, 0) };
        if polled < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted { return Ok(()); }
            return Err(error);
        }
        if polled != 0 || Instant::now() >= pending.deadline {
            if pending.operation_session {
                pending.end_session();
            } else if pending.request.is_none() {
                self.pending.take();
                return Ok(());
            } else { return Err(invalid()); }
        }
        if pending.closing.is_some_and(|until| Instant::now() >= until) {
            // The worker failed to attest that the confined payload finished.
            return Err(invalid());
        }
        loop {
            let mut bytes = [0_u8; 8192];
            match pending.report.read(&mut bytes) {
                Ok(0) => {
                    pending.eof = true;
                    break;
                }
                Ok(count) => pending.buffer.extend_from_slice(&bytes[..count]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => return Err(error),
            }
            if pending.buffer.len() > protocol::REPORT_LIMIT {
                return Err(invalid());
            }
            // Consume complete records before draining another burst. Many
            // small audit frames must not exhaust the single-frame buffer cap.
            if pending.buffer.contains(&b'\n') { break; }
        }
        while let Some(end) = pending.buffer.iter().position(|byte| *byte == b'\n') {
            let report: Report =
                serde_json::from_slice(&pending.buffer[..=end]).map_err(|_| invalid())?;
            pending.buffer.drain(..=end);
            match report {
                Report::Operations(session) if pending.request.is_none() && !pending.operation_session => {
                    if session.validate().is_err() || operation_peer(&pending.client).is_err()
                        || session.boundary_generation != boundary.generation
                        || !budget_available(true, self.completed, self.operation_sessions) {
                        self.pending.take();
                        return Ok(());
                    }
                    if !boundary::still_current(boundary) {
                        return Err(invalid());
                    }
                    pending.operation_session = true;
                    self.operation_sessions += 1;
                    pending.deadline = Instant::now() + Duration::from_secs(3600);
                    if pending.report.write_all(b"G").is_err() {
                        self.pending.take();
                        return Ok(());
                    }
                }
                Report::OperationAudit(audit) if pending.operation_session && !pending.prepared => {
                    // Audit storage is best effort; log rotation/disk pressure
                    // does not invalidate the workload's lifetime guard.
                    if audit.store().is_err() { eprintln!("operation audit unavailable"); }
                }
                Report::OperationsComplete if pending.operation_session && !pending.prepared => {
                    pending.prepared = true;
                }
                Report::Header(request) if pending.request.is_none() && !pending.prepared && !pending.operation_session => {
                    if request.validate().is_err() || request.deadline().is_err()
                        || !budget_available(false, self.completed, self.operation_sessions) {
                        self.pending.take();
                        return Ok(());
                    }
                    pending.deadline = request.deadline()?;
                    pending.request = Some(request);
                    // One byte on a fresh socket cannot fill its send buffer.
                    if pending.report.write_all(b"G").is_err() {
                        self.pending.take();
                        return Ok(());
                    }
                }
                Report::Prepared(mut evidence)
                    if pending.request.is_some() && !pending.prepared =>
                {
                    evidence.boundary_generation = boundary.generation.clone();
                    evidence.validate(1001).map_err(|_| invalid())?;
                    pending.importer_boundary = Some(evidence);
                    pending.prepared = true
                }
                _ => return Err(invalid()),
            }
        }
        let Some(status) = pending.child.try_wait()? else {
            return Ok(());
        };
        if pending.request.is_none() && !pending.operation_session {
            self.pending.take();
            return Ok(());
        }
        if !status.success() {
            return Err(invalid());
        }
        if !pending.eof {
            return Ok(());
        }
        if !pending.buffer.is_empty() || !pending.prepared {
            return Err(invalid());
        }
        if pending.operation_session {
            let _ = pending.client.shutdown(Shutdown::Both);
            self.pending.take();
            return Ok(());
        }
        let request = pending.request.as_ref().ok_or_else(invalid)?;
        let manifest = request.validate()?;
        if !boundary::still_current(boundary) {
            return Err(invalid());
        }
        let acceptance_boundary = if let Some(launch) = &request.launch {
            let job = acceptance::spawn(
                boundary,
                &request.operation_id,
                &launch.script,
                pending.deadline,
            )?;
            let evidence = job.boundary_report.clone().ok_or_else(invalid)?;
            self.jobs.push(job);
            Some(evidence)
        } else {
            None
        };
        let receipt = Receipt {
            receipt_version: 3,
            boundary_generation: boundary.generation.clone(),
            operation_id: request.operation_id.clone(),
            commit: manifest.commit,
            manifest_digest: request.manifest_digest.clone(),
            source_tree_sha256: manifest.source_tree_sha256,
            source_file_count: manifest.source_file_count,
            source_bytes: manifest.source_bytes,
            workspace: format!("/workspace/{}/workspace", request.operation_id),
            launched: request.launch.is_some(),
            importer_boundary: pending.importer_boundary.take().ok_or_else(invalid)?,
            acceptance_boundary,
        };
        promotion::store_receipt(request, &receipt)?;
        timeout(&pending.client, pending.deadline)?;
        protocol::write_json(&mut pending.client, &receipt, protocol::RECEIPT_LIMIT)?;
        pending.client.shutdown(Shutdown::Both)?;
        self.pending.take();
        self.completed += 1;
        Ok(())
    }
}
fn duplicate_low(fd: i32) -> io::Result<OwnedFd> {
    let value = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    if value < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(value) })
}
fn kill_and_reap(child: &mut Child) {
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            _ => break,
        }
    }
}
struct ImportProcess(Child);
impl Drop for ImportProcess {
    fn drop(&mut self) {
        kill_and_reap(&mut self.0);
    }
}
fn receive(
    socket: &mut UnixStream,
    file: &mut File,
    length: u64,
    expected: &str,
    deadline: Instant,
) -> io::Result<()> {
    let mut digest = Sha256::new();
    let mut remaining = length;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let read = protocol::read_some(socket, &mut buffer[..limit], deadline)?;
        if read == 0 {
            return Err(invalid());
        }
        file.write_all(&buffer[..read])?;
        digest.update(&buffer[..read]);
        remaining -= read as u64;
    }
    if hex::encode(digest.finalize()) != expected {
        return Err(invalid());
    }
    file.sync_all()
}
fn run_import(
    request: &Request,
    input: &std::path::Path,
    output: &std::path::Path,
    deadline: Instant,
) -> io::Result<cognia_desktop_guest::observation::ProcessBoundaryReport> {
    let (mut info, write) = UnixStream::pair()?;
    let mut command =
        ImportLaunch::prepare(&request.operation_id, input, output, write.as_fd())?.command()?;
    let mut process = ImportProcess(command.spawn()?);
    drop(command);
    drop(write);
    let init = crate::supervisor::init_pid(&mut info, &mut process.0)?;
    let admission_deadline = deadline.min(Instant::now() + Duration::from_secs(20));
    let observed = loop {
        if process.0.try_wait()?.is_some() || Instant::now() >= admission_deadline {
            return Err(invalid());
        }
        if let Ok(observed) = boundary::observe_importer(process.0.id(), init) {
            break observed;
        }
        thread::sleep(Duration::from_millis(20));
    };
    let evidence = boundary::report(
        &observed,
        observed.workload_pid,
        1001,
        &request.operation_id,
    )?;
    let mut admission = process.0.stdin.take().ok_or_else(invalid)?;
    admission.write_all(b"G")?;
    drop(admission);
    loop {
        if Instant::now() >= deadline {
            return Err(invalid());
        }
        if let Some(status) = process.0.try_wait()? {
            if !status.success() {
                return Err(invalid());
            }
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    // Namespace init's death kills every member, including setsid/double-fork.
    let death_deadline = deadline.min(Instant::now() + Duration::from_secs(5));
    while boundary::start_time(init).ok() == Some(observed.namespace_init_start_time) {
        if Instant::now() >= death_deadline {
            return Err(invalid());
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(evidence)
}
pub(crate) fn worker() -> io::Result<()> {
    root_identity()?;
    let parent = unsafe { libc::getppid() };
    let mut socket = unsafe { UnixStream::from_raw_fd(3) };
    let mut report = unsafe { UnixStream::from_raw_fd(4) };
    if peer(&report)?.pid != parent || parent <= 1 {
        return Err(invalid());
    }
    peer(&socket)?;
    for fd in [3, 4] {
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err(invalid());
        }
    }
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0
        || unsafe { libc::getppid() } != parent
    {
        return Err(invalid());
    }
    let header = protocol::read_line(
        &mut socket,
        protocol::HEADER_LIMIT,
        Instant::now() + Duration::from_secs(30),
    )?;
    if let Ok(session) = serde_json::from_slice::<protocol::OperationSession>(&header) {
        return operation_worker(socket, report, session);
    }
    let request: Request = serde_json::from_slice(&header).map_err(|_| invalid())?;
    let manifest: Manifest = request.validate()?;
    let deadline = request.deadline()?;
    timeout(&report, deadline)?;
    protocol::write_json(
        &mut report,
        &Report::Header(request.clone()),
        protocol::REPORT_LIMIT,
    )?;
    let mut admission = [0_u8];
    if protocol::read_some(&mut report, &mut admission, deadline)? != 1 || admission != [b'G'] {
        return Err(invalid());
    }
    let (input, output) = promotion::stage(&request)?;
    receive(
        &mut socket,
        &mut promotion::input_file(&input, "source.bundle")?,
        manifest.bundle_bytes,
        &manifest.bundle_sha256,
        deadline,
    )?;
    for (index, file) in manifest.files.iter().enumerate() {
        receive(
            &mut socket,
            &mut promotion::input_file(&input, &format!("file-{index}"))?,
            file.bytes,
            &file.sha256,
            deadline,
        )?;
    }
    if protocol::read_some(&mut socket, &mut admission, deadline)? != 0 {
        return Err(invalid());
    }
    let evidence = run_import(&request, &input, &output, deadline)?;
    promotion::promote(&request, &manifest, &output, deadline)?;
    promotion::finish_staging(&request)?;
    protocol::write_json(
        &mut report,
        &Report::Prepared(evidence),
        protocol::REPORT_LIMIT,
    )
}

fn operation_worker(mut socket: UnixStream, mut report: UnixStream, session: protocol::OperationSession) -> io::Result<()> {
    session.validate()?;
    operation_peer(&socket)?;
    let deadline = Instant::now() + Duration::from_secs(3600);
    protocol::write_json(&mut report, &Report::Operations(session.clone()), protocol::REPORT_LIMIT)?;
    let mut admission = [0];
    if protocol::read_some(&mut report, &mut admission, deadline)? != 1 || admission != *b"G" {
        return Err(invalid());
    }
    let boundary = boundary::load_current()?;
    if boundary.generation != session.boundary_generation { return Err(invalid()); }
    let mut job = acceptance::spawn_operations(&boundary)?;
    let ready = operations::write_frame(&mut socket, &protocol::OperationReady {
        session_version: 1,
        admission: job.boundary_report.clone().ok_or_else(invalid)?,
    });
    if ready.is_ok() && socket.set_read_timeout(Some(OPERATION_IDLE)).is_ok()
        && socket.set_write_timeout(Some(Duration::from_secs(30))).is_ok() {
        exchange_operations(&mut socket, &mut report, &mut job, deadline,
            || boundary::still_current(&boundary))?;
    }
    job.finish_operations()?;
    protocol::write_json(&mut report, &Report::OperationsComplete, protocol::REPORT_LIMIT)
}

fn exchange_operations(
    socket: &mut UnixStream, report: &mut UnixStream,
    job: &mut acceptance::AcceptanceJob, deadline: Instant,
    current: impl Fn() -> bool,
) -> io::Result<()> {
    let mut requests = match socket.try_clone() {
        Ok(reader) => io::BufReader::new(reader),
        Err(_) => return Ok(()),
    };
    for _ in 0..10_000 {
        if Instant::now() >= deadline { break; }
        // Host framing, idle timeout and disconnect are session termination,
        // not loss of a descendant guard. Nothing is running at this point.
        let bytes = match operations::read_frame(&mut requests) {
            Ok(Some(bytes)) => bytes,
            Ok(None) | Err(_) => break,
        };
        if Instant::now() >= deadline { break; }
        if !current() { return Err(invalid()); }
        let request: operations::Request = match serde_json::from_slice(&bytes) {
            Ok(request) => request,
            Err(_) => break,
        };
        let control = job.operations_control.as_mut().ok_or_else(invalid)?;
        control.set_read_timeout(Some(Duration::from_secs(70)))?;
        control.set_write_timeout(Some(Duration::from_secs(30)))?;
        control.write_all(&bytes)?;
        let response = operations::read_frame(&mut io::BufReader::new(&mut *control))?.ok_or_else(invalid)?;
        let response: operations::Response = serde_json::from_slice(&response).map_err(|_| invalid())?;
        let audit = response.root_audit(&request);
        report.set_write_timeout(Some(Duration::from_secs(30)))?;
        protocol::write_json(report, &Report::OperationAudit(audit), protocol::REPORT_LIMIT)?;
        if operations::write_frame(socket, &response).is_err() { break; }
        job.check()?;
    }
    Ok(())
}

/// Fixed envd stdio bridge for a Host-owned control connection. It never
/// executes argv; all operation frames go to the root supervisor's socket.
pub(crate) fn forward_operations() -> io::Result<()> {
    root_identity()?;
    let mut socket = UnixStream::connect(SOCKET)?;
    peer(&socket)?;
    socket.set_read_timeout(Some(Duration::from_secs(75)))?;
    socket.set_write_timeout(Some(Duration::from_secs(30)))?;
    let mut input = io::BufReader::new(io::stdin());
    let header = operations::read_frame(&mut input)?.ok_or_else(invalid)?;
    let session: protocol::OperationSession = serde_json::from_slice(&header).map_err(|_| invalid())?;
    session.validate()?;
    socket.write_all(&header)?;
    let mut responses = io::BufReader::new(socket.try_clone()?);
    let mut output = io::stdout();
    output.write_all(&operations::read_frame(&mut responses)?.ok_or_else(invalid)?)?;
    output.flush()?;
    for _ in 0..10_000 {
        let Some(bytes) = operations::read_frame(&mut input)? else {
            socket.shutdown(Shutdown::Write)?;
            // Keep the authenticated peer alive until the supervisor has
            // acknowledged worker teardown and closed its retained descriptor.
            if operations::read_frame(&mut responses)?.is_some() { return Err(invalid()); }
            return Ok(());
        };
        socket.write_all(&bytes)?;
        output.write_all(&operations::read_frame(&mut responses)?.ok_or_else(invalid)?)?;
        output.flush()?;
    }
    Err(invalid())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_boundary() -> boundary::Boundary {
        boundary::Boundary { generation: uuid::Uuid::new_v4().to_string(), isolation_revision: 1,
            namespace_init_pid: 1, namespace_init_start_time: 1, workload_pid: 2,
            workload_start_time: 2, namespaces: Default::default() }
    }
    fn pending_session() -> (Control, UnixStream, UnixStream) {
        use std::os::linux::net::SocketAddrExt;
        let address = std::os::unix::net::SocketAddr::from_abstract_name(
            uuid::Uuid::new_v4().as_bytes()).unwrap();
        let listener = UnixListener::bind_addr(&address).unwrap();
        listener.set_nonblocking(true).unwrap();
        let (client, host) = UnixStream::pair().unwrap();
        let (report, writer) = UnixStream::pair().unwrap();
        report.set_nonblocking(true).unwrap();
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, std::process::id(), 0) };
        assert!(fd >= 0);
        let pending = Pending {
            child: Command::new("/bin/sleep").arg("60").spawn().unwrap(),
            report, client, client_pidfd: unsafe { OwnedFd::from_raw_fd(fd as i32) },
            buffer: Vec::new(), request: None, prepared: false, importer_boundary: None,
            eof: false, deadline: Instant::now() + Duration::from_secs(3600),
            operation_session: true, closing: None,
        };
        (Control { listener, pending: Some(pending), jobs: Vec::new(), completed: 100,
            operation_sessions: 1 }, host, writer)
    }

    #[test]
    fn host_idle_disconnect_and_one_hour_deadline_finish_without_abort() {
        assert_eq!(OPERATION_IDLE, Duration::from_secs(30));
        for reason in ["idle", "disconnect", "deadline"] {
            let (mut job, mut desktop) = acceptance::tests::operation_job();
            let (mut socket, host) = UnixStream::pair().unwrap();
            let (mut report, _reader) = UnixStream::pair().unwrap();
            socket.set_read_timeout(Some(Duration::from_millis(10))).unwrap();
            let deadline = if reason == "deadline" { Instant::now() }
                else { Instant::now() + Duration::from_secs(1) };
            let _host = if reason == "disconnect" { drop(host); None } else { Some(host) };
            exchange_operations(&mut socket, &mut report, &mut job, deadline, || true).unwrap();
            job.finish_operations().unwrap();
            drop(job);
            assert!(desktop.0.try_wait().unwrap().is_none(), "{reason}");
        }
    }

    #[test]
    fn disconnect_after_request_drains_reply_and_audits_root_request() {
        let request = operations::Request::ClipboardGet;
        let response = operations::Response { result: None, error: Some("operation_refused".into()),
            audit: operations::Audit { operation: "untrusted-label".into(), input_bytes: usize::MAX,
                output_bytes: usize::MAX, path_length: usize::MAX, argv_count: usize::MAX, refused: false } };
        let (mut job, mut desktop) = acceptance::tests::operation_reply_job(
            Some(serde_json::to_string(&response).unwrap()));
        let (mut socket, mut host) = UnixStream::pair().unwrap();
        let (mut report, reader) = UnixStream::pair().unwrap();
        operations::write_frame(&mut host, &request).unwrap();
        host.shutdown(Shutdown::Both).unwrap();
        exchange_operations(&mut socket, &mut report, &mut job,
            Instant::now() + Duration::from_secs(1), || true).unwrap();
        job.finish_operations().unwrap();
        let frame = operations::read_frame(&mut io::BufReader::new(reader)).unwrap().unwrap();
        let Report::OperationAudit(audit) = serde_json::from_slice(&frame).unwrap() else { panic!("audit missing"); };
        assert_eq!(audit.operation, "clipboard-get");
        assert_eq!(audit.input_bytes, 0);
        assert_eq!(audit.output_bytes, operations::OUTPUT_LIMIT);
        assert!(audit.refused);
        drop(job);
        assert!(desktop.0.try_wait().unwrap().is_none());
    }

    #[test]
    fn supervisor_deadline_and_peer_death_request_cleanup_then_require_attestation() {
        for peer_death in [false, true] {
            let (mut control, _host, _report) = pending_session();
            let pending = control.pending.as_mut().unwrap();
            let mut dead_peer = Command::new("/bin/true").spawn().unwrap();
            if peer_death {
                let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, dead_peer.id(), 0) };
                assert!(fd >= 0);
                pending.client_pidfd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
                dead_peer.wait().unwrap();
            } else {
                dead_peer.wait().unwrap();
                pending.deadline = Instant::now();
            }
            control.tick(&test_boundary()).unwrap();
            let pending = control.pending.as_mut().unwrap();
            assert!(pending.closing.is_some());
            assert!(pending.child.try_wait().unwrap().is_none());
            // No successful completion after the drain grace is a genuine
            // lifetime-guard failure, and must propagate to supervisor teardown.
            pending.closing = Some(Instant::now());
            assert!(control.tick(&test_boundary()).is_err());
        }
    }

    #[test]
    fn second_connection_is_closed_while_active_session_keeps_running() {
        let (mut control, _host, _report) = pending_session();
        let worker = control.pending.as_ref().unwrap().child.id();
        let mut extra = UnixStream::connect_addr(&control.listener.local_addr().unwrap()).unwrap();
        control.tick(&test_boundary()).unwrap();
        assert_eq!(control.pending.as_ref().unwrap().child.id(), worker);
        assert_eq!(extra.read(&mut [0]).unwrap(), 0);
        assert_eq!(control.completed, 100);
    }

    #[test]
    fn operation_budget_is_independent_and_clean_completion_does_not_charge_handoffs() {
        assert!(budget_available(true, 100, 0));
        assert!(!budget_available(false, 100, 0));
        assert!(budget_available(false, 0, 10_000));
        assert!(!budget_available(true, 0, 10_000));
        let (mut control, _host, mut report) = pending_session();
        protocol::write_json(&mut report, &Report::OperationsComplete, protocol::REPORT_LIMIT).unwrap();
        drop(report);
        let pending = control.pending.as_mut().unwrap();
        kill_and_reap(&mut pending.child);
        pending.child = Command::new("/bin/true").spawn().unwrap();
        pending.child.wait().unwrap();
        control.tick(&test_boundary()).unwrap();
        control.tick(&test_boundary()).unwrap();
        assert!(control.pending.is_none());
        assert_eq!(control.completed, 100);
    }

    #[test]
    fn unproven_worker_exit_and_broken_payload_pipe_remain_fatal() {
        for success in [false, true] {
            let (mut control, _host, report) = pending_session();
            drop(report);
            let pending = control.pending.as_mut().unwrap();
            kill_and_reap(&mut pending.child);
            pending.child = Command::new(if success { "/bin/true" } else { "/bin/false" }).spawn().unwrap();
            pending.child.wait().unwrap();
            assert!(control.tick(&test_boundary()).is_err());
        }
        let (mut job, mut desktop) = acceptance::tests::operation_job();
        // Closing this descriptor simulates lost payload/relay ownership.
        job.operations_control.take();
        let (mut socket, mut host) = UnixStream::pair().unwrap();
        let (mut report, _reader) = UnixStream::pair().unwrap();
        operations::write_frame(&mut host, &operations::Request::ClipboardGet).unwrap();
        assert!(exchange_operations(&mut socket, &mut report, &mut job,
            Instant::now() + Duration::from_secs(1), || true).is_err());
        drop(job);
        assert!(!desktop.0.wait().unwrap().success());

        let (mut job, mut desktop) = acceptance::tests::operation_job();
        let (mut socket, mut host) = UnixStream::pair().unwrap();
        let (mut report, _reader) = UnixStream::pair().unwrap();
        operations::write_frame(&mut host, &operations::Request::ClipboardGet).unwrap();
        assert!(exchange_operations(&mut socket, &mut report, &mut job,
            Instant::now() + Duration::from_secs(1), || false).is_err());
        drop(job);
        assert!(!desktop.0.wait().unwrap().success());
    }
    #[test]
    fn control_and_ingress_are_separate_fixed_endpoints() {
        assert_ne!(SOCKET, crate::relay::SOCKET);
        assert!(!SOCKET.starts_with("/workspace"));
    }

    #[test]
    fn operation_sessions_refuse_socketpairs_and_non_control_endpoints() {
        let (socket, _other) = UnixStream::pair().unwrap();
        assert!(operation_peer(&socket).is_err());
        for version in [0, 2] {
            assert!(protocol::OperationSession { session_version: version,
                boundary_generation: "6a370d8e-2d69-40fb-9586-786b7424365a".into() }.validate().is_err());
        }
        assert!(serde_json::from_str::<protocol::OperationSession>(
            r#"{"sessionVersion":1,"boundaryGeneration":"6a370d8e-2d69-40fb-9586-786b7424365a","socket":"/tmp/other"}"#).is_err());
        assert_ne!(SOCKET, crate::relay::SOCKET);
    }
}
