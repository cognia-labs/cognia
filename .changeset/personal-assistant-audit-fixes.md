---
"cognia-next": patch
---

Fix personal-assistant mode controllability, isolation, and durable delivery defects from the 2026-11-17 gap audit:

- Enforce mid-run responder tightening (`Silent`, `Draft`, `Muted`) across live-steer, follow-up controls, active connector run controllers, and pre-delivery checks (`F1`).
- Disclose per-category `shadow` observe-only recipient policy status directly in the Outbound Recipients editor (`F2`).
- Clarify `Silent` vs independent Workflow/Bot subscriptions, suppress proactive welcome cards while silent without burning one-time dedup keys, and connect conversation automation pause/resume/cancel and adapter host placement in Inbox controls (`F3`, `F4`, `F5`, `F9`).
- Fence Radar generation/suggestion writes and routed memory deletions against runtime account/target switches, propagate Radar cancellation signals, and preserve accepted legacy Radar reports during retention sweeps (`F11`, `F12`, `F22`, `F23`).
- Serialize draft approval/rejection/expiry state transitions, mint fresh outbound idempotency keys when approving held authorization drafts, fence stopped outbound runners before wire send, and classify non-idempotent stale sending jobs as `delivery_unknown` (`F13`, `F14`, `F20`, `F21`).
- Preserve paused scheduler task state on completion writeback, recover single-run retry timers across scheduler restarts, propagate abort signals and stable idempotency keys through scheduled outbound delivery, and broadcast recurring notification updates to paired devices (`F15`, `F16`, `F17`, `F18`, `F19`).
