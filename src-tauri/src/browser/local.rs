//! ADR-0201 — command shells over `cognia-local-browser`: the local Chromium
//! runtime (install, start/stop, allow-listed RPC), its frames and events, and
//! the user's own Chrome.
//!
//! The renderer never sees the runtime's URL or secret. Every renderer call
//! goes through [`browser_local_rpc`], whose allow-list
//! ([`bridge::is_renderer_op`]) excludes the value-carrying ops; only Rust
//! issues those, through [`rpc_privileged`]. `browser.session.create` is
//! rewritten here: host-owned fields are stripped and the Downloads directory,
//! the enabled extensions (local) or the user's Chrome endpoint (user-chrome)
//! are injected.
//!
//! Uploads: a session may only upload from `<app_data>/browser/uploads`.
//! `browser_local_stage_upload` shows a native file picker and copies the
//! chosen files there; the renderer then hands the staged paths to
//! `browser.files.set`.
//!
//! Frames are pushed as raw bytes (`InvokeResponseBody::Raw`, an `ArrayBuffer`
//! in JS) holding the runtime's 24-byte framed JPEG. Journal events are
//! re-emitted as `browser-local://event`; a submitted login's password goes to
//! the password vault (`passwords::stash_pending`) and only a pending id
//! reaches the renderer.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use cognia_local_browser::bridge::{self, BridgeEvent, RuntimeTransport, StopHandle};
use cognia_local_browser::client::RuntimeClient;
use cognia_local_browser::document_viewer::{self, EventRoute, SessionPurpose};
use cognia_local_browser::supervisor::{self, Supervisor, SupervisorConfig, SupervisorEvent};
use cognia_local_browser::{installer, user_chrome};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

/// Runtime journal events, re-emitted.
pub const LOCAL_EVENT: &str = "browser-local://event";
/// Chromium installer progress.
pub const INSTALL_EVENT: &str = "browser-local://install";

/// `<app_data>/browser`: profiles, Chromium, extensions, downloads settings.
pub(crate) fn browser_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("browser"))
        .map_err(|error| format!("app_data_unavailable: {error}"))
}

/// Where the staged runtime may live: the two Tauri resource layouts, then
/// (debug builds) the checkout's `src-tauri/resources/browser-runtime`.
fn runtime_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let resource_dir = app.path().resource_dir().ok();
    let checkout = cfg!(debug_assertions)
        .then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/browser-runtime"));
    supervisor::runtime_candidates(resource_dir.as_deref(), checkout.as_deref())
}

/// The staged runtime directory, or a `runtime_not_staged` error.
pub(crate) fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    supervisor::locate_runtime(&runtime_candidates(app))
        .map_err(|error| format!("runtime_not_staged: {error}"))
}

/// Everything that needs the staged runtime and Node.
struct LocalCore {
    browsers_path: PathBuf,
    supervisor: Arc<Supervisor>,
    transport: bridge::SupervisedTransport,
}

/// Managed state (`.manage(LocalBrowserState::default())`).
#[derive(Default)]
pub struct LocalBrowserState {
    core: Mutex<Option<Arc<LocalCore>>>,
    /// Held for the whole of an install or uninstall, so the two never
    /// overlap and the "in progress" check cannot race the work.
    install_lock: tokio::sync::Mutex<()>,
    /// Mirrors "an install is running" for `browser_local_status`; reset by
    /// [`InstallingFlag`]'s drop, so an early return or a panic cannot leave
    /// it stuck.
    installing: AtomicBool,
    install_error: Mutex<Option<String>>,
    frames: Mutex<HashMap<String, (u64, String, StopHandle)>>,
    frame_tokens: AtomicU64,
    frame_starts: Mutex<HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>>,
    frame_cleanup: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    events: Mutex<Option<StopHandle>>,
    sessions: Mutex<HashMap<String, LocalSession>>,
}

#[derive(Clone, Debug)]
struct LocalSession {
    kind: bridge::SessionKind,
    purpose: Option<SessionPurpose>,
    creator_window: String,
    creation_identity: Arc<()>,
}

impl LocalSession {
    fn authorize(&self, caller: &str, op: &str) -> Result<(), String> {
        document_viewer::authorize_window(self.purpose, &self.creator_window, caller)
            .and_then(|()| document_viewer::authorize_operation(self.purpose, op))
            .map_err(|error| error.to_string())
    }

    fn event_route(&self, credential_submitted: bool) -> EventRoute<'_> {
        document_viewer::event_route(self.purpose, &self.creator_window, credential_submitted)
    }
}

// A late event after session.closed must not become a broadcast (or a vault
// write) just because its creator record has already been removed.
fn session_event_route(session: Option<&LocalSession>, credential: bool) -> EventRoute<'_> {
    session.map_or(EventRoute::Drop, |session| session.event_route(credential))
}

/// Sets a flag for its lifetime; dropping it clears the flag.
pub(crate) struct InstallingFlag<'a>(&'a AtomicBool);

impl<'a> InstallingFlag<'a> {
    pub(crate) fn raise(flag: &'a AtomicBool) -> Self {
        flag.store(true, Ordering::SeqCst);
        Self(flag)
    }
}

impl Drop for InstallingFlag<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl LocalBrowserState {
    fn stop_frames(&self, session_id: &str) {
        self.frames.lock().remove(session_id);
    }

    fn stop_frame_subscription(&self, session_id: &str, subscription_id: Option<&str>) {
        let mut frames = self.frames.lock();
        if frames
            .get(session_id)
            .is_some_and(|(_, id, _)| subscription_id.is_none_or(|wanted| wanted == id))
        {
            frames.remove(session_id);
        }
    }

    fn frame_start_lane(&self, session_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut starts = self.frame_starts.lock();
        starts.retain(|_, lane| lane.strong_count() > 0);
        let lane = starts
            .get(session_id)
            .and_then(std::sync::Weak::upgrade)
            .unwrap_or_else(|| Arc::new(tokio::sync::Mutex::new(())));
        starts.insert(session_id.to_owned(), Arc::downgrade(&lane));
        lane
    }

    fn stop_all_frames(&self) {
        self.frames.lock().clear();
        for job in self.frame_cleanup.lock().drain(..) {
            job.abort();
        }
    }

    fn take_sessions(&self) -> Vec<(String, LocalSession)> {
        self.sessions.lock().drain().collect()
    }

    fn authorize_session(&self, session_id: &str, caller: &str, op: &str) -> Result<(), String> {
        self.sessions
            .lock()
            .get(session_id)
            .ok_or_else(|| "browser_session_not_found: session is not registered".to_string())?
            .authorize(caller, op)
    }

