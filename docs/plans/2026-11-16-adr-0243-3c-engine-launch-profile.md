# ADR-0243 3C — one launch profile for external engines

Status: approved 2026-11-16; rebased onto the engine launch descriptors (`2026-11-16-engine-launch-descriptors.md`, ADR-0217 2026-11-16 section), which landed first.

## Problem

ADR-0243 §6 says a person's credential never leaves the Host, and an engine reaches a personal lane only with full isolation. Today:

- No external engine can use a Cognia-held personal credential:
  - MCP OAuth is refused (`lib/mcp/credential-resolver.ts`).
  - A personal read through the tool host is refused when it is marked, because an unfenced session binding refuses the mark.
  - Fenced Codex disables every MCP server and turns its sandbox network off.
- **Nothing reads the run's acting identity before an engine runs.** `lib/ai/agent/external/` never references `ActingIdentityV1`. So a turn requested by someone else runs the owner's configured engine process. A Feishu group member talking to a session bound to Claude Code is one example. That process has the owner's:
  - inherited Host environment (`GH_TOKEN`, `SSH_AUTH_SOCK`, provider keys);
  - readable home (`~/.config/gh`, `~/.aws`);
  - keychain (`mach-lookup` is open outside bot mode);
  - native logins.

  That is the "borrowing someone else's access" which §3 rules out.

- Isolation exists, but as five unrelated switches with different signals and rules:

| Switch          | Signal                                                   | Private home                                                              | Env                                      | Keychain             | Network                               | Login                                      |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- | -------------------- | ------------------------------------- | ------------------------------------------ |
| Bot             | `COGNIA_BOT_ISOLATION=1`, `COGNIA_BOT_STATE_DIR`         | `<checkout>-state`, home unreadable                                       | launcher `env_clear` + `bot_environment` | securityd IPC denied | policy                                | Devin file copy, `DEVIN_*` / `MCODE_*` env |
| State isolation | `COGNIA_AGENT_STATE_KEY` (default for configured agents) | `<data>/cognia/external-agents/<key>` (config dirs only)                  | inherited                                | open                 | policy                                | none (signed out)                          |
| Gateway task    | `COGNIA_GATEWAY_TASK_CONFIG` / `cogniaGatewayTask`       | `~/.local/share/cognia-agent-tasks/<id>`, home readable minus a deny list | `env_clear` + 14 runtime keys            | open                 | policy                                | ticket lease                               |
| SIWC            | `COGNIA_AGENT_SIWC_CAPABILITY`                           | —                                                                         | `env_clear` + runtime keys               | open                 | policy                                | capability                                 |
| DSH runtime     | `COGNIA_DSH_RUNTIME_HOME`                                | runtime home                                                              | `env_clear` + DSH list                   | open                 | policy                                | `DEEPSEEK_*` / lease                       |
| Personal fence  | `metadata.personalEgressFenced` (Codex only)             | —                                                                         | —                                        | —                    | Codex-internal `network_access:false` | unchanged                                  |

Bot and gateway each override state isolation silently, detected by different signals in TS (`metadata.cogniaGatewayTask`) and Rust (`PAYLOAD_ENV`). The desktop default spawn inherits the whole Host env; the CLI builds an allowlist.

## Decision

### 1. One profile, derived once on the Host

```ts
// packages/agent-contracts (shared by TS host, CLI and the Rust mirror)
type EngineLaunchProfile =
  | { kind: "owner" } // the local person's own run
  | { kind: "isolated"; key: string; reason: IsolationReason }
  | { kind: "personal"; key: string; loopbackPorts: number[] }
type IsolationReason = "bot" | "requester" | "event" | "service"
```

`engineLaunchProfile({ context, chatSessionId })` in `lib/ai/agent/external/policy/launch-profile.ts` is the only producer. It reads the root acting identity of the execution's Host-bound run (`resolveRunActingIdentity`):

