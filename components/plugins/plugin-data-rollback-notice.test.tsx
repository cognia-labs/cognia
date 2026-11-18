/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({ dateTime: (d: Date) => `fmt:${d.toISOString()}` }),
}))

import { render, screen } from "@testing-library/react"

import type { PluginDataRollback } from "@/lib/plugin/dexie/data-rollback"
import { PluginDataRollbackHint, PluginDataRollbackNotice } from "./plugin-data-rollback-notice"

const restore: PluginDataRollback = {
  kind: "restore",
  snapshotId: "s1",
  capturedAt: Date.parse("2026-11-01T09:30:00.000Z"),
  dataVersion: 1,
  currentDataVersion: 2,
  currentRows: 12,
  snapshotRows: 10,
}
const unavailable: PluginDataRollback = {
  kind: "unavailable",
  currentDataVersion: 3,
  targetDataVersion: 1,
}

describe("PluginDataRollbackNotice", () => {
  it("says nothing when the data stays as it is, or before it is known", () => {
    const { container, rerender } = render(
      <PluginDataRollbackNotice data={{ kind: "none" }} name="Notes" version="1.0.0" />
    )
    expect(container).toBeEmptyDOMElement()
    rerender(<PluginDataRollbackNotice data={null} name="Notes" version="1.0.0" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("names the snapshot date and both record counts before a restore", () => {
    render(<PluginDataRollbackNotice data={restore} name="Notes" version="1.0.0" />)
    expect(screen.getByTestId("plugin-data-rollback-restore")).toHaveTextContent(
      'restore:{"name":"Notes","date":"fmt:2026-11-01T09:30:00.000Z","currentRows":12,"snapshotRows":10}'
    )
  })

  it("explains a refusal as an alert", () => {
    render(<PluginDataRollbackNotice data={unavailable} name="Notes" version="1.0.0" />)
    expect(screen.getByRole("alert")).toHaveTextContent(
      'unavailable:{"name":"Notes","version":"1.0.0","current":3}'
    )
  })

  it("says when the effect on the data could not be checked", () => {
    render(<PluginDataRollbackNotice data={null} checkFailed name="Notes" version="1.0.0" />)
    expect(screen.getByRole("alert")).toHaveTextContent("checkFailed")
  })
})

describe("PluginDataRollbackHint", () => {
  it("is one line per outcome, and nothing for none", () => {
    const { container, rerender } = render(<PluginDataRollbackHint data={{ kind: "none" }} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<PluginDataRollbackHint data={restore} />)
    expect(container).toHaveTextContent('rowRestore:{"date":"fmt:2026-11-01T09:30:00.000Z"}')
    rerender(<PluginDataRollbackHint data={unavailable} />)
    expect(container).toHaveTextContent("rowUnavailable")
  })
})
