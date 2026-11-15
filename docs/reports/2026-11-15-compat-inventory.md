# Compat inventory (2026-11-15)

Places where the codebase keeps an older version of its own thing alive.
Third-party version names (AI SDK `LanguageModelV3`, Telegram MarkdownV2,
OneBot v11/v12, OpenCode server v2 API, ACP v1, A2A, VS Code engine, Dify,
Lucide, Chromium/Firefox/CC Switch on-disk formats, pdfjs legacy build) are
out of scope and are not listed.

Categories:

- **A**: two versions of the same internal thing coexist.
- **B**: reads or migrates old persisted data (Dexie, localStorage, settings
  row, keyring, sqlite, files on disk).
- **C**: deprecated aliases, re-exports, shims, renamed-field fallbacks.
- **D**: accepts an older wire version from a peer (phone, Host, server,
  sidecar, CLI).
- **E**: accepts old plugin, manifest or template formats.

Rough totals: A ≈ 30, B ≈ 110, C ≈ 70, D ≈ 22, E ≈ 11 sites.

## A: two versions coexist

| Where                                                                                                                                                                               | What                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `components/workflow/editor/inspector/forms/{form-support,flow-data-forms,ai-forms}.tsx`                                                                                            | `Branch/Switch/LoopConfigV1` beside V2, dispatched on `typeVersion`                                           |
| `lib/workflow/nodes/ai/ai-prompt-v2.ts`, `lib/workflow/definition/migrate.ts`                                                                                                       | v1 `jsonSchema` hint, v1 to v2 workflow JSON                                                                  |
| `lib/platform/host-feature-manifest.ts` (+ `lib/connectors/inbox-writes/route.ts`, `lib/automation/managed-desktop-client.ts`, `lib/ai/agent/external/capability/process-plane.ts`) | `HostFeatureManifestV1` and V2 both accepted                                                                  |
| `lib/ai/agent/external/integrations/opencode.ts`                                                                                                                                    | OpenCode V1 integration beside V2                                                                             |
| `components/eval/eval-lab-workspace.tsx`                                                                                                                                            | `LegacyTool` old dashboard panels beside the new workspace                                                    |
| `packages/agent-contracts/src/external-agent.ts`, `packages/agent-acp/src/client.ts`                                                                                                | legacy `AcpCapabilities` beside `AcpAgentCapabilities`                                                        |
| `packages/agent-pi/src/rpc-client.ts`                                                                                                                                               | pre-ADR-0210 path                                                                                             |
| `components/providers/logger-provider.tsx`                                                                                                                                          | `convertToLegacyEntry` bridge to old `LogTransport`                                                           |
| `components/chat/decision-provider-card.tsx`                                                                                                                                        | `legacy` adapter preset                                                                                       |
| `components/mobile/discover/discover-mobile-body.tsx`                                                                                                                               | legacy card lists beside grid                                                                                 |
| `lib/ai/agent/execution/legacy-mapping.ts`, `lib/agent/composition/legacy-mode-mapping.ts`, `stores/agent/agent-runtime-store.ts`                                                   | legacy mode id to policy mapping, flat mirror fields                                                          |
| `sidecar/src/runtimes/{index,registry}.ts`, `runtimes/claude-agent-sdk/subprocess-env.ts`, `host/events/*`, `host/commands/responses.ts`                                            | legacy provider-id dispatch, env spread, `claude_send` queue, dual event envelopes (marked "Phase 9 deletes") |
| `sidecar/src/tools/builtin/core-files/tasks.ts`                                                                                                                                     | TodoWrite beside TaskCreate/Get/List/Update                                                                   |
| `cli/src/serve/persistence/{journal,backend}.ts`                                                                                                                                    | journal-v4 and sqlite-v5 both live                                                                            |
| `cli/src/agent/external-agent-session.ts`                                                                                                                                           | dual-writes the legacy flat transcript                                                                        |
| `cli/src/agent/runtime/{backend-select,resolve-worker-execution}.ts`                                                                                                                | `runtimeFromLegacy`                                                                                           |
| `cli/src/config/schema.ts`                                                                                                                                                          | `skillLoadMode: "full"` beside `"name"`                                                                       |
| `scripts/build/build-cli-bun.mjs`                                                                                                                                                   | `legacyLayout` branch                                                                                         |
| `crates/cognia-problem/src/paging.rs`, `crates/cognia-companion-rpc/src/rpc/data_sync.rs`                                                                                           | legacy page shapes beside the page envelope                                                                   |
| `crates/cognia-companion/src/host_surface_gate.rs`                                                                                                                                  | legacy explicit `workspaceId` scope                                                                           |
| `crates/cognia-tts/src/proxy.rs`                                                                                                                                                    | caller-supplied credential TTS path                                                                           |

