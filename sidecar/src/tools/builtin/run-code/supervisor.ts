// Sandbox supervisor for the Code tool presentation (ADR-0117, Phase 4).
//
// Owns everything the child cannot be trusted to own: whether a sandbox exists
// at all, which tools may be called, how many times, for how long, and how big
// the answer may be. The child asks; this decides.
//
// The fail-closed rule is enforced in exactly one place — `assertSandboxable()`
// — and there is no option, flag, or environment variable that turns it into a
// warning. "Run it unsandboxed just this once" is the failure this design
// exists to make unrepresentable.

import { execFile, fork, spawn } from "node:child_process"
import type { SpawnOptions } from "node:child_process"
import { fileURLToPath } from "node:url"

import limits from "../../../../../lib/ai/code-mode/limits.json" with { type: "json" }
import { classifyToolFailure } from "../../kernel/failure.ts"
import type { ToolFailureMeta } from "../../kernel/result.ts"
import { trackForegroundGroup } from "../../state/foreground-groups.ts"
import { runAdmission } from "./admission.ts"
import type { RunAdmissionGate, RunAdmissionLimit } from "./admission.ts"
import { checkToolEligibility, programmaticReadOnlyToolNames } from "./eligibility.ts"
import { CHILD_MESSAGE_KINDS } from "./sandbox-child.ts"

const CHILD_PATH = fileURLToPath(new URL("./sandbox-child.ts", import.meta.url))

export { limits as CODE_MODE_LIMITS }

/** The code-mode budgets; tests override single fields. */
export type CodeModeLimits = typeof limits

export type SandboxUnavailableReason = "no-fork" | "no-strict-sandbox" | "no-workdir"

/** What the host can offer a program: a process to run it in, and confinement. */
export interface SandboxProbe {
  canSpawnProcess: boolean
  strictSandbox: boolean
  launcher?: string[] | null | undefined
}

/** A budget a run hit. */
export interface CodeLimit {
  kind: string
  limit: number
  observed?: number | undefined
}

export interface CodeRunLog {
  level: string
  text: string
}

/**
 * Where a failed run stopped. `compile`: the source did not parse, so the
 * program never ran. `run`: the program threw. `cancelled`: the turn was
 * stopped. `limit`: a budget was hit. `busy`: the session or the Host already
 * ran as many programs as it may, for longer than a program may wait.
 * `sandbox`: the child or its supervision failed (crash, OS measurement
 * unavailable).
 */
export type CodeRunFailurePhase = "compile" | "run" | "cancelled" | "limit" | "busy" | "sandbox"

/** What every outcome carries besides its result. */
interface CodeRunTally {
  callsUsed: number
  logs: CodeRunLog[]
  /** Log output past `maxLogBytes` was dropped. */
  logsTruncated?: true
  /**
   * The process group or a nested call was still alive when the grace ran
   * out. Its effects are unknown; read-only tools make that "nothing written",
   * but the run did not prove it stopped.
   */
  stopUnconfirmed?: true
}

export type CodeRunResult =
  | ({ ok: true; result: unknown } & CodeRunTally)
  | ({
      ok: false
      error: { name: string; message: string }
      phase: CodeRunFailurePhase
      limit?: CodeLimit | undefined
    } & CodeRunTally)

/**
 * A nested call's failure as the broker classified it. Thrown by
 * `callTool`; the supervisor hands the kind to the program so both rails give
 * the same tool failure the same shape (CM-08).
 */
export class NestedToolError extends Error {
  declare failure: ToolFailureMeta

  constructor(message: string, failure: ToolFailureMeta) {
    super(message)
    this.name = "NestedToolError"
    this.failure = failure
  }
}

/** How long cancelled nested calls and a killed process group get to finish. */
export const RUN_CODE_STOP_GRACE_MS = 1_000

/** A child message, as far as the supervisor reads it; every field is untrusted. */
interface ChildMessage {
  kind?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  level?: unknown
  text?: unknown
  result?: unknown
  error?: unknown
  phase?: unknown
}

const errorText = (err: unknown) => String((err as { message?: unknown } | null)?.message ?? err)

/** Thrown when the strict sandbox is unavailable. Never downgraded to a warning. */
export class SandboxUnavailableError extends Error {
  declare reason: SandboxUnavailableReason

  constructor(reason: SandboxUnavailableReason) {
    super(`Code mode requires a strict sandbox (${reason})`)
    this.name = "SandboxUnavailableError"
    this.reason = reason
  }
}

