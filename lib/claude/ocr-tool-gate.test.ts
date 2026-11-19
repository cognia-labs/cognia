jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/db/characters", () => ({ resolveCharacterById: jest.fn() }))
jest.mock("@/lib/chat/conversation-channel", () => ({ conversationChannelFor: jest.fn() }))

import { getSession } from "@/lib/db/sessions"
import { resolveCharacterById } from "@/lib/db/characters"
import { conversationChannelFor } from "@/lib/chat/conversation-channel"
import { allowsOcrToolCall, isOcrToolAllowed } from "./ocr-tool-gate"
import type { Character } from "@cognia/agent-config-types"

const char = (enableOcr?: boolean) => ({ enableOcr }) as Pick<Character, "enableOcr">

describe("isOcrToolAllowed", () => {
  it("allows by default (no character, non-IM)", () => {
    expect(isOcrToolAllowed({})).toBe(true)
  })

  it("allows a browser chat with enableOcr undefined or true", () => {
    expect(isOcrToolAllowed({ character: char(undefined) })).toBe(true)
    expect(isOcrToolAllowed({ character: char(true) })).toBe(true)
  })

  it("denies when the character explicitly sets enableOcr=false", () => {
    expect(isOcrToolAllowed({ character: char(false) })).toBe(false)
    // …even in an IM conversation that opted in.
    expect(
      isOcrToolAllowed({ character: char(false), imSession: true, allowOcrOverride: true })
    ).toBe(false)
  })

  it("allows IM sessions by default (allowOcr undefined)", () => {
    expect(isOcrToolAllowed({ imSession: true })).toBe(true)
    expect(isOcrToolAllowed({ imSession: true, allowOcrOverride: undefined })).toBe(true)
  })

  it("denies an IM session only when allowOcr is explicitly false", () => {
    expect(isOcrToolAllowed({ imSession: true, allowOcrOverride: false })).toBe(false)
  })

  it("ignores allowOcr=false for non-IM sessions", () => {
    expect(isOcrToolAllowed({ imSession: false, allowOcrOverride: false })).toBe(true)
  })
})

describe("live OCR tool authorization", () => {
  it("checks Bot-owned IM authority even without a platform binding", async () => {
    const binding = { adapterId: "bot", platform: "telegram", conversationKey: "telegram:bot:chat" }
    const hostCapabilities = jest.fn(async () => ({ ocr: true, computer_use: false }))
    jest.mocked(getSession).mockResolvedValueOnce({ imAuthorityBinding: binding } as never)
    jest.mocked(getSession).mockResolvedValueOnce({ imAuthorityBinding: binding } as never)
    jest.mocked(conversationChannelFor).mockResolvedValue({ hostCapabilities } as never)
    await expect(
      allowsOcrToolCall("cognia-ocr", "ocr.extract", { source: { kind: "screen" } }, "s1")
    ).resolves.toBe(false)
    await expect(
      allowsOcrToolCall("cognia-ocr", "ocr.extract", { source: { kind: "data_url" } }, "s1")
    ).resolves.toBe(true)
    expect(conversationChannelFor).toHaveBeenCalledWith(binding)
  })

  it("applies a character opt-out to screenshot OCR but not raw screenshots", async () => {
    jest.mocked(getSession).mockResolvedValue({ characterId: "c1" } as never)
    jest.mocked(resolveCharacterById).mockResolvedValue({ enableOcr: false } as never)
    await expect(
      allowsOcrToolCall("cognia-screenshot", "extract_screenshot_ocr", {}, "s1")
    ).resolves.toBe(false)
    await expect(allowsOcrToolCall("cognia-screenshot", "take_screenshot", {}, "s1")).resolves.toBe(
      true
    )
  })
})