## B: old persisted data

Frontend (`lib/`, `stores/`, `components/`, `packages/`):

- Dexie: `lib/db/schema.ts` version chain and legacy row shapes;
  `lib/accounts/legacy-migration.ts` (old `cognia-claude` DB);
  `lib/db/{settings,integrations,connector-types,outbound-jobs,inbound-ledger,conversation-override-legacy}.ts`;
  `lib/plugin/security/permission-migration.ts`; `lib/squads/legacy-run-history.ts`;
  `packages/provider-types/src/profile-migration.ts`;
  `packages/plugin-contract/src/types/agent/agent-team.ts` (teammate
  `provider/model/apiKey/baseURL`); eval `isLegacyScoring`.
- localStorage / Zustand persist: `lib/artifacts/localstorage-migration.ts`,
  `stores/artifact/artifact-store.ts`, `stores/canvas/comment-store.ts`,
  `lib/plugin/api/storage-api.ts`, `lib/plugin/devtools/developer-mode.ts`,
  `lib/observability/url-state.ts`, `components/shell/use-{bar,sidebar}-layout.ts`,
  `lib/logging/telemetry-secrets.ts`.
- Secrets to keyring: `lib/settings/provider-secret-split.ts`,
  `lib/network/proxy-credentials.ts`, `lib/credentials/turn-credentials.ts`,
  `lib/mcp/credential-migrator.ts`, `lib/ai/agent/external/session/rehydrate.ts`,
  `lib/companion/credential-book/{legacy-migration,stores}.ts`,
  `lib/logto/session-store.ts`, `lib/plugin/auth/{feishu-legacy-migration,legacy-session-migrations}.ts`,
  `lib/connectors/adapter-registry.ts` (Slack `user_token`),
  `lib/connectors/adapters/telegram/index.ts` (`webhookSecret`),
  `packages/vector/src/migrations/credential-migration.ts`,
  `components/settings/companion/webrtc-card.tsx`.
- Other: `lib/data/migrate.ts` (v1 backup envelopes), `lib/identity/reconcile-user-id.ts`,
  `lib/sync/companion-sync.ts` (`adoptLegacyCursorKeys`), `lib/tauri/companion-storage.ts`,
  `lib/onboarding/migrate-legacy.ts`, `lib/lsp/migrate-settings.ts`,
  `lib/agents/editor-state.ts`, `lib/workflow/node-groups/upgrade.ts`,
  `components/providers/initializers/*` one-shot migrations,
  `components/settings/appearance/tabs/custom-theme-tab.tsx`,
  `components/chat/message-parts/usage-diagnostics-card.tsx`,
  `app/canvas/join/page.tsx` (old share links).

Rust:

- `crates/cognia-secrets/src/{secret_store,host_secrets}.rs`: per-subsystem
  keychain items migrated into the secret store (~300 lines).
- `crates/cognia-companion-security/src/security_store.rs`: Lark receipts,
  device grant/binding/status backfills, `migrate_legacy_device_grants` (~650 lines).
- `crates/cognia-subscription/src/{migration,vault}.rs`: v1 keyring to v2 vault,
  v2 preset to v3 library (~385 lines).
- `crates/cognia-connectors/src/{google_docs_auth,attachments}.rs`: Google v1
  connection/tokens, pre-envelope attachment cache (~420 lines).
- `crates/cognia-gateway/src/{api_keys,route_ticket,runs,execute}.rs`: legacy
  bearer token, scope-less keys, v1 tickets.
- `crates/cognia-companion-connectivity/src/signaling/envelope.rs`,
  `crates/cognia-external-agent/src/dsh_runtime.rs`,
  `crates/cognia-task-workspace-host/src/host_surface.rs`,
  `crates/cognia-codeserver/src/proxy.rs`, `crates/cognia-ocr/src/native.rs`.
- `src-tauri/src/{keyring_secrets,pet_window/mod,companion_api/commands}.rs`.

CLI, sidecar, plugins:

- `cli/src/agent/session-store/legacy.ts` (flat transcripts),
  `cli/src/serve/persistence/{value-codec,operations,sqlite,checkpoint}.ts`,
  `cli/src/db/{bootstrap,snapshot}.ts`, `cli/src/serve/durability.ts`,
  `cli/src/runtime/external/dsh-installer.ts`, `cli/src/plugin/plugin-state.ts`,
  `cli/src/config/{load,mutate,active-model}.ts`, `cli/src/agent/tool-approvals.ts`.
- `sidecar/src/context/progress-checkpoint.ts`, `sidecar/src/runtimes/ai-sdk/compaction.ts`.
- `plugins/{impeccable,feishu-calendar,e2b-sandbox,cognia-visualize,strix-security,example-issue-sync,screenshot}`.

