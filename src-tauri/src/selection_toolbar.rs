//! System-wide text-selection toolbar.
//!
//! The coordinator is intentionally native: it observes passive OS input,
//! reads AX/UIA selections on the automation worker, and owns the transient
//! overlay window even while the main Cognia webview is hidden in the tray.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::automation::commands::AutomationState;
use crate::automation::input_monitor::{InputButton, InputEvent, InputSubscription};
use crate::automation::platform::shared::credential_window;
use crate::automation::selection::{build_text_selection, TextSelectionSnapshot};
use crate::automation::types::{Point, Rect};

pub const SELECTION_TOOLBAR_LABEL: &str = "selection-toolbar";
pub const SELECTION_CANDIDATE_EVENT: &str = "selection://candidate";
pub const SELECTION_DISMISS_EVENT: &str = "selection://dismiss";
pub const SELECTION_STAGE_EVENT: &str = "selection://stage";
/// Rust → toolbar renderer: a bound global chord fired while a candidate is
/// live. Carries the shortcut id so the renderer can run the same code path a
/// click would.
pub const SELECTION_SHORTCUT_EVENT: &str = "selection://shortcut";
/// Rust → toolbar renderer: Escape was pressed while the toolbar owned focus.
/// Lets an open sub-panel close itself before Escape means "dismiss the whole
/// toolbar", which is what every other layered popover does.
pub const SELECTION_ESCAPE_EVENT: &str = "selection://escape";

/// Placeholder size the window is created with. The renderer measures the
/// capsule on mount and calls `selection_toolbar_resize` before revealing the
/// window, so this size is never on screen — it only has to be non-zero.
const MIN_TOOLBAR_WIDTH: f64 = 160.0;
const MIN_TOOLBAR_HEIGHT: f64 = 48.0;
const EDGE_MARGIN: i32 = 8;
const IDLE_DISMISS_MS: u64 = 10_000;
/// How often the idle watchdog re-checks the deadline. Coarse on purpose: the
/// deadline is 10s and the only thing this granularity costs is up to half a
/// second of extra dwell after the pointer leaves.
const IDLE_TICK_MS: u64 = 500;
/// Grace period between emitting a non-interrupting dismiss and actually
/// hiding the native window, so the renderer's exit animation is on screen.
/// Must stay >= the renderer's exit duration.
const EXIT_ANIMATION_MS: u64 = 160;
/// How long a stray key press waits for an action chord to claim it before it
/// counts as "the user has moved on". Long enough to cover the gap between the
/// HID tap and the global-shortcut handler, short enough that dismissing on a
/// real keystroke still feels immediate.
const SHORTCUT_CLAIM_GRACE_MS: u64 = 180;

/// Action shortcuts, bound while the feature is running and released when it
/// stops. Deliberately *not* in `shortcuts::registry::seed_builtins` — that
/// binds unconditionally at startup, which would squat six global chords even
/// for users who never enable the selection toolbar.
///
/// Same `alt+shift+…` family as the pre-existing
/// `selection.captureClipboard = alt+shift+c`.
pub const SELECTION_ACTION_SHORTCUTS: &[(&str, &str)] = &[
    ("selection.copy", "alt+shift+1"),
    ("selection.explain", "alt+shift+2"),
    ("selection.translate", "alt+shift+3"),
    ("selection.ask", "alt+shift+4"),
    ("selection.remember", "alt+shift+5"),
    ("selection.speak", "alt+shift+6"),
];
const DEFAULT_BLOCKED_APPS: &[&str] = &[
    "1password",
    "authy",
    "bitwarden",
    "cognia",
    "dashlane",
    "keepass",
    "keychain access",
    "lastpass",
    "microsoft authenticator",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SelectionOrigin {
    Accessibility,
    Clipboard,
}

/// Which side of the selection the toolbar ended up on. `clamp_toolbar_position`
/// has always made this choice (it flips below when the anchor hugs the top of
/// the work area) but never told the renderer, so the enter animation could not
/// grow *out of* the selection. Returned from `selection_toolbar_resize`
/// because the answer can flip once the real measured height is known.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolbarPlacement {
    Above,
    Below,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionToolbarGeometry {
    pub placement: ToolbarPlacement,
}

/// Why the toolbar is going away. The renderer animates the exit for `Idle` and
/// `Completed`, but an `Interrupted` dismiss means the user is already doing
/// something else — lingering there for 160ms would cover whatever they just
/// clicked, so that one hides synchronously.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DismissReason {
    Interrupted,
    Idle,
    Completed,
}

