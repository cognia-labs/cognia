/** @jest-environment jsdom */
import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { revealSideChat } from "@/lib/slash-commands/actions/side-chat"
import { useAgentChat } from "@/hooks/chat/use-agent-chat-controller"
import { useChatStore } from "@/stores/chat"
import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import { getMessageMentions } from "@/lib/chat/mentions/read"
import { SideChatSourceChip } from "./side-chat-source-chip"

jest.mock("@/lib/slash-commands/actions/side-chat", () => ({ revealSideChat: jest.fn() }))
let mockLocale = "en"
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: { title: string }) => {
    if (namespace !== "contextWorkbench.asides") return key
    const catalog =
      mockLocale === "en"
        ? jest.requireActual("@/i18n/messages/en/contextWorkbench.json")
        : jest.requireActual("@/i18n/messages/zh-CN/contextWorkbench.json")
    const template = catalog.asides[key] ?? key
    return values ? template.replace("{title}", values.title) : template
  },
}))
// Keep the real send controller, mention capture and message persistence;
// replace the provider and Host services so this test sends nothing externally.
jest.mock("@/lib/runtime/standalone-mode", () => ({ isStandaloneChatMode: () => true }))
jest.mock("@/lib/ai/chat/standalone-engine", () => ({
  runStandaloneTurn: jest.fn(async () => undefined),
}))
jest.mock("@/hooks/chat/agent-chat-send-options", () => ({
  ...jest.requireActual("@/hooks/chat/agent-chat-send-options"),
  buildSendOptions: jest.fn(async () => ({
    provider: "openai",
    model: "test-model",
    permissionMode: "plan",
    allowedTools: [],
    toolSurface: "none",
    contentSafety: { injectionProtection: false },
  })),
}))
jest.mock("@/lib/ai/agent/execution/sidecar-client", () => ({
  ...jest.requireActual("@/lib/ai/agent/execution/sidecar-client"),
  onClaudeMessage: jest.fn(async () => () => {}),
  turnsRunOnPairedHost: jest.fn(() => false),
}))
jest.mock("@/lib/files/project-editor-bridge", () => ({
  flushProjectEditorEdits: jest.fn(async () => []),
}))
jest.mock("@/lib/telemetry/events/track-event", () => ({ trackEvent: jest.fn(async () => true) }))
jest.mock("@/lib/execution/direct-chat-run", () => ({
  ...jest.requireActual("@/lib/execution/direct-chat-run"),
  startDirectChatExecutionRun: jest.fn(async () => undefined),
  finishDirectChatExecutionRun: jest.fn(async () => undefined),
  recordDirectChatSdkMessage: jest.fn(async () => undefined),
}))
jest.mock("@/lib/execution/chat-lease", () => ({
  ...jest.requireActual("@/lib/execution/chat-lease"),
  acquireChatLease: jest.fn(async () => () => {}),
}))
jest.mock("@/lib/chat/canonical-sink", () => ({
  ...jest.requireActual("@/lib/chat/canonical-sink"),
  recordChatCanonicalEvents: jest.fn(async () => undefined),
}))

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
afterAll(fixture.dispose)

const parent = { id: "source-parent", title: "Main", createdAt: 1, updatedAt: 1 } as ChatSession
const aside = {
  ...parent,
  id: "resource-workbench:source-aside",
  title: "Research",
  kind: "resource-workbench",
  visibility: "embedded",
  surfaceBinding: { kind: "session", sessionId: parent.id },
} as ChatSession
const citation = {
  kind: "entity" as const,
  id: `message:${aside.id}#answer#exact`,
  label: "Research",
}

function renderChip(ref = citation, parentId = parent.id, locale = "en") {
  mockLocale = locale
  return render(<SideChatSourceChip citation={ref} parentId={parentId} />)
}

beforeEach(async () => {
  await getDb().sessions.bulkPut([parent, aside])
  jest.mocked(revealSideChat).mockReset().mockResolvedValue(true)
})
afterEach(async () => {
  await getDb().sessions.bulkDelete([parent.id, aside.id, "source-other"])
})

it.each([
  ["en", "From side chat: Research"],
  ["zh-CN", "来自旁聊：Research"],
])(
  "renders the localized side-chat source and reveals its exact message (%s)",
  async (locale, label) => {
    const user = userEvent.setup()
    renderChip(citation, parent.id, locale)
    await user.click(await screen.findByRole("button", { name: label }))
    expect(revealSideChat).toHaveBeenCalledTimes(1)
    expect(revealSideChat).toHaveBeenCalledWith(parent.id, aside.id, "answer#exact")
  }
)

it("leaves ordinary message citations unchanged", async () => {
  await getDb().sessions.put({ ...parent, id: "source-other", title: "Ordinary chat" })
  renderChip({ ...citation, id: "message:source-other#answer", label: "Ordinary chat" })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(screen.queryByRole("button")).toBeNull()
  expect(revealSideChat).not.toHaveBeenCalled()
})

it("does not expose a side chat through another parent", async () => {
  await getDb().sessions.put({ ...parent, id: "source-other" })
  renderChip(citation, "source-other")
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(screen.queryByRole("button")).toBeNull()
})

it("updates when the source is deleted", async () => {
  renderChip()
  await screen.findByRole("button", { name: "From side chat: Research" })
  await act(async () => {
    await getDb().sessions.delete(aside.id)
  })
  await waitFor(() => expect(screen.queryByRole("button")).toBeNull())
})

it.each(["message:broken", "session:source-aside", "message:#answer"])(
  "ignores malformed or non-message citations: %s",
  (id) => {
    renderChip({ ...citation, id })
    expect(screen.queryByRole("button")).toBeNull()
  }
)

it("persists a sent user row's side-chat source once through the real controller", async () => {
  useAgentRuntimeStore.setState({ runtimeRef: { kind: "builtin" }, sessionRuntimeRefs: {} })
  useChatStore.getState().clear()
  useChatStore.getState().setActiveSession(parent.id)
  const { result, unmount } = renderHook(useAgentChat)
  try {
    await act(async () => {
      await expect(
        result.current.send("> conclusion\n\n", undefined, {
          sessionId: parent.id,
          citations: [citation, citation],
        })
      ).resolves.toBe(true)
    })
    const userRow = useChatStore
      .getState()
      .sessions[parent.id].messages.find((message) => message.role === "user")!
    expect(getMessageMentions(userRow as { metadata?: Record<string, unknown> })).toEqual([
      citation,
    ])
    const stored = await getDb().messages.get(userRow.id)
    expect(stored?.metadata?.mentions).toEqual([citation])
  } finally {
    unmount()
    useChatStore.getState().clear()
  }
})
