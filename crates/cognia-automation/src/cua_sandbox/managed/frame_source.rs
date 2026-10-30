//! Managed native projections reuse the authenticated frame RPC's owner,
//! generation, qualification and live boundary checks for frames and control.
use super::{ManagedControlAuthority, ManagedDesktopPrincipal, ManagedDesktopService};
use cognia_remote_desktop::{
    error::{RemoteDesktopError, Result},
    frames::{
        blocking, AdmissionCache, CapturedFrame, FrameFuture, FrameSource, NativeFrameProvider,
        NativeInput, NativeInputSink, NativeProviderKind, NativeTargetSummary,
    },
    session::{Principal, SessionMode},
};
use std::sync::Arc;

/// The Host must construct this from its authenticated identity store, using
/// the same principal mapping and live authority as managed_desktop_control_frame.
/// In particular this must not be an admin-lease issuer or a cached request DTO.
pub struct ManagedFrameContext {
    pub principal: ManagedDesktopPrincipal,
    pub authority: Arc<dyn ManagedControlAuthority>,
    /// Host-owned human permission/consent pipeline, never observation authority.
    pub input_executor: ManagedInputExecutor,
}
pub struct ManagedNativeInput {
    pub desktop_id: String,
    pub generation: u64,
    pub lease: super::ManagedControlLease,
    pub input: NativeInput,
}
pub type ManagedInputExecutor = Arc<
    dyn Fn(ManagedNativeInput) -> cognia_remote_desktop::frames::NativeInputFuture + Send + Sync,
