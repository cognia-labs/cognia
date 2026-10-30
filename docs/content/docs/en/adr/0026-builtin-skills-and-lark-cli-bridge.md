---
title: "ADR-0026: Built-in Skill Tier + lark-cli Bridge"
description: "Code-reviewed first-party MCP tools wrapping lark-cli, with A2UI ⇄ skill HITL round-trip"
---

# ADR-0026: Built-in Skill Tier + lark-cli Bridge

- **Status**: Accepted
- **Date**: 2026-05-19
- **Schema bump**: v42 → v43 (`connectorCallbackBindings.payload?` + `"skill_invoke"` kind, `conversationOverrides.allowedBuiltInSkillIds` + `requireHitlForWrites`, `adapterInstances.lastKnownSkillCapabilities?`)
- **Supersedes**: nothing — additive on top of ADR-0009 / ADR-0025

## Context

The A2UI ⇄ IM bridge (ADR-0025) handles messaging surfaces but the Lark
adapter is IM-only. The assistant can read and write Lark messages but
cannot reach the rest of Feishu's enterprise suite — Calendar, Docs,
Bitable, Sheets, Tasks, Wiki — even though those are the high-value
productivity surfaces lark-cli already covers.

User-installable Skills (`character.skillIds`) are prompt-only and not
suitable for shelling out to lark-cli. Plugin tools work but coupling
lark-cli to the (untrusted) plugin loader complicates the trust model.

We need a separate, code-reviewed **built-in skill tier** that:

1. Wraps each lark-cli subcommand as a typed MCP tool the assistant can
   call directly.
2. Reuses the existing Lark adapter OAuth (`lib/connectors/adapters/lark/auth.ts`)
   so users don't run `lark-cli config init` / `auth login` separately.
3. Enforces a clear trust model in IM channels: read auto-runs, write
   surfaces an A2UI confirm card, destructive requires explicit opt-in
   per conversation.

## Decision

### Two parallel tracks

**Track A — Built-in skill tier + lark-cli desktop execution.** Each
lark-cli subcommand surfaces as a typed MCP tool. Execution happens in
the desktop sidecar via `execFile` to the npm-installed `lark-cli`
binary; auth env vars are injected from the Lark adapter's stored
credentials. Mobile clients trigger via the existing V2 server-client
transport — execution always runs desktop-side.

**Track B — A2UI Dialog/Modal capability fill-in.** Pure adapter code
that wires Lark Card v2's `form_dialog` + native Checkbox, Slack
`views.open`, and Discord `interaction.showModal` into the existing
A2UI capability matrix. Independent of Track A.

### Built-in Skill registry

```
interface BuiltInSkill {
  id          // "lark.calendar.list_events"
  family      // "lark.calendar"
  label, description: BilingualString
  platforms   // PlatformKind[] | "any"
  mutation    // "read" | "write" | "destructive"
  imAccess    // "always" | "readonly" | "opt-in" | "blocked"
  mcpToolName // "lark_calendar_list_events"
  inputSchema: ZodTypeAny
  execute(args, ctx): Promise<unknown>
  hitlSurface?(args): A2UISegmentContent  // required for write/destructive
}
```

Each skill self-registers at module load via `registerBuiltInSkill()`.
The shared registry exposes `listByPlatform()`, `listByMutation()`, and
`families()`. The barrel `lib/skills/built-in/index.ts` triggers
side-effect imports for every family.

### Trust model

Tiered by `mutation`:

| Tier            | Default `imAccess` | HITL                         |
| --------------- | ------------------ | ---------------------------- |
| `"read"`        | `"always"`         | none — PII gate + audit only |
| `"write"`       | `"always"`         | A2UI confirm card by default |
| `"destructive"` | `"opt-in"`         | A2UI confirm card always     |

Per-conversation overrides:

- `ConversationOverrideRow.allowedBuiltInSkillIds: string[] | "all" | undefined`
  — `undefined`/`"all"` falls back to per-skill defaults; `[]` blocks all;
  specific IDs (with `family.*` wildcard) constrain the channel.
- `ConversationOverrideRow.requireHitlForWrites: boolean` — defaults `true`;
  set `false` on trusted internal channels to skip the confirm card on
  write skills. Destructive skills ignore this and always HITL.

### Dispatcher pipeline

`runBuiltInSkill(skillId, args, ctx)` runs:

1. Registry lookup — `unknown_skill` denial if missing.
2. Zod schema validation — `invalid_args` denial.
3. PII gate via `hasNoLeakingPii` (same gate Twin + Goal use) —
   `pii_blocked` denial.
