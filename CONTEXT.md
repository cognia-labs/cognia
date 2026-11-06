# CONTEXT — Mobile App & Settings

Domain language and load-bearing decisions for the Capacitor mobile shell and its
settings surface. Keep this glossary stable; flag any usage that conflicts with it.

## Glossary

### Mobile runtime mode

The phone runs in exactly one of two modes (persisted as `AppSettings.mobileRuntimeMode`,
device-local, never synced):

- **Standalone (BYOK)** — the phone is self-sufficient with no paired desktop. Chat
  runs _in the webview_ via `lib/ai/chat/standalone-engine.ts`. Settings are written
  to the local Dexie `settings` row / `providerSettings` and consumed locally.
- **Paired (companion)** — the phone is a remote client of a Tauri desktop. Chat and
  agent work execute on the desktop sidecar; the phone pulls per-table deltas
  (`lib/sync/companion-sync.ts`) and pushes setting edits via the companion
  `app_settings_update` RPC.

### Standalone engine capability boundary _(load-bearing — verified 2026-06-28)_

`standalone-engine.ts` is a plain AI SDK `streamText` call. It consumes **only**
`sendOptions.model` and the composed **system prompt**. It does **NOT** run tools,
MCP, an agent loop, permission modes, `autoMode`, `toolFilter`, or thinking budget.
=> Any "agent-ish" setting exposed on a _standalone_ phone has no consumer today and
would be dead UI unless the engine is first extended to a real agent loop.

### Mobile settings surface

The `/me` route (NOT desktop `/settings`) is the phone's settings center: a data-driven
iOS-style list (`components/mobile/me/me-entries.ts`) of 24+ `/me/*` sub-pages, with
search, favorites (long-press pin), and 6 groups (account / appearance / connection /
automation / data / about). Some sub-pages embed the shared desktop section component
(e.g. `/me/appearance` → `<AppearanceSection/>`); others are mobile-native pages.

### Cross-platform setting sync (asymmetric) _(verified 2026-06-28)_

- Desktop → phone mirrors **19** keys (`CROSS_PLATFORM_SETTING_KEYS` in
  `lib/sync/handlers/app-settings.ts`): includes the agent fields autoMode,
  permissionMode, defaultSystemPrompt, defaultMaxThinkingTokens, bareMode,
  debugMode, briefMode.
- Phone → desktop allows **~36** keys (`APP_SETTINGS_MOBILE_ALLOWED_KEYS` in
  `crates/cognia-companion-rpc/src/rpc.rs`): appearance, webrtc, tts, search, model
  default, conversation, sidebar/pins, telemetry, mic — all non-credential
  preference fields. Enforced server-side (400 on a disallowed key) with
  OpenAPI spec-parity + Rust unit tests.
- **The precise asymmetry**: the agent fields (autoMode, permissionMode,
  defaultSystemPrompt, defaultMaxThinkingTokens, bareMode/debugMode/briefMode)
  sync DOWN but are NOT in the write allowlist — the phone sees them but cannot
  edit them back. Enabling D2's paired remote-edit = add these to the Rust
  allowlist + OpenAPI + tests.
- **Hard security boundary (keep)**: apiKey, apiBaseUrl, provider config,
  sidecarPath, transport keys are asserted _non-writable_ from mobile by Rust
  tests. BYOK provider keys on mobile are device-local (`/me/providers`), never
  synced, never remotely writable.

### Multi-user Host _(ADR-0149, ADR-0253)_

**Host**:
The process that runs chats, agents and sync for the devices paired with it: the desktop app or a headless `cognia-server`. In multi-tenant mode (`COGNIA_DEPLOYMENT_MODE`) one Host serves several members, each in their own partition.
_Avoid_: server (for the Host; the collaboration server is a separate service), desktop (when any Host is meant)

**Person**:
A human being: a `User` with a `usr_` id. A person has many devices and may belong to several organizations.
_Avoid_: account (ADR-0149 froze its four meanings), user (for a device or a local profile), device (for the person behind it)

**Member**:
A person who holds a role in an organization (owner, admin or member) or in a workspace (maintainer, member or viewer). On a multi-tenant Host, a member is a person whose devices reach the Host through their partition, not as the operator. "Member" is also the lowest organization role; say "org member role" when the role is meant.
_Avoid_: tenant (for the person), guest (for someone with only a session or workspace role and no organization membership)

**Standing**:
What the collaboration server says a person currently is in an organization: a member with a role, not a member, in a suspended organization, or unresolved (the server could not be asked). A Host learns it from one authority, cached or fresh, and from the standing-change stream; every partition effect answers to it.
_Avoid_: permission (standing is the input; actions are derived from it)

