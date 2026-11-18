/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({
    number: (value: number, options: { unit: string }) => `${value.toFixed(1)} ${options.unit}`,
  }),
}))

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  __resetPluginDataSnapshotSpaceRequestsForTests,
  requestPluginDataSnapshotSpaceDecision,
  type PluginDataSnapshotSpaceDecision,
} from "@/lib/plugin/dexie/snapshot-space-requests"

import { PluginDataSnapshotSpaceHost } from "./plugin-data-snapshot-space-host"

const MIB = 1024 * 1024

afterEach(() => {
  __resetPluginDataSnapshotSpaceRequestsForTests()
})

function ask(availableBytes?: number) {
  const answer: { value?: PluginDataSnapshotSpaceDecision } = {}
  act(() => {
    void requestPluginDataSnapshotSpaceDecision({
      pluginId: "acme.notes",
      fromVersion: 1,
      toVersion: 2,
      requiredBytes: 3 * MIB,
      ...(availableBytes !== undefined ? { availableBytes } : {}),
    }).then((decision) => {
      answer.value = decision
    })
  })
  return answer
}

describe("PluginDataSnapshotSpaceHost", () => {
  it("renders nothing while no migration is waiting", () => {
    const { container } = render(<PluginDataSnapshotSpaceHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it("says how much the snapshot needs, how little is free and what is lost without it", async () => {
    render(<PluginDataSnapshotSpaceHost />)
    ask(512 * 1024)
    const dialog = await screen.findByTestId("plugin-data-snapshot-space")
    expect(dialog).toHaveTextContent(
      'body:{"name":"acme.notes","from":1,"to":2,"required":"3.0 megabyte"}'
    )
    expect(dialog).toHaveTextContent('available:{"available":"512.0 kilobyte"}')
    expect(dialog).toHaveTextContent('consequence:{"to":2}')
  })

  it("says storage ran out when IndexedDB refused the copy", async () => {
    render(<PluginDataSnapshotSpaceHost />)
    ask()
    expect(await screen.findByTestId("plugin-data-snapshot-space")).toHaveTextContent("ranOut")
  })

  it("gives up the snapshot only when the user chooses to", async () => {
    render(<PluginDataSnapshotSpaceHost />)
    const answer = ask(0)
    await userEvent.click(await screen.findByRole("button", { name: "continue" }))
    await act(async () => {})
    expect(answer.value).toBe("continue-without-snapshot")
  })

  it("cancels the upgrade on Cancel, and when dismissed", async () => {
    render(<PluginDataSnapshotSpaceHost />)
    const cancelled = ask(0)
    await userEvent.click(await screen.findByRole("button", { name: "cancel" }))
    await act(async () => {})
    expect(cancelled.value).toBe("cancel")

    const dismissed = ask(0)
    await screen.findByTestId("plugin-data-snapshot-space")
    await userEvent.keyboard("{Escape}")
    await act(async () => {})
    expect(dismissed.value).toBe("cancel")
  })
})
