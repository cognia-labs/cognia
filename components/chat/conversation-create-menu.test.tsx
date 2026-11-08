import "@/components/interactions/test-pointer-polyfill"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ConversationCreateMenu } from "./conversation-create-menu"
import { openAcceptedSharedSession } from "@/lib/collab/open-shared-session"

let mockAvailability: Record<string, unknown> = { state: "available" }
const mockAccept = jest.fn()
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/hooks/collab/use-shared-chat-enabled", () => ({
  useSharedChatAvailability: () => mockAvailability,
  useSharedChatEnabled: () => mockAvailability.state === "available",
}))
jest.mock("@/components/shell/use-shell-nav", () => ({
  useShellNav: () => ({ switchToDm: jest.fn() }),
}))
jest.mock("@/lib/collab/runtime-client", () => ({
  resolveCurrentCollabContext: async () => ({
    orgId: "org",
    client: { acceptSessionInvite: mockAccept },
  }),
}))
jest.mock("@/lib/collab/open-shared-session", () => ({
  openAcceptedSharedSession: jest.fn(async () => {}),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

beforeEach(() => {
  jest.clearAllMocks()
  mockAvailability = { state: "available" }
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  mockAccept.mockResolvedValue({ invite: { sessionId: "shared" } })
})

function renderMenu() {
  const onNewConversation = jest.fn()
  render(
    <ConversationCreateMenu onNewConversation={onNewConversation} newConversationLabel="New chat">
      <button type="button">Create</button>
    </ConversationCreateMenu>
  )
  return { onNewConversation, user: userEvent.setup() }
}

it("creates a conversation only after choosing New chat", async () => {
  const { user, onNewConversation } = renderMenu()
  await user.click(screen.getByRole("button", { name: "Create" }))
  expect(onNewConversation).not.toHaveBeenCalled()
  expect(screen.getByRole("menuitem", { name: "joinViaInvite" })).toBeInTheDocument()
  await user.click(screen.getByRole("menuitem", { name: "New chat" }))
  expect(onNewConversation).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
})

it("opens the invitation dialog after the menu closes and returns focus to +", async () => {
  const { user } = renderMenu()
  const trigger = screen.getByRole("button", { name: "Create" })
  await user.click(trigger)
  await user.click(screen.getByRole("menuitem", { name: "joinViaInvite" }))
  expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  expect(screen.getByRole("dialog", { name: "acceptInvite" })).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole("textbox", { name: "inviteToken" })).toHaveFocus())
  await user.keyboard("{Escape}")
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
})

it("keeps the dialog mounted while accepting an invite from the menu", async () => {
  const { user, onNewConversation } = renderMenu()
  await user.click(screen.getByRole("button", { name: "Create" }))
  await user.click(screen.getByRole("menuitem", { name: "joinViaInvite" }))
  await user.type(screen.getByRole("textbox", { name: "inviteToken" }), " cit_example ")
  await user.click(screen.getByRole("button", { name: "acceptInvite" }))
  await waitFor(() =>
    expect(openAcceptedSharedSession).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org", sharedSessionId: "shared" })
    )
  )
  expect(mockAccept).toHaveBeenCalledWith("org", "cit_example")
  expect(onNewConversation).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
})

it("keeps the invitation action, inert and with the reason, when shared chat is not offered", async () => {
  mockAvailability = { state: "unavailable", reason: "no_server", accountId: "a", checkedAt: 0 }
  const { user, onNewConversation } = renderMenu()
  await user.click(screen.getByRole("button", { name: "Create" }))
  const join = screen.getByTestId("conversation-create-join")
  expect(join).toHaveAttribute("aria-disabled", "true")
  expect(screen.getByTestId("conversation-create-join-reason")).toHaveTextContent(
    "unavailable.no_server"
  )
  await user.click(join)
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  await user.click(screen.getByRole("menuitem", { name: "New chat" }))
  expect(onNewConversation).toHaveBeenCalledTimes(1)
})

it("says it is still checking before the first answer", async () => {
  mockAvailability = { state: "checking" }
  const { user } = renderMenu()
  await user.click(screen.getByRole("button", { name: "Create" }))
  expect(screen.getByTestId("conversation-create-join")).toHaveAttribute("aria-disabled", "true")
  expect(screen.getByTestId("conversation-create-join-reason")).toHaveTextContent(
    "availability.checking"
  )
})
