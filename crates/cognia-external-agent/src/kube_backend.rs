//! Kubernetes flavor of the container exec backend (ADR-0059 R13, T3).
//!
//! Reuses [`super::container_backend::ContainerBackend`] wholesale — the
//! registry, line-buffering, and event choreography are daemon-agnostic.
//! Only the [`ContainerApi`] seam is reimplemented: one runner **Pod** per
//! spawned agent, the agent binary as the container's only process, stdio
//! over the pod attach API (`Tty: false`), and the workspace mounted as a
//! `subPath` of the shared workspaces **PVC** — a pod never sees another
//! workspace.
//!
//! Differences from the Docker (bollard) flavor, all deliberate:
//! - `pull_image` is a no-op: the kubelet pulls declaratively; a missing
//!   image shows up as the pod never reaching `Running` (timeout below),
//!   never as a create-time 404 — `RunnerRunError::ImageMissing` is unused.
//! - `RunnerSpec.seccomp_json` / `pids_limit` / `network_mode` are ignored:
//!   the k8s answers are a RuntimeClass (gvisor/kata — see
//!   `deploy/k8s/cluster/`), kubelet PID limits, and NetworkPolicy
//!   (`deploy/k8s/base/guardrails.yaml`).
//! - The pod meets the `restricted` Pod Security level: uid/gid
//!   [`RUNNER_UID`] with `runAsNonRoot`, the `RuntimeDefault` seccomp profile,
//!   no privilege escalation, every capability dropped. It carries an
//!   ephemeral-storage limit beside CPU and memory.
//! - Unless `COGNIA_RUNNER_RUNTIME_CLASS` names one, a runner pod takes the
//!   server pod's RuntimeClass, and always its image pull secrets: the server
//!   reads its own pod once ([`SERVER_POD_NAME_ENV`]), so a server moved onto
//!   gVisor or a private registry takes its agents with it.
//! - A pod that does not reach Running is described (phase, scheduling,
//!   the container's waiting or terminated reason) and deleted, as is one
//!   whose attach fails after it runs.
//! - `cap_drop` / `cap_add` / `read_only_rootfs` translate onto the
//!   container's `securityContext`; `tmpfs` entries become in-memory
//!   `emptyDir` volumes. `writable_dirs` has no honest k8s analogue (an
//!   `emptyDir` is empty, never seeded with the image's content), so a spec
//!   that names one is refused rather than half-applied.
//! - Host binds do not exist: `RunnerMount::Bind` is a hard error;
//!   `COGNIA_WORKSPACES_VOLUME` must name the workspaces PVC.
//! - Attach happens after the pod reports `Running` (k8s cannot attach
//!   pre-start like Docker); an ACP agent only writes after our first
//!   request, so nothing is lost in that window.
//!
//! Layering mirrors `container_backend.rs`: the pod-manifest builder and env
//! parsing below are feature-free and unit-tested here; the kube client
//! implementation lives behind the `k8s-exec` cargo feature so desktop
//! builds never compile a Kubernetes client. In-cluster config only — this
//! backend refuses to boot outside a pod.

#![cfg_attr(not(any(test, feature = "k8s-exec")), allow(dead_code))]

use serde_json::{json, Value};

use super::container_backend::{RunnerMount, RunnerSpec};

// ---------------------------------------------------------------------------
// Environment contract (deploy/k8s/tenant-template is the canonical consumer)
// ---------------------------------------------------------------------------

/// Namespace runner pods are created in (default: the server pod's own
/// namespace via the downward API / in-cluster default).
pub const RUNNER_NAMESPACE_ENV: &str = "COGNIA_RUNNER_NAMESPACE";
/// Node to pin runner pods to (downward API `spec.nodeName`). Required in
/// practice when the workspaces PVC is RWO — runner and server must share
/// the node to share the volume. Leave unset with RWX storage.
pub const RUNNER_NODE_NAME_ENV: &str = "COGNIA_RUNNER_NODE_NAME";
/// runtimeClassName for runner pods (e.g. `gvisor`). Unset, a runner pod takes
/// the server pod's own runtime class, so a server moved onto gVisor never
/// starts its agents outside it.
pub const RUNNER_RUNTIME_CLASS_ENV: &str = "COGNIA_RUNNER_RUNTIME_CLASS";
/// Seconds to wait for a runner pod to reach Running (image pull included).
pub const RUNNER_POD_READY_TIMEOUT_ENV: &str = "COGNIA_RUNNER_POD_READY_TIMEOUT_SECS";
/// Per-runner ephemeral-storage limit in MiB (default 10240). The writable
/// root, HOME and `/tmp` of an agent all count against it, so one runaway
/// agent is evicted instead of filling the node's disk.
pub const RUNNER_EPHEMERAL_STORAGE_MB_ENV: &str = "COGNIA_RUNNER_EPHEMERAL_STORAGE_MB";
/// The server pod's own name (downward API `metadata.name`), read to inherit
/// its runtime class and image pull secrets. Falls back to `HOSTNAME`, which
/// the kubelet sets to the pod name.
pub const SERVER_POD_NAME_ENV: &str = "COGNIA_SERVER_POD_NAME";

const DEFAULT_POD_READY_TIMEOUT_SECS: u64 = 120;
const DEFAULT_EPHEMERAL_STORAGE_MIB: u64 = 10 * 1024;
/// The single container's name inside a runner pod (attach targets it).
pub const RUNNER_CONTAINER_NAME: &str = "agent";
/// The uid and gid a runner pod runs as: the Runner image's user
/// (deploy/runner/Dockerfile), the uid cognia-server owns workspaces as, and a
/// non-root user a Kubernetes `restricted` namespace admits.
pub const RUNNER_UID: i64 = 10001;

#[derive(Clone, Debug)]
pub struct KubeRunnerOptions {
    pub namespace: Option<String>,
    pub node_name: Option<String>,
    /// [`RUNNER_RUNTIME_CLASS_ENV`]; when `None`, the server pod's class is
    /// filled in before a pod is built (see [`inherit_from_server_pod`]).
    pub runtime_class: Option<String>,
    pub pod_ready_timeout_secs: u64,
    pub ephemeral_storage_mib: u64,
    /// The server pod's image pull secrets, which a runner pod needs to pull
    /// a private Runner image from the same registry.
    pub image_pull_secrets: Vec<String>,
    pub server_pod: Option<String>,
}

