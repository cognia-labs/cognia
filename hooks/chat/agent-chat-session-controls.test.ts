import type { AgentExecutionHandle } from "@/lib/ai/agent/execution/agent-execution-handle"
import {
  compactChatSession,
  resetChatRuntime,
  rewindChatFiles,
  setChatSessionModel,
} from "./agent-chat-session-controls"

const sidecar = {
  closeSession: jest.fn(async (..._args: unknown[]) => undefined),
  compactSession: jest.fn(async (..._args: unknown[]) => undefined),
  setSessionModel: jest.fn(async (..._args: unknown[]) => undefined),
}
jest.mock("@/lib/ai/agent/execution/sidecar-client", () => ({
  closeSession: (...args: unknown[]) => sidecar.closeSession(...args),
  compactSession: (...args: unknown[]) => sidecar.compactSession(...args),
  setSessionModel: (...args: unknown[]) => sidecar.setSessionModel(...args),
  interruptSession: jest.fn(),
}))

const refreshGitStatus = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/git/load", () => ({
  refreshGitStatus: (...args: unknown[]) => refreshGitStatus(...args),
}))

function handle() {
  return {
    compact: jest.fn(async () => undefined),
    setModel: jest.fn(async () => undefined),
    cancel: jest.fn(async () => undefined),
    rewindFiles: jest.fn(async () => ({ files: ["a.ts"] })),
  } as unknown as AgentExecutionHandle & Record<string, jest.Mock>
}

beforeEach(() => jest.clearAllMocks())

it("compacts and switches models on the session's execution handle when one runs it", async () => {
  const h = handle()
  const ctx = { getExecutionHandle: () => h }

  await compactChatSession(ctx, "chat")
  await setChatSessionModel(ctx, "chat", "opus")

  expect(h.compact).toHaveBeenCalled()
  expect(h.setModel).toHaveBeenCalledWith("opus")
  expect(sidecar.compactSession).not.toHaveBeenCalled()
  expect(sidecar.setSessionModel).not.toHaveBeenCalled()
})

it("falls back to the sidecar session without an execution handle", async () => {
  const ctx = { getExecutionHandle: () => undefined }

  await compactChatSession(ctx, "chat")
  await setChatSessionModel(ctx, "chat", "opus")

  expect(sidecar.compactSession).toHaveBeenCalledWith("chat")
  expect(sidecar.setSessionModel).toHaveBeenCalledWith("chat", "opus")
})

it("forgets the handle on reset even when cancelling it fails", async () => {
  const h = handle()
  ;(h.cancel as jest.Mock).mockRejectedValue(new Error("gone"))
  const handles = new Map([["chat", h]])
  const unregister = jest.fn()
  const ctx = {
    executionHandlesRef: { current: handles },
    executionHandleDirectory: { unregister } as never,
    getExecutionHandle: () => h,
  }

  await expect(resetChatRuntime(ctx, "chat")).rejects.toThrow("gone")

  expect(handles.has("chat")).toBe(false)
  expect(unregister).toHaveBeenCalledWith("chat", h)
  expect(sidecar.closeSession).not.toHaveBeenCalled()
})

it("rewinds files through the handle and refreshes git status only for a real rewind", async () => {
  const h = handle()
  const ctx = { getExecutionHandle: () => h }

  await expect(rewindChatFiles(ctx, "chat", "cp-1", true)).resolves.toEqual({ files: ["a.ts"] })
  expect(h.rewindFiles).toHaveBeenCalledWith("cp-1", { dryRun: true })
  expect(refreshGitStatus).not.toHaveBeenCalled()

  await rewindChatFiles(ctx, "chat", "cp-1", false)
  expect(refreshGitStatus).toHaveBeenCalledTimes(1)
})

it("refuses a rewind when no execution handle holds the checkpoints", async () => {
  await expect(
    rewindChatFiles({ getExecutionHandle: () => undefined }, "chat", "cp-1", false)
  ).rejects.toThrow("checkpoint execution handle is unavailable")
})