/**
 * Env var carrying the OS-confinement launcher, as a JSON argv array.
 *
 * The host (Rust, which owns `crate::sandbox` and knows whether the backend is
 * `macos-sandbox-exec`, `linux-bwrap`, or absent) renders the wrapper argv and
 * hands it over at sidecar spawn. Example:
 * `["/usr/bin/sandbox-exec","-f","/path/profile.sb"]`.
 *
 * This is deliberately a *mechanism*, not a boolean. An earlier version keyed
 * strictness off a bare `COGNIA_STRICT_SANDBOX=1` flag, which was a claim
 * anybody could set without any confinement existing — and since the sidecar
 * itself runs unconfined (it needs network to reach the model), a child forked
 * from it inherits nothing. Requiring the argv means "strict" is true exactly
 * when there is a real wrapper to exec through.
 */
export const SANDBOX_LAUNCHER_ENV = "COGNIA_CODE_SANDBOX_LAUNCHER"

/**
 * Parse the launcher argv. Returns `null` when absent or malformed.
 *
 * Malformed is treated as absent rather than as an error, because the
 * consequence of "absent" is failing closed — the safe direction — whereas
 * throwing here would turn a misconfigured host into a crash.
 */
export function parseSandboxLauncher(raw: string | undefined): string[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null
  try {
    const argv: unknown = JSON.parse(raw)
    if (!Array.isArray(argv) || argv.length === 0) return null
    if (!argv.every((part) => typeof part === "string" && part.length > 0)) return null
    return argv as string[]
  } catch {
    return null
  }
}

/**
 * Probe the host.
 *
 * Returns the same shape `lib/ai/code-mode/availability.ts` consumes, so the
 * renderer's "is Code offered?" and the sidecar's "may I spawn?" answer the
 * same question from the same evidence. `overrides` are injected by tests.
 */
export function probeSandbox(
  overrides: { fork?: unknown; launcher?: string[] | null } = {}
): SandboxProbe & { launcher: string[] | null } {
  const canSpawnProcess =
    overrides.fork !== undefined ? Boolean(overrides.fork) : typeof fork === "function"
  const launcher =
    overrides.launcher !== undefined
      ? overrides.launcher
      : parseSandboxLauncher(process.env[SANDBOX_LAUNCHER_ENV])
  return { canSpawnProcess, strictSandbox: Array.isArray(launcher), launcher: launcher ?? null }
}

export function assertSandboxable(probe: SandboxProbe | null | undefined): void {
  if (!probe?.canSpawnProcess) throw new SandboxUnavailableError("no-fork")
  if (!probe.strictSandbox || !Array.isArray(probe.launcher) || probe.launcher.length === 0) {
    throw new SandboxUnavailableError("no-strict-sandbox")
  }
}

/**
 * The environment the child gets.
 *
 * Built by construction rather than by deleting keys from `process.env`: the
 * sidecar's environment carries ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN,
 * and a deny-list would leak every future secret nobody remembered to add.
 */
export function sandboxEnv({ standalone = false }: { standalone?: boolean } = {}): Record<
  string,
  string
> {
  return {
    COGNIA_CODE_SANDBOX_CHILD: "1",
    // Node itself needs almost nothing. NODE_ENV is passed so the child's
    // runtime assertions behave the same as the rest of the sidecar.
    NODE_ENV: process.env.NODE_ENV === "production" ? "production" : "development",
    ...(standalone ? { BUN_OPTIONS: "--smol", COGNIA_ROLE: "run-code" } : {}),
  }
}

/** Resolve the strict-launcher command without treating a compiled CLI as Node. */
export function resolveSandboxSpawn({
  standalone,
  bun = false,
  launcher,
  execPath,
  childPath,
  maxMemoryBytes,
}: {
  standalone: boolean
  bun?: boolean
  launcher: readonly string[]
  execPath: string
  childPath: string
  maxMemoryBytes: number
}): { command: string; args: string[]; env: Record<string, string> } {
  const runtimeArgs = standalone
    ? []
    : bun
      ? ["--smol", childPath]
      : [`--max-old-space-size=${Math.floor(maxMemoryBytes / (1024 * 1024))}`, childPath]
  return {
    command: launcher[0]!,
    args: [...launcher.slice(1), execPath, ...runtimeArgs],
    env: sandboxEnv({ standalone }),
  }
}

/** The `ps` call RSS sampling makes; injectable so tests need no real process. */
export type ExecFileImpl = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number },
  callback: (error: (Error & { code?: unknown }) | null, stdout: string) => void
) => unknown

