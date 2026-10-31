/**
 * lark-cli execFile wrapper (ADR-0026).
 *
 * Spawns the user's installed lark-cli binary with argv directly — no
 * shell interpolation. Caps mirror `sidecar/src/tools/builtin/shell-advanced/index.ts`:
 *   - 5-minute timeout (skill caller may shorten)
 *   - 1 MB stdout cap (lark-cli list/search responses can be sizeable)
 *   - `windowsHide: true` so no console window flashes on Windows
 *
 * Returns a structured `LarkCliResult`:
 *   - `ok` payload — parsed JSON when stdout starts with `{` or `[`;
 *                    raw string otherwise.
 *   - `error` payload — exit code, stderr, signal, timedOut flag.
 *
 * The helper deliberately does NOT short-circuit on exit code `10`
 * (lark-cli's "confirmation required" signal). The built-in skill
 * dispatcher owns HITL — by the time we shell to lark-cli we've
 * already routed through the confirm-card path, so the helper just
 * always passes `--yes` when the caller marks the invocation as
 * confirmed. Skills that don't pass `confirmed: true` and receive
 * exit 10 surface that as a structured error so the assistant can
 * decide whether to re-prompt.
 *
 * Binary discovery (cross-platform):
 *   1. `process.env.LARK_CLI_BIN` — explicit override, used in tests.
 *   2. PATH lookup via `which` / `where` semantics inside `execFile`
 *      (Node 18+ resolves PATH transparently).
 *   3. Windows-only fallback: `%APPDATA%\npm\lark-cli.cmd` (where the
 *      `lark-cli` npm package installs itself globally).
 */

import { resolveLarkAuth, type LarkAuthBridgeResult } from "./auth-bridge"
import { runLarkCliProcess, type LarkCliProcessResult } from "./process"
import type { BuiltInSkillContext } from "../types"

const MAX_STDOUT_BYTES = 1024 * 1024 // 1 MB
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 5 * 60 * 1000

const LARK_CLI_EXIT_HITL_REQUIRED = 10

export interface ExecLarkCliInput {
  context?: BuiltInSkillContext
  /**
   * Subcommand argv excluding the binary name. e.g.
   *   ["calendar", "+list-events", "--calendar-id", "cal_1", "--json"]
   */
  args: readonly string[]
  /** Per-call timeout (clamped to MAX_TIMEOUT_MS). */
  timeoutMs?: number
  /**
   * Pass `--yes` when set. The dispatcher sets this on the HITL-bypass
   * re-fire path so lark-cli's own confirmation gate is satisfied.
   */
  confirmed?: boolean
  /** Override the auth bridge identity (defaults to user). */
  identity?: "user" | "bot"
  /**
   * Explicit Cognia connection. IM calls stay on their bound adapter;
   * local calls without a selection require a single enabled connection.
   */
  adapterId?: string
  /**
   * Test override — when set, the helper uses this object instead of
   * calling `resolveLarkAuth`. Bypasses Dexie + keyring so unit tests
   * don't need a full database fixture.
   */
  __authOverride?: LarkAuthBridgeResult
}

export type LarkCliResult =
  | {
      status: "ok"
      adapterId: string
      identity: "user" | "bot"
      /** Parsed JSON when stdout begins `{`/`[`; raw string otherwise. */
      data: unknown
      stderr: string
      durationMs: number
    }
  | {
      status: "error"
      reason:
        | "auth_unavailable"
        | "binary_not_found"
        | "non_zero_exit"
        | "hitl_required"
        | "timeout"
        | "json_parse_failed"
        | "output_truncated"
        | "invalid_account_selection"
      message: string
      exitCode?: number
      stderr?: string
      adapterId?: string
    }

