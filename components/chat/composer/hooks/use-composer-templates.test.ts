/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { TextInputContext } from "@/components/ai-elements/prompt-input"
import type { RouteTargetsState } from "@/hooks/chat/use-route-targets"
import { requestTemplateRerun } from "@/lib/chat/template/rerun-request"
import type { ChatTemplateRun } from "@/lib/chat/template/run"
import type { RichSegment } from "@/lib/slash-commands/parse-segments"
import type { ChatSession } from "@cognia/agent-config-types"

import { useComposerTemplates, type ComposerTemplatesInput } from "./use-composer-templates"

const toast = { info: jest.fn(), success: jest.fn() }
jest.mock("sonner", () => ({
  toast: { info: (m: string) => toast.info(m), success: (m: string) => toast.success(m) },
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const listChatTemplates = jest.fn()
const createChatTemplate = jest.fn(async (..._args: unknown[]) => undefined)
const changeListeners = new Set<() => void>()
jest.mock("@/lib/db/chat-templates", () => ({
  listChatTemplates: () => listChatTemplates(),
  createChatTemplate: (...args: unknown[]) => createChatTemplate(...args),
  subscribeChatTemplates: (listener: () => void) => {
    changeListeners.add(listener)
    return () => changeListeners.delete(listener)
  },
}))
const repoTemplate = { id: "repo-1", name: "Repo", revision: 1, params: [], body: "" }
jest.mock("@/hooks/chat/use-repo-chat-templates", () => ({
  useRepoChatTemplates: () => [repoTemplate],
}))
jest.mock("@/hooks/chat/use-template-resource-search", () => ({
  useTemplateResourceSearch: () => jest.fn(),
}))
const startNewSession = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...args: unknown[]) => startNewSession(...args),
}))

const saved = { id: "mine-1", name: "Mine", revision: 3, params: [{ id: "module" }], body: "" }

function textInputWith(initial: string) {
  let value = initial
  return {
    get value() {
      return value
    },
    setInput: jest.fn((next: string) => {
      value = next
    }),
  } as unknown as TextInputContext
}

function setup(overrides: Partial<ComposerTemplatesInput> = {}) {
  const input: ComposerTemplatesInput = {
    tTemplateParams: ((key: string) => key) as ComposerTemplatesInput["tTemplateParams"],
    textValue: "",
    textInput: textInputWith(""),
    textareaRef: { current: null },
    setCaret: jest.fn(),
    cwd: "/repo",
    sessionId: "s1",
    routes: { targets: [] } as unknown as RouteTargetsState,
    chatAgents: undefined,
    teamMembers: [],
    overlaySegments: [],
    props: { session: null },
    ...overrides,
  }
  return {
    input,
    hook: renderHook((p: ComposerTemplatesInput) => useComposerTemplates(p), {
      initialProps: input,
    }),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  changeListeners.clear()
  listChatTemplates.mockResolvedValue([saved])
})

it("offers personal templates ahead of the repository's and follows changes made elsewhere", async () => {
  const { hook } = setup()
  await waitFor(() => expect(hook.result.current.chatTemplates).toEqual([saved, repoTemplate]))

  listChatTemplates.mockResolvedValue([])
  act(() => {
    for (const listener of changeListeners) listener()
  })
  await waitFor(() => expect(hook.result.current.chatTemplates).toEqual([repoTemplate]))
})

it("saves the draft as a template and re-reads the list", async () => {
  const { hook } = setup({ textInput: textInputWith("Review {{module}}") })
  await waitFor(() => expect(listChatTemplates).toHaveBeenCalledTimes(1))

  await act(() => hook.result.current.saveCurrentAsTemplate({ name: "Review" }))

  expect(createChatTemplate).toHaveBeenCalledWith({ name: "Review", body: "Review {{module}}" })
  expect(toast.success).toHaveBeenCalledWith("saved")
  await waitFor(() => expect(listChatTemplates).toHaveBeenCalledTimes(2))
})

it("binds parameter values to the tokens in the text and drops a value whose token left", async () => {
  const param = { kind: "param", paramId: "module", raw: "{{module}}", start: 7, end: 17 }
  const { hook, input } = setup({
    textValue: "Review {{module}}",
    overlaySegments: [param as RichSegment],
  })
  expect(hook.result.current.paramIds).toEqual(["module"])
  expect(hook.result.current.paramTokenAt(9)).toEqual(param)
  expect(hook.result.current.paramTokenAt(2)).toBeNull()
  expect(hook.result.current.preview?.text).toBe("Review {{module}}")

  act(() => hook.result.current.setParamValue("module", { kind: "text", value: "auth" }))
  expect(hook.result.current.effectiveBinding?.params.module).toEqual({
    kind: "text",
    value: "auth",
  })
  expect(hook.result.current.preview?.text).toBe("Review auth")

  hook.rerender({ ...input, textValue: "Review", overlaySegments: [] })
  expect(hook.result.current.effectiveBinding?.params).toEqual({})
  expect(hook.result.current.preview).toBeNull()
})

it("starts a conversation set up the way the inserted template asks and carries the body", async () => {
  const session = { id: "s1", model: "a", permissionMode: "default" } as unknown as ChatSession
  const textInput = textInputWith("")
  const { hook } = setup({ textInput, props: { session } })
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0)
    return 0
  })

  act(() =>
    hook.result.current.setPendingLaunchSpec({
      spec: { model: "b" },
      templateName: "T",
      body: "Hello",
    })
  )
  expect(hook.result.current.launchDifferences.map((d) => d.field)).toEqual(["model"])
  expect(hook.result.current.launchFieldLabel(hook.result.current.launchDifferences[0])).toBe(
    "fieldModel: b"
  )
  expect(hook.result.current.currentLaunchSpec).toEqual({ model: "a", permissionMode: "default" })

  await act(() => hook.result.current.startSessionFromTemplate())

  expect(startNewSession).toHaveBeenCalledTimes(1)
  expect(textInput.setInput).toHaveBeenCalledWith("Hello")
  expect(hook.result.current.pendingLaunchSpec).toBeNull()
})

it("refuses to load a past run over a half-written box", () => {
  jest.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0)
  const run = {
    text: "Review {{module}}",
    templateId: "mine-1",
    version: "3",
    params: {},
  } as unknown as ChatTemplateRun

  const busy = textInputWith("draft")
  setup({ textInput: busy })
  act(() => requestTemplateRerun({ sessionId: "s1", run }))
  expect(toast.info).toHaveBeenCalledWith("rerunBusy")
  expect(busy.setInput).not.toHaveBeenCalled()
})

it("fills an empty box with the run and binds its values", () => {
  jest.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0)
  const empty = textInputWith("")
  const { hook } = setup({ textInput: empty })
  const run = {
    text: "Review {{module}}",
    templateId: "mine-1",
    version: "3",
    params: { module: { kind: "text", value: "auth" } },
  } as unknown as ChatTemplateRun

  act(() => requestTemplateRerun({ sessionId: "s1", run }))

  expect(empty.setInput).toHaveBeenCalledWith("Review {{module}}")
  expect(hook.result.current.pendingLaunchSpec).toBeNull()
})

it("ignores a re-run addressed to another conversation", () => {
  const empty = textInputWith("")
  setup({ textInput: empty })
  const run = { text: "x", templateId: "t", version: "1", params: {} } as unknown as ChatTemplateRun
  act(() => requestTemplateRerun({ sessionId: "other", run }))
  expect(empty.setInput).not.toHaveBeenCalled()
})
