---
"cognia-next": patch
---

Harden account sign-in, deletion, deployment validation, profile Vault isolation, and local recovery across Browser, Tauri, and Capacitor:

- Cancel Web popup/mobile OAuth sign-in cleanly on close or Stop, isolate per-flow OAuth state across platforms, and report callback/sign-out states accurately (F1, F3, F4, F5, F8, F17, F22, F23).
- Expose full cloud account sign-in, sign-out, and official deletion controls on mobile/narrow viewports, enforce cancellation and profile/session identity across official deletion re-authentication, refresh session/status on focus, distinguish `none` from `cancelled`, and disclose cloud sync space purge (F2, F9, F10, F11, F18, F19, F21).
- Validate cloud sessions and organization discovery against the configured deployment issuer/gateway and bind self-hosted sign-in/org switching to the selected profile (F20, F25).
- Prevent changing an inactive Browser profile's password from hijacking the active profile's Vault session, persist `"password"` protection when promoting a Capacitor device workspace, support Vault recovery-key unlock on Tauri and Capacitor with native host verifier/recovery-digest pinning, support crash-safe handover and rotation of profile recovery keys, harden Tauri password rotation atomicity, guard inactive desktop security forms, and fail closed when an encrypted database's Vault record is missing (F7, F13, F14, F15, F16, F24, C4).
