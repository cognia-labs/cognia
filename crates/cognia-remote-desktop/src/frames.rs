//! Native frame data plane (ADR-0234 N2). No registry of desktops lives here:
//! providers resolve their owners' live resources, and pollers exist only while
//! viewers are attached. Capture/codec work belongs to the owning provider.
use crate::{
    audit,
    bridge::MAX_FRAME_BYTES,
    error::{RemoteDesktopError, Result},
    session::Principal,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::{sync::watch, task::JoinHandle};

pub const HUMAN_INTERVAL: Duration = Duration::from_millis(143);
pub const OBSERVER_INTERVAL: Duration = Duration::from_millis(500);
pub const IDLE_INTERVAL: Duration = Duration::from_secs(2);
pub const IDENTICAL_BACKOFF: u32 = 4;
pub const FRAME_PROOFS_PER_PRINCIPAL: usize = 64;
/// One capture may not outlive the input proof it registers.
pub const CAPTURE_TIMEOUT: Duration = Duration::from_secs(3);
/// Consecutive non-authorization failures tolerated before the stream ends.
pub const TRANSIENT_FAILURES: u32 = 5;
pub const JPEG_QUALITIES: [u8; 4] = [70, 50, 35, 20];
pub const HEADER_BYTES: usize = 64;
pub const MAGIC: [u8; 4] = *b"CGFR";
pub const VERSION: u8 = 1;
pub const JPEG: u8 = 1;
pub const UNCHANGED: u8 = 2;
pub type FrameFuture<T> = Pin<Box<dyn Future<Output = Result<T>> + Send>>;

pub fn invalid() -> RemoteDesktopError {
    RemoteDesktopError::new("remote_desktop_frame_invalid")
}
pub fn native_kind(id: &str) -> Option<&str> {
    id.split_once(':')
        .and_then(|(kind, _)| matches!(kind, "sandbox" | "managed-desktop").then_some(kind))
}
pub fn refuse_native_mutation(id: &str) -> Result<()> {
    if native_kind(id).is_some() {
        Err(RemoteDesktopError::new("remote_desktop_native_read_only"))
    } else {
        Ok(())
    }
}
pub fn interval(human: bool, identical: u32) -> Duration {
    if identical >= IDENTICAL_BACKOFF {
        IDLE_INTERVAL
    } else if human {
        HUMAN_INTERVAL
    } else {
        OBSERVER_INTERVAL
    }
}

/// Fixed network-endian header. Width/height are the original input coordinate
/// extent (the registered proof); JPEG pixels may be downscaled to fit the cap.
/// Layout: magic:4, version:u8, encoding:u8, headerSize:u16, payloadSize:u32,
/// width:u32, height:u32, reserved:u32, fence:u64, capturedAtMs:u64,
/// frameId:16 UUID bytes, reserved:8. Reserved bytes must be zero.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameHeader {
    pub frame_id: uuid::Uuid,
    pub fence: u64,
    pub width: u32,
    pub height: u32,
    pub captured_at_ms: u64,
    pub payload_bytes: u32,
    pub encoding: u8,
}
impl FrameHeader {
    pub fn encode(&self) -> Result<[u8; HEADER_BYTES]> {
        if self.width == 0
            || self.height == 0
            || !matches!(
                (self.encoding, self.payload_bytes),
                (JPEG, 1..) | (UNCHANGED, 0)
            )
            || self.payload_bytes as usize > MAX_FRAME_BYTES - HEADER_BYTES
        {
            return Err(invalid());
        }
        let mut bytes = [0; HEADER_BYTES];
        bytes[..4].copy_from_slice(&MAGIC);
        bytes[4] = VERSION;
        bytes[5] = self.encoding;
        bytes[6..8].copy_from_slice(&(HEADER_BYTES as u16).to_be_bytes());
        bytes[8..12].copy_from_slice(&self.payload_bytes.to_be_bytes());
        bytes[12..16].copy_from_slice(&self.width.to_be_bytes());
        bytes[16..20].copy_from_slice(&self.height.to_be_bytes());
        bytes[24..32].copy_from_slice(&self.fence.to_be_bytes());
        bytes[32..40].copy_from_slice(&self.captured_at_ms.to_be_bytes());
        bytes[40..56].copy_from_slice(self.frame_id.as_bytes());
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < HEADER_BYTES
            || bytes[..4] != MAGIC
            || bytes[4] != VERSION
            || !matches!(bytes[5], JPEG | UNCHANGED)
            || bytes[6..8] != (HEADER_BYTES as u16).to_be_bytes()
            || bytes[20..24] != [0; 4]
            || bytes[56..64] != [0; 8]
        {
            return Err(invalid());
        }
        let header = Self {
            encoding: bytes[5],
            frame_id: uuid::Uuid::from_slice(&bytes[40..56]).map_err(|_| invalid())?,
            fence: u64::from_be_bytes(bytes[24..32].try_into().map_err(|_| invalid())?),
            captured_at_ms: u64::from_be_bytes(bytes[32..40].try_into().map_err(|_| invalid())?),
            width: u32::from_be_bytes(bytes[12..16].try_into().map_err(|_| invalid())?),
            height: u32::from_be_bytes(bytes[16..20].try_into().map_err(|_| invalid())?),
            payload_bytes: u32::from_be_bytes(bytes[8..12].try_into().map_err(|_| invalid())?),
        };
        header.encode()?;
        Ok(header)
    }
}

/// Restore one frame boundary from the existing transport's byte pipe.
pub async fn read_frame(reader: &mut (impl tokio::io::AsyncRead + Unpin)) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut header = [0; HEADER_BYTES];
    reader
        .read_exact(&mut header)
        .await
        .map_err(|_| RemoteDesktopError::new("remote_desktop_connection_lost"))?;
    let decoded = FrameHeader::decode(&header)?;
    let mut bytes = vec![0; HEADER_BYTES + decoded.payload_bytes as usize];
    bytes[..HEADER_BYTES].copy_from_slice(&header);
    reader
        .read_exact(&mut bytes[HEADER_BYTES..])
        .await
        .map_err(|_| RemoteDesktopError::new("remote_desktop_connection_lost"))?;
    Ok(bytes)
}

/// One viewer's positive authority, reused for at most the broker's own
/// re-admission period ([`crate::session::ADMISSION_INTERVAL`]), so a 7 Hz
/// stream does not repeat pairing-store queries every tick. A failure clears
/// it; a revoked viewer stops receiving frames within that period plus a tick.
#[derive(Default)]
pub struct AdmissionCache {
    verified_at: Mutex<Option<std::time::Instant>>,
}
impl AdmissionCache {
    pub fn fresh(&self) -> bool {
        self.verified_at
            .lock()
            .is_some_and(|at| at.elapsed() < crate::session::ADMISSION_INTERVAL)
    }
    pub fn mark(&self) {
        *self.verified_at.lock() = Some(std::time::Instant::now());
    }
    pub fn clear(&self) {
        *self.verified_at.lock() = None;
    }
}

/// Run a synchronous authority check (pairing-store queries) off the async
/// runtime.
pub async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| RemoteDesktopError::new("remote_desktop_native_unavailable"))?
}

