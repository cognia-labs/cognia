---
"cognia-next": patch
---

Fix personal-assistant mode controllability, isolation, and durable delivery defects from the 2026-11-17 gap audit:

- Enforce mid-run responder tightening (`Silent`, `Draft`, `Muted`) across live-steer, follow-up controls, active connector run controllers, and pre-delivery checks (`F1`).
- Default unset messaging outbound authorization to risk-stratified `enforce` for unattended runs and cross-conversation sends (while keeping in-thread replies unblocked), disclose `shadow` status, and add a one-click enforcement upgrade in Outbound Recipients (`F2`).
- Clarify `Silent` vs independent Workflow/Bot subscriptions, suppress proactive welcome cards while silent without burning one-time dedup keys, restrict `Draft` mode Team plan and Workflow launch approvals to operators, and surface delegation readiness checks and host placement in Inbox controls (`F3`, `F4`, `F5`, `F9`).
- Align Radar memory intake with standard recall governance, scrub sources deleted before commit, deduplicate overlapping same-account Radar runs with an explicit Force Regenerate escape hatch, ingest local high-value obligations, and notify when scheduled Radar runs surface actionable suggestions (`F6`, `B1`, `B2`, `B3`).
- Fence Radar generation/suggestion writes and routed memory deletions against runtime account/target switches, propagate Radar cancellation signals, and preserve accepted legacy Radar reports during retention sweeps (`F11`, `F12`, `F22`, `F23`).
- Serialize draft approval/rejection/expiry state transitions, mint fresh outbound idempotency keys when approving held authorization drafts, fence stopped outbound runners before wire send, and classify non-idempotent stale sending jobs as `delivery_unknown` (`F13`, `F14`, `F20`, `F21`).
- Preserve paused scheduler task state on completion writeback, recover single-run retry timers across scheduler restarts, propagate abort signals and stable idempotency keys through scheduled outbound delivery, and broadcast recurring notification updates to paired devices (`F15`, `F16`, `F17`, `F18`, `F19`).
