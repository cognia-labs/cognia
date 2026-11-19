/** @jest-environment node */

import {
  abortPluginToolCallsForSession,
  subscribePluginToolDispatchBridge,
} from "./plugin-tool-dispatch-bridge"
import type {
  PluginToolExecRequest,
  PluginToolExecResponse,
} from "@/lib/plugin/bridge/agent-tool-types"
import {
  sendPluginToolResponse,
  subscribePluginToolExec,
} from "@/lib/ai/agent/execution/sidecar-client"
import { runAskUser, useAskUserStore } from "@/stores/agent/ask-user-store"

jest.mock("@/lib/ai/agent/execution/sidecar-client", () => ({
  subscribePluginToolExec: jest.fn(),
  sendPluginToolResponse: jest.fn(),
}))

const request: PluginToolExecRequest = {
  type: "plugin_tool_exec",
  sessionId: "session-a",
  toolUseId: "call-a",
  name: "issue_list",
  args: {},
  remoteExecutionContext: {
    hostId: "host-a",
    originDeviceId: "device-a",
    sessionId: "session-a",
    generation: 1,
    requestId: "request-a",
    issuedAt: 1,
    expiresAt: 2,
  },
}
const response: PluginToolExecResponse = {
  type: "plugin_tool_response",
  sessionId: request.sessionId,
  toolUseId: request.toolUseId,
  result: { ok: true },
}

function harness() {
  let receive!: (request: PluginToolExecRequest) => void
  const unsubscribe = jest.fn()
  const subscribe = jest.fn(async (handler: typeof receive) => {
    receive = handler
    return unsubscribe
  })
  const handle = jest.fn(async (_request: PluginToolExecRequest) => response)
  const send = jest.fn(async (_response: PluginToolExecResponse, _context?: unknown) => {})
  return { subscribe, handle, send, unsubscribe, emit: (req = request) => receive(req) }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

it("subscribes, replies and unsubscribes through the default IPC transport", async () => {
  const h = harness()
  jest.mocked(subscribePluginToolExec).mockImplementationOnce((handler) => h.subscribe(handler))
  const stop = await subscribePluginToolDispatchBridge({ handle: h.handle })
  try {
    h.emit()
    await flush()
    expect(sendPluginToolResponse).toHaveBeenCalledWith(response, request.remoteExecutionContext)
  } finally {
    stop()
  }
  expect(h.unsubscribe).toHaveBeenCalledTimes(1)
})

it("provides a per-call signal, clears a stopped question, drops its answer and opens the next question", async () => {
  const h = harness()
  const settled = jest.fn()
  h.handle.mockImplementation(async (req) => {
    const result = await runAskUser(
      { question: "Choose?", options: ["Yes", "No"] },
      { sessionId: req.sessionId, signal: req.abortSignal }
    )
    settled()
    return { ...response, toolUseId: req.toolUseId, result }
  })
  const stop = await subscribePluginToolDispatchBridge(h)
  try {
    h.emit({ ...request, remoteExecutionContext: undefined })
    await flush()
    expect(h.handle.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal)
    const oldQuestion = useAskUserStore.getState().active!
    expect(oldQuestion).not.toBeNull()
    abortPluginToolCallsForSession(request.sessionId, "interrupted")
    await flush()
    expect(useAskUserStore.getState().active).toBeNull()
    expect(settled).toHaveBeenCalledTimes(1)
    expect(h.send).not.toHaveBeenCalled()
    h.emit({ ...request, toolUseId: "next-question", remoteExecutionContext: undefined })
    await flush()
    const nextQuestion = useAskUserStore.getState().active!
    expect(nextQuestion.id).not.toBe(oldQuestion.id)
    oldQuestion.resolve({ selected: [], text: "late", cancelled: false })
    await flush()
    expect(useAskUserStore.getState().active).toBe(nextQuestion)
    expect(h.send).not.toHaveBeenCalled()
    useAskUserStore
      .getState()
      .resolveActive({ selected: [], text: "next answer", cancelled: false })
    await flush()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: "next-question",
        result: expect.stringContaining("next answer"),
      }),
      undefined
    )
  } finally {
    abortPluginToolCallsForSession(request.sessionId, "cleanup")
    useAskUserStore.setState({ active: null, queue: [] })
    stop()
  }
})

