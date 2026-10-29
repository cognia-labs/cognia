//! Docker CUA's owner-backed native frame provider. Authorization is supplied
//! by the Host installation, rather than inferred from a caller-controlled id.
use super::CuaSandboxRegistry;
use base64::Engine as _;
use cognia_remote_desktop::{
    error::{RemoteDesktopError, Result},
    frames::{
        blocking, AdmissionCache, CapturedFrame, FrameFuture, FrameImage, FrameSource,
        NativeFrameProvider,
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