/**
 * Return resident bytes for the entire sandbox process group.
 *
 * Bun does not expose a hard heap-size flag equivalent to Node's
 * `--max-old-space-size`. The child therefore runs in its own process group and
 * the trusted supervisor accounts for the wrapper plus every descendant. A
 * missing or unparsable `ps` result fails closed instead of silently dropping
 * the documented memory boundary.
 *
 * Asynchronous on purpose (CM-13). The supervisor runs inside the sidecar,
 * which serves every session on the Host; a synchronous `ps` every 25 ms
 * blocked that event loop for most of each sample, so one `run_code` call
 * stalled every other session's stream and IPC.
 */
export function readProcessGroupRssBytes(
  processGroupId: number | undefined,
  { execFileImpl = execFile as unknown as ExecFileImpl }: { execFileImpl?: ExecFileImpl } = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    execFileImpl(
      "ps",
      ["-axo", "pid=,pgid=,rss="],
      { encoding: "utf8", timeout: 2_000 },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              `cannot enforce sandbox memory limit: ps failed (${String(error.code ?? error.message)})`
            )
          )
          return
        }
        let rssKilobytes = 0
        let matched = false
        for (const line of String(stdout ?? "").split("\n")) {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
          if (!match || Number(match[2]) !== processGroupId) continue
          matched = true
          rssKilobytes += Number(match[3])
        }
        if (!matched || !Number.isSafeInteger(rssKilobytes)) {
          reject(new Error("cannot enforce sandbox memory limit: process group RSS is unavailable"))
          return
        }
        resolve(rssKilobytes * 1024)
      }
    )
  })
}

/**
 * Tracks the two budgets that only exist while a program runs.
 *
 * The numbers come from `lib/ai/code-mode/limits.json`, which the SDK
 * declaration also reads, so the ceiling the model is told and the one
 * enforced here cannot diverge.
 */
export class CallBudget {
  declare config: Pick<CodeModeLimits, "maxToolCalls" | "maxConcurrency">
  declare used: number
  declare inFlight: number

  constructor(config: Pick<CodeModeLimits, "maxToolCalls" | "maxConcurrency"> = limits) {
    this.config = config
    this.used = 0
    this.inFlight = 0
  }

  get callsUsed(): number {
    return this.used
  }

  tryAcquire():
    | { ok: true }
    | { ok: false; exceeded: CodeLimit }
    | { ok: false; retry: true; exceeded?: undefined } {
    if (this.used >= this.config.maxToolCalls) {
      return { ok: false, exceeded: { kind: "tool-calls", limit: this.config.maxToolCalls } }
    }
    if (this.inFlight >= this.config.maxConcurrency) return { ok: false, retry: true }
    this.used += 1
    this.inFlight += 1
    return { ok: true }
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
  }
}

/**
 * Run one program.
 *
 * `callTool` re-enters the host's real tool registry. The supervisor never
 * touches a tool implementation directly — argument validation, permissions,
 * confinement, and the canonical event log all live behind this call.
 * `config` overrides the limits, for tests.
 *
 * Stopping is one path for every reason (CM-10): the program returns or
 * fails, a budget is hit, the child dies, or the turn's `signal` aborts. Each
 * closes admission first (a `tool-call` that arrives afterwards is never
 * dispatched), then aborts the signal every in-flight nested call and its
 * approval wait were handed, kills the process group, and waits a bounded
 * grace for both. A run that cannot show both ended says `stopUnconfirmed`.
 *
 * With `sessionId` the process group is also registered with the session's
 * foreground groups, so Stop's process teardown and its stop proof cover a
 * `run_code` child the same way they cover a foreground `bash` (ADR-0244).
 */
