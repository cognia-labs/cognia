use crate::{BeginTaskRun, RunState, ServiceConfig, TaskWorkspaceService};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_REQUEST_LINE_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_LINE_BYTES: usize = 16 * 1024 * 1024;
const MAX_OPEN_RUNS: usize = 64;

#[derive(Deserialize)]
struct WorkerRequest {
    id: String,
    #[serde(flatten)]
    command: WorkerCommand,
}

#[derive(Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "camelCase")]
enum WorkerCommand {
    Begin {
        input: Box<BeginTaskRun>,
        #[serde(default, rename = "repositoryRef")]
        repository_ref: Option<String>,
    },
    Settle {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(default, rename = "finalState")]
        final_state: Option<RunState>,
        #[serde(default, rename = "executorStopped")]
        executor_stopped: bool,
    },
    MarkExecutorUnconfirmed {
        #[serde(rename = "runId")]
        run_id: String,
    },
    AssertExecutionAllowed {
        #[serde(rename = "workspaceRoot")]
        workspace_root: PathBuf,
    },
    GetPatch {
        #[serde(rename = "runId")]
        run_id: String,
    },
    ReadDiff {
        #[serde(rename = "runId")]
        run_id: String,
        path: String,
        #[serde(default, rename = "allowSensitive")]
        allow_sensitive: bool,
    },
    ListTasks {
        #[serde(default, rename = "sessionId")]
        session_id: Option<String>,
    },
    ListRuns {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    Undo {
        #[serde(rename = "runId")]
        run_id: String,
    },
}

struct WorkerRuns<'a> {
    service: &'a TaskWorkspaceService,
    ids: HashSet<String>,
}

impl WorkerRuns<'_> {
    fn finish(&mut self) -> Result<(), String> {
        let mut failures = Vec::new();
        for run_id in std::mem::take(&mut self.ids) {
            if self.service.executor_stop_unconfirmed(&run_id)? { continue; }
            if let Err(error) = self.service.mark_executor_unconfirmed(&run_id) {
                failures.push(error);
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!("close worker runs: {}", failures.join("; ")))
        }
    }
}

impl Drop for WorkerRuns<'_> {
    fn drop(&mut self) {
        // Read/write failures must close the capture window just like EOF.
        if let Err(error) = self.finish() {
            eprintln!("{error}");
        }
    }
}

