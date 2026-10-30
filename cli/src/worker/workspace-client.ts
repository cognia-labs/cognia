import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type {
  ApplyOutcome,
  BeginTaskWorkspaceTurn,
  PatchSet,
  ResourceChange,
  TaskRun,
  TaskWorkspace,
} from "@/lib/task-workspace/types"
import type {
  AgentWorkspaceCaptureReceipt,
  AgentWorkspaceCaptureUnavailableReason,
} from "@cognia/agent-config-types/agent-run-result"

export interface WorkerWorkspaceBinding {
  bindingRef: string
  sourceRoot: string
  gitCommonDir: string
  repositoryFingerprint: string
  createdAt: number
  updatedAt: number
}

interface WorkerWorkspaceClientOptions {
  dataDir: string
  helperPath?: string
  requestTimeoutMs?: number
  spawn?: (
    command: string,
    args: readonly string[],
    options: { stdio: ["pipe", "pipe", "pipe"] }
  ) => ChildProcessWithoutNullStreams
}

export interface WorkerWorkspaceCapture {
  assertExecutionAllowed(workspaceRoot: string): Promise<void>
  begin(input: BeginTaskWorkspaceTurn, repositoryRef?: string): Promise<TaskRun>
  settle(
    runId: string,
    finalState?: "ready" | "failed" | "cancelled",
    executorStopped?: true
  ): Promise<ResourceChange[]>
  markExecutorUnconfirmed(runId: string): Promise<void>
  getPatch(runId: string): Promise<PatchSet | null>
  readDiff(runId: string, path: string, allowSensitive?: boolean): Promise<string>
  listTasks(sessionId?: string): Promise<TaskWorkspace[]>
  listRuns(taskId: string): Promise<TaskRun[]>
  undo(runId: string): Promise<ApplyOutcome>
  close(): Promise<void>
}

export interface WorkerWorkspaceCaptureLease {
  sessionId: string
  taskId: string
  runId: string
  workspaceRoot: string
  executionRoot: string
  settle(finalState: "ready" | "failed" | "cancelled"): Promise<void>
  markExecutorUnconfirmed(): Promise<void>
  close(): Promise<void>
}

export interface WorkerTurnCapture {
  finish(
    finalState: "ready" | "failed" | "cancelled",
    executorStopped?: boolean
  ): Promise<AgentWorkspaceCaptureReceipt>
}

function sameWorkspaceDirectory(expected: string, actual: unknown): actual is string {
  if (typeof actual !== "string" || !path.isAbsolute(actual)) return false
  if (actual === path.resolve(expected)) return true
  try {
    return fs.realpathSync(actual) === fs.realpathSync(expected)
  } catch {
    return false
  }
}