export async function runCodeProgram({
  source,
  callTool,
  probe,
  config = limits,
  onLog,
  signal,
  sessionId,
  groupProofSupported,
  readRss = readProcessGroupRssBytes,
  admit = runAdmission.acquire,
}: {
  source: string
  callTool: (name: string, input: unknown, signal: AbortSignal) => Promise<unknown>
  probe?: SandboxProbe | undefined
  config?: CodeModeLimits | undefined
  onLog?: ((level: string, text: string) => void) | undefined
  /** The turn's abort signal. Aborting it cancels the program. */
  signal?: AbortSignal | undefined
  /** Session that owns the process group, for Stop and its proof. */
  sessionId?: string | undefined
  groupProofSupported?: boolean | undefined
  /** RSS sampler; tests inject one. */
  readRss?: (processGroupId: number | undefined) => Promise<number>
  /** Concurrency admission (CM-11); the sidecar's own table unless injected. */
  admit?: RunAdmissionGate
}): Promise<CodeRunResult> {
  const resolvedProbe = probe ?? probeSandbox()
  assertSandboxable(resolvedProbe)

  const sourceBytes = Buffer.byteLength(source ?? "", "utf8")
  if (sourceBytes > config.maxSourceBytes) {
    return failure("source-too-large", config.maxSourceBytes, sourceBytes)
  }
  if (signal?.aborted) return cancelledBeforeStart()

  // A session runs one program at a time and the Host a few (CM-11). Waiting
  // here spends none of the program's own wall time, and follows the turn.
  const admission = await admit({ sessionId, signal, limits: config })
  if (!admission.ok) {
    return admission.reason === "cancelled" ? cancelledBeforeStart() : busy(admission.limit)
  }
  try {
    return await runAdmitted()
  } finally {
    admission.release()
  }

  async function runAdmitted(): Promise<CodeRunResult> {
    const budget = new CallBudget(config)
    const logs: CodeRunLog[] = []
    let logBytes = 0
    let logsTruncated = false
    let resultBytes = 0
    const toolNames = programmaticReadOnlyToolNames()
    const standalone = Boolean(
      (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun?.isStandaloneExecutable
    )
    const target = resolveSandboxSpawn({
      standalone,
      bun: Boolean(process.versions.bun),
      launcher: resolvedProbe.launcher ?? [],
      execPath: process.execPath,
      childPath: CHILD_PATH,
      maxMemoryBytes: config.maxMemoryBytes,
    })
    const spawnOptions: SpawnOptions = {
      // No `cwd` override on purpose. The launcher's policy defines the child's
      // filesystem view — `bwrap` chdirs into its own scratch bind, and the
      // macOS profile scopes reads and writes explicitly. An earlier version
      // created its own `mkdtemp` here, which the host-rendered policy knew
      // nothing about, so the child started in a directory the profile did not
      // grant. Letting the confinement own the cwd removes the mismatch instead
      // of duplicating a path convention across Rust and Node.
      env: target.env,
      // A dedicated process group lets the trusted parent account for and kill
      // the sandbox wrapper plus all descendants as one memory-bounded unit.
      // Code mode already fails closed on Windows because no strict launcher is
      // available there.
      detached: process.platform !== "win32",
      // The child must not inherit the sidecar's stdio: its stdout would
      // interleave with the sidecar's own protocol stream. Slot 3 is the IPC
      // channel; both `bwrap` and `sandbox-exec` pass inherited fds through, so
      // the tool-call protocol survives the confinement wrapper.
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }

    const child = resolvedProbe.launcher
      ? spawn(target.command, target.args, spawnOptions)
      : // Unreachable: `assertSandboxable` already rejected a probe with no
        // launcher. Kept as a throw rather than a `fork` fallback so that a future
        // edit to the assertion cannot silently reintroduce an unconfined path.
        (() => {
          throw new SandboxUnavailableError("no-strict-sandbox")
        })()
    // Session-owned, so Stop's teardown signals the group and its proof waits
    // for it; the registry's exit hook also kills it if the sidecar exits first.
    if (sessionId) trackForegroundGroup(sessionId, child, groupProofSupported ?? true)
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve())
      child.once("error", () => resolve())
    })

    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let memoryTimer: ReturnType<typeof setInterval> | null = null
    // Every nested call gets this signal: settling the run aborts them, and the
    // turn's own abort reaches them through it.
    const runAbort = new AbortController()
    const inFlight = new Set<Promise<void>>()

    const killGroup = () => {
      try {
        if (spawnOptions.detached && child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
    }

    /** A run outcome before the budget and logs are attached. */
    type Outcome =
      | { ok: true; result: unknown }
      | {
          ok: false
          error: { name: string; message: string }
          phase: CodeRunFailurePhase
          limit?: CodeLimit
        }

    return await new Promise<CodeRunResult>((resolve) => {
      const onAbort = () =>
        settle({
          ok: false,
          error: { name: "AbortError", message: "run_code was cancelled" },
          phase: "cancelled",
        })

      const settle = (value: Outcome) => {
        if (settled) return
        // Admission closes before anything else: from here no tool-call message
        // is dispatched, whatever the child still has queued.
        settled = true
        if (timer) clearTimeout(timer)
        if (memoryTimer) clearInterval(memoryTimer)
        signal?.removeEventListener("abort", onAbort)
        runAbort.abort(new Error("run_code finished"))
        killGroup()
        void (async () => {
          const stopped = await settledWithin(
            Promise.all([exited, Promise.allSettled([...inFlight])]),
            RUN_CODE_STOP_GRACE_MS
          )
          resolve({
            ...value,
            callsUsed: budget.callsUsed,
            logs,
            ...(logsTruncated ? { logsTruncated: true as const } : {}),
            ...(stopped ? {} : { stopUnconfirmed: true as const }),
          })
        })()
      }

      signal?.addEventListener("abort", onAbort, { once: true })

      timer = setTimeout(() => {
        settle({
          ok: false,
          error: { name: "CodeLimitExceeded", message: "wall time exceeded" },
          phase: "limit",
          limit: { kind: "wall-time", limit: config.wallTimeMs },
        })
      }, config.wallTimeMs)

      // One sample at a time: a slow `ps` skips ticks instead of piling up.
      let sampling = false
      const enforceMemoryLimit = async () => {
        if (sampling || settled) return
        sampling = true
        try {
          const observed = await readRss(child.pid)
          if (observed <= config.maxMemoryBytes) return
          settle({
            ok: false,
            error: { name: "CodeLimitExceeded", message: "memory limit exceeded" },
            phase: "limit",
            limit: { kind: "memory", limit: config.maxMemoryBytes, observed },
          })
        } catch (error) {
          settle({
            ok: false,
            error: { name: "SandboxError", message: errorText(error) },
            phase: "sandbox",
          })
        } finally {
          sampling = false
        }
      }
      memoryTimer = setInterval(() => void enforceMemoryLimit(), 25)
      memoryTimer.unref?.()
      void enforceMemoryLimit()

      child.on("error", (error) => {
        settle({
          ok: false,
          error: { name: "SandboxError", message: errorText(error) },
          phase: "sandbox",
        })
      })

      child.on("exit", (code, signalName) => {
        // An exit before a DONE/FAILED message means the child died — OOM kill
        // lands here, and reporting it as a crash rather than as a result is the
        // difference between "the limit worked" and "the answer was empty".
        settle({
          ok: false,
          error: {
            name: "SandboxError",
            message: `sandbox exited unexpectedly (code=${code}, signal=${signalName})`,
          },
          phase: "sandbox",
        })
      })

      child.on("message", (raw: unknown) => {
        if (settled || !raw || typeof raw !== "object") return
        const message = raw as ChildMessage

        switch (message.kind) {
          case CHILD_MESSAGE_KINDS.READY:
            child.send({ kind: CHILD_MESSAGE_KINDS.START, source, toolNames })
            return

          case CHILD_MESSAGE_KINDS.LOG:
            recordLog(String(message.level), String(message.text))
            return

          case CHILD_MESSAGE_KINDS.TOOL_CALL: {
            const call = handleToolCall(message)
            inFlight.add(call)
            void call.finally(() => inFlight.delete(call))
            return
          }

          case CHILD_MESSAGE_KINDS.DONE: {
            const serialized = safeStringify(message.result)
            if (Buffer.byteLength(serialized, "utf8") > config.maxResultBytes) {
              settle({
                ok: false,
                error: { name: "CodeLimitExceeded", message: "result too large" },
                phase: "limit",
                limit: {
                  kind: "result-too-large",
                  limit: config.maxResultBytes,
                  observed: Buffer.byteLength(serialized, "utf8"),
                },
              })
              return
            }
            settle({ ok: true, result: message.result })
            return
          }

          case CHILD_MESSAGE_KINDS.FAILED:
            settle({
              ok: false,
              // The child sends only `{ name, message }` (see sandbox-child.ts).
              error: (message.error as { name: string; message: string } | undefined) ?? {
                name: "Error",
                message: "unknown",
              },
              phase: message.phase === "compile" ? "compile" : "run",
            })
            return

          default:
            return
        }
      })

      /** Keep console output bounded per entry and in total. */
      function recordLog(level: string, text: string) {
        if (logsTruncated) return
        const entry = truncateUtf8(text, config.maxLogEntryBytes)
        const bytes = Buffer.byteLength(entry, "utf8")
        if (logBytes + bytes > config.maxLogBytes) {
          logsTruncated = true
          return
        }
        logBytes += bytes
        logs.push({ level, text: entry })
        onLog?.(level, entry)
      }

      async function handleToolCall(message: ChildMessage) {
        const reply = (patch: { result?: unknown; error?: string; failure?: ToolFailureMeta }) => {
          if (settled) return
          child.send({ kind: CHILD_MESSAGE_KINDS.TOOL_RESULT, id: message.id, ...patch })
        }
        const refuse = (error: string, failureMeta: ToolFailureMeta) =>
          reply({ error, failure: failureMeta })

        // The allowlist is re-checked here even though the child was only handed
        // eligible names. The child is the untrusted side; a name it invents must
        // die at this boundary, not at the registry.
        const eligibility = checkToolEligibility(message.name)
        if (!eligibility.allowed) {
          refuse(
            `tool "${String(message.name)}" is not callable from code (${eligibility.reason})`,
            {
              kind: "permission-denied",
              retryable: false,
            }
          )
          return
        }

        const inputBytes = Buffer.byteLength(safeStringify(message.input), "utf8")
        if (inputBytes > config.maxToolInputBytes) {
          refuse(
            `input for "${String(message.name)}" is ${inputBytes} bytes, over the ${config.maxToolInputBytes}-byte limit for one call`,
            { kind: "invalid-args", retryable: false }
          )
          return
        }

        const slot = budget.tryAcquire()
        if (!slot.ok && slot.exceeded) {
          settle({
            ok: false,
            error: { name: "CodeLimitExceeded", message: "tool call budget exhausted" },
            phase: "limit",
            limit: slot.exceeded,
          })
          return
        }
        if (!slot.ok) {
          refuse("too many concurrent tool calls; await earlier calls first", {
            kind: "resource-exhausted",
            retryable: true,
          })
          return
        }

        try {
          const result = await callTool(message.name as string, message.input, runAbort.signal)
          if (settled) return
          const bytes = Buffer.byteLength(safeStringify(result), "utf8")
          if (bytes > config.maxToolResultBytes) {
            refuse(
              `result of "${String(message.name)}" is ${bytes} bytes, over the ${config.maxToolResultBytes}-byte limit for one call; ask for less`,
              { kind: "resource-exhausted", retryable: false }
            )
            return
          }
          resultBytes += bytes
          if (resultBytes > config.maxTotalToolResultBytes) {
            settle({
              ok: false,
              error: { name: "CodeLimitExceeded", message: "tool results too large in total" },
              phase: "limit",
              limit: {
                kind: "tool-result-bytes",
                limit: config.maxTotalToolResultBytes,
                observed: resultBytes,
              },
            })
            return
          }
          reply({ result })
        } catch (error) {
          const meta =
            error instanceof NestedToolError
              ? error.failure
              : (() => {
                  const classified = classifyToolFailure(error)
                  return { kind: classified.kind, retryable: classified.retryable }
                })()
          refuse(errorText(error), meta)
        } finally {
          budget.release()
        }
      }
    })
  }
}