    fn is_document_viewer(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .get(session_id)
            .is_some_and(|session| session.purpose == Some(SessionPurpose::DocumentViewer))
    }

    fn session_create_failed(
        &self,
        session_id: &str,
        identity: &Arc<()>,
        error: &cognia_local_browser::client::ClientError,
    ) {
        let mut sessions = self.sessions.lock();
        let Some(session) = sessions.get(session_id) else {
            return;
        };
        if !Arc::ptr_eq(&session.creation_identity, identity) {
            return;
        }
        // A transport failure can hide a successful create. Keep its creator
        // binding until session.closed or runtime exit, so only that window
        // can recover/close the potentially live viewer.
        if session.purpose == Some(SessionPurpose::DocumentViewer)
            && matches!(
                error.code.as_str(),
                "runtime_unreachable" | "runtime_protocol_error"
            )
        {
            return;
        }
        sessions.remove(session_id);
    }
}

/// `browser_local_status` payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBrowserStatus {
    pub installed: bool,
    pub installing: bool,
    pub chromium_version: Option<String>,
    pub running: bool,
    pub runtime_staged: bool,
    pub error: Option<String>,
}

fn status(app: &AppHandle, state: &LocalBrowserState) -> LocalBrowserStatus {
    let runtime = runtime_dir(app);
    let installed = match (&runtime, browser_root(app)) {
        (Ok(runtime), Ok(root)) => installer::installed(&root.join("chromium"), runtime),
        _ => None,
    };
    let core = state.core.lock().clone();
    let running = core
        .as_ref()
        .is_some_and(|core| core.supervisor.is_running());
    let error = state
        .install_error
        .lock()
        .clone()
        .or_else(|| core.as_ref().and_then(|core| core.supervisor.last_error()));
    LocalBrowserStatus {
        installed: installed.is_some(),
        installing: state.installing.load(Ordering::SeqCst),
        chromium_version: installed.map(|installed| installed.version),
        running,
        runtime_staged: runtime.is_ok(),
        error,
    }
}

/// Build (once) the supervisor and transport.
fn core(app: &AppHandle, state: &LocalBrowserState) -> Result<Arc<LocalCore>, String> {
    let mut slot = state.core.lock();
    if let Some(core) = slot.as_ref() {
        return Ok(Arc::clone(core));
    }
    let runtime_dir = runtime_dir(app)?;
    let node = cognia_core::node_runtime::node_executable()
        .map_err(|error| format!("node_runtime_unavailable: {error}"))?;
    let root = browser_root(app)?;
    let config = SupervisorConfig::new(node, runtime_dir, &root);
    let browsers_path = config.browsers_path.clone();
    let events_app = app.clone();
    let supervisor = Supervisor::new(config, move |event| on_supervisor_event(&events_app, event));
    let client = RuntimeClient::new().map_err(|error| error.to_string())?;
    let transport = bridge::SupervisedTransport::new(client, Arc::clone(&supervisor));
    let core = Arc::new(LocalCore {
        browsers_path,
        supervisor,
        transport,
    });
    *slot = Some(Arc::clone(&core));
    Ok(core)
}

/// A process ended: its sessions are gone. Tell the renderer.
fn on_supervisor_event(app: &AppHandle, event: SupervisorEvent) {
    match &event {
        SupervisorEvent::Exited { .. } | SupervisorEvent::Failed { .. } => {
            log::warn!("local browser runtime: {event:?}");
            if let Some(state) = app.try_state::<LocalBrowserState>() {
                state.stop_all_frames();
                for (session_id, session) in state.take_sessions() {
                    emit_routed_event(
                        app,
                        json!({
                            "type": "session.closed",
                            "sessionId": session_id,
                            "reason": "runtime_exited",
                        }),
                        session.event_route(false),
                    );
                }
            }
        }
        SupervisorEvent::Started { generation } => {
            log::info!("local browser runtime started (generation {generation})");
        }
        SupervisorEvent::Stopped { .. } => {}
    }
}

pub(crate) fn emit_local_event(app: &AppHandle, payload: Value) {
    let session = payload
        .get("sessionId")
        .and_then(Value::as_str)
        .and_then(|id| {
            app.try_state::<LocalBrowserState>()?
                .sessions
                .lock()
                .get(id)
                .cloned()
        });
    let route = if payload.get("sessionId").and_then(Value::as_str).is_some() {
        session_event_route(session.as_ref(), false)
    } else {
        EventRoute::Broadcast
    };
    emit_routed_event(app, payload, route);
}

fn emit_routed_event(app: &AppHandle, payload: Value, route: EventRoute<'_>) {
    let result = match route {
        EventRoute::Broadcast => app.emit(LOCAL_EVENT, payload),
        EventRoute::Window(window) => app.emit_to(window, LOCAL_EVENT, payload),
        EventRoute::Drop => return,
    };
    if let Err(error) = result {
        log::debug!("emit {LOCAL_EVENT}: {error}");
    }
}

