# Engine launch descriptors: the process host stops knowing engines

Status: done (2026-11-16), recorded in ADR-0217 (2026-11-16 section). This is the prerequisite for ADR-0243 3C (`2026-11-16-adr-0243-3c-engine-launch-profile.md`).

## Problem

ADR-0217 moved vendor behaviour out of the TS manager into packages (`AcpVendorProfile`, typed extensions, package manifests). The **process host** was left out. Both copies of it still recognise engines by command name and patch the launch:

- the Rust `crates/cognia-external-agent` (`process.rs`, `sandbox.rs`, `presets.rs`, `devin_mcp_config.rs`);
- the CLI `cli/src/runtime/external` (`node-backend.ts`, `sandbox-launcher.ts`, `devin-mcp-config.ts`).

Named-engine branches today: pi, codex, kimi, goose, grok, claude, qoder, aider, cline, devin, minimax/mcode, antigravity, copilot, hermes, crush, dsh, codebuff. Each patch is one of these kinds:

| Kind                                                                                | Examples                                                                                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| native state root (env or argument selection, default dir, must stay inside a root) | `KIMI_CODE_HOME`, `GROK_HOME`, `MINIMAX_DATA_DIR`, Qoder `--config-dir`, Cline `--config` / `CLINE_DIR`, `GEMINI_HOME`, `OPENCLAUDE_CONFIG_DIR`… |
| temp dir under that root                                                            | kimi, cline, qoder, minimax, goose, antigravity                                                                                                  |
| reviewed env of the engine                                                          | Kimi's `KIMI_*` review, Aider's `AIDER_*` strip, Grok's private `XAI_API_KEY` slot                                                               |
| read-only program roots under home                                                  | `~/.qoder/entry`, `~/.qoder/bin`, `~/.local/share/devin/cli/_versions`                                                                           |
| MCP delivery the engine needs                                                       | Devin reads only `XDG_CONFIG_HOME/devin/mcp_config.json` (a whole module ×3)                                                                     |
| cannot be isolated                                                                  | Antigravity (shared keychain accounts)                                                                                                           |
| network requirement                                                                 | Codebuff needs network off                                                                                                                       |

Costs:

- Adding or fixing an engine means editing the Rust host and the CLI host in lockstep.
- Engine knowledge lives outside the engine's package.
- Every security mode (Bot isolation today, the 3C launch profile next) has to be threaded through every engine branch, which is exactly how `COGNIA_BOT_ISOLATION` ended up in about 30 places.

One kind is already done right. State-isolation rules are data in `protocol/external-agent-security-policy.json`; Rust and TS interpret them generically, and `audit:agent-capabilities` keeps the two in step.

## Options

### A. Each spawn request carries its engine's launch description

The adapter adds the description to `AgentProcessSpawnSpec`; the host executes it.

Rejected. The process host also serves remote spawn requests: companion clients reach the headless Host's `spawn_external_agent`. A description sent per request is client input, so it could name `~/.config/gh` as a readable root. Today the host derives quirks from the command, so a client cannot widen them. That property must survive.

### B. Engine packages run their own launch code before spawn

