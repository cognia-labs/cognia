# Command shell backends (Git Bash first, brush experimental)

Status: converged design (grill 2026-11-12), not started.

## Goal

Let the Agent and Chat `!` run Bash on Windows instead of PowerShell, which is a burden for models. Do it through one Host-side shell backend contract, so that adding a backend means changing its own adapter, descriptor and tests, not the terminal, Agent or jobs execution code.

Non-goals for this plan: embedding `brush-core` in process, a persistent Agent shell worker, unifying the existing default-shell policies, a plugin system for backends.

## Facts the design rests on

The current code has at least five independent "pick the default shell" policies, and they disagree:

| Entry            | Decided by                                                                                                        | Unix today                      | Windows today                                        | Reads `terminal.defaultShell` |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------- | ----------------------------- |
| Interactive PTY  | Rust `crates/cognia-terminal/src/session.rs:658` + `host_capabilities.rs`                                         | user shell, integration scripts | probe list `host_capabilities.rs:79`                 | yes                           |
| Chat `!`         | TS builds argv: `lib/shell-intelligence/execute.ts:203`, `shell-argv.ts:26`; Rust jobs only gets `program`+`args` | `<shell> -lc`                   | per-family flags                                     | yes                           |
| Agent bash tool  | sidecar on its own: `sidecar/src/platform/process/shell.ts:173`                                                   | `/bin/sh -c`, sanitized env     | pwsh → powershell → cmd                              | no                            |
| Scheduled jobs   | Rust `crates/cognia-jobs/src/commands.rs:44` `shell_invocation`                                                   | `/bin/sh -lc`                   | `powershell.exe -NoProfile -NonInteractive -Command` | no                            |
| Headless default | Rust `crates/cognia-terminal/src/headless.rs:439`                                                                 | hardcoded                       | hardcoded                                            | no                            |

Other facts:

