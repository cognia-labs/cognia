//! Managed native projections reuse the authenticated frame RPC's owner,
//! generation, qualification and live boundary checks. No input lease is minted.
use super::{ManagedControlAuthority, ManagedDesktopPrincipal, ManagedDesktopService};
use cognia_remote_desktop::{
    error::{RemoteDesktopError, Result},
    frames::{blocking, AdmissionCache, CapturedFrame, FrameFuture, FrameSource, NativeFrameProvider},
    session::{Principal, SessionMode},
};
use std::sync::Arc;

/// The Host must construct this from its authenticated identity store, using
/// the same principal mapping and live authority as managed_desktop_control_frame.
/// In particular this must not be an admin-lease issuer or a cached request DTO.
pub struct ManagedFrameContext {
    pub principal: ManagedDesktopPrincipal,
    pub authority: Arc<dyn ManagedControlAuthority>,
}
pub type ManagedFrameContextResolver =
    Arc<dyn Fn(Principal) -> FrameFuture<ManagedFrameContext> + Send + Sync>;
pub struct ManagedNativeFrameProvider {
    service: Arc<ManagedDesktopService>,
    context: ManagedFrameContextResolver,
}
impl ManagedNativeFrameProvider {
    pub fn new(service: Arc<ManagedDesktopService>, context: ManagedFrameContextResolver) -> Self {
        Self { service, context }
    }
}
struct Source {
    service: Arc<ManagedDesktopService>,
    context: ManagedFrameContextResolver,
    principal: Principal,
    id: String,
    generation: u64,
    access: Arc<Access>,
}
/// The viewer's resolved context and when its authority was last checked;
/// reused for one broker admission interval so a tick repeats no store work.
#[derive(Default)]
struct Access {
    verified: AdmissionCache,
    context: parking_lot::Mutex<Option<Arc<ManagedFrameContext>>>,
}
#[derive(Clone)]
struct Viewer {
    service: Arc<ManagedDesktopService>,
    resolve: ManagedFrameContextResolver,
    principal: Principal,
    id: String,
    generation: u64,
    access: Arc<Access>,
}
impl Viewer {
    /// The live context, revalidated (device admission, principal, desktop
    /// scope and qualification) at most once per admission interval.
    async fn admitted(&self) -> Result<Arc<ManagedFrameContext>> {
        if self.access.verified.fresh() {
            if let Some(context) = self.access.context.lock().clone() {
                return Ok(context);
            }
        }
        let outcome = async {
            let principal = self.principal.clone();
            blocking(move || check(&principal)).await?;
            let context = Arc::new((self.resolve)(self.principal.clone()).await?);
            self.service
                .native_frame_admission(
                    &context.principal,
                    &self.id,
                    self.generation,
                    context.authority.as_ref(),
                )
                .await
                .map_err(unavailable)?;
            Ok(context)
        }
        .await;
        match &outcome {
            Ok(context) => {
                *self.access.context.lock() = Some(context.clone());
                self.access.verified.mark();
            }
            Err(_) => {
                *self.access.context.lock() = None;
                self.access.verified.clear();
            }
        }
        outcome
    }
}
impl Source {
    fn viewer(&self) -> Viewer {
        Viewer {
            service: self.service.clone(),
            resolve: self.context.clone(),
            principal: self.principal.clone(),
            id: self.id.clone(),
            generation: self.generation,
            access: self.access.clone(),
        }
    }
}
fn check(principal: &Principal) -> Result<()> {
    if principal.admitted(SessionMode::View) {
        Ok(())
    } else {
        Err(RemoteDesktopError::new("remote_desktop_forbidden"))
    }
}
fn unavailable(_: super::ManagedDesktopError) -> RemoteDesktopError {
    RemoteDesktopError::new("remote_desktop_native_unavailable")
}
impl NativeFrameProvider for ManagedNativeFrameProvider {
    fn resolve(&self, id: String, principal: Principal) -> FrameFuture<Arc<dyn FrameSource>> {
        let (service, context) = (self.service.clone(), self.context.clone());
        Box::pin(async move {
            let admission = principal.clone();
            blocking(move || check(&admission)).await?;
            let ctx = context(principal.clone()).await?;
            let generation = service
                .native_frame_generation(&ctx.principal, &id, ctx.authority.as_ref())
                .await
                .map_err(unavailable)?;
            let source = Source {
                service,
                context,
                principal,
                id,
                generation,
                access: Arc::default(),
            };
            source.viewer().admitted().await?;
            Ok(Arc::new(source) as Arc<dyn FrameSource>)
        })
    }
}
impl FrameSource for Source {
    fn authorize(&self) -> FrameFuture<()> {
        let viewer = self.viewer();
        Box::pin(async move { viewer.admitted().await.map(|_| ()) })
    }
    fn capture(&self) -> FrameFuture<CapturedFrame> {
        let viewer = self.viewer();
        Box::pin(async move {
            let context = viewer.admitted().await?;
            let (frame, human) = viewer
                .service
                .native_stream_frame(
                    &context.principal,
                    &viewer.id,
                    viewer.generation,
                    context.authority.as_ref(),
                )
                .await
                .map_err(unavailable)?;
            viewer.admitted().await?;
            crate::cua_sandbox::frame_source::from_screenshot(
                frame.frame_id,
                frame.fence,
                frame.screenshot,
                human,
            )
            .await
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observation_admission_never_requests_control() {
        let principal = Principal::device("observer", Arc::new(|mode| mode == SessionMode::View));
        assert!(check(&principal).is_ok());
        assert!(!principal.admitted(SessionMode::Control));
        assert!(check(&Principal::device("revoked", Arc::new(|_| false))).is_err());
    }
}