export async function execLarkCli(input: ExecLarkCliInput): Promise<LarkCliResult> {
  const auth =
    input.__authOverride ??
    (await resolveLarkAuth({
      adapterId: input.adapterId,
      identity: input.identity,
      context: input.context,
    }))
  if (!auth.ok) {
    return {
      status: "error",
      reason: "auth_unavailable",
      message: auth.message,
      adapterId: "adapterId" in auth ? auth.adapterId : undefined,
    }
  }

  const binary = locateLarkCliBinary()

  const argv = accountBoundArgs(input.args, auth.identity)
  if (!argv) {
    return {
      status: "error",
      reason: "invalid_account_selection",
      message:
        "Lark CLI identity must match the selected Cognia connection. Select a connection with adapterId, not --profile or another --as identity.",
      adapterId: auth.adapterId,
    }
  }
  if (input.confirmed && !argv.includes("--yes")) {
    argv.push("--yes")
  }

  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const start = Date.now()
  const result = await runLarkCliProcess(binary, argv, {
    env: auth.env,
    timeoutMs,
    maxOutputBytes: MAX_STDOUT_BYTES,
  })
  if (result.truncated) {
    return {
      status: "error",
      reason: "output_truncated",
      message: `lark-cli output exceeded the ${MAX_STDOUT_BYTES}-byte limit; partial output was discarded.`,
      adapterId: auth.adapterId,
      exitCode: result.exitCode,
    }
  }
  if (
    !result.notFound &&
    !result.timedOut &&
    (result.exitCode === undefined || result.exitCode === 0)
  ) {
    const data = tryParseJson(result.stdout)
    return {
      status: "ok",
      adapterId: auth.adapterId,
      identity: auth.identity,
      data,
      stderr: result.stderr,
      durationMs: Date.now() - start,
    }
  }
  return interpretError(result, auth.adapterId)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// These are the valueless switches emitted by the certified skill builders.
// Other flags take a value, which must remain data even when it looks like
// --profile or --as=bot (for example a document's literal content).
const SWITCH_FLAGS = new Set([
  "--yes",
  "--dry-run",
  "--match-case",
  "--match-entire-cell",
  "--complete",
  "--help",
  "-h",
  "--version",
  "-v",
])

function accountBoundArgs(args: readonly string[], identity: "user" | "bot"): string[] | undefined {
  const command: string[] = []
  let identityCount = 0
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "--") {
      command.push(...args.slice(i))
      break
    }
    if (arg === "--profile" || arg.startsWith("--profile=")) return
    if (arg === "--as" || arg.startsWith("--as=")) {
      const requested = arg === "--as" ? args[++i] : arg.slice("--as=".length)
      identityCount += 1
      if (requested !== identity || identityCount > 1) return
      continue
    }
    command.push(arg)
    if (
      arg.startsWith("--") &&
      !arg.includes("=") &&
      !SWITCH_FLAGS.has(arg) &&
      i + 1 < args.length
    ) {
      command.push(args[++i])
    }
  }
  return ["--as", identity, ...command]
}

/** Test escape hatch. */
export function __setLarkCliBinaryForTests(path: string | null): void {
  testBinaryOverride = path
}
let testBinaryOverride: string | null = null

function locateLarkCliBinary(): string {
  if (testBinaryOverride) return testBinaryOverride
  const fromEnv = process.env.LARK_CLI_BIN?.trim()
  if (fromEnv) return fromEnv
  if (process.platform === "win32") {
    return "lark-cli.cmd"
  }
  return "lark-cli"
}

function tryParseJson(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Fall through to return raw — caller can decide.
    }
  }
  return trimmed
}

function interpretError(result: LarkCliProcessResult, adapterId: string): LarkCliResult {
  const stderr = result.stderr
  const exitCode = result.exitCode
  if (result.timedOut) {
    return {
      status: "error",
      reason: "timeout",
      message: "lark-cli timed out.",
      stderr,
      adapterId,
    }
  }
  if (result.notFound) {
    return {
      status: "error",
      reason: "binary_not_found",
      message: "lark-cli binary not found (ENOENT).",
      adapterId,
    }
  }
  if (exitCode === LARK_CLI_EXIT_HITL_REQUIRED) {
    return {
      status: "error",
      reason: "hitl_required",
      message:
        "lark-cli reported confirmation required (exit 10). Re-invoke with confirmed:true after user approves the confirm card.",
      exitCode,
      stderr,
      adapterId,
    }
  }
  return {
    status: "error",
    reason: "non_zero_exit",
    message: stderr || `lark-cli exited with code ${exitCode}.`,
    exitCode,
    stderr,
    adapterId,
  }
}