impl KubeRunnerOptions {
    pub fn from_env() -> Result<Self, String> {
        let non_empty = |key: &str| {
            std::env::var(key)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let pod_ready_timeout_secs = match non_empty(RUNNER_POD_READY_TIMEOUT_ENV) {
            Some(v) => v
                .parse()
                .map_err(|e| format!("invalid {RUNNER_POD_READY_TIMEOUT_ENV}: {e}"))?,
            None => DEFAULT_POD_READY_TIMEOUT_SECS,
        };
        let ephemeral_storage_mib = match non_empty(RUNNER_EPHEMERAL_STORAGE_MB_ENV) {
            Some(v) => match v.parse::<u64>() {
                Ok(mib) if mib > 0 => mib,
                Ok(_) => return Err(format!("{RUNNER_EPHEMERAL_STORAGE_MB_ENV} must be above 0")),
                Err(e) => return Err(format!("invalid {RUNNER_EPHEMERAL_STORAGE_MB_ENV}: {e}")),
            },
            None => DEFAULT_EPHEMERAL_STORAGE_MIB,
        };
        Ok(Self {
            namespace: non_empty(RUNNER_NAMESPACE_ENV),
            node_name: non_empty(RUNNER_NODE_NAME_ENV),
            runtime_class: non_empty(RUNNER_RUNTIME_CLASS_ENV),
            pod_ready_timeout_secs,
            ephemeral_storage_mib,
            image_pull_secrets: Vec::new(),
            server_pod: non_empty(SERVER_POD_NAME_ENV).or_else(|| non_empty("HOSTNAME")),
        })
    }
}

/// Fill in what a runner pod inherits from the server pod, given that pod's
/// `spec`: its runtime class unless [`RUNNER_RUNTIME_CLASS_ENV`] names one,
/// and its image pull secrets (which already include the service account's,
/// since admission copies those onto the pod).
pub fn inherit_from_server_pod(opts: &KubeRunnerOptions, server_spec: &Value) -> KubeRunnerOptions {
    let mut inherited = opts.clone();
    if inherited.runtime_class.is_none() {
        inherited.runtime_class = server_spec
            .get("runtimeClassName")
            .and_then(Value::as_str)
            .filter(|class| !class.is_empty())
            .map(str::to_string);
    }
    inherited.image_pull_secrets = server_spec
        .get("imagePullSecrets")
        .and_then(Value::as_array)
        .map(|secrets| {
            secrets
                .iter()
                .filter_map(|secret| secret.get("name").and_then(Value::as_str))
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    inherited
}

/// Where a runner pod stands while it starts, from its `status`.
#[derive(Debug, PartialEq, Eq)]
pub enum PodStart {
    Running,
    /// Terminated before reaching Running: no point waiting further.
    Ended,
    /// Pending: scheduling, pulling, or backing off.
    Waiting,
}

pub fn pod_start(status: &Value) -> PodStart {
    match status.get("phase").and_then(Value::as_str) {
        Some("Running") => PodStart::Running,
        Some("Succeeded" | "Failed") => PodStart::Ended,
        _ => PodStart::Waiting,
    }
}

/// Why a runner pod has not started, from its `status`: the phase, a false
/// `PodScheduled` condition, and the runner container's waiting or
/// terminated state, so an image pull failure, an unschedulable pod and a
/// crashing agent read differently instead of as one timeout.
pub fn describe_pod_start(status: &Value) -> String {
    let mut parts = vec![format!(
        "phase {}",
        status
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    )];
    let text = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let with_message = |reason: String, message: Option<String>| match message {
        Some(message) => format!("{reason}: {message}"),
        None => reason,
    };
    for condition in status
        .get("conditions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if condition.get("type").and_then(Value::as_str) == Some("PodScheduled")
            && condition.get("status").and_then(Value::as_str) == Some("False")
        {
            let reason = text(condition, "reason").unwrap_or_else(|| "Unschedulable".into());
            parts.push(format!(
                "not scheduled: {}",
                with_message(reason, text(condition, "message"))
            ));
        }
    }
    let containers = status
        .get("containerStatuses")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    for container in containers {
        if container.get("name").and_then(Value::as_str) != Some(RUNNER_CONTAINER_NAME) {
            continue;
        }
        let state = container.get("state").cloned().unwrap_or(Value::Null);
        if let Some(waiting) = state.get("waiting") {
            let reason = text(waiting, "reason").unwrap_or_else(|| "Waiting".into());
            parts.push(format!(
                "container waiting: {}",
                with_message(reason, text(waiting, "message"))
            ));
        } else if let Some(terminated) = state.get("terminated") {
            let reason = text(terminated, "reason").unwrap_or_else(|| "Terminated".into());
            let code = terminated
                .get("exitCode")
                .and_then(Value::as_i64)
                .map(|code| format!(" (exit {code})"))
                .unwrap_or_default();
            parts.push(format!(
                "container terminated: {}{code}",
                with_message(reason, text(terminated, "message"))
            ));
        }
    }
    parts.join("; ")
}

/// Run what follows a successful pod create; if it fails, delete the pod
/// before returning, so a pod that never became a runner is not left for the
/// next boot's orphan sweep. A failed delete is part of the returned error.
pub async fn delete_on_failure<T, Rest, Delete, Deleted>(
    pod: &str,
    rest: Rest,
    delete: Delete,
) -> Result<T, String>
where
    Rest: std::future::Future<Output = Result<T, String>>,
    Delete: FnOnce() -> Deleted,
    Deleted: std::future::Future<Output = Result<(), String>>,
{
    match rest.await {
        Ok(value) => Ok(value),
        Err(error) => match delete().await {
            Ok(()) => Err(error),
            Err(delete_error) => Err(format!(
                "{error}; deleting pod {pod} also failed ({delete_error}), the next boot's orphan \
                 sweep removes it"
            )),
        },
    }
}

/// DNS-1123 subdomain form of a runner name. `sanitize_container_name`
/// already restricts to `[A-Za-z0-9_.-]`; k8s additionally forbids uppercase
/// and `_`, and requires alphanumeric ends.
pub fn pod_name(spec_name: &str) -> String {
    let lowered: String = spec_name
        .chars()
        .map(|c| match c.to_ascii_lowercase() {
            c if c.is_ascii_alphanumeric() || c == '-' || c == '.' => c,
            _ => '-',
        })
        .collect();
    let trimmed = lowered.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    let mut name = if trimmed.is_empty() {
        "cognia-agent".to_string()
    } else {
        trimmed.to_string()
    };
    name.truncate(63);
    while name
        .chars()
        .last()
        .is_some_and(|c| !c.is_ascii_alphanumeric())
    {
        name.pop();
    }
    name
}

/// Build the runner Pod manifest for `spec`. Pure — unit-tested without a
/// cluster or the kube dependency.
pub fn runner_pod_manifest(spec: &RunnerSpec, opts: &KubeRunnerOptions) -> Result<Value, String> {
    // A runtime environment sandbox on Kubernetes is the pool's pod
    // (ADR-0184), not a runner pod. Only the Docker driver builds these
    // fields; one reaching here is refused rather than half-applied.
    if spec.entrypoint.is_some()
        || spec.user.is_some()
        || spec.runtime.is_some()
        || !spec.extra_mounts.is_empty()
    {
        return Err(
            "kubernetes runner pods do not run runtime environment sandboxes; the Kubernetes \
             sandbox pool is ADR-0184"
                .to_string(),
        );
    }
    if !spec.writable_dirs.is_empty() {
        // `Config.Volumes` anonymous volumes are seeded with the image's
        // content. k8s has no equivalent — an emptyDir under the path would
        // silently hide what the image shipped there — so the spec is
        // refused rather than translated into a different semantic.
        return Err(
            "kubernetes runner pods cannot honor writable_dirs (an emptyDir is empty, not \
             seeded from the image)"
                .to_string(),
        );
    }
    let tmpfs: Vec<&str> = spec
        .tmpfs
        .iter()
        .map(|entry| {
            // k8s has no tmpfs option syntax — only the path translates.
            entry
                .split_once(':')
                .map_or(entry.as_str(), |(path, _)| path)
        })
        .collect();
    if spec.tmpfs.iter().any(|entry| {
        entry
            .split_once(':')
            .is_some_and(|(_, opts)| !opts.is_empty())
    }) {
        return Err(
            "kubernetes runner pods cannot honor tmpfs mount options (emptyDir has none)"
                .to_string(),
        );
    }
    let read_only = matches!(spec.mount, Some(RunnerMount::ReadOnly { .. }));
    let (claim, sub_path) = match spec.mount.as_ref().map(RunnerMount::source_mount) {
        Some(RunnerMount::Volume { volume, subpath }) => (volume.clone(), subpath.clone()),
        Some(RunnerMount::Bind { host_dir }) => {
            return Err(format!(
                "kubernetes exec mode has no host binds (got {host_dir}) — set \
                 COGNIA_WORKSPACES_VOLUME to the workspaces PVC name"
            ))
        }
        None => return Err("a kubernetes runner pod needs a workspace mount".to_string()),
        Some(RunnerMount::ReadOnly { .. }) => unreachable!("source_mount unwraps read-only mounts"),
    };

    let merged_env =
        super::container_backend::merge_runner_workspace_env(&spec.env, &spec.workspace_env);
    let env: Vec<Value> = merged_env
        .iter()
        .map(|kv| {
            let (name, value) = kv.split_once('=').unwrap_or((kv.as_str(), ""));
            json!({ "name": name, "value": value })
        })
        .collect();

    let memory_mi = (spec.memory_bytes / (1024 * 1024)).max(1);
    let milli_cpu = (spec.nano_cpus / 1_000_000).max(1);

    let mut volume_mount = json!({
        "name": "workspace",
        "mountPath": super::container_backend::WORKSPACE_TARGET,
    });
    if let Some(sub) = &sub_path {
        volume_mount["subPath"] = json!(sub);
    }
    if read_only { volume_mount["readOnly"] = json!(true); }
    let mut volume_mounts = vec![volume_mount];
    let mut volumes = vec![json!({
        "name": "workspace",
        "persistentVolumeClaim": { "claimName": claim },
    })];
    for (index, path) in tmpfs.iter().enumerate() {
        let name = format!("tmpfs-{index}");
        volumes.push(json!({
            "name": name,
            "emptyDir": { "medium": "Memory" },
        }));
        volume_mounts.push(json!({
            "name": name,
            "mountPath": path,
        }));
    }

    let mut security_context = json!({ "allowPrivilegeEscalation": false });
    if !spec.cap_drop.is_empty() || !spec.cap_add.is_empty() {
        let mut capabilities = serde_json::Map::new();
        if !spec.cap_drop.is_empty() {
            capabilities.insert("drop".to_string(), json!(spec.cap_drop));
        }
        if !spec.cap_add.is_empty() {
            capabilities.insert("add".to_string(), json!(spec.cap_add));
        }
        security_context["capabilities"] = Value::Object(capabilities);
    }
    if spec.read_only_rootfs {
        security_context["readOnlyRootFilesystem"] = json!(true);
    }

    let mut pod_spec = json!({
        "restartPolicy": "Never",
        "automountServiceAccountToken": false,
        "containers": [{
            "name": RUNNER_CONTAINER_NAME,
            "image": spec.image,
            "command": spec.cmd,
            "env": env,
            "workingDir": spec.working_dir,
            "stdin": true,
            "stdinOnce": false,
            "tty": false,
            "volumeMounts": volume_mounts,
            "resources": {
                "limits": {
                    "memory": format!("{memory_mi}Mi"),
                    "cpu": format!("{milli_cpu}m"),
                    "ephemeral-storage": format!("{}Mi", opts.ephemeral_storage_mib.max(1)),
                }
            },
            "securityContext": security_context,
        }],
        "volumes": volumes,
        // What a `restricted` Pod Security namespace requires of the pod
        // (the container half is allowPrivilegeEscalation=false and
        // capabilities.drop=[ALL] above). fsGroup makes the workspace volume
        // group-owned by the same uid cognia-server writes it as.
        "securityContext": {
            "runAsNonRoot": true,
            "runAsUser": RUNNER_UID,
            "runAsGroup": RUNNER_UID,
            "fsGroup": RUNNER_UID,
            "seccompProfile": { "type": "RuntimeDefault" },
        },
    });
    if let Some(node) = &opts.node_name {
        pod_spec["nodeName"] = json!(node);
    }
    if let Some(rc) = &opts.runtime_class {
        pod_spec["runtimeClassName"] = json!(rc);
    }
    if !opts.image_pull_secrets.is_empty() {
        pod_spec["imagePullSecrets"] = Value::Array(
            opts.image_pull_secrets
                .iter()
                .map(|name| json!({ "name": name }))
                .collect(),
        );
    }

    // Ownership labels ride on the pod too. Without them the k8s path has the
    // same blind spot the Docker path had: after a restart nothing can list
    // which pods are ours, so an orphan is invisible rather than reapable.
    let mut labels = serde_json::Map::new();
    labels.insert("app".to_string(), json!("cognia-runner"));
    for (key, value) in &spec.labels {
        labels.insert(key.clone(), json!(sanitize_label_value(value)));
    }

    Ok(json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": pod_name(&spec.name),
            "labels": Value::Object(labels),
        },
        "spec": pod_spec,
    }))
}