- **owner**: an execution bound to no run (a Host operation the local person started: a direct connect, a model probe); a `local` or `schedule` trigger whose authorizing principal is `local-person` with no other requester (a direct UI run records exactly that); or a `requester` trigger with exactly one requester who is the local person or whom their channel verifies as this Host's owner. The verification is vendor-neutral: `ConversationChannel.requesterIsOwner` (read through `platformRequesterIsOwner` in `lib/chat/conversation-channel.ts`), which the connectors answer from `ConnectorVendorContribution.ownerPrincipal(row)` on the requester's own enabled adapter. Lark names the adapter's `connectedUser`, the account `verifyLarkImOwnerAuthorization` checks; a vendor without the hook has no owner.
- **personal**: not produced here. The manager turns an `owner` turn into `personal` when its session is marked and the turn runs as a Cognia gateway task (§4).
- **isolated**: everything else. That covers a requester who is not the owner, an event actor, the service lane, more than one requester, and every Bot run. A Bot stops setting `COGNIA_BOT_ISOLATION` itself and asks for `isolated/bot`.
- A run with no resolvable identity is **isolated**, never owner.

The profile is checked again on every execute (requesters only ever grow), right after `enforceExternalRunAuthority` (`manager.ts` `executeUnbudgeted` / `executeStreamingUnbudgeted`), so a refused run never starts an instance. An agent that spawns no local process, a gateway task and an instance that already carries a profile (a Bot run, an isolated instance) are not derived again.

### 2. One launch instance per profile key

`owner` keeps today's long-lived configured instance. `isolated` and `personal` run in a transient instance derived from the configured agent: `<agentId>:iso:<key>`. This generalises the Bot's `bot-<uuid>` and the gateway's `<agentId>:chat:<chatSessionId>`. The key is:

- **Bot:** the bot run id. Kept as today: one process per run, removed at the end.
- **Chat session:** `sha256(["chat", chatSessionId], sorted principal keys of the requesters)`. The private state survives the session's turns. A new requester set gives a new key, so a resumed engine session never carries one requester's transcript to another; this is the ADR's "resumed engine session after a second requester joins". A conversation keeps one isolated instance per configured agent: the new key retires the previous one, which is removed with its state root once no execution still runs on it. A session id the new instance does not hold is dropped, so the turn starts a fresh engine session.
- **Run without a conversation:** `sha256(["run", rootRunId], requesters)`, one instance for the execution, removed when it ends.
- Removing or disconnecting the configured agent, and disposing the manager, removes its isolated instances and their state roots. Session operations addressed to the configured agent (permission answers, cancel, steer, model and mode changes, close, delete) reach the instance that holds the session, and the instance's events reach the configured agent's listeners. Conversation lookups (`resolveConversationSessionId`, `liveSessions`) stay per instance, so an owner turn never resumes an isolated session.

### 3. One enforcement point per runtime

The profile reaches the process as one env value, `COGNIA_ENGINE_PROFILE` (JSON, Host-minted, stripped before the child). It replaces:

- `COGNIA_BOT_ISOLATION` and `COGNIA_BOT_STATE_DIR`;
- the Bot validator `presets.rs::validate_bot_runtime_state`;
- the `launch_owns_private_home` and `stateIsolationApplies` special cases.

Each profile launches as follows.

- **Rust** (`crates/cognia-external-agent/src/launch_profile.rs`, new): one `fn launch_environment(profile, ambient, config_env) -> HashMap`, which replaces the `env_clear` branches in `process.rs`:
  - _owner_: ambient filtered by the shared table (essential, session and owner keys, model-provider families, host configuration keys) plus the keys the engine's descriptor admits, then the request env. Loader and injection keys are always dropped. `SSH_AUTH_SOCK` stays: this is the owner's own run.
  - _isolated / personal_: today's `bot_environment` rules (no helpers, `GIT_CONFIG_GLOBAL=/dev/null`) plus the request env, filtered. Model credentials arrive only from the Host (§5).
  - The SIWC, managed-gateway and DSH env special cases become profile inputs to the same function. They are not separate `env_clear` sites.
- **Sandbox** (`sandbox.rs` wrap and the launcher): _isolated / personal_ use the Bot's confinement:
  - private state root `<data>/cognia/isolated-agents/<key>`, the single location (the checkout-sibling `-state` directory goes away). It sits beside the configurations' `external-agents/<id>` roots rather than under them, so no configuration id can name it; `external_agent_state_root_remove { key, isolated: true }` deletes it when the instance is removed;
  - home unreadable except the toolchain list;
  - securityd IPC denied;
  - outbound unix sockets limited to the tool host.
