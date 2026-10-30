import { hasNoLeakingPii } from "@cognia/redact"
import {
  __resetInterceptorRegistryForTesting,
  registerInterceptor,
  type InterceptorRegistration,
} from "@/lib/plugin/interceptors"
import {
  dispatchGatewayRuntimeCommand,
  isGatewayRuntimeCommand,
  type GatewayPrivacyReplacement,
} from "./runtime-bridge"

jest.mock("@/lib/accounts/active-account-id", () => ({ getActiveAccountId: () => "owner" }))
jest.mock("@/lib/tauri/gateway", () => ({ gatewayGetStatus: jest.fn() }))
jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(async () => ({ providerSettings: {} })),
}))
jest.mock("@/lib/search/configured-search-core", () => ({ searchWithSettings: jest.fn() }))
jest.mock("@/lib/ai/provider-consumption", () => ({
  createProviderSettingsSnapshot: jest.fn((settings) => settings),
  resolveFeatureProvider: jest.fn(),
  createFeatureProviderModel: jest.fn(() => ({ modelId: "vision-model" })),
}))
jest.mock("@/lib/ai/ledgered-model-call", () => ({
  beginLedgeredGeneration: jest.fn(),
  usageOfResult: jest.fn(() => ({ inputTokens: 12, outputTokens: 4 })),
}))
jest.mock("@/lib/db/session-usage", () => ({
  recordSurfaceUsage: jest.fn(async () => null),
  swallowUsageWrite: (promise: Promise<unknown>) => void promise.catch(() => {}),
}))
jest.mock("@/lib/claude/provider-attempt-options", () => ({
  resolveSubscriptionProviderCredential: jest.fn(),
}))
jest.mock("@/lib/runtime/streaming-fetch", () => ({
  getStreamingFetch: jest.fn(),
  browserDirectHeaders: jest.fn(() => ({})),
}))
jest.mock("@/lib/network/proxy-fetch", () => ({ proxyFetch: jest.fn() }))
jest.mock("ai", () => ({ generateText: jest.fn() }))

const status = jest.requireMock("@/lib/tauri/gateway").gatewayGetStatus as jest.Mock
const search = jest.requireMock("@/lib/search/configured-search-core")
  .searchWithSettings as jest.Mock
const providers = jest.requireMock("@/lib/ai/provider-consumption")
const ledger = jest.requireMock("@/lib/ai/ledgered-model-call")
const usage = jest.requireMock("@/lib/db/session-usage").recordSurfaceUsage as jest.Mock
const generate = jest.requireMock("ai").generateText as jest.Mock
const credential = jest.requireMock("@/lib/claude/provider-attempt-options")
  .resolveSubscriptionProviderCredential as jest.Mock
const context = {
  requestId: "request-1",
  sessionId: "session-1",
  ownerAccountId: "owner",
  accountGeneration: 3,
  protocol: "anthropic",
  modelAlias: "vision",
  providerId: "openai",
  modelId: "vision-model",
}

function interceptor(pointId: string, handler: (value: Record<string, unknown>) => unknown) {
  registerInterceptor({
    registrationId: pointId,
    pluginId: "approved-plugin",
    pluginInstanceId: "approved-plugin#1",
    generation: 1,
    realmId: "global",
    pointId,
    semantic: pointId === "gateway.usage.recorded" ? "observe" : "transform",
    trustTier: "builtin",
    order: {},
    timeoutMs: 50,
    handler: handler as InterceptorRegistration["handler"],
    source: "interceptors",
    runtime: "frontend",
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetInterceptorRegistryForTesting()
  status.mockResolvedValue({ running: true, ownerAccountId: "owner", accountGeneration: 3 })
  providers.resolveFeatureProvider.mockReturnValue({
    kind: "resolved",
    providerId: "openai",
    protocol: "openai",
    model: "default",
    apiKey: "test-only",
  })
  ledger.beginLedgeredGeneration.mockResolvedValue(null)
  credential.mockResolvedValue(null)
  generate.mockResolvedValue({ text: "A red bird", usage: { inputTokens: 12, outputTokens: 4 } })
  search.mockResolvedValue({
    results: [{ title: "Primary source", url: "https://example.com", content: "Evidence" }],
  })
})

it("recognizes only the internal gateway command family", () => {
  expect(isGatewayRuntimeCommand("gateway_privacy_prepare")).toBe(true)
  expect(isGatewayRuntimeCommand("gateway_update_config")).toBe(false)
})

it("masks text with unique canonical placeholders while preserving selectors and media", async () => {
  const body = {
    model: "vision",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Contact first@example.com" },
          { type: "text", text: "Then second@example.com" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "first@example.com" },
          },
        ],
      },
    ],
  }
  const result = (await dispatchGatewayRuntimeCommand("gateway_privacy_prepare", {
    ...context,
    body,
  })) as { body: typeof body; replacements: GatewayPrivacyReplacement[] }
  expect(result.body.model).toBe("vision")
  expect(result.body.messages[0].content[2]).toEqual(body.messages[0].content[2])
  expect(result.replacements).toHaveLength(2)
  expect(
    new Set(result.replacements.map((entry: { placeholder: string }) => entry.placeholder)).size
  ).toBe(2)
  expect(hasNoLeakingPii(result.body.messages[0].content[0].text!)).toBe(true)
  expect(result.replacements.map((entry: { original: string }) => entry.original)).toEqual([
    "first@example.com",
    "second@example.com",
  ])
  expect(body.messages[0].content[0].text).toContain("first@example.com")
})