/** Shared per-turn owner for unified runs and direct terminal session sends. */
export async function openWorkerTurnCapture(
  request: {
    input: BeginTaskWorkspaceTurn
    persist: boolean
    unavailableReason?: AgentWorkspaceCaptureUnavailableReason
    inherited?: WorkerWorkspaceCaptureLease
  },
  options: WorkerWorkspaceClientOptions & { openCapture?: () => WorkerWorkspaceCapture }
): Promise<WorkerTurnCapture> {
  const { input, inherited } = request
  const unavailableReason = !request.persist ? "persistence-disabled" : request.unavailableReason
  let receipt: AgentWorkspaceCaptureReceipt = {
    available: false,
    reason: unavailableReason ?? "not-started",
  }
  let run: { taskId: string; runId: string; workspaceRoot: string } | undefined
  let owner:
    Pick<WorkerWorkspaceCapture, "settle" | "markExecutorUnconfirmed" | "close"> | undefined
  if (inherited) {
    if (
      inherited.sessionId === input.sessionId &&
      sameWorkspaceDirectory(input.workspaceRoot, inherited.executionRoot)
    ) {
      run = {
        taskId: inherited.taskId,
        runId: inherited.runId,
        workspaceRoot: inherited.workspaceRoot,
      }
      owner = {
        settle: async (_runId, state = "ready") => {
          await inherited.settle(state)
          return []
        },
        close: () => inherited.close(),
        markExecutorUnconfirmed: () => inherited.markExecutorUnconfirmed(),
      }
    } else {
      // A mismatched lease is not proof that its executor has stopped.
      await inherited.markExecutorUnconfirmed().catch(() => undefined)
      await inherited.close().catch(() => undefined)
      throw new WorkerWorkspaceError(
        "capture_refused",
        "Workspace capture lease does not match this session and execution root"
      )
    }
  } else if (!request.persist && !request.unavailableReason) {
    let admission: WorkerWorkspaceCapture | undefined
    try {
      admission = options.openCapture?.() ?? createWorkerWorkspaceClient(options).openCapture()
      await admission.assertExecutionAllowed(input.workspaceRoot)
    } catch (error) {
      if (isWorkspaceCaptureRefusal(error)) throw error
      // Untracked mode needs no helper, but must honor an authoritative fence
      // when the local ledger can answer. This probe creates no run or snapshot.
    } finally {
      await admission?.close().catch(() => undefined)
    }
  } else if (!unavailableReason) {
    let began = false
    try {
      const capture = options.openCapture?.() ?? createWorkerWorkspaceClient(options).openCapture()
      owner = capture
      const observed = await capture.begin({ ...input, observeInPlace: true })
      began = true
      if (
        observed.runId !== input.runId ||
        observed.taskId !== input.taskId ||
        observed.isolationKind !== "observed" ||
        observed.workspaceId !== null ||
        // Older helpers must be retired before execution: their EOF handler
        // cannot preserve an unconfirmed executor's capture fence.
        observed.executorStopUnconfirmed !== false ||
        !sameWorkspaceDirectory(input.workspaceRoot, observed.executionRoot)
      )
        throw new Error("Task Workspace helper did not observe the requested local run")
      run = { taskId: input.taskId, runId: input.runId, workspaceRoot: observed.executionRoot }
    } catch (error) {
      receipt = { available: false, reason: began ? "capture-failed" : "helper-unavailable" }
      if (owner) {
        if (began) await owner.settle(input.runId, "cancelled").catch(() => undefined)
        await owner.close().catch(() => undefined)
        owner = undefined
      }
      if (isWorkspaceCaptureRefusal(error)) throw error
    }
  }
  let finishing: Promise<AgentWorkspaceCaptureReceipt> | undefined
  return {
    finish(finalState, executorStopped = true) {
      return (finishing ??= (async () => {
        if (!owner || !run) return receipt
        try {
          if (!executorStopped) {
            // This is a native ledger state, not just a downgraded receipt.
            // It suppresses patch publication through EOF and later recovery.
            await owner.markExecutorUnconfirmed(run.runId)
          } else {
            await owner.settle(run.runId, finalState)
          }
          receipt = unavailableReason
            ? { available: false, reason: unavailableReason, ...run }
            : executorStopped
              ? { available: true, ...run }
              : { available: false, reason: "capture-failed", ...run }
        } catch {
          receipt = { available: false, reason: "capture-failed", ...run }
        } finally {
          // The Begin capability handshake also guarantees EOF/SIGKILL keeps
          // an unfinished run quarantined. Close even if mark delivery is
          // unknown so the explicit stop-recovery command can reacquire it.
          await owner.close().catch(() => undefined)
        }
        return receipt
      })())
    },
  }
}

export class WorkerWorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "WorkerWorkspaceError"
  }
}

/** An authoritative ownership refusal must stop execution, unlike missing capture support. */
export function isWorkspaceCaptureRefusal(error: unknown): error is WorkerWorkspaceError {
  return error instanceof WorkerWorkspaceError && error.code === "capture_refused"
}