it("cancels only matching remote session/host/device/generation calls and drops non-cooperative late responses", async () => {
  const h = harness()
  const finish: Array<() => void> = []
  h.handle.mockImplementation(
    (req) =>
      new Promise((resolve) =>
        finish.push(() => resolve({ ...response, sessionId: req.sessionId }))
      )
  )
  const stop = await subscribePluginToolDispatchBridge(h)
  try {
    h.emit()
    h.emit({ ...request, sessionId: "other" })
    h.emit({
      ...request,
      remoteExecutionContext: { ...request.remoteExecutionContext!, hostId: "other" },
    })
    h.emit({
      ...request,
      remoteExecutionContext: { ...request.remoteExecutionContext!, originDeviceId: "other" },
    })
    h.emit({
      ...request,
      remoteExecutionContext: { ...request.remoteExecutionContext!, generation: 2 },
    })
    h.emit({ ...request, remoteExecutionContext: undefined })
    await flush()
    abortPluginToolCallsForSession(request.sessionId, "interrupted", request.remoteExecutionContext)
    expect(h.handle.mock.calls.map(([req]) => req.abortSignal?.aborted)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ])
    finish.forEach((done) => done())
    await flush()
    expect(h.send).toHaveBeenCalledTimes(5)
    expect(
      h.send.mock.calls.some(([, context]) => context === request.remoteExecutionContext)
    ).toBe(true)
    expect(
      h.send.mock.calls.filter(
        ([resp, context]) =>
          resp.sessionId === request.sessionId && context === request.remoteExecutionContext
      )
    ).toHaveLength(0)
  } finally {
    stop()
  }
})

it.each(["original", "prepared", "bridge"])("combines signals when %s cancels", async (source) => {
  const h = harness()
  const original = new AbortController()
  const prepared = new AbortController()
  h.handle.mockImplementation(() => new Promise(() => {}))
  const stop = await subscribePluginToolDispatchBridge({
    ...h,
    prepareRequest: (req) => ({ ...req, abortSignal: prepared.signal }),
  })
  h.emit({ ...request, abortSignal: original.signal })
  await flush()
  const signal = h.handle.mock.calls[0][0].abortSignal!
  expect(signal).toBeDefined()
  if (source === "original") original.abort()
  else if (source === "prepared") prepared.abort()
  else
    abortPluginToolCallsForSession(request.sessionId, "interrupted", request.remoteExecutionContext)
  await flush()
  expect(signal.aborted).toBe(true)
  expect(h.send).not.toHaveBeenCalled()
  stop()
})

it("does not cancel a newer turn on a delayed session-ended event", async () => {
  const h = harness()
  h.handle.mockImplementation(() => new Promise(() => {}))
  const stop = await subscribePluginToolDispatchBridge(h)
  try {
    h.emit({ ...request, turnId: "new-turn" })
    h.emit({ ...request, toolUseId: "legacy" })
    await flush()
    abortPluginToolCallsForSession(
      request.sessionId,
      "session ended",
      request.remoteExecutionContext,
      "old-turn"
    )
    expect(h.handle.mock.calls.map(([req]) => req.abortSignal?.aborted)).toEqual([false, true])
    abortPluginToolCallsForSession(request.sessionId, "interrupted", request.remoteExecutionContext)
    await flush()
    expect(h.handle.mock.calls[0][0].abortSignal?.aborted).toBe(true)
    expect(h.send).not.toHaveBeenCalled()
  } finally {
    stop()
  }
})

it("answers preparation failures safely and never executes the handler", async () => {
  const h = harness()
  const stop = await subscribePluginToolDispatchBridge({
    ...h,
    prepareRequest: () => {
      throw new Error("private request")
    },
  })
  h.emit()
  await flush()
  expect(h.handle).not.toHaveBeenCalled()
  expect(h.send).toHaveBeenCalledWith(
    expect.objectContaining({ error: "Plugin tool executor failed" }),
    request.remoteExecutionContext
  )
  stop()
})

it("shares one consumer and executes a call only once, including completed duplicates", async () => {
  const h = harness()
  let resolve!: (response: PluginToolExecResponse) => void
  h.handle.mockImplementation(() => new Promise((done) => (resolve = done)))
  const [stopFirst, stopSecond] = await Promise.all([
    subscribePluginToolDispatchBridge(h),
    subscribePluginToolDispatchBridge(h),
  ])
  expect(h.subscribe).toHaveBeenCalledTimes(1)
  h.emit()
  h.emit()
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
  resolve(response)
  await flush()
  h.emit()
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
  expect(h.send).toHaveBeenCalledTimes(1)
  expect(h.send).toHaveBeenCalledWith(response, request.remoteExecutionContext)
  stopFirst()
  expect(h.unsubscribe).not.toHaveBeenCalled()
  stopSecond()
  stopSecond()
  expect(h.unsubscribe).toHaveBeenCalledTimes(1)
  h.emit({ ...request, toolUseId: "after-stop" })
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
})

