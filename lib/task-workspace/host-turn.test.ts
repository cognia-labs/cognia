jest.mock("./origin", () => ({ taskWorkspaceHostTransport: jest.fn() }))
import { openHostTaskWorkspaceTurn } from "./host-turn"

it("executes a Host-owned run in its lease alias and settles once on the captured transport", async () => {
  const call = jest
    .fn()
    .mockResolvedValueOnce({ bundleId: "bundle" })
    .mockResolvedValueOnce({
      bundleTurnId: "turn",
      primaryAlias: "/alias",
      runs: [{ run: { taskId: "task", runId: "run", executionRoot: "/actual" } }],
    })
    .mockResolvedValueOnce({ resources: [{ path: "a.ts" }] })
  const lease = await openHostTaskWorkspaceTurn(
    { runId: "run", chatSessionId: "chat", agentId: "agent", workingDirectory: "/source" },
    { call }
  )
  expect(lease.workingDirectory).toBe("/alias")
  expect(lease.runs).toEqual([
    {
      taskId: "task",
      runId: "run",
      workspaceRoot: "/actual",
      executionRoot: "/actual",
      origin: { kind: "local" },
    },
  ])
  const first = lease.settle("cancelled")
  const second = lease.settle("ready")
  expect(first).toBe(second)
  await first
  expect(call).toHaveBeenLastCalledWith("task_workspace_bundle_turn_settle", {
    bundleTurnId: "turn",
    finalState: "cancelled",
  })
  expect(call).toHaveBeenCalledTimes(3)
})

it("releases an unusable lease instead of dispatching without a working root", async () => {
  const call = jest
    .fn()
    .mockResolvedValueOnce({ bundleId: "bundle" })
    .mockResolvedValueOnce({ bundleTurnId: "turn", primaryAlias: "", runs: [] })
    .mockResolvedValueOnce({})
  await expect(
    openHostTaskWorkspaceTurn(
      { runId: "run", chatSessionId: "chat", agentId: "agent", workingDirectory: "/source" },
      { call }
    )
  ).rejects.toThrow("no workspace execution root")
  expect(call).toHaveBeenLastCalledWith("task_workspace_bundle_turn_abort", {
    bundleTurnId: "turn",
  })
})

it("observes explicit Local roots without acquiring a managed bundle", async () => {
  const call = jest
    .fn()
    .mockResolvedValueOnce({
      taskId: "task",
      runId: "run",
      executionRoot: "/repo",
      isolationKind: "observed",
    })
    .mockResolvedValueOnce([])
  const lease = await openHostTaskWorkspaceTurn(
    {
      runId: "run",
      chatSessionId: "chat",
      agentId: "agent",
      workingDirectory: "/repo",
      observeInPlace: true,
    },
    { call }
  )
  expect(lease.workingDirectory).toBe("/repo")
  expect(lease.bundleTurnId).toBeUndefined()
  expect(call).toHaveBeenCalledWith("task_workspace_begin", {
    input: expect.objectContaining({ observeInPlace: true, workspaceRoot: "/repo" }),
  })
  await lease.settle("ready")
  expect(call).toHaveBeenLastCalledWith("task_workspace_settle", {
    runId: "run",
    finalState: "ready",
  })
})

it("rejects old Hosts that silently ignore observed mode", async () => {
  const call = jest
    .fn()
    .mockResolvedValueOnce({ runId: "run", executionRoot: "/isolated", isolationKind: "shadow" })
    .mockResolvedValueOnce([])
  await expect(
    openHostTaskWorkspaceTurn(
      {
        runId: "run",
        chatSessionId: "chat",
        agentId: "agent",
        workingDirectory: "/repo",
        observeInPlace: true,
      },
      { call }
    )
  ).rejects.toThrow("in place")
})