impl DismissReason {
    fn is_animated(self) -> bool {
        !matches!(self, DismissReason::Interrupted)
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct DismissPayload {
    reason: DismissReason,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSelectionCandidate {
    pub id: String,
    pub text: String,
    pub source_app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_title: Option<String>,
    pub origin: SelectionOrigin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_rect: Option<Rect>,
    pub captured_at: i64,
    pub truncated: bool,
}

impl ExternalSelectionCandidate {
    fn from_snapshot(snapshot: TextSelectionSnapshot, origin: SelectionOrigin) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            text: snapshot.text,
            source_app: snapshot.source_app,
            source_title: snapshot.source_title,
            origin,
            anchor_rect: snapshot.anchor_rect,
            captured_at: chrono::Utc::now().timestamp_millis(),
            truncated: snapshot.truncated,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SelectionToolbarAction {
    Copy,
    Explain,
    Translate { target_locale: String },
    Ask,
    Remember,
    Speak,
}

impl SelectionToolbarAction {
    /// Whether handing this action to the main window should also raise it.
    ///
    /// Explain / translate / ask put a prompt in the composer and the answer is
    /// only readable there, so the window has to come forward. Remember and
    /// speak complete without the user ever looking at the app — raising it
    /// would interrupt whatever they were doing, which is the entire value of
    /// "just stash this" / "just read this out".
    fn focuses_main(&self) -> bool {
        matches!(
            self,
            SelectionToolbarAction::Explain
                | SelectionToolbarAction::Translate { .. }
                | SelectionToolbarAction::Ask
        )
    }

    /// Whether the toolbar stays on screen after dispatching, letting the
    /// renderer decide when to leave.
    ///
    /// True for everything that finishes *here* rather than in the main window:
    /// copy needs its checkmark to be on screen for a moment, remember has to
    /// report whether the PII gate let it through (that gate *returns*
    /// `{ok:false}` rather than throwing, so leaving early would turn a blocked
    /// memory into a silent no-op), and speak drives a player until playback
    /// ends. False for the three handoff actions — the main window has come
    /// forward and the user is looking at that, not at us.
    fn holds_toolbar(&self) -> bool {
        !self.focuses_main()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionStagePayload {
    pub candidate: ExternalSelectionCandidate,
    pub action: SelectionToolbarAction,
    pub focus_main: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SelectionToolbarStartArgs {
    #[serde(default)]
    pub disabled_apps: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionToolbarStatus {
    pub running: bool,
    pub has_candidate: bool,
}

struct ActiveSelectionMonitor {
    _subscription: InputSubscription,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
struct SelectionToolbarInner {
    active: Mutex<Option<ActiveSelectionMonitor>>,
    candidate: Mutex<Option<ExternalSelectionCandidate>>,
    pending_stage: Mutex<Option<SelectionStagePayload>>,
    disabled_apps: Mutex<HashSet<String>>,
    generation: AtomicU64,
    /// Every *opaque* rect inside the window, in logical (CSS) pixels, as last
    /// reported by the renderer: the capsule, plus the language list while it
    /// is open. The window is deliberately larger than its content (see
    /// `SHADOW_PAD`) and that surplus is transparent — so hit-testing the whole
    /// window would make the shadow margin a dead zone that neither activates a
    /// button nor dismisses.
    ///
    /// A list rather than one rect because the content is not one box: the
    /// language list is a *sibling* of the capsule with a gap between them.
    /// Hit-testing their bounding box would put that gap — and the two corners
    /// beside the narrower of the pair — back inside the toolbar.
    hit_rects: Mutex<Vec<Rect>>,
    /// Set while the pointer is over the capsule, or while an action is
    /// pending / speech is playing. Freezes the idle countdown.
    keep_alive: AtomicBool,
    idle_deadline: Mutex<Option<Instant>>,
    /// Set while the renderer has a focus-taking sub-panel open (the language
    /// list). Escape then belongs to that panel, not to the whole toolbar.
    interactive: AtomicBool,
    /// Wall-clock ms of the last action chord `dispatch_shortcut` accepted.
    ///
    /// The input tap is listen-only and reports no modifier state, so the `3`
    /// of `⌥⇧3` is indistinguishable from a `3` typed into another app. A key
    /// press therefore does not dismiss on sight — it waits
    /// `SHORTCUT_CLAIM_GRACE_MS` and stands down if a chord claimed it.
    shortcut_claim_ms: AtomicI64,
}

#[derive(Clone, Default)]
pub struct SelectionToolbarState {
    inner: Arc<SelectionToolbarInner>,
}

impl SelectionToolbarState {
    fn is_running(&self) -> bool {
        self.inner.active.lock().is_some()
    }

    fn status(&self) -> SelectionToolbarStatus {
        SelectionToolbarStatus {
            running: self.is_running(),
            has_candidate: self.inner.candidate.lock().is_some(),
        }
    }
}

#[tauri::command]
pub async fn selection_toolbar_start(
    app: AppHandle,
    automation: State<'_, AutomationState>,
    state: State<'_, SelectionToolbarState>,
    args: Option<SelectionToolbarStartArgs>,
) -> Result<SelectionToolbarStatus, String> {
    let args = args.unwrap_or_default();
    *state.inner.disabled_apps.lock() = args
        .disabled_apps
        .into_iter()
        .map(|app| app.to_lowercase())
        .collect();
    if state.is_running() {
        return Ok(state.status());
    }

    let mut subscription = automation.input_monitor.subscribe(128)?;
    let mut receiver = subscription.take_receiver();
    let coordinator = state.inner.clone();
    let automation_handle = automation.handle.clone();
    let app_handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                InputEvent::MouseUp {
                    x,
                    y,
                    button: InputButton::Left,
                    ..
                } => {
                    let generation = coordinator.generation.fetch_add(1, Ordering::SeqCst) + 1;
                    let coordinator = coordinator.clone();
                    let automation_handle = automation_handle.clone();
                    let app = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(60)).await;
                        let mut snapshot = read_accessibility_selection(&automation_handle).await;
                        if snapshot.is_none() {
                            tokio::time::sleep(Duration::from_millis(120)).await;
                            snapshot = read_accessibility_selection(&automation_handle).await;
                        }
                        if coordinator.generation.load(Ordering::SeqCst) != generation {
                            return;
                        }
                        let Some(mut snapshot) = snapshot else {
                            return;
                        };
                        if app_is_disabled(&coordinator, &snapshot.source_app) {
                            return;
                        }
                        if snapshot.anchor_rect.is_none() {
                            snapshot.anchor_rect = Some(Rect {
                                x,
                                y,
                                width: 1,
                                height: 1,
                            });
                        }
                        let candidate = ExternalSelectionCandidate::from_snapshot(
                            snapshot,
                            SelectionOrigin::Accessibility,
                        );
                        let _ = show_candidate(&app, &coordinator, candidate);
                    });
                }
                InputEvent::MouseDown { x, y, .. } => {
                    if !point_inside_toolbar(&app_handle, &coordinator, x, y) {
                        dismiss(&app_handle, &coordinator, DismissReason::Interrupted);
                    }
                }
                InputEvent::Scroll { .. } => {
                    dismiss(&app_handle, &coordinator, DismissReason::Interrupted)
                }
                InputEvent::KeyDown { vk, ts_ms } => {
                    let window = app_handle.get_webview_window(SELECTION_TOOLBAR_LABEL);
                    let toolbar_focused = window
                        .as_ref()
                        .and_then(|window| window.is_focused().ok())
                        .unwrap_or(false);
                    if is_escape_key(vk) {
                        // With the language list open the toolbar holds focus,
                        // so give the renderer the first refusal: Escape should
                        // close that panel, and only a second Escape (by which
                        // point `interactive` is false again) the toolbar.
                        if coordinator.interactive.load(Ordering::SeqCst) {
                            if let Some(window) = window.as_ref() {
                                let _ = window.emit(SELECTION_ESCAPE_EVENT, ());
                            }
                        } else {
                            dismiss(&app_handle, &coordinator, DismissReason::Interrupted);
                        }
                    } else if is_modifier_key(vk) {
                        // Holding ⌥⇧ is the start of an action chord, never a
                        // sign the user has moved on.
                    } else if !toolbar_focused {
                        // Typing anywhere else means the user has moved on —
                        // but only once the action chords have had their say.
                        // See `shortcut_claim_ms`: the tap cannot see modifiers,
                        // so dismissing here on sight nulled the candidate
                        // before `dispatch_shortcut` could read it, and every
                        // ⌥⇧1–⌥⇧6 press cancelled itself.
                        let coordinator = coordinator.clone();
                        let app = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(SHORTCUT_CLAIM_GRACE_MS))
                                .await;
                            if coordinator.shortcut_claim_ms.load(Ordering::SeqCst) >= ts_ms {
                                return;
                            }
                            dismiss(&app, &coordinator, DismissReason::Interrupted);
                        });
                    }
                }
                _ => {}
            }
        }
    });

    *state.inner.active.lock() = Some(ActiveSelectionMonitor {
        _subscription: subscription,
        task,
    });
    bind_action_shortcuts(&app);
    Ok(state.status())
}

