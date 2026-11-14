/** @jest-environment jsdom */

import { dispatchSideChat, openSideChat, revealSideChat } from "./side-chat"
import type { SlashContext } from "../builtin"
import { useSideChatRequestStore } from "@/stores/chat/side-chat-request-store"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { toast } from "sonner"

const mockGet = jest.fn()
const mockEnsure = jest.fn()
const mockReveal = jest.fn()
const mockOverride = jest.fn()
let mockActive = "elsewhere"
const mockSetActive = jest.fn()
const mockJump = jest.fn(async (..._args: unknown[]) => true)
jest.mock("@/stores/chat", () => ({
  useChatStore: {
    getState: () => ({ activeSessionId: mockActive, setActiveSession: mockSetActive }),
  },
}))
jest.mock("@/lib/chat/cross-session-jump", () => ({
  jumpToSessionMessage: (...args: unknown[]) => mockJump(...args),
}))

let mockOverrides: Record<string, string> = {}
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ sessions: { get: mockGet } }) }))
jest.mock("@/lib/db/resource-workbench-sessions", () => ({
  createResourceSessionRepository: () => ({}),
}))
jest.mock("@/lib/context-workbench/resource-session", () => ({
  isEmbeddedAside: (...args: unknown[]) =>
    jest.requireActual("@/lib/context-workbench/resource-session").isEmbeddedAside(...args),
  ensureResourceWorkbenchSession: (...args: unknown[]) => mockEnsure(...args),
}))
jest.mock("@/stores/artifact/artifact-dock-layout-store", () => ({
  useArtifactDockLayoutStore: { getState: () => ({ revealSidechat: mockReveal }) },
}))
jest.mock("@/stores/context-workbench/context-workbench-store", () => ({
  useContextWorkbenchStore: {
    getState: () => ({ sessionOverrides: mockOverrides, setSessionOverride: mockOverride }),
  },
}))
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: async () => (key: string) => key,
}))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isNativeMobile: () => false,
}))
jest.mock("sonner", () => ({ toast: { info: jest.fn(), error: jest.fn() } }))

const ctx = (extra: Partial<SlashContext> = {}) =>
  ({
    activeSessionId: "main",
    args: "question",
    chatStatus: "streaming",
    ...extra,
  }) as SlashContext

beforeEach(() => {
  jest.clearAllMocks()
  mockActive = "elsewhere"
  mockOverrides = {}
  mockGet.mockResolvedValue(undefined)
  mockEnsure.mockResolvedValue({ id: "primary", kind: "resource-workbench" })
  useSideChatRequestStore.setState({ pending: {} })
  useComposerIntentStore.setState({ pendingBySession: {} })
})

it.each(["streaming", "awaiting_approval"] as const)(
  "opens and stages during %s without a main send",
  async (chatStatus) => {
    await dispatchSideChat(ctx({ chatStatus }))
    expect(mockEnsure).toHaveBeenCalledWith(
      { kind: "session", sessionId: "main" },
      expect.any(String),
      {}
    )
    expect(useSideChatRequestStore.getState().pending.primary[0].question).toBe("question")
    expect(mockReveal).toHaveBeenCalledTimes(1)
  }
)

it("uses the switcher's override and only focuses when there is no question", async () => {
  const { getContextResourceKey } = await import("@/types/context-workbench")
  mockOverrides[
    getContextResourceKey({ kind: "session", sessionId: "main", capabilities: ["ai"] })
  ] = "chosen"
  mockGet.mockResolvedValue({ id: "chosen", kind: "resource-workbench" })
  await openSideChat("main")
  expect(mockEnsure).not.toHaveBeenCalled()
  expect(useSideChatRequestStore.getState().pending).toEqual({})
  expect(useComposerIntentStore.getState().pendingBySession.chosen.prompt).toBeNull()
})

it("falls back through ensure when the selected aside no longer exists", async () => {
  const { getContextResourceKey } = await import("@/types/context-workbench")
  const key = getContextResourceKey({ kind: "session", sessionId: "main", capabilities: ["ai"] })
  mockOverrides[key] = "deleted"
  await openSideChat("main", "question")
  expect(mockOverride).toHaveBeenCalledWith(key, null)
  expect(mockEnsure).toHaveBeenCalled()
})

it.each([
  [{ isMobile: true }, "desktopOnly"],
  [{ activeSessionId: null }, "needSession"],
] as const)("explains unavailable entry points", async (overrides, message) => {
  await expect(dispatchSideChat(ctx(overrides))).rejects.toThrow(message)
  expect(toast.info).toHaveBeenCalledWith(message)
  expect(mockReveal).not.toHaveBeenCalled()
})

it("does not nest asides", async () => {
  await expect(dispatchSideChat(ctx({ isAside: true }))).rejects.toThrow("openError")
  expect(mockEnsure).not.toHaveBeenCalled()
  expect(mockReveal).not.toHaveBeenCalled()
})

