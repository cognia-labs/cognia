//! Docker CUA's owner-backed native frame provider. Authorization is supplied
//! by the Host installation, rather than inferred from a caller-controlled id.
use super::CuaSandboxRegistry;
use base64::Engine as _;
use cognia_remote_desktop::{
    error::{RemoteDesktopError, Result},
    frames::{
        blocking, AdmissionCache, CapturedFrame, FrameFuture, FrameImage, FrameSource,
        NativeFrameProvider, NativeInput, NativeInputError, NativeInputFuture, NativeInputSink,
        NativeProviderKind, NativeTargetSummary,
    },
    session::{Principal, SessionMode},
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// The Host's owner check for a viewer: the local shell, or (remote
/// observation) the Host account's owner devices only. The local IPC-only RPC's
/// equivalent is `principal.is_local()`.
pub type SandboxFrameAdmission = Arc<dyn Fn(&Principal, &str) -> bool + Send + Sync>;
pub struct CuaNativeFrameProvider {
    registry: CuaSandboxRegistry,
    admission: SandboxFrameAdmission,
}
impl CuaNativeFrameProvider {
    pub fn new(registry: CuaSandboxRegistry, admission: SandboxFrameAdmission) -> Self {
        Self {
            registry,
            admission,
        }
    }
}
struct Source {
    registry: CuaSandboxRegistry,
    id: String,
    principal: Principal,
    admission: SandboxFrameAdmission,
    verified: Arc<AdmissionCache>,
}
/// `check` reads the pairing store, so it runs off the runtime and its success
/// is reused for one broker admission interval.
async fn admitted(
    verified: &AdmissionCache,
    registry: &CuaSandboxRegistry,
    admission: &SandboxFrameAdmission,
    principal: &Principal,
    id: &str,
) -> Result<()> {
    if verified.fresh() {
        return Ok(());
    }
    let (admission, principal, owned_id) = (admission.clone(), principal.clone(), id.to_owned());
    let outcome = async {
        blocking(move || check(&admission, &principal, &owned_id)).await?;
        require_docker(registry, id).await
    }
    .await;
    match outcome {
        Ok(()) => verified.mark(),
        Err(_) => verified.clear(),
    }
    outcome
}
fn check(admission: &SandboxFrameAdmission, principal: &Principal, id: &str) -> Result<()> {
    if !principal.admitted(SessionMode::View) || !admission(principal, id) {
        return Err(RemoteDesktopError::new("remote_desktop_forbidden"));
    }
    // The owner checks the exact connection id. Lume aliases are rejected by
    // require_docker before entering the shared registry capture path.
    if id.is_empty() || id.len() > 256 || id.contains('\0') {
        return Err(cognia_remote_desktop::frames::invalid());
    }
    Ok(())
}
async fn require_docker(registry: &CuaSandboxRegistry, id: &str) -> Result<()> {
    if let Some(lume) = registry.existing_lume_service().await {
        if lume
            .resolve_target(id)
            .await
            .map_err(|_| RemoteDesktopError::new("remote_desktop_native_unavailable"))?
            .is_some()
        {
            return Err(RemoteDesktopError::new("remote_desktop_native_unavailable"));
        }
    }
    Ok(())
}
impl NativeFrameProvider for CuaNativeFrameProvider {
    fn list(&self, principal: Principal) -> FrameFuture<Vec<NativeTargetSummary>> {
        let (registry, admission) = (self.registry.clone(), self.admission.clone());
        Box::pin(async move {
            let mut targets = Vec::new();
            for id in registry.native_connection_ids().await {
                let (check_admission, viewer, connection) =
                    (admission.clone(), principal.clone(), id.clone());
                if blocking(move || check(&check_admission, &viewer, &connection))
                    .await
                    .is_err()
                    || require_docker(&registry, &id).await.is_err()
                {
                    continue;
                }
                let Ok(Some(state)) = registry.inspect(&id).await else {
                    continue;
                };
                if !state.running || state.paused {
                    continue;
                }
                let Some(target) = native_summary(&registry, &id).await else {
                    continue;
                };
                let (check_admission, viewer, connection) =
                    (admission.clone(), principal.clone(), id.clone());
                if blocking(move || check(&check_admission, &viewer, &connection))
                    .await
                    .is_err()
                {
                    continue;
                }
                targets.push(target);
            }
            Ok(targets)
        })
    }
    fn acquire_input(
        &self,
        id: String,
        principal: Principal,
        takeover: bool,
    ) -> FrameFuture<Arc<dyn NativeInputSink>> {
        let (registry, admission) = (self.registry.clone(), self.admission.clone());
        Box::pin(async move {
            control_admitted(&registry, &admission, &principal, &id).await?;
            let lease = registry
                .acquire_control(&id, takeover)
                .await
                .map_err(unavailable)?;
            let sink = Arc::new(InputSink {
                registry,
                admission,
                principal,
                id,
                lease,
            });
            if let Err(error) = sink.admitted().await {
                let _ = sink.release().await;
                return Err(error);
            }
            Ok(sink as Arc<dyn NativeInputSink>)
        })
    }
    fn resolve(&self, id: String, principal: Principal) -> FrameFuture<Arc<dyn FrameSource>> {
        let source = Source {
            registry: self.registry.clone(),
            id,
            principal,
            admission: self.admission.clone(),
            verified: Arc::new(AdmissionCache::default()),
        };
        Box::pin(async move {
            source.authorize().await?;
            source
                .registry
                .client(&source.id)
                .await
                .map_err(|_| RemoteDesktopError::new("remote_desktop_native_unavailable"))?;
            source.verified.clear();
            source.authorize().await?;
            Ok(Arc::new(source) as Arc<dyn FrameSource>)
        })
    }
}

/// Read stream metadata only after owner/running admission. A broken item
/// must not hide the other desktops or stored external targets.
async fn native_summary(registry: &CuaSandboxRegistry, id: &str) -> Option<NativeTargetSummary> {
    let Ok(name) = super::registry::container_name_for_connection(id) else {
        log::debug!("native sandbox enumeration item unavailable");
        return None;
    };
    let selkies = match registry.stream_backend.0.endpoint(&name).await {
        Ok(endpoint) => endpoint.is_some(),
        Err(_) => {
            log::debug!("native sandbox stream metadata unavailable");
            return None;
        }
    };
    Some(NativeTargetSummary {
        label: id.into(),
        id: id.into(),
        provider: NativeProviderKind::Docker,
        selkies,
    })
}

fn unavailable(_: crate::automation::types::AutomationError) -> RemoteDesktopError {
    RemoteDesktopError::new("remote_desktop_native_unavailable")
}
async fn control_admitted(
    registry: &CuaSandboxRegistry,
    admission: &SandboxFrameAdmission,
    principal: &Principal,
    id: &str,
) -> Result<()> {
    let (admission, principal, owned_id) = (admission.clone(), principal.clone(), id.to_owned());
    blocking(move || {
        check(&admission, &principal, &owned_id)?;
        if !principal.admitted(SessionMode::Control) {
            return Err(RemoteDesktopError::new("remote_desktop_forbidden"));
        }
        Ok(())
    })
    .await?;
    require_docker(registry, id).await
}
#[derive(Clone)]
struct InputSink {
    registry: CuaSandboxRegistry,
    admission: SandboxFrameAdmission,
    principal: Principal,
    id: String,
    lease: super::desktop_session::ControlLease,
}
impl InputSink {
    async fn admitted(&self) -> Result<()> {
        control_admitted(&self.registry, &self.admission, &self.principal, &self.id).await
    }
}
/// The wire vocabulary is a closed subset of the local viewer's UiAction.
pub(super) fn local_input(
    input: NativeInput,
) -> Result<(
    String,
    Option<crate::automation::types::Point>,
    crate::automation::session::UiAction,
)> {
    let action = serde_json::from_value(
        serde_json::to_value(input.action).map_err(|_| cognia_remote_desktop::frames::invalid())?,
    )
    .map_err(|_| cognia_remote_desktop::frames::invalid())?;
    let point = input.point.map(|point| crate::automation::types::Point {
        x: point.x,
        y: point.y,
    });
    Ok((input.frame_id, point, action))
}
impl NativeInputSink for InputSink {
    fn fence(&self) -> u64 {
        self.lease.fence
    }
    fn input(&self, input: NativeInput) -> NativeInputFuture {
        let sink = self.clone();
        Box::pin(async move {
            sink.admitted().await.map_err(NativeInputError::fatal)?;
            let (frame_id, point, action) = local_input(input)
                .map_err(|_| NativeInputError::refused("remote_desktop_input_invalid"))?;
            sink.registry
                .control_input(
                    &sink.id,
                    &sink.lease.token,
                    sink.lease.fence,
                    &frame_id,
                    point,
                    action,
                )
                .await
                .map_err(docker_input_error)
        })
    }
    fn renew(&self) -> FrameFuture<()> {
        let sink = self.clone();
        Box::pin(async move {
            sink.admitted().await?;
            sink.registry
                .renew_control(&sink.id, &sink.lease.token, sink.lease.fence)
                .await
                .map_err(unavailable)?;
            Ok(())
        })
    }
    fn release(&self) -> FrameFuture<()> {
        let sink = self.clone();
        Box::pin(async move {
            sink.registry
                .release_control(&sink.id, &sink.lease.token, sink.lease.fence)
                .await
                .map_err(unavailable)
        })
    }
}

fn docker_input_error(error: crate::automation::types::AutomationError) -> NativeInputError {
    use crate::automation::types::AutomationError;
    match error {
        AutomationError::PermissionDenied { reason }
            if matches!(
                reason.as_str(),
                "sandbox desktop frame is stale or consumed"
                    | "sandbox desktop frame is stale or surface changed"
            ) =>
        {
            NativeInputError::refused("remote_desktop_input_stale_frame")
        }
        AutomationError::PermissionDenied { reason }
            if reason == "sandbox desktop input limit exceeded" =>
        {
            NativeInputError::refused("remote_desktop_input_invalid")
        }
        AutomationError::BackendError { message }
            if matches!(
                message.as_str(),
                "remote input point is outside the desktop surface"
                    | "remote pointer action requires a point"
                    | "click count must be between 1 and 3"
                    | "key chord is empty"
            ) =>
        {
            NativeInputError::refused("remote_desktop_input_invalid")
        }
        AutomationError::PermissionDenied { .. } | AutomationError::PreemptedBeforeSend => {
            NativeInputError::fatal(RemoteDesktopError::new("remote_desktop_control_expired"))
        }
        _ => NativeInputError::fatal(RemoteDesktopError::new("remote_desktop_native_unavailable")),
    }
}
impl FrameSource for Source {
    fn authorize(&self) -> FrameFuture<()> {
        let (registry, admission, principal, id, verified) = (
            self.registry.clone(),
            self.admission.clone(),
            self.principal.clone(),
            self.id.clone(),
            self.verified.clone(),
        );
        Box::pin(async move { admitted(&verified, &registry, &admission, &principal, &id).await })
    }
    fn capture(&self) -> FrameFuture<CapturedFrame> {
        let (registry, id, principal, admission, verified) = (
            self.registry.clone(),
            self.id.clone(),
            self.principal.clone(),
            self.admission.clone(),
            self.verified.clone(),
        );
        Box::pin(async move {
            admitted(&verified, &registry, &admission, &principal, &id).await?;
            let (frame, human) = registry
                .desktop_stream_frame(&id)
                .await
                .map_err(|_| RemoteDesktopError::new("remote_desktop_native_unavailable"))?;
            admitted(&verified, &registry, &admission, &principal, &id).await?;
            from_screenshot(frame.frame_id, frame.fence, frame.screenshot, human).await
        })
    }
}

/// One codec implementation for both native owners. Existing capture validates
/// PNG/JPEG pixels and their allocation limits before returning the screenshot.
struct Pixels {
    image: image::RgbImage,
    hash: [u8; 32],
}
impl FrameImage for Pixels {
    fn dimensions(&self) -> (u32, u32) {
        self.image.dimensions()
    }
    fn hash(&self) -> [u8; 32] {
        self.hash
    }
    fn jpeg(&self, quality: u8, width: u32, height: u32) -> Result<Vec<u8>> {
        let resized;
        let image = if (width, height) == self.image.dimensions() {
            &self.image
        } else {
            resized = image::imageops::resize(
                &self.image,
                width,
                height,
                image::imageops::FilterType::Triangle,
            );
            &resized
        };
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality)
            .encode_image(image)
            .map_err(|_| cognia_remote_desktop::frames::invalid())?;
        Ok(bytes)
    }
}
pub(crate) async fn from_screenshot(
    frame_id: String,
    fence: u64,
    screenshot: crate::automation::types::Screenshot,
    human_controlled: bool,
) -> Result<CapturedFrame> {
    tokio::task::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&screenshot.bytes)
            .map_err(|_| cognia_remote_desktop::frames::invalid())?;
        let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|_| cognia_remote_desktop::frames::invalid())?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(16384);
        limits.max_image_height = Some(16384);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        let image = reader
            .decode()
            .map_err(|_| cognia_remote_desktop::frames::invalid())?
            .into_rgb8();
        if image.dimensions() != (screenshot.width, screenshot.height) {
            return Err(cognia_remote_desktop::frames::invalid());
        }
        let hash = Sha256::digest(image.as_raw()).into();
        Ok(CapturedFrame {
            frame_id,
            fence,
            captured_at_ms: screenshot.captured_at.max(0) as u64,
            human_controlled,
            image: Arc::new(Pixels { image, hash }),
        })
    })
    .await
    .map_err(|_| cognia_remote_desktop::frames::invalid())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn provider_control_accepts_stream_proof_and_releases_after_close_or_revocation() {
        use cognia_remote_desktop::{
            commands::{dispatch, RemoteDesktopState},
            frames::NativeUiAction,
            host::RemoteDesktopHost,
        };
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use tokio::io::AsyncWriteExt;
        for revoke in [false, true] {
            let registry = CuaSandboxRegistry::default();
            let mut png = std::io::Cursor::new(Vec::new());
            image::RgbImage::new(20, 20)
                .write_to(&mut png, image::ImageFormat::Png)
                .unwrap();
            let pixels = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
            let inputs = Arc::new(AtomicUsize::new(0));
            let seen = inputs.clone();
            let client = super::super::remote_client::CuaRemoteClient::from_handler(Arc::new(
                move |request, _| {
                    let (pixels, seen) = (pixels.clone(), seen.clone());
                    Box::pin(async move {
                        if request.command == "screenshot" {
                            Ok(serde_json::json!({"status":"success","image_data":pixels}))
                        } else {
                            seen.fetch_add(1, Ordering::SeqCst);
                            Ok(serde_json::json!({"status":"success"}))
                        }
                    })
                },
            ));
            registry
                .insert_test_client("original/connection", client)
                .await;
            let admitted = Arc::new(AtomicBool::new(true));
            let admission = admitted.clone();
            let provider = CuaNativeFrameProvider::new(
                registry.clone(),
                Arc::new(move |_, _| admission.load(Ordering::SeqCst)),
            );
            let dir = tempfile::tempdir().unwrap();
            let host = RemoteDesktopHost::open(dir.path()).unwrap();
            host.register_native_frames("sandbox", Arc::new(provider))
                .unwrap();
            let state = RemoteDesktopState::from_host(host);
            let phone = Principal::device("phone", Arc::new(|_| true));
            let session = dispatch(&state, &phone, "remote_desktop_session_open", serde_json::json!({"targetId":"sandbox:original/connection","bindingId":"native","mode":"control","takeover":true})).await.unwrap();
            let sid = session["sessionId"].as_str().unwrap();
            let (mut viewer, pipe) =
                tokio::io::duplex(cognia_remote_desktop::bridge::MAX_FRAME_BYTES);
            state
                .host()
                .unwrap()
                .attach_viewer(&phone, sid, Box::new(pipe))
                .unwrap();
            let frame = cognia_remote_desktop::frames::read_frame(&mut viewer)
                .await
                .unwrap();
            let proof = cognia_remote_desktop::frames::FrameHeader::decode(&frame).unwrap();
            let input = NativeInput {
                point: None,
                frame_id: proof.frame_id.to_string(),
                action: NativeUiAction::PressKey {
                    chord: "Tab".into(),
                },
            };
            let valid = serde_json::to_vec(&input).unwrap();
            let stale = serde_json::to_vec(&NativeInput {
                frame_id: uuid::Uuid::new_v4().to_string(),
                ..input
            })
            .unwrap();
            for bytes in [&stale, &valid] {
                viewer.write_u32(bytes.len() as u32).await.unwrap();
                viewer.write_all(bytes).await.unwrap();
            }
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while inputs.load(Ordering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            if revoke {
                admitted.store(false, Ordering::SeqCst);
                viewer.write_u32(valid.len() as u32).await.unwrap();
                viewer.write_all(&valid).await.unwrap();
            } else {
                dispatch(
                    &state,
                    &phone,
                    "remote_desktop_session_close",
                    serde_json::json!({"sessionId":sid}),
                )
                .await
                .unwrap();
            }
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while registry
                    .desktop_guard("original/connection")
                    .await
                    .controller_expiry()
                    .is_some()
                {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }
    #[tokio::test]
    async fn native_control_requires_authority_and_fences_input_and_releases_on_drop() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let registry = CuaSandboxRegistry::default();
        let admitted = Arc::new(AtomicBool::new(true));
        let live = admitted.clone();
        let principal = Principal::device("phone", Arc::new(move |_| live.load(Ordering::SeqCst)));
        let provider = CuaNativeFrameProvider::new(registry.clone(), Arc::new(|_, _| true));
        let observer = Principal::device("observer", Arc::new(|mode| mode == SessionMode::View));
        assert!(provider
            .acquire_input("a".into(), observer, true)
            .await
            .is_err());
        assert!(provider
            .acquire_input("a".into(), principal.clone(), false)
            .await
            .is_err());
        // Seed the existing core without requiring a network capture. The sink
        // still goes through public input/renew/release and their proof checks.
        let lease = registry.desktop_guard("a").await.acquire().unwrap();
        let sink = Arc::new(InputSink {
            registry: registry.clone(),
            admission: Arc::new(|_, _| true),
            principal,
            id: "a".into(),
            lease: lease.clone(),
        });
        assert!(sink
            .input(NativeInput {
                point: None,
                frame_id: uuid::Uuid::new_v4().to_string(),
                action: cognia_remote_desktop::frames::NativeUiAction::TypeText {
                    text: "never sent".into()
                }
            })
            .await
            .is_err());
        sink.renew().await.unwrap();
        let worker = cognia_remote_desktop::frames::NativeInputLease::new(sink);
        let mut released = worker.released.clone();
        admitted.store(false, Ordering::SeqCst);
        drop(worker);
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            released.wait_for(|result| result.is_some()),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(released.borrow().as_ref().unwrap().is_ok());
        assert!(registry
            .renew_control("a", &lease.token, lease.fence)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn native_enumeration_preserves_original_ids_and_hides_foreign_owners() {
        let registry = CuaSandboxRegistry::default();
        registry.desktop_slot("Team/Alpha").await;
        registry.desktop_slot("Team_Alpha").await;
        assert_eq!(
            registry.native_connection_ids().await,
            ["Team/Alpha", "Team_Alpha"]
        );
        let provider = CuaNativeFrameProvider::new(registry, Arc::new(|_, _| false));
        assert!(provider.list(Principal::local()).await.unwrap().is_empty());
    }
    #[tokio::test]
    async fn broken_item_metadata_is_skipped_and_later_items_keep_their_original_ids() {
        use super::super::{
            lifecycle::StreamEndpoint,
            stream::{SelkiesApi, StreamBackend, StreamBackendHandle},
        };
        struct Metadata;
        #[async_trait::async_trait]
        impl StreamBackend for Metadata {
            async fn endpoint(
                &self,
                container: &str,
            ) -> crate::automation::types::Result<Option<StreamEndpoint>> {
                if container.ends_with("broken") {
                    Err(crate::automation::types::AutomationError::Internal {
                        message: "metadata unavailable".into(),
                    })
                } else {
                    Ok(None)
                }
            }
            fn api(
                &self,
                _: &StreamEndpoint,
            ) -> crate::automation::types::Result<Arc<dyn SelkiesApi>> {
                Err(crate::automation::types::AutomationError::Internal {
                    message: "not used for listing".into(),
                })
            }
        }
        let mut registry = CuaSandboxRegistry::default();
        registry.stream_backend = StreamBackendHandle(Arc::new(Metadata));
        let mut listed = Vec::new();
        for id in ["managed:invalid", "broken", "Team/Alpha"] {
            if let Some(target) = native_summary(&registry, id).await {
                listed.push(target);
            }
        }
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "Team/Alpha");
        assert!(!listed[0].selkies);
    }
    #[test]
    fn codec_encodes_real_jpeg_and_preserves_coordinate_extent() {
        let image = Pixels {
            image: image::RgbImage::new(100, 80),
            hash: [0; 32],
        };
        let bytes = image.jpeg(70, 50, 40).unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 50);
        assert_eq!(image.dimensions(), (100, 80));
    }
    #[tokio::test]
    async fn refuses_unauthorized_projection_without_connecting() {
        let provider =
            CuaNativeFrameProvider::new(CuaSandboxRegistry::default(), Arc::new(|_, _| false));
        assert!(provider
            .resolve("a".into(), Principal::local())
            .await
            .is_err());
    }
    #[test]
    fn shared_wire_fixture_contains_decodable_jpeg_pixels() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../cognia-remote-desktop/fixtures/frame-v1.json"
        ))
        .unwrap();
        let bytes = hex::decode(fixture["hex"].as_str().unwrap()).unwrap();
        let pixels =
            image::load_from_memory(&bytes[cognia_remote_desktop::frames::HEADER_BYTES..]).unwrap();
        assert_eq!((pixels.width(), pixels.height()), (2, 1));
    }
    #[tokio::test]
    async fn codec_preserves_proof_and_hashes_pixels_without_timestamp_or_frame_id() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbImage::new(2, 1)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
        let screenshot = |captured_at| crate::automation::types::Screenshot {
            bytes: bytes.clone(),
            width: 2,
            height: 1,
            captured_at,
            format: crate::automation::types::ImageFormat::Png,
            source_width: None,
            source_height: None,
        };
        let id = uuid::Uuid::new_v4();
        let first = from_screenshot(id.to_string(), 7, screenshot(1000), true)
            .await
            .unwrap();
        let second = from_screenshot(uuid::Uuid::new_v4().to_string(), 8, screenshot(2000), false)
            .await
            .unwrap();
        assert_eq!(first.image.hash(), second.image.hash());
        let bytes = cognia_remote_desktop::frames::encode_frame(&first).unwrap();
        let header = cognia_remote_desktop::frames::FrameHeader::decode(&bytes).unwrap();
        assert_eq!(header.frame_id, id);
        assert_eq!(header.fence, 7);
        assert_eq!(header.captured_at_ms, 1000);
        assert_eq!((header.width, header.height), (2, 1));
        assert_eq!(
            image::load_from_memory(&bytes[cognia_remote_desktop::frames::HEADER_BYTES..])
                .unwrap()
                .width(),
            2
        );
    }
}