/// One local JSONL child process owns a service for its complete lifetime.
/// Opening another service for every operation would recover an active turn
/// between begin and settle. This uses the existing worker binary and store;
/// it does not open a network listener or introduce a second Host service.
pub fn run_worker_server(
    args: &[String],
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> Result<(), String> {
    let data_dir = required_flag(args, "data-dir")?;
    let service = TaskWorkspaceService::open(ServiceConfig::new(PathBuf::from(data_dir)))?;
    let mut owned = WorkerRuns {
        service: &service,
        ids: HashSet::new(),
    };
    loop {
        let mut line = Vec::new();
        let read = input
            .by_ref()
            .take((MAX_REQUEST_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|error| format!("read worker request: {error}"))?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_REQUEST_LINE_BYTES {
            if !line.ends_with(b"\n") {
                discard_request_tail(input)?;
            }
            write_worker_response(
                output,
                Value::Null,
                Err(("request_too_large", "request line exceeds 256 KiB".into())),
            )?;
            continue;
        }
        let id = serde_json::from_slice::<Value>(&line)
            .ok()
            .and_then(|value| value.get("id").cloned())
            .filter(|value| value.is_string())
            .unwrap_or(Value::Null);
        let request = serde_json::from_slice::<WorkerRequest>(&line);
        let result = match request {
            Ok(request)
                if !request.id.is_empty()
                    && request.id.len() <= 128
                    && !request.id.chars().any(char::is_control) =>
            {
                let is_begin = matches!(&request.command, WorkerCommand::Begin { .. } | WorkerCommand::AssertExecutionAllowed { .. });
                dispatch_worker_request(&service, request.command, &mut owned.ids)
                    .map_err(|error| {
                        let code = if is_begin && is_capture_refusal(&error) { "capture_refused" } else { "request_failed" };
                        (code, error)
                    })
            }
            Ok(_) => Err((
                "invalid_request",
                "request id must be 1-128 bytes without control characters".into(),
            )),
            Err(error) => Err((
                "invalid_request",
                format!("invalid worker request: {error}"),
            )),
        };
        write_worker_response(output, id, result)?;
    }
    // EOF is not evidence the executor stopped. Quarantine unfinished captures;
    // their initial baseline also makes process-death recovery fail closed.
    owned.finish()
}

fn dispatch_worker_request(
    service: &TaskWorkspaceService,
    command: WorkerCommand,
    owned: &mut HashSet<String>,
) -> Result<Value, String> {
    let value = match command {
        WorkerCommand::Begin {
            input,
            repository_ref,
        } => {
            let input = *input;
            if owned.len() >= MAX_OPEN_RUNS && !owned.contains(&input.run_id) {
                return Err("worker already owns 64 unfinished runs".into());
            }
            let run = service.begin_worker_run(input, repository_ref.as_deref())?;
            if matches!(run.state, RunState::Running | RunState::Settling) && !service.owns_run_capture(&run.run_id) {
                return Err("task run capture still has another live owner".into());
            }
            if matches!(run.state, RunState::Running | RunState::Settling) && service.owns_run_capture(&run.run_id) {
                owned.insert(run.run_id.clone());
            }
            serde_json::to_value(run)
        }
        WorkerCommand::Settle {
            run_id,
            final_state,
            executor_stopped,
        } => {
            let resources = if executor_stopped && service.executor_stop_unconfirmed(&run_id)? {
                service.confirm_executor_stopped(&run_id)?;
                Vec::new()
            } else { match final_state.unwrap_or(RunState::Ready) {
                RunState::Ready => service.settle_run(&run_id)?,
                RunState::Failed => service.settle_failed_run(&run_id)?,
                RunState::Cancelled => service.settle_cancelled_run(&run_id)?,
                _ => return Err("settle requires ready, failed or cancelled finalState".into()),
            } };
            owned.remove(&run_id);
            serde_json::to_value(resources)
        }
        WorkerCommand::MarkExecutorUnconfirmed { run_id } => {
            serde_json::to_value(service.mark_executor_unconfirmed(&run_id)?)
        }
        WorkerCommand::AssertExecutionAllowed { workspace_root } => {
            service.assert_execution_allowed(&workspace_root)?;
            serde_json::to_value(())
        }
        WorkerCommand::GetPatch { run_id } => serde_json::to_value(service.get_patch_set(&run_id)?),
        WorkerCommand::ReadDiff {
            run_id,
            path,
            allow_sensitive,
        } => serde_json::to_value(service.read_patch_diff(&run_id, &path, allow_sensitive)?),
        WorkerCommand::ListTasks { session_id } => {
            serde_json::to_value(service.list_tasks(session_id.as_deref())?)
        }
        WorkerCommand::ListRuns { task_id } => serde_json::to_value(service.list_runs(&task_id)?),
        WorkerCommand::Undo { run_id } => serde_json::to_value(service.undo_patch_set(&run_id)?),
    };
    value.map_err(|error| format!("serialize worker workspace result: {error}"))
}

fn is_capture_refusal(message: &str) -> bool {
    [
        "local workspace observation is already active",
        "runId is already owned by another task run:",
        "pipeline workspace is already active:",
        "task run capture still has a live owner",
        "task run capture still has another live owner",
        "snapshot_busy:",
        "workspace lease changed during run acquisition",
        "workspace source binding changed and must be rebound",
        "workspace source is a Registry-owned execution root:",
        "one task cannot span multiple workspace roots",
        "run already has an execution root:",
    ]
    .iter()
    .any(|prefix| message.starts_with(prefix))
}
fn write_worker_response(
    output: &mut impl Write,
    id: Value,
    result: Result<Value, (&str, String)>,
) -> Result<(), String> {
    let response = match result {
        Ok(value) => serde_json::json!({"id":id,"result":value}),
        Err((code, message)) => {
            serde_json::json!({"id":id,"error":{"code":code,"message":message}})
        }
    };
    let mut encoded = serde_json::to_vec(&response)
        .map_err(|error| format!("serialize worker response: {error}"))?;
    if encoded.len() > MAX_RESPONSE_LINE_BYTES {
        encoded = serde_json::to_vec(&serde_json::json!({"id":id,"error":{
            "code":"response_too_large", "message":"request completed but its response exceeds 16 MiB; no response was truncated"
        }})).map_err(|error| format!("serialize worker error: {error}"))?;
    }
    output
        .write_all(&encoded)
        .and_then(|_| output.write_all(b"\n"))
        .and_then(|_| output.flush())
        .map_err(|error| format!("write worker response: {error}"))
}

fn discard_request_tail(input: &mut impl BufRead) -> Result<(), String> {
    loop {
        let buffer = input
            .fill_buf()
            .map_err(|error| format!("read oversized request tail: {error}"))?;
        if buffer.is_empty() {
            return Ok(());
        }
        let end = buffer.iter().position(|byte| *byte == b'\n');
        let consumed = end.map_or(buffer.len(), |index| index + 1);
        input.consume(consumed);
        if end.is_some() {
            return Ok(());
        }
    }
}

pub fn run_worker_cli(args: &[String], input: &str, output: &mut impl Write) -> Result<(), String> {
    let command = args
        .first()
        .map(String::as_str)
        .ok_or_else(|| "missing worker workspace command".to_string())?;
    let data_dir = required_flag(args, "data-dir")?;
    let service = TaskWorkspaceService::open(ServiceConfig::new(PathBuf::from(data_dir)))?;
    let value = match command {
        "bind" => {
            let binding_ref = required_flag(args, "repository-ref")?;
            let source_root = required_flag(args, "path")?;
            serde_json::to_value(service.bind_workspace_source(
                binding_ref,
                Path::new(source_root),
                now_ms(),
            )?)
            .map_err(|error| format!("serialize worker workspace result: {error}"))?
        }
        "list" => serde_json::to_value(service.list_workspace_source_bindings()?)
            .map_err(|error| format!("serialize worker workspace result: {error}"))?,
        "remove" => {
            let binding_ref = required_flag(args, "repository-ref")?;
            serde_json::json!({
                "removed": service.remove_workspace_source_binding(binding_ref)?
            })
        }
        "resolve" => {
            let binding_ref = required_flag(args, "repository-ref")?;
            serde_json::to_value(service.resolve_workspace_source(binding_ref)?)
                .map_err(|error| format!("serialize worker workspace result: {error}"))?
        }
        "begin" => {
            let binding_ref = required_flag(args, "repository-ref")?;
            let request: BeginTaskRun = serde_json::from_str(input)
                .map_err(|error| format!("parse begin request: {error}"))?;
            serde_json::to_value(service.begin_bound_run(binding_ref, request)?)
                .map_err(|error| format!("serialize worker workspace result: {error}"))?
        }
        "settle" => {
            let run_id = required_flag(args, "run-id")?;
            if !args.iter().any(|arg| arg == "--executor-stopped") {
                return Err("worker settle requires --executor-stopped after confirming the executor has stopped".into());
            }
            serde_json::to_value(service.confirm_executor_stopped(run_id)?)
                .map_err(|error| format!("serialize worker workspace result: {error}"))?
        }
        _ => return Err(format!("unknown worker workspace command: {command}")),
    };
    writeln!(output, "{value}").map_err(|error| format!("write result: {error}"))
}

fn required_flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, String> {
    let flag = format!("--{name}");
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing {flag}"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn observed_request(workspace: &Path) -> Value {
        serde_json::json!({
            "taskId":"cli-task", "sessionId":"cli-session", "runId":"cli-run",
            "parentRunId":null,"agentId":"cli-agent","agentKind":"cli",
            "workspaceRoot":workspace.to_string_lossy(),"observeInPlace":true
        })
    }

    struct ObservedOutput {
        bytes: Vec<u8>,
        root: PathBuf,
        changed: bool,
        fail: bool,
    }

    impl Write for ObservedOutput {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes.extend_from_slice(bytes);
            if !self.changed && (self.bytes.contains(&b'\n') || self.fail) {
                std::fs::write(self.root.join("story.txt"), b"after local CLI turn\n")?;
                self.changed = true;
            }
            if self.fail {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "closed CLI consumer",
                ));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn serve_keeps_one_service_for_begin_settle_diff_and_undo() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        std::fs::write(workspace.path().join("story.txt"), b"before CLI turn\n").unwrap();
        let requests = [
            serde_json::json!({"id":"begin","method":"begin","params":{"input":observed_request(workspace.path())}}),
            serde_json::json!({"id":"settle","method":"settle","params":{"runId":"cli-run","finalState":"ready"}}),
            serde_json::json!({"id":"patch","method":"getPatch","params":{"runId":"cli-run"}}),
            serde_json::json!({"id":"diff","method":"readDiff","params":{"runId":"cli-run","path":"story.txt"}}),
            serde_json::json!({"id":"tasks","method":"listTasks","params":{"sessionId":"cli-session"}}),
            serde_json::json!({"id":"runs","method":"listRuns","params":{"taskId":"cli-task"}}),
            serde_json::json!({"id":"undo","method":"undo","params":{"runId":"cli-run"}}),
        ];
        let source = requests
            .iter()
            .map(|request| format!("{request}\n"))
            .collect::<String>();
        let mut output = ObservedOutput {
            bytes: Vec::new(),
            root: workspace.path().into(),
            changed: false,
            fail: false,
        };
        run_worker_server(
            &args("serve", data.path(), &[]),
            &mut std::io::Cursor::new(source),
            &mut output,
        )
        .unwrap();
        let responses = String::from_utf8(output.bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            responses
                .iter()
                .map(|value| value["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["begin", "settle", "patch", "diff", "tasks", "runs", "undo"]
        );
        assert!(
            responses.iter().all(|value| value.get("error").is_none()),
            "{responses:?}"
        );
        assert_eq!(responses[0]["result"]["state"], "running");
        assert_eq!(responses[0]["result"]["isolationKind"], "observed");
        assert_eq!(responses[2]["result"]["state"], "applied");
        assert!(responses[3]["result"]
            .as_str()
            .unwrap()
            .contains("+after local CLI turn"));
        assert_eq!(responses[4]["result"].as_array().unwrap().len(), 1);
        assert_eq!(responses[5]["result"][0]["state"], "ready");
        assert_eq!(responses[6]["result"]["state"], "reverted");
        assert_eq!(
            std::fs::read(workspace.path().join("story.txt")).unwrap(),
            b"before CLI turn\n"
        );
    }

    #[test]
    fn serve_quarantines_unfinished_local_runs_on_eof_and_broken_output() {
        for fail in [false, true] {
            let data = TempDir::new().unwrap();
            let workspace = TempDir::new().unwrap();
            std::fs::write(workspace.path().join("story.txt"), b"before CLI turn\n").unwrap();
            let source = format!(
                "{}\n",
                serde_json::json!({"id":"begin","method":"begin","params":{"input":observed_request(workspace.path())}})
            );
            let mut output = ObservedOutput {
                bytes: Vec::new(),
                root: workspace.path().into(),
                changed: false,
                fail,
            };
            let result = run_worker_server(
                &args("serve", data.path(), &[]),
                &mut std::io::Cursor::new(source),
                &mut output,
            );
            assert_eq!(result.is_err(), fail);
            let service =
                TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
            assert_eq!(
                service.list_runs("cli-task").unwrap()[0].state,
                RunState::Settling
            );
            assert!(service.list_runs("cli-task").unwrap()[0].executor_stop_unconfirmed);
            assert!(service.get_patch_set("cli-run").unwrap().is_none());
            assert!(service.read_patch_diff("cli-run", "story.txt", false).is_err());
            assert!(service.settle_cancelled_run("cli-run").is_err());
            service.confirm_executor_stopped("cli-run").unwrap();
            assert!(service.get_patch_set("cli-run").unwrap().is_none());
        }
    }

    #[test]
    fn turn_diff_review_duplicate_begin_eof_does_not_take_capture_ownership() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        std::fs::write(workspace.path().join("story.txt"), "before\n").unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        let request: BeginTaskRun =
            serde_json::from_value(observed_request(workspace.path())).unwrap();
        service.begin_run(request).unwrap();
        let source = format!(
            "{}\n",
            serde_json::json!({"id":"duplicate","method":"begin","params":{"input":observed_request(workspace.path())}})
        );
        let mut output = Vec::new();
        run_worker_server(
            &args("serve", data.path(), &[]),
            &mut std::io::Cursor::new(source),
            &mut output,
        )
        .unwrap();
        assert_eq!(
            service.list_runs("cli-task").unwrap()[0].state,
            RunState::Running
        );
        let refused: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(refused["error"]["code"], "capture_refused");
        assert!(service.get_patch_set("cli-run").unwrap().is_none());
        std::fs::write(workspace.path().join("story.txt"), "original owner tail\n").unwrap();
        service.settle_run("cli-run").unwrap();
        assert!(service
            .read_patch_diff("cli-run", "story.txt", false)
            .unwrap()
            .contains("+original owner tail"));
    }

    #[test]
    fn execution_admission_checks_existing_fences_without_creating_capture_history() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let check = serde_json::json!({"id":"check","method":"assertExecutionAllowed","params":{"workspaceRoot":workspace.path()}});
        let mut output = Vec::new();
        run_worker_server(
            &args("serve", data.path(), &[]),
            &mut std::io::Cursor::new(format!("{check}\n")),
            &mut output,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&output).unwrap()["result"],
            Value::Null
        );
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        assert!(service.list_tasks(None).unwrap().is_empty());
        let request: BeginTaskRun =
            serde_json::from_value(observed_request(workspace.path())).unwrap();
        service.begin_worker_run(request, None).unwrap();
        for quarantined in [false, true] {
            if quarantined {
                service.mark_executor_unconfirmed("cli-run").unwrap();
            }
            let mut output = Vec::new();
            run_worker_server(
                &args("serve", data.path(), &[]),
                &mut std::io::Cursor::new(format!("{check}\n")),
                &mut output,
            )
            .unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&output).unwrap()["error"]["code"],
                "capture_refused"
            );
        }
        assert_eq!(service.list_runs("cli-task").unwrap().len(), 1);
        assert!(service.get_patch_set("cli-run").unwrap().is_none());
    }

    #[test]
    fn capture_refusal_classification_does_not_hide_missing_helper_or_io_errors() {
        assert!(is_capture_refusal(
            "local workspace observation is already active for an overlapping root"
        ));
        assert!(is_capture_refusal(
            "task run capture still has another live owner"
        ));
        assert!(is_capture_refusal(
            "runId is already owned by another task run: run"
        ));
        assert!(!is_capture_refusal(
            "open workspace database: database is locked"
        ));
        assert!(!is_capture_refusal(
            "canonicalize workspace /missing: No such file or directory"
        ));
    }

    #[test]
    fn turn_diff_review_uncertain_executor_survives_eof_and_requires_explicit_stop() {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        std::fs::write(workspace.path().join("story.txt"), "before\n").unwrap();
        let source = [
            serde_json::json!({"id":"begin","method":"begin","params":{"input":observed_request(workspace.path())}}),
            serde_json::json!({"id":"uncertain","method":"markExecutorUnconfirmed","params":{"runId":"cli-run"}}),
        ].iter().map(|request| format!("{request}\n")).collect::<String>();
        let mut output = ObservedOutput {
            bytes: Vec::new(),
            root: workspace.path().into(),
            changed: false,
            fail: false,
        };
        run_worker_server(
            &args("serve", data.path(), &[]),
            &mut std::io::Cursor::new(source),
            &mut output,
        )
        .unwrap();
        let responses = String::from_utf8(output.bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert!(responses[1].get("error").is_none(), "{responses:?}");
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        assert_eq!(
            service.list_runs("cli-task").unwrap()[0].state,
            RunState::Settling
        );
        assert!(service.get_patch_set("cli-run").unwrap().is_none());
        assert!(service
            .settle_failed_run("cli-run")
            .unwrap_err()
            .contains("executor"));
        assert!(service
            .read_patch_diff("cli-run", "story.txt", false)
            .is_err());
        assert!(service.undo_patch_set("cli-run").is_err());
        let mut next: BeginTaskRun =
            serde_json::from_value(observed_request(workspace.path())).unwrap();
        next.run_id = "next-run".into();
        assert!(service.begin_run(next.clone()).is_err());
        drop(service);
        let mut recovered = Vec::new();
        run_worker_cli(
            &args(
                "settle",
                data.path(),
                &["--run-id", "cli-run", "--executor-stopped"],
            ),
            "",
            &mut recovered,
        )
        .unwrap();
        let service = TaskWorkspaceService::open(ServiceConfig::new(data.path().into())).unwrap();
        assert_eq!(
            service.list_runs("cli-task").unwrap()[0].state,
            RunState::Failed
        );
        assert!(service.get_patch_set("cli-run").unwrap().is_none());
        service.begin_run(next).unwrap();
        service.settle_run("next-run").unwrap();
    }
    #[test]
    fn serve_bounds_lines_and_recovers_after_invalid_requests() {
        let data = TempDir::new().unwrap();
        let mut source = vec![b'x'; MAX_REQUEST_LINE_BYTES + 20];
        source.extend_from_slice(b"\n{bad json}\n");
        source.extend_from_slice(b"{\"id\":\"next\",\"method\":\"listTasks\",\"params\":{}}\n");
        let mut output = Vec::new();
        run_worker_server(
            &args("serve", data.path(), &[]),
            &mut std::io::Cursor::new(source),
            &mut output,
        )
        .unwrap();
        let responses = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(responses.len(), 3);
        assert_eq!(responses[0]["error"]["code"], "request_too_large");
        assert_eq!(responses[1]["error"]["code"], "invalid_request");
        assert_eq!(responses[2], serde_json::json!({"id":"next","result":[]}));
        let mut oversized = Vec::new();
        write_worker_response(
            &mut oversized,
            Value::String("large".into()),
            Ok(Value::String("a".repeat(MAX_RESPONSE_LINE_BYTES))),
        )
        .unwrap();
        let response: Value = serde_json::from_slice(&oversized).unwrap();
        assert_eq!(response["id"], "large");
        assert_eq!(response["error"]["code"], "response_too_large");
    }

    fn args(command: &str, data: &Path, extra: &[&str]) -> Vec<String> {
        let mut values = vec![
            command.to_string(),
            "--data-dir".to_string(),
            data.to_string_lossy().into_owned(),
        ];
        values.extend(extra.iter().map(|value| value.to_string()));
        values
    }

    #[test]
    fn bind_list_resolve_and_remove_share_the_task_workspace_store() {
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        let repository_path = repository.path().to_string_lossy().into_owned();
        let binding_ref = "repository:project-1:repo-1";

        let mut bind_output = Vec::new();
        run_worker_cli(
            &args(
                "bind",
                data.path(),
                &["--repository-ref", binding_ref, "--path", &repository_path],
            ),
            "",
            &mut bind_output,
        )
        .unwrap();
        let binding: crate::WorkspaceSourceBinding = serde_json::from_slice(&bind_output).unwrap();
        assert_eq!(binding.binding_ref, binding_ref);

        let mut list_output = Vec::new();
        run_worker_cli(&args("list", data.path(), &[]), "", &mut list_output).unwrap();
        let listed: Vec<crate::WorkspaceSourceBinding> =
            serde_json::from_slice(&list_output).unwrap();
        assert_eq!(listed, vec![binding.clone()]);

        let mut resolve_output = Vec::new();
        run_worker_cli(
            &args("resolve", data.path(), &["--repository-ref", binding_ref]),
            "",
            &mut resolve_output,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<crate::WorkspaceSourceBinding>(&resolve_output).unwrap(),
            binding
        );

        let mut remove_output = Vec::new();
        run_worker_cli(
            &args("remove", data.path(), &["--repository-ref", binding_ref]),
            "",
            &mut remove_output,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&remove_output).unwrap(),
            serde_json::json!({ "removed": true })
        );
    }
}