/// Pixels/codec stay with the capture owner, avoiding a desktop/codec dependency
/// in this platform crate. Implementations hash decoded pixels, not timestamps.
pub trait FrameImage: Send + Sync + 'static {
    fn dimensions(&self) -> (u32, u32);
    fn hash(&self) -> [u8; 32];
    fn jpeg(&self, quality: u8, width: u32, height: u32) -> Result<Vec<u8>>;
}
pub struct CapturedFrame {
    pub frame_id: String,
    pub fence: u64,
    pub captured_at_ms: u64,
    pub human_controlled: bool,
    pub image: Arc<dyn FrameImage>,
}
/// Capture performs the same live owner/authority checks as the frame RPC,
/// before and after awaiting capture. It never acquires/renews control.
pub trait FrameSource: Send + Sync + 'static {
    /// Live authorization only: never captures, acquires or renews control.
    fn authorize(&self) -> FrameFuture<()>;
    fn capture(&self) -> FrameFuture<CapturedFrame>;
}
pub trait NativeFrameProvider: Send + Sync + 'static {
    /// Owner-filtered live resources, never persisted in the target store.
    fn list(&self, principal: Principal) -> FrameFuture<Vec<NativeTargetSummary>>;
    fn resolve(&self, id: String, principal: Principal) -> FrameFuture<Arc<dyn FrameSource>>;
    fn acquire_input(
        &self,
        _id: String,
        _principal: Principal,
        _takeover: bool,
    ) -> FrameFuture<Arc<dyn NativeInputSink>> {
        Box::pin(async { Err(RemoteDesktopError::new("remote_desktop_forbidden")) })
    }
}

