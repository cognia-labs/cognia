/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"

const replace = jest.fn()
let pathname = "/settings"
let search = "section=automation"

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: jest.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
}))

const stop = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
  transport: { call: jest.fn().mockResolvedValue(null), subscribe: jest.fn(() => stop) },
}))

jest.mock("@/lib/automation/client", () => {
  const actual =
    jest.requireActual<typeof import("@/lib/automation/client")>("@/lib/automation/client")
  return {
    ...actual,
    desktop: {
      settingsGet: jest.fn(() => Promise.resolve(actual.defaultAutomationSettings())),
      killSwitchEngaged: jest.fn(() => Promise.resolve(false)),
      capabilities: jest.fn(() => Promise.resolve({ platform: "macos" })),
    },
  }
})

jest.mock("@/lib/skills/recording/recorder-client", () => ({
  recordPreflight: jest.fn(() =>
    Promise.resolve({
      accessibility: "ok",
      screenRecording: "ok",
      uiAutomation: "notApplicable",
    })
  ),
}))

jest.mock("@/lib/automation/audit", () => ({ listAuditRows: jest.fn().mockResolvedValue([]) }))

import { isTauri, transport } from "@/lib/tauri"
import { AutomationSection } from "@/components/settings/automation/automation-section"

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <AutomationSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  replace.mockClear()
  stop.mockClear()
  ;(isTauri as jest.Mock).mockReturnValue(true)
  pathname = "/settings"
  search = "section=automation"
})

describe("AutomationSection", () => {
  it("off the desktop shell, explains the missing engine instead of a build command", () => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    renderSection()
    const notice = screen.getByTestId("automation-unavailable")
    expect(notice).toHaveTextContent(en.automation.unavailable.title)
    expect(notice.textContent ?? "").not.toMatch(/pnpm|tauri dev|tauri build/i)
    expect(screen.queryByTestId("automation-status-strip")).not.toBeInTheDocument()
    expect(screen.queryByTestId("automation-panel-body")).not.toBeInTheDocument()
  })

  it("puts the status strip above a rail of every panel", async () => {
    renderSection()
    expect(await screen.findByTestId("automation-status-strip")).toBeInTheDocument()
    for (const id of [
      "overview",
      "permissions",
      "accessRules",
      "behavior",
      "audit",
      "inspector",
      "diagnostics",
    ] as const) {
      expect(screen.getByTestId(`automation-nav-item-${id}`)).toHaveTextContent(
        en.automation.nav.items[id].label
      )
    }
    // The sandbox registry is no longer a panel here, only an entry point.
    expect(screen.queryByTestId("automation-nav-item-sandboxes")).not.toBeInTheDocument()
    expect(screen.getByTestId("automation-sandbox-entry")).toBeInTheDocument()
    expect(screen.getByTestId("automation-panel-body")).toHaveAttribute("data-panel", "overview")
  })

  it("keeps the panel selection on the settings route", async () => {
    renderSection()
    await screen.findByTestId("automation-status-strip")
    await userEvent.click(screen.getByTestId("automation-nav-item-audit"))
    expect(replace).toHaveBeenCalledWith("/settings?section=automation&autoTab=audit", {
      scroll: false,
    })
  })

  /**
   * `?autoTab=whitelist` and `?autoTab=sandboxes` are what links and bookmarks
   * carry from the tab strip.
   */
  it("still resolves the retired tab ids", () => {
    search = "section=automation&autoTab=whitelist"
    const { unmount } = renderSection()
    expect(screen.getByTestId("automation-panel-body")).toHaveAttribute("data-panel", "accessRules")
    unmount()
    search = "section=automation&autoTab=sandboxes"
    renderSection()
    expect(screen.getByTestId("automation-panel-body")).toHaveAttribute("data-panel", "overview")
  })

  /**
   * The regression this guards: selection used to write `/settings` verbatim,
   * navigating any other route that mounted the section away on first click.
   */
  it("keeps the panel selection on whatever other route mounted it", async () => {
    pathname = "/me/computer-use"
    search = ""
    renderSection()
    await screen.findByTestId("automation-status-strip")
    await userEvent.click(screen.getByTestId("automation-nav-item-accessRules"))
    expect(replace).toHaveBeenCalledWith("/me/computer-use?autoTab=accessRules", { scroll: false })
    expect(replace).not.toHaveBeenCalledWith(
      expect.stringContaining("/settings"),
      expect.anything()
    )
  })

  it("uses the shared event transport so native teardown races are contained", async () => {
    const { unmount } = renderSection()
    await waitFor(() =>
      expect(transport.subscribe).toHaveBeenCalledWith(
        "automation:backend-init-failed",
        expect.any(Function)
      )
    )
    expect(transport.subscribe).toHaveBeenCalledWith("automation:kill-switch", expect.any(Function))
    unmount()
    expect(stop).toHaveBeenCalledTimes(2)
  })
})
