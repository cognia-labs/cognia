import { fireEvent, render, screen } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"

import { PlatformComposerHeader } from "./platform-composer-header"

jest.mock("@/components/inbox/platform-badge", () => ({
  PlatformBadge: ({ platform }: { platform: string }) => (
    <span data-testid="badge">{platform}</span>
  ),
}))
jest.mock("./platform-reply-assistance", () => ({
  PlatformReplyAssistance: () => <span data-testid="assist" />,
}))
jest.mock("@/components/inbox/canned-response-picker", () => ({
  CannedResponsePicker: ({ conversationKey }: { conversationKey: string }) => (
    <span data-testid="canned">{conversationKey}</span>
  ),
}))
const actionsHost = jest.fn()
jest.mock("@/components/inbox/inbox-composer-actions-host", () => ({
  InboxComposerActionsHost: (props: Record<string, unknown>) => {
    actionsHost(props)
    return null
  },
}))

const binding = { platform: "lark", conversationKey: "oc_1", adapterId: "lark-1" }
const session = { id: "s1", title: "Ops room", platformBinding: binding } as unknown as ChatSession

it("names the destination and wires the IM tools to this conversation", () => {
  const onReviewDrafts = jest.fn()
  render(
    <PlatformComposerHeader
      session={session}
      binding={binding as NonNullable<ChatSession["platformBinding"]>}
      pendingDraftCount={2}
      onReviewDrafts={onReviewDrafts}
    />
  )

  expect(screen.getByTestId("badge")).toHaveTextContent("lark")
  expect(screen.getByText(/Ops room/)).toBeInTheDocument()
  expect(screen.getByTestId("canned")).toHaveTextContent("oc_1")
  expect(actionsHost).toHaveBeenCalledWith(
    expect.objectContaining({ conversationKey: "oc_1", adapterId: "lark-1", sessionId: "s1" })
  )

  fireEvent.click(screen.getByRole("button"))
  expect(onReviewDrafts).toHaveBeenCalled()
})