- **CLI** (`cli/src/runtime/external/node-backend.ts`, `sandbox-launcher.ts`): the same function in TS. Engine knowledge comes from the descriptors both hosts already read (`protocol/external-agent-launch.json`): the owner allowlist is the host-owned runtime and config keys plus `admitsRequestEnv`, exactly as the CLI's `buildExternalAgentChildEnv` builds it today.
- **Engines that cannot run privately** are refused for `isolated` and `personal` with `engine_isolation_unsupported`: one that declares `privateLaunchUnsupported` (Antigravity's shared keychain, enforced by `check_private_launch` / `checkPrivateLaunch`), and any isolated launch that reaches a process table unwrapped by this host's sandbox. An engine whose descriptor declares an `isolation` rule gets its homes mapped inside the private root; one without a rule (Devin) gets the root alone, with the platform's data, cache, state and temp roots relocated into it under a home it cannot read, so it starts signed out instead of being refused.

### 4. The personal profile and the broker

`personal` is `isolated` plus:

- **Model through the Host gateway only.** The engine must support a gateway task (`codex, opencode, pi, claude, qwen, dsh, kimi, goose, copilot, aider`) and the run must have a Cognia model binding. Native logins are unreachable by construction.
- **Network: the Host's own loopback services only.** The profile carries `loopbackPorts`: the gateway port from the lease endpoint and the port of every hosted tool-host MCP server (`cognia-tools`, `cognia-plugin-tools` on `127.0.0.1`), because the tool host is HTTP on loopback, not a unix socket. Both hosts pass each as the launcher's `--network-allow-loopback <port>`, which conflicts with `--network`. The filtering proxy (`net_proxy.rs`, `ProxyPolicy.loopback_ports`) dials an admitted `127.0.0.1`/`localhost` port directly, skipping DNS, the private-address filter and any upstream proxy; every other host and loopback port stays forbidden. A remote Host whose network ceiling is not `Full` refuses the launch (`validate_sandbox_policy`, `spawnLeased`), since loopback access exceeds it.
- **Host MCP only.** Only the tool-host projection reaches the engine (`isToolHostMcpServer`). Configured MCP servers are dropped for this profile, because static headers are the owner's secrets.
- **Broker checks** in `cli/src/agent/tool-host/broker.ts` `authorize()` and the desktop `renderer-tool-host.ts`. A call that would use a personal credential is checked on every call:
  - **resource**: the tool is a declared module tool whose `effect` is `read`;
  - **action**: anything else is denied. That includes write, outbound and opaque tools (shell, fetch, browser, git), which the personal egress check already names;
  - **recipient**: the result goes only to this run. It is marked, and `personal-disclosure.ts` still denies any disclosure until phase 5 supplies declared recipients.
- `admitPersonalCredential` replaces its blanket `externalEngine → "external-engine"` with:
  - the call's execution carries a Host-recorded `personal` profile lease for the same person; otherwise
  - it is refused with `"external-engine"`, as today.

The `personalEgressFenced` Codex special case goes away: a marked session's next turn requires the `personal` profile. The manager (`personalLaunch`) admits it for an owner turn with a Cognia gateway binding and refuses (`PersonalEgressDeniedError`) a marked isolated or Bot turn, an agent with no instance and one with no Cognia model, native-login Codex included. A personal session acknowledges further marks; any other session refuses them. Both hosts refuse a personal launch that is not a gateway task (`engine_personal_unsupported`).

### 5. Credentials in isolated launches

- No ambient credential, no native login, and no keychain.
- A model credential comes only from:
  - a Host gateway ticket (`cogniaModel`), or
  - the agent's own secret stored in Cognia (`lifecycle.readSecrets()`, for example DSH's DeepSeek key or Devin's API key). It is passed as request env.

  Devin's `mcpConfigFile.privateCopy` (the `credentials.toml` copy) is removed from its descriptor, and the field from the vocabulary: it copies the owner's native login into an isolated launch.

- An isolated engine with neither is refused with `needsSetup`: "isolated runs need a Cognia model or an agent key".
- The Codex account overlay (`env-builder.ts`) applies to _owner_ only.

### 6. Dead code removed

- `COGNIA_BOT_ISOLATION` / `COGNIA_BOT_STATE_DIR` and every consumer, now reading the profile: ACP terminal refusal, Pi package refusal, Hermes, TMP-dir branches, `bot-run.ts` state dir naming and `validate_bot_runtime_state`. The descriptor functions that already take one `private` flag (`reviewed_env_refused`, `blank_private_credentials`, `relocated_state`'s `private_base`, `check_private_launch`, `mcp_config_file::prepare`) get it from the profile instead of the Bot env.
- `launch_owns_private_home`, `stateIsolationApplies`'s gateway/bot exceptions, and the two gateway-detection signals. One profile field replaces them.
- `metadata.personalEgressFenced` and the Codex fence branches in `app-server-client.ts`.
- `EngineMcpConfigFile.privateCopy` (Rust and TS).

### 7. What the descriptors already removed

The per-engine profile wiring this plan first listed is gone with option C: no host branch names an engine, and `check-engine-launch-hosts.mjs` keeps it so. Every private-launch decision in the hosts is a descriptor function over one `private` flag, so the profile reaches every engine by changing where that flag comes from. No profile logic is written per engine.

## Acceptance tests (ADR-0243 list items this phase owns)

- **Token export to an external CLI:**
  - an isolated launch's child env and readable roots contain no ambient credential, helper socket or native login (Rust and CLI unit tests over `launch_environment`, wrap-arg tests);
  - the macOS SBPL denies securityd.
- **Second requester:** a non-owner requester gets the isolated instance; a second requester gets a new key and a fresh engine session (manager tests).
- **Resumed engine session after a second requester joins:** the resume uses the new key's state and never the old session id.
- **Personal admission:**
  - an external engine without a `personal` lease is refused;
  - with one, a declared read is admitted and marked;
  - a write, outbound or opaque tool is denied by the broker;
  - an engine without a gateway task is refused.
- **Bot runs** keep their behaviour through `isolated/bot` (existing bot tests, rewired).
- **Owner runs** keep native logins and `SSH_AUTH_SOCK` but lose unrelated ambient env (desktop now matches the CLI).

## Verification limits

Unit tests cover:

- the env function;
- the wrap arguments;
- SBPL text;
- profile derivation;
- the broker decisions;
- the manager's instance selection.

Not proven by tests, owed as a desktop smoke:

- a real isolated Claude Code / Codex launch on macOS (signed-out start, gateway login, keychain denial, network allowlist);
- a Feishu non-owner turn.

## Phasing inside 3C

1. One launch environment per host (done): `launchEnvironment` in `protocol/external-agent-security-policy.json`, interpreted by `crates/cognia-external-agent/src/launch_environment.rs` and `cli/src/runtime/external/launch-environment.ts`. Every spawn's child starts from it in one of three modes: owner (desktop now matches the CLI), essential (gateway task, SIWC) or none (DSH). No mode inherits a `COGNIA_*` or loader key from the Host. The contract type and the profile derivation moved to phase 2, where the manager produces the profile and both hosts enforce it, so neither ships unwired.
2. Split in two commits, each wired end to end:
   - **2a (done)**: the profile contract (`packages/agent-contracts/src/engine-launch-profile.ts`, Rust `launch_profile.rs`), the isolated profile replacing Bot isolation in both hosts (private state root from the key, `apply_state_isolation` / `applyStateIsolation` applying the engine's rule inside it, sandbox confinement, `Inheritance::Isolated` with `isolatedKeys` / `isolatedSet` in the policy table, refusal outside the sandbox), the launcher's `--isolated` confinement flag without its own env allowlist, Bot runs asking for `isolated/bot` keyed by their agent id, and the root deleted on `removeAgent`. Removed: `COGNIA_BOT_ISOLATION` / `COGNIA_BOT_STATE_DIR`, `validate_bot_runtime_state`, `launch_owns_private_home` / `launchOwnsPrivateHome`, the launcher's `bot_environment` and `--bot-isolation` with the CLI's capability probe, `PluginWorkspaceHandle.runtimeStateRoot`, and `EngineMcpConfigFile.privateCopy`.
   - **2b (done)**: `engineLaunchProfile` with the vendor-neutral owner check (`ConversationChannel.requesterIsOwner`, `ConnectorVendorContribution.ownerPrincipal`), and the manager's transient `<agentId>:iso:<key>` instances (§2).
3. Split in two commits:
   - **3a (done)**: the `personal` profile (`loopbackPorts`) in the contract and both hosts, the launcher's `--network-allow-loopback` and the proxy's loopback admission, the remote `Full` ceiling requirement, the manager's `personalLaunch` with tool-host-only MCP, and the Codex fence removed (`ExternalAgentExecutionOptions.personalEgressFenced` and every branch in `app-server-client.ts`).
   - **3b**: `admitPersonalCredential` with the Host-recorded `personal` lease, and the broker's per-call resource/action/recipient checks.
4. ADR implementation status, docs and changeset.
