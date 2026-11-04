jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false), transport: {} }))
jest.mock("@/lib/tauri/transport-companion", () => ({ loadCompanionConfig: jest.fn() }))
jest.mock("@/lib/claude/run-and-capture", () => ({ runAndCaptureAssistantReply: jest.fn() }))
jest.mock("@/lib/claude/ipc", () => ({ closeSession: jest.fn().mockResolvedValue(undefined) }))
jest.mock("@cognia/redact", () => ({ hasNoLeakingPiiDeep: jest.fn(() => true) }))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueHostStateIntentIfAvailable: jest.fn(async (input) => ({ id: input.actionId })),
  awaitHostStateIntentSettlement: jest.fn(async () => ({ outcome: "applied" })),
}))
jest.mock("@/lib/sync/host-state-service", () => ({
  hydrateHostStateSession: jest.fn(async () => undefined),
}))
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  getRuntimeSnapshot: () => ({
    host: { hostStateScope: { accountId: "host-account", runtimeTargetId: "host-runtime" } },
  }),
}))

import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { closeSession } from "@/lib/claude/ipc"
import { isTauri } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import {
  setActiveRuntimeTargetContext,
  clearActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { createHostLlmClient, shouldUseHostLlmClient } from "./host-llm-client"
import { enqueueHostStateIntentIfAvailable } from "@/lib/db/mobile-outbound-queue"

const provider = {
  kind: "resolved",
  providerId: "openai",
  protocol: "openai",
  model: "gpt-5.6-luna",
  apiKey: "private-key",
  baseURL: "http://127.0.0.1:8787/v1",
  apiFlavor: "chat",
  headers: { "X-Tenant": "one" },
  isCustomProvider: false,
  useProxy: false,
} as const
const run = jest.mocked(runAndCaptureAssistantReply)

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(isTauri).mockReturnValue(false)
  jest
    .mocked(loadCompanionConfig)
    .mockReturnValue({ targetId: "host-one", deviceId: "device-one" } as never)
  jest.mocked(hasNoLeakingPiiDeep).mockReturnValue(true)
  clearActiveRuntimeTargetContext()
  setActiveRuntimeTargetContext("account-one", "host-one")
  run.mockResolvedValue({
    text: "OK",
    resultSubtype: "success",
    usage: { inputTokens: 12, outputTokens: 2 },
  } as never)
})
afterEach(() => clearActiveRuntimeTargetContext())