it.each([true, false])("routes by current session semantics (embedded=%s)", async (embedded) => {
  const id = "resource-workbench:session:old"
  mockGet.mockResolvedValue({
    id,
    kind: embedded ? "resource-workbench" : "direct",
    ...(embedded
      ? { visibility: "embedded", surfaceBinding: { kind: "session", sessionId: "old" } }
      : {}),
  })
  const result = dispatchSideChat(ctx({ activeSessionId: id }))
  if (embedded) await expect(result).rejects.toThrow("openError")
  else await expect(result).resolves.toBeUndefined()
  expect(mockEnsure).toHaveBeenCalledTimes(embedded ? 0 : 1)
  expect(mockReveal).toHaveBeenCalledTimes(embedded ? 0 : 1)
})

it("rejects a prefixed session whose row is unknown", async () => {
  await expect(
    dispatchSideChat(ctx({ activeSessionId: "resource-workbench:session:unloaded" }))
  ).rejects.toThrow("openError")
  expect(mockEnsure).not.toHaveBeenCalled()
  expect(mockReveal).not.toHaveBeenCalled()
})

it.each([767, 768, 1023])(
  "keeps the viewport boundary at phone width (%ipx, B11)",
  async (width) => {
    const matchMedia = jest.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query === "(max-width: 767.98px)" && width < 768,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }))
    try {
      const result = dispatchSideChat(ctx())
      if (width < 768) await expect(result).rejects.toThrow("desktopOnly")
      else await expect(result).resolves.toBeUndefined()
      expect(mockReveal).toHaveBeenCalledTimes(width < 768 ? 0 : 1)
      if (width < 768) expect(toast.info).toHaveBeenCalledWith("desktopOnly")
    } finally {
      matchMedia.mockRestore()
    }
  }
)

it("reports an opening failure", async () => {
  mockEnsure.mockRejectedValueOnce(new Error("database unavailable"))
  await expect(dispatchSideChat(ctx())).rejects.toThrow("openError")
  expect(toast.error).toHaveBeenCalledWith("openError")
  expect(mockReveal).not.toHaveBeenCalled()
})

it.each(["main", "resource-workbench:session:old"])(
  "reports a metadata read failure for %s",
  async (id) => {
    mockGet.mockRejectedValueOnce(new Error("metadata unavailable"))
    await expect(dispatchSideChat(ctx({ activeSessionId: id }))).rejects.toThrow("openError")
    expect(toast.error).toHaveBeenCalledWith("openError")
    expect(mockEnsure).not.toHaveBeenCalled()
    expect(mockReveal).not.toHaveBeenCalled()
  }
)

it("reveals the selected aside and jumps without making it a standalone conversation", async () => {
  mockGet.mockImplementation(async (id: string) =>
    id === "main"
      ? { id, title: "Parent" }
      : { id, kind: "resource-workbench", surfaceBinding: { kind: "session", sessionId: "main" } }
  )
  await expect(revealSideChat("main", "chosen", "message")).resolves.toBe(true)
  expect(mockSetActive).toHaveBeenCalledWith("main")
  expect(mockOverride).toHaveBeenCalledWith(expect.any(String), "chosen")
  expect(mockReveal).toHaveBeenCalledTimes(1)
  expect(mockJump).toHaveBeenCalledWith(
    "chosen",
    "message",
    expect.objectContaining({ activeSessionId: "main" })
  )
  expect(useComposerIntentStore.getState().pendingBySession).toEqual({})
})

it("opens only the parent on a narrow layout", async () => {
  const media = jest
    .spyOn(window, "matchMedia")
    .mockReturnValue({ matches: true } as MediaQueryList)
  mockGet.mockImplementation(async (id: string) =>
    id === "main"
      ? { id }
      : { id, kind: "resource-workbench", surfaceBinding: { kind: "session", sessionId: "main" } }
  )
  try {
    await expect(revealSideChat("main", "chosen", "message")).resolves.toBe(true)
    expect(mockSetActive).toHaveBeenCalledWith("main")
    expect(mockOverride).not.toHaveBeenCalled()
    expect(mockReveal).not.toHaveBeenCalled()
    expect(mockJump).not.toHaveBeenCalled()
  } finally {
    media.mockRestore()
  }
})

it("refuses an orphan or an aside belonging to a different parent", async () => {
  mockGet.mockResolvedValue(undefined)
  await expect(revealSideChat("main", "chosen")).resolves.toBe(false)
  mockGet.mockImplementation(async (id: string) =>
    id === "main"
      ? { id }
      : { id, kind: "resource-workbench", surfaceBinding: { kind: "session", sessionId: "other" } }
  )
  await expect(revealSideChat("main", "chosen")).resolves.toBe(false)
  expect(mockSetActive).not.toHaveBeenCalled()
  expect(mockReveal).not.toHaveBeenCalled()
})

it("does not reclaim the parent if the user navigates during metadata hydration", async () => {
  let complete!: (value: unknown) => void
  mockGet.mockImplementation((id: string) =>
    id === "main"
      ? new Promise((resolve) => {
          complete = resolve
        })
      : Promise.resolve({
          id,
          kind: "resource-workbench",
          surfaceBinding: { kind: "session", sessionId: "main" },
        })
  )
  const opening = revealSideChat("main", "aside")
  mockActive = "user-chosen"
  complete({ id: "main" })
  await expect(opening).resolves.toBe(false)
  expect(mockSetActive).not.toHaveBeenCalled()
  expect(mockReveal).not.toHaveBeenCalled()
})