/// Coerce a value into what Kubernetes accepts for a label: alphanumerics,
/// `-`, `_`, `.`, starting and ending alphanumeric, at most 63 characters.
/// A value that cannot be coerced becomes `unknown` rather than failing the
/// spawn — a pod that runs with a degraded label beats a pod that will not
/// start, and the owner label itself is a fixed constant that always passes.
fn sanitize_label_value(value: &str) -> String {
    let mapped: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = mapped
        .trim_matches(|c: char| !c.is_ascii_alphanumeric())
        .chars()
        .take(63)
        .collect::<String>();
    let trimmed = trimmed.trim_end_matches(|c: char| !c.is_ascii_alphanumeric());
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

// ---------------------------------------------------------------------------
// Kube implementation (feature `k8s-exec`)
// ---------------------------------------------------------------------------

#[cfg(feature = "k8s-exec")]
pub mod kube_api {
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use std::time::Duration;

    use async_trait::async_trait;
    use k8s_openapi::api::core::v1::Pod;
    use kube::api::{Api, AttachParams, DeleteParams, ListParams, PostParams};
    use kube::runtime::wait::await_condition;
    use serde_json::Value;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::{mpsc, OnceCell};

    use super::super::container_backend::{
        is_owned, ContainerApi, OwnedContainer, RegistryAuth, RunnerEvent, RunnerRunError,
        RunnerSpec, RunningRunner, OWNER_LABEL, OWNER_VALUE,
    };
    use super::{
        delete_on_failure, describe_pod_start, inherit_from_server_pod, pod_start,
        runner_pod_manifest, KubeRunnerOptions, PodStart, RUNNER_CONTAINER_NAME,
    };

    pub struct KubeContainerApi {
        client: kube::Client,
        namespace: String,
        /// The namespace the server pod itself runs in (the in-cluster
        /// default), which may differ from the runner namespace.
        server_namespace: String,
        opts: KubeRunnerOptions,
        /// `opts` with what the server pod passes on, read once on first use.
        resolved: OnceCell<KubeRunnerOptions>,
    }

    impl KubeContainerApi {
        /// In-cluster only: the T3 topology always runs cognia-server as a
        /// pod, and refusing kubeconfig fallbacks keeps the failure mode of
        /// a misconfigured deployment loud.
        pub fn connect() -> Result<Arc<Self>, String> {
            let opts = KubeRunnerOptions::from_env()?;
            let config = kube::Config::incluster()
                .map_err(|e| format!("kubernetes exec mode requires in-cluster config: {e}"))?;
            let namespace = opts
                .namespace
                .clone()
                .unwrap_or_else(|| config.default_namespace.clone());
            let server_namespace = config.default_namespace.clone();
            let client = kube::Client::try_from(config)
                .map_err(|e| format!("kube client init failed: {e}"))?;
            Ok(Arc::new(Self {
                client,
                namespace,
                server_namespace,
                opts,
                resolved: OnceCell::new(),
            }))
        }

        fn pods(&self) -> Api<Pod> {
            Api::namespaced(self.client.clone(), &self.namespace)
        }

        /// The options a runner pod is built from: the configured ones plus
        /// the server pod's runtime class and image pull secrets. Reading the
        /// server pod failing is a failed spawn, not a pod started without
        /// the sandbox runtime the server itself runs under. A failure is
        /// not cached, so the next spawn reads again.
        async fn options(&self) -> Result<KubeRunnerOptions, String> {
            self.resolved
                .get_or_try_init(|| async {
                    let Some(name) = self.opts.server_pod.as_deref() else {
                        return Ok(self.opts.clone());
                    };
                    let pods: Api<Pod> =
                        Api::namespaced(self.client.clone(), &self.server_namespace);
                    let pod = pods.get(name).await.map_err(|e| {
                        format!(
                            "cannot read the server pod {name} to inherit its runtime class and \
                             image pull secrets: {e}"
                        )
                    })?;
                    let spec = serde_json::to_value(&pod.spec)
                        .map_err(|e| format!("server pod {name} spec: {e}"))?;
                    Ok(inherit_from_server_pod(&self.opts, &spec))
                })
                .await
                .cloned()
        }
    }

    fn pod_status(pod: Option<&Pod>) -> Value {
        pod.and_then(|pod| pod.status.as_ref())
            .and_then(|status| serde_json::to_value(status).ok())
            .unwrap_or(Value::Null)
    }

    /// Wait until the pod runs, stops, or the timeout passes, and say why
    /// it is not running when it is not.
    async fn wait_until_running(
        pods: &Api<Pod>,
        name: &str,
        timeout_secs: u64,
    ) -> Result<(), String> {
        let settled =
            |pod: Option<&Pod>| pod.is_none() || pod_start(&pod_status(pod)) != PodStart::Waiting;
        let waited = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            await_condition(pods.clone(), name, settled),
        )
        .await;
        match waited {
            Ok(Ok(Some(pod))) => {
                let status = pod_status(Some(&pod));
                match pod_start(&status) {
                    PodStart::Running => Ok(()),
                    _ => Err(format!(
                        "pod {name} stopped before it ran: {}",
                        describe_pod_start(&status)
                    )),
                }
            }
            Ok(Ok(None)) => Err(format!("pod {name} was deleted while it started")),
            Ok(Err(e)) => Err(format!("pod {name} failed while waiting for Running: {e}")),
            Err(_) => {
                let current = pods.get_opt(name).await.ok().flatten();
                Err(format!(
                    "pod {name} not Running within {timeout_secs}s: {}",
                    describe_pod_start(&pod_status(current.as_ref()))
                ))
            }
        }
    }

    async fn delete_now(pods: &Api<Pod>, name: &str) -> Result<(), String> {
        match pods
            .delete(
                name,
                &DeleteParams {
                    grace_period_seconds: Some(0),
                    ..DeleteParams::default()
                },
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(kube::Error::Api(status)) if status.code == 404 => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Exit code of the runner container, if the pod still exists and has
    /// terminated. Best-effort — a killed pod may already be deleted.
    async fn terminated_exit_code(pods: &Api<Pod>, name: &str) -> Option<i64> {
        let pod = pods.get(name).await.ok()?;
        let statuses = pod.status?.container_statuses?;
        let state = statuses.into_iter().next()?.state?;
        state.terminated.map(|t| i64::from(t.exit_code))
    }

    fn pod_labels(pod: &Pod) -> BTreeMap<String, String> {
        pod.metadata.labels.clone().unwrap_or_default()
    }

    fn owned_container_from_pod(pod: Pod) -> Option<OwnedContainer> {
        let id = pod.metadata.name?;
        let labels = pod.metadata.labels.unwrap_or_default();
        is_owned(&labels).then_some(OwnedContainer { id, labels })
    }

    #[async_trait]
    impl ContainerApi for KubeContainerApi {
        async fn run(&self, spec: RunnerSpec) -> Result<RunningRunner, RunnerRunError> {
            let opts = self.options().await.map_err(RunnerRunError::Other)?;
            let manifest = runner_pod_manifest(&spec, &opts).map_err(RunnerRunError::Other)?;
            let pod: Pod = serde_json::from_value(manifest)
                .map_err(|e| RunnerRunError::Other(format!("pod manifest invalid: {e}")))?;
            let name = pod
                .metadata
                .name
                .clone()
                .expect("runner_pod_manifest always sets a name");
            let pods = self.pods();

            // An admission refusal (a Pod Security level, a quota) arrives
            // here with the API server's reason.
            pods.create(&PostParams::default(), &pod)
                .await
                .map_err(|e| RunnerRunError::Other(format!("pod create failed: {e}")))?;

            // From here the pod exists. Whatever fails before it becomes a
            // runner deletes it: the caller only learns of a runner it got.
            let started = async {
                // Covers scheduling and the image pull.
                wait_until_running(&pods, &name, opts.pod_ready_timeout_secs).await?;
                let attach_params = AttachParams::default()
                    .container(RUNNER_CONTAINER_NAME)
                    .stdin(true)
                    .stdout(true)
                    .stderr(true)
                    .tty(false);
                let mut attached = pods
                    .attach(&name, &attach_params)
                    .await
                    .map_err(|e| format!("pod {name} attach failed: {e}"))?;
                let stdin = attached
                    .stdin()
                    .ok_or_else(|| format!("pod {name} attach returned no stdin stream"))?;
                let stdout = attached
                    .stdout()
                    .ok_or_else(|| format!("pod {name} attach returned no stdout stream"))?;
                let stderr = attached
                    .stderr()
                    .ok_or_else(|| format!("pod {name} attach returned no stderr stream"))?;
                Ok((attached, stdin, stdout, stderr))
            };
            let (_attached, mut stdin_writer, mut stdout_reader, mut stderr_reader) =
                delete_on_failure(&name, started, || delete_now(&pods, &name))
                    .await
                    .map_err(RunnerRunError::Other)?;

            let (event_tx, event_rx) = mpsc::unbounded_channel::<RunnerEvent>();
            let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();

            // stdin pump.
            tokio::spawn(async move {
                while let Some(bytes) = stdin_rx.recv().await {
                    if stdin_writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                    let _ = stdin_writer.flush().await;
                }
            });

            // Output pumps — drain both streams to EOF (the attach streams
            // close when the process exits), THEN resolve the exit code from
            // pod status, so Exited is guaranteed to be the last event.
            let pods_for_status = pods.clone();
            let status_name = name.clone();
            tokio::spawn(async move {
                let out_tx = event_tx.clone();
                let out = async move {
                    let mut buf = [0u8; 4096];
                    loop {
                        match stdout_reader.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if out_tx.send(RunnerEvent::Stdout(buf[..n].to_vec())).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                };
                let err_tx = event_tx.clone();
                let err = async move {
                    let mut buf = [0u8; 4096];
                    loop {
                        match stderr_reader.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if err_tx.send(RunnerEvent::Stderr(buf[..n].to_vec())).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                };
                tokio::join!(out, err);
                let code = terminated_exit_code(&pods_for_status, &status_name).await;
                let _ = event_tx.send(RunnerEvent::Exited { code });
            });

            Ok(RunningRunner {
                container_id: name,
                events: event_rx.into(),
                stdin: stdin_tx.into(),
            })
        }

        async fn pull_image(
            &self,
            _image: &str,
            _auth: Option<RegistryAuth>,
        ) -> Result<(), String> {
            // The kubelet pulls declaratively at pod admission, with the
            // image pull secrets the pod inherits from the server pod; `run`
            // never reports ImageMissing, so this is unreachable in practice.
            Ok(())
        }

        async fn kill(&self, container_id: &str) -> Result<(), String> {
            // grace 0 ≈ SIGKILL: the attach streams close, the reader task
            // emits Exited, and the ContainerBackend choreography proceeds
            // exactly as with the Docker flavor.
            self.pods()
                .delete(
                    container_id,
                    &DeleteParams {
                        grace_period_seconds: Some(0),
                        ..DeleteParams::default()
                    },
                )
                .await
                .map(|_| ())
                .map_err(|e| format!("pod delete failed: {e}"))
        }

        async fn labels(
            &self,
            container_id: &str,
        ) -> Result<Option<BTreeMap<String, String>>, String> {
            self.pods()
                .get_opt(container_id)
                .await
                .map(|pod| pod.as_ref().map(pod_labels))
                .map_err(|e| format!("pod get failed: {e}"))
        }

        async fn list_owned(&self) -> Result<Vec<OwnedContainer>, String> {
            // Include terminated pods: they are precisely the orphans a
            // previous server process may have failed to delete.
            let selector = format!("{OWNER_LABEL}={OWNER_VALUE}");
            let params = ListParams::default().labels(&selector);
            self.pods()
                .list(&params)
                .await
                .map(|pods| {
                    pods.items
                        .into_iter()
                        .filter_map(owned_container_from_pod)
                        .collect()
                })
                .map_err(|e| format!("pod list failed: {e}"))
        }

        async fn remove(&self, container_id: &str) -> Result<(), String> {
            match self
                .pods()
                .delete(container_id, &DeleteParams::default())
                .await
            {
                Ok(_) => Ok(()),
                // Idempotent: an already-gone pod is success.
                Err(kube::Error::Api(status)) if status.code == 404 => Ok(()),
                Err(e) => Err(format!("pod delete failed: {e}")),
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

        use super::*;
        use crate::container_backend::{ownership_labels, INSTANCE_LABEL};

        fn pod(name: Option<&str>, labels: BTreeMap<String, String>) -> Pod {
            Pod {
                metadata: ObjectMeta {
                    name: name.map(str::to_string),
                    labels: Some(labels),
                    ..ObjectMeta::default()
                },
                ..Pod::default()
            }
        }

        #[test]
        fn pod_labels_preserve_ownership_metadata() {
            let labels = ownership_labels("agent-1", "instance-previous", "deployment-a");
            assert_eq!(pod_labels(&pod(Some("runner-1"), labels.clone())), labels);
        }

        #[test]
        fn owned_container_requires_name_and_owner_label() {
            let labels = ownership_labels("agent-1", "instance-previous", "deployment-a");
            let owned = owned_container_from_pod(pod(Some("runner-1"), labels))
                .expect("owner-labelled pod with a name");
            assert_eq!(owned.id, "runner-1");
            assert_eq!(
                owned.labels.get(INSTANCE_LABEL).map(String::as_str),
                Some("instance-previous")
            );

            assert!(owned_container_from_pod(pod(None, ownership_labels("a", "b", "c"))).is_none());
            assert!(owned_container_from_pod(pod(
                Some("foreign"),
                BTreeMap::from([("app".to_string(), "foreign".to_string())]),
            ))
            .is_none());
        }
    }
}

// ---------------------------------------------------------------------------
// Tests (feature-free: manifest builder + env parsing)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::super::container_backend::{
        ownership_labels, RunnerMount, RunnerSpec, WORKSPACE_TARGET,
    };
    use super::*;

    fn spec(mount: RunnerMount) -> RunnerSpec {
        RunnerSpec {
            name: "cognia-agent-A_1".into(),
            image: "ghcr.io/example/cognia-runner:test".into(),
            cmd: vec!["claude-code-acp".into(), "--stdio".into()],
            workspace_env: Default::default(),
            env: vec!["A_KEY=1".into(), "FLAG".into()],
            working_dir: WORKSPACE_TARGET.into(),
            mount: Some(mount),
            seccomp_json: Some("{}".into()),
            memory_bytes: 2048 * 1024 * 1024,
            nano_cpus: 1_500_000_000,
            pids_limit: 512,
            network_mode: "bridge".into(),
            labels: ownership_labels("A_1", "test-instance", "test-deployment"),
            entrypoint: None,
            user: None,
            extra_mounts: Vec::new(),
            runtime: None,
            cap_drop: vec!["ALL".to_string()],
            cap_add: Vec::new(),
            read_only_rootfs: false,
            tmpfs: Vec::new(),
            writable_dirs: Vec::new(),
        }
    }

    fn opts() -> KubeRunnerOptions {
        KubeRunnerOptions {
            namespace: None,
            node_name: None,
            runtime_class: None,
            pod_ready_timeout_secs: 120,
            ephemeral_storage_mib: 10 * 1024,
            image_pull_secrets: Vec::new(),
            server_pod: None,
        }
    }

    #[test]
    fn runner_pods_meet_the_restricted_pod_security_level() {
        // A `restricted` namespace (deploy/k8s/overlays/production) refused
        // the pod before: no runAsNonRoot, no seccomp profile, image user root.
        let manifest = runner_pod_manifest(
            &spec(RunnerMount::Volume {
                volume: "v".into(),
                subpath: Some("ws".into()),
            }),
            &opts(),
        )
        .expect("manifest");
        let pod = &manifest["spec"]["securityContext"];
        assert_eq!(pod["runAsNonRoot"], true);
        assert_eq!(pod["runAsUser"], RUNNER_UID);
        assert_eq!(pod["runAsGroup"], RUNNER_UID);
        assert_eq!(pod["fsGroup"], RUNNER_UID);
        assert_eq!(pod["seccompProfile"]["type"], "RuntimeDefault");
        let container = &manifest["spec"]["containers"][0]["securityContext"];
        assert_eq!(container["allowPrivilegeEscalation"], false);
        assert_eq!(container["capabilities"]["drop"][0], "ALL");
        assert!(container["capabilities"].get("add").is_none());
        assert_eq!(
            manifest["spec"]["containers"][0]["resources"]["limits"]["ephemeral-storage"],
            "10240Mi"
        );
        assert!(manifest["spec"].get("imagePullSecrets").is_none());
    }

    #[test]
    fn runner_pods_inherit_the_server_pods_runtime_class_and_pull_secrets() {
        let server = json!({
            "runtimeClassName": "gvisor",
            "imagePullSecrets": [{ "name": "ghcr-pull" }, { "name": "" }, { "other": 1 }],
        });
        let inherited = inherit_from_server_pod(&opts(), &server);
        assert_eq!(inherited.runtime_class.as_deref(), Some("gvisor"));
        assert_eq!(inherited.image_pull_secrets, vec!["ghcr-pull".to_string()]);
        let manifest = runner_pod_manifest(
            &spec(RunnerMount::Volume {
                volume: "v".into(),
                subpath: None,
            }),
            &inherited,
        )
        .expect("manifest");
        assert_eq!(manifest["spec"]["runtimeClassName"], "gvisor");
        assert_eq!(manifest["spec"]["imagePullSecrets"][0]["name"], "ghcr-pull");

        // An explicit class wins; a server pod with neither passes nothing on.
        let explicit = KubeRunnerOptions {
            runtime_class: Some("kata".into()),
            ..opts()
        };
        assert_eq!(
            inherit_from_server_pod(&explicit, &server)
                .runtime_class
                .as_deref(),
            Some("kata")
        );
        let plain = inherit_from_server_pod(&opts(), &json!({}));
        assert_eq!(plain.runtime_class, None);
        assert!(plain.image_pull_secrets.is_empty());
    }

    #[test]
    fn a_pod_that_does_not_start_says_why() {
        assert_eq!(pod_start(&json!({ "phase": "Running" })), PodStart::Running);
        assert_eq!(pod_start(&json!({ "phase": "Failed" })), PodStart::Ended);
        assert_eq!(pod_start(&json!({ "phase": "Succeeded" })), PodStart::Ended);
        assert_eq!(pod_start(&json!({ "phase": "Pending" })), PodStart::Waiting);
        assert_eq!(pod_start(&Value::Null), PodStart::Waiting);

        let pulling = json!({
            "phase": "Pending",
            "containerStatuses": [{
                "name": RUNNER_CONTAINER_NAME,
                "state": { "waiting": {
                    "reason": "ImagePullBackOff",
                    "message": "Back-off pulling image \"ghcr.io/o/cognia-runner:latest\"",
                } },
            }],
        });
        assert_eq!(
            describe_pod_start(&pulling),
            "phase Pending; container waiting: ImagePullBackOff: Back-off pulling image \
             \"ghcr.io/o/cognia-runner:latest\""
        );
        let unschedulable = json!({
            "phase": "Pending",
            "conditions": [
                { "type": "PodScheduled", "status": "False", "reason": "Unschedulable",
                  "message": "0/3 nodes are available: 3 Insufficient memory." },
                { "type": "Ready", "status": "False" },
            ],
        });
        assert_eq!(
            describe_pod_start(&unschedulable),
            "phase Pending; not scheduled: Unschedulable: 0/3 nodes are available: 3 Insufficient memory."
        );
        let crashed = json!({
            "phase": "Failed",
            "containerStatuses": [
                { "name": "sidecar", "state": { "waiting": { "reason": "Ignored" } } },
                { "name": RUNNER_CONTAINER_NAME,
                  "state": { "terminated": { "reason": "Error", "exitCode": 127 } } },
            ],
        });
        assert_eq!(
            describe_pod_start(&crashed),
            "phase Failed; container terminated: Error (exit 127)"
        );
        assert_eq!(describe_pod_start(&Value::Null), "phase unknown");
    }

    #[tokio::test]
    async fn a_pod_that_fails_after_create_is_deleted() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let deletes = AtomicUsize::new(0);
        let delete = || async {
            deletes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        };

        let ok = delete_on_failure("p", async { Ok::<_, String>(7) }, delete).await;
        assert_eq!(ok, Ok(7));
        assert_eq!(
            deletes.load(Ordering::SeqCst),
            0,
            "a pod that became a runner stays"
        );

        let attach = delete_on_failure(
            "p",
            async { Err::<(), _>("pod p attach failed: closed".to_string()) },
            delete,
        )
        .await;
        assert_eq!(attach, Err("pod p attach failed: closed".to_string()));
        assert_eq!(deletes.load(Ordering::SeqCst), 1);

        let both = delete_on_failure(
            "p",
            async { Err::<(), _>("pod p not Running within 1s: phase Pending".to_string()) },
            || async { Err("forbidden".to_string()) },
        )
        .await
        .unwrap_err();
        assert!(both.starts_with("pod p not Running within 1s: phase Pending; deleting pod p also failed (forbidden)"), "{both}");
    }

    #[test]
    fn p4_kubernetes_workspace_read_only_is_additive() {
        let original = RunnerMount::Volume { volume: "workspaces".into(), subpath: Some("task".into()) };
        let legacy = runner_pod_manifest(&spec(original.clone()), &opts()).unwrap();
        let readonly = runner_pod_manifest(&spec(RunnerMount::ReadOnly { mount: Box::new(original) }), &opts()).unwrap();
        assert!(legacy["spec"]["containers"][0]["volumeMounts"][0].get("readOnly").is_none());
        assert_eq!(readonly["spec"]["containers"][0]["volumeMounts"][0]["readOnly"], true);
    }

    #[test]
    fn pod_name_is_dns1123() {
        assert_eq!(pod_name("cognia-agent-A_1"), "cognia-agent-a-1");
        assert_eq!(pod_name("ok.id-9"), "ok.id-9");
        assert_eq!(pod_name("---"), "cognia-agent");
        let long = pod_name(&"x".repeat(80));
        assert_eq!(long.len(), 63);
    }

    #[test]
    fn manifest_maps_spec_onto_a_locked_down_pod() {
        let manifest = runner_pod_manifest(
            &spec(RunnerMount::Volume {
                volume: "cognia-workspaces".into(),
                subpath: Some("ws-1".into()),
            }),
            &KubeRunnerOptions {
                node_name: Some("node-a".into()),
                runtime_class: Some("gvisor".into()),
                ..opts()
            },
        )
        .expect("manifest");

        assert_eq!(manifest["metadata"]["name"], "cognia-agent-a-1");
        let pod_spec = &manifest["spec"];
        assert_eq!(pod_spec["restartPolicy"], "Never");
        assert_eq!(pod_spec["automountServiceAccountToken"], false);
        assert_eq!(pod_spec["nodeName"], "node-a");
        assert_eq!(pod_spec["runtimeClassName"], "gvisor");
        assert_eq!(
            pod_spec["volumes"][0]["persistentVolumeClaim"]["claimName"],
            "cognia-workspaces"
        );

        let container = &pod_spec["containers"][0];
        assert_eq!(container["name"], RUNNER_CONTAINER_NAME);
        assert_eq!(container["command"][0], "claude-code-acp");
        assert_eq!(container["stdin"], true);
        assert_eq!(container["tty"], false);
        assert_eq!(container["workingDir"], WORKSPACE_TARGET);
        assert_eq!(container["volumeMounts"][0]["subPath"], "ws-1");
        assert_eq!(container["resources"]["limits"]["memory"], "2048Mi");
        assert_eq!(container["resources"]["limits"]["cpu"], "1500m");
        assert_eq!(
            container["securityContext"]["allowPrivilegeEscalation"],
            false
        );
        // Env pairs split on the first '='; a bare key becomes an empty value.
        assert_eq!(container["env"][0]["name"], "A_KEY");
        assert_eq!(container["env"][0]["value"], "1");
        assert_eq!(container["env"][1]["name"], "FLAG");
        assert_eq!(container["env"][1]["value"], "");
    }

    #[test]
    fn root_workspace_omits_subpath_and_optional_fields() {
        let manifest = runner_pod_manifest(
            &spec(RunnerMount::Volume {
                volume: "v".into(),
                subpath: None,
            }),
            &opts(),
        )
        .expect("manifest");
        let pod_spec = &manifest["spec"];
        assert!(pod_spec.get("nodeName").is_none());
        assert!(pod_spec.get("runtimeClassName").is_none());
        assert!(pod_spec["containers"][0]["volumeMounts"][0]
            .get("subPath")
            .is_none());
    }

    #[test]
    fn bind_mounts_are_rejected() {
        let err = runner_pod_manifest(
            &spec(RunnerMount::Bind {
                host_dir: "/workspaces/ws-1".into(),
            }),
            &opts(),
        )
        .unwrap_err();
        assert!(err.contains("COGNIA_WORKSPACES_VOLUME"), "{err}");
    }

    #[test]
    fn runtime_environment_fields_and_a_missing_workspace_are_refused() {
        let workspace = RunnerMount::Volume {
            volume: "v".into(),
            subpath: None,
        };
        let sandbox_fields: [fn(&mut RunnerSpec); 4] = [
            |s| s.entrypoint = Some(vec!["/cognia/bin/cognia-sandboxd".into()]),
            |s| s.user = Some("0".into()),
            |s| s.runtime = Some("runsc".into()),
            |s| {
                s.extra_mounts
                    .push(super::super::container_backend::VolumeMount {
                        volume: "bundle".into(),
                        target: "/cognia".into(),
                        read_only: true,
                    })
            },
        ];
        for set in sandbox_fields {
            let mut sandboxed = spec(workspace.clone());
            set(&mut sandboxed);
            let err = runner_pod_manifest(&sandboxed, &opts()).unwrap_err();
            assert!(err.contains("ADR-0184"), "{err}");
        }

        let mut no_workspace = spec(workspace);
        no_workspace.mount = None;
        assert!(runner_pod_manifest(&no_workspace, &opts())
            .unwrap_err()
            .contains("workspace mount"));
    }

    #[test]
    fn capability_and_readonly_bounds_land_on_the_security_context() {
        let mut hardened = spec(RunnerMount::Volume {
            volume: "v".into(),
            subpath: None,
        });
        hardened.cap_drop = vec!["ALL".into()];
        hardened.cap_add = vec!["CHOWN".into()];
        hardened.read_only_rootfs = true;
        hardened.tmpfs = vec!["/tmp".into(), "/run".into()];

        let manifest = runner_pod_manifest(&hardened, &opts()).expect("manifest");
        let container = &manifest["spec"]["containers"][0];
        assert_eq!(
            container["securityContext"]["capabilities"]["drop"][0],
            "ALL"
        );
        assert_eq!(
            container["securityContext"]["capabilities"]["add"][0],
            "CHOWN"
        );
        assert_eq!(container["securityContext"]["readOnlyRootFilesystem"], true);
        // Each tmpfs path is an in-memory emptyDir paired with a mount.
        assert_eq!(
            manifest["spec"]["volumes"][1]["emptyDir"]["medium"],
            "Memory"
        );
        assert_eq!(container["volumeMounts"][1]["mountPath"], "/tmp");
        assert_eq!(container["volumeMounts"][2]["mountPath"], "/run");
    }

    #[test]
    fn writable_dirs_and_tmpfs_options_are_refused_not_half_applied() {
        let mut seeded = spec(RunnerMount::Volume {
            volume: "v".into(),
            subpath: None,
        });
        seeded.writable_dirs = vec!["/home/agent".into()];
        let err = runner_pod_manifest(&seeded, &opts()).unwrap_err();
        assert!(err.contains("writable_dirs"), "{err}");

        let mut with_opts = spec(RunnerMount::Volume {
            volume: "v".into(),
            subpath: None,
        });
        with_opts.tmpfs = vec!["/run:size=64m".into()];
        let err = runner_pod_manifest(&with_opts, &opts()).unwrap_err();
        assert!(err.contains("tmpfs"), "{err}");
    }

    #[tokio::test]
    async fn options_from_env_parse_and_default() {
        let _guard = crate::test_env_lock::env_lock().await;
        std::env::remove_var(RUNNER_NAMESPACE_ENV);
        std::env::remove_var(RUNNER_NODE_NAME_ENV);
        std::env::remove_var(RUNNER_RUNTIME_CLASS_ENV);
        std::env::remove_var(RUNNER_POD_READY_TIMEOUT_ENV);
        let defaults = KubeRunnerOptions::from_env().expect("defaults");
        assert_eq!(defaults.namespace, None);
        assert_eq!(defaults.pod_ready_timeout_secs, 120);

        std::env::set_var(RUNNER_NAMESPACE_ENV, "tenant-a");
        std::env::set_var(RUNNER_NODE_NAME_ENV, "node-a");
        std::env::set_var(RUNNER_RUNTIME_CLASS_ENV, "gvisor");
        std::env::set_var(RUNNER_POD_READY_TIMEOUT_ENV, "45");
        let parsed = KubeRunnerOptions::from_env().expect("parsed");
        assert_eq!(parsed.namespace.as_deref(), Some("tenant-a"));
        assert_eq!(parsed.node_name.as_deref(), Some("node-a"));
        assert_eq!(parsed.runtime_class.as_deref(), Some("gvisor"));
        assert_eq!(parsed.pod_ready_timeout_secs, 45);

        std::env::set_var(RUNNER_POD_READY_TIMEOUT_ENV, "not-a-number");
        assert!(KubeRunnerOptions::from_env()
            .unwrap_err()
            .contains(RUNNER_POD_READY_TIMEOUT_ENV));
        std::env::remove_var(RUNNER_POD_READY_TIMEOUT_ENV);

        std::env::remove_var(RUNNER_EPHEMERAL_STORAGE_MB_ENV);
        assert_eq!(
            KubeRunnerOptions::from_env().unwrap().ephemeral_storage_mib,
            10240
        );
        std::env::set_var(RUNNER_EPHEMERAL_STORAGE_MB_ENV, "4096");
        assert_eq!(
            KubeRunnerOptions::from_env().unwrap().ephemeral_storage_mib,
            4096
        );
        for bad in ["0", "-1", "lots"] {
            std::env::set_var(RUNNER_EPHEMERAL_STORAGE_MB_ENV, bad);
            assert!(KubeRunnerOptions::from_env()
                .unwrap_err()
                .contains(RUNNER_EPHEMERAL_STORAGE_MB_ENV));
        }
        std::env::remove_var(RUNNER_EPHEMERAL_STORAGE_MB_ENV);

        std::env::set_var(SERVER_POD_NAME_ENV, "cognia-server-0");
        assert_eq!(
            KubeRunnerOptions::from_env().unwrap().server_pod.as_deref(),
            Some("cognia-server-0")
        );
        std::env::remove_var(SERVER_POD_NAME_ENV);

        std::env::remove_var(RUNNER_NAMESPACE_ENV);
        std::env::remove_var(RUNNER_NODE_NAME_ENV);
        std::env::remove_var(RUNNER_RUNTIME_CLASS_ENV);
    }
}