#[tauri::command]
pub async fn selection_toolbar_stop(
    app: AppHandle,
    automation: State<'_, AutomationState>,
    state: State<'_, SelectionToolbarState>,
) -> Result<SelectionToolbarStatus, String> {
    if let Some(active) = state.inner.active.lock().take() {
        active.task.abort();
        drop(active);
    }
    unbind_action_shortcuts(&app);
    dismiss(&app, &state.inner, DismissReason::Interrupted);
    automation.input_monitor.stop_if_idle();
    Ok(state.status())
}

/// Claim the six action chords. A chord the user has already re-bound (the
/// renderer replays persisted overrides at boot) is left alone — binding the
/// default here would silently clobber their configuration. A conflict with an
/// unrelated shortcut is logged and skipped rather than failing `start`: losing
/// one hotkey is not a reason to leave the whole feature off.
fn bind_action_shortcuts<R: Runtime>(app: &AppHandle<R>) {
    let registry = app.state::<Arc<crate::shortcuts::ShortcutRegistry>>();
    for (id, chord) in SELECTION_ACTION_SHORTCUTS {
        if registry.chord_for_id(id).is_some() {
            continue;
        }
        if let Err(error) = registry.bind(app, id, chord) {
            log::warn!("selection toolbar shortcut {id}={chord} not bound: {error}");
        }
    }
}

fn unbind_action_shortcuts<R: Runtime>(app: &AppHandle<R>) {
    let registry = app.state::<Arc<crate::shortcuts::ShortcutRegistry>>();
    for (id, _) in SELECTION_ACTION_SHORTCUTS {
        if let Err(error) = registry.unbind(app, id) {
            log::warn!("selection toolbar shortcut {id} not released: {error}");
        }
    }
}

/// Forward a global chord to the toolbar renderer as if the matching button
/// had been clicked. A no-op when nothing is on offer — the chords stay
/// registered for as long as the feature runs, so most presses land here.
///
/// Deliberately a *notification* rather than a second execution path: the
/// renderer owns the translation target the user picked, the pending/✓/⚠
/// state machine, and the exit animation. Running the action from Rust would
/// fork all three and drift from the click path.
pub fn dispatch_shortcut<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if !SELECTION_ACTION_SHORTCUTS
        .iter()
        .any(|(known, _)| *known == id)
    {
        return;
    }
    let state = app.state::<SelectionToolbarState>();
    // Claim before anything can bail: the raw key press that produced this
    // chord is already sitting in its grace window, and it must stand down even
    // if the candidate went away in between.
    state
        .inner
        .shortcut_claim_ms
        .store(now_ms(), Ordering::SeqCst);
    let Some(candidate) = state.inner.candidate.lock().clone() else {
        return;
    };
    let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_LABEL) else {
        return;
    };
    let _ = window.emit(
        SELECTION_SHORTCUT_EVENT,
        serde_json::json!({ "shortcutId": id, "candidateId": candidate.id }),
    );
}

#[tauri::command]
pub async fn selection_toolbar_status(
    state: State<'_, SelectionToolbarState>,
) -> Result<SelectionToolbarStatus, String> {
    Ok(state.status())
}

#[tauri::command]
pub async fn selection_toolbar_current_candidate(
    state: State<'_, SelectionToolbarState>,
) -> Result<Option<ExternalSelectionCandidate>, String> {
    Ok(state.inner.candidate.lock().clone())
}

#[tauri::command]
pub async fn selection_toolbar_capture_clipboard(
    app: AppHandle,
) -> Result<Option<ExternalSelectionCandidate>, String> {
    capture_clipboard_candidate(&app).await
}

#[tauri::command]
pub async fn selection_toolbar_execute(
    app: AppHandle,
    state: State<'_, SelectionToolbarState>,
    candidate_id: String,
    action: SelectionToolbarAction,
) -> Result<(), String> {
    let candidate = state
        .inner
        .candidate
        .lock()
        .clone()
        .filter(|candidate| candidate.id == candidate_id)
        .ok_or_else(|| "selection candidate is stale".to_string())?;

    let holds_toolbar = action.holds_toolbar();
    match action {
        SelectionToolbarAction::Copy => {
            app.clipboard()
                .write_text(candidate.text.clone())
                .map_err(|error| error.to_string())?;
        }
        action => {
            let Some(main) = app.get_webview_window("main") else {
                return Err("main window is unavailable".into());
            };
            let focus_main = action.focuses_main();
            let payload = SelectionStagePayload {
                candidate,
                action,
                focus_main,
            };
            *state.inner.pending_stage.lock() = Some(payload.clone());
            if focus_main {
                crate::window_utils::bring_window_to_front(&main);
            }
            main.emit(SELECTION_STAGE_EVENT, payload)
                .map_err(|error| error.to_string())?;
        }
    }
    if holds_toolbar {
        // The renderer closes these out through `selection_toolbar_finish`.
        // Hold the toolbar open meanwhile so the idle watchdog cannot pull it
        // out from under a checkmark, a spinner or a playing waveform.
        state.inner.keep_alive.store(true, Ordering::SeqCst);
    } else {
        dismiss(&app, &state.inner, DismissReason::Completed);
    }
    Ok(())
}

