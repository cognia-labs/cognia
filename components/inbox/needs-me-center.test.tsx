/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NeedsMeCenter } from "./needs-me-center"
import { usePersonalResponsibilities } from "@/hooks/inbox/use-personal-responsibilities"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
import { decideRadarSuggestion } from "@/lib/radar/suggestions"
import { respondRunApproval } from "@/lib/execution/run-approvals"

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("./draft-editor", () => ({
  DraftEditor: ({ draft }: { draft: { id: string } }) => (
    <div data-testid={`stub-draft-editor-${draft.id}`} />
  ),
}))
jest.mock("@/hooks/inbox/use-personal-responsibilities", () => ({
  usePersonalResponsibilities: jest.fn(),
}))
jest.mock("@/lib/connectors/inbox-writes", () => ({
  mutateConversationOverride: jest.fn(async () => undefined),
}))
jest.mock("@/lib/radar/suggestions", () => ({
  decideRadarSuggestion: jest.fn(async () => ({ status: "accepted" })),
}))
jest.mock("@/lib/execution/run-approvals", () => ({
  respondRunApproval: jest.fn(async () => ({ ok: true, status: "approved" })),
}))

const mockHook = usePersonalResponsibilities as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

describe("NeedsMeCenter (F10)", () => {
  it("renders the empty state when nothing requires operator action", () => {
    mockHook.mockReturnValue({
      loading: false,
      items: [],
      countsByKind: {
        outbound_draft: 0,
        hitl_approval: 0,
        sla_overdue: 0,
        blocked_commitment: 0,
        radar_suggestion: 0,
      },
    })
    render(<NeedsMeCenter />)
    expect(screen.getByTestId("needs-me-empty")).toBeInTheDocument()
  })

  it("filters across responsibility categories and executes inline HITL, SLA, and Radar actions", async () => {
    mockHook.mockReturnValue({
      loading: false,
      items: [
        {
          id: "hitl:int_1",
          kind: "hitl_approval",
          priority: "urgent",
          title: "Send email to partner",
          createdAt: 10,
          attention: {
            id: "run:int_1",
            source: "run",
            kind: "run-approval",
            title: "Send email to partner",
            openedAt: 10,
            stale: false,
            interrupt: { id: "int_1", runId: "run_1", type: "tool_approval", status: "pending" },
          },
        },
        {
          id: "sla:lark:b1:c1",
          kind: "sla_overdue",
          priority: "urgent",
          title: "Escalated VIP thread",
          createdAt: 20,
          dueAt: 5,
          overdueMinutes: 15,
          conversationKey: "lark:b1:c1",
          sessionId: "s1",
          override: { id: "co1", conversationKey: "lark:b1:c1", sessionId: "s1" },
        },
        {
          id: "radar:r1:action:0",
          kind: "radar_suggestion",
          priority: "normal",
          title: "Follow up Q4 pricing",
          createdAt: 30,
          radar: {
            reportId: "r1",
            generatedAt: 30,
            suggestionId: "r1:action:0",
            actionIndex: 0,
            text: "Follow up Q4 pricing",
            verdict: "Pricing thread stalled",
          },
        },
      ],
      countsByKind: {
        outbound_draft: 0,
        hitl_approval: 1,
        sla_overdue: 1,
        blocked_commitment: 0,
        radar_suggestion: 1,
      },
    })

    render(<NeedsMeCenter />)
    expect(screen.getByTestId("needs-me-total-badge")).toHaveTextContent("3")

    fireEvent.click(screen.getByTestId("needs-me-approve-hitl:int_1"))
    await waitFor(() =>
      expect(respondRunApproval).toHaveBeenCalledWith(
        expect.objectContaining({ interruptId: "int_1", decision: "approve" })
      )
    )

    fireEvent.click(screen.getByTestId("needs-me-resolve-sla-sla:lark:b1:c1"))
    await waitFor(() =>
      expect(mutateConversationOverride).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "upsert",
          input: expect.objectContaining({
            conversationKey: "lark:b1:c1",
            status: "resolved",
          }),
        })
      )
    )

    fireEvent.click(screen.getByTestId("needs-me-filter-radar_suggestion"))
    expect(screen.queryByText("Escalated VIP thread")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("needs-me-accept-radar-radar:r1:action:0"))
    await waitFor(() =>
      expect(decideRadarSuggestion).toHaveBeenCalledWith("r1", "r1:action:0", "accepted")
    )
  })
})
