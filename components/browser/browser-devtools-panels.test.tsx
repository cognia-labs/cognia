/**
 * @jest-environment jsdom
 */
import { fireEvent, render as renderUi, screen } from "@testing-library/react"
import zh from "@/i18n/messages/zh-CN/browser.json"
import { appendRing } from "@/hooks/browser/use-browser-devtools"

import { BrowserConsolePanel, BrowserNetworkPanel } from "./browser-devtools-panels"

const intl = jest.requireMock<typeof import("next-intl")>("next-intl")

function render(ui: React.ReactNode, locale: "en" | "zh-CN" = "en") {
  // Translation I/O is stubbed here; real next-intl locale rendering is also
  // exercised by the actual Chromium fixture.
  if (locale === "zh-CN")
    jest
      .spyOn(intl, "useTranslations")
      .mockReturnValue(((key: keyof typeof zh.devtools, values?: { count: number }) =>
        zh.devtools[key].replace("{count}", String(values?.count))) as ReturnType<
        typeof intl.useTranslations
      >)
  return renderUi(ui)
}

afterEach(() => jest.restoreAllMocks())

const consoleEntries = [
  { level: "log" as const, text: "hello", ts: 1 },
  { level: "error" as const, text: "boom", ts: 2 },
]
const network = [
  { url: "https://x/ok", method: "GET", status: 200, ok: true, durationMs: 12 },
  { url: "https://x/bad", method: "POST", status: 503, ok: false, durationMs: null },
]

describe("BrowserConsolePanel (ADR-0127)", () => {
  it("localizes loss and clipping notices in Chinese", () => {
    render(
      <BrowserConsolePanel
        entries={[{ ...consoleEntries[0], droppedBefore: 5, truncated: true }]}
        onClear={jest.fn()}
      />,
      "zh-CN"
    )
    expect(screen.getByRole("status")).toHaveTextContent("已丢弃 5 条较早的记录。")
    expect(screen.getByText("已截断")).toBeVisible()
  })
  it("shows discarded history and identifies clipped console entries", () => {
    render(
      <BrowserConsolePanel
        entries={[{ ...consoleEntries[0], droppedBefore: 500, truncated: true }]}
        onClear={jest.fn()}
      />
    )
    expect(screen.getByRole("status")).toHaveTextContent("500 earlier entries were discarded.")
    expect(screen.getByText("Truncated")).toBeVisible()
    expect(screen.getByText("hello")).toBeVisible()
  })
  it("keeps the loss notice visible after its original row is evicted", () => {
    const initial = Array.from({ length: 500 }, (_, ts) => ({
      level: "log" as const,
      text: `line-${ts}`,
      ts,
      ...(ts === 0 ? { droppedBefore: 500 } : {}),
    }))
    const entries = appendRing(initial, [{ level: "log", text: "new", ts: 501 }])
    render(<BrowserConsolePanel entries={entries} onClear={jest.fn()} />)
    expect(screen.getByRole("status")).toHaveTextContent("501 earlier entries were discarded.")
  })
  it("lists entries with their level and clears on request", () => {
    const onClear = jest.fn()
    render(<BrowserConsolePanel entries={consoleEntries} onClear={onClear} />)
    const list = screen.getByTestId("browser-devtools-console")
    expect(list).toHaveTextContent("hello")
    expect(list).toHaveTextContent("boom")
    expect(list.querySelector('[data-level="error"]')).not.toBeNull()

    fireEvent.click(screen.getByTestId("browser-devtools-clear"))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it("says so when nothing has been captured", () => {
    render(<BrowserConsolePanel entries={[]} onClear={jest.fn()} />)
    expect(screen.queryByTestId("browser-devtools-console")).toBeNull()
    expect(screen.getByText("No console output captured yet.")).toBeInTheDocument()
  })
})

describe("BrowserNetworkPanel (ADR-0127)", () => {
  it("localizes loss and clipping notices in Chinese", () => {
    render(
      <BrowserNetworkPanel
        entries={[{ ...network[0], droppedBefore: 3, truncated: true }]}
        onClear={jest.fn()}
      />,
      "zh-CN"
    )
    expect(screen.getByRole("status")).toHaveTextContent("已丢弃 3 条较早的记录。")
    expect(screen.getByText("已截断")).toBeVisible()
  })
  it("shows discarded history and identifies clipped URLs", () => {
    render(
      <BrowserNetworkPanel
        entries={[{ ...network[0], droppedBefore: 7, truncated: true }]}
        onClear={jest.fn()}
      />
    )
    expect(screen.getByRole("status")).toHaveTextContent("7 earlier entries were discarded.")
    expect(screen.getByText("Truncated")).toBeVisible()
    expect(screen.getByText("https://x/ok")).toBeVisible()
  })
  it("marks failed requests and renders a duration when there is one", () => {
    render(<BrowserNetworkPanel entries={network} onClear={jest.fn()} />)
    const list = screen.getByTestId("browser-devtools-network")
    expect(list.querySelector('[data-ok="false"]')).not.toBeNull()
    expect(list).toHaveTextContent("https://x/ok")
    expect(list).toHaveTextContent("503")
    // `durationMs: null` must not render an empty "ms" row.
    expect(list.querySelectorAll("li")[1]?.textContent).not.toContain("ms")
  })

  it("clears on request", () => {
    const onClear = jest.fn()
    render(<BrowserNetworkPanel entries={network} onClear={onClear} />)
    fireEvent.click(screen.getByTestId("browser-devtools-clear"))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it("says so when nothing has been captured", () => {
    render(<BrowserNetworkPanel entries={[]} onClear={jest.fn()} />)
    expect(screen.queryByTestId("browser-devtools-network")).toBeNull()
    expect(screen.getByText("No requests captured yet.")).toBeInTheDocument()
  })
})
