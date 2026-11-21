/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PersonalSourcesTab } from "./personal-sources-tab"

const mockProbeAll = jest.fn()
const mockProbeOne = jest.fn()
const mockUpsertMcp = jest.fn()
const mockFindMcp = jest.fn()
const mockSetEnabled = jest.fn()

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

jest.mock("@/lib/integrations/personal-sources/health-probe", () => ({
  probeAllPersonalDataSources: (...args: unknown[]) => mockProbeAll(...args),
  probePersonalDataSource: (...args: unknown[]) => mockProbeOne(...args),
}))

jest.mock("@/lib/integrations/personal-sources/presets", () => {
  const actual = jest.requireActual("@/lib/integrations/personal-sources/presets")
  return {
    ...actual,
    findPersonalSourceMcpServer: (...args: unknown[]) => mockFindMcp(...args),
    upsertPersonalSourceMcpServer: (...args: unknown[]) => mockUpsertMcp(...args),
    setPersonalSourceEnabled: (...args: unknown[]) => mockSetEnabled(...args),
  }
})

beforeEach(() => {
  jest.clearAllMocks()
  mockFindMcp.mockResolvedValue(undefined)
  mockProbeAll.mockResolvedValue({
    lark: { sourceId: "lark", status: "ready", detectedVersion: "1.0.98", checkedAt: 1 },
    gmail: { sourceId: "gmail", status: "unconfigured", checkedAt: 1 },
    "google-calendar": { sourceId: "google-calendar", status: "unconfigured", checkedAt: 1 },
    outlook: { sourceId: "outlook", status: "reauth_required", detail: "HTTP_401", checkedAt: 1 },
  })
  mockProbeOne.mockResolvedValue({
    sourceId: "gmail",
    status: "ready",
    serverId: "mcp_gmail",
    checkedAt: 2,
  })
  mockUpsertMcp.mockResolvedValue({ id: "mcp_gmail", enabled: true })
})

describe("PersonalSourcesTab (F7)", () => {
  it("renders all four personal data source cards with probed health statuses and saves Gmail MCP credentials", async () => {
    render(<PersonalSourcesTab hostAvailable />)

    await waitFor(() => {
      expect(screen.getByTestId("personal-source-status-lark")).toHaveAttribute(
        "data-status",
        "ready"
      )
    })
    expect(screen.getByTestId("personal-source-status-gmail")).toHaveAttribute(
      "data-status",
      "unconfigured"
    )
    expect(screen.getByTestId("personal-source-status-outlook")).toHaveAttribute(
      "data-status",
      "reauth_required"
    )

    fireEvent.change(screen.getByTestId("personal-source-secret-gmail"), {
      target: { value: "gmail-secret-123" },
    })
    fireEvent.click(screen.getByTestId("personal-source-save-gmail"))

    await waitFor(() => {
      expect(mockUpsertMcp).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: "gmail",
          command: "npx",
          args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
          secretValue: "gmail-secret-123",
          enabled: true,
        })
      )
    })
    await waitFor(() => {
      expect(screen.getByTestId("personal-source-status-gmail")).toHaveAttribute(
        "data-status",
        "ready"
      )
    })
  })

  it("shows the host-required notice and disables mutations when hostAvailable is false", async () => {
    mockProbeAll.mockResolvedValue({
      lark: { sourceId: "lark", status: "desktop_required", checkedAt: 1 },
      gmail: { sourceId: "gmail", status: "desktop_required", checkedAt: 1 },
      "google-calendar": { sourceId: "google-calendar", status: "desktop_required", checkedAt: 1 },
      outlook: { sourceId: "outlook", status: "desktop_required", checkedAt: 1 },
    })
    render(<PersonalSourcesTab hostAvailable={false} />)
    expect(await screen.findByTestId("personal-sources-host-required")).toBeInTheDocument()
    expect(screen.getByTestId("personal-source-save-gmail")).toBeDisabled()
  })
})