it("does not replace a literal placeholder already present in the request", async () => {
  const result = (await dispatchGatewayRuntimeCommand("gateway_privacy_prepare", {
    ...context,
    body: { input: "Literal <EMAIL_001> and first@example.com" },
  })) as { body: { input: string }; replacements: GatewayPrivacyReplacement[] }
  expect(result.body.input).toContain("<EMAIL_001>")
  expect(result.replacements[0].placeholder).not.toBe("<EMAIL_001>")
})

it("masks ordinary tool data fields while leaving encoded media untouched", async () => {
  const result = (await dispatchGatewayRuntimeCommand("gateway_privacy_prepare", {
    ...context,
    body: {
      input: { data: "first@example.com", url: "https://first:secretvalue@example.test" },
      messages: [
        { content: [{ type: "image", source: { type: "base64", data: "first@example.com" } }] },
      ],
    },
  })) as {
    body: { input: { data: string; url: string } }
    replacements: GatewayPrivacyReplacement[]
  }
  expect(result.body.input.data).not.toContain("first@example.com")
  expect(result.body.input.url).not.toContain("secretvalue")
})

it("keeps Gemini file references opaque in both supported wire spellings", async () => {
  const reference = {
    mimeType: "image/png",
    fileUri: "https://user:opaque-token@example.test/image.png",
  }
  const body = {
    contents: [
      {
        parts: [
          { fileData: reference },
          { file_data: { mime_type: "image/png", file_uri: reference.fileUri } },
          { text: "first@example.com" },
        ],
      },
    ],
  }
  const result = await dispatchGatewayRuntimeCommand("gateway_privacy_prepare", {
    ...context,
    body,
  })
  expect(result.body).toMatchObject({
    contents: [
      {
        parts: [
          { fileData: reference },
          { file_data: { mime_type: "image/png", file_uri: reference.fileUri } },
          { text: expect.not.stringContaining("first@example.com") },
        ],
      },
    ],
  })
})

it("refuses a stale account generation before exposing request text", async () => {
  status.mockResolvedValue({ ownerAccountId: "owner", accountGeneration: 4 })
  const hook = jest.fn((value) => value)
  interceptor("gateway.request.prepare", hook)
  await expect(
    dispatchGatewayRuntimeCommand("gateway_middleware_request", {
      ...context,
      body: { input: "hello" },
    })
  ).rejects.toThrow("gateway_account_changed")
  expect(hook).not.toHaveBeenCalled()
})

it("dispatches raw wire bodies at the dedicated point", async () => {
  interceptor("gateway.request.prepare", (value) => ({ ...value, body: { input: "rewritten" } }))
  await expect(
    dispatchGatewayRuntimeCommand("gateway_middleware_request", {
      ...context,
      body: { input: "original" },
    })
  ).resolves.toEqual({ body: { input: "rewritten" } })
})

it("rejects an interceptor that changes the caller or deployment", async () => {
  interceptor("gateway.provider.prepare", (value) => ({ ...value, providerId: "other" }))
  await expect(
    dispatchGatewayRuntimeCommand("gateway_middleware_provider", { ...context, body: {} })
  ).rejects.toThrow(/providerId/)
})

it("rejects an in-place identity mutation rather than trusting a mutated input", async () => {
  interceptor("gateway.request.prepare", (value) => {
    value.ownerAccountId = "other"
    return value
  })
  await expect(
    dispatchGatewayRuntimeCommand("gateway_middleware_request", { ...context, body: {} })
  ).rejects.toThrow(/ownerAccountId/)
})

it("fails closed when a gateway transform exceeds its registered deadline", async () => {
  jest.useFakeTimers()
  try {
    interceptor("gateway.request.prepare", async () => new Promise(() => {}))
    const pending = dispatchGatewayRuntimeCommand("gateway_middleware_request", {
      ...context,
      body: {},
    })
    const failure = expect(pending).rejects.toThrow(/timed out|timeout/i)
    await jest.advanceTimersByTimeAsync(60)
    await failure
  } finally {
    jest.useRealTimers()
  }
})