pub struct NativeTargetSummary {
    /// The owning service's connection id; the Host adds the registered kind.
    pub id: String,
    pub label: String,
    pub provider: NativeProviderKind,
    pub selkies: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeProviderKind {
    Docker,
    E2b,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativePoint {
    pub x: i32,
    pub y: i32,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeButton {
    Left,
    Middle,
    Right,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeDragOptions {
    pub button: Option<NativeButton>,
    pub duration_ms: Option<u32>,
    pub steps: Option<u32>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeScrollOptions {
    #[serde(default)]
    pub dx: i32,
    #[serde(default)]
    pub dy: i32,
}
/// Exactly the local viewer's public control vocabulary. No held input or
/// internal control RPC names cross the data channel.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum NativeUiAction {
    Click {
        button: Option<NativeButton>,
        count: Option<u32>,
    },
    Drag {
        to: NativePoint,
        #[serde(default)]
        opts: NativeDragOptions,
    },
    Scroll {
        #[serde(default)]
        opts: NativeScrollOptions,
    },
    PressKey {
        chord: String,
    },
    TypeText {
        text: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeInput {
    pub point: Option<NativePoint>,
    pub action: NativeUiAction,
    pub frame_id: String,
}
pub const MAX_INPUT_BYTES: usize = 32 * 1024;
/// Bound teardown even when the owning provider stops responding.
const INPUT_RELEASE_TIMEOUT: Duration = Duration::from_secs(5);
#[derive(Clone, Debug)]
pub struct NativeInputError {
    pub error: RemoteDesktopError,
    pub fatal: bool,
}
pub type NativeInputResult<T> = std::result::Result<T, NativeInputError>;
pub type NativeInputFuture = Pin<Box<dyn Future<Output = NativeInputResult<()>> + Send>>;
impl NativeInputError {
    pub fn fatal(error: RemoteDesktopError) -> Self {
        Self { error, fatal: true }
    }
    pub fn refused(code: &'static str) -> Self {
        Self {
            error: RemoteDesktopError::new(code),
            fatal: false,
        }
    }
    /// One classification boundary; never copy provider detail or input content.
    pub fn managed(code: &str) -> Self {
        match code {
            "managed_desktop_control_stale_frame" => {
                Self::refused("remote_desktop_input_stale_frame")
            }
            "managed_desktop_control_input_limit" | "managed_desktop_invalid_request" => {
                Self::refused("remote_desktop_input_invalid")
            }
            "managed_desktop_control_target_unverified"
            | "managed_desktop_control_policy_unavailable"
            | "managed_desktop_control_kill_switch" => Self::fatal(RemoteDesktopError::new(
                "remote_desktop_input_policy_denied",
            )),
            "managed_desktop_control_policy_denied" | "managed_desktop_control_policy_changed" => {
                Self::refused("remote_desktop_input_policy_denied")
            }
            "managed_desktop_control_consent_denied"
            | "managed_desktop_control_consent_required" => {
                Self::refused("remote_desktop_input_consent_required")
            }
            "managed_desktop_control_lease_expired" | "managed_desktop_stale_generation" => {
                Self::fatal(RemoteDesktopError::new("remote_desktop_control_expired"))
            }
            "managed_desktop_forbidden"
            | "managed_desktop_account_required"
            | "managed_desktop_control_admin_lease_expired" => {
                Self::fatal(RemoteDesktopError::new("remote_desktop_forbidden"))
            }
            _ => Self::fatal(RemoteDesktopError::new("remote_desktop_native_unavailable")),
        }
    }
}
/// Length-delimited UTF-8 JSON survives relay chunks and WebSocket boundaries.
pub async fn read_input(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
) -> NativeInputResult<Option<NativeInput>> {
    use tokio::io::AsyncReadExt;
    let size = match reader.read_u32().await {
        Ok(size) => size as usize,
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(_) => return Err(NativeInputError::fatal(invalid())),
    };
    if size > MAX_INPUT_BYTES {
        return Err(NativeInputError::fatal(invalid()));
    }
    if size == 0 {
        return Err(NativeInputError::refused("remote_desktop_input_invalid"));
    }
    let mut bytes = vec![0; size];
    reader
        .read_exact(&mut bytes)
        .await
        .map_err(|_| NativeInputError::fatal(invalid()))?;
    let input: NativeInput = serde_json::from_slice(&bytes)
        .map_err(|_| NativeInputError::refused("remote_desktop_input_invalid"))?;
    uuid::Uuid::parse_str(&input.frame_id)
        .map_err(|_| NativeInputError::refused("remote_desktop_input_invalid"))?;
    Ok(Some(input))
}
/// One already-acquired owner lease. Implementations re-admit each operation
/// and call the same control entry points used by the local viewer.
pub trait NativeInputSink: Send + Sync + 'static {
    fn fence(&self) -> u64;
    fn input(&self, input: NativeInput) -> NativeInputFuture;
    fn renew(&self) -> FrameFuture<()>;
    fn release(&self) -> FrameFuture<()>;
}
/// A single owned worker serializes input/renewal and releases on the last
/// sender's drop, including failed opens, broker revocation and aborted tasks.
#[derive(Clone)]
pub struct NativeInputLease {
    pub fence: u64,
    sender: tokio::sync::mpsc::Sender<(
        NativeInput,
        tokio::sync::oneshot::Sender<NativeInputResult<()>>,
    )>,
    pub released: watch::Receiver<Option<Result<()>>>,
    _closed: watch::Sender<()>,
}
impl NativeInputLease {
    pub fn new(sink: Arc<dyn NativeInputSink>) -> Self {
        let fence = sink.fence();
        let (sender, mut receiver) = tokio::sync::mpsc::channel::<(
            NativeInput,
            tokio::sync::oneshot::Sender<NativeInputResult<()>>,
        )>(1);
        let (done, released) = watch::channel(None);
        let (closed, mut closing) = watch::channel(());
        tokio::spawn(async move {
            let mut renew = tokio::time::interval(Duration::from_secs(5));
            renew.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            renew.tick().await;
            'worker: loop {
                tokio::select! {
                    command = receiver.recv() => match command {
                        Some((input, reply)) => {
                            let work = sink.input(input);
                            tokio::pin!(work);
                            let result = loop {
                                tokio::select! {
                                    result = &mut work => break result,
                                    _ = renew.tick() => {
                                        tokio::select! {
                                            result = &mut work => break result,
                                            result = sink.renew() => if let Err(error) = result {
                                                break Err(NativeInputError::fatal(error));
                                            },
                                            _ = closing.changed() => break 'worker,
                                        }
                                    },
                                    _ = closing.changed() => break 'worker,
                                }
                            };
                            let failed = result.as_ref().is_err_and(|error| error.fatal);
                            let _ = reply.send(result);
                            if failed { break; }
                        }
                        None => break,
                    },
                    _ = renew.tick() => {
                        tokio::select! {
                            result = sink.renew() => if result.is_err() { break; },
                            _ = closing.changed() => break,
                        }
                    },
                    _ = closing.changed() => break,
                }
            }
            let result = tokio::time::timeout(INPUT_RELEASE_TIMEOUT, sink.release())
                .await
                .unwrap_or_else(|_| {
                    Err(RemoteDesktopError::new(
                        "remote_desktop_control_release_timeout",
                    ))
                });
            let _ = done.send(Some(result));
        });
        Self {
            fence,
            sender,
            released,
            _closed: closed,
        }
    }
    pub async fn input(&self, input: NativeInput) -> NativeInputResult<()> {
        let (reply, result) = tokio::sync::oneshot::channel();
        self.sender
            .send((input, reply))
            .await
            .map_err(|_| NativeInputError::fatal(invalid()))?;
        result
            .await
            .map_err(|_| NativeInputError::fatal(invalid()))?
    }
}

/// Quality falls first, then dimensions. Original coordinates remain in header.
pub fn encode_frame(frame: &CapturedFrame) -> Result<Vec<u8>> {
    let (source_width, source_height) = frame.image.dimensions();
    if source_width == 0 || source_height == 0 {
        return Err(invalid());
    }
    let (mut width, mut height) = (source_width, source_height);
    loop {
        for quality in JPEG_QUALITIES {
            let jpeg = frame.image.jpeg(quality, width, height)?;
            if jpeg.len() <= MAX_FRAME_BYTES - HEADER_BYTES {
                let header = FrameHeader {
                    frame_id: uuid::Uuid::parse_str(&frame.frame_id).map_err(|_| invalid())?,
                    fence: frame.fence,
                    width: source_width,
                    height: source_height,
                    captured_at_ms: frame.captured_at_ms,
                    payload_bytes: jpeg.len() as u32,
                    encoding: JPEG,
                };
                let mut bytes = header.encode()?.to_vec();
                bytes.extend(jpeg);
                return Ok(bytes);
            }
        }
        if width == 1 && height == 1 {
            return Err(RemoteDesktopError::new("remote_desktop_frame_too_large"));
        }
        width = (width / 2).max(1);
        height = (height / 2).max(1);
    }
}

struct PublishedFrame {
    header: FrameHeader,
    jpeg: Arc<Vec<u8>>,
    revision: u64,
}
type Delivery = Option<Result<Arc<PublishedFrame>>>;
#[derive(Default)]
pub struct FrameHub {
    pollers: Mutex<BTreeMap<String, Arc<Poller>>>,
}
struct Viewer {
    source: Arc<dyn FrameSource>,
    sender: watch::Sender<Delivery>,
}
struct Poller {
    target: String,
    viewers: Mutex<BTreeMap<u64, Viewer>>,
    task: Mutex<Option<JoinHandle<()>>>,
}
impl Drop for Poller {
    fn drop(&mut self) {
        if let Some(task) = self.task.get_mut().take() {
            task.abort();
        }
    }
}
pub struct FrameSubscription {
    receiver: watch::Receiver<Delivery>,
    hub: Weak<FrameHub>,
    target: String,
    viewer: u64,
    revision: Option<u64>,
}
impl FrameSubscription {
    pub async fn next(&mut self) -> Result<Arc<Vec<u8>>> {
        self.receiver
            .changed()
            .await
            .map_err(|_| RemoteDesktopError::new("remote_desktop_connection_lost"))?;
        let frame = self
            .receiver
            .borrow_and_update()
            .clone()
            .ok_or_else(invalid)??;
        let unchanged = self.revision == Some(frame.revision);
        let mut header = frame.header.clone();
        header.encoding = if unchanged { UNCHANGED } else { JPEG };
        header.payload_bytes = if unchanged {
            0
        } else {
            frame.jpeg.len() as u32
        };
        let mut bytes = header.encode()?.to_vec();
        if !unchanged {
            bytes.extend_from_slice(&frame.jpeg);
        }
        self.revision = Some(frame.revision);
        Ok(Arc::new(bytes))
    }
}
impl Drop for FrameSubscription {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            let mut pollers = hub.pollers.lock();
            if let Some(poller) = pollers.get(&self.target) {
                let (removed, count) = {
                    let mut viewers = poller.viewers.lock();
                    (viewers.remove(&self.viewer).is_some(), viewers.len())
                };
                if removed {
                    viewer_audit(&self.target, count);
                }
                if count == 0 {
                    pollers.remove(&self.target);
                }
            }
        }
    }
}
fn viewer_audit(target: &str, count: usize) {
    audit::record_background(
        "remote_desktop.session.viewers",
        native_kind(target).unwrap_or("external"),
        target,
        "host",
        "allow",
        0,
        serde_json::json!({"binding_id":"native", "count":count}),
    );
}
impl FrameHub {
    pub fn subscribe(
        self: &Arc<Self>,
        target: &str,
        source: Arc<dyn FrameSource>,
    ) -> FrameSubscription {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let viewer = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut pollers = self.pollers.lock();
        let poller = pollers.entry(target.into()).or_insert_with(|| {
            Arc::new(Poller {
                target: target.into(),
                viewers: Mutex::new(BTreeMap::new()),
                task: Mutex::new(None),
            })
        });
        // A revoked last viewer can leave an old subscription draining its error.
        // Replace that empty poller now; its terminating task must not strand a new viewer.
        let (sender, receiver) = watch::channel(None);
        let mut viewers = poller.viewers.lock();
        let finished = poller
            .task
            .lock()
            .as_ref()
            .is_some_and(JoinHandle::is_finished);
        if viewers.is_empty() || finished {
            drop(viewers);
            *poller = Arc::new(Poller {
                target: target.into(),
                viewers: Mutex::new(BTreeMap::new()),
                task: Mutex::new(None),
            });
            viewers = poller.viewers.lock();
        }
        // The emptiness check and insertion share this lock with poller exit.
        viewers.insert(viewer, Viewer { source, sender });
        drop(viewers);
        if poller.task.lock().is_none() {
            *poller.task.lock() = Some(tokio::spawn(supervise(Arc::downgrade(poller))));
        }
        viewer_audit(target, poller.viewers.lock().len());
        FrameSubscription {
            receiver,
            hub: Arc::downgrade(self),
            target: target.into(),
            viewer,
            revision: None,
        }
    }
    pub fn viewer_count(&self, target: &str) -> usize {
        self.pollers
            .lock()
            .get(target)
            .map_or(0, |p| p.viewers.lock().len())
    }
}
fn sources(weak: &Weak<Poller>) -> Vec<(u64, Arc<dyn FrameSource>)> {
    weak.upgrade()
        .map(|p| {
            p.viewers
                .lock()
                .iter()
                .map(|(id, viewer)| (*id, viewer.source.clone()))
                .collect()
        })
        .unwrap_or_default()
}
fn refuse_viewer(weak: &Weak<Poller>, id: u64, error: RemoteDesktopError) {
    if let Some(poller) = weak.upgrade() {
        let mut viewers = poller.viewers.lock();
        if let Some(viewer) = viewers.remove(&id) {
            viewer.sender.send_replace(Some(Err(error)));
            viewer_audit(&poller.target, viewers.len());
        }
    }
}
/// The first viewer that is still authorized captures this tick. The others
/// are authorized once, right before their frame is published.
async fn capturing(weak: &Weak<Poller>) -> Option<(u64, Arc<dyn FrameSource>)> {
    for (id, source) in sources(weak) {
        match source.authorize().await {
            Ok(()) => return Some((id, source)),
            Err(error) => refuse_viewer(weak, id, error),
        }
    }
    None
}
fn refuse_all(weak: &Weak<Poller>, error: &RemoteDesktopError) {
    for (id, _) in sources(weak) {
        refuse_viewer(weak, id, error.clone());
    }
}
/// A capture, encode or proof failure that is not about authority: keep the
/// viewers and retry at the idle rate, ending the stream only after
/// [`TRANSIENT_FAILURES`] in a row.
async fn transient(
    weak: &Weak<Poller>,
    failures: &mut u32,
    error: RemoteDesktopError,
    tick_started: tokio::time::Instant,
) {
    *failures = failures.saturating_add(1);
    if *failures >= TRANSIENT_FAILURES {
        *failures = 0;
        refuse_all(weak, &error);
        return;
    }
    tokio::time::sleep_until(tick_started + IDLE_INTERVAL).await;
}
/// Runs the poller and, whichever way it ends (no viewers, or a provider
/// panic), hands every remaining viewer an error so none waits forever.
async fn supervise(weak: Weak<Poller>) {
    use futures_util::FutureExt as _;
    let outcome = std::panic::AssertUnwindSafe(poll(weak.clone()))
        .catch_unwind()
        .await;
    if outcome.is_err() {
        log::warn!("remote desktop frame poller stopped unexpectedly");
    }
    refuse_all(
        &weak,
        &RemoteDesktopError::new("remote_desktop_native_unavailable"),
    );
}
async fn poll(weak: Weak<Poller>) {
    let mut previous = None;
    let mut jpeg: Option<Arc<Vec<u8>>> = None;
    let mut revision = 0u64;
    let mut identical = 0u32;
    let mut failures = 0u32;
    loop {
        let tick_started = tokio::time::Instant::now();
        let Some((id, source)) = capturing(&weak).await else {
            // A viewer may have attached during an awaited authorization. It
            // was not in that snapshot, so authorize it on the next iteration.
            if sources(&weak).is_empty() {
                return;
            }
            continue;
        };
        // No strong Poller reference crosses any await. Removing the last
        // viewer aborts this task, including an in-flight capture or sleep.
        let captured = tokio::time::timeout(CAPTURE_TIMEOUT, source.capture())
            .await
            .unwrap_or_else(|_| Err(RemoteDesktopError::new("remote_desktop_native_timeout")));
        let frame = match captured {
            Ok(frame) => frame,
            Err(error) => {
                // Lost authority refuses only that viewer, with its own code.
                if let Err(denied) = source.authorize().await {
                    refuse_viewer(&weak, id, denied);
                    continue;
                }
                transient(&weak, &mut failures, error, tick_started).await;
                continue;
            }
        };
        let (width, height) = frame.image.dimensions();
        let key = (frame.image.hash(), width, height);
        let duplicate = previous == Some(key);
        identical = if duplicate {
            identical.saturating_add(1)
        } else {
            0
        };
        let delay = interval(frame.human_controlled, identical);
        let mut header = FrameHeader {
            frame_id: match uuid::Uuid::parse_str(&frame.frame_id) {
                Ok(id) => id,
                Err(_) => {
                    transient(&weak, &mut failures, invalid(), tick_started).await;
                    continue;
                }
            },
            fence: frame.fence,
            width,
            height,
            captured_at_ms: frame.captured_at_ms,
            payload_bytes: 0,
            encoding: UNCHANGED,
        };
        if !duplicate {
            let result = tokio::task::spawn_blocking(move || encode_frame(&frame))
                .await
                .map_err(|_| invalid())
                .and_then(|result| result);
            match result {
                Ok(bytes) => {
                    jpeg = Some(Arc::new(bytes[HEADER_BYTES..].to_vec()));
                }
                Err(error) => {
                    transient(&weak, &mut failures, error, tick_started).await;
                    continue;
                }
            }
            previous = Some(key);
            revision = revision.saturating_add(1);
        }
        failures = 0;
        let jpeg = jpeg
            .as_ref()
            .expect("a successful first frame supplies pixels")
            .clone();
        header.payload_bytes = jpeg.len() as u32;
        header.encoding = JPEG;
        let published = Arc::new(PublishedFrame {
            header,
            jpeg,
            revision,
        });
        // Every viewer revalidates its own native authority after capture/encode.
        // The broker's independent device admission still runs as before.
        for (id, source) in sources(&weak) {
            match source.authorize().await {
                Ok(()) => {
                    // Do not await another viewer between this authority check
                    // and publishing to this viewer's latest-only slot.
                    if let Some(poller) = weak.upgrade() {
                        if let Some(viewer) = poller.viewers.lock().get(&id) {
                            viewer.sender.send_replace(Some(Ok(published.clone())));
                        }
                    }
                }
                Err(error) => refuse_viewer(&weak, id, error),
            }
        }
        tokio::time::sleep_until(tick_started + delay).await;
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    #[tokio::test]
    async fn input_eof_on_length_prefix_is_clean_but_truncated_payload_is_fatal() {
        for bytes in [&b""[..], &b"\0"[..], &b"\0\0\0"[..]] {
            assert!(read_input(&mut &*bytes).await.unwrap().is_none());
        }
        assert!(read_input(&mut &b"\0\0\0\x01"[..]).await.unwrap_err().fatal);
    }
    #[test]
    fn managed_global_policy_failures_end_control_but_input_denials_do_not() {
        for code in [
            "managed_desktop_control_kill_switch",
            "managed_desktop_control_policy_unavailable",
            "managed_desktop_control_target_unverified",
        ] {
            assert!(NativeInputError::managed(code).fatal, "{code}");
        }
        for code in [
            "managed_desktop_control_stale_frame",
            "managed_desktop_control_policy_denied",
            "managed_desktop_control_policy_changed",
        ] {
            assert!(!NativeInputError::managed(code).fatal, "{code}");
        }
    }
    #[tokio::test(start_paused = true)]
    async fn stalled_release_publishes_a_timeout() {
        struct Sink;
        impl NativeInputSink for Sink {
            fn fence(&self) -> u64 {
                1
            }
            fn input(&self, _: NativeInput) -> NativeInputFuture {
                Box::pin(async { Ok(()) })
            }
            fn renew(&self) -> FrameFuture<()> {
                Box::pin(async { Ok(()) })
            }
            fn release(&self) -> FrameFuture<()> {
                Box::pin(std::future::pending())
            }
        }
        let lease = NativeInputLease::new(Arc::new(Sink));
        let mut done = lease.released.clone();
        drop(lease);
        done.wait_for(|value| value.is_some()).await.unwrap();
        assert_eq!(
            done.borrow().as_ref().unwrap().as_ref().unwrap_err().code,
            "remote_desktop_control_release_timeout"
        );
    }
    #[tokio::test]
    async fn bounded_bad_inputs_preserve_boundaries_and_oversized_input_is_fatal() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, mut reader) = tokio::io::duplex(1024);
        for value in [
            serde_json::json!({"action":{"kind":"keyDown"}}),
            serde_json::json!({"frameId":uuid::Uuid::new_v4().to_string(),"action":{"kind":"pressKey","chord":"Tab"}}),
        ] {
            let bytes = serde_json::to_vec(&value).unwrap();
            writer.write_u32(bytes.len() as u32).await.unwrap();
            writer.write_all(&bytes).await.unwrap();
        }
        assert!(!read_input(&mut reader).await.unwrap_err().fatal);
        assert!(read_input(&mut reader).await.is_ok());
        writer.write_u32(MAX_INPUT_BYTES as u32 + 1).await.unwrap();
        assert!(read_input(&mut reader).await.unwrap_err().fatal);
    }
    #[tokio::test]
    async fn input_worker_keeps_lease_on_refusal_and_releases_on_fatal_error() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Sink(Arc<AtomicUsize>, Arc<AtomicUsize>);
        impl NativeInputSink for Sink {
            fn fence(&self) -> u64 {
                1
            }
            fn input(&self, _: NativeInput) -> NativeInputFuture {
                let n = self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    match n {
                        0 => Err(NativeInputError::refused(
                            "remote_desktop_input_stale_frame",
                        )),
                        1 => Ok(()),
                        _ => Err(NativeInputError::fatal(RemoteDesktopError::new(
                            "remote_desktop_forbidden",
                        ))),
                    }
                })
            }
            fn renew(&self) -> FrameFuture<()> {
                Box::pin(async { Ok(()) })
            }
            fn release(&self) -> FrameFuture<()> {
                let released = self.1.clone();
                Box::pin(async move {
                    released.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            }
        }
        let released = Arc::new(AtomicUsize::new(0));
        let lease = NativeInputLease::new(Arc::new(Sink(
            Arc::new(AtomicUsize::new(0)),
            released.clone(),
        )));
        let input = || NativeInput {
            point: None,
            frame_id: uuid::Uuid::new_v4().to_string(),
            action: NativeUiAction::PressKey {
                chord: "Tab".into(),
            },
        };
        assert!(!lease.input(input()).await.unwrap_err().fatal);
        lease.input(input()).await.unwrap();
        assert_eq!(released.load(Ordering::SeqCst), 0);
        assert!(lease.input(input()).await.unwrap_err().fatal);
        let mut done = lease.released.clone();
        done.wait_for(|result| result.is_some()).await.unwrap();
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }
    #[tokio::test(start_paused = true)]
    async fn pending_consent_does_not_block_renewal_and_close_cancels_the_wait() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Pending(Arc<AtomicUsize>);
        impl NativeInputSink for Pending {
            fn fence(&self) -> u64 {
                1
            }
            fn input(&self, _: NativeInput) -> NativeInputFuture {
                Box::pin(std::future::pending())
            }
            fn renew(&self) -> FrameFuture<()> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(()) })
            }
            fn release(&self) -> FrameFuture<()> {
                Box::pin(async { Ok(()) })
            }
        }
        let renewed = Arc::new(AtomicUsize::new(0));
        let lease = NativeInputLease::new(Arc::new(Pending(renewed.clone())));
        let mut released = lease.released.clone();
        let sender = lease.clone();
        let input = tokio::spawn(async move {
            sender
                .input(NativeInput {
                    point: None,
                    frame_id: uuid::Uuid::new_v4().to_string(),
                    action: NativeUiAction::PressKey {
                        chord: "Tab".into(),
                    },
                })
                .await
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(6)).await;
        tokio::task::yield_now().await;
        assert!(renewed.load(Ordering::SeqCst) > 0);
        input.abort();
        let _ = input.await;
        drop(lease);
        tokio::time::timeout(
            Duration::from_secs(1),
            released.wait_for(|result| result.is_some()),
        )
        .await
        .unwrap()
        .unwrap();
    }
    #[tokio::test(start_paused = true)]
    async fn closing_cancels_a_stalled_renewal_with_or_without_pending_input() {
        struct PendingRenew(Arc<AtomicUsize>);
        impl NativeInputSink for PendingRenew {
            fn fence(&self) -> u64 {
                1
            }
            fn input(&self, _: NativeInput) -> NativeInputFuture {
                Box::pin(std::future::pending())
            }
            fn renew(&self) -> FrameFuture<()> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(std::future::pending())
            }
            fn release(&self) -> FrameFuture<()> {
                Box::pin(async { Ok(()) })
            }
        }
        for pending_input in [false, true] {
            let renewed = Arc::new(AtomicUsize::new(0));
            let lease = NativeInputLease::new(Arc::new(PendingRenew(renewed.clone())));
            let mut released = lease.released.clone();
            let task = pending_input.then(|| {
                let sender = lease.clone();
                tokio::spawn(async move {
                    sender
                        .input(NativeInput {
                            point: None,
                            frame_id: uuid::Uuid::new_v4().to_string(),
                            action: NativeUiAction::PressKey {
                                chord: "Tab".into(),
                            },
                        })
                        .await
                })
            });
            tokio::task::yield_now().await;
            tokio::time::advance(Duration::from_secs(6)).await;
            tokio::task::yield_now().await;
            assert_eq!(renewed.load(Ordering::SeqCst), 1);
            if let Some(task) = task {
                task.abort();
                let _ = task.await;
            }
            drop(lease);
            tokio::time::timeout(
                Duration::from_secs(1),
                released.wait_for(|result| result.is_some()),
            )
            .await
            .unwrap()
            .unwrap();
        }
    }
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Image {
        sizes: Mutex<Vec<(u8, u32, u32)>>,
        large: bool,
    }
    impl FrameImage for Image {
        fn dimensions(&self) -> (u32, u32) {
            (640, 480)
        }
        fn hash(&self) -> [u8; 32] {
            [1; 32]
        }
        fn jpeg(&self, q: u8, w: u32, h: u32) -> Result<Vec<u8>> {
            self.sizes.lock().push((q, w, h));
            Ok(vec![
                0;
                if self.large && w > 320 {
                    MAX_FRAME_BYTES
                } else {
                    10
                }
            ])
        }
    }
    fn frame(image: Arc<dyn FrameImage>, fence: u64) -> CapturedFrame {
        CapturedFrame {
            frame_id: "00112233-4455-6677-8899-aabbccddeeff".into(),
            fence,
            captured_at_ms: 123456789,
            human_controlled: false,
            image,
        }
    }
    #[test]
    fn header_round_trip_fixture_and_rejections() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/frame-v1.json")).unwrap();
        let bytes = hex::decode(vector["hex"].as_str().unwrap()).unwrap();
        let header = FrameHeader::decode(&bytes).unwrap();
        assert_eq!(
            header.frame_id.to_string(),
            vector["frameId"].as_str().unwrap()
        );
        assert_eq!(header.fence, 42);
        assert_eq!((header.width, header.height), (2, 1));
        assert_eq!(header.captured_at_ms, 123456789);
        assert_eq!(&header.encode().unwrap()[..], &bytes[..HEADER_BYTES]);
        assert_eq!(header.payload_bytes as usize, bytes.len() - HEADER_BYTES);
        for offset in [0, 4, 5, 6, 20, 56] {
            let mut bad = bytes.clone();
            bad[offset] ^= 1;
            assert!(FrameHeader::decode(&bad).is_err());
        }
        assert!(FrameHeader::decode(&bytes[..63]).is_err());
    }
    #[test]
    fn unchanged_frames_round_trip_shared_fixture_and_require_zero_payload() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/frame-v1.json")).unwrap();
        let bytes = hex::decode(fixture["unchanged"]["hex"].as_str().unwrap()).unwrap();
        let mut header = FrameHeader::decode(&bytes).unwrap();
        assert_eq!(header.encoding, UNCHANGED);
        assert_eq!(
            header.frame_id.to_string(),
            fixture["unchanged"]["frameId"].as_str().unwrap()
        );
        assert_eq!(
            header.captured_at_ms,
            fixture["unchanged"]["capturedAtMs"].as_u64().unwrap()
        );
        assert_eq!(header.payload_bytes, 0);
        assert_eq!(header.encode().unwrap().as_slice(), bytes);
        header.payload_bytes = 1;
        assert!(header.encode().is_err());
        header.payload_bytes = 0;
        header.encoding = JPEG;
        assert!(header.encode().is_err());
    }

    #[test]
    fn quality_then_downscale_never_exceeds_cap() {
        let image = Arc::new(Image {
            sizes: Mutex::new(vec![]),
            large: true,
        });
        let bytes = encode_frame(&frame(image.clone(), 42)).unwrap();
        assert!(bytes.len() <= MAX_FRAME_BYTES);
        assert_eq!(
            *image.sizes.lock(),
            vec![
                (70, 640, 480),
                (50, 640, 480),
                (35, 640, 480),
                (20, 640, 480),
                (70, 320, 240)
            ]
        );
        assert_eq!(FrameHeader::decode(&bytes).unwrap().width, 640);
    }
    #[test]
    fn rate_selection() {
        assert_eq!(interval(true, 0), HUMAN_INTERVAL);
        assert_eq!(interval(false, 0), OBSERVER_INTERVAL);
        assert_eq!(interval(true, IDENTICAL_BACKOFF), IDLE_INTERVAL);
        assert_eq!(interval(false, IDENTICAL_BACKOFF), IDLE_INTERVAL);
        assert!(IDLE_INTERVAL < Duration::from_millis(crate::control::FRAME_MS as u64));
        assert!(
            FRAME_PROOFS_PER_PRINCIPAL
                > (crate::control::FRAME_MS as u128 / HUMAN_INTERVAL.as_millis()) as usize
        );
    }
    struct Source(Arc<AtomicUsize>, bool);
    impl FrameSource for Source {
        fn authorize(&self) -> FrameFuture<()> {
            Box::pin(async { Ok(()) })
        }
        fn capture(&self) -> FrameFuture<CapturedFrame> {
            let count = self.0.fetch_add(1, Ordering::SeqCst);
            let changing = self.1;
            Box::pin(async move {
                let mut result = frame(
                    Arc::new(Image {
                        sizes: Mutex::new(vec![]),
                        large: false,
                    }),
                    if changing { count as u64 } else { 0 },
                );
                result.frame_id = uuid::Uuid::from_u128(count as u128 + 1).to_string();
                Ok(result)
            })
        }
    }
    #[tokio::test(start_paused = true)]
    async fn fanout_dedup_and_stop_without_viewers() {
        let hub = Arc::new(FrameHub::default());
        let count = Arc::new(AtomicUsize::new(0));
        let source = Arc::new(Source(count.clone(), false));
        let mut a = hub.subscribe("sandbox:a", source.clone());
        let mut b = hub.subscribe("sandbox:a", source);
        let first = a.next().await.unwrap();
        assert_eq!(b.next().await.unwrap(), first);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        tokio::time::advance(OBSERVER_INTERVAL).await;
        tokio::task::yield_now().await;
        assert_eq!(count.load(Ordering::SeqCst), 2);
        let refresh = a.next().await.unwrap();
        let proof = FrameHeader::decode(&refresh).unwrap();
        assert_eq!(refresh.len(), HEADER_BYTES);
        assert_eq!(proof.encoding, UNCHANGED);
        assert_ne!(
            proof.frame_id,
            FrameHeader::decode(&first).unwrap().frame_id
        );
        drop(a);
        drop(b);
        assert_eq!(hub.viewer_count("sandbox:a"), 0);
        tokio::time::advance(IDLE_INTERVAL * 10).await;
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn latest_only_replaces_unsent_frame() {
        let hub = Arc::new(FrameHub::default());
        let mut sub = hub.subscribe(
            "sandbox:a",
            Arc::new(Source(Arc::new(AtomicUsize::new(0)), true)),
        );
        let poller = hub.pollers.lock().get("sandbox:a").unwrap().clone();
        poller.task.lock().take().unwrap().abort();
        let publish = |fence| {
            Arc::new(PublishedFrame {
                header: FrameHeader {
                    frame_id: uuid::Uuid::new_v4(),
                    fence,
                    width: 1,
                    height: 1,
                    captured_at_ms: 1,
                    payload_bytes: 4,
                    encoding: JPEG,
                },
                jpeg: Arc::new(vec![255, 216, 255, 217]),
                revision: fence,
            })
        };
        let viewers = poller.viewers.lock();
        let sender = &viewers.get(&sub.viewer).unwrap().sender;
        sender.send_replace(Some(Ok(publish(1))));
        sender.send_replace(Some(Ok(publish(2))));
        drop(viewers);
        let bytes = sub.next().await.unwrap();
        assert_eq!(FrameHeader::decode(&bytes).unwrap().fence, 2);
        assert_eq!(FrameHeader::decode(&bytes).unwrap().encoding, JPEG);
    }
    pub(crate) struct GateSource {
        pub active: Arc<std::sync::atomic::AtomicBool>,
        pub calls: Arc<AtomicUsize>,
        pub fail_capture: bool,
    }
    impl FrameSource for GateSource {
        fn authorize(&self) -> FrameFuture<()> {
            let active = self.active.load(Ordering::SeqCst);
            Box::pin(async move {
                if active {
                    Ok(())
                } else {
                    Err(RemoteDesktopError::new("remote_desktop_forbidden"))
                }
            })
        }
        fn capture(&self) -> FrameFuture<CapturedFrame> {
            let count = self.calls.fetch_add(1, Ordering::SeqCst);
            let fail = self.fail_capture;
            Box::pin(async move {
                if fail {
                    return Err(RemoteDesktopError::new("remote_desktop_native_unavailable"));
                }
                let mut result = frame(
                    Arc::new(Image {
                        sizes: Mutex::new(vec![]),
                        large: false,
                    }),
                    42,
                );
                result.frame_id = uuid::Uuid::from_u128(count as u128 + 1).to_string();
                Ok(result)
            })
        }
    }
    pub(crate) fn gate_source(
        active: Arc<std::sync::atomic::AtomicBool>,
        fail_capture: bool,
    ) -> Arc<GateSource> {
        Arc::new(GateSource {
            active,
            calls: Arc::new(AtomicUsize::new(0)),
            fail_capture,
        })
    }
    #[tokio::test(start_paused = true)]
    async fn frames_revoke_each_viewer_independently_and_continue_capture() {
        use std::sync::atomic::AtomicBool;
        let hub = Arc::new(FrameHub::default());
        let active_a = Arc::new(AtomicBool::new(true));
        let active_b = Arc::new(AtomicBool::new(true));
        let source_a = gate_source(active_a.clone(), false);
        let source_b = gate_source(active_b.clone(), false);
        let mut a = hub.subscribe("managed-desktop:a", source_a.clone());
        let mut b = hub.subscribe("managed-desktop:a", source_b.clone());
        a.next().await.unwrap();
        b.next().await.unwrap();
        active_b.store(false, Ordering::SeqCst);
        tokio::time::advance(OBSERVER_INTERVAL).await;
        let refresh = a.next().await.unwrap();
        assert_eq!(FrameHeader::decode(&refresh).unwrap().encoding, UNCHANGED);
        assert_eq!(b.next().await.unwrap_err().code, "remote_desktop_forbidden");
        assert_eq!(source_a.calls.load(Ordering::SeqCst), 2);
        assert_eq!(source_b.calls.load(Ordering::SeqCst), 0);
        assert_eq!(hub.viewer_count("managed-desktop:a"), 1);
        // Last revocation must not strand a newly attached authorized viewer,
        // even while the old subscriptions have not dropped yet.
        active_a.store(false, Ordering::SeqCst);
        tokio::time::advance(OBSERVER_INTERVAL).await;
        assert!(a.next().await.is_err());
        let mut next = hub.subscribe(
            "managed-desktop:a",
            gate_source(Arc::new(AtomicBool::new(true)), false),
        );
        assert_eq!(
            FrameHeader::decode(&next.next().await.unwrap())
                .unwrap()
                .encoding,
            JPEG
        );
        drop(a);
        drop(b);
        assert_eq!(hub.viewer_count("managed-desktop:a"), 1);
    }
    #[tokio::test(start_paused = true)]
    async fn frames_late_and_slow_viewers_receive_current_pixels_before_unchanged() {
        let hub = Arc::new(FrameHub::default());
        let source = Arc::new(Source(Arc::new(AtomicUsize::new(0)), false));
        let mut fast = hub.subscribe("sandbox:a", source.clone());
        fast.next().await.unwrap();
        let mut late = hub.subscribe("sandbox:a", source);
        for _ in 0..3 {
            tokio::time::advance(OBSERVER_INTERVAL).await;
            assert_eq!(
                FrameHeader::decode(&fast.next().await.unwrap())
                    .unwrap()
                    .encoding,
                UNCHANGED
            );
        }
        assert_eq!(
            FrameHeader::decode(&late.next().await.unwrap())
                .unwrap()
                .encoding,
            JPEG
        );
        tokio::time::advance(OBSERVER_INTERVAL).await;
        assert_eq!(
            FrameHeader::decode(&late.next().await.unwrap())
                .unwrap()
                .encoding,
            UNCHANGED
        );
    }
    #[tokio::test(start_paused = true)]
    async fn frames_capture_failure_reaches_all_viewers_without_bytes() {
        let hub = Arc::new(FrameHub::default());
        let source = gate_source(Arc::new(std::sync::atomic::AtomicBool::new(true)), true);
        let mut a = hub.subscribe("sandbox:a", source.clone());
        let mut b = hub.subscribe("sandbox:a", source.clone());
        // Persistent failure ends every stream, but only after the bounded
        // number of transient retries at the idle rate.
        assert_eq!(
            a.next().await.unwrap_err().code,
            "remote_desktop_native_unavailable"
        );
        assert_eq!(
            b.next().await.unwrap_err().code,
            "remote_desktop_native_unavailable"
        );
        assert_eq!(hub.viewer_count("sandbox:a"), 0);
        assert_eq!(
            source.calls.load(Ordering::SeqCst),
            TRANSIENT_FAILURES as usize
        );
    }

    /// Fails the first `fail` captures, hangs on `hang`, panics on `panic`.
    struct Flaky {
        calls: Arc<AtomicUsize>,
        authorizations: Arc<AtomicUsize>,
        fail: usize,
        hang: bool,
        panic: bool,
    }
    impl FrameSource for Flaky {
        fn authorize(&self) -> FrameFuture<()> {
            self.authorizations.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
        fn capture(&self) -> FrameFuture<CapturedFrame> {
            let count = self.calls.fetch_add(1, Ordering::SeqCst);
            let (fail, hang, panic) = (self.fail, self.hang, self.panic);
            Box::pin(async move {
                if panic {
                    panic!("provider bug");
                }
                if hang {
                    std::future::pending::<()>().await;
                }
                if count < fail {
                    return Err(RemoteDesktopError::new("remote_desktop_frame_busy"));
                }
                let mut result = frame(
                    Arc::new(Image {
                        sizes: Mutex::new(vec![]),
                        large: false,
                    }),
                    1,
                );
                result.frame_id = uuid::Uuid::from_u128(count as u128 + 1).to_string();
                Ok(result)
            })
        }
    }
    fn flaky(fail: usize, hang: bool, panic: bool) -> Arc<Flaky> {
        Arc::new(Flaky {
            calls: Arc::new(AtomicUsize::new(0)),
            authorizations: Arc::new(AtomicUsize::new(0)),
            fail,
            hang,
            panic,
        })
    }

    #[test]
    fn admission_cache_expires_with_the_broker_interval_and_clears_on_failure() {
        let cache = AdmissionCache::default();
        assert!(!cache.fresh());
        cache.mark();
        assert!(cache.fresh());
        cache.clear();
        assert!(!cache.fresh());
        *cache.verified_at.lock() = Some(
            std::time::Instant::now() - crate::session::ADMISSION_INTERVAL,
        );
        assert!(!cache.fresh());
    }

    #[tokio::test(start_paused = true)]
    async fn frames_transient_failures_keep_viewers_and_recover() {
        let hub = Arc::new(FrameHub::default());
        let source = flaky(TRANSIENT_FAILURES as usize - 1, false, false);
        let mut viewer = hub.subscribe("sandbox:a", source.clone());
        let bytes = viewer.next().await.unwrap();
        assert_eq!(FrameHeader::decode(&bytes).unwrap().encoding, JPEG);
        assert_eq!(source.calls.load(Ordering::SeqCst), TRANSIENT_FAILURES as usize);
        assert_eq!(hub.viewer_count("sandbox:a"), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn frames_a_hung_capture_times_out_and_counts_as_transient() {
        let hub = Arc::new(FrameHub::default());
        let source = flaky(0, true, false);
        let mut viewer = hub.subscribe("sandbox:a", source.clone());
        assert_eq!(
            viewer.next().await.unwrap_err().code,
            "remote_desktop_native_timeout"
        );
        assert_eq!(source.calls.load(Ordering::SeqCst), TRANSIENT_FAILURES as usize);
        assert!(CAPTURE_TIMEOUT < Duration::from_millis(crate::control::FRAME_MS as u64));
    }

    #[tokio::test]
    async fn frames_a_panicking_provider_ends_its_viewers_and_a_new_viewer_starts_fresh() {
        let hub = Arc::new(FrameHub::default());
        let mut broken = hub.subscribe("sandbox:a", flaky(0, false, true));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), broken.next())
                .await
                .unwrap()
                .unwrap_err()
                .code,
            "remote_desktop_native_unavailable"
        );
        let mut next = hub.subscribe("sandbox:a", flaky(0, false, false));
        let bytes = tokio::time::timeout(Duration::from_secs(2), next.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(FrameHeader::decode(&bytes).unwrap().encoding, JPEG);
    }

    #[tokio::test]
    async fn frames_only_the_capturing_viewer_is_authorized_before_capture() {
        let hub = Arc::new(FrameHub::default());
        let first = flaky(0, false, false);
        let second = flaky(0, false, false);
        let mut a = hub.subscribe("sandbox:a", first.clone());
        let mut b = hub.subscribe("sandbox:a", second.clone());
        a.next().await.unwrap();
        b.next().await.unwrap();
        // First tick: the capturer is authorized before capture and before
        // publish; the other viewer only before its publish.
        assert_eq!(first.authorizations.load(Ordering::SeqCst), 2);
        assert_eq!(second.authorizations.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn frames_the_capturing_viewer_losing_authority_gets_the_authority_error() {
        use std::sync::atomic::AtomicBool;
        struct Revoking {
            active: Arc<AtomicBool>,
        }
        impl FrameSource for Revoking {
            fn authorize(&self) -> FrameFuture<()> {
                let active = self.active.load(Ordering::SeqCst);
                Box::pin(async move {
                    if active {
                        Ok(())
                    } else {
                        Err(RemoteDesktopError::new("remote_desktop_forbidden"))
                    }
                })
            }
            fn capture(&self) -> FrameFuture<CapturedFrame> {
                self.active.store(false, Ordering::SeqCst);
                Box::pin(async { Err(RemoteDesktopError::new("remote_desktop_native_unavailable")) })
            }
        }
        let hub = Arc::new(FrameHub::default());
        let mut viewer = hub.subscribe(
            "sandbox:a",
            Arc::new(Revoking {
                active: Arc::new(AtomicBool::new(true)),
            }),
        );
        assert_eq!(viewer.next().await.unwrap_err().code, "remote_desktop_forbidden");
    }
    #[tokio::test]
    async fn frames_read_restores_chunked_and_header_only_boundaries() {
        use tokio::io::AsyncWriteExt;
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/frame-v1.json")).unwrap();
        let jpeg = hex::decode(fixture["hex"].as_str().unwrap()).unwrap();
        let unchanged = hex::decode(fixture["unchanged"]["hex"].as_str().unwrap()).unwrap();
        let (mut writer, mut reader) = tokio::io::duplex(MAX_FRAME_BYTES);
        for chunk in jpeg.chunks(17) {
            writer.write_all(chunk).await.unwrap();
        }
        writer.write_all(&unchanged).await.unwrap();
        assert_eq!(read_frame(&mut reader).await.unwrap(), jpeg);
        assert_eq!(read_frame(&mut reader).await.unwrap(), unchanged);
    }
    #[test]
    fn frames_quality_fallback_precedes_downscale_and_unencodable_is_refused() {
        struct Quality;
        impl FrameImage for Quality {
            fn dimensions(&self) -> (u32, u32) {
                (2, 2)
            }
            fn hash(&self) -> [u8; 32] {
                [0; 32]
            }
            fn jpeg(&self, quality: u8, width: u32, _: u32) -> Result<Vec<u8>> {
                assert_eq!(width, 2, "quality fallback must happen before scaling");
                Ok(vec![0; if quality == 70 { MAX_FRAME_BYTES } else { 4 }])
            }
        }
        let bytes = encode_frame(&frame(Arc::new(Quality), 1)).unwrap();
        assert_eq!(bytes.len(), HEADER_BYTES + 4);
        struct Oversize;
        impl FrameImage for Oversize {
            fn dimensions(&self) -> (u32, u32) {
                (1, 1)
            }
            fn hash(&self) -> [u8; 32] {
                [0; 32]
            }
            fn jpeg(&self, _: u8, _: u32, _: u32) -> Result<Vec<u8>> {
                Ok(vec![0; MAX_FRAME_BYTES])
            }
        }
        assert_eq!(
            encode_frame(&frame(Arc::new(Oversize), 1))
                .unwrap_err()
                .code,
            "remote_desktop_frame_too_large"
        );
    }

    #[tokio::test]
    async fn frames_subscribe_during_last_authorization_refusal_cannot_strand_viewer() {
        struct PendingAuthority {
            started: Arc<tokio::sync::Notify>,
            resume: Arc<tokio::sync::Notify>,
        }
        impl FrameSource for PendingAuthority {
            fn authorize(&self) -> FrameFuture<()> {
                let (started, resume) = (self.started.clone(), self.resume.clone());
                Box::pin(async move {
                    started.notify_one();
                    resume.notified().await;
                    Err(RemoteDesktopError::new("remote_desktop_forbidden"))
                })
            }
            fn capture(&self) -> FrameFuture<CapturedFrame> {
                Box::pin(async { Err(invalid()) })
            }
        }
        let hub = Arc::new(FrameHub::default());
        let started = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        let mut old = hub.subscribe(
            "sandbox:a",
            Arc::new(PendingAuthority {
                started: started.clone(),
                resume: resume.clone(),
            }),
        );
        started.notified().await;
        let mut next = hub.subscribe(
            "sandbox:a",
            gate_source(Arc::new(std::sync::atomic::AtomicBool::new(true)), false),
        );
        resume.notify_one();
        assert!(old.next().await.is_err());
        let bytes = tokio::time::timeout(Duration::from_secs(2), next.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(FrameHeader::decode(&bytes).unwrap().encoding, JPEG);
        assert_eq!(hub.viewer_count("sandbox:a"), 1);
    }

    #[tokio::test]
    async fn frames_publish_immediately_after_each_viewers_final_authorization() {
        struct SlowAuthority {
            source: Arc<GateSource>,
            calls: Arc<AtomicUsize>,
            started: Arc<tokio::sync::Notify>,
            resume: Arc<tokio::sync::Notify>,
        }
        impl FrameSource for SlowAuthority {
            fn authorize(&self) -> FrameFuture<()> {
                let call = self.calls.fetch_add(1, Ordering::SeqCst);
                let (started, resume) = (self.started.clone(), self.resume.clone());
                Box::pin(async move {
                    if call == 1 {
                        started.notify_one();
                        resume.notified().await;
                    }
                    Ok(())
                })
            }
            fn capture(&self) -> FrameFuture<CapturedFrame> {
                self.source.capture()
            }
        }
        use std::sync::atomic::AtomicBool;
        let hub = Arc::new(FrameHub::default());
        let active = Arc::new(AtomicBool::new(true));
        let mut a = hub.subscribe("sandbox:a", gate_source(active.clone(), false));
        let started = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        let mut b = hub.subscribe(
            "sandbox:a",
            Arc::new(SlowAuthority {
                source: gate_source(Arc::new(AtomicBool::new(true)), false),
                calls: Arc::new(AtomicUsize::new(0)),
                started: started.clone(),
                resume: resume.clone(),
            }),
        );
        started.notified().await;
        // A's valid frame is published before waiting for B's authority.
        tokio::time::timeout(Duration::from_secs(1), a.next())
            .await
            .unwrap()
            .unwrap();
        active.store(false, Ordering::SeqCst);
        resume.notify_one();
        b.next().await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), a.next())
                .await
                .unwrap()
                .unwrap_err()
                .code,
            "remote_desktop_forbidden"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn frames_capture_time_is_part_of_the_poll_interval() {
        struct SlowCapture(Arc<AtomicUsize>);
        impl FrameSource for SlowCapture {
            fn authorize(&self) -> FrameFuture<()> {
                Box::pin(async { Ok(()) })
            }
            fn capture(&self) -> FrameFuture<CapturedFrame> {
                let count = self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    tokio::time::sleep(OBSERVER_INTERVAL / 2).await;
                    let mut result = frame(
                        Arc::new(Image {
                            sizes: Mutex::new(vec![]),
                            large: false,
                        }),
                        0,
                    );
                    result.frame_id = uuid::Uuid::from_u128(count as u128 + 1).to_string();
                    Ok(result)
                })
            }
        }
        let hub = Arc::new(FrameHub::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let mut viewer = hub.subscribe("sandbox:a", Arc::new(SlowCapture(calls.clone())));
        viewer.next().await.unwrap();
        tokio::time::advance(OBSERVER_INTERVAL / 2).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
