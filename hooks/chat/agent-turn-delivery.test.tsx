/** @jest-environment jsdom */
/** Real Composer and history hook over a session created by the headless API. */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { Composer } from "@/components/chat/composer"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getSession } from "@/lib/db/sessions"
import { listMessages, persistMessages } from "@/lib/db/messages"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { useClaudeChat } from "./use-claude-chat-controller"
import { useSessions } from "./use-sessions"
import { runPluginAgentTurn } from "@/lib/plugin/api/agent-turn"
import { sendManualMessageToConversation } from "@/lib/inbox/manual-send"
import { insertInboundMessage } from "@/lib/connectors/runtime"
import { useHistoryHydration } from "@/hooks/connectors/use-history-hydration"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useProjectStore } from "@/stores/project/project-store"
import { isTauri } from "@/lib/platform/detect"
import { setRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { toast } from "sonner"

jest.mock("@/lib/db/characters", () => ({
  ...jest.requireActual("@/lib/db/characters"),
  resolveCharacterById: async () => ({ id: "lecturer", name: "Lecturer" }),
}))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: async () => ({ cwd: "/repo" }),
}))
jest.mock("@/lib/claude/run-and-capture", () => ({
  runAndCaptureAssistantReply: jest.fn(async () => ({ text: "Reviewed", messageId: "reply" })),
}))
jest.mock("@/lib/claude/unattended-park", () => ({
  createUnattendedPark: () => ({ park: jest.fn(), finish: async () => {}, runId: () => null }),
}))
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: async () => (key: string) => key,
}))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(() => false),
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "web" }))
jest.mock("@/hooks/chat/use-follow-up-suggestions", () => ({
  useFollowUpSuggestions: () => ({
    suggestions: [],
    loading: false,
    dismiss: jest.fn(),
    status: "ineligible",
    retry: jest.fn(),
  }),
}))
jest.mock("@/hooks/chat/use-sdk-context-usage", () => ({
  useSdkContextUsage: () => ({ snapshot: null, refresh: jest.fn() }),
}))
jest.mock("@/components/chat/composer/voice-controls", () => ({ VoiceControls: () => null }))
jest.mock("@/components/inbox/inbox-composer-actions-host", () => ({
  InboxComposerActionsHost: () => null,
}))
jest.mock("@/lib/slash-commands/custom", () => ({ loadCustomSlashCommands: async () => [] }))
jest.mock("@/lib/chat/attachments/dispatch", () => ({
  buildSendContent: async (text: string) => ({
    content: text,
    rejected: [],
    tokens: 1,
    manifest: [],
  }),
  INLINE_TOKEN_CEILING: 1_000_000,
}))
jest.mock("@/lib/inbox/manual-send", () => ({
  ...jest.requireActual("@/lib/inbox/manual-send"),
  sendManualMessageToConversation: jest.fn(async () => {}),
}))
jest.mock("@/lib/connectors/inbox-writes", () => ({
  ...jest.requireActual("@/lib/connectors/inbox-writes"),
  canEnqueueInboxWrite: () => true,
}))
const mockFetchHistory = jest.fn(async function* () {
  yield {
    kind: "create",
    messageId: "remote",
    conversationKey: "lark:app:chat:topic",
    timestamp: 1,
  }
})
jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => ({ listAdapters: () => [{ id: "app", fetchHistory: mockFetchHistory }] }),
}))
jest.mock("@/lib/connectors/runtime", () => ({
  findSessionByConversationKey: jest.fn(),
  insertInboundMessage: jest.fn(),
}))

jest.mock("@/lib/claude/ipc", () => ({
  ...jest.requireActual("@/lib/claude/ipc"),
  onClaudeMessage: async () => () => {},
}))

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  jest.clearAllMocks()
  jest.mocked(isTauri).mockReturnValue(false)
  useChatStore.getState().clear()
  useSettingsStore.setState({ settings: undefined as never })
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  setRuntimeSnapshot({ target: null, vaultState: "unavailable", connectionState: "offline" })
})
afterAll(fixture.dispose)

async function botTranscript(prompt = "Review") {
  const turn = await runPluginAgentTurn(
    { characterId: "lecturer", cwd: "/repo", prompt },
    {
      grantSource: { kind: "bot", id: "bot" },
      sessionKey: "installation:topic",
      platformBinding: {
        platform: "lark",
        adapterId: "app",
        conversationKey: "lark:app:chat:topic",
        conversationRef: { platform: "lark", adapterId: "app", channelId: "chat" },
      },
    }
  )
  return (await getSession(turn.sessionId))!
}