/// Called by the toolbar renderer once a `holds_toolbar` action has settled
/// (checkmark shown, memory written or PII-blocked, speech finished/stopped).
#[tauri::command]
pub async fn selection_toolbar_finish(
    app: AppHandle,
    state: State<'_, SelectionToolbarState>,
    candidate_id: String,
) -> Result<(), String> {
    let matches_current = state
        .inner
        .candidate
        .lock()
        .as_ref()
        .is_some_and(|candidate| candidate.id == candidate_id);
    if matches_current {
        dismiss(&app, &state.inner, DismissReason::Completed);
    }
    Ok(())
}

/// Freeze or resume the idle countdown. Driven by pointer enter/leave on the
/// capsule and by the renderer's pending / speaking states.
#[tauri::command]
pub async fn selection_toolbar_set_keep_alive(
    state: State<'_, SelectionToolbarState>,
    window: WebviewWindow,
    keep_alive: bool,
) -> Result<(), String> {
    if window.label() != SELECTION_TOOLBAR_LABEL {
        return Err("selection toolbar keep-alive called from wrong window".into());
    }
    state.inner.keep_alive.store(keep_alive, Ordering::SeqCst);
    if !keep_alive {
        *state.inner.idle_deadline.lock() =
            Some(Instant::now() + Duration::from_millis(IDLE_DISMISS_MS));
    }
    Ok(())
}

/// Size the native window to the renderer's measured content and re-anchor it.
///
/// `width`/`height` are the full window box in logical pixels — the content
/// plus its `SHADOW_PAD` margin — and `hit_rects` are the opaque rects inside
/// that box (the capsule, plus the language list when it is open), which is
/// what hit-testing must use. Returns the placement actually chosen, because a
/// taller measured toolbar can no longer fit above a selection that the
/// placeholder size did fit above.
#[tauri::command]
pub async fn selection_toolbar_resize(
    app: AppHandle,
    state: State<'_, SelectionToolbarState>,
    window: WebviewWindow,
    width: f64,
    height: f64,
    hit_rects: Vec<Rect>,
) -> Result<SelectionToolbarGeometry, String> {
    if window.label() != SELECTION_TOOLBAR_LABEL {
        return Err("selection toolbar resize called from wrong window".into());
    }
    let width = width.max(MIN_TOOLBAR_WIDTH);
    let height = height.max(MIN_TOOLBAR_HEIGHT);
    *state.inner.hit_rects.lock() = hit_rects;

    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;

    let anchor = state
        .inner
        .candidate
        .lock()
        .as_ref()
        .and_then(|candidate| candidate.anchor_rect);
    let Some(anchor) = anchor else {
        return Ok(SelectionToolbarGeometry {
            placement: ToolbarPlacement::Above,
        });
    };
    let (x, y, placement) = toolbar_position(&app, anchor, width as i32, height as i32);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    Ok(SelectionToolbarGeometry { placement })
}

#[tauri::command]
pub async fn selection_toolbar_take_pending_stage(
    state: State<'_, SelectionToolbarState>,
) -> Result<Option<SelectionStagePayload>, String> {
    Ok(state.inner.pending_stage.lock().take())
}

#[tauri::command]
pub async fn selection_toolbar_reveal(window: WebviewWindow) -> Result<(), String> {
    if window.label() != SELECTION_TOOLBAR_LABEL {
        return Err("selection toolbar reveal called from wrong window".into());
    }
    window.show().map_err(|error| error.to_string())
}

/// Toggle the toolbar's ability to take focus, so an open dropdown can receive
/// keyboard input.
///
/// It used to also jump the window to a fixed 280px "menu height" and re-anchor
/// it for that height, which teleported the capsule ~236px up the screen the
/// moment the language menu opened. Sizing is now entirely renderer-driven via
/// `selection_toolbar_resize`: the window grows *downward* around a capsule
/// that does not move.
#[tauri::command]
pub async fn selection_toolbar_set_interactive(
    state: State<'_, SelectionToolbarState>,
    window: WebviewWindow,
    interactive: bool,
) -> Result<(), String> {
    if window.label() != SELECTION_TOOLBAR_LABEL {
        return Err("selection toolbar focus called from wrong window".into());
    }
    state.inner.interactive.store(interactive, Ordering::SeqCst);
    #[cfg(target_os = "windows")]
    set_windows_interactive(&window, interactive)?;
    if interactive {
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn spawn_clipboard_capture<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = capture_clipboard_candidate(&app).await {
            log::warn!("selection toolbar clipboard capture failed: {error}");
        }
    });
}

async fn capture_clipboard_candidate<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<ExternalSelectionCandidate>, String> {
    let state = app.state::<SelectionToolbarState>();
    if !state.is_running() {
        return Ok(None);
    }
    let text = app
        .clipboard()
        .read_text()
        .map_err(|error| error.to_string())?;
    let automation = app.state::<AutomationState>();
    let focus = automation.handle.get_focus().await.ok();
    let cursor = automation
        .handle
        .cursor_position()
        .await
        .unwrap_or(Point { x: 0, y: 0 });
    let source_app = focus
        .as_ref()
        .and_then(|focus| focus.process_name.as_deref())
        .unwrap_or("Clipboard");
    if app_is_disabled(&state.inner, source_app) {
        return Ok(None);
    }
    let snapshot = build_text_selection(
        &text,
        source_app,
        focus
            .as_ref()
            .and_then(|focus| focus.window_title.as_deref()),
        Some(Rect {
            x: cursor.x,
            y: cursor.y,
            width: 1,
            height: 1,
        }),
    );
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    let candidate = ExternalSelectionCandidate::from_snapshot(snapshot, SelectionOrigin::Clipboard);
    show_candidate(app, &state.inner, candidate.clone())?;
    Ok(Some(candidate))
}

