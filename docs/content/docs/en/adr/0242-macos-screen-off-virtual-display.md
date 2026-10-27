---
title: "0242 — macOS screen-off virtual display"
description: "A Developer ID beta uses one runtime-resolved CGVirtualDisplay and explicit ScreenCaptureKit targeting while the unlocked Mac keeps computing with its physical panel asleep."
---

# ADR 0242 — macOS screen-off virtual display

**Status:** Accepted (beta)
**Date:** 2026-10-27
**Related:** ADR-0020 (Computer Use), ADR-0196 (crate ownership)
**Research:** `docs/research/2026-10-27-screen-off-macos-linux-feasibility.md`, sections 1–3, 5–6

## Context

Windows screen-off mode owns a Parsec virtual display. The macOS backend previously captured `CGMainDisplayID()` through `SCScreenshotManager`; keeping the CPU awake does not guarantee that a sleeping physical display retains a capturable surface. Creating a virtual display is necessary infrastructure, but cannot prove that synthetic input leaves the physical panel dark.

Acceptance has two independent conditions: the real Cognia backend must capture fresh frames from the intended target and drive that target correctly; the physical panel must stay off throughout input. Unit tests do not establish either hardware condition.

## Decision

Ship a restricted **Developer ID beta**, outside the Mac App Store. Resolve `CGVirtualDisplay`, `CGVirtualDisplayDescriptor`, `CGVirtualDisplaySettings`, and `CGVirtualDisplayMode` with `NSClassFromString`. There are no private-class linker references. Missing classes, unsupported macOS versions (capture requires 14.4+), or incompatible selectors deny acquisition rather than crashing.

The process owns exactly **one 1920×1080 display at 1× scale**. No resolution controls, Retina variants, lid-closed operation, or Linux backend are included. The session must stay unlocked, active on the console, with Screen Recording and Accessibility granted. Lid closure, session resignation, permission revocation and system sleep deny further capture/input and invalidate the active display. Resume/unlock requires an explicit new arm. The backend does not lock/unlock the session or force physical display sleep.

Reuse the crate's controller, 100 ms health cadence and five-minute idle timeout. Driver selection uses `macos-cgvirtualdisplay`; Windows retains `windows-parsec-vdd`; other platforms report `unsupported`. `installed` means the runtime classes exist. `available` additionally requires the supported OS and a permission-ready, unlocked, lid-open session; it is permission to try, not hardware certification. macOS setup checks readiness and never launches the Windows installer.

### Window and coordinate strategy

Save active display origins, reject mirror sets whose configuration cannot be restored by origin changes, then make the owned display primary at global `(0,0)`. Translate existing display origins to the right of the owned surface, preserving their relative positions, modes, scale and rotation. Release restores only the saved origins of still-online displays and removes only the owned virtual display. Missing original displays produce a restore failure.

A new primary does not automatically move an existing application. Only an explicitly targeted application moves: tree reads, element resolves and application-window captures move that application's focused/main window onto the owned surface. A display capture moves nothing, and Cognia's own window is never moved (`window_target_failure`), so the host window and its emergency stop stay on the physical screen. Preserve each moved window's first position and size; translate physical-display positions back through the saved layout offset for restoration. Resize only when necessary to fit. Refuse windows that do not support moving/resizing or cannot be verified entirely inside the virtual bounds. Full-screen windows and mirror sets are outside this beta's supported configurations.

Because the owned origin is `(0,0)` and scale is 1×, screenshot pixels, AX points and CGEvent global points coincide. Explicit pointer coordinates outside the surface are rejected. Preparing an application also brings it to the front (verified by reading the focused application back through AX), and it becomes the lease's driven application. Input checks the live session, that the application with keyboard focus is the driven one, and that its focused window is on the owned display. Nothing targeted yet, focus taken by another application (including Cognia), or a focused window on a physical screen all refuse with `window_target_failure`; input is never silently typed into another application or screen. A release or re-arm forgets the driven application. AX semantic actions prepare their resolved application first. Restore physical origins before restoring the moved windows. Layout changes are app-scoped (`kCGConfigureForAppOnly`): WindowServer reverts the shifted origins when the process exits, whatever the exit path.

### Capture, identity and ownership

Owned-display captures explicitly pass its `CGDirectDisplayID` into ScreenCaptureKit. Use `SCStream`, require a new complete frame, and reject idle/blank/suspended samples. No physical-display fallback is permitted. Validate display identity, geometry, scale and lifecycle generation after capture. Application-window streams carry the same display identity and generation checks.

