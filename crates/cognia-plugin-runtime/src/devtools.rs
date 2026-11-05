//! Plugin devtools Tauri commands: the filesystem watcher behind the in-app
//! plugin file watch (`lib/plugin/devtools/file-watch.ts`).
//!
//! They are registered unconditionally. An earlier version of this comment
//! claimed they were `debug_assertions`-gated, which was never true of the
//! code.
//!
//! `plugin_dev_server_start` / `plugin_dev_server_stop` used to live here.
//! They set an in-memory `running` flag and returned: no port was bound and no
//! server existed, while the renderer built a `getUrl()` / `getWebSocketUrl()`
//! / `connectedClients` API on top of them. `plugin_reload` also went, since
//! the `plugin-hot-reload:<id>` event it emitted had exactly one listener and
//! that module is gone. Reloading is now the verified cli-bridge round-trip in
//! `lib/cli-bridge/handlers/plugin-dev-reload.ts`. `plugin_dev_server_watch` /
//! `plugin_dev_server_unwatch` and `plugin_list_dev_plugins` went later for
//! the same reason: their only caller was the deleted `dev-server.ts`.
//!
//! ADR 0016 P1-7 (2026-05-17) — `plugin_watch_start` holds a real
//! `notify::RecommendedWatcher` instead of a stub `Vec<PathBuf>`. Filesystem
//! events emit `plugin:file-change` with the payload shape `file-watch.ts`
//! expects.

// Without `tauri-host` the commands compile out (ADR-0196), leaving imports
// and helpers only they use; the feature build still lints all of them.
#![cfg_attr(not(feature = "tauri-host"), allow(dead_code, unused_imports))]

use std::path::{Path, PathBuf};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
#[cfg(feature = "tauri-host")]
use tauri::{AppHandle, Emitter};

use super::{PluginError, Result};

/// The watcher `plugin_watch_start` created, and the paths it watches.
struct WatcherState {
    /// Dropping it stops the underlying file-system event stream.
    watcher: Option<RecommendedWatcher>,
    paths: Vec<PathBuf>,
}

static WATCHERS: once_cell::sync::Lazy<Mutex<WatcherState>> = once_cell::sync::Lazy::new(|| {
    Mutex::new(WatcherState {
        watcher: None,
        paths: Vec::new(),
    })
});

/// Test-only accessor: number of currently-watched paths.
#[cfg(test)]
fn watched_path_count() -> usize {
    WATCHERS.lock().paths.len()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangePayload {
    /// "create" | "modify" | "delete" | "rename". Matches the type union in
    /// `lib/plugin/devtools/file-watch.ts`.
    #[serde(rename = "type")]
    pub kind: String,
    pub path: String,
    /// Milliseconds since UNIX epoch when the watcher saw the change.
    /// Diagnostic only: the renderer orders and debounces changes itself.
    pub timestamp: u64,
}

impl FileChangePayload {
    fn from_event(event: &notify::Event) -> Vec<Self> {
        let kind = match event.kind {
            notify::EventKind::Create(_) => "create",
            notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => "rename",
            notify::EventKind::Modify(_) => "modify",
            notify::EventKind::Remove(_) => "delete",
            _ => "modify",
        };
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        event
            .paths
            .iter()
            .map(|p| Self {
                kind: kind.into(),
                path: p.to_string_lossy().into_owned(),
                timestamp,
            })
            .collect()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStartArgs {
    pub paths: Vec<String>,
}

/// Watch `args.paths`, replacing whatever an earlier call watched.
#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn plugin_watch_start(app: AppHandle, args: WatchStartArgs) -> Result<()> {
    if args.paths.is_empty() {
        return Ok(());
    }
    let watcher = start_watcher(&app, args.paths.clone())?;
    let mut state = WATCHERS.lock();
    state.watcher = Some(watcher);
    state.paths = args.paths.into_iter().map(PathBuf::from).collect();
    Ok(())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn plugin_watch_stop() -> Result<()> {
    let mut state = WATCHERS.lock();
    // Dropping the watcher stops the underlying file-system event stream.
    state.watcher = None;
    state.paths.clear();
    Ok(())
}

// ---- helpers ----------------------------------------------------------------

#[cfg(feature = "tauri-host")]
/// Create a `notify::RecommendedWatcher` that emits `plugin:file-change`
/// events on the given Tauri app. Each filesystem event is converted into one
/// or more `FileChangePayload` entries and broadcast to the renderer.
fn start_watcher(app: &AppHandle, paths: Vec<String>) -> Result<RecommendedWatcher> {
    let app_for_watcher = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            for payload in FileChangePayload::from_event(&event) {
                let _ = app_for_watcher.emit("plugin:file-change", payload);
            }
        }
    })
    .map_err(|e| PluginError::Internal(format!("notify init failed: {e}")))?;
    for path in paths {
        watcher
            .watch(Path::new(&path), RecursiveMode::Recursive)
            .map_err(|e| PluginError::Internal(format!("watch start failed for {path}: {e}")))?;
    }
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_kind_from_create_event() {
        let event = notify::Event {
            kind: notify::EventKind::Create(notify::event::CreateKind::File),
            paths: vec![std::path::PathBuf::from("/tmp/x")],
            attrs: notify::event::EventAttributes::default(),
        };
        let payloads = FileChangePayload::from_event(&event);
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].kind, "create");
        assert!(payloads[0].path.ends_with("x"));
        assert!(payloads[0].timestamp > 0);
    }

    #[test]
    fn payload_kind_from_modify_event() {
        let event = notify::Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Any),
            paths: vec![std::path::PathBuf::from("/tmp/y")],
            attrs: notify::event::EventAttributes::default(),
        };
        let payloads = FileChangePayload::from_event(&event);
        assert_eq!(payloads[0].kind, "modify");
    }

    #[test]
    fn payload_kind_from_remove_event() {
        let event = notify::Event {
            kind: notify::EventKind::Remove(notify::event::RemoveKind::Any),
            paths: vec![std::path::PathBuf::from("/tmp/z")],
            attrs: notify::event::EventAttributes::default(),
        };
        let payloads = FileChangePayload::from_event(&event);
        assert_eq!(payloads[0].kind, "delete");
    }

    #[test]
    fn payload_kind_from_rename_event_is_rename_not_modify() {
        // notify reports renames as Modify(Name(...)); the TS contract
        // distinguishes "rename" from "modify" so we must map separately.
        let event = notify::Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::To,
            )),
            paths: vec![std::path::PathBuf::from("/tmp/w")],
            attrs: notify::event::EventAttributes::default(),
        };
        let payloads = FileChangePayload::from_event(&event);
        assert_eq!(payloads[0].kind, "rename");
    }

    #[tokio::test]
    async fn watch_stop_clears_the_watcher() {
        // Build state directly — we can't construct a real AppHandle in unit
        // tests, but the stop path only touches the WATCHERS mutex.
        {
            let mut state = WATCHERS.lock();
            state.paths.push(PathBuf::from("/tmp/a"));
            state.paths.push(PathBuf::from("/tmp/b"));
            // We can't construct a RecommendedWatcher without notify init,
            // but the watcher only matters for the side effect of dropping —
            // leaving it None is fine for this test.
        }
        assert_eq!(watched_path_count(), 2);
        plugin_watch_stop().await.unwrap();
        assert_eq!(watched_path_count(), 0);
    }
}