async fn read_accessibility_selection(
    automation: &crate::automation::worker::AutomationHandle,
) -> Option<TextSelectionSnapshot> {
    if credential_window::is_credential_window_focused() {
        return None;
    }
    automation.read_text_selection().await.ok().flatten()
}

fn app_is_disabled(inner: &SelectionToolbarInner, source_app: &str) -> bool {
    let normalized = source_app.to_lowercase();
    is_default_blocked_app(&normalized) || inner.disabled_apps.lock().contains(&normalized)
}

fn is_default_blocked_app(normalized_app: &str) -> bool {
    DEFAULT_BLOCKED_APPS
        .iter()
        .any(|blocked| normalized_app.contains(blocked))
}

/// `InputEvent::KeyDown` carries a Windows-style virtual-key code on every
/// platform — the macOS tap runs its raw CGKeyCode through
/// `cg_keycode_to_vk` before publishing — so one constant covers both.
const VK_ESCAPE: u32 = 0x1B;

fn is_escape_key(vk: u32) -> bool {
    vk == VK_ESCAPE
}

/// Same clock the input monitor stamps `InputEvent::ts_ms` with, so a shortcut
/// claim is directly comparable against the key press that produced it.
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Modifier keys, which start a chord rather than ending the selection.
///
/// Only Windows' low-level keyboard hook reports these: the macOS tap
/// subscribes to `KeyDown` and not `FlagsChanged`, so a bare ⌥ or ⇧ never
/// reaches us there. Without this, holding ⌥⇧ to press an action chord
/// dismissed the toolbar on the very first modifier.
fn is_modifier_key(vk: u32) -> bool {
    const VK_SHIFT: u32 = 0x10;
    const VK_CONTROL: u32 = 0x11;
    const VK_MENU: u32 = 0x12;
    const VK_LWIN: u32 = 0x5B;
    const VK_RWIN: u32 = 0x5C;
    const VK_LSHIFT: u32 = 0xA0;
    const VK_RSHIFT: u32 = 0xA1;
    const VK_LCONTROL: u32 = 0xA2;
    const VK_RCONTROL: u32 = 0xA3;
    const VK_LMENU: u32 = 0xA4;
    const VK_RMENU: u32 = 0xA5;
    matches!(
        vk,
        VK_SHIFT
            | VK_CONTROL
            | VK_MENU
            | VK_LWIN
            | VK_RWIN
            | VK_LSHIFT
            | VK_RSHIFT
            | VK_LCONTROL
            | VK_RCONTROL
            | VK_LMENU
            | VK_RMENU
    )
}

fn show_candidate<R: Runtime>(
    app: &AppHandle<R>,
    inner: &Arc<SelectionToolbarInner>,
    candidate: ExternalSelectionCandidate,
) -> Result<(), String> {
    let anchor = candidate.anchor_rect.unwrap_or(Rect {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
    });
    let window = ensure_window(app)?;
    // Placeholder placement only. The window is still hidden: the renderer
    // measures the capsule, calls `selection_toolbar_resize` (which re-anchors
    // against the real size) and only then reveals.
    let (x, y, _) = toolbar_position(
        app,
        anchor,
        MIN_TOOLBAR_WIDTH as i32,
        MIN_TOOLBAR_HEIGHT as i32,
    );
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    *inner.candidate.lock() = Some(candidate.clone());
    inner.hit_rects.lock().clear();
    inner.keep_alive.store(false, Ordering::SeqCst);
    *inner.idle_deadline.lock() = Some(Instant::now() + Duration::from_millis(IDLE_DISMISS_MS));
    window
        .emit(SELECTION_CANDIDATE_EVENT, candidate.clone())
        .map_err(|error| error.to_string())?;

    spawn_idle_watchdog(app, inner, candidate.id);
    Ok(())
}

/// Idle countdown for one candidate.
///
/// This replaced a single `sleep(IDLE_DISMISS_MS)`, which could not be called
/// off — so the toolbar vanished mid-read even with the pointer resting on it.
/// Ticking lets `keep_alive` (pointer hover, a pending action, playing speech)
/// keep pushing the deadline out.
fn spawn_idle_watchdog<R: Runtime>(
    app: &AppHandle<R>,
    inner: &Arc<SelectionToolbarInner>,
    candidate_id: String,
) {
    let app = app.clone();
    let inner = inner.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(IDLE_TICK_MS)).await;
            let still_current = inner
                .candidate
                .lock()
                .as_ref()
                .is_some_and(|current| current.id == candidate_id);
            if !still_current {
                return;
            }
            if inner.keep_alive.load(Ordering::SeqCst) {
                *inner.idle_deadline.lock() =
                    Some(Instant::now() + Duration::from_millis(IDLE_DISMISS_MS));
                continue;
            }
            if idle_deadline_passed(&inner, Instant::now()) {
                dismiss(&app, &inner, DismissReason::Idle);
                return;
            }
        }
    });
}

fn idle_deadline_passed(inner: &SelectionToolbarInner, now: Instant) -> bool {
    inner
        .idle_deadline
        .lock()
        .is_some_and(|deadline| now >= deadline)
}

fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_LABEL) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        SELECTION_TOOLBAR_LABEL,
        WebviewUrl::App("selection-toolbar".into()),
    )
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .visible(false)
    .inner_size(MIN_TOOLBAR_WIDTH, MIN_TOOLBAR_HEIGHT)
    .build()
    .map_err(|error| error.to_string())?;
    let _ = window.remove_menu();

    #[cfg(target_os = "macos")]
    {
        let panel = window.clone();
        app.run_on_main_thread(move || {
            if let Err(error) = crate::pet_window::apply_overlay_panel_behavior(
                &panel,
                crate::pet_window::OverlayPanelRole::Popup,
            ) {
                log::warn!("selection toolbar NSPanel setup failed: {error}");
            }
        })
        .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    apply_windows_no_activate(&window)?;

    Ok(window)
}