**Partition**:
Everything a multi-tenant Host keeps for one person: a data root encrypted under that person's key, a brain process, a personal sandbox workspace, usage ledger rows and the sessions that person owns. A purge removes all of it.
_Avoid_: tenant (for the partition), account (for its data root)

**Principal**:
Who an authenticated request acts as. On a Host: a paired device, which acts for the person it is bound to (ES256 + DPoP); a person brain, which acts for one partition (a `person-brain` token); or the service plane (the internal service credential). Each check names the principals it accepts; a person brain never passes a check that accepts the service.
_Avoid_: user (for the principal), "the principal is the device" (a device acts for its person)

**Tenant**:
The unit a deployment isolates and accounts for: an organization. A multi-tenant Host is one where several members, possibly of several organizations, share the Host; a tenant principal is any principal that is not the operator.
_Avoid_: tenant (for a person or a partition), `tnt_` (the legacy Logto id; organizations are `org_`)

**Grant**:
A permission held by a named holder. A device grant (control, agent control, terminal, SSH files) is given by the Host owner to one paired device. A collaboration grant is a short-lived HMAC-signed bearer that the collaboration server mints and verifies itself; for a few minutes it proves which person, with which role, the bearer is in one organization. Org and workspace actions (`execution.request`, `host.global-surfaces`) are derived from roles and never stored. On a client, an absent grant list means unknown and an empty one means the device holds none.
_Avoid_: role (roles are ladders; actions and grants come from them)

**Operator**:
Whoever runs the deployment. The operator installs and configures the Host and the collaboration server, sets rollout policy, sets organization credentials, suspends organizations and purges persons. The operator acts through operator subcommands (`cognia-server persons`, `org-credentials`, `devices`; `cognia-collab-server rollout`, `org`), the operator database role or the service plane, never through an organization role or a browser. On a single-user Host, the Host owner is the operator.
_Avoid_: admin and owner (organization roles), user (for the operator)

## Decisions

- **D1 — Parity target: both modes equal, standalone (BYOK) is the main line.**
  Mobile settings aim for full parity, not a simplified subset.

- **D2 — Agent-ish settings are mode-gated (resolves the D1 tension).**
  Agent Runtime / tool filter / MCP / permission modes / slash commands are exposed
  only in **paired** mode, where they remote-edit the desktop sidecar (real backend).
  In **standalone** mode they are hidden/disabled (no consumer — no dead UI).
  "Extend the standalone engine to a real agent loop so BYOK can run tools/MCP" is a
  SEPARATE future initiative, not part of the settings effort.

- **D3 — Build strategy: hybrid, default reuse.** Pure settings-store-driven desktop
  sections embed directly into a `/me/*` `SubPageShell` (as `/me/appearance` already
  does). Complex sections with Tauri-only tabs (e.g. agent-runtime's sidecar/SDK tabs)
  are reused but gate those tabs out by platform/mode. Avoid full mobile-native rewrites
  (duplication + drift + double test burden).

- **D4 — `permissionMode` remote-write is gated.** Adding `permissionMode` to the write
  allowlist is allowed, but a remote write (especially an escalation toward
  `bypassPermissions`/`acceptEdits`) must pass the existing `biometricRequiredFor` /
  companion `can_control` gate — not a bare preference write. Benign bucket-1 fields
  (autoMode, defaultSystemPrompt, defaultMaxThinkingTokens, bareMode/debugMode/briefMode)
  write normally.

- **D5 — Coverage: buckets 1+2+3 (full), bucket 4 stays excluded.** Bucket 3 (absent
  desktop sections) ships wave-by-wave, one section per PR, each user-confirmed.

- **D6 — Bucket-3 desktop-bound sections are read-only on mobile.** Slash Commands,
  Network, Hooks, Agent Teams write to filesystem / OS / Rust lifecycle that a phone
  cannot replicate → ship read-only / partial views + "manage on desktop" guidance.

- **D7 — Phone→desktop setting propagation goes through `useSettingsPatch()`, not a
  global `save()` rewire.** The canonical hook (`hooks/use-settings-patch.ts`) does
  `save(patch)` + `enqueue(app_settings_update)`. Sync-down writes via `db.settings.put`
  (never `save()`), so centralizing in `save()` would be echo-free but rewrites 6 test
  files; the hook DRYs the existing per-page pattern at zero test cost. Consequence:
  edits made through _embedded_ desktop sections (`/me/appearance`, `/me/ocr`, which call
  `save()` directly) stay device-local on the phone — acceptable for presentation prefs;
  desktop→phone sync still flows. Revisit only if a shared pref must round-trip up.
