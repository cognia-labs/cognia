//! Recipe-8 wire contract over the SAME protected envd process channel as handoff.
//! Kept here because the guest's root-only binary DTOs are deliberately private.
use super::{contracts::*, provider::LifecycleAdmission};
use cognia_e2b::envd::{DesktopBootstrap, ProcessEvent, ProcessInput, StartSpec};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, time::Duration};

pub const CHUNK_BYTES: usize = 64 * 1024;
pub const FILE_BYTES: usize = 8 * 1024 * 1024;
pub const TEXT_BYTES: usize = 1024 * 1024;
/// Durable, pre-dispatch reservations: at most 256 MiB of files, clipboard and
/// exec output per desktop lifetime, across connections AND Host restarts.
/// Reads reserve their requested maximum; exec/clipboard-get reserve 1 MiB.
/// Refusals, cancellation and short reads never refund a reservation, so an
/// ambiguous provider outcome cannot reset/bypass the bound. This is a transfer
/// budget, not a filesystem quota or a bound on files produced inside the guest.
/// Only a NEW immutable desktop ID starts a fresh budget. Generation changes,
/// lease/delegation renewal, configuration edits, reconnects and destruction
/// never reset an existing ID's spent reservations.
pub const DESKTOP_VOLUME_BYTES: u64 = 256 * 1024 * 1024;
const FRAME_BYTES: usize = 6 * TEXT_BYTES + 8192;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationAudit {
    pub observed_at: i64,
    pub desktop_id: Option<String>,
    pub operation: String,
    pub path_length: usize,
    pub input_bytes: usize,
    pub output_bytes: usize,
    pub reserved_bytes: u64,
    pub outcome: OperationOutcome,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationOutcome {
    Completed,
    Refused,
    Uncertain,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GuestOperation {
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
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GuestOperationResult {
    Exec {
        output: Vec<u8>,
        truncated: bool,
        timed_out: bool,
        exit_code: Option<i32>,
        signal: Option<i32>,
    },
    FileRead {
        chunk: Vec<u8>,
        eof: bool,
    },
    FileWrite {
        bytes: usize,
        r#final: bool,
    },
    ClipboardGet {
        text: String,
    },
    ClipboardSet {
        bytes: usize,
    },
}
impl GuestOperation {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Exec { .. } => "exec",
            Self::FileRead { .. } => "file-read",
            Self::FileWrite { .. } => "file-write",
            Self::ClipboardGet => "clipboard-get",
            Self::ClipboardSet { .. } => "clipboard-set",
        }
    }
    pub fn audit_fields(&self) -> serde_json::Value {
        let (path_length, input_bytes, argv_count) = match self {
            Self::Exec { argv, cwd, .. } => {
                (cwd.len(), argv.iter().map(String::len).sum(), argv.len())
            }
            Self::FileRead { path, .. } => (path.len(), 0, 0),
            Self::FileWrite { path, chunk, .. } => (path.len(), chunk.len(), 0),
            Self::ClipboardGet => (0, 0, 0),
            Self::ClipboardSet { text } => (0, text.len(), 0),
        };
        serde_json::json!({"operation":self.name(),"pathLength":path_length,"inputBytes":input_bytes,"argvCount":argv_count,"reservedBytes":self.reservation()})
    }
    pub fn reservation(&self) -> u64 {
        match self {
            Self::Exec { .. } | Self::ClipboardGet => TEXT_BYTES as u64,
            Self::FileRead { length, .. } => *length as u64,
            Self::FileWrite { chunk, .. } => chunk.len() as u64,
            Self::ClipboardSet { text } => text.len() as u64,
        }
    }
    pub fn validate(&self) -> Result<()> {
        let path_ok = |path: &str, directory: bool| {
            let relative = if path == "/home/cua" {
                ""
            } else {
                path.strip_prefix("/home/cua/").unwrap_or(path)
            };
            path.len() <= 4096
                && !path.contains('\0')
                && ((directory && matches!(relative, "" | "."))
                    || (!relative.is_empty()
                        && relative.split('/').all(|p| !matches!(p, "" | "." | ".."))))
        };
        let range_ok = |offset: u64, length: usize| {
            length <= CHUNK_BYTES
                && offset
                    .checked_add(length as u64)
                    .is_some_and(|end| end <= FILE_BYTES as u64)
        };
        let valid = match self {
            Self::Exec {
                argv,
                cwd,
                timeout_ms,
            } => {
                path_ok(cwd, true)
                    && !argv.is_empty()
                    && argv.len() <= 256
                    && !argv[0].is_empty()
                    && argv.iter().map(String::len).sum::<usize>() <= CHUNK_BYTES
                    && !argv.iter().any(|s| s.contains('\0'))
                    && (1..=60_000).contains(timeout_ms)
            }
            Self::FileRead {
                path,
                offset,
                length,
            } => path_ok(path, false) && *length > 0 && range_ok(*offset, *length),
            Self::FileWrite {
                path,
                offset,
                chunk,
                ..
            } => path_ok(path, false) && range_ok(*offset, chunk.len()),
            Self::ClipboardGet => true,
            Self::ClipboardSet { text } => text.len() <= TEXT_BYTES && !text.contains('\0'),
        };
        if valid {
            Ok(())
        } else {
            Err(refused("managed_desktop_operation_limit"))
        }
    }
    pub fn validate_result(&self, result: &GuestOperationResult) -> Result<()> {
        let valid = match (self, result) {
            (
                Self::Exec { .. },
                GuestOperationResult::Exec {
                    output,
                    exit_code,
                    signal,
                    ..
                },
            ) => {
                output.len() <= TEXT_BYTES
                    && (matches!((exit_code,signal),(Some(code),None) if (0..=255).contains(code))
                        || matches!((exit_code,signal),(None,Some(signal)) if (1..=64).contains(signal)))
            }
            (Self::FileRead { length, .. }, GuestOperationResult::FileRead { chunk, eof }) => {
                chunk.len() <= *length && (*eof || !chunk.is_empty())
            }
            (
                Self::FileWrite { chunk, r#final, .. },
                GuestOperationResult::FileWrite {
                    bytes,
                    r#final: done,
                },
            ) => *bytes == chunk.len() && done == r#final,
            (Self::ClipboardGet, GuestOperationResult::ClipboardGet { text }) => {
                text.len() <= TEXT_BYTES && !text.contains('\0')
            }
            (Self::ClipboardSet { text }, GuestOperationResult::ClipboardSet { bytes }) => {
                *bytes == text.len()
            }
            _ => false,
        };
        if valid {
            Ok(())
        } else {
            Err(refused("managed_desktop_operation_protocol"))
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ready {
    session_version: u32,
    admission: cognia_desktop_guest::observation::ProcessBoundaryReport,
}
fn validate_admission(
    ready: &Ready,
    desktop: &cognia_desktop_guest::observation::ProcessBoundaryReport,
) -> Result<()> {
    use cognia_desktop_guest::observation::ObservationPhase;
    let helper = &ready.admission;
    // The helper is a DIFFERENT process in the pinned workload boundary.
    // Validate its admission phase/FD gates, then compare boundary identity,
    // never its process pid/start-time or phase with the desktop process.
    if ready.session_version != 1
        || desktop.phase != ObservationPhase::DesktopLive
        || desktop.validate(1000).is_err()
        || helper.phase != ObservationPhase::AcceptanceAdmission
        || helper.validate(1000).is_err()
        || helper.boundary_generation != desktop.boundary_generation
        || helper.namespace_init_pid != desktop.namespace_init_pid
        || helper.namespace_init_start_time != desktop.namespace_init_start_time
        || helper.namespaces != desktop.namespaces
        || helper.provider_namespaces != desktop.provider_namespaces
    {
        return Err(refused("managed_desktop_boundary_mismatch"));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    result: Option<GuestOperationResult>,
    error: Option<String>,
    audit: serde_json::Value,
}
fn response(bytes: &[u8], request: &GuestOperation) -> Result<GuestOperationResult> {
    let value: Response =
        serde_json::from_slice(bytes).map_err(|_| refused("managed_desktop_operation_protocol"))?;
    // Audit is never copied from the guest into Host audit records.
    let _ = value.audit;
    match (value.result, value.error.as_deref()) {
        (Some(result), None) => {
            request.validate_result(&result)?;
            Ok(result)
        }
        (None, Some("operation_refused")) => Err(refused("managed_desktop_operation_refused")),
        (None, Some("operation_exec_unavailable")) => {
            Err(refused("managed_desktop_operation_exec_unavailable"))
        }
        _ => Err(refused("managed_desktop_operation_protocol")),
    }
}
fn wire_error() -> ManagedDesktopError {
    refused("managed_desktop_operation_transport")
}
async fn line(
    stream: &mut cognia_e2b::envd::ProcessStream,
    pending: &mut Vec<u8>,
) -> Result<Vec<u8>> {
    loop {
        if let Some(end) = pending.iter().position(|b| *b == b'\n') {
            return Ok(pending.drain(..=end).collect());
        }
        match stream.next_event().await.map_err(|_| wire_error())? {
            Some(ProcessEvent::Stdout(bytes)) if pending.len() + bytes.len() <= FRAME_BYTES => {
                pending.extend(bytes)
            }
            Some(ProcessEvent::Keepalive) => (),
            _ => return Err(wire_error()),
        }
    }
}
/// Start the pinned guest forwarder; it alone connects to the supervisor's
/// root socket. Never run caller commands as root or open a second transport.
pub(super) async fn execute(
    bootstrap: &DesktopBootstrap,
    boundary: &HostBoundaryBinding,
    request: &GuestOperation,
    admission: LifecycleAdmission,
) -> Result<GuestOperationResult> {
    request.validate()?;
    let work = async {
        admission()?;
        let spec = StartSpec {
            cmd: "/usr/local/bin/cognia-desktop-guest".into(),
            args: vec!["operations".into()],
            envs: BTreeMap::new(),
            cwd: Some("/".into()),
            stdin: true,
        };
        let mut stream = cognia_e2b::envd::start_protected(bootstrap, &spec)
            .await
            .map_err(|_| wire_error())?;
        let pid = match stream.next_event().await.map_err(|_| wire_error())? {
            Some(ProcessEvent::Start { pid }) if pid > 0 => pid,
            _ => return Err(wire_error()),
        };
        let input = ProcessInput::for_desktop(bootstrap, pid).map_err(|_| wire_error())?;
        let header = serde_json::json!({"sessionVersion":1,"boundaryGeneration":boundary.observation.boundary_generation});
        admission()?;
        input
            .send(format!("{header}\n").as_bytes())
            .await
            .map_err(|_| wire_error())?;
        let mut pending = Vec::new();
        let ready: Ready = serde_json::from_slice(&line(&mut stream, &mut pending).await?)
            .map_err(|_| wire_error())?;
        validate_admission(&ready, &boundary.observation)?;
        let mut bytes = serde_json::to_vec(request).map_err(|_| wire_error())?;
        bytes.push(b'\n');
        admission()?;
        input.send(&bytes).await.map_err(|_| wire_error())?;
        let answer = line(&mut stream, &mut pending).await?;
        input.close().await.map_err(|_| wire_error())?;
        // Exit confirms worker/descendant teardown. A content response alone
        // must never clear the durable uncertainty quarantine.
        if !pending.is_empty() {
            return Err(wire_error());
        }
        loop {
            match stream.next_event().await.map_err(|_| wire_error())? {
                Some(ProcessEvent::End(status)) if status.code() == Some(0) => break,
                Some(ProcessEvent::Keepalive) => (),
                _ => return Err(wire_error()),
            }
        }
        response(&answer, request)
    };
    tokio::time::timeout(Duration::from_secs(75), work)
        .await
        .map_err(|_| wire_error())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operation_admission_accepts_the_helper_and_refuses_changed_namespace_or_init() {
        use cognia_desktop_guest::observation::{
            DescriptorObservation, ObservationPhase, ProcessBoundaryReport, NAMESPACES,
        };
        let desktop = ProcessBoundaryReport {
            report_version:1,workload_isolation_revision:1,phase:ObservationPhase::DesktopLive,
            boundary_generation:"6a370d8e-2d69-40fb-9586-786b7424365a".into(),namespace_init_pid:20,namespace_init_start_time:1,
            workload_pid:21,workload_start_time:2,namespaces:NAMESPACES.into_iter().map(|n|(n.into(),format!("{n}:[2]"))).collect(),
            provider_namespaces:NAMESPACES.into_iter().map(|n|(n.into(),format!("{n}:[1]"))).collect(),
            status:"Uid:1000 1000 1000 1000\nGid:1000 1000 1000 1000\nGroups:\nCapInh:0\nCapPrm:0\nCapEff:0\nCapBnd:0\nCapAmb:0\nNoNewPrivs:1\nSeccomp:2\n".into(),
            network_devices:"header\nheader\n lo: 0\n".into(),ipv4_routes:"header\n".into(),ipv6_routes:String::new(),
            descriptors:(0..=2).map(|fd|(fd,DescriptorObservation {target:"/dev/null".into(),flags:0,socket_scope:None})).collect(),
        };
        let mut helper = desktop.clone();
        helper.phase = ObservationPhase::AcceptanceAdmission;
        helper.workload_pid = 30;
        helper.workload_start_time = 5;
        for fd in [3, 4] {
            helper.descriptors.insert(
                fd,
                DescriptorObservation {
                    target: format!("pipe:[{fd}]"),
                    flags: 0o2000000,
                    socket_scope: None,
                },
            );
        }
        let mut ready = Ready {
            session_version: 1,
            admission: helper,
        };
        assert!(validate_admission(&ready, &desktop).is_ok());
        ready.admission.namespace_init_start_time += 1;
        assert!(validate_admission(&ready, &desktop).is_err());
        ready.admission.namespace_init_start_time -= 1;
        ready
            .admission
            .namespaces
            .insert("net".into(), "net:[3]".into());
        assert!(validate_admission(&ready, &desktop).is_err());
        ready.admission = desktop.clone();
        assert!(validate_admission(&ready, &desktop).is_err());
    }
    #[test]
    fn limits_paths_and_content_free_audit() {
        for path in [
            "/etc/passwd",
            "../secret",
            "/home/cua/../secret",
            "/home/cua/a//b",
        ] {
            assert!(GuestOperation::FileRead {
                path: path.into(),
                offset: 0,
                length: 1
            }
            .validate()
            .is_err());
        }
        assert!(GuestOperation::FileWrite {
            path: "/home/cua/a".into(),
            offset: FILE_BYTES as u64,
            chunk: vec![1],
            r#final: true
        }
        .validate()
        .is_err());
        assert!(GuestOperation::ClipboardSet {
            text: "a".repeat(TEXT_BYTES + 1)
        }
        .validate()
        .is_err());
        let request = GuestOperation::FileWrite {
            path: "/home/cua/private-name".into(),
            offset: 0,
            chunk: b"secret-content".to_vec(),
            r#final: true,
        };
        let audit = request.audit_fields().to_string();
        assert!(!audit.contains("private-name") && !audit.contains("secret-content"));
        assert_eq!(request.audit_fields()["pathLength"], 22);
    }
    #[test]
    fn guest_containment_refusals_surface_without_leaking_guest_errors() {
        let request = GuestOperation::ClipboardGet;
        let reply = |error| {
            serde_json::to_vec(&serde_json::json!({"result":null,"error":error,"audit":{}}))
                .unwrap()
        };
        assert_eq!(
            response(&reply("operation_refused"), &request)
                .unwrap_err()
                .code,
            "managed_desktop_operation_refused"
        );
        assert_eq!(
            response(&reply("secret filename"), &request)
                .unwrap_err()
                .code,
            "managed_desktop_operation_protocol"
        );
        assert!(request
            .validate_result(&GuestOperationResult::ClipboardGet {
                text: "a".repeat(TEXT_BYTES + 1)
            })
            .is_err());
    }
    #[test]
    fn guest_output_caps_and_nonprogressing_read_are_protocol_errors() {
        let exec = GuestOperation::Exec {
            argv: vec!["id".into()],
            cwd: "/home/cua".into(),
            timeout_ms: 1000,
        };
        assert!(exec
            .validate_result(&GuestOperationResult::Exec {
                output: vec![0; TEXT_BYTES + 1],
                truncated: true,
                timed_out: false,
                exit_code: Some(0),
                signal: None
            })
            .is_err());
        assert!(exec
            .validate_result(&GuestOperationResult::Exec {
                output: vec![],
                truncated: false,
                timed_out: false,
                exit_code: None,
                signal: None
            })
            .is_err());
        let read = GuestOperation::FileRead {
            path: "/home/cua/a".into(),
            offset: 0,
            length: 2,
        };
        for result in [
            GuestOperationResult::FileRead {
                chunk: vec![],
                eof: false,
            },
            GuestOperationResult::FileRead {
                chunk: vec![1, 2, 3],
                eof: true,
            },
        ] {
            assert!(read.validate_result(&result).is_err());
        }
        assert!(read
            .validate_result(&GuestOperationResult::FileRead {
                chunk: vec![],
                eof: true
            })
            .is_ok());
    }
}