export interface WorkerWorkspaceClient {
  bind(repositoryRef: string, sourcePath: string): Promise<WorkerWorkspaceBinding>
  list(): Promise<WorkerWorkspaceBinding[]>
  remove(repositoryRef: string): Promise<{ removed: boolean }>
  resolve(repositoryRef: string): Promise<WorkerWorkspaceBinding>
  /** @deprecated Provision execution through openCapture().begin so its owner stays alive. */
  begin(repositoryRef: string, request: unknown): Promise<Record<string, unknown>>
  /** Present on the native client; older injected administrative clients may omit it. */
  openCapture?(): WorkerWorkspaceCapture
}

export function createWorkerWorkspaceClient(
  options: WorkerWorkspaceClientOptions
): WorkerWorkspaceClient & { openCapture(): WorkerWorkspaceCapture } {
  const spawn = options.spawn ?? nodeSpawn
  const helperPath =
    options.helperPath ??
    resolveWorkerWorkspaceHelper(process.env, import.meta.url, process.execPath)

  function call<T>(command: string, args: string[], input = ""): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const child = spawn(helperPath, [command, "--data-dir", options.dataDir, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => (stdout += chunk))
      child.stderr.on("data", (chunk: string) => (stderr += chunk))
      child.once("error", reject)
      child.once("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Task Workspace helper exited with code ${code}`))
          return
        }
        try {
          resolve(JSON.parse(stdout) as T)
        } catch (error) {
          reject(new Error(`invalid Task Workspace helper response: ${(error as Error).message}`))
        }
      })
      child.stdin.end(input)
    })
  }

  return {
    openCapture() {
      return createCaptureSession(helperPath, options, spawn)
    },
    bind(repositoryRef, sourcePath) {
      return call("bind", ["--repository-ref", repositoryRef, "--path", sourcePath])
    },
    list() {
      return call("list", [])
    },
    remove(repositoryRef) {
      return call("remove", ["--repository-ref", repositoryRef])
    },
    resolve(repositoryRef) {
      return call("resolve", ["--repository-ref", repositoryRef])
    },
    begin(repositoryRef, request) {
      return call("begin", ["--repository-ref", repositoryRef], JSON.stringify(request))
    },
  }
}

const REQUEST_LIMIT = 256 * 1024
const RESPONSE_LIMIT = 16 * 1024 * 1024
const PENDING_LIMIT = 64

