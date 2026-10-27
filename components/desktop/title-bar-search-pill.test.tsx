/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

type Status = "idle" | "streaming" | "awaiting_approval" | "error"
const chatRef = {
  sessions: {} as Record<string, { status: Status }>,
  activeSessionId: null as string | null,
}
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({ sessions: chatRef.sessions, activeSessionId: chatRef.activeSessionId }),
}))

/** One focused conversation, which is what most of these cases are about. */
function focusedOnly(status: Status) {
  chatRef.sessions = { a: { status } }
  chatRef.activeSessionId = "a"
}

// The pill names what is in front (`useBarTitle`): the chat home by default.
const pathRef = { value: "/" }
jest.mock("next/navigation", () => ({ usePathname: () => pathRef.value }))

const labelRef = { value: undefined as string | undefined }
jest.mock("@/hooks/chat/use-active-session-label", () => ({
  useActiveSessionLabel: () => ({ label: labelRef.value }),
}))

// The hint is the palette's effective chord (`app.commandPalette.toggle`),
// resolved by the shared label hook; driven here so the tests can rebind it.
const shortcutRef = { label: "⌘K", aria: "Meta+K" as string | undefined }
const shortcutHook = jest.fn((_id: string) => shortcutRef)
jest.mock("@/hooks/shortcuts/use-app-shortcut-label", () => ({
  useAppShortcutLabel: (id: string) => shortcutHook(id),
}))

import { TitleBarSearchPill } from "./title-bar-search-pill"

const onClick = jest.fn()

const renderPill = () =>
  render(
    <TitleBarSearchPill
      appName="Cognia"
      separator=" — "
      placeholder="Search or jump to…"
      onClick={onClick}
    />
  )

beforeEach(() => {
  pathRef.value = "/"
  shortcutRef.label = "⌘K"
  shortcutRef.aria = "Meta+K"
  shortcutHook.mockClear()
  onClick.mockClear()
  focusedOnly("idle")
  labelRef.value = undefined
})

describe("TitleBarSearchPill", () => {
  it("shows the app name alone when no conversation is active", () => {
    renderPill()
    expect(screen.getByTestId("title-bar-title")).toHaveTextContent("Cognia")
  })

  it("appends the active conversation label", () => {
    labelRef.value = "Refactor the parser"
    renderPill()
    expect(screen.getByTestId("title-bar-title")).toHaveTextContent("Cognia — Refactor the parser")
  })

  it("swaps the magnifier for a pulsing dot while streaming", () => {
    focusedOnly("streaming")
    renderPill()
    expect(screen.getByTestId("title-bar-streaming-dot")).toBeInTheDocument()
  })

  it("shows no streaming dot when idle", () => {
    renderPill()
    expect(screen.queryByTestId("title-bar-streaming-dot")).toBeNull()
  })

  it("opens the command palette on click and labels itself with the placeholder", () => {
    renderPill()
    const pill = screen.getByRole("button", { name: "Search or jump to…" })
    fireEvent.click(pill)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("renders the keyboard hint", () => {
    renderPill()
    expect(screen.getByText("⌘K")).toBeInTheDocument()
  })

  it("keeps the dot on the conversation it names, not on the app", () => {
    // The pill names one document; the dot is that document's state. Borrowing
    // a background turn's dot would attribute work to the wrong conversation.
    chatRef.sessions = { a: { status: "idle" }, b: { status: "streaming" } }
    chatRef.activeSessionId = "a"
    renderPill()
    expect(screen.queryByTestId("title-bar-streaming-dot")).toBeNull()
  })

  it("says how much is running elsewhere, which the dot cannot", () => {
    chatRef.sessions = { a: { status: "idle" }, b: { status: "streaming" } }
    chatRef.activeSessionId = "a"
    renderPill()
    const badge = screen.getByTestId("title-bar-background-count")
    expect(badge).toHaveTextContent("1")
    expect(badge).toHaveAccessibleName('runningCount:{"count":1}')
  })

  it("shows no badge when the only running turn is the one on screen", () => {
    focusedOnly("streaming")
    renderPill()
    expect(screen.queryByTestId("title-bar-background-count")).toBeNull()
  })
})

describe("compact search beside the conversation title", () => {
  it("omits duplicate title and shortcut text while retaining accessible search and run state", () => {
    labelRef.value = "Refactor the parser"
    chatRef.sessions = { a: { status: "streaming" }, b: { status: "streaming" } }
    render(
      <TitleBarSearchPill
        appName="Cognia"
        separator=" — "
        placeholder="Search"
        onClick={onClick}
        compact
      />
    )
    const button = screen.getByRole("button", { name: "Search" })
    expect(button).toHaveAttribute("data-compact", "true")
    expect(button).toHaveAttribute("title", "Search (⌘K)")
    expect(screen.queryByTestId("title-bar-title")).not.toBeInTheDocument()
    expect(screen.queryByText("⌘K")).not.toBeInTheDocument()
    expect(screen.getByTestId("title-bar-streaming-dot")).toBeInTheDocument()
    expect(screen.getByTestId("title-bar-background-count")).toBeInTheDocument()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe("the shortcut hint", () => {
  it("prints the palette's effective chord and exposes it to assistive tech", () => {
    renderPill()
    expect(shortcutHook).toHaveBeenCalledWith("app.commandPalette.toggle")
    expect(screen.getByText("⌘K")).toBeInTheDocument()
    expect(screen.getByTestId("title-bar-search-pill")).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+K"
    )
  })

  it("follows a rebinding instead of a fixed string", () => {
    shortcutRef.label = "Ctrl+J"
    shortcutRef.aria = "Control+J"
    renderPill()
    expect(screen.getByText("Ctrl+J")).toBeInTheDocument()
    expect(screen.queryByText("⌘K")).not.toBeInTheDocument()
  })

  it("prints no hint while the palette is unbound", () => {
    shortcutRef.label = ""
    shortcutRef.aria = undefined
    render(
      <TitleBarSearchPill
        appName="Cognia"
        separator=" — "
        placeholder="Search"
        onClick={onClick}
        compact
      />
    )
    const button = screen.getByRole("button", { name: "Search" })
    expect(button).toHaveAttribute("title", "Search")
    expect(button).not.toHaveAttribute("aria-keyshortcuts")
  })
})

// On another page the pill names that page, so it stops claiming the last
// conversation — and no conversation owns the streaming dot there.
describe("on a page other than the chat home", () => {
  it("names the page instead of the last conversation", () => {
    pathRef.value = "/settings"
    labelRef.value = "Refactor the parser"
    renderPill()
    expect(screen.getByTestId("title-bar-title")).toHaveTextContent("Cognia — settings")
    expect(screen.getByTestId("title-bar-title")).not.toHaveTextContent("Refactor the parser")
  })

  it("counts the focused turn as running elsewhere instead of drawing the dot", () => {
    pathRef.value = "/workflows"
    focusedOnly("streaming")
    renderPill()
    expect(screen.queryByTestId("title-bar-streaming-dot")).toBeNull()
    expect(screen.getByTestId("title-bar-background-count")).toHaveTextContent("1")
  })

  it("shows no badge while nothing runs", () => {
    pathRef.value = "/workflows"
    focusedOnly("idle")
    renderPill()
    expect(screen.queryByTestId("title-bar-background-count")).toBeNull()
  })
})