4. Channel allowlist check — `not_allowed_for_channel` denial.
5. `imAccess` check — `destructive_opt_in_required` /
   `readonly_requires_channel_curation` / `skill_blocked_in_im` denial.
6. Mutation-tier HITL routing:
   - read / write-with-`requireHitlForWrites=false` / `hitlBypass=true`
     → execute immediately
   - write / destructive → render `skill.hitlSurface(args)`, persist
     a `connectorCallbackBindings` row with `kind: "skill_invoke"` and
     `payload: {skillId, args}`, return `pending_hitl`

Every gate writes a `connectorAudit` row using the new audit kinds
(`builtin_skill_invoked` / `_denied` / `_hitl_pending` / `_hitl_approved`
/ `_hitl_rejected` / `_failed`). PII redaction runs before the audit
write so the audit log never holds leaked content.

### A2UI ⇄ skill bidirectional flow

The user clicks Confirm in the A2UI card. The adapter's parser
normalises the platform payload into a `ConnectorCallbackEvent` and
hands it to `ConnectorBus.dispatchConnectorCallback`. The bus:

1. Dedupes by `triggerId` (namespace `"callback"`).
2. Resolves the binding via `resolveCallbackBinding(adapterId, actionId)`.
3. Detects `binding.kind === "skill_invoke"` and short-circuits the
   standard digest-turn path.
4. Reads `binding.payload.{skillId, args}` and re-fires
   `runBuiltInSkill(skillId, args, { hitlBypass: true })`.

Cancel clicks audit `builtin_skill_hitl_rejected` and return.

### Sidecar exposure

The built-in skill manifest folds into the existing `opts.pluginTools`
stream. The sidecar's `plugin-tools.mjs` builds a synthetic
`cognia-plugin-tools` MCP server from this manifest and proxies
invocations back to the renderer via `plugin_tool_exec` IPC.
`lib/claude/plugin-tool-ipc.ts:handlePluginToolExec` falls back to the
built-in skill registry by `mcpToolName` when the plugin store has no
match. Thus, the same handler routes both plugin tools and built-in
skills through the existing IPC channel.

### lark-cli execution

`lib/skills/built-in/lark/exec-lark-cli.ts` wraps `execFile`:

- Binary discovery: `LARK_CLI_BIN` env override → PATH lookup → Windows
  `%APPDATA%\npm\lark-cli.cmd` fallback.
- Caps: 5-min timeout (configurable), 1 MB stdout, `windowsHide: true`.
- Auth env injection via `auth-bridge.ts`: reads the Lark adapter's
  stored OAuth tokens and emits `LARK_APP_ID`, `LARK_APP_SECRET`,
  `LARK_USER_ACCESS_TOKEN` (or `LARK_TENANT_ACCESS_TOKEN`) for the spawn.
- Identity flag (`--as user|bot`) auto-prepended when missing.
- `--yes` appended when the dispatcher signals `confirmed: true` so
  lark-cli's own confirmation gate is satisfied on HITL re-fire.
- Exit code 10 surfaced as `hitl_required` so callers see a structured
  signal.

### Per-channel capability prompt

`buildCapabilityPromptSection(platform, matrix, skillCapabilities?)`
gains an optional fourth bullet:

> Built-in skills available on this channel: lark.calendar (read+write),
> lark.doc (read+write+destructive), … Write/destructive operations
> route through an A2UI confirm card by default.

`AdapterInstanceRow.lastKnownSkillCapabilities` caches the per-family
mutation set at adapter start so the hot send path doesn't walk the
registry on every turn.

## Consequences

### Positive

- Lark's entire enterprise suite (Calendar/Doc/Sheets/Bitable/Task/Wiki)
  becomes assistant-callable without reimplementing OAuth or upload
  pipelines.
- The trust model is explicit per skill and per channel, with audit
  every step of the way.
- The A2UI confirm-card pattern reuses existing infrastructure
  (`connectorCallbackBindings`, `dispatchConnectorCallback`,
  `recordCallbackBinding`) — no new persistence layer.

### Negative

- lark-cli must be installed on the desktop side. The auth bridge
  surfaces a precise error when it isn't.
- Mobile clients route through the V2 server (per ADR-0014); they
  cannot run skills standalone. This is acceptable for v1 — mobile is
  client-only in the current product framing.
- The `pluginTools` manifest now carries up to 40+ entries (Lark v1),
  growing the system-prompt context budget. Mitigated by the per-channel
  `allowedBuiltInSkillIds` filter in IM and the desktop-only opt-in
  (`character.enableBuiltInSkills`).

