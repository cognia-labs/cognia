import { taskWorkspaceHostTransport } from "./origin"
import type { Transport } from "@/lib/tauri/transport-types"
import type {
  ResourceChange,
  TaskRun,
  WorkspaceBundle,
  WorkspaceBundleTurnLease,
  WorkspaceBundleTurnOutcome,
} from "./types"

/** Host-owned external runs have no renderer lease; the execution Host owns it. */
export async function openHostTaskWorkspaceTurn(
  input: {
    runId: string
    chatSessionId: string
    agentId: string
    workingDirectory: string
    agentKind?: string
    observeInPlace?: boolean
  },
  target: Pick<Transport, "call"> = taskWorkspaceHostTransport()
) {
  if (input.observeInPlace) {
    const run = await target.call<TaskRun>("task_workspace_begin", {
      input: {
        taskId: `remote:${input.chatSessionId}`,
        sessionId: input.chatSessionId,
        runId: input.runId,
        executionRunId: input.runId,
        turnId: input.runId,
        workspaceKey: `local:${input.chatSessionId}`,
        workspaceRoot: input.workingDirectory,
        agentId: input.agentId,
        agentKind: input.agentKind ?? "external",
        surface: "chat",
        observeInPlace: true,
        base: { kind: "workingState" },
      },
    })
    if (run.isolationKind !== "observed") {
      await target.call("task_workspace_settle", { runId: run.runId, finalState: "cancelled" })
      throw new Error("Host cannot capture Local workspace turns in place")
    }
    let completion: Promise<ResourceChange[]> | undefined
    return {
      workingDirectory: run.executionRoot,
      bundleTurnId: undefined,
      runs: [
        {
          taskId: run.taskId,
          runId: run.runId,
          workspaceRoot: run.executionRoot,
          executionRoot: run.executionRoot,
          origin: { kind: "local" as const },
        },
      ],
      settle(state: "ready" | "failed" | "cancelled") {
        completion ??= target.call<ResourceChange[]>("task_workspace_settle", {
          runId: run.runId,
          finalState: state,
        })
        return completion
      },
    }
  }
  const bundle = await target.call<WorkspaceBundle>("task_workspace_bundle_acquire", {
    input: {
      ownerType: "session",
      ownerRef: input.chatSessionId,
      environmentKind: "managed",
      base: { kind: "workingState" },
      roots: [{ logicalRootId: "primary", role: "primary", sourceRoot: input.workingDirectory }],
    },
  })
  const lease = await target.call<WorkspaceBundleTurnLease>("task_workspace_bundle_turn_begin", {
    bundleId: bundle.bundleId,
    request: {
      primaryLogicalRootId: "primary",
      run: {
        taskId: `remote:${input.chatSessionId}`,
        sessionId: input.chatSessionId,
        runId: input.runId,
        executionRunId: input.runId,
        turnId: input.runId,
        agentId: input.agentId,
        agentKind: input.agentKind ?? "external",
        workspaceRoot: input.workingDirectory,
        surface: "chat",
      },
    },
  })
  if (!lease.primaryAlias || lease.runs.length === 0) {
    await target.call("task_workspace_bundle_turn_abort", { bundleTurnId: lease.bundleTurnId })
    throw new Error("Host returned no workspace execution root")
  }
  let completion: Promise<ResourceChange[]> | undefined
  return {
    workingDirectory: lease.primaryAlias,
    bundleTurnId: lease.bundleTurnId,
    runs: lease.runs.map(({ run }) => ({
      taskId: run.taskId,
      runId: run.runId,
      workspaceRoot: run.executionRoot,
      executionRoot: run.executionRoot,
      origin: { kind: "local" as const },
    })),
    settle(state: "ready" | "failed" | "cancelled") {
      completion ??= target
        .call<WorkspaceBundleTurnOutcome>("task_workspace_bundle_turn_settle", {
          bundleTurnId: lease.bundleTurnId,
          finalState: state,
        })
        .then((outcome) => outcome.resources)
      return completion
    },
  }
}