it("cannot drop a stream event by returning null", async () => {
  interceptor("gateway.stream.transform", (value) => ({ ...value, data: null }))
  await expect(
    dispatchGatewayRuntimeCommand("gateway_middleware_event", {
      ...context,
      event: "content_block_delta",
      data: { delta: "hello" },
    })
  ).rejects.toThrow("gateway_invalid_stream_event")
})

it("observes usage without accepting a rewritten accounting record", async () => {
  const observer = jest.fn(() => ({ usage: { inputTokens: 0 } }))
  interceptor("gateway.usage.recorded", observer)
  await expect(
    dispatchGatewayRuntimeCommand("gateway_middleware_usage", {
      ...context,
      usage: { inputTokens: 12 },
    })
  ).resolves.toEqual({ recorded: true })
  expect(observer).toHaveBeenCalledWith(
    expect.objectContaining({ usage: { inputTokens: 12 } }),
    expect.anything()
  )
})

it("reuses configured search policy and a pinned synthesis model", async () => {
  const result = await dispatchGatewayRuntimeCommand("gateway_bridge_search", {
    ...context,
    query: "public subject",
    maxResults: 3,
  })
  expect(search).toHaveBeenCalledWith(
    "public subject",
    expect.objectContaining({
      options: expect.objectContaining({ maxResults: 3 }),
      settings: expect.anything(),
    })
  )
  expect(providers.resolveFeatureProvider).toHaveBeenCalledWith(
    expect.objectContaining({
      providerId: "openai",
      selectionMode: "explicit-provider",
      fallbackMode: "none",
    }),
    expect.anything()
  )
  expect(result.text).toBe("A red bird")
  expect(usage).toHaveBeenCalledWith(
    expect.objectContaining({
      surface: "gateway",
      scopeId: "session-1",
      operationId: "bridge:request-1:search",
    })
  )
})

it("bounds UTF-8 prompt bytes before running search or generation", async () => {
  await expect(
    dispatchGatewayRuntimeCommand("gateway_bridge_search", {
      ...context,
      query: "界".repeat(22_000),
    })
  ).rejects.toThrow("gateway_bridge_prompt_too_large")
  expect(search).not.toHaveBeenCalled()
  expect(generate).not.toHaveBeenCalled()
  expect(ledger.beginLedgeredGeneration).not.toHaveBeenCalled()
})

it("bounds the final search synthesis prompt before reserving or generating", async () => {
  search.mockResolvedValue({ results: [{ content: "evidence ".repeat(9_000) }] })
  await expect(
    dispatchGatewayRuntimeCommand("gateway_bridge_search", { ...context, query: "Find evidence" })
  ).rejects.toThrow("gateway_bridge_prompt_too_large")
  expect(search).toHaveBeenCalledTimes(1)
  expect(generate).not.toHaveBeenCalled()
  expect(ledger.beginLedgeredGeneration).not.toHaveBeenCalled()
})

it("refuses unavailable credentials without changing providers", async () => {
  providers.resolveFeatureProvider.mockReturnValue({ kind: "unresolved", reason: "missing key" })
  await expect(
    dispatchGatewayRuntimeCommand("gateway_bridge_vision", {
      ...context,
      prompt: "Describe",
      images: ["data:image/png;base64,AQID"],
    })
  ).rejects.toThrow("gateway_bridge_credentials_unavailable")
  expect(generate).not.toHaveBeenCalled()
})

it("refuses a credential changed since the native snapshot was accepted", async () => {
  await expect(
    dispatchGatewayRuntimeCommand("gateway_bridge_vision", {
      ...context,
      expectedCredentialHash: "0".repeat(64),
      prompt: "Describe",
      images: ["data:image/png;base64,AQID"],
    })
  ).rejects.toThrow("gateway_bridge_credential_changed")
  expect(generate).not.toHaveBeenCalled()
  expect(search).not.toHaveBeenCalled()
})

it("uses a native one-use ticket without resolving or recording the provider secret again", async () => {
  const hash = "a".repeat(64)
  await dispatchGatewayRuntimeCommand("gateway_bridge_vision", {
    ...context,
    expectedCredentialHash: hash,
    nativeLease: {
      baseUrl: "http://127.0.0.1:8317/v1",
      secret: "one-use-test-ticket",
      modelId: "vision-model",
      credentialHash: hash,
    },
    prompt: "Describe",
    images: ["data:image/png;base64,AQID"],
  })
  expect(providers.createProviderSettingsSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({
      providerSettings: {},
      customProviders: [
        expect.objectContaining({
          apiKey: "one-use-test-ticket",
          baseURL: "http://127.0.0.1:8317/v1",
        }),
      ],
    })
  )
  expect(credential).not.toHaveBeenCalled()
  expect(usage).not.toHaveBeenCalled()
})