it("refreshes the open pane after a background turn and preserves it on the typed follow-up", async () => {
  const session = await botTranscript()
  useChatStore.getState().setActiveSession(session.id)
  useProjectStore.setState({ activeProjectId: session.projectId ?? "workspace", loaded: true })
  const pane = renderHook(() => useSessions({ listOnly: true }))
  await waitFor(() =>
    expect(useChatStore.getState().sessions[session.id]?.messages).toHaveLength(2)
  )
  let finish!: (value: Awaited<ReturnType<typeof runAndCaptureAssistantReply>>) => void
  jest.mocked(runAndCaptureAssistantReply).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const background = botTranscript("Background material")
  await waitFor(() => expect(finish).toBeDefined())
  await act(async () => {
    finish({
      text: "Background review",
      messageId: "background-reply",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    })
    await background
  })
  await waitFor(() =>
    expect(useChatStore.getState().sessions[session.id]?.messages).toHaveLength(4)
  )
  let submitted: Promise<void> | undefined
  const onSend = jest.fn(
    () =>
      (submitted = (async () => {
        // The controller's full-transcript persistence boundary, with the real
        // pane store and real IndexedDB writer rather than a mocked save.
        const next = [
          ...useChatStore.getState().sessions[session.id]!.messages,
          {
            id: "follow-up",
            role: "user" as const,
            parts: [{ type: "text" as const, text: "Re-review this" }],
          },
        ]
        await persistMessages(session.id, next)
      })())
  )
  const view = render(
    <DataAdapterProvider
      adapter={{
        useCharacters: () => undefined,
        useCharacter: () => undefined,
        useSkillsByIds: () => undefined,
        usePresets: () => undefined,
        clearMessages: jest.fn(),
        updateSession: jest.fn(),
        recordPresetUsage: jest.fn(),
        trustWorkspace: jest.fn(),
      }}
    >
      <TooltipProvider>
        <Composer
          session={session}
          onSend={onSend}
          onStartNewSession={async () => {}}
          onOpenSettings={() => {}}
          onStop={async () => {}}
        />
      </TooltipProvider>
    </DataAdapterProvider>
  )
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Re-review this" } })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    await submitted
  })
  expect(sendManualMessageToConversation).not.toHaveBeenCalled()
  const messages = await listMessages(session.id)
  expect(messages).toHaveLength(5)
  expect(messages.map((message) => message.id)).toEqual(
    expect.arrayContaining(["background-reply", "follow-up"])
  )
  expect(messages.flatMap((message) => message.parts)).toEqual(
    expect.arrayContaining([{ type: "text", text: "Background material" }])
  )
  view.unmount()
  pane.unmount()
})

it("cannot import remote history via HistoryLoadEarlier's explicit session id", async () => {
  const session = await botTranscript()
  jest.mocked(isTauri).mockReturnValue(true)
  const { result } = renderHook(() => useHistoryHydration("lark:app:chat:topic", "app", session.id))
  let imported: number | undefined
  await act(async () => {
    imported = await result.current.hydrate()
  })
  expect(imported).toBe(0)
  expect(mockFetchHistory).not.toHaveBeenCalled()
  expect(insertInboundMessage).not.toHaveBeenCalled()
  expect(session.platformBinding).toBeUndefined() // ChatView does not mount HistoryLoadEarlier.
})

it("keeps the Bot reply alive while desktop send and regenerate are refused", async () => {
  const session = await botTranscript()
  useChatStore.getState().setActiveSession(session.id)
  useChatStore.getState().replaceSessionMessages(session.id, await listMessages(session.id))
  let finish!: (value: Awaited<ReturnType<typeof runAndCaptureAssistantReply>>) => void
  jest.mocked(runAndCaptureAssistantReply).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const background = botTranscript("Background continues")
  await waitFor(() => expect(finish).toBeDefined())
  const controller = renderHook(() => useClaudeChat())
  await waitFor(() =>
    expect(useChatStore.getState().sessions[session.id]?.status).toBe("streaming")
  )
  await act(async () => {
    await expect(
      controller.result.current.send("Desktop prompt", undefined, { sessionId: session.id })
    ).rejects.toThrow("session_turn_busy")
    await controller.result.current.regenerate(session.id)
  })
  expect(runAndCaptureAssistantReply).toHaveBeenCalledTimes(2)
  await act(async () => {
    finish({
      text: "Bot completed",
      messageId: "bot-completed",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    })
    await background
  })
  expect(
    (await listMessages(session.id)).find((message) => message.id === "bot-completed")?.parts
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "text", text: "Bot completed" })])
  )
  expect(useChatStore.getState().sessions[session.id]?.status).toBe("idle")
  controller.unmount()
})

it("keeps the Composer input and shows busy when a Bot capture refuses desktop send", async () => {
  const session = await botTranscript()
  useChatStore.getState().setActiveSession(session.id)
  useChatStore.getState().replaceSessionMessages(session.id, await listMessages(session.id))
  let finish!: (value: Awaited<ReturnType<typeof runAndCaptureAssistantReply>>) => void
  jest.mocked(runAndCaptureAssistantReply).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const background = botTranscript("Background continues")
  await waitFor(() => expect(finish).toBeDefined())
  const controller = renderHook(() => useClaudeChat())
  const warning = jest.spyOn(toast, "warning")
  const onSend = jest.fn((content: Parameters<typeof controller.result.current.send>[0]) =>
    controller.result.current.send(content, undefined, { sessionId: session.id })
  )
  const view = render(
    <DataAdapterProvider
      adapter={{
        useCharacters: () => undefined,
        useCharacter: () => undefined,
        useSkillsByIds: () => undefined,
        usePresets: () => undefined,
        clearMessages: jest.fn(),
        updateSession: jest.fn(),
        recordPresetUsage: jest.fn(),
        trustWorkspace: jest.fn(),
      }}
    >
      <TooltipProvider>
        <Composer
          session={session}
          onSend={onSend}
          onStartNewSession={async () => {}}
          onOpenSettings={() => {}}
          onStop={async () => {}}
        />
      </TooltipProvider>
    </DataAdapterProvider>
  )
  try {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep my input" } })
    fireEvent.click(screen.getByRole("button", { name: "Send as a follow-up" }))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    await act(async () => {
      await onSend.mock.results[0].value.catch(() => undefined)
    })
    expect(warning).toHaveBeenCalled()
    expect(screen.getByRole("textbox")).toHaveValue("Keep my input")
    expect(runAndCaptureAssistantReply).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(await listMessages(session.id))).not.toContain("Keep my input")
  } finally {
    await act(async () => {
      finish({
        text: "Bot completed",
        messageId: "bot-completed",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })
      await background
    })
    view.unmount()
    controller.unmount()
    warning.mockRestore()
  }
})
