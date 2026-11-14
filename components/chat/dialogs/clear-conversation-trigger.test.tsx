// Coverage for the header's clear-conversation trigger: gating on
// session/messages, the confirm→clear flow, and error handling.

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import type { UIMessage } from "ai"
import { toast } from "sonner"

import { ClearConversationTrigger } from "./clear-conversation-trigger"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useChatStore } from "@/stores/chat"
import {
  clearMessages as clearStoredMessages,
  listMessages,
  persistMessages,
} from "@/lib/db/messages"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { invalidateTranscriptRuntime } from "@/lib/chat/transcript/revision-events"

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

jest.mock("@/lib/chat/transcript/revision-events", () => ({
  ...jest.requireActual("@/lib/chat/transcript/revision-events"),
  invalidateTranscriptRuntime: jest.fn(async () => {}),
}))

function makeAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
  return {
    useCharacters: () => [],
    useCharacter: () => undefined,
    useSkillsByIds: () => [],
    usePresets: () => [],
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
    ...overrides,
  }
}

// TooltipProvider is mounted app-wide in app/layout.tsx; the trigger's
// TooltipIconButton needs it present in tests too.
function withAdapter(adapter: DataAdapter) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={adapter}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
  Wrapper.displayName = "ClearTriggerTestWrapper"
  return Wrapper
}

const userMsg = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }],
})

beforeEach(() => {
  useChatStore.getState().clear()
  useChatStore.getState().setActiveSession("ses_1")
  act(() => {
    useChatStore.getState().replaceMessages([userMsg("m1")])
  })
})

describe("ClearConversationTrigger", () => {
  it("renders nothing when there are no messages", () => {
    act(() => {
      useChatStore.getState().replaceMessages([])
    })
    const { container } = render(
      <DataAdapterProvider adapter={makeAdapter()}>
        <ClearConversationTrigger />
      </DataAdapterProvider>
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing when there is no active session", () => {
    act(() => {
      useChatStore.getState().setActiveSession(null)
    })
    const { container } = render(
      <DataAdapterProvider adapter={makeAdapter()}>
        <ClearConversationTrigger />
      </DataAdapterProvider>
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders a labeled outline button for the sheet variant and still opens the confirm dialog", async () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <ClearConversationTrigger variant="labeled" className="w-full" />
      </Wrapper>
    )
    const trigger = screen.getByRole("button", { name: /clear/i })
    expect(trigger).toHaveClass("w-full")
    expect(trigger).toHaveTextContent(/clear/i)
    fireEvent.click(trigger)
    expect(await screen.findByRole("button", { name: /delete messages/i })).toBeInTheDocument()
  })

  it("confirms then calls adapter.clearMessages with the active sessionId", async () => {
    const clearMessages = jest.fn(async () => undefined)
    const Wrapper = withAdapter(makeAdapter({ clearMessages }))
    render(
      <Wrapper>
        <ClearConversationTrigger />
      </Wrapper>
    )

    fireEvent.click(screen.getByRole("button", { name: /clear/i }))
    const confirm = await screen.findByRole("button", { name: /delete messages/i })
    await act(async () => {
      fireEvent.click(confirm)
    })

    await waitFor(() => expect(clearMessages).toHaveBeenCalledWith("ses_1"))
    expect(useChatStore.getState().messages).toEqual([])
    expect(toast.success).toHaveBeenCalledWith("Conversation cleared.")
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("surfaces clear errors without crashing", async () => {
    const clearMessages = jest.fn(async () => {
      throw new Error("boom")
    })
    const Wrapper = withAdapter(makeAdapter({ clearMessages }))
    render(
      <Wrapper>
        <ClearConversationTrigger />
      </Wrapper>
    )
    fireEvent.click(screen.getByRole("button", { name: /clear/i }))
    const confirm = await screen.findByRole("button", { name: /delete messages/i })
    await act(async () => {
      fireEvent.click(confirm)
    })
    await waitFor(() => expect(clearMessages).toHaveBeenCalled())
    expect(useChatStore.getState().messages).toEqual([userMsg("m1")])
    expect(toast.error).toHaveBeenCalledWith("boom")
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("handles a non-Error clear rejection without crashing", async () => {
    const clearMessages = jest.fn(async () => {
      throw "string failure"
    })
    const Wrapper = withAdapter(makeAdapter({ clearMessages }))
    render(
      <Wrapper>
        <ClearConversationTrigger />
      </Wrapper>
    )
    fireEvent.click(screen.getByRole("button", { name: /clear/i }))
    const confirm = await screen.findByRole("button", { name: /delete messages/i })
    await act(async () => {
      fireEvent.click(confirm)
    })
    await waitFor(() => expect(clearMessages).toHaveBeenCalled())
  })

  describe("aside retirement failure", () => {
    const dbFixture = createDbTestFixture()
    beforeAll(dbFixture.initialize)
    afterAll(dbFixture.dispose)

    it("replaces store messages and shows success after the parent clear commits", async () => {
      await getDb().sessions.bulkPut([
        { id: "ses_1", title: "Parent", createdAt: 1, updatedAt: 1 },
        {
          id: "broken-aside",
          title: "Aside",
          kind: "resource-workbench",
          surfaceBinding: { kind: "session", sessionId: "ses_1" },
          surfaceBindingKey: "session:ses_1",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      await persistMessages("ses_1", [userMsg("m1")])
      jest.mocked(invalidateTranscriptRuntime).mockImplementation(async (id) => {
        if (id === "broken-aside") throw new Error("close failed")
      })
      try {
        const user = userEvent.setup()
        const Wrapper = withAdapter(makeAdapter({ clearMessages: clearStoredMessages }))
        render(
          <Wrapper>
            <ClearConversationTrigger />
          </Wrapper>
        )
        await user.click(screen.getByRole("button", { name: /clear/i }))
        await user.click(await screen.findByRole("button", { name: /delete messages/i }))

        await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Conversation cleared."))
        expect(useChatStore.getState().messages).toEqual([])
        expect(await listMessages("ses_1")).toEqual([])
        expect(invalidateTranscriptRuntime).toHaveBeenCalledWith("broken-aside")
        expect(toast.error).not.toHaveBeenCalled()
      } finally {
        jest.mocked(invalidateTranscriptRuntime).mockResolvedValue(undefined)
      }
    })
  })
})
