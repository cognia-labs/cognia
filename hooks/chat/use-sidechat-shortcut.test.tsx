/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useSidechatShortcut } from "./use-sidechat-shortcut"
import { getAppRegistration, __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import { openSideChat } from "@/lib/slash-commands/actions/side-chat"

const mockGet = jest.fn()
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ sessions: { get: mockGet } }) }))

let mockMobile = false
let mockActive = "main"
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => mockMobile }))
jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (state: { activeSessionId: string }) => unknown) =>
    selector({ activeSessionId: mockActive }),
}))
jest.mock("@/lib/slash-commands/actions/side-chat", () => ({
  openSideChat: jest.fn(async () => {}),
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

beforeEach(() => {
  __resetAppRuntimeForTesting()
  jest.clearAllMocks()
  mockMobile = false
  mockActive = "main"
  mockGet.mockReset().mockResolvedValue(undefined)
})

it.each(["embedded", "promoted", "unknown"])(
  "uses persisted identity for a preserved aside ID (%s)",
  async (state) => {
    const id = "resource-workbench:session:old"
    mockActive = id
    mockGet.mockResolvedValue(
      state === "unknown"
        ? undefined
        : { id, kind: state === "embedded" ? "resource-workbench" : "direct" }
    )
    renderHook(() => useSidechatShortcut(id))
    expect(getAppRegistration("chat.sidechat.toggle")).toBeUndefined()
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(id))
    if (state === "promoted")
      await waitFor(() => expect(getAppRegistration("chat.sidechat.toggle")).toBeDefined())
    const registration = getAppRegistration("chat.sidechat.toggle")
    if (state !== "promoted") expect(registration).toBeUndefined()
    else {
      expect(registration).toBeDefined()
      await act(async () =>
        registration!.handler(new KeyboardEvent("keydown", { key: ";", ctrlKey: true }))
      )
      expect(openSideChat).toHaveBeenCalledWith(id)
    }
  }
)
afterEach(() => document.body.replaceChildren())

it("reveals from the main textarea and returns focus without closing the dock", async () => {
  document.body.innerHTML =
    '<div data-composer-session="main"><textarea id="main"></textarea></div><div data-sidechat-parent="main"><textarea id="aside"></textarea></div>'
  renderHook(() => useSidechatShortcut("main"))
  const registration = getAppRegistration("chat.sidechat.toggle")!
  expect(registration.allowInEditable).toBe(true)
  expect(registration.preventDefault).toBe(true)
  document.getElementById("main")!.focus()
  await act(async () =>
    registration.handler(new KeyboardEvent("keydown", { key: ";", ctrlKey: true }))
  )
  expect(openSideChat).toHaveBeenCalledWith("main")
  document.getElementById("aside")!.focus()
  act(() => registration.handler(new KeyboardEvent("keydown", { key: ";", metaKey: true })))
  expect(document.activeElement).toBe(document.getElementById("main"))
  expect(openSideChat).toHaveBeenCalledTimes(1)
})

it.each(["mobile", "aside", "inactive", "no-session"])("does not register for %s", (mode) => {
  mockMobile = mode === "mobile"
  if (mode === "inactive") mockActive = "other"
  renderHook(() =>
    useSidechatShortcut(mode === "no-session" ? undefined : "main", mode === "aside")
  )
  expect(getAppRegistration("chat.sidechat.toggle")).toBeUndefined()
})