The settings probe takes an exclusive controller lease. If an action already owns the display, the probe reports busy without capturing or releasing it. A probe also prevents action acquisition until its lease ends. Cancellation/error drops the lease; a stale lease cannot release a later generation. The probe's monitor label is the verified display identity; `nonBlack` remains the legacy encoded-size heuristic for compatibility, not evidence of freshness, correct input or panel darkness. Windows probes now select the exact owned GDI display name, with no unknown-monitor fallback.

### Power and failure classes

The native bridge takes a dedicated, checked `PreventUserIdleSystemSleep` IOKit assertion. It never requests a display assertion or declares user activity. This follows `cognia-power`'s System semantics but is independently owned: its current aggregate `acquire()` is best effort and cannot establish readiness. Keeping the small assertion with the native resource avoids a new workspace dependency/lockfile change; a failed assertion denies acquisition as `power_hold_failed`. Other subsystems' assertions are neither removed nor weakened. Any display-level assertion they hold can prevent physical display sleep and must be recorded during acceptance.

Errors retain distinct classes: `unsupported`, `permission_missing`, `session_locked`, `system_sleep`, `lid_closed`, `power_hold_failed`, `capture_failure`, `window_target_failure`, `coordinate_invalid`, `driver_failure`, and `restore_failure`. Cleanup failure survives in controller health after the display is gone. A failure gates capture and input only while its lease is up; once the display is released it is reported to health but no longer blocks automation on the physical display, so a failed arm or probe never needs a successful re-arm to recover. Releasing a mouse button and reading the cursor position are never gated, so a release always reaches the OS.

Kill switch, session close, idle timeout and controller shutdown call the same driver release. A native normal-exit terminator also restores the owned state when process exit bypasses Rust managed-state drops. After SIGKILL/crash, WindowServer drops the owned display and reverts the app-scoped origins, and IOKit drops the assertion; moved windows are not restored. It remains a hardware recovery test.

## Rejected alternatives

- **Public APIs only:** no public API creates the required software display for the current logged-in desktop.
- **Dummy plug:** useful as a separately tested external output, but not a zero-hardware owned backend and not part of this beta.
- **Mac App Store:** private API use is incompatible with the chosen distribution channel.
- **Only making the virtual display primary:** existing task windows may remain on the physical screen; explicit window migration is required.
- **Only keeping the machine awake or capturing the physical screen:** does not establish a retained render surface or panel darkness.

## Hardware acceptance plan

Run the research section 6 plan through a genuinely signed Tauri Developer ID build, on the minimum supported and target stable macOS versions, primarily Apple Silicon and Intel if still supported. Record exact hardware, OS/build, signing identity, permissions, display layout and power assertions. No such run is claimed by this ADR.

Use a controlled app with a ticking clock, per-round nonce, click counter, text field and drag target. Each condition runs for 30 minutes: sample once a second; perform at least 300 click/type/scroll/drag operations; check the final application state; record target ID, generation, geometry, frame time, errors and input results. An external camera/light sensor must prove continuous panel darkness. Then wait over five minutes without actions and verify idle release.

Test separately:

1. Lit baseline; display sleep (`caffeinate -i -t 1800` plus `pmset displaysleepnow`, with lock disabled only in the controlled test account); external monitor power-off; and cable unplug. Never accept an old frame or silently switch outputs.
2. Sidecar, DisplayLink and another virtual display, each with different nonces, including reconnects. Reject unsupported mirror layouts honestly.
3. Permission deny/revoke/regrant and app restart; lock/unlock; explicit system sleep/resume; lid closure on AC and battery. Lid closure must stop the beta, not be reported as successful operation.
4. Kill switch, session close, normal exit, forced kill and crash. Verify owned-display removal, assertion release, primary/origins/modes/scale/rotation and moved-window restoration. Missing original outputs must report degraded restoration.
5. Input during every display-sleep condition, watched externally for any panel wake. A functioning virtual capture alone does not pass this condition.

## Consequences

Private API compatibility can regress with a macOS update. The beta deliberately fails closed on ambiguous targets and unsupported layouts/windows. Desktop layout changes are visible while armed. Automated pure/fake-driver tests establish contracts and compilation; fresh-frame/input correctness, physical darkness and recovery need the hardware runs above before claiming parity with Windows.
