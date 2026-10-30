/** Real provider/model construction; only the outbound HTTP transport is captured. */
import { dispatchGatewayRuntimeCommand } from "./runtime-bridge"
import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import { getStreamingFetch } from "@/lib/runtime/streaming-fetch"

jest.mock("@tauri-apps/api/core", () => ({
  ...jest.requireActual("@tauri-apps/api/core"),
  invoke: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(() => false),
}))

jest.mock("@/lib/accounts/active-account-id", () => ({ getActiveAccountId: () => "owner" }))
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayGetStatus: async () => ({ ownerAccountId: "owner", accountGeneration: 3 }),
}))
jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => ({ providerSettings: {}, customProviders: [] }),
}))
jest.mock("@/lib/ai/ledgered-model-call", () => ({
  beginLedgeredGeneration: async () => null,
  usageOfResult: () => ({ inputTokens: 9, outputTokens: 3 }),
}))
jest.mock("@/lib/db/session-usage", () => ({
  recordSurfaceUsage: jest.fn(),
  swallowUsageWrite: jest.fn(),
}))
jest.mock("@/lib/runtime/streaming-fetch", () => ({
  getStreamingFetch: jest.fn(() => mockFetch),
  browserDirectHeaders: () => ({}),
}))

const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

beforeEach(() => {
  jest.mocked(isTauri).mockReturnValue(false)
  jest.mocked(invoke).mockReset()
  jest.mocked(getStreamingFetch).mockClear()
  mockFetch.mockReset().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          id: "native-child",
          object: "chat.completion",
          created: 1,
          model: "bound-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Observed image" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        }),
        { headers: { "content-type": "application/json" } }
      )
  )
  jest.spyOn(globalThis, "fetch").mockImplementation(mockFetch)
})
afterEach(() => {
  jest.restoreAllMocks()
})

it.each(["codex", "google", "commandcode"])(
  "pins a %s native lease to its loopback Chat endpoint and one-use token",
  async (providerId) => {
    const hash = "a".repeat(64)
    const result = await dispatchGatewayRuntimeCommand("gateway_bridge_vision", {
      requestId: "native-1",
      sessionId: "session",
      ownerAccountId: "owner",
      accountGeneration: 3,
      modelAlias: "vision",
      providerId,
      modelId: "bound-model",
      protocol: "anthropic",
      expectedCredentialHash: hash,
      nativeLease: {
        baseUrl: "http://127.0.0.1:8317/v1",
        secret: "one-use-test-ticket",
        modelId: "bound-model",
        credentialHash: hash,
      },
      prompt: "Describe the image",
      images: [PNG],
    })
    expect(result.text).toBe("Observed image")
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetch.mock.calls[0]
    expect(url instanceof Request ? url.url : String(url)).toBe(
      "http://127.0.0.1:8317/v1/chat/completions"
    )
    expect(
      new Headers(url instanceof Request ? url.headers : options?.headers).get("authorization")
    ).toBe("Bearer one-use-test-ticket")
    const body = JSON.parse(
      url instanceof Request ? await url.clone().text() : String(options?.body)
    )
    expect(body.model).toBe("bound-model")
    expect(body.messages[0].content[1].image_url.url).toBe(PNG)
  }
)

it("uses the real buffered native proxy rather than WebView fetch for a desktop lease", async () => {
  jest.mocked(isTauri).mockReturnValue(true)
  const response = {
    id: "child",
    object: "chat.completion",
    created: 1,
    model: "bound-model",
    choices: [
      { index: 0, message: { role: "assistant", content: "Native answer" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
  }
  jest.mocked(invoke).mockImplementation(async (command) => {
    if (command === "proxy_get_active") return { requestAdmissionVersion: 1 }
    if (command === "proxy_http_prepare") return "admission-test"
    if (command === "proxy_http_request")
      return {
        status: 200,
        bodyBase64: btoa(JSON.stringify(response)),
        headers: { "content-type": "application/json" },
      }
    return true
  })
  const hash = "a".repeat(64)
  const result = await dispatchGatewayRuntimeCommand("gateway_bridge_vision", {
    requestId: "desktop-native",
    ownerAccountId: "owner",
    accountGeneration: 3,
    protocol: "anthropic",
    modelAlias: "vision",
    providerId: "codex",
    modelId: "bound-model",
    expectedCredentialHash: hash,
    nativeLease: {
      baseUrl: "http://127.0.0.1:8317/v1",
      secret: "one-use-test-ticket",
      modelId: "bound-model",
      credentialHash: hash,
    },
    prompt: "Describe",
    images: [PNG],
  })
  expect(result.text).toBe("Native answer")
  expect(mockFetch).not.toHaveBeenCalled()
  expect(getStreamingFetch).not.toHaveBeenCalled()
  const args = jest
    .mocked(invoke)
    .mock.calls.find(([command]) => command === "proxy_http_request")?.[1] as {
    input: {
      url: string
      headers: Record<string, string>
      bodyBase64: string
      timeoutMs: number
    }
  }
  const request = args.input
  expect(request.url).toBe("http://127.0.0.1:8317/v1/chat/completions")
  expect(request.headers.authorization).toBe("Bearer one-use-test-ticket")
  expect(request.headers.origin).toBeUndefined()
  expect(request.timeoutMs).toBeGreaterThanOrEqual(60_000)
  expect(JSON.parse(atob(request.bodyBase64)).model).toBe("bound-model")
})