/** One long-lived helper owns the live-run locks until capture has settled. */
function createCaptureSession(
  helperPath: string,
  options: WorkerWorkspaceClientOptions,
  spawn: NonNullable<WorkerWorkspaceClientOptions["spawn"]>
): WorkerWorkspaceCapture {
  const child = spawn(helperPath, ["serve", "--data-dir", options.dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let buffer = ""
  let sequence = 0
  let failure: Error | undefined
  let closing = false
  let exited = false
  let closePromise: Promise<void> | undefined
  let didExit!: () => void
  const exit = new Promise<void>((resolve) => {
    didExit = resolve
  })

  const fail = (error: Error) => {
    failure ??= error
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(failure)
    }
    pending.clear()
    child.stdin.end()
  }
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  // Consume diagnostics without retaining unbounded or potentially sensitive text.
  child.stderr.on("data", () => {})
  child.once("error", (error) => {
    fail(error)
    exited = true
    didExit()
  })
  child.stdin.on("error", (error) => fail(error))
  child.once("close", (code) => {
    exited = true
    if (pending.size > 0 || (!closing && code !== 0)) {
      fail(
        new WorkerWorkspaceError("helper_exited", `Task Workspace helper exited with code ${code}`)
      )
    }
    didExit()
  })
  child.stdout.on("data", (chunk: string) => {
    if (failure) return
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        if (Buffer.byteLength(line) > RESPONSE_LIMIT) throw new Error("response limit exceeded")
        const response: unknown = JSON.parse(line)
        if (
          !response ||
          typeof response !== "object" ||
          !("id" in response) ||
          typeof response.id !== "string"
        )
          throw new Error("response id is missing")
        const item = pending.get(response.id)
        if (!item) throw new Error("response id is unknown")
        pending.delete(response.id)
        clearTimeout(item.timer)
        if ("error" in response) {
          const error = response.error as { code?: unknown; message?: unknown } | null
          if (!error || typeof error.code !== "string" || typeof error.message !== "string") {
            item.reject(
              new WorkerWorkspaceError("invalid_response", "invalid Task Workspace helper response")
            )
            throw new Error("response error is invalid")
          }
          item.reject(new WorkerWorkspaceError(error.code, error.message))
        } else if ("result" in response) item.resolve(response.result)
        else {
          item.reject(
            new WorkerWorkspaceError("invalid_response", "invalid Task Workspace helper response")
          )
          throw new Error("response result is missing")
        }
      } catch {
        fail(new WorkerWorkspaceError("invalid_response", "invalid Task Workspace helper response"))
        return
      }
    }
    if (Buffer.byteLength(buffer) > RESPONSE_LIMIT) {
      fail(
        new WorkerWorkspaceError("response_limit", "Task Workspace helper response limit exceeded")
      )
    }
  })

  function request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (failure || closing || exited)
      return Promise.reject(
        failure ?? new WorkerWorkspaceError("closed", "Task Workspace helper is closed")
      )
    if (pending.size >= PENDING_LIMIT)
      return Promise.reject(
        new WorkerWorkspaceError("request_limit", "Task Workspace helper request limit exceeded")
      )
    const id = `workspace-${++sequence}`
    const line = JSON.stringify({ id, method, params }) + "\n"
    if (Buffer.byteLength(line) > REQUEST_LIMIT)
      return Promise.reject(
        new WorkerWorkspaceError("request_limit", "Task Workspace helper request limit exceeded")
      )
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(new WorkerWorkspaceError("helper_timeout", "Task Workspace helper request timed out"))
        child.kill()
      }, options.requestTimeoutMs ?? 60_000)
      timer.unref?.()
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      child.stdin.write(line, (error) => {
        if (error) fail(error)
      })
    })
  }

  return {
    assertExecutionAllowed: (workspaceRoot) => request("assertExecutionAllowed", { workspaceRoot }),
    begin: (input, repositoryRef) =>
      request("begin", { input, ...(repositoryRef ? { repositoryRef } : {}) }),
    settle: (runId, finalState = "ready", executorStopped) =>
      request("settle", { runId, finalState, ...(executorStopped ? { executorStopped } : {}) }),
    markExecutorUnconfirmed: (runId) => request("markExecutorUnconfirmed", { runId }),
    getPatch: (runId) => request("getPatch", { runId }),
    readDiff: (runId, path, allowSensitive = false) =>
      request("readDiff", { runId, path, allowSensitive }),
    listTasks: (sessionId) => request("listTasks", sessionId ? { sessionId } : {}),
    listRuns: (taskId) => request("listRuns", { taskId }),
    undo: (runId) => request("undo", { runId }),
    close() {
      return (closePromise ??= (async () => {
        closing = true
        child.stdin.end()
        const timer = setTimeout(() => child.kill(), 5_000)
        timer.unref?.()
        try {
          await exit
        } finally {
          clearTimeout(timer)
        }
      })())
    },
  }
}

export function resolveWorkerWorkspaceHelper(
  env: Record<string, string | undefined>,
  moduleUrl: string,
  executablePath: string
): string {
  const override = env.COGNIA_TASK_WORKSPACE_HELPER?.trim()
  if (override) return override
  const executable =
    process.platform === "win32"
      ? "cognia-task-workspace-worker.exe"
      : "cognia-task-workspace-worker"
  const moduleDir = path.dirname(fileURLToPath(moduleUrl))
  const candidates = [
    path.join(moduleDir, executable),
    path.join(moduleDir, "..", executable),
    path.join(path.dirname(executablePath), executable),
    path.join(process.cwd(), "cli", "dist", executable),
    path.join(process.cwd(), "target", "release", executable),
    path.join(process.cwd(), "target", "debug", executable),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}
