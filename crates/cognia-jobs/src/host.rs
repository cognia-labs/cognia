//! Background-job supervisor wiring.
//!
//! Owns the process-wide [`JobSupervisor`] and the `host_rpc` dispatcher the
//! sidecar calls into.
//!
//! Storage is a process-global slot rather than Tauri managed state, matching
//! the headless service lifetime: the headless `cognia-server` binary has no
//! `app.state::<T>()` to read from, and background jobs must work there. Both
//! entry points call [`install`] at boot; everything else reads [`supervisor`].

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use crate::{
    JobDelivery, JobOwner, JobStore, JobSupervisor, MonitorCondition, MonitorDelivery,
    MonitorRegistry, SpawnJobRequest,
};
use serde_json::{json, Value};

static SUPERVISOR: OnceLock<Arc<JobSupervisor>> = OnceLock::new();
static MONITORS: OnceLock<Arc<MonitorRegistry>> = OnceLock::new();

/// Create the supervisor rooted at `data_dir` (`<app_data>/cognia`) and install
/// it process-wide. Idempotent: a second call returns the existing instance.
///
/// Runs boot reconcile as part of installation — rows left `running` by a
/// previous lifetime become `interrupted` BEFORE any spawn, so the concurrency
/// caps never count ghosts.
pub fn install(data_dir: PathBuf) -> Result<Arc<JobSupervisor>, String> {
    if let Some(existing) = SUPERVISOR.get() {
        return Ok(Arc::clone(existing));
    }
    let store_handle =
        Arc::new(JobStore::new(data_dir.join("jobs.sqlite")).map_err(|e| e.to_string())?);
    let supervisor = Arc::new(JobSupervisor::new(
        Arc::clone(&store_handle),
        data_dir.join("jobs"),
    ));
    match supervisor.reconcile_on_boot() {
        Ok(ids) if !ids.is_empty() => {
            log::info!(
                "jobs: {} job(s) from a previous run marked interrupted on boot",
                ids.len()
            );
        }
        Ok(_) => {}
        Err(e) => log::warn!("jobs: boot reconcile failed: {e}"),
    }
    // A racing installer wins harmlessly — both built an equivalent supervisor.
    let _ = SUPERVISOR.set(Arc::clone(&supervisor));
    let installed = Arc::clone(SUPERVISOR.get().unwrap_or(&supervisor));

    // Monitors share the supervisor's store, so a watch is visible to exactly
    // the same readers as the jobs it watches.
    let monitors = Arc::new(MonitorRegistry::new(
        Arc::clone(&store_handle),
        Arc::clone(&installed),
    ));
    match monitors.reconcile_on_boot() {
        Ok(ids) if !ids.is_empty() => {
            log::info!("jobs: resumed {} durable monitor(s) on boot", ids.len());
        }
        Ok(_) => {}
        Err(e) => log::warn!("jobs: monitor boot reconcile failed: {e}"),
    }
    let _ = MONITORS.set(monitors);

    Ok(installed)
}

/// The installed supervisor, or `None` before boot has run.
pub fn supervisor() -> Option<Arc<JobSupervisor>> {
    SUPERVISOR.get().cloned()
}

/// The installed monitor registry, or `None` before boot has run.
pub fn monitors() -> Option<Arc<MonitorRegistry>> {
    MONITORS.get().cloned()
}

fn require_monitors() -> Result<Arc<MonitorRegistry>, String> {
    monitors().ok_or_else(|| "monitors are not available on this host".to_string())
}

fn require_supervisor() -> Result<Arc<JobSupervisor>, String> {
    supervisor().ok_or_else(|| "background jobs are not available on this host".to_string())
}

/// Parse the `owner` field shared by most methods.
fn owner_from(params: &Value) -> Result<JobOwner, String> {
    serde_json::from_value(params.get("owner").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("invalid owner: {e}"))
}

fn str_field(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing required field `{key}`"))
}

fn u64_field(params: &Value, key: &str, default: u64) -> u64 {
    params.get(key).and_then(|v| v.as_u64()).unwrap_or(default)
}