## C: aliases, re-exports, shims

- Tauri/RPC: eight deprecated `claude_*` commands (`src-tauri/src/claude/commands.rs`)
  and their RPC arms (`crates/cognia-companion-rpc/src/rpc/chat.rs`);
  `keyring_secret_*` aliases; `subscription_{get,set}_preset`; perf `legacy:` leases;
  serde aliases in `src-tauri/src/cli_bridge/handlers.rs`, `cognia-companion-bus`,
  `cognia-plugin-runtime`, `cognia-external-agent`; `required_aliased` in
  `cognia-companion-rpc`; `cognia-environment` legacy env names and catalog entries;
  `cognia-agent-state` legacy provider ids; `scripts/build/lib/companion-known-commands.mjs`
  `RENAMED_COMMANDS`.
- TS: `types/plugin/_compat.ts`, `packages/plugin-contract/src/types/plugin/_compat.ts`,
  `lib/plugin/core/compatibility.ts`, `FullPluginContext`, `PluginContext` alias,
  ~15 `@deprecated` fields in `packages/plugin-contract/src/types/agent-config/index.ts`,
  `plugin.ts` deprecated members, `lib/agent/utils.ts`, `lib/chat/slash-command-registry.ts`,
  `lib/claude/{skill-builtin-tools,skills-bridge}.ts`, `lib/ai/agent/external/lifecycle/*`
  2-line shims, `lib/twin/distill/llm.ts`, `lib/usage/pricing.ts`, `lib/scheduler/executors/index.ts`,
  `stores/settings/settings-store.ts`, `stores/chat/chat-store.ts`,
  `hooks/a2ui/use-a2ui-context.ts`, `hooks/ui/use-copy.ts`,
  settings nav-config tab aliases, `components/inbox/inbox-sidebar.tsx`,
  `components/error/diagnostic-card.tsx`, scheduler `allowConcurrent`,
  `packages/logging` legacy types, `packages/provider-core` aliases.
- CLI/sidecar: `cli/src/agent/run.ts` (`maxTurns`), TUI re-export shims, `regenerate`/`optimize`
  command aliases, `classic` theme, `sidecar/src/hooks/{pre-compact,sdk-output}.ts`,
  `sidecar/src/runtimes/claude-agent-sdk/sdk-options.ts` (`claudeAgentSdk.plugins`).

## D: older peer wire versions

- `crates/cognia-companion-rpc` (`connector_send`, `EnvironmentScript::Legacy`),
  `crates/cognia-companion-connectivity/src/signaling/peer.rs` (`cognia.v2` DataChannel label),
  `crates/cognia-gateway/src/{lib,snapshot}.rs` (unversioned snapshots),
  `crates/cognia-connectors/src/types.rs`, `crates/cognia-task-workspace/src/transfer.rs`,
  `crates/cognia-collab-server/src/api.rs`, perf frame compat fields.
- `lib/collab/{capabilities,shared-chat-availability}.ts`, `hooks/chat/use-sessions.ts`,
  `lib/companion/execution-run-control-handler.ts`, `components/mobile/remote-sessions/remote-session-detail.tsx`,
  `components/settings/connectivity/blocks/relay-check-block.tsx`.
- `cli/src/serve/bridge-client.ts`, `services/workspace-runtime/src/runtime-server.mjs`,
  `scripts/build/gen-companion-api.mjs` stripping legacy contract entries.

## E: old plugin / manifest / template formats

- `packages/plugin-sdk/contract/compat/` (signed GitHub Delivery 2.0.0 bundle),
  `packages/plugin-sdk/src/manifest/index.ts` compat paths,
  `packages/plugin-contract/src/types/plugin/plugin-messaging.ts` bare handlers,
  `packages/plugin-contract/src/lib/plugin/interceptors/normalize.ts` + `scripts/gates/check-plugin-hooks.mjs`
  `LEGACY_HOOK_POINTS`, `packages/agent-runtime-kit/src/plugin-compat.ts`,
  `lib/templates/{legacy-sources,migration}.ts`, `components/plugins/detail/plugin-config-form.tsx`
  `__variant`, `plugins/zhihu-content-pipeline` legacy manifest fields,
  `plugins/wasm-example-formatter/wit/world.wit` error channel.

## Not compat (checked)

- `components/pet/skins/sprite-v2-skin.tsx`: no v1 skin exists; "v2" is the
  Codex sprite-pack format.
- `BackupPackageV3`, `GlanceSnapshotV1`, `AgentCapabilityGrantV1`,
  `UnattendedPermissionProfileV1`, `AgentRunResultV1`: sole current version.
- Forward-only SQL schema migrations in Rust crates: ordinary schema evolution.
