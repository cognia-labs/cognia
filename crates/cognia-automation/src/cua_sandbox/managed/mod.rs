//! Host-owned managed desktops (ADR-0233). GUI and delegated agent control
//! require current per-configuration qualification and explicit Host authority.
pub mod contracts;
pub mod frame_source;
pub mod evidence;
pub mod handoff;
pub mod journal;
pub mod provider;
pub mod operations;
pub mod service;

pub use contracts::*;
// Provider implementors need the boundary/report types used by the public
// ManagedDesktopProvider interface without a second dependency declaration.
pub use cognia_desktop_guest::observation::ProcessBoundaryReport;
pub use cognia_e2b::envd::EgressProbeReport;
pub use provider::{
    E2bDesktopProvider, FileManagedDesktopSecrets, ManagedDesktopImageVerifier,
    ManagedDesktopProvider, ManagedDesktopSecrets,
};
pub use service::{
    run_qualification_smoke, ExplicitPaidSmokeAuthorization, HandoffTransfer, ManagedDesktopService,
    ManagedDesktopSmokeHost,
};

pub use service::control::{
    run_control_qualification_smoke, ControlQualificationReceipt, ManagedControlAuthority,
    ManagedControlFrame, ManagedControlLease, ManagedControlStatus,
    ManagedControlInput, ManagedControlLeaseRef,
};

pub use service::qualification_runs::*;

pub use service::delegation::*;
pub use service::acceptance::*;