it("keeps standalone and Tauri on their existing network paths", () => {
  jest.mocked(loadCompanionConfig).mockReturnValue(null)
  expect(shouldUseHostLlmClient()).toBe(false)
  jest
    .mocked(loadCompanionConfig)
    .mockReturnValue({ targetId: "host-one", deviceId: "device-one" } as never)
  jest.mocked(isTauri).mockReturnValue(true)
  expect(shouldUseHostLlmClient()).toBe(false)
})
it("uses exact credentials and one bounded toolless request, reports usage and closes its own session", async () => {
  const client = createHostLlmClient(provider, "composer-followups")
  const onUsage = jest.fn()
  await expect(
    client.complete("Predict", {
      system: "Only suggestions",
      maxTokens: 128,
      maxRetries: 0,
      onUsage,
    })
  ).resolves.toBe("OK")
  const [id, prompt, options, capture] = run.mock.calls[0]
  expect(id).toMatch(/^utility-/)
  expect(prompt).toBe("Predict")
  expect(options).toMatchObject({
    provider: "openai",
    model: "gpt-5.6-luna",
    providerCredentials: {
      apiKey: "private-key",
      baseURL: provider.baseURL,
      apiFlavor: "chat",
      headers: provider.headers,
    },
    systemPrompt: "Only suggestions",
    toolSurface: "none",
    allowedTools: [],
    mcpServers: {},
    maxTurns: 1,
    modelParams: { maxOutputTokens: 128, temperature: 0, maxRetries: 0 },
    compaction: { enabled: false },
  })
  expect(options).not.toHaveProperty("cwd")
  expect(options).not.toHaveProperty("initialConversation")
  expect(capture?.execution).not.toHaveProperty("skip")
  expect(capture?.timeoutMs).toBe(30_000)
  expect(closeSession).toHaveBeenCalledWith(id)
  expect(onUsage).toHaveBeenCalledWith(
    expect.objectContaining({ inputTokens: 12, outputTokens: 2 })
  )
  expect(client.getUsageSnapshot?.().totalTokens).toBe(14)
})
it("fails closed before outbound dispatch when the PII gate refuses", async () => {
  jest.mocked(hasNoLeakingPiiDeep).mockReturnValue(false)
  await expect(createHostLlmClient(provider, "prediction").complete("private")).rejects.toThrow(
    "PII gate"
  )
  expect(run).not.toHaveBeenCalled()
})
it("admits a fresh device session before dispatch and confirms its owned cleanup", async () => {
  const enqueue = jest.mocked(enqueueHostStateIntentIfAvailable)
  run.mockImplementation(async (id) => {
    if (
      !enqueue.mock.calls.some(
        ([input]) => input.sessionId === id && input.action.kind === "session.create"
      )
    ) {
      throw new Error("The session does not exist on this Host.")
    }
    return { text: "OK", resultSubtype: "success" } as never
  })
  await expect(createHostLlmClient(provider, "prediction").complete("Predict")).resolves.toBe("OK")
  const id = run.mock.calls[0][0]
  expect(enqueue).toHaveBeenLastCalledWith({
    sessionId: id,
    actionId: `${id}:delete`,
    action: { kind: "session.delete" },
  })
})
it("rejects a client after switching accounts or Hosts", async () => {
  const client = createHostLlmClient(provider, "prediction")
  setActiveRuntimeTargetContext("account-two", "host-two")
  await expect(client.complete("Predict")).rejects.toThrow("Host connection changed")
  expect(run).not.toHaveBeenCalled()
})
it("rechecks the target at dispatch and rejects late output after switching", async () => {
  run.mockImplementation(async (_id, _prompt, _options, capture) => {
    setActiveRuntimeTargetContext("account-two", "host-two")
    await expect(capture?.beforeSend?.()).rejects.toThrow("Host connection changed")
    expect(capture?.signal?.aborted).toBe(true)
    return { text: "late" } as never
  })
  await expect(createHostLlmClient(provider, "prediction").complete("Predict")).rejects.toThrow(
    "Host connection changed"
  )
  expect(closeSession).not.toHaveBeenCalled()
})
it("forwards cancellation without retrying a possibly accepted request", async () => {
  const controller = new AbortController()
  run.mockImplementation(async (_id, _prompt, _options, capture) => {
    controller.abort()
    expect(capture?.signal?.aborted).toBe(true)
    throw new DOMException("Aborted", "AbortError")
  })
  await expect(
    createHostLlmClient(provider, "prediction").complete("Predict", {
      abortSignal: controller.signal,
    })
  ).rejects.toThrow("Aborted")
  expect(run).toHaveBeenCalledTimes(1)
  expect(closeSession).toHaveBeenCalledTimes(1)
})
it("propagates provider failure and never reports an empty success", async () => {
  run.mockResolvedValue({ text: "", resultSubtype: "error_during_execution" } as never)
  await expect(createHostLlmClient(provider, "prediction").complete("Predict")).rejects.toThrow(
    "error_during_execution"
  )
  expect(closeSession).toHaveBeenCalledTimes(1)
})

it("does not use a stored or build-time pairing while standalone or locked", () => {
  clearActiveRuntimeTargetContext()
  expect(shouldUseHostLlmClient()).toBe(false)
  setActiveRuntimeTargetContext("account-one", "standalone")
  expect(shouldUseHostLlmClient()).toBe(false)
})
it("refuses stale clients after re-pairing the same Host", async () => {
  const client = createHostLlmClient(provider, "prediction")
  jest
    .mocked(loadCompanionConfig)
    .mockReturnValue({ targetId: "host-one", deviceId: "replacement-device" } as never)
  await expect(client.complete("Predict")).rejects.toThrow("Host connection changed")
  expect(run).not.toHaveBeenCalled()
})

it("streams actual deltas from the capture and retains per-call output limits", async () => {
  run.mockImplementation(async (_id, _prompt, options, capture) => {
    expect(options?.modelParams?.maxOutputTokens).toBe(48)
    expect(options?.modelParams?.maxRetries).toBe(0)
    await capture?.onPartial?.("Hel")
    await capture?.onPartial?.("Hello")
    return { text: "Hello!", resultSubtype: "success" } as never
  })
  const chunks: string[] = []
  for await (const chunk of createHostLlmClient(provider, "composer-inline").stream!("Continue", {
    maxTokens: 48,
  }))
    chunks.push(chunk)
  expect(chunks.join("")).toBe("Hello!")
  expect(chunks.length).toBeGreaterThan(1)
})
it("does not emit a late streamed partial after the route changes", async () => {
  run.mockImplementation(async (_id, _prompt, _options, capture) => {
    setActiveRuntimeTargetContext("account-two", "host-two")
    await expect(Promise.resolve().then(() => capture?.onPartial?.("stale"))).rejects.toThrow(
      "Host connection changed"
    )
    return { text: "stale" } as never
  })
  const chunks: string[] = []
  const collect = async () => {
    for await (const chunk of createHostLlmClient(provider, "composer-inline").stream!("Continue"))
      chunks.push(chunk)
  }
  await expect(collect()).rejects.toThrow("Host connection changed")
  expect(chunks).toEqual([])
})