it("isolates call ids by session and remote host generation", async () => {
  const h = harness()
  const stop = await subscribePluginToolDispatchBridge(h)
  h.emit()
  h.emit({ ...request, sessionId: "session-b" })
  h.emit({
    ...request,
    remoteExecutionContext: { ...request.remoteExecutionContext!, generation: 2 },
  })
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(3)
  stop()
})

it("prefers a session owner over a global consumer and preserves the original context", async () => {
  const h = harness()
  const localHandle = jest.fn(async () => response)
  const stopGlobal = await subscribePluginToolDispatchBridge(h)
  const stopSession = await subscribePluginToolDispatchBridge({
    ...h,
    sessionId: request.sessionId,
    handle: localHandle,
    prepareRequest: (req) => ({ ...req, sandboxRuntimeRef: "sandbox-a" }),
  })
  h.emit()
  await flush()
  expect(h.handle).not.toHaveBeenCalled()
  expect(localHandle).toHaveBeenCalledWith({
    ...request,
    sandboxRuntimeRef: "sandbox-a",
    abortSignal: expect.any(AbortSignal),
  })
  expect(h.send).toHaveBeenCalledWith(response, request.remoteExecutionContext)
  stopSession()
  h.emit({ ...request, toolUseId: "next-call" })
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
  stopGlobal()
})

it("answers executor exceptions safely without leaking arguments or exception text", async () => {
  const h = harness()
  h.handle.mockImplementation(() => {
    throw new Error("token=private-secret argument=confidential")
  })
  const stop = await subscribePluginToolDispatchBridge(h)
  h.emit({ ...request, args: { token: "private-secret" } })
  await flush()
  expect(h.send).toHaveBeenCalledWith(
    {
      type: "plugin_tool_response",
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      error: "Plugin tool executor failed",
    },
    request.remoteExecutionContext
  )
  stop()
})

it("forwards handler error responses using the existing protocol", async () => {
  const h = harness()
  h.handle.mockResolvedValue({ ...response, error: "Plugin tool is disabled" })
  const stop = await subscribePluginToolDispatchBridge(h)
  h.emit()
  await flush()
  expect(h.send).toHaveBeenCalledWith(
    { ...response, error: "Plugin tool is disabled" },
    request.remoteExecutionContext
  )
  stop()
})

it("fails remote execution closed when the owner cannot proxy it", async () => {
  const h = harness()
  const stop = await subscribePluginToolDispatchBridge({ ...h, canExecuteRemote: () => false })
  h.emit()
  await flush()
  expect(h.handle).not.toHaveBeenCalled()
  expect(h.send).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.stringContaining("REMOTE_FEATURE_UNSUPPORTED") }),
    request.remoteExecutionContext
  )
  stop()
})

it("keeps an in-flight claim across unsubscribe and resubscribe", async () => {
  const h = harness()
  let resolve!: (response: PluginToolExecResponse) => void
  h.handle.mockImplementation(() => new Promise((done) => (resolve = done)))
  const stop = await subscribePluginToolDispatchBridge(h)
  h.emit()
  await flush()
  stop()
  const stopAgain = await subscribePluginToolDispatchBridge(h)
  h.emit()
  resolve(response)
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
  expect(h.send).toHaveBeenCalledTimes(1)
  stopAgain()
})

it("can restart after a failed subscription", async () => {
  const h = harness()
  h.subscribe.mockRejectedValueOnce(new Error("unavailable"))
  await expect(subscribePluginToolDispatchBridge(h)).rejects.toThrow("unavailable")
  const stop = await subscribePluginToolDispatchBridge(h)
  h.emit()
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
  stop()
})

it("does not re-execute a tool when its response transport rejects", async () => {
  const h = harness()
  h.send.mockRejectedValueOnce(new Error("disconnected"))
  const stop = await subscribePluginToolDispatchBridge(h)
  h.emit()
  await flush()
  h.emit()
  await flush()
  expect(h.handle).toHaveBeenCalledTimes(1)
  expect(h.send).toHaveBeenCalledTimes(1)
  stop()
})