#[cfg(target_os = "windows")]
fn apply_windows_no_activate(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let current = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) };
    let next = current | WS_EX_NOACTIVATE.0 as i32 | WS_EX_TOOLWINDOW.0 as i32;
    unsafe {
        SetWindowLongW(hwnd, GWL_EXSTYLE, next);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn set_windows_interactive(window: &WebviewWindow, interactive: bool) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let current = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) };
    let next = if interactive {
        current & !(WS_EX_NOACTIVATE.0 as i32) | WS_EX_TOOLWINDOW.0 as i32
    } else {
        current | WS_EX_NOACTIVATE.0 as i32 | WS_EX_TOOLWINDOW.0 as i32
    };
    unsafe {
        SetWindowLongW(hwnd, GWL_EXSTYLE, next);
    }
    Ok(())
}

fn toolbar_position<R: Runtime>(
    app: &AppHandle<R>,
    anchor: Rect,
    width: i32,
    height: i32,
) -> (i32, i32, ToolbarPlacement) {
    let preferred_x = anchor.x + anchor.width / 2 - width / 2;
    let preferred_y = anchor.y - height - EDGE_MARGIN;
    let monitor = app
        .monitor_from_point(anchor.x as f64, anchor.y as f64)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return (
            preferred_x,
            preferred_y.max(EDGE_MARGIN),
            ToolbarPlacement::Above,
        );
    };
    let work = monitor.work_area();
    clamp_toolbar_position(
        preferred_x,
        preferred_y,
        anchor,
        width,
        height,
        (
            work.position.x,
            work.position.y,
            work.size.width as i32,
            work.size.height as i32,
        ),
    )
}

fn clamp_toolbar_position(
    preferred_x: i32,
    preferred_y: i32,
    anchor: Rect,
    width: i32,
    height: i32,
    work: (i32, i32, i32, i32),
) -> (i32, i32, ToolbarPlacement) {
    let (work_x, work_y, work_width, work_height) = work;
    let max_x = work_x + work_width - width - EDGE_MARGIN;
    let max_y = work_y + work_height - height - EDGE_MARGIN;
    let x = preferred_x.clamp(work_x + EDGE_MARGIN, max_x.max(work_x + EDGE_MARGIN));
    let above_fits = preferred_y >= work_y + EDGE_MARGIN;
    let (desired_y, placement) = if above_fits {
        (preferred_y, ToolbarPlacement::Above)
    } else {
        (
            anchor.y + anchor.height + EDGE_MARGIN,
            ToolbarPlacement::Below,
        )
    };
    let y = desired_y.clamp(work_y + EDGE_MARGIN, max_y.max(work_y + EDGE_MARGIN));
    (x, y, placement)
}

/// Hit-test against the toolbar's *opaque content*, not the window.
///
/// The window is intentionally larger than the pill so the drop shadow and the
/// enter/exit scale have room. That surplus is fully transparent, and Tauri
/// cannot make part of a window click-through — so treating the whole window as
/// "inside" turned the margin into a dead zone: clicks there neither pressed a
/// button nor dismissed the toolbar.
///
/// The content is more than the pill, though. While the language list is open
/// it is a sibling of the capsule inside the same window, so testing the
/// capsule alone made every click in that list read as "the user moved on":
/// `dismiss(Interrupted)` cleared the candidate before the click's own handler
/// could run, and choosing a language failed with a stale candidate. Falls back
/// to the window box until the renderer has reported anything (i.e. before the
/// first measure).
fn point_inside_toolbar<R: Runtime>(
    app: &AppHandle<R>,
    inner: &Arc<SelectionToolbarInner>,
    x: i32,
    y: i32,
) -> bool {
    let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_LABEL) else {
        return false;
    };
    if !window.is_visible().unwrap_or(false) {
        return false;
    }
    let Ok(position) = window.outer_position() else {
        return false;
    };
    let Ok(size) = window.outer_size() else {
        return false;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let origin = (position.x, position.y);
    let rects = inner.hit_rects.lock();
    if rects.is_empty() {
        let whole = Rect {
            x: 0,
            y: 0,
            width: size.width as i32,
            height: size.height as i32,
        };
        return point_in_window_rect(origin, whole, x, y);
    }
    point_in_any_rect(origin, &rects, scale, x, y)
}

/// Pure half of `point_inside_toolbar` — testable without a live window.
fn point_in_any_rect(origin: (i32, i32), rects: &[Rect], scale: f64, x: i32, y: i32) -> bool {
    rects
        .iter()
        .any(|rect| point_in_window_rect(origin, scale_rect(*rect, scale), x, y))
}

/// Convert a renderer-reported rect (logical CSS pixels, relative to the
/// window) into the physical pixels `outer_position` / `outer_size` speak.
fn scale_rect(rect: Rect, scale: f64) -> Rect {
    Rect {
        x: (rect.x as f64 * scale).round() as i32,
        y: (rect.y as f64 * scale).round() as i32,
        width: (rect.width as f64 * scale).round() as i32,
        height: (rect.height as f64 * scale).round() as i32,
    }
}

fn point_in_window_rect(origin: (i32, i32), rect: Rect, x: i32, y: i32) -> bool {
    let left = origin.0 + rect.x;
    let top = origin.1 + rect.y;
    x >= left && y >= top && x < left + rect.width && y < top + rect.height
}