/// An optional, typed field: absent or null is `None`, a malformed value an
/// error naming the field (never a silent default).
fn optional_field<T: serde::de::DeserializeOwned>(
    params: &Value,
    key: &str,
) -> Result<Option<T>, String> {
    params
        .get(key)
        .filter(|value| !value.is_null())
        .map(|value| serde_json::from_value::<T>(value.clone()))
        .transpose()
        .map_err(|error| format!("invalid {key}: {error}"))
}

/// Dispatch one `host_rpc` frame. Returns the value to put in `result`.
///
/// Every arm is answered here in Rust — nothing is forwarded to the renderer,
/// which is what lets the same call succeed headless and under remote driving.
pub async fn dispatch_host_rpc(method: &str, params: &Value) -> Result<Value, String> {
    let sup = require_supervisor()?;
    dispatch_with_supervisor(&sup, method, params).await
}

async fn dispatch_with_supervisor(
    sup: &JobSupervisor,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    match method {
        "jobs.spawn" => {
            let origin = params
                .get("origin")
                .filter(|value| !value.is_null())
                .map(|value| serde_json::from_value::<crate::types::JobOrigin>(value.clone()))
                .transpose()
                .map_err(|error| format!("invalid job origin: {error}"))?;
            let delivery = optional_field::<JobDelivery>(params, "delivery")?;
            let req: SpawnJobRequest = serde_json::from_value(params.clone())
                .map_err(|e| format!("invalid spawn request: {e}"))?;
            let rec = sup
                .spawn_attributed(req, origin, delivery)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(rec).map_err(|e| e.to_string())
        }
        "jobs.read" => {
            let id = str_field(params, "jobId")?;
            let from = u64_field(params, "fromOffset", 0);
            let max = u64_field(params, "maxBytes", 30_000) as usize;
            let slice = sup.read(&id, from, max).map_err(|e| e.to_string())?;
            serde_json::to_value(slice).map_err(|e| e.to_string())
        }
        "jobs.wait" => {
            let id = str_field(params, "jobId")?;
            let from = u64_field(params, "fromOffset", 0);
            let max = u64_field(params, "maxBytes", 30_000) as usize;
            // Bounded host-side so a caller cannot pin a worker indefinitely;
            // the sidecar's own schema already caps this at 30s.
            let wait_ms = u64_field(params, "waitMs", 0).min(30_000);
            let slice = sup
                .wait_for_output(&id, from, max, Duration::from_millis(wait_ms))
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(slice).map_err(|e| e.to_string())
        }
        "jobs.kill" => {
            let id = str_field(params, "jobId")?;
            // `requester` present ⇒ scoped permission check. The sidecar always
            // sends it, so an agent can never reach another session's job.
            let requester = match params.get("requester") {
                Some(Value::Null) | None => None,
                Some(v) => Some(
                    serde_json::from_value::<JobOwner>(v.clone())
                        .map_err(|e| format!("invalid requester: {e}"))?,
                ),
            };
            let rec = sup
                .kill(&id, requester.as_ref())
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(rec).map_err(|e| e.to_string())
        }
        "jobs.killByPid" => {
            let pid = params
                .get("pid")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| "missing required field `pid`".to_string())?
                as u32;
            let requester = match params.get("requester") {
                Some(Value::Null) | None => None,
                Some(v) => Some(
                    serde_json::from_value::<JobOwner>(v.clone())
                        .map_err(|e| format!("invalid requester: {e}"))?,
                ),
            };
            // `matched: false` is a normal answer, not an error — it tells the
            // caller the pid is not a job so it may fall back to a raw signal.
            match sup
                .kill_by_pid(pid, requester.as_ref())
                .await
                .map_err(|e| e.to_string())?
            {
                Some(rec) => Ok(json!({ "matched": true, "job": rec })),
                None => Ok(json!({ "matched": false })),
            }
        }
        "jobs.list" => {
            let owner = match params.get("owner") {
                Some(Value::Null) | None => None,
                Some(_) => Some(owner_from(params)?),
            };
            let rows = match (&owner, params.get("includeOrigin").and_then(Value::as_bool)) {
                (Some(JobOwner::Session { session_id }), Some(true)) => {
                    sup.list_by_origin_session(session_id)
                }
                _ => sup.list(owner.as_ref()),
            }
            .map_err(|e| e.to_string())?;
            // Keep JobRecord's Rust/source shape compatible. Liveness is an
            // optional wire field, separate from the leader's terminal status.
            let jobs = rows
                .into_iter()
                .map(|row| {
                    let running = sup.process_group_running(&row.id);
                    let mut value = serde_json::to_value(row).map_err(|error| error.to_string())?;
                    if let Some(running) = running {
                        value["processGroupRunning"] = json!(running);
                    }
                    Ok::<_, String>(value)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut response = json!({ "jobs": jobs });
            if let (Some(JobOwner::Session { session_id }), Some(true)) =
                (&owner, params.get("includeOrigin").and_then(Value::as_bool))
            {
                response["originSessionId"] = json!(session_id);
            }
            Ok(response)
        }
        // Ended agent-started jobs and settled agent-registered monitors, for
        // a consumer settling what its events missed (ADR-0249 §7).
        "jobs.settlements" => {
            let session_id = params.get("sessionId").and_then(Value::as_str);
            let since_ms = params.get("sinceMs").and_then(Value::as_i64);
            let jobs = sup
                .settlements(session_id, since_ms)
                .map_err(|e| e.to_string())?;
            let monitors = match monitors() {
                Some(reg) => reg
                    .settlements(session_id, since_ms)
                    .map_err(|e| e.to_string())?,
                None => Vec::new(),
            };
            Ok(json!({ "jobs": jobs, "monitors": monitors }))
        }
        // Several consumers may hear one end (a window and a Host brain);
        // the first to claim it is the one that delivers (ADR-0249 §7).
        "jobs.claimDelivery" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or("missing id")?;
            let consumer = params
                .get("consumer")
                .and_then(Value::as_str)
                .filter(|consumer| !consumer.trim().is_empty())
                .ok_or("missing consumer")?;
            let claimed = match params.get("kind").and_then(Value::as_str) {
                Some("job") => sup.claim_delivery(id, consumer),
                Some("monitor") => require_monitors()?.claim_delivery(id, consumer),
                _ => return Err("kind must be \"job\" or \"monitor\"".into()),
            }
            .map_err(|e| e.to_string())?;
            Ok(json!({ "claimed": claimed }))
        }
        "jobs.killOwnedBy" => {
            let owner = owner_from(params)?;
            let ids = match (&owner, params.get("includeOrigin").and_then(Value::as_bool)) {
                (JobOwner::Session { session_id }, Some(true)) => {
                    sup.kill_origin_session(session_id).await
                }
                _ => sup.kill_owned_by(&owner).await,
            }
            .map_err(|e| e.to_string())?;
            Ok(json!({ "killed": ids }))
        }
        // --- monitors ------------------------------------------------------
        // Registration and waiting are SEPARATE calls on purpose: that is what
        // lets the sidecar block for a while and then stop blocking without
        // losing the watch, which is the whole blocking→async degradation.
        "monitors.register" => {
            let reg = require_monitors()?;
            let condition: MonitorCondition =
                serde_json::from_value(params.get("condition").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("invalid condition: {e}"))?;
            let owner = owner_from(params)?;
            let expires_at_ms = params.get("expiresAtMs").and_then(|v| v.as_i64());
            let label = params
                .get("label")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let delivery = optional_field::<MonitorDelivery>(params, "delivery")?;
            // The conversation it reports into, not its owner (a tool
            // session's executor id).
            if delivery
                .as_ref()
                .is_some_and(|delivery| delivery.session_id.trim().is_empty())
            {
                return Err("a monitor's delivery must name the session it reports into".into());
            }
            let rec = reg
                .register_delivered(condition, owner, expires_at_ms, label, delivery)
                .map_err(|e| e.to_string())?;
            serde_json::to_value(rec).map_err(|e| e.to_string())
        }
        "monitors.wait" => {
            let reg = require_monitors()?;
            let id = str_field(params, "monitorId")?;
            // Bounded host-side so one caller cannot pin a worker forever.
            let wait_ms = u64_field(params, "waitMs", 0).min(60_000);
            // `inline`: the agent's own blocking `Monitor` call. What it
            // returns settled is its result, never delivered a second time.
            let wait = Duration::from_millis(wait_ms);
            let rec = if params.get("inline").and_then(Value::as_bool) == Some(true) {
                reg.wait_inline(&id, wait).await
            } else {
                reg.wait(&id, wait).await
            }
            .map_err(|e| e.to_string())?;
            serde_json::to_value(rec).map_err(|e| e.to_string())
        }
        "monitors.cancel" => {
            let reg = require_monitors()?;
            let id = str_field(params, "monitorId")?;
            let requester = match params.get("requester") {
                Some(Value::Null) | None => None,
                Some(v) => Some(
                    serde_json::from_value::<JobOwner>(v.clone())
                        .map_err(|e| format!("invalid requester: {e}"))?,
                ),
            };
            let rec = reg
                .cancel(&id, requester.as_ref())
                .map_err(|e| e.to_string())?;
            serde_json::to_value(rec).map_err(|e| e.to_string())
        }
        "monitors.list" => {
            let reg = require_monitors()?;
            let owner = match params.get("owner") {
                Some(Value::Null) | None => None,
                Some(_) => Some(owner_from(params)?),
            };
            let rows = reg.list(owner.as_ref()).map_err(|e| e.to_string())?;
            Ok(json!({ "monitors": rows }))
        }
        // Called by the renderer/scheduler when a background subagent settles
        // or a scheduled task's run finishes — the linkage that lets an agent
        // wait on work it did not start.
        "monitors.signalUpstream" => {
            let reg = require_monitors()?;
            let source = str_field(params, "source")?;
            let id = str_field(params, "id")?;
            let fired = reg
                .signal_upstream(&source, &id)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "fired": fired }))
        }
        other => Err(format!("unknown host_rpc method `{other}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn rpc_origin_list_reports_live_group_after_shell_exits() {
        let dir = tempfile::tempdir().unwrap();
        let sup = JobSupervisor::new(
            Arc::new(JobStore::new_in_memory().unwrap()),
            dir.path().join("logs"),
        );
        let command = "sleep 60 </dev/null >/dev/null 2>&1 & exit 0";
        dispatch_with_supervisor(
            &sup,
            "jobs.spawn",
            &json!({
                "command": command, "program": "/bin/sh", "args": ["-c", command],
                "cwd": dir.path(), "env": { "PATH": "/usr/bin:/bin" }, "owner": { "kind": "app" },
                "origin": { "sessionId": "origin", "childRunId": "child", "dispatchEpoch": 1 }
            }),
        )
        .await
        .unwrap();
        let scope =
            json!({ "owner": { "kind": "session", "sessionId": "origin" }, "includeOrigin": true });
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let list = dispatch_with_supervisor(&sup, "jobs.list", &scope)
                .await
                .unwrap();
            if list["jobs"][0]["status"] == "exited" {
                assert_eq!(list["jobs"][0]["processGroupRunning"], true);
                break;
            }
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        dispatch_with_supervisor(&sup, "jobs.killOwnedBy", &scope)
            .await
            .unwrap();
        let list = dispatch_with_supervisor(&sup, "jobs.list", &scope)
            .await
            .unwrap();
        assert_eq!(list["jobs"][0]["processGroupRunning"], false);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detached_rpc_jobs_keep_origin_scope_through_kill_and_authoritative_read() {
        let dir = tempfile::tempdir().unwrap();
        let sup = JobSupervisor::new(
            Arc::new(JobStore::new_in_memory().unwrap()),
            dir.path().join("logs"),
        );
        let spawned = dispatch_with_supervisor(
            &sup,
            "jobs.spawn",
            &json!({
                "command": "sleep 60", "program": "/bin/sh", "args": ["-c", "sleep 60"],
                "cwd": dir.path(), "env": { "PATH": "/usr/bin:/bin" }, "owner": { "kind": "app" },
                "origin": { "sessionId": "origin", "childRunId": "child", "dispatchEpoch": 5 }
            }),
        )
        .await
        .unwrap();
        let owned = json!({ "owner": { "kind": "session", "sessionId": "origin" } });
        assert_eq!(
            dispatch_with_supervisor(&sup, "jobs.list", &owned)
                .await
                .unwrap(),
            json!({ "jobs": [] })
        );
        let origin =
            json!({ "owner": { "kind": "session", "sessionId": "origin" }, "includeOrigin": true });
        // Ordinary session disposal must leave an app-owned detached job alive.
        assert_eq!(
            dispatch_with_supervisor(&sup, "jobs.killOwnedBy", &owned)
                .await
                .unwrap(),
            json!({ "killed": [] })
        );
        let live = dispatch_with_supervisor(&sup, "jobs.list", &origin)
            .await
            .unwrap();
        assert_eq!(live["originSessionId"], "origin");
        assert_eq!(live["jobs"][0]["id"], spawned["id"]);
        assert_eq!(live["jobs"][0]["status"], "running");
        dispatch_with_supervisor(&sup, "jobs.killOwnedBy", &origin)
            .await
            .unwrap();
        for _ in 0..200 {
            let read = dispatch_with_supervisor(&sup, "jobs.list", &origin)
                .await
                .unwrap();
            if read["jobs"][0]["status"] != "running" {
                assert_eq!(read["jobs"][0]["status"], "killed");
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("origin process did not stop");
    }

    /// The sidecar's spawn carries the delivery contract, naming the chat
    /// session (its tool session owns the job as an executor); settlements
    /// list the ended job under that chat session (ADR-0249 §7).
    #[cfg(unix)]
    #[tokio::test]
    async fn rpc_spawn_with_delivery_is_listed_by_settlements_once_ended() {
        let dir = tempfile::tempdir().unwrap();
        let sup = JobSupervisor::new(
            Arc::new(JobStore::new_in_memory().unwrap()),
            dir.path().join("logs"),
        );
        let spawned = dispatch_with_supervisor(
            &sup,
            "jobs.spawn",
            &json!({
                "command": "echo hi", "program": "/bin/sh", "args": ["-c", "echo hi"],
                "cwd": dir.path(), "env": { "PATH": "/usr/bin:/bin" },
                "owner": { "kind": "session", "sessionId": "executor-1" },
                "origin": { "sessionId": "executor-1" },
                "delivery": { "sessionId": "s1", "runId": "execution:agent:r1", "notify": "none" }
            }),
        )
        .await
        .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let settled =
                dispatch_with_supervisor(&sup, "jobs.settlements", &json!({ "sessionId": "s1" }))
                    .await
                    .unwrap();
            if let Some(job) = settled["jobs"].as_array().and_then(|jobs| jobs.first()) {
                assert_eq!(job["jobId"], spawned["id"]);
                assert_eq!(job["delivery"]["runId"], "execution:agent:r1");
                assert_eq!(job["delivery"]["notify"], "none");
                assert!(job["outputTail"].as_str().unwrap_or("").contains("hi"));
                assert_eq!(settled["monitors"], json!([]));
                break;
            }
            assert!(tokio::time::Instant::now() < deadline, "job never settled");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rpc_claim_hands_an_ended_jobs_delivery_to_the_first_consumer_only() {
        let dir = tempfile::tempdir().unwrap();
        let sup = JobSupervisor::new(
            Arc::new(JobStore::new_in_memory().unwrap()),
            dir.path().join("logs"),
        );
        let spawned = dispatch_with_supervisor(
            &sup,
            "jobs.spawn",
            &json!({
                "command": "echo hi", "program": "/bin/sh", "args": ["-c", "echo hi"],
                "cwd": dir.path(), "env": { "PATH": "/usr/bin:/bin" },
                "owner": { "kind": "session", "sessionId": "executor-1" },
                "delivery": { "sessionId": "s1" }
            }),
        )
        .await
        .unwrap();
        let id = spawned["id"].as_str().unwrap().to_string();
        let claim = |consumer: &'static str| {
            let id = id.clone();
            let sup = &sup;
            async move {
                dispatch_with_supervisor(
                    sup,
                    "jobs.claimDelivery",
                    &json!({ "kind": "job", "id": id, "consumer": consumer }),
                )
                .await
                .unwrap()["claimed"]
                    .as_bool()
                    .unwrap()
            }
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        // A running job's end is not there to claim yet.
        while !claim("window-a").await {
            assert!(tokio::time::Instant::now() < deadline, "job never ended");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(
            !claim("brain").await,
            "a second consumer must not deliver it too"
        );
        assert!(
            claim("window-a").await,
            "the claimant may retry its own delivery"
        );
        let settled = dispatch_with_supervisor(&sup, "jobs.settlements", &json!({}))
            .await
            .unwrap();
        assert_eq!(settled["jobs"][0]["delivery"]["claimedBy"], "window-a");
        let err = dispatch_with_supervisor(
            &sup,
            "jobs.claimDelivery",
            &json!({ "kind": "shell", "id": id, "consumer": "brain" }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("kind"), "got {err}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rpc_spawn_rejects_a_malformed_delivery_instead_of_dropping_it() {
        let dir = tempfile::tempdir().unwrap();
        let sup = JobSupervisor::new(
            Arc::new(JobStore::new_in_memory().unwrap()),
            dir.path().join("logs"),
        );
        let err = dispatch_with_supervisor(
            &sup,
            "jobs.spawn",
            &json!({
                "command": "true", "program": "/bin/sh", "args": ["-c", "true"],
                "cwd": dir.path(), "owner": { "kind": "session", "sessionId": "s1" },
                "delivery": { "sessionId": "s1", "notify": "sometimes" }
            }),
        )
        .await
        .unwrap_err();
        assert!(err.contains("invalid delivery"), "got {err}");
    }

    #[test]
    fn str_field_reports_the_missing_key_by_name() {
        let params = json!({});
        let err = str_field(&params, "jobId").unwrap_err();
        assert!(err.contains("jobId"), "got {err}");
    }

    #[test]
    fn str_field_reads_a_present_value() {
        assert_eq!(str_field(&json!({ "jobId": "j1" }), "jobId").unwrap(), "j1");
    }

    #[test]
    fn u64_field_falls_back_to_the_default_for_missing_or_wrong_types() {
        let params = json!({ "a": 7, "b": "not-a-number" });
        assert_eq!(u64_field(&params, "a", 1), 7);
        assert_eq!(u64_field(&params, "b", 1), 1);
        assert_eq!(u64_field(&params, "missing", 42), 42);
    }

    #[test]
    fn owner_parses_each_tagged_variant() {
        let s = owner_from(&json!({ "owner": { "kind": "session", "sessionId": "s1" } })).unwrap();
        assert_eq!(
            s,
            JobOwner::Session {
                session_id: "s1".into()
            }
        );
        let a = owner_from(&json!({ "owner": { "kind": "app" } })).unwrap();
        assert_eq!(a, JobOwner::App);
    }

    #[test]
    fn owner_rejects_an_unknown_kind_instead_of_defaulting() {
        // Silently defaulting to `App` would quietly widen a job's lifetime
        // past what the caller asked for.
        assert!(owner_from(&json!({ "owner": { "kind": "nonsense" } })).is_err());
        assert!(owner_from(&json!({})).is_err());
    }

    #[tokio::test]
    async fn an_unknown_method_is_rejected_by_name() {
        // Runs before any `install`, so it also pins the not-available path.
        let err = dispatch_host_rpc("jobs.teleport", &json!({}))
            .await
            .unwrap_err();
        assert!(
            err.contains("not available") || err.contains("jobs.teleport"),
            "got {err}"
        );
    }
}