/// The `savedPath` of a `download.updated` event, if any.
fn reported_download_path(event: &Value) -> Option<PathBuf> {
    if event.get("type").and_then(Value::as_str) != Some("download.updated") {
        return None;
    }
    event
        .get("download")
        .unwrap_or(event)
        .get("savedPath")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

/// Route one journal event.
fn handle_bridge_event(app: &AppHandle, event: BridgeEvent) {
    match event {
        BridgeEvent::Forward(value) => {
            let session = value
                .get("sessionId")
                .and_then(Value::as_str)
                .and_then(|id| {
                    app.try_state::<LocalBrowserState>()?
                        .sessions
                        .lock()
                        .get(id)
                        .cloned()
                });
            if value.get("type").and_then(Value::as_str) == Some("session.closed") {
                if let (Some(state), Some(session_id)) = (
                    app.try_state::<LocalBrowserState>(),
                    value.get("sessionId").and_then(Value::as_str),
                ) {
                    state.sessions.lock().remove(session_id);
                    state.stop_frames(session_id);
                }
            }
            if let Some(path) = reported_download_path(&value) {
                crate::browser::downloads::remember_reported_download(app, &path);
            }
            let route = if value.get("sessionId").and_then(Value::as_str).is_some() {
                session_event_route(session.as_ref(), false)
            } else {
                EventRoute::Broadcast
            };
            emit_routed_event(app, value, route);
        }
        BridgeEvent::CredentialSubmitted {
            session_id,
            page_id,
            origin,
            username,
            password,
        } => {
            let session = session_id.as_deref().and_then(|id| {
                app.try_state::<LocalBrowserState>()?
                    .sessions
                    .lock()
                    .get(id)
                    .cloned()
            });
            let route = session_event_route(session.as_ref(), true);
            if route == EventRoute::Drop {
                return;
            }
            let pending_id = crate::browser::passwords::stash_pending(
                app,
                origin.clone(),
                username.clone(),
                password,
            );
            emit_routed_event(
                app,
                json!({
                    "type": "credential.submitted",
                    "sessionId": session_id,
                    "pageId": page_id,
                    "origin": origin,
                    "username": username,
                    "pendingId": pending_id,
                }),
                route,
            );
        }
    }
}

/// Start the runtime (idempotent) and the journal tailer.
async fn ensure_started(
    app: &AppHandle,
    state: &LocalBrowserState,
) -> Result<Arc<LocalCore>, String> {
    let core = core(app, state)?;
    core.supervisor
        .start()
        .await
        .map_err(|error| error.to_string())?;
    let mut events = state.events.lock();
    if events.is_none() {
        let (handle, stop) = bridge::stop_pair();
        let transport = core.transport.clone();
        let tail_app = app.clone();
        tauri::async_runtime::spawn(async move {
            bridge::run_event_tailer(
                &transport,
                |event| handle_bridge_event(&tail_app, event),
                stop,
                bridge::EventTailConfig::default(),
            )
            .await;
        });
        *events = Some(handle);
    }
    drop(events);
    Ok(core)
}

/// Stop frames, the tailer and the process.
async fn stop_runtime(app: &AppHandle, state: &LocalBrowserState) {
    state.stop_all_frames();
    state.events.lock().take();
    let core = state.core.lock().clone();
    if let Some(core) = core {
        core.supervisor.stop().await;
    }
    for (session_id, session) in state.take_sessions() {
        emit_routed_event(
            app,
            json!({"type": "session.closed", "sessionId": session_id, "reason": "runtime_stopped"}),
            session.event_route(false),
        );
    }
}

/// App-exit hook: stop the runtime so Chromium closes cleanly (children are
/// also `kill_on_drop`).
pub async fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<LocalBrowserState>() {
        stop_runtime(app, state.inner()).await;
    }
}

/// Lifecycle of the runtime as the managed-process registry reports it. Carries
/// no endpoint, so the bearer secret never leaves this module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LocalBrowserManagedPhase {
    Running,
    /// Crashed; the supervisor restarts it after a backoff.
    Restarting {
        attempt: u32,
    },
    /// Restarts exhausted (or start failed); only an explicit start recovers.
    Failed(String),
}

/// `process_registry` row source for the local browser runtime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LocalBrowserManagedInfo {
    pub pid: Option<u32>,
    /// `127.0.0.1:<port>` (or `[::1]:<port>`) while running.
    pub address: Option<String>,
    pub generation: Option<u64>,
    pub phase: LocalBrowserManagedPhase,
}

/// Map a supervisor phase to a registry row source. `Stopped` has no row.
fn managed_info_from(
    phase: &supervisor::Phase,
    pid: Option<u32>,
) -> Option<LocalBrowserManagedInfo> {
    match phase {
        supervisor::Phase::Stopped => None,
        supervisor::Phase::Running(endpoint) => Some(LocalBrowserManagedInfo {
            pid,
            address: Some(
                endpoint
                    .base_url
                    .trim_start_matches("http://")
                    .trim_start_matches("https://")
                    .to_string(),
            ),
            generation: Some(endpoint.generation),
            phase: LocalBrowserManagedPhase::Running,
        }),
        supervisor::Phase::Restarting { attempt } => Some(LocalBrowserManagedInfo {
            pid: None,
            address: None,
            generation: None,
            phase: LocalBrowserManagedPhase::Restarting { attempt: *attempt },
        }),
        supervisor::Phase::Failed(error) => Some(LocalBrowserManagedInfo {
            pid: None,
            address: None,
            generation: None,
            phase: LocalBrowserManagedPhase::Failed(error.clone()),
        }),
    }
}

/// Snapshot for the managed-process registry: `None` when the runtime was
/// never built or is stopped. Never holds a lock across an `.await`.
pub(crate) async fn managed_snapshot(app: &AppHandle) -> Option<LocalBrowserManagedInfo> {
    let state = app.try_state::<LocalBrowserState>()?;
    let core = state.core.lock().clone()?;
    managed_info_from(&core.supervisor.phase(), core.supervisor.pid())
}

/// Restart from the managed-process panel: stop (closing sessions) and start
/// again through the same path `browser_local_start` uses.
pub(crate) async fn restart(app: &AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<LocalBrowserState>()
        .ok_or_else(|| "local_browser_unavailable: state is not managed".to_string())?;
    stop_runtime(app, state.inner()).await;
    ensure_started(app, state.inner()).await.map(|_| ())
}

/// The runtime's endpoint for `browser.extensions.reload` after an extension
/// change, when it is running.
pub(crate) async fn reload_extensions(app: &AppHandle, extension_paths: Vec<String>) {
    let Some(state) = app.try_state::<LocalBrowserState>() else {
        return;
    };
    if !state
        .sessions
        .lock()
        .values()
        .any(|session| session.kind == bridge::SessionKind::Local && session.purpose.is_none())
    {
        return;
    }
    let core = state.core.lock().clone();
    let Some(core) = core.filter(|core| core.supervisor.is_running()) else {
        return;
    };
    if let Err(error) = core
        .transport
        .control(
            "browser.extensions.reload",
            json!({ "extensionPaths": extension_paths }),
        )
        .await
    {
        log::warn!("local browser extension reload failed: {error}");
    }
}

/// `<app_data>/browser/uploads`, the only directory a session may upload
/// from (created on demand).
fn uploads_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(browser_root(app)?.join("uploads"))
}

/// The session's upload roots: only the staging directory. Files elsewhere
/// reach a page only after the user picked them (`browser_local_stage_upload`).
fn upload_roots(uploads: &std::path::Path) -> Result<Vec<String>, String> {
    std::fs::create_dir_all(uploads)
        .map_err(|error| format!("uploads_dir_unavailable: {}: {error}", uploads.display()))?;
    Ok(vec![uploads.to_string_lossy().into_owned()])
}