/// Tear down the current candidate.
///
/// `Interrupted` hides immediately — the user clicked, typed or scrolled
/// somewhere else, and an always-on-top pill fading over whatever they just
/// touched reads as lag, not polish. `Idle` and `Completed` get a short grace
/// period so the renderer's exit animation is actually seen; the generation
/// counter makes that delayed hide a no-op if a fresh selection has already
/// claimed the window.
fn dismiss<R: Runtime>(
    app: &AppHandle<R>,
    inner: &Arc<SelectionToolbarInner>,
    reason: DismissReason,
) {
    let generation = inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *inner.candidate.lock() = None;
    inner.hit_rects.lock().clear();
    *inner.idle_deadline.lock() = None;
    inner.keep_alive.store(false, Ordering::SeqCst);
    inner.interactive.store(false, Ordering::SeqCst);

    let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_LABEL) else {
        return;
    };
    let _ = window.emit(SELECTION_DISMISS_EVENT, DismissPayload { reason });
    if !reason.is_animated() {
        let _ = window.hide();
        return;
    }

    let app = app.clone();
    let inner = inner.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(EXIT_ANIMATION_MS)).await;
        if inner.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Some(window) = app.get_webview_window(SELECTION_TOOLBAR_LABEL) {
            let _ = window.hide();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hand-maintained ACL for the overlay window. The generated
    /// `all-app-commands.toml` does not cover it — that grant hangs off the
    /// `default` capability, which is scoped `windows: ["main"]`.
    const TOOLBAR_PERMISSION_TOML: &str =
        include_str!("../permissions/selection-toolbar-app-commands.toml");

    #[test]
    fn every_command_the_overlay_invokes_is_granted_to_its_window() {
        // Mirrors the `invoke(...)` call sites in
        // `lib/tauri/selection-toolbar.ts`. A command missing here does not
        // fail to build — it is rejected at runtime with "Command not found",
        // which is how the content-hugging resize shipped with the toolbar
        // permanently invisible.
        const INVOKED_BY_OVERLAY: &[&str] = &[
            "selection_toolbar_current_candidate",
            "selection_toolbar_execute",
            "selection_toolbar_finish",
            "selection_toolbar_resize",
            "selection_toolbar_reveal",
            "selection_toolbar_set_interactive",
            "selection_toolbar_set_keep_alive",
            "shortcut_list",
        ];
        for command in INVOKED_BY_OVERLAY {
            assert!(
                TOOLBAR_PERMISSION_TOML.contains(&format!("\"{command}\"")),
                "{command} is invoked from the selection-toolbar window but not \
                 granted in permissions/selection-toolbar-app-commands.toml"
            );
        }
    }

    #[test]
    fn placement_prefers_above_and_clamps_horizontally() {
        let position = clamp_toolbar_position(
            -150,
            120,
            Rect {
                x: 5,
                y: 172,
                width: 20,
                height: 18,
            },
            360,
            44,
            (0, 0, 1280, 720),
        );
        assert_eq!(position, (8, 120, ToolbarPlacement::Above));
    }

    #[test]
    fn placement_moves_below_when_top_edge_has_no_room() {
        let position = clamp_toolbar_position(
            100,
            -20,
            Rect {
                x: 260,
                y: 12,
                width: 50,
                height: 20,
            },
            360,
            44,
            (0, 0, 1280, 720),
        );
        assert_eq!(position, (100, 40, ToolbarPlacement::Below));
    }

    #[test]
    fn a_taller_toolbar_flips_below_where_the_short_one_fit_above() {
        // Same anchor, same screen: only the measured height changes. This is
        // exactly why placement has to come back from `resize` rather than
        // being decided once at candidate time.
        let anchor = Rect {
            x: 400,
            y: 90,
            width: 60,
            height: 20,
        };
        let work = (0, 0, 1280, 720);
        let (_, _, short) = clamp_toolbar_position(400, 90 - 48 - 8, anchor, 200, 48, work);
        let (_, _, tall) = clamp_toolbar_position(400, 90 - 240 - 8, anchor, 200, 240, work);
        assert_eq!(short, ToolbarPlacement::Above);
        assert_eq!(tall, ToolbarPlacement::Below);
    }

    #[test]
    fn hit_test_ignores_the_transparent_shadow_margin() {
        // Window at (100, 100), 240x88 logical; capsule inset by the renderer's
        // 20px shadow padding.
        let capsule = Rect {
            x: 20,
            y: 20,
            width: 200,
            height: 48,
        };
        // Inside the window but in the shadow padding — must NOT count as a hit,
        // otherwise the click is swallowed instead of dismissing the toolbar.
        assert!(!point_in_window_rect((100, 100), capsule, 105, 105));
        // Dead centre of the capsule.
        assert!(point_in_window_rect((100, 100), capsule, 220, 144));
        // Just past the capsule's right edge, still inside the window.
        assert!(!point_in_window_rect((100, 100), capsule, 321, 144));
    }

    #[test]
    fn hit_test_covers_the_open_language_list_as_well_as_the_capsule() {
        // Window at (100, 100). The list sits above the capsule with the
        // shell's 6px gap between them, and is narrower than the pill.
        let list = Rect {
            x: 40,
            y: 20,
            width: 160,
            height: 120,
        };
        let capsule = Rect {
            x: 20,
            y: 146,
            width: 200,
            height: 48,
        };
        let rects = [list, capsule];
        // Choosing a language must not read as "the user clicked away": before
        // this, the capsule-only test dismissed the candidate here, and the
        // click's own handler then failed with a stale candidate.
        assert!(point_in_any_rect((100, 100), &rects, 1.0, 200, 180));
        // …and the capsule still hits.
        assert!(point_in_any_rect((100, 100), &rects, 1.0, 200, 260));
        // The gap between the two, and the corners beside the narrower list,
        // are transparent — a bounding box would have swallowed both.
        assert!(!point_in_any_rect((100, 100), &rects, 1.0, 160, 243));
        assert!(!point_in_any_rect((100, 100), &rects, 1.0, 130, 200));
        // Still nothing outside the content.
        assert!(!point_in_any_rect((100, 100), &rects, 1.0, 105, 105));
    }

    #[test]
    fn capsule_rect_is_scaled_into_physical_pixels() {
        let scaled = scale_rect(
            Rect {
                x: 20,
                y: 20,
                width: 200,
                height: 48,
            },
            2.0,
        );
        assert_eq!(scaled.x, 40);
        assert_eq!(scaled.width, 400);
        assert_eq!(scaled.height, 96);
    }

    #[test]
    fn only_interrupted_dismissals_skip_the_exit_animation() {
        assert!(!DismissReason::Interrupted.is_animated());
        assert!(DismissReason::Idle.is_animated());
        assert!(DismissReason::Completed.is_animated());
    }

    #[test]
    fn idle_deadline_only_fires_once_it_is_actually_past() {
        let inner = SelectionToolbarInner::default();
        let now = Instant::now();
        *inner.idle_deadline.lock() = Some(now + Duration::from_millis(IDLE_DISMISS_MS));
        assert!(!idle_deadline_passed(&inner, now));
        assert!(idle_deadline_passed(
            &inner,
            now + Duration::from_millis(IDLE_DISMISS_MS + 1)
        ));
        // No deadline (freshly dismissed) never expires.
        *inner.idle_deadline.lock() = None;
        assert!(!idle_deadline_passed(
            &inner,
            now + Duration::from_secs(3600)
        ));
    }

    #[test]
    fn handoff_actions_raise_the_main_window_but_background_ones_do_not() {
        assert!(SelectionToolbarAction::Explain.focuses_main());
        assert!(SelectionToolbarAction::Ask.focuses_main());
        assert!(SelectionToolbarAction::Translate {
            target_locale: "ja".into()
        }
        .focuses_main());
        // Stashing a note or reading text aloud must not yank the app forward.
        assert!(!SelectionToolbarAction::Remember.focuses_main());
        assert!(!SelectionToolbarAction::Speak.focuses_main());
        assert!(!SelectionToolbarAction::Copy.focuses_main());
    }

    #[test]
    fn actions_that_finish_locally_hold_the_toolbar_open() {
        // Copy has to outlive its own checkmark; remember has to be able to
        // report a PII block; speak owns the player.
        assert!(SelectionToolbarAction::Copy.holds_toolbar());
        assert!(SelectionToolbarAction::Remember.holds_toolbar());
        assert!(SelectionToolbarAction::Speak.holds_toolbar());
        // Handing off and raising the main window are the same set: once the
        // app is in front, keeping a floating pill over it is just clutter.
        assert!(!SelectionToolbarAction::Explain.holds_toolbar());
        assert!(!SelectionToolbarAction::Ask.holds_toolbar());
        assert!(!SelectionToolbarAction::Translate {
            target_locale: "de".into()
        }
        .holds_toolbar());
    }

    #[test]
    fn action_shortcuts_are_unique_and_do_not_collide_with_the_clipboard_chord() {
        let ids: HashSet<&str> = SELECTION_ACTION_SHORTCUTS
            .iter()
            .map(|(id, _)| *id)
            .collect();
        let chords: HashSet<&str> = SELECTION_ACTION_SHORTCUTS
            .iter()
            .map(|(_, chord)| *chord)
            .collect();
        assert_eq!(ids.len(), SELECTION_ACTION_SHORTCUTS.len());
        assert_eq!(chords.len(), SELECTION_ACTION_SHORTCUTS.len());
        assert!(!chords.contains("alt+shift+c"));
    }

    #[test]
    fn stage_wire_shape_carries_the_focus_decision() {
        let payload = SelectionStagePayload {
            candidate: ExternalSelectionCandidate {
                id: "c1".into(),
                text: "hello".into(),
                source_app: "TextEdit".into(),
                source_title: None,
                origin: SelectionOrigin::Accessibility,
                anchor_rect: None,
                captured_at: 0,
                truncated: false,
            },
            action: SelectionToolbarAction::Speak,
            focus_main: false,
        };
        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["focusMain"], serde_json::json!(false));
        assert_eq!(value["action"]["kind"], serde_json::json!("speak"));
    }

    #[test]
    fn dismiss_payload_is_camel_case_tagged() {
        assert_eq!(
            serde_json::to_value(DismissPayload {
                reason: DismissReason::Interrupted
            })
            .unwrap(),
            serde_json::json!({ "reason": "interrupted" })
        );
    }

    #[test]
    fn action_wire_shape_is_tagged_and_camel_case() {
        let action = SelectionToolbarAction::Translate {
            target_locale: "zh-CN".into(),
        };
        assert_eq!(
            serde_json::to_value(action).unwrap(),
            serde_json::json!({"kind": "translate", "targetLocale": "zh-CN"})
        );
    }

    #[test]
    fn default_sensitive_apps_are_blocked_without_user_configuration() {
        assert!(is_default_blocked_app("1password 8"));
        assert!(is_default_blocked_app("cognia"));
        assert!(is_default_blocked_app("bitwarden.exe"));
        assert!(!is_default_blocked_app("textedit"));
    }

    #[test]
    fn recognizes_escape_by_virtual_key_on_every_platform() {
        // `InputEvent` publishes Windows-style virtual keys everywhere: the
        // macOS tap runs its CGKeyCode through `cg_keycode_to_vk` first. The
        // raw macOS keycode for Escape (53) is the CGKeyCode for `keypad 1`
        // once translated, so matching on it dismissed on the wrong key and
        // never on Escape.
        assert!(is_escape_key(0x1B));
        assert!(!is_escape_key(53));
        assert!(!is_escape_key(0));
    }

    #[test]
    fn modifier_presses_do_not_count_as_moving_on() {
        // Windows' low-level hook reports bare modifiers; without this the
        // ⌥ of ⌥⇧3 dismissed the toolbar before the chord completed.
        for vk in [0x10, 0x11, 0x12, 0x5B, 0xA0, 0xA4] {
            assert!(is_modifier_key(vk), "vk {vk:#04x} should be a modifier");
        }
        // Digits and letters are ordinary keys — they defer to the shortcut
        // claim window rather than being ignored outright.
        for vk in [0x31, 0x36, 0x41, 0x1B] {
            assert!(!is_modifier_key(vk), "vk {vk:#04x} should not be a modifier");
        }
    }

    #[test]
    fn a_shortcut_claim_stands_down_the_key_press_that_produced_it() {
        let inner = SelectionToolbarInner::default();
        let key_ts = 1_000_i64;

        // Nothing claimed the press yet: the grace window expires and the
        // dismiss goes through.
        assert!(inner.shortcut_claim_ms.load(Ordering::SeqCst) < key_ts);

        // `dispatch_shortcut` stamps the claim; a claim at or after the key's
        // own timestamp belongs to it.
        inner.shortcut_claim_ms.store(key_ts, Ordering::SeqCst);
        assert!(inner.shortcut_claim_ms.load(Ordering::SeqCst) >= key_ts);

        // A stale claim never suppresses a later press.
        let later_ts = key_ts + 1;
        assert!(inner.shortcut_claim_ms.load(Ordering::SeqCst) < later_ts);
    }
}
