/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"

const mockSetReplyTo = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ setReplyTo: mockSetReplyTo }) },
}))
const mockStage = jest.fn()
jest.mock("@/stores/chat/composer-intent-store", () => ({
  useComposerIntentStore: { getState: () => ({ stage: mockStage }) },
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: "p1" }) },
}))
const mockAppend = jest.fn((_detail: unknown) => true)
jest.mock("@/components/chat/composer", () => ({
  dispatchComposerAppend: (detail: unknown) => mockAppend(detail),
}))
let mockAside: string | null = null
jest.mock("@/components/context-workbench/aside-target", () => ({
  useAsideTarget: () => mockAside,
}))
const mockGetSession = jest.fn()
jest.mock("@/lib/db/sessions", () => ({ getSession: (id: string) => mockGetSession(id) }))
jest.mock("dexie-react-hooks", () => {
  const React = jest.requireActual("react") as typeof import("react")
  return {
    useLiveQuery: (query: () => Promise<unknown>, deps: unknown[]) => {
      const [value, setValue] = React.useState<unknown>(undefined)
      React.useEffect(() => {
        void query().then(setValue)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps)
      return value
    },
  }
})
const mockSaveMemory = jest.fn()
jest.mock("@/lib/chat/save-message-as-memory", () => ({
  saveMessageAsMemory: (input: unknown) => mockSaveMemory(input),
}))
const mockSaveIssue = jest.fn()
jest.mock("@/lib/chat/save-message-as-issue", () => ({
  saveMessageAsIssue: (input: unknown) => mockSaveIssue(input),
}))
const mockRerun = jest.fn()
jest.mock("@/lib/chat/template/rerun-request", () => ({
  requestTemplateRerun: (input: unknown) => mockRerun(input),
}))
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
    info: (...args: unknown[]) => mockToast.info(...args),
  },
}))
const mockPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import { useMessageCommands } from "./use-message-commands"

const message = (text = "line one\nline two", metadata?: unknown): UIMessage =>
  ({ id: "m1", role: "assistant", parts: [{ type: "text", text }], metadata }) as UIMessage

beforeEach(() => {
  jest.clearAllMocks()
  mockAside = null
  mockGetSession.mockResolvedValue({ id: "s1", parentSessionId: null })
})

it("aims the composer's next send at the message", () => {
  const { result } = renderHook(() => useMessageCommands({ message: message(), sessionId: "s1" }))
  result.current.reply()
  expect(mockSetReplyTo).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m1" }), "s1")
})

it("does nothing for a closed sheet or outside a conversation", async () => {
  const closed = renderHook(() => useMessageCommands({ message: null, sessionId: "s1" }))
  closed.result.current.reply()
  await closed.result.current.saveAsMemory()
  await closed.result.current.bringBack()
  const loose = renderHook(() => useMessageCommands({ message: message(), sessionId: undefined }))
  loose.result.current.reply()
  await loose.result.current.saveAsIssue()
  expect(mockSetReplyTo).not.toHaveBeenCalled()
  expect(mockSaveMemory).not.toHaveBeenCalled()
  expect(mockSaveIssue).not.toHaveBeenCalled()
  expect(mockAppend).not.toHaveBeenCalled()
})

it("hands a branch's message back to the conversation it was cut from", async () => {
  mockGetSession.mockResolvedValue({ id: "s1", parentSessionId: "parent" })
  const { result } = renderHook(() => useMessageCommands({ message: message(), sessionId: "s1" }))
  await waitFor(() => expect(result.current.handBackTargetId).toBe("parent"))
  await act(() => result.current.bringBack())
  expect(mockAppend).toHaveBeenCalledWith(
    expect.objectContaining({
      text: "> line one\n> line two\n\n",
      sessionId: "parent",
      submit: false,
    })
  )
  expect(mockToast.success).toHaveBeenCalledWith("bringBackDone")
})

it("sends a side chat's message to the main conversation, citing where it came from", async () => {
  mockAside = "main"
  mockGetSession.mockResolvedValue({ id: "aside", title: "Side chat" })
  const { result } = renderHook(() =>
    useMessageCommands({ message: message(), sessionId: "aside", documentSessionId: "aside" })
  )
  expect(result.current.asideTargetSessionId).toBe("main")
  await act(() => result.current.sendToMain())
  const detail = mockAppend.mock.calls[0][0] as {
    sessionId: string
    submit: boolean
    citations: unknown[]
  }
  expect(detail).toMatchObject({ sessionId: "main", submit: true })
  expect(detail.citations).toHaveLength(1)
})

it("stages the text as a draft when no composer claims it", async () => {
  mockAside = "main"
  mockAppend.mockReturnValueOnce(false)
  const { result } = renderHook(() =>
    useMessageCommands({ message: message(), sessionId: "aside" })
  )
  await act(() => result.current.bringBack())
  expect(mockStage).toHaveBeenCalledWith("main", expect.objectContaining({ mode: "append" }))
  expect(mockToast.info).toHaveBeenCalledWith("bringBackDraft")
})

it("saves as a memory under the active project and says so", async () => {
  mockSaveMemory.mockResolvedValue("A finding")
  const { result } = renderHook(() => useMessageCommands({ message: message(), sessionId: "s1" }))
  await act(() => result.current.saveAsMemory())
  expect(mockSaveMemory).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: "s1", projectId: "p1" })
  )
  expect(mockToast.success).toHaveBeenCalledWith('saveAsMemoryDone:{"title":"A finding"}')
})

it("reports a refused save instead of claiming success", async () => {
  mockSaveIssue.mockRejectedValue(new Error("Create a project first"))
  const { result } = renderHook(() => useMessageCommands({ message: message(), sessionId: "s1" }))
  await act(() => result.current.saveAsIssue())
  expect(mockToast.error).toHaveBeenCalledWith(
    'saveAsIssueFailed:{"reason":"Create a project first"}'
  )
})

it("reruns the template the turn recorded, and nothing for a turn without one", () => {
  const plain = renderHook(() => useMessageCommands({ message: message(), sessionId: "s1" }))
  expect(plain.result.current.templateRun).toBeNull()
  plain.result.current.rerunTemplate()
  expect(mockRerun).not.toHaveBeenCalled()
})