/// The runtime's upload limits (`resolveLocalUploads`).
pub(crate) const MAX_UPLOAD_FILES: usize = 10;
pub(crate) const MAX_UPLOAD_FILE_BYTES: u64 = 100 * 1024 * 1024;
/// Staged copies older than this are removed on the next staging.
const STAGED_UPLOAD_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Copy the user-picked `sources` into `uploads`, each into its own fresh
/// subdirectory so the page sees the original file name and two picks never
/// collide. Returns the staged paths. Stale staging directories are pruned
/// first.
pub(crate) fn stage_uploads(
    uploads: &std::path::Path,
    sources: &[PathBuf],
) -> Result<Vec<PathBuf>, String> {
    if sources.len() > MAX_UPLOAD_FILES {
        return Err(format!(
            "browser_upload_invalid: at most {MAX_UPLOAD_FILES} files can be uploaded at once"
        ));
    }
    std::fs::create_dir_all(uploads)
        .map_err(|error| format!("uploads_dir_unavailable: {}: {error}", uploads.display()))?;
    prune_staged_uploads(uploads, STAGED_UPLOAD_TTL);
    for source in sources {
        let metadata = std::fs::metadata(source)
            .map_err(|error| format!("browser_upload_invalid: {}: {error}", source.display()))?;
        if !metadata.is_file() {
            return Err(format!(
                "browser_upload_invalid: {} is not a file",
                source.display()
            ));
        }
        if metadata.len() > MAX_UPLOAD_FILE_BYTES {
            return Err(format!(
                "browser_upload_invalid: {} is larger than 100 MB",
                source.display()
            ));
        }
    }
    let mut staged = Vec::with_capacity(sources.len());
    for source in sources {
        let name = source
            .file_name()
            .map(|name| {
                cognia_local_browser::local_files::sanitize_filename(&name.to_string_lossy())
            })
            .unwrap_or_else(|| "upload".to_string());
        let dir = uploads.join(uuid::Uuid::new_v4().simple().to_string());
        std::fs::create_dir(&dir)
            .map_err(|error| format!("uploads_dir_unavailable: {}: {error}", dir.display()))?;
        let target = dir.join(name);
        std::fs::copy(source, &target)
            .map_err(|error| format!("browser_upload_invalid: {}: {error}", source.display()))?;
        staged.push(target);
    }
    Ok(staged)
}

/// Remove staging subdirectories last modified more than `ttl` ago.
fn prune_staged_uploads(uploads: &std::path::Path, ttl: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(uploads) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > ttl);
        if !stale {
            continue;
        }
        let path = entry.path();
        let _ = if metadata.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
    }
}

/// Let the user pick files in a native picker and stage copies under
/// `<app_data>/browser/uploads` for `browser.files.set`. Returns the staged
/// paths (empty when the picker was cancelled).
#[tauri::command]
pub async fn browser_local_stage_upload(
    app: AppHandle,
    webview: tauri::Webview,
) -> Result<Vec<String>, String> {
    crate::browser::cookie_import::require_main_window(webview.label())?;
    let builder = {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file()
    };
    let picked = crate::browser::downloads::native_dialog::pick_files(builder).await;
    if picked.is_empty() {
        return Ok(Vec::new());
    }
    let uploads = uploads_dir(&app)?;
    let staged = tauri::async_runtime::spawn_blocking(move || stage_uploads(&uploads, &picked))
        .await
        .map_err(|error| error.to_string())??;
    Ok(staged
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

/// Resolve the host-owned session fields.
fn session_context(
    app: &AppHandle,
    core: &LocalCore,
    payload: &Value,
) -> Result<bridge::SessionCreateContext, String> {
    let kind = bridge::session_kind(payload).map_err(|error| error.to_string())?;
    let downloads_dir = crate::browser::downloads::current_downloads_dir(app)
        .to_string_lossy()
        .into_owned();
    let upload_roots = upload_roots(&uploads_dir(app)?)?;
    match kind {
        bridge::SessionKind::Local => {
            let runtime = runtime_dir(app)?;
            if installer::installed(&core.browsers_path, &runtime).is_none() {
                return Err(
                    "chromium_not_installed: install Chromium before opening a local session"
                        .into(),
                );
            }
            let extension_paths = if document_viewer::session_purpose(payload)
                .map_err(|error| error.to_string())?
                == Some(SessionPurpose::DocumentViewer)
            {
                Vec::new()
            } else {
                crate::browser::extensions::extension_store(app)?
                    .enabled_paths()
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect()
            };
            Ok(bridge::SessionCreateContext {
                downloads_dir,
                extension_paths,
                cdp_endpoint: None,
                upload_roots,
            })
        }
        bridge::SessionKind::UserChrome => {
            let browser = payload
                .get("browser")
                .and_then(Value::as_str)
                .unwrap_or("chrome");
            let endpoint =
                user_chrome::resolve_endpoint(browser).map_err(|error| error.to_string())?;
            Ok(bridge::SessionCreateContext {
                downloads_dir,
                extension_paths: Vec::new(),
                cdp_endpoint: Some(endpoint),
                upload_roots,
            })
        }
    }
}

async fn call(
    app: &AppHandle,
    state: &LocalBrowserState,
    op: &str,
    payload: Value,
    creator_window: &str,
) -> Result<Value, String> {
    let core = ensure_started(app, state).await?;
    let (payload, kind) = if op == "browser.session.create" {
        // Resolving the context reads the extension registry and creates the
        // uploads directory: blocking I/O, kept off the async workers.
        let context = {
            let app = app.clone();
            let core = Arc::clone(&core);
            let payload = payload.clone();
            tauri::async_runtime::spawn_blocking(move || session_context(&app, &core, &payload))
                .await
                .map_err(|error| error.to_string())??
        };
        let kind = bridge::session_kind(&payload).map_err(|error| error.to_string())?;
        let prepared =
            bridge::prepare_session_create(payload, &context).map_err(|error| error.to_string())?;
        (prepared, Some(kind))
    } else {
        (payload, None)
    };
    // Register before control: page/lifecycle events can precede its response.
    let creating_id = if let Some(kind) = kind {
        let id = payload
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "browser_session_option_invalid: session id is required".to_string())?
            .to_owned();
        let session = LocalSession {
            kind,
            purpose: document_viewer::session_purpose(&payload)
                .map_err(|error| error.to_string())?,
            creator_window: creator_window.to_owned(),
            creation_identity: Arc::new(()),
        };
        let identity = Arc::clone(&session.creation_identity);
        let mut sessions = state.sessions.lock();
        if sessions.contains_key(&id) {
            return Err("browser_session_exists: session exists".into());
        }
        sessions.insert(id.clone(), session);
        Some((id, identity))
    } else {
        if let Some(id) = payload.get("sessionId").and_then(Value::as_str) {
            state.authorize_session(id, creator_window, op)?;
        }
        None
    };
    let result = core.transport.control(op, payload.clone()).await;
    if let Err(error) = &result {
        if let Some((id, identity)) = creating_id {
            state.session_create_failed(&id, &identity, error);
        }
    } else if op == "browser.session.close" {
        if let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) {
            // The journal's session.closed consumes the creator record, so
            // its notification retains the targeted route after this reply.
            state.stop_frames(session_id);
        }
    }
    result.map_err(|error| error.to_string())
}

