/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : `${ns}.${key}`
    t.has = () => true
    return t
  },
}))

jest.mock("@cognia/logging", () => {
  const stub = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  return { loggers: new Proxy({}, { get: () => stub }), createLogger: () => stub }
})

const updateSession = jest.fn(async () => {})
jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(),
  updateSession: (...args: unknown[]) => updateSession(...(args as [])),
}))

let panelSession: ChatSession | undefined
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => panelSession,
}))

let imMode: { mode: string | null; setMode: jest.Mock } | null = null
const imHookArgs: unknown[] = []
jest.mock("@/hooks/connectors/use-im-room-reply-mode", () => ({
  useImRoomReplyMode: (session: unknown) => {
    imHookArgs.push(session)
    return imMode
  },
}))

import {
  ROOM_SETTINGS_CONTROLS,
  RoomSettingsPanel,
  RoomSettingsSection,
} from "./room-settings-section"

const imSession = (extra: Partial<ChatSession> = {}) =>
  ({
    id: "s-im",
    title: "Group",
    platformBinding: { platform: "lark", adapterId: "a1", conversationKey: "lark:a1:oc_1" },
    roomSettings: { memory: false },
    ...extra,
  }) as unknown as ChatSession

const sharedSession = () =>
  ({
    id: "s-sh",
    title: "Shared",
    collaboration: {},
    roomSettings: { memory: false },
  }) as unknown as ChatSession

beforeEach(() => {
  updateSession.mockClear()
  imHookArgs.length = 0
  imMode = null
  panelSession = undefined
})

const open = () => fireEvent.click(screen.getByTestId("room-settings-toggle"))

describe("RoomSettingsSection", () => {
  it("shows a control only where something reads it", () => {
    expect(ROOM_SETTINGS_CONTROLS).toEqual({
      team: ["replyMode", "squadHandoff", "instructions", "memory", "mutedMembers"],
      im: ["replyMode", "memory"],
      shared: ["memory"],
    })
  })

  it("gives an IM room the conversation's reply mode and writes it there, not to the session", async () => {
    imMode = { mode: "mention_only", setMode: jest.fn(async () => {}) }
    render(<RoomSettingsSection sessionId="s-im" session={imSession()} />)
    expect(screen.getByTestId("room-settings")).toHaveAttribute("data-room-kind", "im")
    expect(screen.getByTestId("room-settings-summary")).toHaveTextContent(
      "roomSettings.summary:desktop.memberList.roomSettings.replyModes.mention_only,desktop.memberList.roomSettings.memoryOff"
    )
    open()
    expect(screen.getByTestId("room-reply-mode-mention_only")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(screen.getByTestId("room-settings-reply-mode-hint")).toHaveTextContent(
      "desktop.memberList.roomSettings.imReplyModeHints.mention_only"
    )
    expect(screen.getByTestId("room-settings-reply-mode-im-note")).toBeInTheDocument()
    expect(screen.getByTestId("room-memory-switch")).toBeInTheDocument()
    expect(screen.queryByTestId("room-instructions")).not.toBeInTheDocument()
    expect(screen.queryByTestId("room-squad-handoff-confirm")).not.toBeInTheDocument()
    expect(screen.queryByTestId("room-muted-members")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("room-reply-mode-asleep"))
    await waitFor(() => expect(imMode!.setMode).toHaveBeenCalledWith("asleep"))
    expect(updateSession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("room-memory-switch"))
    expect(updateSession).toHaveBeenCalledWith("s-im", {
      roomSettings: { memory: true },
      memoryUse: true,
      memoryLearn: true,
    })
  })

  it("holds the reply mode back until the conversation's policy is known", () => {
    imMode = { mode: null, setMode: jest.fn(async () => {}) }
    render(<RoomSettingsSection sessionId="s-im" session={imSession()} defaultCollapsed={false} />)
    for (const mode of ["auto", "mention_only", "asleep"]) {
      expect(screen.getByTestId(`room-reply-mode-${mode}`)).toBeDisabled()
    }
    expect(screen.queryByTestId("room-settings-reply-mode-hint")).not.toBeInTheDocument()
    expect(screen.getByTestId("room-settings-summary")).toHaveTextContent(
      "desktop.memberList.roomSettings.memoryOff"
    )
  })

  it("gives a shared room its memory switch only", () => {
    render(
      <RoomSettingsSection sessionId="s-sh" session={sharedSession()} defaultCollapsed={false} />
    )
    expect(screen.getByTestId("room-settings")).toHaveAttribute("data-room-kind", "shared")
    expect(screen.getByTestId("room-memory-switch")).toBeInTheDocument()
    expect(screen.queryByTestId("room-reply-mode-auto")).not.toBeInTheDocument()
    expect(screen.getByTestId("room-settings-summary")).toHaveTextContent(
      "desktop.memberList.roomSettings.memoryOff"
    )
  })

  it("renders nothing for a direct conversation", () => {
    const { container } = render(
      <RoomSettingsSection
        sessionId="s-dm"
        session={{ id: "s-dm", title: "DM" } as unknown as ChatSession}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("keeps a team room's reply mode on the session when told the kind", () => {
    render(
      <RoomSettingsSection
        sessionId="s-team"
        session={{ id: "s-team", title: "T" } as unknown as ChatSession}
        kind="team"
        defaultCollapsed={false}
      />
    )
    fireEvent.click(screen.getByTestId("room-reply-mode-asleep"))
    expect(updateSession).toHaveBeenCalledWith("s-team", { roomSettings: { replyMode: "asleep" } })
    expect(screen.getByTestId("room-settings-reply-mode-hint")).toHaveTextContent(
      "desktop.memberList.roomSettings.replyModeHints.auto"
    )
  })
})

describe("RoomSettingsPanel", () => {
  it("opens an IM room's settings and says so when there is no room", () => {
    imMode = { mode: "auto", setMode: jest.fn(async () => {}) }
    panelSession = imSession()
    const { unmount } = render(<RoomSettingsPanel sessionId="s-im" />)
    expect(screen.getByTestId("room-settings-panel")).toBeInTheDocument()
    expect(screen.getByTestId("room-reply-mode-auto")).toHaveAttribute("aria-pressed", "true")
    unmount()

    panelSession = { id: "s-dm", title: "DM" } as unknown as ChatSession
    render(<RoomSettingsPanel sessionId="s-dm" />)
    expect(screen.getByTestId("room-settings-panel-empty")).toHaveTextContent(
      "desktop.memberList.roomSettings.noRoom"
    )
  })
})