Rejected. The package would need broad host file access (it must read and write under the user's home), which the ADR-0217 ports deliberately do not grant. It has the same remote-input problem as A.

### C. Package-owned launch descriptors, generated into `protocol/`, interpreted generically (recommended)

- Each engine package declares a **launch descriptor** in its `./manifest`, next to its runtime catalog row. ACP vendors declare it in their `AcpVendorProfile` file, for example `packages/agent-acp/src/vendors/devin.ts`.
- A generator writes all descriptors into `protocol/external-agent-launch.json`, gated with `--check`. This is the same pattern as `gen:external-agent-runtimes` (ADR-0217) and the existing state rules, which fold into it.
- The Rust host compiles the descriptors in, with literals checked by the audit gate as today. The CLI host reads them.
- A spawn request names only the command, its arguments and the 3C profile. It never names a descriptor: the host looks one up by command, as it does for state rules today. The trust boundary is unchanged.
- Each host implements a **closed vocabulary of primitives**, generically and once, with no engine names:

```ts
// packages/agent-contracts/src/engine-launch.ts (shape; the vocabulary is closed)
interface EngineLaunchDescriptor {
  match: { commands: string[]; args?: string[] } // as the state rules match today
  state?: {
    env: Record<string, string> // env key -> dir relative to the state root
    select?: { env?: string[]; args?: string[] } // where the engine lets a user relocate it
    temp?: "state-root" // TMPDIR/TMP/TEMP under <root>/tmp
    sharedRoots: string[]
    denyReadable: string[] // home-relative, as today
  }
  env?: { reviewed?: string[]; stripPrefixes?: string[] } // the engine's own env review
  programRoots?: string[] // home-relative, read-only (installed CLIs)
  mcp?:
    // how attached MCP servers reach it
    | { kind: "session" } // ACP session/new, Codex thread config, ...
    | {
        kind: "config-file"
        root: "xdg-config"
        path: string
        key: "mcpServers"
        privateKeep?: string[]
        privateSet?: Record<string, unknown>
      }
  isolation: { supported: true } | { supported: false; reason: string }
  network?: "off-required"
}
```

Host invariants stay engine-agnostic and bound every descriptor:

- writable roots ⊆ {cwd, the launch's state root, the tool-host directory};
- program roots are read-only and never under a credential root on the baseline deny list;
- `config-file` writes only into a private overlay directory;
- loader and injection env keys are always dropped.

A descriptor can relocate and narrow. It cannot grant anything those rules forbid, so a careless manifest fails the gate or the host, never silently.

**Devin under C.** The three `devin-mcp-config` modules become one generic `config-file` primitive per host: write the injected servers into `<overlay>/devin/mcp_config.json`. For the owner, merge them with the existing file and link the rest of the person's XDG config; a private launch does neither. Devin's own data (`path`, `privateKeep: ["version", "devin.org_id"]`, `privateSet: {"shell.setup_complete": true}`) moves to `packages/agent-acp/src/vendors/devin.ts`. The bare-launcher detection and payload env stay generic.

**3C on top of C.** The launch profile (owner / isolated / personal) is one function per host over (profile × descriptor):

- an engine whose descriptor says `isolation.supported: false` is refused for a private launch (the Antigravity special case disappears);
- a private launch maps the descriptor's state env into its own root, empties program-specific relaxations it does not need, and blanks the descriptor's reviewed credential env.

No profile logic is written per engine.

### Out of scope here

These are not third-party quirks. Each is already a registered host module:

- Cognia-owned runtimes: DSH runtime, Hermes probe, the Codebuff and Crush native bridges (`native_bridge.rs`);
- SIWC;
- the gateway task.

They keep their modules and read the same profile. Folding them in is a later step if it pays off.

## Migration

1. **Contract and generator.** `EngineLaunchDescriptor` in `@cognia/agent-contracts`; `gen:external-agent-launch` + `--check`; `protocol/external-agent-launch.json`. The current state rules move into it unchanged, and the security policy points at it.
2. **Generic primitives per host** (Rust `launch_descriptor.rs`, CLI `launch-descriptor.ts`): state, select, temp, env review, program roots, `config-file` MCP, isolation support, network requirement. Shared fixtures under `protocol/fixtures/` drive both hosts' tests, so the two implementations are checked against one set of cases.
3. **Move each engine.** Its branch leaves `sandbox.rs`, `process.rs`, `presets.rs`, `sandbox-launcher.ts` and `node-backend.ts`, and its descriptor lands in its package. This is a behaviour-preserving refactor: every existing per-engine test is kept and re-pointed at the descriptor. The `devin_mcp_config` modules are deleted.
4. **Gate.** `audit:agent-capabilities` (or a new `audit:engine-launch`) fails when a host source names a runtime outside the native-bridge registry, so knowledge cannot drift back into the hosts.
5. **3C** resumes on top: profile × descriptor, as in the 3C plan, with the per-engine profile wiring removed from that plan.

## Risks

- A one-off quirk may not fit the closed vocabulary. The rule is to add a primitive with a host invariant, never an engine branch, and the gate enforces it. If an engine needs truly bespoke code, it becomes a registered native bridge, the way DSH and Codebuff already are.
- The behaviour-preserving move covers 17 engines. The existing Rust and CLI per-engine tests are the safety net; nothing is dropped.
- The Rust host still needs compiled-in literals for the descriptors, as it does for the state rules today. The gate keeps them identical to the JSON.

## Outcome

Landed on `dev` in five commits: the contract, generator and state rules (`df09446015`); relocation, temp, companion, platform arguments and private-launch refusal (`1ac784626a`); env admission and review, hidden files, program and login roots, stderr noise and feature flags (`58f550b216`); the `mcpConfigFile` primitive replacing the `devin-mcp-config` modules (`492d724c6d`); and the host gate (`audit:external-agent-launch` runs `check-engine-launch-hosts.mjs`), the compiled-in security policy and the ADR section.

Differences from the sketch above:

- The descriptor names its fields by what the host does with them (`relocation`, `temp`, `companion`, `env`, `hiddenFiles`, `programRoots`, `loginRoots`, `mcpConfigFile`, …) instead of the nested `state` / `mcp` shape.
- The Rust host reads the generated JSON with `include_str!`, so no literals are mirrored and no parity check is needed. The command allowlist is compiled in from the security policy the same way.
- Shared fixtures under `protocol/fixtures/` were not needed: each host's tests read the same generated table.
- A network requirement stayed with the Codebuff native bridge, which is out of scope.

Where the Rust and CLI copies disagreed, the unified rule is:

| Behaviour                                                    | Before                                                        | Now, on both hosts                           |
| ------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------- |
| Gateway task and the host's state-directory env              | per-engine code, applied by some engines                      | never applied                                |
| Bot relocation containment                                   | per-engine checks, not all resolving symlinks                 | lexical and physical for every relocation    |
| Antigravity `--uid=` on Linux                                | one host only                                                 | both                                         |
| Grok host credential in a private launch                     | Rust set it empty, the CLI dropped it                         | set empty unless the request sets it         |
| Aider's host `AIDER_*` env                                   | stripped on both, with separate code                          | `reviewedRequestOnly`                        |
| Windows command extension (`agy_acp_server.par`)             | Rust replaced any extension, the CLI special-cased one engine | the CLI replaces any extension, as Rust does |
| Engine state env refused from tenants and operator additions | two hand lists that had drifted                               | every relocation and isolation key           |
