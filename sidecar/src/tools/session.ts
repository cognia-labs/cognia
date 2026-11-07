// Session-owned state shared by the two agent rails and external tool hosts.
// Resolver refresh preserves read/task/process state when a paused lease changes
// its tool options; final disposal owns both resolver and process cleanup.
import { makeLazyLspResolver } from "../services/lsp/lazy-resolver.ts"
import { makeLazyCodeGraphResolver } from "../services/code-graph/lazy-resolver.ts"
import { createReadTracker } from "./state/read-tracker.ts"
import { createSessionTaskStore } from "./state/tasks.ts"
import { createSessionBgShellRegistry } from "./state/host-background-shells.ts"
import {
  disposeTerminalRepls,
  retireTerminalRepls,
  hasSessionTerminalRepls,
  hasRunningSessionTerminalRepls,
} from "./builtin/terminal-repl/index.ts"
import {
  disposeForegroundGroups,
  retireForegroundGroups,
  hasSessionForegroundGroups,
  hasSessionForegroundProcesses,
} from "./builtin/core-files/bash.ts"
import type { HostRpcCaller } from "./state/host-background-shells.ts"
import type { BackgroundDelivery, BackgroundJobSettlement } from "./state/background-shells.ts"
import { randomUUID } from "node:crypto"

export type ToolSessionSendOptions = Parameters<typeof makeLazyLspResolver>[0]["sendOptions"] &
  Parameters<typeof makeLazyCodeGraphResolver>[0]["sendOptions"] & {
    backgroundProcessHost?: string | undefined
    processOrigin?: { childRunId: string; dispatchEpoch: number } | undefined
    execution?: { identity?: { runId?: string | undefined } | undefined } | undefined
  }

export interface ToolSessionOptions {
  sendOptions: ToolSessionSendOptions
  sessionId: string
  /** Process/admission identity of this executor, never a reusable chat id. */
  executorId?: string
  groupProofSupported?: boolean
  hostRpc?: HostRpcCaller | null | undefined
  log?: (level: "info" | "warn" | "error", message: string) => void
  /**
   * An in-process background shell ended (ADR-0249). Host-backed jobs report
   * through the host supervisor instead.
   */
  onBackgroundJobSettled?: ((settlement: BackgroundJobSettlement) => void) | undefined
}

/**
 * Where this session's agent-started jobs and monitors report their end: the
 * conversation, and the run the executor was created for when the send named
 * one (a durable child's run, else the execution identity's).
 */
export function backgroundDeliveryFor(
  sessionId: string,
  sendOptions: ToolSessionSendOptions
): BackgroundDelivery | undefined {
  if (!sessionId) return undefined
  const runId = sendOptions.processOrigin?.childRunId ?? sendOptions.execution?.identity?.runId
  return { sessionId, ...(runId ? { runId } : {}) }
}

const factories = {
  createReadTracker,
  createSessionTaskStore,
  createSessionBgShellRegistry,
  makeLazyLspResolver,
  makeLazyCodeGraphResolver,
  disposeTerminalRepls,
}

export function createToolSessionContext(
  {
    sendOptions,
    sessionId: conversationId,
    executorId = randomUUID(),
    hostRpc,
    groupProofSupported = process.platform !== "win32",
    log = () => {},
    onBackgroundJobSettled,
  }: ToolSessionOptions,
  dependencies: typeof factories = factories
) {
  // Process/admission identity: the tools' jobs are owned by the executor.
  const sessionId = executorId
  const delivery = backgroundDeliveryFor(conversationId, sendOptions)
  const readTracker = dependencies.createReadTracker()
  const taskStore = dependencies.createSessionTaskStore()
  const bgShells = dependencies.createSessionBgShellRegistry({
    hostRpc,
    sessionId,
    groupProofSupported,
    backgroundProcessHost: sendOptions.backgroundProcessHost,
    processOrigin: sendOptions.processOrigin,
    delivery,
    onSettled: onBackgroundJobSettled,
  })
  let lsp = dependencies.makeLazyLspResolver({ sendOptions, log })
  let codeGraph = dependencies.makeLazyCodeGraphResolver({ sendOptions, log })
  let resolversDisposed = false
  let processesDisposed: Promise<void> | undefined
  let processProofUnconfirmed = false
  const processAdmission = new AbortController()

  function disposeResolvers() {
    if (resolversDisposed) return
    resolversDisposed = true
    try {
      lsp.dispose()
    } finally {
      codeGraph.dispose()
    }
  }

  function disposeProcesses(): Promise<void> {
    processAdmission.abort()
    processesDisposed ??= (async () => {
      try {
        const results = await Promise.allSettled([
          dependencies.disposeTerminalRepls(sessionId),
          disposeForegroundGroups(sessionId),
        ])
        const failure = results.find((result) => result.status === "rejected")
        if (failure?.status === "rejected") throw failure.reason
      } finally {
        await bgShells.killAll()
        // Host-backed killAll is best-effort. A fresh authoritative read must
        // also prove that no job in this session's teardown scope is running:
        // owner-only ordinarily, origin-wide for durable children.
        const deadline = Date.now() + 2_000
        while (groupProofSupported) {
          const remaining = bgShells.hasLiveProcesses
            ? await bgShells.hasLiveProcesses()
            : (await bgShells.list()).some((job) => job.status === "running")
          if (!remaining) break
          if (Date.now() >= deadline)
            throw new Error(`session ${sessionId} still has live background processes`)
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
        }
      }
    })().finally(() => {
      // WP1 covers Bash/background jobs/PTY TOOL groups, not MCP/hooks/LSP helpers.
      if (!retireForegroundGroups(sessionId)) processProofUnconfirmed = true
      if (!retireTerminalRepls(sessionId)) processProofUnconfirmed = true
    })
    return processesDisposed
  }

  return {
    executorId,
    readTracker,
    taskStore,
    bgShells,
    async hasRunningProcesses(): Promise<boolean> {
      return (
        hasSessionForegroundProcesses(sessionId) ||
        hasRunningSessionTerminalRepls(sessionId) ||
        ("hasRunningProcesses" in bgShells
          ? await bgShells.hasRunningProcesses()
          : (await bgShells.list()).some((job) => job.status === "running"))
      )
    },
    async hasLiveProcesses(): Promise<boolean> {
      return (
        processProofUnconfirmed ||
        hasSessionForegroundGroups(sessionId) ||
        hasSessionTerminalRepls(sessionId) ||
        (bgShells.hasLiveProcesses
          ? await bgShells.hasLiveProcesses()
          : (await bgShells.list()).some((job) => job.status === "running"))
      )
    },
    get lsp() {
      return lsp
    },
    get codeGraph() {
      return codeGraph
    },
    toolContext() {
      return {
        readTracker,
        taskStore,
        bgShells,
        hostRpc,
        sessionId,
        delivery,
        processSignal: processAdmission.signal,
        groupProofSupported,
        lspResolver: lsp.lspResolver,
        codeGraphResolver: codeGraph.codeGraphResolver,
      }
    },
    refreshResolvers(nextSendOptions: ToolSessionSendOptions) {
      disposeResolvers()
      lsp = dependencies.makeLazyLspResolver({ sendOptions: nextSendOptions, log })
      codeGraph = dependencies.makeLazyCodeGraphResolver({ sendOptions: nextSendOptions, log })
      resolversDisposed = false
    },
    disposeResolvers,
    disposeProcesses,
    async dispose() {
      try {
        disposeResolvers()
      } finally {
        await disposeProcesses()
      }
    },
  }
}

export type ToolSessionContext = ReturnType<typeof createToolSessionContext>