>;
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
    fn list(&self, principal: Principal) -> FrameFuture<Vec<NativeTargetSummary>> {
        let (service, resolve) = (self.service.clone(), self.context.clone());
        Box::pin(async move {
            let viewer = principal.clone();
            if blocking(move || check(&viewer)).await.is_err() {
                return Ok(Vec::new());
            }
            let context = match resolve(principal).await {
                Ok(context) => context,
                Err(error) if error.code == "remote_desktop_forbidden" => return Ok(Vec::new()),
                Err(error) => return Err(error),
            };
            context
                .authority
                .revalidate(&context.principal)
                .await
                .map_err(unavailable)?;
            let desktops = service
                .list(&context.principal)
                .await
                .map_err(unavailable)?;
            let mut targets = Vec::new();
            for row in desktops {
                if row.state != super::ManagedDesktopState::Running {
                    continue;
                }
                targets.push(NativeTargetSummary {
                    label: row.id.clone(),
                    id: row.id,
                    provider: NativeProviderKind::E2b,
                    selkies: false,
                });
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
        let (service, resolve) = (self.service.clone(), self.context.clone());
        Box::pin(async move {
            let viewer = principal.clone();
            blocking(move || {
                check(&viewer)?;
                if !viewer.admitted(SessionMode::Control) {
                    return Err(RemoteDesktopError::new("remote_desktop_forbidden"));
                }
                Ok(())
            })
            .await?;
            let context = Arc::new(resolve(principal.clone()).await?);
            let generation = service
                .native_frame_generation(&context.principal, &id, context.authority.as_ref())
                .await
                .map_err(unavailable)?;
            let lease = service
                .control_acquire(
                    &context.principal,
                    &id,
                    generation,
                    takeover,
                    context.authority.as_ref(),
                )
                .await
                .map_err(unavailable)?;
            Ok(Arc::new(InputSink {
                service,
                context,
                principal,
                id,
                generation,
                lease,
            }) as Arc<dyn NativeInputSink>)
        })
    }
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

#[derive(Clone)]
struct InputSink {
    service: Arc<ManagedDesktopService>,
    context: Arc<ManagedFrameContext>,
    principal: Principal,
    id: String,
    generation: u64,
    lease: super::ManagedControlLease,
}
impl InputSink {
    async fn admitted(&self) -> Result<()> {
        let viewer = self.principal.clone();
        blocking(move || {
            if viewer.admitted(SessionMode::Control) {
                Ok(())
            } else {
                Err(RemoteDesktopError::new("remote_desktop_forbidden"))
            }
        })
        .await?;
        self.context
            .authority
            .revalidate(&self.context.principal)
            .await
            .map_err(unavailable)
    }
}
impl NativeInputSink for InputSink {
    fn fence(&self) -> u64 {
        self.lease.fence
    }
    fn input(&self, input: NativeInput) -> cognia_remote_desktop::frames::NativeInputFuture {
        let sink = self.clone();
        Box::pin(async move {
            sink.admitted()
                .await
                .map_err(cognia_remote_desktop::frames::NativeInputError::fatal)?;
            let (frame_id, point, action) =
                crate::cua_sandbox::frame_source::local_input(input.clone()).map_err(|_| {
                    cognia_remote_desktop::frames::NativeInputError::refused(
                        "remote_desktop_input_invalid",
                    )
                })?;
            sink.service
                .native_input_check(
                    &sink.context.principal,
                    &sink.id,
                    sink.generation,
                    &super::ManagedControlInput {
                        token: &sink.lease.token,
                        fence: sink.lease.fence,
                        frame_id: &frame_id,
                        point,
                        action,
                    },
                )
                .await
                .map_err(|error| {
                    cognia_remote_desktop::frames::NativeInputError::managed(&error.code)
                })?;
            (sink.context.input_executor)(ManagedNativeInput {
                desktop_id: sink.id,
                generation: sink.generation,
                lease: sink.lease,
                input,
            })
            .await
        })
    }
    fn renew(&self) -> FrameFuture<()> {
        let sink = self.clone();
        Box::pin(async move {
            sink.admitted().await?;
            sink.service
                .control_renew(
                    &sink.context.principal,
                    &sink.id,
                    sink.generation,
                    &sink.lease.token,
                    sink.lease.fence,
                    sink.context.authority.as_ref(),
                )
                .await
                .map_err(unavailable)?;
            Ok(())
        })
    }
    fn release(&self) -> FrameFuture<()> {
        let sink = self.clone();
        Box::pin(async move {
            sink.service
                .native_control_release(
                    &sink.context.principal,
                    &sink.id,
                    sink.generation,
                    &sink.lease.token,
                    sink.lease.fence,
                )
                .await
                .map_err(unavailable)
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
    use cognia_remote_desktop::frames::{NativeInputError, NativeUiAction};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    struct LiveAuthority {
        live: Arc<AtomicBool>,
        identity: Arc<AtomicU64>,
        epoch: u64,
    }
    #[async_trait::async_trait]
    impl ManagedControlAuthority for LiveAuthority {
        async fn revalidate(&self, _: &ManagedDesktopPrincipal) -> super::super::Result<()> {
            if self.live.load(Ordering::SeqCst)
                && self.identity.load(Ordering::SeqCst) == self.epoch
            {
                Ok(())
            } else {
                Err(super::super::refused("managed_desktop_forbidden"))
            }
        }
        fn input_admission(
            &self,
            _: &ManagedDesktopPrincipal,
        ) -> Arc<dyn Fn() -> bool + Send + Sync> {
            let (live, identity, epoch) = (self.live.clone(), self.identity.clone(), self.epoch);
            Arc::new(move || {
                live.load(Ordering::SeqCst) && identity.load(Ordering::SeqCst) == epoch
            })
        }
    }
    #[tokio::test]
    async fn provider_acquires_accepts_stream_proof_and_releases_on_close_revocation_and_identity_change(
    ) {
        use cognia_remote_desktop::{
            commands::dispatch, commands::RemoteDesktopState, host::RemoteDesktopHost,
        };
        use tokio::io::AsyncWriteExt;
        for ending in ["close", "revoke", "identity"] {
            let (_directory, service, p, row, inputs) =
                super::super::service::control::native_test_fixture().await;
            let live = Arc::new(AtomicBool::new(true));
            let identity = Arc::new(AtomicU64::new(1));
            let authority = Arc::new(LiveAuthority {
                live: live.clone(),
                identity: identity.clone(),
                epoch: 1,
            });
            let (context_service, principal, context_authority) =
                (service.clone(), p.clone(), authority.clone());
            let provider = ManagedNativeFrameProvider::new(
                service.clone(),
                Arc::new(move |_| {
                    let (service, principal, authority) = (
                        context_service.clone(),
                        principal.clone(),
                        context_authority.clone(),
                    );
                    let (input_service, input_p, input_authority) =
                        (service.clone(), principal.clone(), authority.clone());
                    Box::pin(async move {
                        Ok(ManagedFrameContext {
                            principal,
                            authority,
                            input_executor: Arc::new(move |request| {
                                let (service, p, authority) = (
                                    input_service.clone(),
                                    input_p.clone(),
                                    input_authority.clone(),
                                );
                                Box::pin(async move {
                                    let (frame_id, point, action) =
                                        crate::cua_sandbox::frame_source::local_input(
                                            request.input,
                                        )
                                        .map_err(NativeInputError::fatal)?;
                                    service
                                        .native_control_input(
                                            &p,
                                            &request.desktop_id,
                                            request.generation,
                                            super::super::ManagedControlInput {
                                                token: &request.lease.token,
                                                fence: request.lease.fence,
                                                frame_id: &frame_id,
                                                point,
                                                action,
                                            },
                                            authority.as_ref(),
                                        )
                                        .await
                                        .map_err(|error| NativeInputError::managed(&error.code))
                                })
                            }),
                        })
                    })
                }),
            );
            let host_dir = tempfile::tempdir().unwrap();
            let host = RemoteDesktopHost::open(host_dir.path()).unwrap();
            host.register_native_frames("managed-desktop", Arc::new(provider))
                .unwrap();
            let host = RemoteDesktopState::from_host(host);
            let phone = Principal::device("phone", Arc::new(|_| true));
            let target = format!("managed-desktop:{}", row.id);
            let session = dispatch(&host, &phone, "remote_desktop_session_open", serde_json::json!({"targetId":target,"bindingId":"native","mode":"control","takeover":true})).await.unwrap();
            let sid = session["sessionId"].as_str().unwrap();
            let (mut viewer, pipe) =
                tokio::io::duplex(cognia_remote_desktop::bridge::MAX_FRAME_BYTES);
            host.host()
                .unwrap()
                .attach_viewer(&phone, sid, Box::new(pipe))
                .unwrap();
            let frame = cognia_remote_desktop::frames::read_frame(&mut viewer)
                .await
                .unwrap();
            let proof = cognia_remote_desktop::frames::FrameHeader::decode(&frame).unwrap();
            let write = |id: String| {
                serde_json::to_vec(&NativeInput {
                    point: None,
                    frame_id: id,
                    action: NativeUiAction::PressKey {
                        chord: "Tab".into(),
                    },
                })
                .unwrap()
            };
            let stale = write(uuid::Uuid::new_v4().to_string());
            viewer.write_u32(stale.len() as u32).await.unwrap();
            viewer.write_all(&stale).await.unwrap();
            let valid = write(proof.frame_id.to_string());
            viewer.write_u32(valid.len() as u32).await.unwrap();
            viewer.write_all(&valid).await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while inputs.load(Ordering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            if ending == "close" {
                dispatch(
                    &host,
                    &phone,
                    "remote_desktop_session_close",
                    serde_json::json!({"sessionId":sid}),
                )
                .await
                .unwrap();
            } else {
                if ending == "revoke" {
                    live.store(false, Ordering::SeqCst);
                } else {
                    identity.fetch_add(1, Ordering::SeqCst);
                }
                viewer.write_u32(valid.len() as u32).await.unwrap();
                viewer.write_all(&valid).await.unwrap();
            }
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                loop {
                    if service
                        .control_status(&p, &row.id, row.generation)
                        .await
                        .unwrap()
                        .lease_expires_at
                        .is_none()
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }
    #[tokio::test]
    async fn policy_refusals_before_any_send_retain_control_but_partial_sends_quarantine() {
        struct InputPolicy {
            allowed: Arc<AtomicBool>,
            deny_on_send: Arc<AtomicU64>,
        }
        #[async_trait::async_trait]
        impl ManagedControlAuthority for InputPolicy {
            async fn revalidate(&self, _: &ManagedDesktopPrincipal) -> super::super::Result<()> {
                if self.allowed.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err(super::super::refused(
                        "managed_desktop_control_policy_denied",
                    ))
                }
            }
            fn input_admission(
                &self,
                _: &ManagedDesktopPrincipal,
            ) -> Arc<dyn Fn() -> bool + Send + Sync> {
                let allowed = self.allowed.clone();
                let deny_on_send = self.deny_on_send.clone();
                let checked = AtomicU64::new(0);
                Arc::new(move || {
                    let deny_at = deny_on_send.load(Ordering::SeqCst);
                    if deny_at > 0 && checked.fetch_add(1, Ordering::SeqCst) + 1 >= deny_at {
                        allowed.store(false, Ordering::SeqCst);
                    }
                    allowed.load(Ordering::SeqCst)
                })
            }
        }
        for boundary in ["capture", "first-send", "partial-send"] {
            let allowed = Arc::new(AtomicBool::new(true));
            let armed = Arc::new(AtomicBool::new(false));
            let deny_on_send = Arc::new(AtomicU64::new(0));
            let (capture_policy, capture_armed) = (allowed.clone(), armed.clone());
            let (_directory, service, p, row, inputs) =
                super::super::service::control::native_test_fixture_with_capture(Arc::new(
                    move || {
                        if capture_armed.swap(false, Ordering::SeqCst) {
                            capture_policy.store(false, Ordering::SeqCst);
                        }
                    },
                ))
                .await;
            let authority = Arc::new(LiveAuthority {
                live: Arc::new(AtomicBool::new(true)),
                identity: Arc::new(AtomicU64::new(1)),
                epoch: 1,
            });
            let (input_service, input_p) = (service.clone(), p.clone());
            let input_authority = Arc::new(InputPolicy {
                allowed: allowed.clone(),
                deny_on_send: deny_on_send.clone(),
            });
            let executor: ManagedInputExecutor = Arc::new(move |request| {
                let (service, p, authority) = (
                    input_service.clone(),
                    input_p.clone(),
                    input_authority.clone(),
                );
                Box::pin(async move {
                    let (frame_id, point, action) =
                        crate::cua_sandbox::frame_source::local_input(request.input)
                            .map_err(NativeInputError::fatal)?;
                    service
                        .native_control_input(
                            &p,
                            &request.desktop_id,
                            request.generation,
                            super::super::ManagedControlInput {
                                token: &request.lease.token,
                                fence: request.lease.fence,
                                frame_id: &frame_id,
                                point,
                                action,
                            },
                            authority.as_ref(),
                        )
                        .await
                        .map_err(|error| NativeInputError::managed(&error.code))
                })
            });
            let principal = Principal::device("phone", Arc::new(|_| true));
            let provider = ManagedNativeFrameProvider::new(
                service.clone(),
                Arc::new({
                    let p = p.clone();
                    move |_| {
                        let context = ManagedFrameContext {
                            principal: p.clone(),
                            authority: authority.clone(),
                            input_executor: executor.clone(),
                        };
                        Box::pin(async move { Ok(context) })
                    }
                }),
            );
            let sink = provider
                .acquire_input(row.id.clone(), principal.clone(), true)
                .await
                .unwrap();
            let source = provider.resolve(row.id.clone(), principal).await.unwrap();
            let frame = source.capture().await.unwrap();
            if boundary == "capture" {
                armed.store(true, Ordering::SeqCst);
            } else {
                deny_on_send.store(
                    if boundary == "first-send" { 1 } else { 2 },
                    Ordering::SeqCst,
                );
            }
            let result = sink
                .input(NativeInput {
                    point: (boundary == "partial-send")
                        .then_some(cognia_remote_desktop::frames::NativePoint { x: 1, y: 1 }),
                    frame_id: frame.frame_id,
                    action: if boundary == "partial-send" {
                        NativeUiAction::Scroll {
                            opts: cognia_remote_desktop::frames::NativeScrollOptions {
                                dx: 0,
                                dy: 1,
                            },
                        }
                    } else {
                        NativeUiAction::PressKey {
                            chord: "Tab".into(),
                        }
                    },
                })
                .await
                .unwrap_err();
            if boundary == "partial-send" {
                assert!(result.fatal);
                assert_eq!(inputs.load(Ordering::SeqCst), 1);
                assert_eq!(
                    service
                        .control_status(&p, &row.id, row.generation)
                        .await
                        .unwrap()
                        .state,
                    "quarantined"
                );
                continue;
            }
            assert!(!result.fatal, "{boundary}: {result:?}");
            assert_eq!(result.error.code, "remote_desktop_input_policy_denied");
            assert_eq!(inputs.load(Ordering::SeqCst), 0);
            assert!(service
                .control_status(&p, &row.id, row.generation)
                .await
                .unwrap()
                .lease_expires_at
                .is_some());
            allowed.store(true, Ordering::SeqCst);
            deny_on_send.store(0, Ordering::SeqCst);
            let frame = source.capture().await.unwrap();
            sink.input(NativeInput {
                point: None,
                frame_id: frame.frame_id,
                action: NativeUiAction::PressKey {
                    chord: "Tab".into(),
                },
            })
            .await
            .unwrap();
            assert_eq!(inputs.load(Ordering::SeqCst), 1);
            sink.release().await.unwrap();
        }
    }
    #[test]
    fn observation_admission_never_requests_control() {
        let principal = Principal::device("observer", Arc::new(|mode| mode == SessionMode::View));
        assert!(check(&principal).is_ok());
        assert!(!principal.admitted(SessionMode::Control));
        assert!(check(&Principal::device("revoked", Arc::new(|_| false))).is_err());
    }
}