- `IntegrationCapabilities::local_pty(enabled)` (`crates/cognia-terminal/src/host.rs:151`) reports `osc633`, `command_status`, `cwd_tracking` from the request flag, while `ShellKind::Unknown` gets `IntegrationSetup::empty()` (`integration.rs:172`). The SSH path already models degradation (`ssh.rs:1113-1133`).
- The sidecar `ShellDescriptor` injection point (`bash.ts:378`) is test-only; the Host never tells the sidecar which shell to use.
- The POSIX danger scan in `bash.ts:401-413` is gated on `isWin`, i.e. on platform, not dialect.
- The Windows probe lists `bash.exe` on PATH (`host_capabilities.rs:86`), which is often the WSL launcher (`System32\bash.exe`, `WindowsApps`) and runs in another OS.
- `cognia-core` is foundation, `cognia-jobs` platform, `cognia-terminal` domain (`scripts/gates/rust-architecture.json`): shared shell descriptors in `cognia-core` create no upward edge.
- Stale comments: `sidecar/src/platform/process/shell.ts:15` and `lib/shell-intelligence/shell-argv.ts:4` cite `src-tauri/src/shell.rs` / `src-tauri/src/terminal/session.rs`, which no longer exist.
- brush 0.4 (May 2026): Windows is a **Preview** tier (parts missing, no prebuilt Windows binaries, needs Microsoft coreutils or the experimental bundled coreutils), `/c/` paths unsupported (reubeno/brush#1142), DEBUG trap supported but diverges from bash in the oils spec suite, signal traps in progress.
- Git for Windows ships a mature bash plus coreutils; `<Git>\bin\bash.exe` sets up the coreutils PATH, `<Git>\usr\bin\bash.exe` does not.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Purpose: Bash for AI-driven commands on Windows. Git Bash is the first Windows bash backend; brush is an opt-in experimental backend that proves the contract.                                                                                                                                             |
| D2  | The capability over-report fix ships alone, first. Reuse the SSH `degraded_reason` vocabulary. Automation that needs a reliable command end gets an explicit error under degraded integration; no sentinel fallback.                                                                                       |
| D3  | Rust/TS consistency through shared JSON vectors in `protocol/` (precedent: `terminal-fixtures.json`, `workflow-cron-vectors.json`). No code generation.                                                                                                                                                    |
| D4  | Scope: the interactive terminal keeps choosing any installed shell through profiles (add Git Bash and exclude WSL in the probe; no PTY integration change). `!` and the Agent share one backend.                                                                                                           |
| D5  | The Host (Rust) resolves once. It hands the sidecar a data-only descriptor `{backend, dialect, bin, argvTemplate, envPatch, capabilities, syntaxHint, pathStyle}`. `!` sends `{command, startup fields}` instead of a TS-built argv. The sidecar's own probe stays only as the fallback for an older Host. |
| D6  | "Consistent" means shared backend and dialect. Startup behaviour stays per entry: `!` keeps login + inherited env, the Agent keeps non-login + sanitized env.                                                                                                                                              |
| D7  | Startup mode is a set of orthogonal fields (`login`, `envPolicy: inherit \| sanitized`, `interactive`, `shellSource: user \| fixed`), declared by each entry. An adapter declares which field values it supports and the resolver refuses unsupported combinations. Adapters never know entry points.      |
| D8  | With no backend configured, every entry keeps its exact current argv and env. The five divergent policies are encoded as named field combinations in `SystemAdapter` and pinned by vectors. Unifying them is a separate decision.                                                                          |
| D9  | Scheduled tasks pin their backend at creation (default = the command shell setting at that moment, editable per task). Existing tasks without the field keep today's interpreter. Changing the global setting never changes an existing task.                                                              |
| D10 | The command shell setting belongs to the executing Host: each Host stores its own value and offers only backends it actually probed. Selection never falls back to another backend silently.                                                                                                               |
| D11 | A conversation pins its backend at its first run. New conversations use the current setting. The conversation shows its backend.                                                                                                                                                                           |
| D12 | Windows bash paths are shown to the model as `C:/Users/x` (forward slashes). Works in Git Bash, brush and native programs.                                                                                                                                                                                 |
| D13 | Git Bash discovery order: explicit user path → registry `GitForWindows` `InstallPath` → derived from `git.exe` location → common install dirs. Always resolve `<Git>\bin\bash.exe`. Reject WSL launchers.                                                                                                  |
| D14 | brush is detected only (PATH, cargo, MSYS2, explicit path). It is never bundled or downloaded. It is marked experimental in the type, the UI and a test (Hard Rule 7).                                                                                                                                     |
| D15 | Windows default flips from PowerShell to Git Bash only after an A/B run on a fixed Windows coding task set shows Git Bash is no worse on completion rate, shell error count and turns/tokens. It flips only where Git Bash is detected. Until then the backend is opt-in.                                  |
| D16 | Danger scanning, permission-rule matching and the syntax hint key off dialect, not platform.                                                                                                                                                                                                               |

## Contract sketch

```text
resolveShell(selection, startup fields, execution target)
  → { backend, dialect, platform, pathStyle,
      launchPlan: { bin, argv, envPatch, integration? },
      capabilities, refusal? }
```

- `selection` is `{ backend, path? }` from the Host setting, the conversation pin, or the task pin.
- The resolver never spawns. PTY, jobs and the sidecar keep their own permission, sandbox, ownership, cancel and delivery paths.
- `refusal` names the reason: backend missing on target, startup field unsupported, integration degraded where required.

Placement:

- `crates/cognia-core`: descriptor types, startup fields, launch plan, `SystemAdapter` / `GitBashAdapter` / `BrushAdapter`, resolver. No Tauri, no brush crates.
- `crates/cognia-terminal`: native shell integration stays here, and the terminal probe uses the core discovery.
- `crates/cognia-jobs`: `shell_invocation` becomes a resolver call; it honours task pins.
- `sidecar/src/platform/process/shell.ts`: accepts the Host descriptor and keeps its probe as the old-Host fallback.
- `protocol/shell-backend-vectors.json`: input (selection, fields, platform) → expected argv, env patch, capabilities, refusal. Both the Rust and sidecar suites run them.

## Stages

Each stage is independently acceptable.

1. **Capability truth.** `local_pty` reports what `IntegrationSetup` actually configured. The readiness state machine covers: supported → configured → nonce-valid ready event → or degraded with reason (unknown shell, integration off, script missing, ready timeout). Automation needing command-end refuses on degraded.
   - Failing tests first for those four cases.
   - Changeset: patch.
2. **Contract + SystemAdapter, zero behaviour change.**
   - Core types and resolver.
   - Vectors capture today's argv/env for every entry and platform.
   - Move `!` argv building into Rust jobs.
   - Host passes the descriptor to the sidecar; the sidecar fallback stays.
   - Danger scan keyed on dialect.
   - Fix the stale comments.
   - ADR for the contract (backend / dialect / platform / startup fields, Host ownership).
3. **Git Bash adapter (Windows, opt-in).**
   - Discovery chain (D13) and WSL exclusion in the terminal probe too.
   - Host-level command shell setting (module-owned settings key, i18n in en + zh-CN).
   - Conversation pin (D11), scheduled task pin (D9), `C:/` path style and syntax hint, Git Bash terminal profile.
   - Changeset: minor.
4. **brush adapter (experimental).** Detection only (D14) and the experimental labelling. Its startup-field support is declared from evidence, not assumed.
   - Acceptance: the diff touches only the adapter, its descriptor, its vectors and tests, plus the UI listing. Any change to terminal, Agent or jobs code means the contract is wrong; fix the contract, not the entry.
5. **Evidence and default flip.** Run the A/B task set (D15). Flip the Windows default only if the criteria hold.

## Verification obligations

- Vectors pass in Rust and the sidecar for every entry × platform with no backend configured (stage 2 regression net). The 35 existing tests are the baseline, not the proof.
- Real Windows runs (stage 3):
  - Agent bash tool via Git Bash: output, exit code, cancel kills the process tree, sandbox path keeps argv.
  - `!` line on desktop and on a paired Host.
  - Scheduled task with a pinned backend.
  - A WSL-only machine refuses rather than running in WSL.
- Remote Host: a Linux Host offers no Git Bash; a conversation pinned to a backend the target lacks refuses with a clear reason.
- Older Host: the new UI hides backend selection when the Host does not advertise the contract; the sidecar fallback still runs.
- Logs record backend, startup fields, target and refusal reason, never the full env or credentials.

## Open after this plan

- Whether the five divergent default policies should be unified (D8 defers it).
- Whether to extend the conversation pin to resumed and forked conversations, or re-pin them.
- brush in-process embedding (`brush-core`) as a future backend kind: the launch plan would need an in-process session variant.
