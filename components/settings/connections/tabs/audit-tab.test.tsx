/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AuditEntry } from "@/types/connectors/audit"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

const mockAdapters: Partial<AdapterInstanceRow>[] = [
  { id: "a1", displayName: "Telegram Bot", type: "telegram" },
  { id: "a2", displayName: "Discord Bot", type: "discord" },
]

const mockAuditEntries: Partial<AuditEntry>[] = [
  {
    id: "e1",
    adapterId: "a1",
    kind: "delivery.success",
    at: Date.now() - 1000,
    reason: "OK",
    conversationKey: "telegram:a1:12345",
    fields: { messageId: "123" },
  },
  {
    id: "e2",
    adapterId: "a2",
    kind: "delivery.error",
    at: Date.now() - 2000,
    reason: "Timeout",
    conversationKey: "discord:a2:99999",
  },
  {
    id: "e3",
    adapterId: "a1",
    kind: "adapter.started",
    at: Date.now() - 3000,
  },
  // Heartbeats — must be excluded by the default view (no selectedKinds)
  // per `types/connectors/audit.ts`'s "noisy by design" contract. Toggling
  // them on (impossible via the UI because the kind has no chip) would be
  // a separate scenario.
  {
    id: "h1",
    adapterId: "a1",
    kind: "adapter.heartbeat",
    at: Date.now() - 500,
  },
  {
    id: "h2",
    adapterId: "a2",
    kind: "adapter.heartbeat",
    at: Date.now() - 600,
  },
]

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

import { useLiveQuery } from "dexie-react-hooks"
const mockUseLiveQuery = useLiveQuery as jest.MockedFunction<typeof useLiveQuery>

import { AuditTab } from "./audit-tab"

let callCount = 0

