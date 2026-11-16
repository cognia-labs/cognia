/** @jest-environment jsdom */
import { transport } from "@/lib/tauri"
import { hasApiKey, hasOauthBearer, setApiKey, setProviderEnv } from "./sidecar-credentials"

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

let callSpy: jest.SpiedFunction<typeof transport.call>

beforeEach(() => {
  setTauri(true)
  callSpy = jest.spyOn(transport, "call")
})

afterEach(() => {
  setTauri(false)
  jest.restoreAllMocks()
})

describe("Agent Host credential commands", () => {
  it("setApiKey forwards the key (string or null)", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await setApiKey("sk-abc")
    expect(callSpy).toHaveBeenCalledWith("claude_set_api_key", { key: "sk-abc" })

    callSpy.mockResolvedValueOnce(undefined)
    await setApiKey(null)
    expect(callSpy).toHaveBeenCalledWith("claude_set_api_key", { key: null })
  })

  it("hasApiKey returns the boolean from the command", async () => {
    callSpy.mockResolvedValueOnce(true)
    await expect(hasApiKey()).resolves.toBe(true)
    expect(callSpy).toHaveBeenCalledWith("claude_has_api_key")
  })
})

describe("provider env and OAuth bearer", () => {
  it("setProviderEnv sends header pairs, and leaves headers untouched when omitted", async () => {
    callSpy.mockResolvedValue(undefined)
    await setProviderEnv("sk-1", "https://relay.example", { "anthropic-beta": "context-1m" })
    expect(callSpy).toHaveBeenCalledWith("claude_set_provider_env", {
      apiKey: "sk-1",
      baseUrl: "https://relay.example",
      customHeaders: [["anthropic-beta", "context-1m"]],
    })
    await setProviderEnv(null, null)
    expect(callSpy).toHaveBeenLastCalledWith("claude_set_provider_env", {
      apiKey: null,
      baseUrl: null,
      customHeaders: undefined,
    })
  })

  it("hasOauthBearer returns the boolean from the command", async () => {
    callSpy.mockResolvedValueOnce(false)
    await expect(hasOauthBearer()).resolves.toBe(false)
    expect(callSpy).toHaveBeenCalledWith("claude_has_oauth_bearer")
  })
})

describe("web mode", () => {
  it("rejects setApiKey with the WebStub error when no spy is attached", async () => {
    setTauri(false)
    callSpy.mockRestore()
    await expect(setApiKey(null)).rejects.toThrow(/tauri-only command from web mode/)
  })
})
