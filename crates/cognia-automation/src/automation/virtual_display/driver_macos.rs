//! Developer ID beta: one runtime-resolved CGVirtualDisplay, 1080p at 1x.
//! The native bridge owns Objective-C objects and restores only its own changes.
//! Kept as a separate module because its ABI/session state is not a Parsec device.
use super::{AcquiredDisplay, ReleaseReason, VddDriver, VddError, VirtualDisplayHealth};
use parking_lot::Mutex;

#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(C)]
pub struct Geometry {
    pub display_id: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Geometry {
    fn valid(self) -> bool {
        self.display_id != 0
            && self.x == 0.0
            && self.y == 0.0
            && self.width == 1920.0
            && self.height == 1080.0
    }
}

/// `invalid` gates capture and input only while the lease it belongs to is
/// still up (or being torn down). Once the display is released the failure
/// moves to `last_error`, which health reports but nothing gates on: a dead
/// screen-off lease must never block automation on the physical display.
///
/// `driven_pid` is the application last prepared (moved and activated) on
/// this lease. Input is only posted while that application has keyboard focus
/// with its focused window on the owned display.
#[derive(Default)]
struct TargetState {
    geometry: Option<Geometry>,
    invalid: Option<String>,
    last_error: Option<String>,
    driven_pid: Option<u32>,
    generation: u64,
}
static TARGET: Mutex<TargetState> = Mutex::new(TargetState {
    geometry: None,
    invalid: None,
    last_error: None,
    driven_pid: None,
    generation: 0,
});

/// Serializes tests that swap the process-global `TARGET`.
#[cfg(test)]
pub(crate) static TARGET_TEST_LOCK: Mutex<()> = Mutex::new(());

fn error(code: i32) -> VddError {
    let (class, message) = match code {
        1 => (
            "unsupported",
            "macOS 14.4+ and CGVirtualDisplay runtime classes are required",
        ),
        2 => (
            "permission_missing",
            "Screen Recording and Accessibility must both be granted",
        ),
        3 => (
            "session_locked",
            "the console session must remain active and unlocked",
        ),
        4 => (
            "system_sleep",
            "the system slept; explicitly re-arm screen-off mode",
        ),
        5 => (
            "lid_closed",
            "screen-off beta requires the lid to stay open",
        ),
        6 => (
            "power_hold_failed",
            "could not install the system-sleep-only power assertion",
        ),
        7 => (
            "restore_failure",
            "could not restore the previous display or window layout",
        ),
        8 => (
            "capture_failure",
            "the owned display disappeared or its geometry changed",
        ),
        11 => (
            "unsupported",
            "this display layout cannot be safely restored; mirror sets are unsupported",
        ),
        12 => (
            "window_target_failure",
            "Cognia's own window is never moved onto the screen-off display",
        ),
        13 => (
            "window_target_failure",
            "the targeted application could not be brought to the front",
        ),
        14 => (
            "window_target_failure",
            "target an application (read its tree or capture its window) before sending input",
        ),
        15 => (
            "window_target_failure",
            "another application took keyboard focus; target the application again before input",
        ),
        9 => (
            "window_target_failure",
            "the target window could not be moved onto the owned display",
        ),
        _ => (
            "driver_failure",
            "CGVirtualDisplay could not create a 1920x1080 1x display",
        ),
    };
    VddError::Backend {
        class,
        message: message.into(),
    }
}

fn health(installed: bool, code: i32) -> VirtualDisplayHealth {
    VirtualDisplayHealth {
        backend: "macos-cgvirtualdisplay".into(),
        installed,
        available: installed && code == 0,
        driver_version: String::new(),
        active_monitor: String::new(),
        last_error: if code == 0 {
            String::new()
        } else {
            error(code).to_string()
        },
    }
}

pub fn probe_health() -> VirtualDisplayHealth {
    let mut health = health(native::installed(), native::check());
    if health.last_error.is_empty() {
        let state = TARGET.lock();
        if let Some(error) = state.invalid.as_ref().or(state.last_error.as_ref()) {
            health.last_error = error.clone();
        }
    }
    health
}

fn invalid_lease(state: &TargetState) -> Result<(), VddError> {
    match (&state.geometry, &state.invalid) {
        (Some(_), Some(message)) => Err(VddError::Backend {
            class: "capture_failure",
            message: message.clone(),
        }),
        _ => Ok(()),
    }
}

/// No fallback to another screen while an invalidated screen-off lease is
/// still up; the controller's next ping releases it. With no lease, `None`.
pub fn target() -> Result<Option<Geometry>, VddError> {
    let state = TARGET.lock();
    invalid_lease(&state)?;
    Ok(state.geometry)
}

pub fn generation() -> u64 {
    TARGET.lock().generation
}

/// Latch a failure on the live lease. Without one there is nothing to gate,
/// so the message is kept for health only.
pub fn invalidate(message: String) {
    let mut state = TARGET.lock();
    if state.geometry.is_some() {
        state.invalid = Some(message.clone());
    }
    state.last_error = Some(message);
}

/// Called immediately before AX input, tree reads and captures (no TCC cache).
pub fn validate_session() -> Result<(), VddError> {
    let geometry = target()?;
    if geometry.is_some() {
        let code = native::check();
        if code != 0 {
            return Err(error(code));
        }
    }
    Ok(())
}

pub fn input_generation() -> Result<Option<u64>, VddError> {
    let state = TARGET.lock();
    invalid_lease(&state)?;
    Ok(state.geometry.map(|_| state.generation))
}

/// Long drags/typing/key holds cannot cross a release or re-arm boundary,
/// including a kill switch whose display has already finished restoring.
pub fn validate_input_generation(expected: Option<u64>) -> Result<(), VddError> {
    if input_generation()? != expected {
        return Err(VddError::Backend {
            class: "cancelled",
            message: "screen-off display lease changed during input".into(),
        });
    }
    validate_input()
}

pub fn validate_input() -> Result<(), VddError> {
    validate_session()?;
    if target()?.is_some() {
        let (focused_pid, focused_inside) = native::input_state().map_err(error)?;
        let driven = TARGET.lock().driven_pid;
        let code = input_target_code(driven, std::process::id(), focused_pid, focused_inside);
        if code != 0 {
            return Err(error(code));
        }
    }
    Ok(())
}

/// Keystrokes go to whichever application has keyboard focus, so input is
/// posted only when that is the application being driven and its focused
/// window is on the owned display. Never Cognia itself: its window stays on
/// the physical screen.
fn input_target_code(driven: Option<u32>, own: u32, focused: u32, focused_inside: bool) -> i32 {
    match driven {
        None => 14,
        Some(pid) if pid == own => 12,
        Some(pid) if focused != pid => 15,
        Some(_) if !focused_inside => 9,
        Some(_) => 0,
    }
}

/// Record the application a successful prepare activated, unless the lease
/// changed meanwhile (a release or re-arm must not inherit it).
fn note_driven(pid: u32, generation: u64) {
    let mut state = TARGET.lock();
    if state.geometry.is_some() && state.generation == generation {
        state.driven_pid = Some(pid);
    }
}

fn point_in_target(
    target: Option<Geometry>,
    point: crate::automation::types::Point,
) -> Result<crate::automation::types::Point, VddError> {
    if target.is_some() && (!(0..1920).contains(&point.x) || !(0..1080).contains(&point.y)) {
        return Err(VddError::Backend {
            class: "coordinate_invalid",
            message: "point is outside the owned display".into(),
        });
    }
    Ok(point)
}

pub fn validate_point(
    point: crate::automation::types::Point,
) -> Result<crate::automation::types::Point, VddError> {
    point_in_target(target()?, point)
}

/// Move the targeted application's focused/main window onto the owned display
/// and bring it to the front; it becomes the application input is checked
/// against. There is no implicit target: pid `0` and Cognia's own pid are
/// refused (`window_target_failure`).
/// Origin (0,0), 1x pixels == global CGEvent points, so AX and screenshot input
/// use the same coordinates without double translating app-session points.
pub fn prepare_application(pid: u32) -> Result<(), VddError> {
    validate_session()?;
    if target()?.is_some() {
        let generation = generation();
        let code = native::prepare(pid);
        if code != 0 {
            return Err(error(code));
        }
        note_driven(pid, generation);
    }
    Ok(())
}

#[derive(Default)]
pub struct MacosVddDriver {
    handle: Option<usize>,
    cleanup_error: Option<String>,
}
impl VddDriver for MacosVddDriver {
    fn acquire(&mut self) -> Result<AcquiredDisplay, VddError> {
        let code = native::check();
        if code != 0 {
            return Err(error(code));
        }
        let (handle, geometry) = native::create().map_err(error)?;
        self.handle = Some(handle);
        self.cleanup_error = None;
        if !geometry.valid() {
            self.release(ReleaseReason::DriverLost);
            return Err(error(8));
        }
        let mut state = TARGET.lock();
        let generation = state.generation.wrapping_add(1);
        *state = TargetState {
            geometry: Some(geometry),
            invalid: None,
            last_error: None,
            driven_pid: None,
            generation,
        };
        Ok(AcquiredDisplay {
            label: geometry.display_id.to_string(),
            width: 1920,
            height: 1080,
        })
    }
    fn ping(&mut self) -> Result<(), VddError> {
        validate_session()?;
        let code = native::ping(self.handle.ok_or_else(|| error(8))?);
        if code != 0 {
            return Err(error(code));
        }
        Ok(())
    }
    fn release(&mut self, reason: ReleaseReason) {
        // Gate the owned display before native teardown so capture cannot
        // silently choose main; the health message stays the real cause.
        let previous_error = {
            let mut state = TARGET.lock();
            let previous = state.invalid.take();
            state.invalid = Some("screen-off display is being released".into());
            previous
        };
        let code = self.handle.take().map_or(0, native::release);
        self.cleanup_error = (code != 0)
            .then(|| error(code).to_string())
            .or(previous_error.clone());
        let failure = self.cleanup_error.clone().or(previous_error).or_else(|| {
            (reason == ReleaseReason::DriverLost)
                .then(|| "owned screen-off display lost; re-arm required".into())
        });
        let mut state = TARGET.lock();
        let generation = state.generation.wrapping_add(1);
        *state = TargetState {
            geometry: None,
            invalid: None,
            last_error: failure,
            driven_pid: None,
            generation,
        };
    }
    fn is_acquired(&self) -> bool {
        self.handle.is_some()
    }
    fn release_error(&self) -> Option<String> {
        self.cleanup_error.clone()
    }
}
impl Drop for MacosVddDriver {
    fn drop(&mut self) {
        if self.handle.is_some() {
            self.release(ReleaseReason::Shutdown);
        }
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::Geometry;
    unsafe extern "C" {
        fn cognia_vd_installed() -> bool;
        fn cognia_vd_check() -> i32;
        fn cognia_vd_create(geometry: *mut Geometry, code: *mut i32) -> usize;
        fn cognia_vd_ping(handle: usize) -> i32;
        fn cognia_vd_release(handle: usize) -> i32;
        fn cognia_vd_prepare(pid: u32) -> i32;
        fn cognia_vd_input_state(focused_pid: *mut u32, focused_inside: *mut bool) -> i32;
    }
    /// Which process has keyboard focus, and whether its focused window lies
    /// on the owned display.
    pub fn input_state() -> Result<(u32, bool), i32> {
        let mut focused_pid = 0;
        let mut focused_inside = false;
        let code = unsafe { cognia_vd_input_state(&mut focused_pid, &mut focused_inside) };
        if code == 0 {
            Ok((focused_pid, focused_inside))
        } else {
            Err(code)
        }
    }
    pub fn installed() -> bool {
        unsafe { cognia_vd_installed() }
    }
    pub fn check() -> i32 {
        unsafe { cognia_vd_check() }
    }
    pub fn create() -> Result<(usize, Geometry), i32> {
        let mut geometry = Geometry {
            display_id: 0,
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
        let mut code = 0;
        let handle = unsafe { cognia_vd_create(&mut geometry, &mut code) };
        if handle == 0 {
            Err(code)
        } else {
            Ok((handle, geometry))
        }
    }
    pub fn ping(handle: usize) -> i32 {
        unsafe { cognia_vd_ping(handle) }
    }
    pub fn release(handle: usize) -> i32 {
        unsafe { cognia_vd_release(handle) }
    }
    pub fn prepare(pid: u32) -> i32 {
        unsafe { cognia_vd_prepare(pid) }
    }
}
#[cfg(not(target_os = "macos"))]
mod native {
    use super::Geometry;
    pub fn input_state() -> Result<(u32, bool), i32> {
        Err(1)
    }
    pub fn installed() -> bool {
        false
    }
    pub fn check() -> i32 {
        1
    }
    pub fn create() -> Result<(usize, Geometry), i32> {
        Err(1)
    }
    pub fn ping(_: usize) -> i32 {
        1
    }
    pub fn release(_: usize) -> i32 {
        0
    }
    pub fn prepare(_: u32) -> i32 {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn virtual_display_geometry_is_fixed_and_global() {
        let g = Geometry {
            display_id: 42,
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        assert!(g.valid());
        assert!(!Geometry { display_id: 0, ..g }.valid());
        assert!(!Geometry { x: -1920.0, ..g }.valid());
        assert!(!Geometry { width: 3840.0, ..g }.valid());
    }
    #[test]
    fn virtual_display_coordinates_reject_other_screens_without_translating_ax_points() {
        use crate::automation::types::Point;
        let target = Some(Geometry {
            display_id: 42,
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        });
        for (x, y) in [(0, 0), (1919, 1079)] {
            let p = point_in_target(target, Point { x, y }).unwrap();
            assert_eq!((p.x, p.y), (x, y));
        }
        for (x, y) in [(-1, 0), (1920, 0), (0, -1), (0, 1080)] {
            assert!(point_in_target(target, Point { x, y }).is_err());
            assert!(point_in_target(None, Point { x, y }).is_ok());
        }
    }

    /// Swaps in a fresh `TARGET` and puts the old one back, holding the test
    /// lock so parallel tests never see another test's lease.
    struct Isolated(
        Option<TargetState>,
        #[allow(dead_code)] parking_lot::MutexGuard<'static, ()>,
    );
    impl Isolated {
        fn new() -> Self {
            let guard = TARGET_TEST_LOCK.lock();
            let previous = std::mem::take(&mut *TARGET.lock());
            Self(Some(previous), guard)
        }
    }
    impl Drop for Isolated {
        fn drop(&mut self) {
            if let Some(previous) = self.0.take() {
                *TARGET.lock() = previous;
            }
        }
    }

    const OWNED: Geometry = Geometry {
        display_id: 42,
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };

    #[test]
    fn virtual_display_failed_lease_does_not_block_automation_after_release() {
        let _isolated = Isolated::new();
        TARGET.lock().geometry = Some(OWNED);
        invalidate("capture_failure: no fresh frame".into());
        // While the dead lease is still up, nothing may fall back to main.
        assert!(target().is_err());
        assert!(input_generation().is_err());

        let mut driver = MacosVddDriver::default();
        driver.release(ReleaseReason::DriverLost);
        assert_eq!(
            driver.release_error().as_deref(),
            Some("capture_failure: no fresh frame")
        );
        // Physical-display automation works again without a re-arm ...
        assert_eq!(target().unwrap(), None);
        assert_eq!(input_generation().unwrap(), None);
        assert!(validate_input().is_ok());
        assert!(validate_point(crate::automation::types::Point { x: 4000, y: 10 }).is_ok());
        // ... and the cause is still reported to health.
        assert_eq!(
            TARGET.lock().last_error.as_deref(),
            Some("capture_failure: no fresh frame")
        );
    }

    #[test]
    fn virtual_display_input_goes_only_to_the_driven_application() {
        const OWN: u32 = 100;
        const APP: u32 = 200;
        // Nothing targeted yet: keystrokes would land in whatever is active.
        assert_eq!(input_target_code(None, OWN, OWN, false), 14);
        // Driven app in front with its focused window on the owned display.
        assert_eq!(input_target_code(Some(APP), OWN, APP, true), 0);
        // Cognia (or anything else) took focus back: refuse, do not type there.
        assert_eq!(input_target_code(Some(APP), OWN, OWN, false), 15);
        assert_eq!(input_target_code(Some(APP), OWN, 300, true), 15);
        // Driven app in front, but its focused window is on a physical screen.
        assert_eq!(input_target_code(Some(APP), OWN, APP, false), 9);
        // Cognia is never a screen-off target, even if recorded somehow.
        assert_eq!(input_target_code(Some(OWN), OWN, OWN, true), 12);
    }

    #[test]
    fn virtual_display_driven_application_belongs_to_one_lease() {
        let _isolated = Isolated::new();
        // No lease: nothing to record.
        note_driven(200, 0);
        assert_eq!(TARGET.lock().driven_pid, None);
        {
            let mut state = TARGET.lock();
            state.geometry = Some(OWNED);
            state.generation = 7;
        }
        // A prepare that started on an older lease must not leak into this one.
        note_driven(200, 6);
        assert_eq!(TARGET.lock().driven_pid, None);
        note_driven(200, 7);
        assert_eq!(TARGET.lock().driven_pid, Some(200));
        // Release forgets it; the next lease starts with no target.
        MacosVddDriver::default().release(ReleaseReason::Manual);
        assert_eq!(TARGET.lock().driven_pid, None);
    }

    #[test]
    fn virtual_display_invalidation_without_a_lease_is_health_only() {
        let _isolated = Isolated::new();
        invalidate("capture_failure: late".into());
        assert_eq!(target().unwrap(), None);
        assert_eq!(
            TARGET.lock().last_error.as_deref(),
            Some("capture_failure: late")
        );
    }

    #[test]
    fn virtual_display_input_stops_after_release_or_rearm_without_posting_native_events() {
        let _isolated = Isolated::new();
        TARGET.lock().generation = 42;
        // A completed release has no display, but an older operation must stop.
        assert!(validate_input_generation(Some(41))
            .unwrap_err()
            .to_string()
            .starts_with("cancelled:"));
        TARGET.lock().geometry = Some(Geometry {
            display_id: 42,
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        });
        // The same CG display ID in a new generation is still a different lease.
        assert!(validate_input_generation(Some(41)).is_err());
        assert!(validate_input_generation(None).is_err());
    }

    #[test]
    fn virtual_display_health_distinguishes_installation_and_readiness() {
        for code in 1..=15 {
            let h = health(code != 1, code);
            assert!(!h.available);
            assert_eq!(h.installed, code != 1);
            assert!(h.last_error.contains(':'));
            assert_eq!(h.backend, "macos-cgvirtualdisplay");
        }
        assert!(health(true, 0).available);
        assert!(!health(false, 0).available);
    }
    #[test]
    fn virtual_display_error_classes_are_actionable() {
        for (code, class) in [
            (1, "unsupported"),
            (2, "permission_missing"),
            (3, "session_locked"),
            (4, "system_sleep"),
            (5, "lid_closed"),
            (6, "power_hold_failed"),
            (7, "restore_failure"),
            (8, "capture_failure"),
            (9, "window_target_failure"),
            (11, "unsupported"),
            (12, "window_target_failure"),
            (13, "window_target_failure"),
            (14, "window_target_failure"),
            (15, "window_target_failure"),
        ] {
            assert!(error(code).to_string().starts_with(class));
        }
    }
}
