/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({ dateTime: (d: Date) => `fmt:${d.toISOString()}` }),
}))

const mockSnapshots = jest.fn()
jest.mock("@/hooks/plugins/use-plugin-data-snapshots", () => ({
  usePluginDataSnapshots: (pluginId: string, enabled: boolean) => mockSnapshots(pluginId, enabled),
}))
const mockMirrored = jest.fn(() => false)
jest.mock("@/lib/plugin/core/mirrored-client", () => ({
  isMirroredPluginClient: () => mockMirrored(),
}))

import { render, screen } from "@testing-library/react"

import { PluginDataSnapshots } from "./plugin-data-snapshots"

beforeEach(() => {
  mockMirrored.mockReturnValue(false)
  mockSnapshots.mockReset().mockReturnValue({ records: [], error: null })
})

describe("PluginDataSnapshots", () => {
  it("lists captured snapshots and marks the data versions that have none", () => {
    mockSnapshots.mockReturnValue({
      records: [
        {
          kind: "skipped",
          id: "k",
          pluginId: "notes",
          dataVersion: 2,
          migratedTo: 3,
          createdAt: Date.parse("2026-11-10T00:00:00.000Z"),
          reason: "insufficient-space",
        },
        {
          kind: "captured",
          id: "c",
          pluginId: "notes",
          dataVersion: 1,
          migratedTo: 2,
          createdAt: Date.parse("2026-11-01T00:00:00.000Z"),
          tables: [],
          rows: 42,
          bytes: 1,
        },
      ],
      error: null,
    })
    render(<PluginDataSnapshots pluginId="notes" />)
    expect(mockSnapshots).toHaveBeenCalledWith("notes", true)
    expect(screen.getByTestId("plugin-data-snapshot-skipped")).toHaveTextContent(
      'skipped:{"from":2,"to":3,"date":"fmt:2026-11-10T00:00:00.000Z"}'
    )
    expect(
      screen.getByText('captured:{"from":1,"to":2,"rows":42,"date":"fmt:2026-11-01T00:00:00.000Z"}')
    ).toBeInTheDocument()
  })

  it("says when there are none", () => {
    render(<PluginDataSnapshots pluginId="notes" />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("says when they could not be read", () => {
    mockSnapshots.mockReturnValue({ records: null, error: "closed" })
    render(<PluginDataSnapshots pluginId="notes" />)
    expect(screen.getByRole("alert")).toHaveTextContent("loadFailed")
  })

  it("lists nothing on a mirrored client, which keeps no plugin data", () => {
    mockMirrored.mockReturnValue(true)
    const { container } = render(<PluginDataSnapshots pluginId="notes" />)
    expect(container).toBeEmptyDOMElement()
    expect(mockSnapshots).toHaveBeenCalledWith("notes", false)
  })
})