it("rejects a remote native-lease endpoint before any call", async () => {
  const hash = "a".repeat(64)
  await expect(
    dispatchGatewayRuntimeCommand("gateway_bridge_vision", {
      ...context,
      expectedCredentialHash: hash,
      nativeLease: {
        baseUrl: "https://example.com/v1",
        secret: "test-ticket",
        modelId: "vision-model",
        credentialHash: hash,
      },
      prompt: "Describe",
      images: ["data:image/png;base64,AQID"],
    })
  ).rejects.toThrow("gateway_invalid_native_lease")
  expect(generate).not.toHaveBeenCalled()
})

it("requires the selected subscription account instead of falling back to a manual key", async () => {
  await expect(
    dispatchGatewayRuntimeCommand("gateway_bridge_vision", {
      ...context,
      accountId: "account-b",
      prompt: "Describe",
      images: ["data:image/png;base64,AQID"],
    })
  ).rejects.toThrow("gateway_bridge_credentials_unavailable")
  expect(credential).toHaveBeenCalledWith("openai", expect.anything(), "account-b")
  expect(generate).not.toHaveBeenCalled()
})

it("uses a selected subscription credential only in a transient provider snapshot", async () => {
  credential.mockResolvedValue({
    apiKey: "transient-test-key",
    baseURL: "https://provider.example/v1",
  })
  await dispatchGatewayRuntimeCommand("gateway_bridge_vision", {
    ...context,
    accountId: "account-b",
    prompt: "Describe",
    images: ["data:image/png;base64,AQID"],
  })
  expect(providers.createProviderSettingsSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({
      providerSettings: {
        openai: expect.objectContaining({ providerId: "openai", apiKey: "transient-test-key" }),
      },
    })
  )
})

it("uses only inline image bytes, a gated prompt, and the existing generation lease", async () => {
  const lease = {
    options: { maxRetries: 0, maxOutputTokens: 64 },
    succeeded: jest.fn(),
    failed: jest.fn(),
  }
  ledger.beginLedgeredGeneration.mockResolvedValue(lease)
  const result = await dispatchGatewayRuntimeCommand("gateway_bridge_vision", {
    ...context,
    prompt: "Describe",
    images: ["data:image/png;base64,AQID"],
  })
  expect(result.text).toBe("A red bird")
  expect(generate).toHaveBeenCalledWith(
    expect.objectContaining({ maxRetries: 0, maxOutputTokens: 64, messages: expect.any(Array) })
  )
  expect(lease.succeeded).toHaveBeenCalledWith({ inputTokens: 12, outputTokens: 4 })
})

it.each(["https://example.com/private.png", "file:///private.png"])(
  "rejects image locations without fetching them: %s",
  async (image) => {
    await expect(
      dispatchGatewayRuntimeCommand("gateway_bridge_vision", {
        ...context,
        prompt: "Describe",
        images: [image],
      })
    ).rejects.toThrow("gateway_bridge_inline_images_required")
    expect(generate).not.toHaveBeenCalled()
  }
)

it("does not send text that still fails the canonical PII gate", async () => {
  await expect(
    dispatchGatewayRuntimeCommand("gateway_bridge_vision", {
      ...context,
      prompt: "Email first@example.com",
      images: ["data:image/png;base64,AQID"],
    })
  ).rejects.toThrow("gateway_bridge_pii_blocked")
  expect(generate).not.toHaveBeenCalled()
})

it("settles a failed provider call once and discards results after an account change", async () => {
  const lease = { options: { maxRetries: 0 }, succeeded: jest.fn(), failed: jest.fn() }
  ledger.beginLedgeredGeneration.mockResolvedValue(lease)
  generate.mockRejectedValueOnce(new Error("provider failed"))
  await expect(
    dispatchGatewayRuntimeCommand("gateway_bridge_vision", {
      ...context,
      prompt: "Describe",
      images: ["data:image/png;base64,AQID"],
    })
  ).rejects.toThrow("provider failed")
  expect(lease.failed).toHaveBeenCalledTimes(1)
  generate.mockImplementationOnce(async () => {
    status.mockResolvedValue({ ownerAccountId: "other", accountGeneration: 4 })
    return { text: "discarded", usage: {} }
  })
  await expect(
    dispatchGatewayRuntimeCommand("gateway_bridge_vision", {
      ...context,
      prompt: "Describe",
      images: ["data:image/png;base64,AQID"],
    })
  ).rejects.toThrow("gateway_account_changed")
})