### Out of scope (v2)

- Other Lark families: `mail`, `drive`, `slides`, `vc`, `minutes`,
  `whiteboard`, `approval`, `attendance`, `contact`, `event`, `okr`.
- Native Lark SDK integration (revisit only if lark-cli proves
  insufficient).
- Driving `lark-cli config init` / `auth login` from cognia UI.
- Cross-platform skill families (Slack canvas, Discord forums,
  Telegram mini-apps).

## Layering

| Layer             | Module / file                                                      |
| ----------------- | ------------------------------------------------------------------ |
| Skill contracts   | `lib/skills/built-in/types.ts`                                     |
| Registry          | `lib/skills/built-in/registry.ts`                                  |
| Dispatcher        | `lib/skills/built-in/dispatcher.ts`                                |
| Manifest          | `lib/skills/built-in/manifest.ts`                                  |
| Lark exec         | `lib/skills/built-in/lark/exec-lark-cli.ts`                        |
| Auth bridge       | `lib/skills/built-in/lark/auth-bridge.ts`                          |
| Lark families     | `lib/skills/built-in/lark/{calendar,doc,sheets,base,task,wiki}.ts` |
| Bus integration   | `lib/connectors/bus.ts` (skill_invoke branch)                      |
| Sidecar bridge    | `lib/claude/plugin-tool-ipc.ts` (built-in fallback)                |
| Build-options     | `lib/claude/build-options.ts:resolveSendOptions`                   |
| Capability prompt | `lib/connectors/a2ui-bridge/capability-evaluator.ts`               |
| Settings UI       | `components/settings/built-in-skills/`                             |
| Slash command     | `lib/slash-commands/actions/lark.ts`                               |
| Schema            | `lib/db/schema.ts` (v43), `lib/db/connector-types.ts`              |
| Audit             | `types/connectors/audit.ts` (6 new kinds)                          |

## Amendment — 2026-10-30: personal authorization in IM turns

Built-in skill context carries the acting human senders of the current turn
(remote user id, and principal/union id when available), or `unknown`.
Hydration shares the inbound-job lookup with confirmation actor scoping and
includes completed messages absorbed into the same execution run. The running
job's execution record must belong to the calling session; a missing record
or another session's run is unknown. An in-flight live steer, an unattributed
completed steer whose local `createdAt >= current.createdAt`, and failed
lookups remain unknown. The window uses local intake time, not the platform's
message timestamp. Queued messages and `steer-replay` jobs wait for the next
turn and are ignored. Confirm-card re-fires explicitly carry the verified
callback clicker, rather than looking up whoever happens to be running later.

For a session whose persisted `platformBinding` binds it to IM, every sender
must match the adapter's `settings.connectedUser.openId` before a Lark call
can use that user's token. When both sides have a union id, it must also
match. Missing ownership, unknown/empty sender sets, cross-app identities,
and lookup failures refuse with `sender_not_token_owner`. The shared gate
covers all Lark CLI skill reads/writes and contact-name search, including
`/lark` calls carrying only a session id. Local sessions without a platform
binding retain personal authorization.

OAuth stamps the `authorizationEpoch` returned by native token publication
onto `connectedUser`. The gate takes one native authorization snapshot and
requires the metadata epoch to match it; legacy metadata without an epoch
must match the snapshot's atomic `accountLabel` against `name || openId`.
Missing or mismatching authorization refuses. The gate returns that verified
snapshot's access token and epoch: CLI execution uses the verified token,
and HTTP requests also fence refresh/retry to its epoch. With epoch-stamped
metadata, reconnecting cannot combine the old owner's metadata with the new
account's token during the separate metadata write. The legacy label check
is weaker when different accounts share a display name; a completed OAuth
connection stamps the epoch for subsequent checks.

User authorization never implicitly downgrades to a tenant token. The CLI
bridge fails with `user_not_authorized` when a preferred user token is
missing. The OpenAPI harness requires `identity: "user" | "bot"`; user mode
fails closed with the existing `notAuthorized` account error when its token
is missing, invalidated or cannot be refreshed. Bot mode uses only the
tenant identity. Docs search/fetch, Twin ingestion, and the account-selected
issue Task/Bitable resources and their pickers explicitly use user mode.

Residuals: adapter reply-as-user and `lookupAsPerson` routing are unchanged.
Bot control-plane runs without IM-bound sessions, non-Lark platform identity
policies, and group-audience authorization (who can see a reply even when
the requester owns the token) are outside this amendment. Ownership alone
does not make a group safe for personal data.