/** Resolve true when `work` settles within `ms`, false when the grace runs out. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([work.then(() => true as const), expired])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Cut a UTF-8 string to at most `max` bytes, marking the cut. */
function truncateUtf8(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text
  const marker = "…[truncated]"
  const budget = Math.max(0, max - Buffer.byteLength(marker, "utf8"))
  let cut = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8")
  // A cut through a multi-byte character decodes to U+FFFD; drop it.
  if (cut.endsWith("�")) cut = cut.slice(0, -1)
  return cut + marker
}

function failure(kind: string, limit: number, observed: number): CodeRunResult {
  return {
    ok: false,
    error: { name: "CodeLimitExceeded", message: kind },
    phase: "limit",
    limit: { kind, limit, observed },
    callsUsed: 0,
    logs: [],
  }
}

function busy(limit: RunAdmissionLimit): CodeRunResult {
  return {
    ok: false,
    error: {
      name: "CodeLimitExceeded",
      message:
        limit.kind === "concurrent-runs-session"
          ? "another run_code program of this session is still running"
          : "this Host is running as many run_code programs as it allows",
    },
    phase: "busy",
    limit,
    callsUsed: 0,
    logs: [],
  }
}

function cancelledBeforeStart(): CodeRunResult {
  return {
    ok: false,
    error: { name: "AbortError", message: "run_code was cancelled before it started" },
    phase: "cancelled",
    callsUsed: 0,
    logs: [],
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? "null"
  } catch {
    return String(value)
  }
}