/// Rust-only access for value-carrying ops (`browser.cookies.set`,
/// `browser.credential.fill`). Document viewers remain creator-bound, and
/// clearing their reserved profile is a renderer-only user action.
pub async fn rpc_privileged(app: &AppHandle, op: &str, payload: Value) -> Result<Value, String> {
    if op == "browser.profile.delete"
        && payload
            .get("profileId")
            .and_then(Value::as_str)
            .is_some_and(document_viewer::is_document_viewer_profile)
    {
        return Err(
            "browser_profile_reserved: clear document browser data through the renderer".into(),
        );
    }
    let state = app
        .try_state::<LocalBrowserState>()
        .ok_or_else(|| "local_browser_unavailable: state is not managed".to_string())?;
    if let Some(id) = payload.get("sessionId").and_then(Value::as_str) {
        state.authorize_session(id, "", op)?;
    }
    let core = ensure_started(app, state.inner()).await?;
    core.transport
        .control(op, payload)
        .await
        .map_err(|error| error.to_string())
}

fn not_allowed(op: &str) -> String {
    format!("browser_op_not_allowed: {op} is not available to the renderer")
}

#[tauri::command]
pub async fn browser_local_status(
    app: AppHandle,
    state: State<'_, LocalBrowserState>,
) -> Result<LocalBrowserStatus, String> {
    Ok(status(&app, state.inner()))
}

#[tauri::command]
pub async fn browser_local_install(
    app: AppHandle,
    state: State<'_, LocalBrowserState>,
) -> Result<LocalBrowserStatus, String> {
    let Ok(_install) = state.install_lock.try_lock() else {
        return Err("install_in_progress: Chromium is already being installed".into());
    };
    let installing = InstallingFlag::raise(&state.installing);
    *state.install_error.lock() = None;
    let emit_app = app.clone();
    let result = async {
        let runtime = runtime_dir(&app)?;
        let node = cognia_core::node_runtime::node_executable()
            .map_err(|error| format!("node_runtime_unavailable: {error}"))?;
        let browsers = browser_root(&app)?.join("chromium");
        installer::install(&node, &runtime, &browsers, |progress| {
            let _ = emit_app.emit(INSTALL_EVENT, &progress);
        })
        .await
        .map_err(|error| error.to_string())
    }
    .await;
    drop(installing);
    if let Err(error) = &result {
        // The installer reports its own failures; errors before it ran
        // (nothing staged, no Node) are reported here.
        if error.starts_with("runtime_not_staged") || error.starts_with("node_runtime_unavailable")
        {
            let _ = app.emit(
                INSTALL_EVENT,
                installer::InstallProgress::phase(
                    installer::InstallPhase::Failed,
                    Some(error.clone()),
                ),
            );
        }
        *state.install_error.lock() = Some(error.clone());
    }
    Ok(status(&app, state.inner()))
}

#[tauri::command]
pub async fn browser_local_uninstall(
    app: AppHandle,
    state: State<'_, LocalBrowserState>,
) -> Result<LocalBrowserStatus, String> {
    // Held until the tree is gone, so an install cannot start mid-removal.
    let Ok(_install) = state.install_lock.try_lock() else {
        return Err("install_in_progress: wait for the install to finish".into());
    };
    stop_runtime(&app, state.inner()).await;
    let browsers = browser_root(&app)?.join("chromium");
    installer::uninstall_async(browsers)
        .await
        .map_err(|error| error.to_string())?;
    *state.install_error.lock() = None;
    Ok(status(&app, state.inner()))
}

#[tauri::command]
pub async fn browser_local_start(
    app: AppHandle,
    state: State<'_, LocalBrowserState>,
) -> Result<LocalBrowserStatus, String> {
    ensure_started(&app, state.inner()).await?;
    Ok(status(&app, state.inner()))
}

#[tauri::command]
pub async fn browser_local_stop(
    app: AppHandle,
    state: State<'_, LocalBrowserState>,
) -> Result<(), String> {
    stop_runtime(&app, state.inner()).await;
    Ok(())
}

#[tauri::command]
pub async fn browser_local_rpc(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, LocalBrowserState>,
    op: String,
    payload: Value,
) -> Result<Value, String> {
    if let Some(id) = payload.get("sessionId").and_then(Value::as_str) {
        state.authorize_session(id, window.label(), &op)?;
    }
    if !bridge::is_renderer_op(&op) {
        return Err(not_allowed(&op));
    }
    call(&app, state.inner(), &op, payload, window.label()).await
}

async fn begin_frame_subscription<T: RuntimeTransport + Clone + Send + Sync + 'static>(
    state: &LocalBrowserState,
    transport: T,
    session_id: &str,
    stream_id: &str,
) -> Result<(u64, bridge::StopSignal), String> {
    let document_viewer = state.is_document_viewer(session_id);
    let token = state.frame_tokens.fetch_add(1, Ordering::SeqCst);
    let (handle, mut stop) = bridge::stop_pair();
    state
        .frames
        .lock()
        .insert(session_id.to_owned(), (token, stream_id.to_owned(), handle));
    let start_lane = state.frame_start_lane(&session_id);
    let start_guard = tokio::select! {
        guard = start_lane.lock() => guard,
        _ = stop.cancelled() => return Err("frame subscription cancelled".into()),
    };
    if !state
        .frames
        .lock()
        .get(session_id)
        .is_some_and(|(owner, _, _)| *owner == token)
    {
        return Err("frame subscription superseded".into());
    }
    let started = tokio::select! {
        result = transport
        .control(
            "browser.screencast.start",
            json!({ "sessionId": session_id, "quality": 70, "streamId": stream_id }),
        )
        => result,
        _ = stop.cancelled() => Err(cognia_local_browser::client::ClientError::new("subscription_cancelled", "frame subscription cancelled")),
    };
    drop(start_guard);
    if let Err(error) = started {
        state.stop_frame_subscription(&session_id, Some(&stream_id));
        let session_id = session_id.to_owned();
        let stream_id = stream_id.to_owned();
        let cleanup = tokio::spawn(async move {
            retire_frame_consumer(&transport, &session_id, &stream_id, document_viewer).await
        });
        let mut jobs = state.frame_cleanup.lock();
        jobs.retain(|job| !job.is_finished());
        jobs.push(cleanup);
        return Err(error.to_string());
    }
    Ok((token, stop))
}

