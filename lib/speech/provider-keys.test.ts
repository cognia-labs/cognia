jest.mock("@/lib/tts/keyring", () => ({
  HOST_KEY_PRESENT: "__cognia_host_key_present__",
  setProviderKey: jest.fn(),
  clearProviderKey: jest.fn(),
  loadAllProviderKeys: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))

import { isTauri } from "@/lib/tauri"
import { clearProviderKey, loadAllProviderKeys, setProviderKey } from "@/lib/tts/keyring"
import {
  __resetSpeechProviderKeysForTests,
  clearSpeechProviderKey,
  ensureSpeechProviderKeys,
  refreshSpeechProviderKeys,
  setSpeechProviderKey,
  speechProviderKeys,
} from "./provider-keys"

const load = jest.mocked(loadAllProviderKeys)

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(isTauri).mockReturnValue(false)
  __resetSpeechProviderKeysForTests()
  jest.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => jest.restoreAllMocks())

describe("speech provider keys", () => {
  it("trims a key, writes it to the keyring and mirrors it", async () => {
    await setSpeechProviderKey("openai", "  sk-trim  ")
    expect(setProviderKey).toHaveBeenCalledWith("openai", "sk-trim")
    expect(speechProviderKeys().openai).toBe("sk-trim")
  })

  it("forgets the mirrored key when the trimmed key is empty", async () => {
    __resetSpeechProviderKeysForTests({ openai: "sk-old" }, true)
    await setSpeechProviderKey("openai", "    ")
    expect(setProviderKey).toHaveBeenCalledWith("openai", "")
    expect(speechProviderKeys().openai).toBeUndefined()
  })

  it("keeps only a presence marker for a desktop key", async () => {
    jest.mocked(isTauri).mockReturnValue(true)
    await setSpeechProviderKey("openai", "sk-desktop")
    expect(speechProviderKeys().openai).toBe("__cognia_host_key_present__")
  })

  it("clears a provider's slot", async () => {
    __resetSpeechProviderKeysForTests({ openai: "sk-x", google: "g" }, true)
    await clearSpeechProviderKey("openai")
    expect(clearProviderKey).toHaveBeenCalledWith("openai")
    expect(speechProviderKeys()).toEqual({ google: "g" })
  })

  it("loads once, then leaves the keys alone", async () => {
    load.mockResolvedValue({ openai: "sk-lazy" })
    await ensureSpeechProviderKeys()
    await ensureSpeechProviderKeys()
    expect(speechProviderKeys()).toEqual({ openai: "sk-lazy" })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("warns on a failed load and retries on the next call", async () => {
    load.mockRejectedValueOnce(new Error("keyring err"))
    await ensureSpeechProviderKeys()
    expect(speechProviderKeys()).toEqual({})
    expect(console.warn).toHaveBeenCalled()

    load.mockResolvedValue({ openai: "ok" })
    await ensureSpeechProviderKeys()
    expect(speechProviderKeys()).toEqual({ openai: "ok" })
  })

  it("refreshes even after a load, and keeps the keys it had when that fails", async () => {
    __resetSpeechProviderKeysForTests({ openai: "stale" }, true)
    load.mockResolvedValueOnce({ openai: "fresh" })
    await refreshSpeechProviderKeys()
    expect(speechProviderKeys().openai).toBe("fresh")

    load.mockRejectedValueOnce(new Error("offline"))
    await refreshSpeechProviderKeys()
    expect(speechProviderKeys().openai).toBe("fresh")
    expect(console.warn).toHaveBeenCalled()
  })
})
