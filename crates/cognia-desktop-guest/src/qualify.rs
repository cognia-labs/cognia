//! Fixed root-only asynchronous collector. No workload-selected PID/path/argv.
//! EnvD returns from start before this detached collector begins. Qualification
//! result is a separate authenticated connection, never a prerequisite for death.
use crate::{acceptance, boundary, operations, promotion, protocol};
use cognia_desktop_guest::qualification::*;
use cognia_exec_sandbox::importer::ImportLaunch;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
const CLAIM: &str = "/run/cognia-desktop/qualification.claim";
const RESULT: &str = "/run/cognia-desktop/qualification.json";
const FAILURE: &str = "/run/cognia-desktop/qualification.failed";
const LIMIT: u64 = 128 * 1024;
static STAGE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
const ACCEPTANCE_STAGES: &[&str] = &[
    "acceptance_prepare",
    "acceptance_spawn",
    "acceptance_admission_wait",
    "acceptance_admission_validate",
    "acceptance_ack",
    "acceptance_payload",
    "payload_identity",
    "payload_acceptance",
    "payload_terminal_spawn",
    "payload_terminal_wait",
    "payload_terminal_peer",
    "payload_terminal_report",
    "payload_terminal_exited",
    "payload_terminal_deadline",
    "payload_terminal_probe",
    "payload_browser_local",
    "payload_browser_metadata",
    "payload_browser_redirect",
    "payload_browser_hostname",
    "payload_descendant",
    "payload_serialization",
    "importer_prepare",
    "importer_spawn",
    "importer_init",
    "importer_admission",
    "importer_boundary_report",
    "importer_release",
    "importer_wait",
    "importer_deadline",
    "importer_teardown",
    "importer_output",
    "importer_exited",
    "importer_identity",
    "importer_git_spawn",
    "importer_git_observe",
    "importer_git_write",
    "importer_git_wait",
    "importer_serialization",
    "payload_terminal_display",
    "payload_terminal_pty",
    "payload_terminal_exec",
    "payload_terminal_font",
    "importer_probe_snapshot",
    "importer_probe_sockets",
    "importer_probe_dns_spawn",
    "importer_probe_dns_deadline",
    "importer_probe_dns_channel",
    "importer_probe_helpers",
    "payload_acceptance_snapshot",
    "payload_acceptance_sockets",
    "payload_acceptance_dns_spawn",
    "payload_acceptance_dns_deadline",
    "payload_acceptance_dns_channel",
    "payload_acceptance_helpers",
    "payload_terminal_snapshot",
    "payload_terminal_sockets",
    "payload_terminal_dns_spawn",
    "payload_terminal_dns_deadline",
    "payload_terminal_dns_channel",
    "payload_terminal_helpers",
    "validation_desktop",
    "validation_negative_control",
    "validation_tamper_control",
    "validation_acceptance_admission",
    "validation_importer_admission",
    "validation_binding",
    "validation_acceptance_probe",
    "validation_terminal_probe",
    "validation_browser_process",
    "validation_importer_probe",
    "validation_git_process",
    "validation_browser",
    "validation_acceptance_executable",
    "validation_terminal_executable",
    "validation_importer_executable",
    "validation_git_executable",
    "validation_git_exit",
    "validation_browser_executable",
    "validation_browser_exit",
    "validation_browser_preview",
    "validation_browser_metadata",
    "validation_browser_redirect",
    "validation_browser_hostname",
    "validation_teardown",
    "negative_prepare",
    "negative_spawn",
    "negative_observe",
    "negative_rejection",
    "negative_teardown",
    "validation_weakened_launch",
    "validation_operations",
];
pub(crate) fn acceptance_stage(value: &str) {
    if let Some(index) = ACCEPTANCE_STAGES.iter().position(|name| *name == value) {
        stage(index as u8 + 10);
    }
}
fn stage(value: u8) {
    STAGE.store(value, std::sync::atomic::Ordering::Relaxed);
}
fn failure_stage() -> &'static str {
    match STAGE.load(std::sync::atomic::Ordering::Relaxed) {
        1 => "boundary",
        2 => "importer",
        3 => "acceptance",
        4 => "descendants",
        5 => "supervisor_death",
        6 => "validation",
        value if value >= 10 => ACCEPTANCE_STAGES
            .get((value - 10) as usize)
            .copied()
            .unwrap_or("bootstrap"),
        _ => "bootstrap",
    }
}
fn refused() -> io::Error {
    io::Error::other("qualification refused")
}
fn root() -> io::Result<()> {
    if unsafe { libc::getuid() } != 0 || unsafe { libc::geteuid() } != 0 {
        return Err(refused());
    }
    let meta = fs::symlink_metadata("/run/cognia-desktop")?;
    if !meta.is_dir() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
        return Err(refused());
    }
    Ok(())
}
fn protected_read(path: &str) -> io::Result<Vec<u8>> {
    root()?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.uid() != 0
        || meta.nlink() != 1
        || meta.mode() & 0o7777 != 0o600
        || meta.len() > LIMIT
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT {
        return Err(refused());
    }
    Ok(bytes)
}
fn protected_write(path: &str, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() as u64 > LIMIT {
        return Err(refused());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}
pub(crate) fn start() -> io::Result<()> {
    root()?;
    let live = boundary::load_current()?;
    protected_write(CLAIM, live.generation.as_bytes())?;
    let mut command = Command::new("/usr/local/bin/cognia-desktop-guest");
    command
        .arg("qualify-worker")
        .env_clear()
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0
                || libc::syscall(libc::SYS_close_range, 3_u32, u32::MAX, 4_u32) != 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn()?;
    io::stdout().write_all(
        &serde_json::to_vec(
            &serde_json::json!({"boundaryGeneration": live.generation, "started":true}),
        )
        .map_err(|_| refused())?,
    )
}
pub(crate) fn result() -> io::Result<()> {
    root()?;
    let claim = String::from_utf8(protected_read(CLAIM)?).map_err(|_| refused())?;
    if Path::new(FAILURE).exists() {
        let failure = protected_read(FAILURE)?;
        if failure.len() <= 128
            && failure
                .iter()
                .all(|b| b.is_ascii_lowercase() || *b == b'_' || *b == b':')
        {
            eprintln!("{}", String::from_utf8_lossy(&failure));
        }
        // A failed report stays private. Only this bounded typed projection
        // may cross the authenticated root result channel; stdout stays empty.
        if let Ok(bytes) = protected_read(RESULT) {
            if let Ok(report) = serde_json::from_slice::<WorkloadQualificationReport>(&bytes) {
                if report.boundary_generation == claim && report.validate().is_err() {
                    let diagnostic = BrowserDiagnostic::from_report(&report);
                    if diagnostic.validate_for(&claim).is_ok() {
                        if let Ok(json) = serde_json::to_string(&diagnostic) {
                            if json.len() <= 2048 {
                                eprintln!("qualification_browser_diagnostic:{json}");
                            }
                        }
                    }
                }
            }
        }
        return Err(refused());
    }
    let bytes = match protected_read(RESULT) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return io::stdout().write_all(
                &serde_json::to_vec(
                    &serde_json::json!({"boundaryGeneration":claim,"pending":true}),
                )
                .map_err(|_| refused())?,
            )
        }
        Err(error) => return Err(error),
    };
    let report: WorkloadQualificationReport =
        serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if report.boundary_generation != claim {
        return Err(refused());
    }
    report.validate().map_err(|_| refused())?;
    io::stdout().write_all(&bytes)
}
pub(crate) fn worker() -> io::Result<()> {
    let outcome = worker_inner();
    if outcome.is_err() && root().is_ok() {
        // Bootstrap errors precede watchdog installation and otherwise leave a
        // permanent pending result after the detached worker has already exited.
        let _ = protected_write(
            FAILURE,
            format!("qualification_failed:{}", failure_stage()).as_bytes(),
        );
    }
    outcome
}
fn worker_inner() -> io::Result<()> {
    root()?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(CLAIM)?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(refused());
    }
    // The start command's envd stdout has closed. This process retained no envd
    // descriptors and is neither a child of nor owned by the desktop supervisor.
    let pinned = boundary::load_current()?;
    let (_, _, watchdog_supervisor) = supervisor(pinned.namespace_init_pid)?;
    let completed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = completed.clone();
    let watchdog = std::thread::spawn(move || {
        let end = Instant::now() + Duration::from_secs(75);
        while Instant::now() < end {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = protected_write(FAILURE, b"qualification_deadline");
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                watchdog_supervisor.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0_u32,
            );
            libc::_exit(124);
        }
    });
    std::thread::sleep(Duration::from_secs(2));
    let outcome = collect().and_then(|report| {
        let bytes = serde_json::to_vec(&report).map_err(|_| refused())?;
        protected_write(RESULT, &bytes)
    });
    if outcome.is_err() {
        let _ = protected_write(
            FAILURE,
            format!("qualification_failed:{}", failure_stage()).as_bytes(),
        );
    }
    completed.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = watchdog.join();
    outcome
}
struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn importer(
    generation: &str,
) -> io::Result<(
    cognia_desktop_guest::observation::ProcessBoundaryReport,
    ImporterProbe,
    BTreeMap<u32, u64>,
)> {
    acceptance_stage("importer_prepare");
    let operation = uuid::Uuid::new_v4().to_string();
    let root = Path::new(promotion::IMPORTS);
    promotion::directory(root, 0o711, 0, 0, false)?;
    let staging = root.join(&operation);
    promotion::directory(&staging, 0o711, 0, 0, true)?;
    let input = staging.join("input");
    let output = staging.join("output");
    promotion::directory(&input, 0o750, 0, 1001, true)?;
    promotion::directory(&output, 0o700, 1001, 1001, true)?;
    let outcome = (|| {
        let (mut info, write) = UnixStream::pair()?;
        let mut command =
            ImportLaunch::prepare(&operation, &input, &output, write.as_fd())?.command()?;
        acceptance_stage("importer_spawn");
        let mut process = Process(command.spawn()?);
        drop(command);
        drop(write);
        acceptance_stage("importer_init");
        let init = crate::supervisor::init_pid(&mut info, &mut process.0)?;
        let until = Instant::now() + Duration::from_secs(10);
        acceptance_stage("importer_admission");
        let observed = loop {
            if let Ok(value) = boundary::observe_importer(process.0.id(), init) {
                break value;
            }
            if process.0.try_wait()?.is_some() || Instant::now() >= until {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        acceptance_stage("importer_boundary_report");
        let report = boundary::report(&observed, observed.workload_pid, 1001, generation)?;
        let mut pids = boundary::descendants(process.0.id())?;
        pids.insert(process.0.id());
        let terminated = pids
            .into_iter()
            .map(|pid| Ok((pid, boundary::start_time(pid)?)))
            .collect::<io::Result<BTreeMap<_, _>>>()?;
        acceptance_stage("importer_release");
        process
            .0
            .stdin
            .take()
            .ok_or_else(refused)?
            .write_all(b"Q")?;
        acceptance_stage("importer_wait");
        let until = Instant::now() + Duration::from_secs(25);
        let status = loop {
            if let Some(status) = process.0.try_wait()? {
                break status;
            }
            if Instant::now() >= until {
                acceptance_stage("importer_deadline");
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        acceptance_stage("importer_teardown");
        for (pid, start) in &terminated {
            if boundary::start_time(*pid).ok() == Some(*start) {
                return Err(refused());
            }
        }
        acceptance_stage("importer_output");
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(output.join("qualification.json"))?;
        let meta = file.metadata()?;
        if !meta.is_file() || meta.uid() != 1001 || meta.nlink() != 1 || meta.len() > 32768 {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(32769)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 32768 {
            return Err(refused());
        }
        // Failure payload is read only after exit and the same protected path,
        // owner/type/link/size checks as success. It can never qualify a run.
        if let Ok(failure) = serde_json::from_slice::<crate::probe::DiagnosticFailure>(&bytes) {
            if crate::probe::valid_failure(&failure.diagnostic_failure)
                && failure.diagnostic_failure.starts_with("importer_")
            {
                acceptance_stage(&failure.diagnostic_failure);
            }
            return Err(refused());
        }
        if !status.success() {
            acceptance_stage("importer_exited");
            return Err(refused());
        }
        let probe: ImporterProbe = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        Ok((report, probe, terminated))
    })();
    let _ = fs::remove_dir_all(&staging);
    outcome
}
fn weakened_launch(
    desktop: &cognia_desktop_guest::observation::ProcessBoundaryReport,
) -> io::Result<WeakenedLaunchEvidence> {
    use cognia_desktop_guest::observation::{
        ObservationPhase, ProcessBoundaryReport, ISOLATION_REVISION, NAMESPACES, REPORT_VERSION,
    };
    acceptance_stage("negative_prepare");
    let operation = uuid::Uuid::new_v4().to_string();
    let root = Path::new(promotion::IMPORTS);
    promotion::directory(root, 0o711, 0, 0, false)?;
    let staging = root.join(&operation);
    promotion::directory(&staging, 0o711, 0, 0, true)?;
    let input = staging.join("input");
    let output = staging.join("output");
    promotion::directory(&input, 0o750, 0, 1001, true)?;
    promotion::directory(&output, 0o700, 1001, 1001, true)?;
    let outcome = (|| {
        let (mut info, write) = UnixStream::pair()?;
        let mut command = ImportLaunch::prepare(&operation, &input, &output, write.as_fd())?
            .qualification_without_seccomp_command()?;
        acceptance_stage("negative_spawn");
        let mut process = Process(command.spawn()?);
        drop(command);
        drop(write);
        let init = crate::supervisor::init_pid(&mut info, &mut process.0)?;
        let init_start = boundary::start_time(init)?;
        acceptance_stage("negative_observe");
        let until = Instant::now() + Duration::from_secs(5);
        let (workload, observed) = loop {
            let mut candidates = boundary::descendants(init)?;
            candidates.insert(init);
            let value = candidates.into_iter().find_map(|pid| {
                (fs::read(format!("/proc/{pid}/cmdline")).ok()?.as_slice()
                    == b"/usr/local/bin/cognia-desktop-guest\0qualification-negative-wait\0")
                    .then(|| crate::probe::snapshot(pid).ok())
                    .flatten()
                    .map(|report| (pid, report))
            });
            if let Some(value) = value {
                break value;
            }
            if process.0.try_wait()?.is_some() || Instant::now() >= until {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        if !boundary::descendants(process.0.id())?.contains(&init)
            || boundary::start_time(init)? != init_start
            || NAMESPACES.iter().any(|name| {
                boundary::namespace(init, name).ok().as_ref() != observed.namespaces.get(*name)
            })
        {
            return Err(refused());
        }
        let read = |suffix: &str, limit: usize| -> io::Result<String> {
            let mut file = std::fs::File::open(format!("/proc/{workload}/{suffix}"))?;
            let mut bytes = String::new();
            Read::by_ref(&mut file)
                .take(limit as u64 + 1)
                .read_to_string(&mut bytes)?;
            if bytes.len() > limit {
                return Err(refused());
            }
            Ok(bytes)
        };
        let admission = ProcessBoundaryReport {
            report_version: REPORT_VERSION,
            phase: ObservationPhase::ImporterAdmission,
            workload_isolation_revision: ISOLATION_REVISION,
            boundary_generation: desktop.boundary_generation.clone(),
            namespace_init_pid: init,
            namespace_init_start_time: init_start,
            workload_pid: workload,
            workload_start_time: observed.start_time,
            namespaces: observed.namespaces,
            provider_namespaces: desktop.provider_namespaces.clone(),
            status: observed.status,
            network_devices: read("net/dev", 4096)?,
            ipv4_routes: read("net/route", 4096)?,
            ipv6_routes: read("net/ipv6_route", 8192)?,
            descriptors: observed.descriptors,
        };
        let mut pids = boundary::descendants(process.0.id())?;
        pids.insert(process.0.id());
        let terminated_processes = pids
            .into_iter()
            .map(|pid| Ok((pid, boundary::start_time(pid)?)))
            .collect::<io::Result<BTreeMap<_, _>>>()?;
        if boundary::start_time(workload)? != admission.workload_start_time {
            return Err(refused());
        }
        acceptance_stage("negative_rejection");
        let mut evidence = WeakenedLaunchEvidence {
            profile: "importer-without-seccomp-v1".into(),
            executable: observed.executable,
            admission,
            terminated_processes,
            surviving_processes: BTreeMap::new(),
        };
        // Reject inherited provider filters that make this an undemonstrated
        // negative control. Never grant a capability or weaken networking.
        evidence.validate(desktop).map_err(|_| refused())?;
        acceptance_stage("negative_teardown");
        if boundary::start_time(init)? != init_start
            || unsafe { libc::kill(init as i32, libc::SIGKILL) } != 0
        {
            return Err(refused());
        }
        let until = Instant::now() + Duration::from_secs(3);
        while process.0.try_wait()?.is_none() {
            if Instant::now() >= until {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        loop {
            evidence.surviving_processes = evidence
                .terminated_processes
                .iter()
                .filter(|(pid, start)| boundary::start_time(**pid).ok() == Some(**start))
                .map(|(pid, start)| (*pid, *start))
                .collect();
            if evidence.surviving_processes.is_empty() {
                break;
            }
            if Instant::now() >= until {
                return Err(refused());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        evidence.validate(desktop).map_err(|_| refused())?;
        Ok(evidence)
    })();
    let _ = fs::remove_dir_all(&staging);
    outcome
}
fn supervisor(init: u32) -> io::Result<(u32, u64, OwnedFd)> {
    let mut pid = init;
    for _ in 0..8 {
        let cmd = fs::read(format!("/proc/{pid}/cmdline"))?;
        if cmd == b"/usr/local/bin/cognia-desktop-guest\0supervise\0" {
            let started = boundary::start_time(pid)?;
            let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
            if raw < 0 {
                return Err(io::Error::last_os_error());
            }
            let fd = unsafe { OwnedFd::from_raw_fd(raw as i32) };
            if boundary::start_time(pid)? != started {
                return Err(refused());
            }
            return Ok((pid, started, fd));
        }
        let status = fs::read_to_string(format!("/proc/{pid}/status"))?;
        pid = status
            .lines()
            .find_map(|l| l.strip_prefix("PPid:"))
            .and_then(|v| v.trim().parse().ok())
            .filter(|p| *p > 1)
            .ok_or_else(refused)?;
    }
    Err(refused())
}
fn collect() -> io::Result<WorkloadQualificationReport> {
    stage(1);
    let live = boundary::load_current()?;
    if protected_read(CLAIM)? != live.generation.as_bytes() {
        return Err(refused());
    }
    let desktop = boundary::report(&live, live.workload_pid, 1000, &live.generation)?;
    let negative_control = crate::probe::snapshot(std::process::id())?;
    let weakened_launch = weakened_launch(&desktop)?;
    let (supervisor_pid, supervisor_start_time, supervisor_fd) =
        supervisor(live.namespace_init_pid)?;
    stage(2);
    let (importer_admission, importer_probe, mut terminated_processes) =
        importer(&live.generation)?;
    let operation = uuid::Uuid::new_v4().to_string();
    let parent = Path::new("/var/lib/cognia-desktop/workspace").join(&operation);
    promotion::directory(&parent, 0o711, 0, 0, true)?;
    let workspace = parent.join("workspace");
    promotion::directory(&workspace, 0o755, 1000, 1000, true)?;
    stage(3);
    let mut job =
        acceptance::spawn_diagnostic(&live, &operation, Instant::now() + Duration::from_secs(90))?;
    let acceptance_admission = job.boundary_report.take().ok_or_else(refused)?;
    let desktop_probe = job.diagnostic_report.take().ok_or_else(refused)?;
    acceptance_stage("validation_operations");
    let (mut operations, operation_socket, death_argv) = operation_probes(&live, supervisor_pid)?;
    stage(4);
    let mut pids = boundary::descendants(supervisor_pid)?;
    pids.insert(supervisor_pid);
    pids.insert(live.namespace_init_pid);
    for pid in pids {
        if let Ok(start) = boundary::start_time(pid) {
            terminated_processes.insert(pid, start);
        }
    }
    let detached_outer_pid = terminated_processes
        .keys()
        .copied()
        .find(|pid| {
            boundary::namespace(*pid, "pid").ok().as_ref() == live.namespaces.get("pid")
                && fs::read_to_string(format!("/proc/{pid}/status"))
                    .ok()
                    .and_then(|text| {
                        text.lines()
                            .find_map(|l| l.strip_prefix("NSpid:"))
                            .and_then(|v| v.split_whitespace().last())
                            .and_then(|v| v.parse::<u32>().ok())
                    })
                    == Some(desktop_probe.detached_pid)
        })
        .ok_or_else(refused)?;
    let death_command = death_argv.iter().flat_map(|arg| arg.bytes().chain(std::iter::once(0))).collect::<Vec<_>>();
    operations.death_processes = terminated_processes.iter().filter(|(pid, _)| {
        fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|cmd| cmd == death_command)
            && boundary::namespace(**pid, "pid").ok().as_ref() == live.namespaces.get("pid")
    }).map(|(pid, start)| (*pid, *start)).collect();
    if operations.death_processes.len() != 2 { return Err(refused()); }
    stage(5);
    // Pin identity, then kill the actual supervisor, not its workload namespace.
    // No Host connection, explicit desktop delete or AcceptanceJob drop triggers it.
    if boundary::start_time(supervisor_pid)? != supervisor_start_time
        || !boundary::still_current(&live)
    {
        return Err(refused());
    }
    if unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            supervisor_fd.as_raw_fd(),
            libc::SIGKILL,
            std::ptr::null::<libc::siginfo_t>(),
            0_u32,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let until = Instant::now() + Duration::from_secs(8);
    let surviving_processes = loop {
        let survivors: BTreeMap<_, _> = terminated_processes
            .iter()
            .filter(|(pid, start)| boundary::start_time(**pid).ok() == Some(**start))
            .map(|(p, s)| (*p, *s))
            .collect();
        if survivors.is_empty() || Instant::now() >= until {
            break survivors;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let ingress_errno = match std::net::TcpStream::connect_timeout(
        &"127.0.0.1:8000".parse().map_err(|_| refused())?,
        Duration::from_secs(1),
    ) {
        Ok(_) => 0,
        Err(e) => e.raw_os_error().unwrap_or(0),
    };
    // Only after recording post-supervisor evidence may local handle drop clean up.
    drop(job);
    drop(operation_socket);
    let _ = fs::remove_dir_all(parent);
    let report = WorkloadQualificationReport {
        report_version: PROBE_VERSION,
        boundary_generation: live.generation.clone(),
        negative_control,
        weakened_launch,
        desktop,
        acceptance_admission,
        importer_admission,
        desktop_probe,
        importer_probe,
        terminated_processes,
        surviving_processes,
        supervisor_pid,
        detached_outer_pid,
        supervisor_start_time,
        ingress_errno,
        operations: Some(operations),
    };
    stage(6);
    if let Err(category) = report.validate() {
        acceptance_stage(category);
        // Failed evidence remains root-only for diagnosis. FAILURE prevents the
        // result command from returning it as a qualification result.
        protected_write(RESULT, &serde_json::to_vec(&report).map_err(|_| refused())?)?;
        return Err(refused());
    }
    Ok(report)
}

struct OperationClient {
    socket: UnixStream,
    responses: io::BufReader<UnixStream>,
    admission: cognia_desktop_guest::observation::ProcessBoundaryReport,
}
impl OperationClient {
    fn connect(live: &boundary::Boundary) -> io::Result<Self> {
        let mut socket = UnixStream::connect(crate::control::SOCKET)?;
        socket.set_read_timeout(Some(Duration::from_secs(75)))?;
        socket.set_write_timeout(Some(Duration::from_secs(30)))?;
        operations::write_frame(&mut socket, &protocol::OperationSession {
            session_version: 1, boundary_generation: live.generation.clone(),
        })?;
        let mut responses = io::BufReader::new(socket.try_clone()?);
        let ready: protocol::OperationReady = serde_json::from_slice(
            &operations::read_frame(&mut responses)?.ok_or_else(refused)?).map_err(|_| refused())?;
        ready.admission.validate(1000).map_err(|_| refused())?;
        if ready.session_version != 1 || ready.admission.boundary_generation != live.generation
            || ready.admission.namespaces != live.namespaces { return Err(refused()); }
        Ok(Self { socket, responses, admission: ready.admission })
    }
    fn request(&mut self, request: operations::Request) -> io::Result<operations::Response> {
        operations::write_frame(&mut self.socket, &request)?;
        serde_json::from_slice(&operations::read_frame(&mut self.responses)?.ok_or_else(refused)?).map_err(|_| refused())
    }
    fn success(&mut self, request: operations::Request) -> io::Result<operations::ResultValue> {
        let response = self.request(request)?;
        if response.error.is_some() { return Err(refused()); }
        response.result.ok_or_else(refused)
    }
    fn refused(&mut self, name: &str, request: operations::Request) -> io::Result<ErrorObservation> {
        let response = self.request(request)?;
        if response.result.is_some() || response.error.as_deref() != Some("operation_refused") { return Err(refused()); }
        Ok(ErrorObservation { operation: name.into(), result: -1, errno: 1 })
    }
    fn exec(&mut self, argv: Vec<String>, cwd: &str, timeout_ms: u64) -> io::Result<operations::ExecResult> {
        match self.success(operations::Request::Exec { argv, cwd: cwd.into(), timeout_ms })? {
            operations::ResultValue::Exec(result) => Ok(result),
            _ => Err(refused()),
        }
    }
    fn close(self) -> io::Result<()> {
        self.socket.shutdown(std::net::Shutdown::Write)?;
        let mut reader = self.responses;
        if operations::read_frame(&mut reader)?.is_some() { return Err(refused()); }
        Ok(())
    }
}

fn python(code: &str, args: &[String]) -> Vec<String> {
    [vec!["/usr/local/bin/python3".into(), "-I".into(), "-c".into(), code.into()], args.to_vec()].concat()
}

fn operation_survivors(
    processes: &BTreeMap<u32, u64>, read: impl Fn(u32) -> io::Result<String>,
) -> io::Result<BTreeMap<u32, u64>> {
    let mut survivors = BTreeMap::new();
    for (&pid, &start) in processes {
        let stat = match read(pid) {
            Ok(stat) => stat,
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => continue,
            Err(error) => return Err(error),
        };
        if boundary::parse_start_time(&stat)? == start { survivors.insert(pid, start); }
    }
    Ok(survivors)
}

fn operation_probes(live: &boundary::Boundary, supervisor_pid: u32) -> io::Result<(OperationProbe, OperationClient, Vec<String>)> {
    use operations::{Request, ResultValue, CHUNK_LIMIT, FILE_LIMIT, TEXT_LIMIT};
    let mut client = OperationClient::connect(live)?;
    let directory = format!("cognia-recipe8-{}", uuid::Uuid::new_v4());
    let setup = client.exec(python(crate::probe::OPERATION_SETUP, std::slice::from_ref(&directory)), ".", 5000)?;
    if setup.exit_code != Some(0) { return Err(refused()); }
    let mut network_clients = Vec::new();
    for target in TARGETS {
        let result = client.exec(python(crate::probe::OPERATION_NETWORK, &[target.into()]), ".", 5000)?;
        if result.timed_out || result.truncated || !result.output.is_empty() { return Err(refused()); }
        network_clients.push(OperationNetworkClient { target: target.into(), exit_code: result.exit_code.ok_or_else(refused)? });
    }
    let mut refusals = Vec::new();
    for (label, name) in [("symlink", "symlink"), ("directory-symlink", "directory-link/file"),
        ("hardlink", "hard"), ("fifo", "fifo"), ("socket", "socket"), ("parent", "../escape")] {
        let path = format!("{directory}/{name}");
        refusals.push(client.refused(&format!("{label}-read"), Request::FileRead { path: path.clone(), offset: 0, length: 1 })?);
        refusals.push(client.refused(&format!("{label}-write"), Request::FileWrite { path, offset: 0, chunk: vec![1], r#final: true })?);
    }
    // The in-home FIFO reaches descriptor metadata's !is_file refusal, rather
    // than stopping at the outside-home path check as /dev/null would.
    for (name, path, length) in [("special-file", format!("{directory}/fifo"), 1),
        ("file-cap", format!("{directory}/large"), 1),
        ("chunk-read-cap", format!("{directory}/single"), CHUNK_LIMIT + 1)] {
        refusals.push(client.refused(name, Request::FileRead { path, offset: 0, length })?);
    }
    refusals.push(client.refused("chunk-write-cap", Request::FileWrite {
        path: format!("{directory}/single"), offset: 0, chunk: vec![0; CHUNK_LIMIT + 1], r#final: true,
    })?);
    let output = client.exec(python("import os; os.write(1,b'x'*700000); os.write(2,b'y'*700000)", &[]), ".", 5000)?;
    if output.exit_code != Some(0) || output.timed_out { return Err(refused()); }
    let timeout = client.exec(python(crate::probe::OPERATION_TIMEOUT, &[]), &directory, 1000)?;
    let timeout_processes = match client.success(Request::FileRead {
        path: format!("{directory}/timeout.json"), offset: 0, length: CHUNK_LIMIT,
    })? {
        ResultValue::FileRead { chunk, .. } => serde_json::from_slice::<BTreeMap<u32, u64>>(&chunk).map_err(|_| refused())?,
        _ => return Err(refused()),
    };
    let timeout_survivors = operation_survivors(&timeout_processes, |pid| {
        fs::read_to_string(format!("/proc/{}/root/proc/{pid}/stat", live.namespace_init_pid))
    })?;
    let text = "x".repeat(TEXT_LIMIT);
    match client.success(Request::ClipboardSet { text: text.clone() })? {
        ResultValue::ClipboardSet { bytes } if bytes == TEXT_LIMIT => (),
        _ => return Err(refused()),
    }
    let clipboard_bytes = match client.success(Request::ClipboardGet)? {
        ResultValue::ClipboardGet { text: actual } if actual == text => actual.len() as u64,
        _ => return Err(refused()),
    };
    refusals.push(client.refused("clipboard-cap", Request::ClipboardSet { text: "x".repeat(TEXT_LIMIT + 1) })?);
    let admission = client.admission.clone();
    // Quota starts afresh on the next root control connection, after this
    // connection's exact EOF has been acknowledged by the supervisor.
    client.close()?;
    let mut quota = OperationClient::connect(live)?;
    let path = format!("{directory}/transfer");
    for offset in (0..FILE_LIMIT).step_by(CHUNK_LIMIT) {
        match quota.success(Request::FileWrite { path: path.clone(), offset, chunk: vec![42; CHUNK_LIMIT], r#final: offset + CHUNK_LIMIT as u64 == FILE_LIMIT })? {
            ResultValue::FileWrite { bytes, .. } if bytes == CHUNK_LIMIT => (),
            _ => return Err(refused()),
        }
    }
    for _ in 0..3 {
        for offset in (0..FILE_LIMIT).step_by(CHUNK_LIMIT) {
            match quota.success(Request::FileRead { path: path.clone(), offset, length: CHUNK_LIMIT })? {
                ResultValue::FileRead { chunk, .. } if chunk == vec![42; CHUNK_LIMIT] => (),
                _ => return Err(refused()),
            }
        }
    }
    refusals.push(quota.refused("session-read-cap", Request::FileRead { path: path.clone(), offset: 0, length: 1 })?);
    refusals.push(quota.refused("session-write-cap", Request::FileWrite { path, offset: 0, chunk: vec![0], r#final: true })?);
    quota.close()?;
    let mut death = OperationClient::connect(live)?;
    let death_argv = python(crate::probe::OPERATION_DEATH, &[]);
    operations::write_frame(&mut death.socket, &Request::Exec { argv: death_argv.clone(), cwd: ".".into(), timeout_ms: 60_000 })?;
    // Wait for both the original executable and its detached grandchild. Never
    // infer supervisor-death coverage from a PID that was not observed alive.
    let command = death_argv.iter().flat_map(|arg| arg.bytes().chain(std::iter::once(0))).collect::<Vec<_>>();
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let matches = boundary::descendants(supervisor_pid)?.into_iter().filter_map(|pid| {
            if !fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|value| value == command) { return None; }
            let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            let (_, fields) = stat.rsplit_once(')')?;
            let fields = fields.split_whitespace().collect::<Vec<_>>();
            Some((fields.get(1)?.parse::<u32>().ok()?, fields.get(3)?.parse::<u32>().ok()?))
        }).collect::<Vec<_>>();
        // Both children must already have been adopted by the exec subreaper,
        // in different sessions. Seeing two PIDs before double-fork is insufficient.
        if matches.len() == 2 && matches[0].0 == matches[1].0 && matches[0].1 != matches[1].1 { break; }
        if Instant::now() >= until { return Err(refused()); }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok((OperationProbe {
        admission, network_clients, refusals, written_bytes: FILE_LIMIT, read_bytes: FILE_LIMIT,
        output_bytes: output.output.len() as u64, output_truncated: output.truncated,
        timeout_ms: 1000, timeout_signal: if timeout.timed_out { timeout.signal.unwrap_or(0) } else { 0 },
        clipboard_bytes, timeout_processes, timeout_survivors, death_processes: BTreeMap::new(),
    }, death, death_argv))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timeout_survivor_observation_accepts_only_enoent_as_missing() {
        let processes = BTreeMap::from([(123, 456)]);
        assert!(operation_survivors(&processes,
            |_| Err(io::Error::from_raw_os_error(libc::ENOENT))).unwrap().is_empty());
        for code in [libc::EACCES, libc::EIO, libc::ESRCH] {
            assert!(operation_survivors(&processes,
                |_| Err(io::Error::from_raw_os_error(code))).is_err());
        }
        assert!(operation_survivors(&processes, |_| Ok("malformed".into())).is_err());
        let stat = format!("123 (task) {} 456", vec!["0"; 19].join(" "));
        assert_eq!(operation_survivors(&processes, |_| Ok(stat.clone())).unwrap(), processes);
    }
    #[test]
    fn diagnostic_stage_catalog_is_unique_and_bounded() {
        let unique: std::collections::BTreeSet<_> = ACCEPTANCE_STAGES.iter().collect();
        assert_eq!(unique.len(), ACCEPTANCE_STAGES.len());
        assert!(ACCEPTANCE_STAGES.len() + 10 < u8::MAX as usize);
        assert!(ACCEPTANCE_STAGES.iter().all(|stage| stage.len() <= 64
            && stage
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')));
        assert!(ACCEPTANCE_STAGES.contains(&"importer_probe_dns_deadline"));
        assert!(ACCEPTANCE_STAGES.contains(&"validation_importer_probe"));
    }
    #[test]
    fn fixed_result_paths_are_outside_workload_mounts() {
        for path in [CLAIM, RESULT, FAILURE] {
            assert!(path.starts_with("/run/cognia-desktop/"));
        }
        assert_eq!(LIMIT, 131072);
    }
}