async fn retire_frame_consumer<T: RuntimeTransport>(
    transport: &T,
    session_id: &str,
    stream_id: &str,
    document_viewer: bool,
) {
    if document_viewer {
        bridge::retire_document_viewer_screencast(transport, session_id, stream_id).await;
    } else {
        bridge::retire_screencast(transport, session_id, stream_id).await;
    }
}

#[tauri::command]
pub async fn browser_local_frames_subscribe(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, LocalBrowserState>,
    session_id: String,
    channel: Channel<InvokeResponseBody>,
    subscription_id: Option<String>,
) -> Result<(), String> {
    state.authorize_session(&session_id, window.label(), "browser.screencast.start")?;
    let core = ensure_started(&app, state.inner()).await?;
    state.authorize_session(&session_id, window.label(), "browser.screencast.start")?;
    let stream_id = subscription_id.unwrap_or_else(|| {
        format!(
            "legacy-{}",
            state.frame_tokens.fetch_add(1, Ordering::SeqCst)
        )
    });
    if stream_id.is_empty() || stream_id.len() > 128 {
        return Err("invalid frame subscription identity".into());
    }
    let (token, stop) = begin_frame_subscription(
        state.inner(),
        core.transport.clone(),
        &session_id,
        &stream_id,
    )
    .await?;
    let transport = core.transport.clone();
    let poll_app = app.clone();
    let document_viewer = state.is_document_viewer(&session_id);
    tauri::async_runtime::spawn(async move {
        let end = bridge::run_frame_poller(
            &transport,
            &session_id,
            |bytes| channel.send(InvokeResponseBody::Raw(bytes)).is_ok(),
            stop,
            bridge::FramePollConfig::default(),
        )
        .await;
        log::debug!("local browser frames for {session_id} ended: {end:?}");
        if let Some(state) = poll_app.try_state::<LocalBrowserState>() {
            let mut frames = state.frames.lock();
            if frames
                .get(&session_id)
                .is_some_and(|(owner, _, _)| *owner == token)
            {
                frames.remove(&session_id);
            }
        }
        let reason = match end {
            bridge::FramePollEnd::Stopped => "stopped",
            bridge::FramePollEnd::SinkClosed => "sink-closed",
            bridge::FramePollEnd::RuntimeRestarted => "runtime-restarted",
            bridge::FramePollEnd::RuntimeFailed(_) => "runtime-failed",
        };
        let ended = json!({ "type": "ended", "subscriptionId": stream_id, "reason": reason });
        let _ = channel.send(InvokeResponseBody::Json(ended.to_string()));
        retire_frame_consumer(&transport, &session_id, &stream_id, document_viewer).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn browser_local_frames_unsubscribe(
    window: tauri::Window,
    state: State<'_, LocalBrowserState>,
    session_id: String,
    subscription_id: Option<String>,
) -> Result<(), String> {
    state.authorize_session(&session_id, window.label(), "browser.screencast.ack")?;
    state.stop_frame_subscription(&session_id, subscription_id.as_deref());
    Ok(())
}

#[tauri::command]
pub async fn browser_user_chrome_discover() -> Result<Vec<user_chrome::UserChromeCandidate>, String>
{
    tauri::async_runtime::spawn_blocking(user_chrome::discover)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_session(purpose: Option<SessionPurpose>) -> LocalSession {
        LocalSession {
            kind: bridge::SessionKind::Local,
            purpose,
            creator_window: "document-dock".into(),
            creation_identity: Arc::new(()),
        }
    }

    #[test]
    fn document_viewer_window_mismatch_refuses_rpc_and_frame_access() {
        let state = LocalBrowserState::default();
        state.sessions.lock().insert(
            "viewer".into(),
            test_session(Some(SessionPurpose::DocumentViewer)),
        );
        for op in [
            "browser.navigate",
            "browser.screencast.start",
            "browser.screencast.ack",
        ] {
            assert!(state
                .authorize_session("viewer", "document-dock", op)
                .is_ok());
            assert!(state
                .authorize_session("viewer", "other-window", op)
                .unwrap_err()
                .starts_with(document_viewer::DOCUMENT_VIEWER_WINDOW_MISMATCH));
        }
        assert!(state
            .authorize_session("viewer", "document-dock", "browser.evaluate")
            .unwrap_err()
            .starts_with(document_viewer::DOCUMENT_VIEWER_OP_REFUSED));
        let ordinary = test_session(None);
        assert!(ordinary
            .authorize("other-window", "browser.evaluate")
            .is_ok());
        assert!(state
            .authorize_session("unregistered", "other-window", "browser.screencast.start")
            .unwrap_err()
            .starts_with("browser_session_not_found"));
    }

    #[test]
    fn document_viewer_targeted_routing_survives_session_removal_and_runtime_exit() {
        let state = LocalBrowserState::default();
        state.sessions.lock().insert(
            "viewer".into(),
            test_session(Some(SessionPurpose::DocumentViewer)),
        );
        // The normal closed-event path snapshots its route before removing it.
        let record = state.sessions.lock().get("viewer").cloned();
        state.sessions.lock().remove("viewer");
        assert_eq!(
            session_event_route(record.as_ref(), false),
            EventRoute::Window("document-dock")
        );
        assert_eq!(session_event_route(record.as_ref(), true), EventRoute::Drop);
        assert_eq!(session_event_route(None, false), EventRoute::Drop);
        state
            .sessions
            .lock()
            .insert("viewer".into(), record.unwrap());
        let drained = state.take_sessions();
        assert_eq!(
            drained[0].1.event_route(false),
            EventRoute::Window("document-dock")
        );
        assert!(state.sessions.lock().is_empty());
        assert_eq!(test_session(None).event_route(false), EventRoute::Broadcast);
    }

    #[test]
    fn document_viewer_create_error_keeps_ambiguous_binding() {
        use cognia_local_browser::client::ClientError;
        let state = LocalBrowserState::default();
        let viewer = test_session(Some(SessionPurpose::DocumentViewer));
        let identity = Arc::clone(&viewer.creation_identity);
        state.sessions.lock().insert("viewer".into(), viewer);
        for code in ["runtime_unreachable", "runtime_protocol_error"] {
            state.session_create_failed("viewer", &identity, &ClientError::new(code, "lost reply"));
            assert!(state
                .authorize_session("viewer", "document-dock", "browser.session.close")
                .is_ok());
            assert!(state
                .authorize_session("viewer", "other-window", "browser.navigate")
                .is_err());
        }
        state.session_create_failed(
            "viewer",
            &identity,
            &ClientError::new("browser_profile_in_use", "in use"),
        );
        assert!(state.sessions.lock().is_empty());
        // A late failed create must not delete the replacement's binding.
        state.sessions.lock().insert(
            "viewer".into(),
            test_session(Some(SessionPurpose::DocumentViewer)),
        );
        state.session_create_failed(
            "viewer",
            &identity,
            &ClientError::new("browser_session_not_found", "closed"),
        );
        assert_eq!(state.sessions.lock().len(), 1);
    }

    #[derive(Clone, Default)]
    struct FrameStartTransport {
        generation: Arc<AtomicU64>,
        entered: Arc<tokio::sync::Notify>,
        fail_start: Arc<AtomicBool>,
        fail_stop: Arc<AtomicBool>,
        calls: Arc<Mutex<Vec<(String, Value)>>>,
    }

    impl RuntimeTransport for FrameStartTransport {
        fn generation(&self) -> Option<u64> {
            match self.generation.load(Ordering::SeqCst) {
                0 => None,
                value => Some(value),
            }
        }
        async fn control(
            &self,
            op: &str,
            payload: Value,
        ) -> Result<Value, cognia_local_browser::client::ClientError> {
            self.calls.lock().push((op.to_owned(), payload.clone()));
            if op == "browser.screencast.start" && self.fail_start.load(Ordering::SeqCst) {
                return Err(cognia_local_browser::client::ClientError::new(
                    "failed_start",
                    "start failed",
                ));
            }
            if op == "browser.screencast.start" && payload["streamId"] == "old" {
                self.entered.notify_one();
                std::future::pending::<()>().await;
            }
            if op == "browser.screencast.stop" && self.fail_stop.load(Ordering::SeqCst) {
                return Err(cognia_local_browser::client::ClientError::new(
                    "lost_stop",
                    "stop failed",
                ));
            }
            Ok(json!({"ok":true}))
        }
        async fn media(
            &self,
            _: &str,
            _: u64,
        ) -> Result<
            Option<cognia_local_browser::client::MediaFrame>,
            cognia_local_browser::client::ClientError,
        > {
            Ok(None)
        }
        async fn events(
            &self,
            _: u64,
        ) -> Result<Vec<Value>, cognia_local_browser::client::ClientError> {
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn production_frame_start_cancels_old_rpc_and_preserves_replacement() {
        let state = LocalBrowserState::default();
        let transport = FrameStartTransport::default();
        transport.generation.store(1, Ordering::SeqCst);
        let (old, ()) = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            tokio::join!(
                begin_frame_subscription(&state, transport.clone(), "a", "old"),
                async {
                    transport.entered.notified().await;
                    let (_, other) =
                        begin_frame_subscription(&state, transport.clone(), "b", "independent")
                            .await
                            .unwrap();
                    assert!(!other.is_stopped());
                    let (_, newer) =
                        begin_frame_subscription(&state, transport.clone(), "a", "new")
                            .await
                            .unwrap();
                    assert!(!newer.is_stopped());
                }
            )
        })
        .await
        .expect("a pending start cannot block its replacement or another session");
        assert!(old.is_err());
        assert_eq!(state.frames.lock().get("a").unwrap().1, "new");
        let jobs: Vec<_> = state.frame_cleanup.lock().drain(..).collect();
        for job in jobs {
            job.await.unwrap();
        }
        assert!(transport
            .calls
            .lock()
            .iter()
            .any(|(op, payload)| op == "browser.screencast.stop" && payload["streamId"] == "old"));
    }

    #[tokio::test]
    async fn production_start_failure_returns_while_retirement_remains_owned() {
        let state = LocalBrowserState::default();
        let transport = FrameStartTransport::default();
        transport.generation.store(1, Ordering::SeqCst);
        transport.fail_start.store(true, Ordering::SeqCst);
        transport.fail_stop.store(true, Ordering::SeqCst);
        let failed = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            begin_frame_subscription(&state, transport.clone(), "a", "failed"),
        )
        .await
        .expect("cleanup retry cannot hide a known start failure");
        assert!(failed.is_err());
        assert!(!state.frames.lock().contains_key("a"));
        assert_eq!(state.frame_cleanup.lock().len(), 1);
        transport.generation.store(0, Ordering::SeqCst);
        let jobs: Vec<_> = state.frame_cleanup.lock().drain(..).collect();
        for job in jobs {
            tokio::time::timeout(std::time::Duration::from_secs(1), job)
                .await
                .unwrap()
                .unwrap();
        }
    }

    #[test]
    fn the_installing_flag_resets_on_drop() {
        let flag = AtomicBool::new(false);
        {
            let _raised = InstallingFlag::raise(&flag);
            assert!(flag.load(Ordering::SeqCst));
        }
        assert!(!flag.load(Ordering::SeqCst));
        let result = std::panic::catch_unwind(|| {
            let _raised = InstallingFlag::raise(&flag);
            panic!("install failed");
        });
        assert!(result.is_err());
        assert!(
            !flag.load(Ordering::SeqCst),
            "a panic still clears the flag"
        );
    }

    #[tokio::test]
    async fn install_and_uninstall_share_one_lock() {
        let state = LocalBrowserState::default();
        let held = state.install_lock.try_lock().unwrap();
        assert!(state.install_lock.try_lock().is_err());
        drop(held);
        assert!(state.install_lock.try_lock().is_ok());
    }

    #[test]
    fn upload_roots_are_only_the_staging_dir() {
        let root = tempfile::tempdir().unwrap();
        let uploads = root.path().join("browser").join("uploads");
        assert_eq!(
            upload_roots(&uploads).unwrap(),
            vec![uploads.to_string_lossy().into_owned()]
        );
        assert!(uploads.is_dir());
    }

    #[test]
    fn staging_copies_picked_files_under_uploads() {
        let root = tempfile::tempdir().unwrap();
        let uploads = root.path().join("uploads");
        let picked = root.path().join("picked");
        std::fs::create_dir_all(&picked).unwrap();
        let a = picked.join("report.pdf");
        let b = picked.join("report.pdf.copy");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();
        let staged = stage_uploads(&uploads, &[a.clone(), a.clone(), b]).unwrap();
        assert_eq!(staged.len(), 3);
        for path in &staged {
            assert!(path.starts_with(&uploads), "{}", path.display());
        }
        assert_eq!(staged[0].file_name().unwrap(), "report.pdf");
        assert_ne!(staged[0], staged[1], "each pick lands in its own directory");
        assert_eq!(std::fs::read(&staged[1]).unwrap(), b"a");
        assert!(a.exists(), "the original stays in place");

        assert!(stage_uploads(&uploads, &[picked.clone()])
            .unwrap_err()
            .contains("not a file"));
        assert!(stage_uploads(&uploads, &[picked.join("missing")]).is_err());
        let too_many = vec![a; MAX_UPLOAD_FILES + 1];
        assert!(stage_uploads(&uploads, &too_many)
            .unwrap_err()
            .starts_with("browser_upload_invalid"));
    }

    #[test]
    fn stale_staging_dirs_are_pruned() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("f"), b"x").unwrap();
        prune_staged_uploads(root.path(), std::time::Duration::from_secs(3600));
        assert!(old.exists(), "fresh entries stay");
        std::thread::sleep(std::time::Duration::from_millis(20));
        prune_staged_uploads(root.path(), std::time::Duration::from_millis(1));
        assert!(!old.exists(), "stale entries go");
    }

    #[test]
    fn status_serializes_with_the_contract_keys() {
        let value = serde_json::to_value(LocalBrowserStatus {
            installed: true,
            installing: false,
            chromium_version: Some("153.0.8010.12".into()),
            running: false,
            runtime_staged: true,
            error: None,
        })
        .unwrap();
        assert_eq!(
            value,
            json!({
                "installed": true,
                "installing": false,
                "chromiumVersion": "153.0.8010.12",
                "running": false,
                "runtimeStaged": true,
                "error": null,
            })
        );
    }

    #[test]
    fn download_events_report_their_saved_path() {
        assert_eq!(
            reported_download_path(&json!({
                "type": "download.updated",
                "download": {"id": "d1", "savedPath": "/Users/u/Downloads/a.pdf"},
            })),
            Some(PathBuf::from("/Users/u/Downloads/a.pdf"))
        );
        assert_eq!(
            reported_download_path(&json!({"type": "download.updated", "savedPath": "/x"})),
            Some(PathBuf::from("/x"))
        );
        assert_eq!(
            reported_download_path(
                &json!({"type": "download.updated", "download": {"savedPath": ""}})
            ),
            None
        );
        assert_eq!(
            reported_download_path(&json!({"type": "pages.changed", "savedPath": "/x"})),
            None
        );
    }

    #[test]
    fn privileged_ops_are_refused_for_the_renderer() {
        for op in [
            "browser.cookies.set",
            "browser.credential.fill",
            "browser.extensions.reload",
            "browser.download.save",
        ] {
            assert!(!bridge::is_renderer_op(op));
            assert!(not_allowed(op).starts_with("browser_op_not_allowed"));
        }
        assert!(bridge::is_renderer_op("browser.navigate"));
    }

    #[test]
    fn managed_info_follows_the_supervisor_phase() {
        use cognia_local_browser::client::RuntimeEndpoint;
        assert_eq!(managed_info_from(&supervisor::Phase::Stopped, None), None);

        let running = managed_info_from(
            &supervisor::Phase::Running(RuntimeEndpoint {
                base_url: "http://127.0.0.1:51234".into(),
                secret: "s".repeat(64),
                generation: 3,
            }),
            Some(4242),
        )
        .unwrap();
        assert_eq!(running.pid, Some(4242));
        assert_eq!(running.address.as_deref(), Some("127.0.0.1:51234"));
        assert_eq!(running.generation, Some(3));
        assert_eq!(running.phase, LocalBrowserManagedPhase::Running);

        let restarting =
            managed_info_from(&supervisor::Phase::Restarting { attempt: 2 }, Some(1)).unwrap();
        assert_eq!(restarting.pid, None, "no live child while backing off");
        assert_eq!(
            restarting.phase,
            LocalBrowserManagedPhase::Restarting { attempt: 2 }
        );

        let failed = managed_info_from(&supervisor::Phase::Failed("boom".into()), None).unwrap();
        assert_eq!(
            failed.phase,
            LocalBrowserManagedPhase::Failed("boom".into())
        );
        assert_eq!(failed.address, None);
    }

    #[tokio::test]
    async fn pending_frame_starts_are_cancellable_and_do_not_block_another_session() {
        let state = LocalBrowserState::default();
        let first = state.frame_start_lane("a");
        assert!(Arc::ptr_eq(&first, &state.frame_start_lane("a")));
        let held = first.lock().await;
        assert!(state.frame_start_lane("b").try_lock().is_ok());
        let (handle, mut stop) = bridge::stop_pair();
        handle.stop();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            tokio::select! {
                _ = first.lock() => panic!("pending start should wait for its session"),
                _ = stop.cancelled() => {},
            }
        })
        .await
        .unwrap();
        drop(held);
        drop(first);
        state.frame_start_lane("c");
        assert_eq!(
            state.frame_starts.lock().len(),
            1,
            "finished sessions do not retain lane entries"
        );
    }

    #[test]
    fn state_tracks_sessions_and_frame_handles() {
        let state = LocalBrowserState::default();
        state
            .sessions
            .lock()
            .insert("s1".into(), test_session(None));
        state.sessions.lock().insert(
            "s2".into(),
            LocalSession {
                kind: bridge::SessionKind::UserChrome,
                ..test_session(None)
            },
        );
        let (handle, stop) = bridge::stop_pair();
        state
            .frames
            .lock()
            .insert("s1".into(), (1, "new".into(), handle));
        state.stop_frame_subscription("s1", Some("old"));
        assert!(
            !stop.is_stopped(),
            "a late unsubscribe cannot stop a newer stream"
        );
        state.stop_frames("s1");
        assert!(stop.is_stopped(), "unsubscribing stops the poller");
        let mut sessions: Vec<_> = state
            .take_sessions()
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        sessions.sort();
        assert_eq!(sessions, vec!["s1", "s2"]);
        assert!(state.take_sessions().is_empty());
    }
}