beforeEach(() => {
  jest.clearAllMocks()
  callCount = 0
  // First call = adapters, second call = audit entries
  mockUseLiveQuery.mockImplementation((() => {
    callCount++
    if (callCount % 2 === 1) return mockAdapters as unknown
    return mockAuditEntries as unknown
  }) as typeof useLiveQuery)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuditTab", () => {
  it("filters protection events and counts only the current audit view", () => {
    const entries = [
      ...mockAuditEntries,
      {
        id: "protected",
        adapterId: "a1",
        kind: "inbound.policy_blocked",
        reason: "content_safety_blocked",
        at: Date.now(),
        fields: { reasonCodes: ["instruction_override"] },
      },
    ]
    let query = 0
    mockUseLiveQuery.mockImplementation((() =>
      ++query % 2 === 1 ? mockAdapters : entries) as typeof useLiveQuery)
    render(<AuditTab />)
    expect(screen.getByText(/1 protection event/i)).toBeInTheDocument()
    expect(screen.getByText("Content protection blocked")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: "Content protection only" }))
    expect(screen.queryByText("Timeout")).not.toBeInTheDocument()
    expect(screen.getByText("Content protection blocked")).toBeInTheDocument()
  })
  it("renders the redaction reminder banner", () => {
    render(<AuditTab />)
    expect(screen.getByText(/allowlist-redacted/i)).toBeInTheDocument()
    expect(screen.getByText(/tokens and message bodies never appear/i)).toBeInTheDocument()
  })

  it("keeps adapter choices in a checkbox dropdown", async () => {
    const user = userEvent.setup()
    render(<AuditTab />)
    expect(screen.queryByRole("menuitemcheckbox")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Adapters" }))
    expect(
      screen.getByRole("menuitemcheckbox", { name: /filter by adapter telegram bot/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("menuitemcheckbox", { name: /filter by adapter discord bot/i })
    ).toBeInTheDocument()
  })

  it("supports multiple event-type checkboxes and resets the active filters", async () => {
    const user = userEvent.setup()
    render(<AuditTab />)
    await user.click(screen.getByRole("button", { name: "Event types" }))
    const delivered = screen.getByRole("menuitemcheckbox", { name: /filter by delivered/i })
    await user.click(delivered)
    expect(delivered).toBeChecked()
    await user.click(screen.getByRole("menuitemcheckbox", { name: /filter by delivery failed/i }))
    expect(screen.getByRole("menuitemcheckbox", { name: /filter by delivered/i })).toBeChecked()
    expect(
      screen.getByRole("menuitemcheckbox", { name: /filter by delivery failed/i })
    ).toBeChecked()
    await user.keyboard("{Escape}")
    expect(screen.getByRole("button", { name: "Event types" })).toHaveTextContent("2 selected")
    expect(screen.getByTestId("audit-export-trigger")).toHaveTextContent("2")
    await user.click(screen.getByRole("button", { name: "Reset filters" }))
    expect(screen.getByTestId("audit-export-trigger")).toHaveTextContent("3")
  })

  it("uses a single-select dropdown for the time range", async () => {
    const user = userEvent.setup()
    render(<AuditTab />)
    const range = screen.getByRole("combobox", { name: "Time range" })
    expect(range).toHaveTextContent("Last 24h")
    await user.click(range)
    expect(screen.getByRole("option", { name: "Last hour" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "All" })).toBeInTheDocument()
    await user.click(screen.getByRole("option", { name: "Last 7d" }))
    expect(range).toHaveTextContent("Last 7d")
  })

  it("renders all audit entries by default (humanized kind labels)", () => {
    render(<AuditTab />)
    expect(screen.getAllByText("Delivered")).toHaveLength(1)
    expect(screen.getAllByText("Delivery failed")).toHaveLength(1)
    expect(screen.getAllByText("Adapter started")).toHaveLength(1)
  })

  it("shows empty state when no entries match filters", () => {
    callCount = 0
    mockUseLiveQuery.mockImplementation((() => {
      callCount++
      if (callCount === 1) return [] as unknown
      return [] as unknown
    }) as typeof useLiveQuery)
    render(<AuditTab />)
    expect(screen.getByText(/no audit entries match/i)).toBeInTheDocument()
  })

  it("expands a row into its conversation key and fields", async () => {
    render(<AuditTab />)
    // e1 (fields + key) and e2 (key only) are expandable; e3 has neither.
    const rows = screen.getAllByRole("button", { name: "Expand audit entry" })
    expect(rows).toHaveLength(2)
    expect(screen.queryByText("messageId")).not.toBeInTheDocument()
    fireEvent.click(rows[0])
    await waitFor(() => {
      expect(screen.getByText("messageId")).toBeInTheDocument()
    })
    expect(screen.getByText("123")).toBeInTheDocument()
    expect(screen.getByText("telegram:a1:12345")).toBeInTheDocument()
    expect(rows[0]).toHaveAttribute("aria-expanded", "true")
    expect(rows[0]).toHaveAccessibleName("Collapse audit entry")
  })

  it("summarizes the visible entries and the event-type selection", async () => {
    const user = userEvent.setup()
    render(<AuditTab />)
    expect(screen.getByText("3 entries")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Event types" }))
    await user.click(screen.getByRole("menuitemcheckbox", { name: /filter by delivered/i }))
    await user.keyboard("{Escape}")
    // One kind reads as its label, not "1 selected".
    expect(screen.getByRole("button", { name: "Event types" })).toHaveTextContent("Delivered")
    // The shared next-intl mock resolves `=N` and `other` plural branches only.
    expect(screen.getByText(/^1 entr(y|ies)$/)).toBeInTheDocument()
  })

  it("hides the adapter filter and column when scoped to one adapter", () => {
    render(<AuditTab adapterId="a1" />)
    expect(screen.queryByRole("button", { name: "Adapters" })).not.toBeInTheDocument()
    expect(screen.queryByText("Telegram Bot")).not.toBeInTheDocument()
    expect(screen.getAllByText("Delivered")).toHaveLength(1)
    expect(screen.queryByText("Delivery failed")).not.toBeInTheDocument()
  })

  it("offers a reset from the empty state when filters hide everything", async () => {
    render(<AuditTab />)
    fireEvent.change(screen.getByTestId("audit-conv-key-input"), {
      target: { value: "no-match-at-all-zzz" },
    })
    expect(await screen.findByText(/no audit entries match/i)).toBeInTheDocument()
    const resets = screen.getAllByRole("button", { name: "Reset filters" })
    fireEvent.click(resets[resets.length - 1])
    await waitFor(() => expect(screen.getByText("3 entries")).toBeInTheDocument())
  })

  it("filters by conversationKey substring (case-insensitive)", async () => {
    render(<AuditTab />)
    const input = screen.getByTestId("audit-conv-key-input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "TELEGRAM:A1" } })
    await waitFor(() => {
      expect(screen.getAllByText("Delivered")).toHaveLength(1)
      expect(screen.queryByText("Delivery failed")).not.toBeInTheDocument()
    })
  })

  it("renders an Export trigger that disables when no entries are visible", async () => {
    render(<AuditTab />)
    const trigger = screen.getByTestId("audit-export-trigger")
    expect(trigger).toBeEnabled()
    // Drive an impossible filter to empty the list.
    const input = screen.getByTestId("audit-conv-key-input")
    fireEvent.change(input, { target: { value: "no-match-at-all-zzz" } })
    await waitFor(() => {
      expect(screen.getByTestId("audit-export-trigger")).toBeDisabled()
    })
  })

  it("renders the Export trigger with the visible-row count", () => {
    render(<AuditTab />)
    const trigger = screen.getByTestId("audit-export-trigger")
    // mockAuditEntries has 3 non-heartbeat rows + 2 heartbeats; the
    // default view hides heartbeats, so the visible count is 3.
    expect(trigger.textContent).toMatch(/3/)
  })

  it("hides adapter.heartbeat rows from the default view (noisy by design)", () => {
    render(<AuditTab />)
    // Heartbeats are present in the dataset (2 rows) but must not appear as
    // entry badges with the default (empty) `selectedKinds`. The kind filter
    // UI also intentionally has no `adapter.heartbeat` chip, so the only
    // occurrence we'd expect is in the badge for an actual entry row — and
    // that should be zero.
    expect(screen.queryByText("adapter.heartbeat")).toBeNull()
    expect(screen.queryByText("Heartbeat")).toBeNull()
    // Sanity check: non-heartbeat entries still render their badges.
    expect(screen.getAllByText("Delivered")).toHaveLength(1)
  })
})
