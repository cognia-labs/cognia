import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ToolUIPart } from "ai"
import squadsMessages from "@/i18n/messages/en/squads.json"

// Read the split messages directly; aggregate regeneration belongs to the build.
jest.mock("next-intl", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const messages = { squads: jest.requireActual("@/i18n/messages/en/squads.json") }
  return {
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
      const result = `${namespace}.${key}`
        .split(".")
        .reduce<unknown>(
          (value, part) =>
            value && typeof value === "object"
              ? (value as Record<string, unknown>)[part]
              : undefined,
          messages
        )
      if (typeof result !== "string") throw new Error(`Missing translation: ${namespace}.${key}`)
      void React
      return result.replace(/\{(\w+)\}/g, (_, name: string) =>
        String(values?.[name] ?? `{${name}}`)
      )
    },
  }
})

const chatState: { sessions: Record<string, { messages: unknown[] }> } = { sessions: {} }
jest.mock("@/stores/chat", () => ({
  useChatStore: (select: (state: typeof chatState) => unknown) => select(chatState),
}))
const teamState = {
  teams: {
    "sq-1": { id: "sq-1", name: "Builders" },
    "sq-2": { id: "sq-2", name: "Reviewers" },
  } as Record<string, { id: string; name: string }>,
}
jest.mock("@/stores/squads/agent-team-store/store", () => ({
  useAgentTeamStore: (select: (state: typeof teamState) => unknown) => select(teamState),
}))
const requestDecision = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({
  ok: true,
  decision: { status: "declined", decidedAt: 1, decidedBy: { kind: "local" } },
}))
jest.mock("@/lib/squads/room-handoff/decide-client", () => ({
  requestRoomSquadHandoffDecision: (...args: unknown[]) => requestDecision(...args),
}))
const dispatchRunControl = jest.fn(async (..._args: unknown[]) => ({ accepted: true }))
jest.mock("@/lib/execution/run-control-dispatch", () => ({
  dispatchRunControl: (...args: unknown[]) => dispatchRunControl(...args),
}))
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: () => "desktop" }))
let delegationRun: unknown = undefined
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => delegationRun }))
jest.mock("@/lib/db/execution-runs", () => ({ getExecutionRun: jest.fn() }))
jest.mock("@/components/chat/message-parts/squad-run-part", () => ({
  SquadRunPart: ({ part }: { part: { runId: string; objective: string } }) => (
    <div data-testid="squad-run-part">
      {part.runId}: {part.objective}
    </div>
  ),
}))

import { RoomHandoffCard } from "./room-handoff-card"

const t = squadsMessages.roomHandoff
const ROOM = "room-1"

function part(output: unknown, input: Record<string, unknown> = { brief: "Write a hello script" }) {
  return {
    type: "tool-room_handoff_to_squad",
    toolCallId: "tu-1",
    state: "output-available",
    input,
    output,
  } as unknown as ToolUIPart
}

const proposed = (squadId?: string) => ({
  status: "proposed",
  proposalId: "tu-1",
  brief: "Write a hello script",
  ...(squadId ? { squadId } : {}),
})

function holdReply(decision?: unknown, output: unknown = proposed("sq-1")) {
  chatState.sessions[ROOM] = {
    messages: [
      {
        id: "m1",
        role: "assistant",
        parts: [part(output)],
        metadata: { senderId: "ava", ...(decision ? { squadHandoffs: { "tu-1": decision } } : {}) },
      },
    ],
  }
}

const started = {
  status: "started",
  squadId: "sq-1",
  squadName: "Builders",
  delegationRunId: "execution:delegation:room-handoff:tu-1",
  squadRunId: "execution:team:r1",
  decidedAt: 5,
  decidedBy: { kind: "device", deviceId: "phone-1" },
}

beforeEach(() => {
  jest.clearAllMocks()
  chatState.sessions = {}
  delegationRun = undefined
})

describe("RoomHandoffCard", () => {
  it("offers the member's Squad and starts it on confirm", async () => {
    holdReply()
    render(<RoomHandoffCard part={part(proposed("sq-1"))} sessionId={ROOM} />)
    expect(screen.getByRole("heading", { name: t.title })).toBeInTheDocument()
    expect(screen.getByTestId("room-handoff-brief")).toHaveTextContent("Write a hello script")
    expect(screen.getByTestId("room-handoff-squad")).toHaveTextContent("Builders")
    expect(screen.getByText(t.gatesNote)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("room-handoff-confirm"))
    expect(requestDecision).toHaveBeenCalledWith({
      roomId: ROOM,
      toolUseId: "tu-1",
      decision: "confirm",
      squadId: "sq-1",
    })
  })

  it("needs a Squad picked when the member named none, and declines without one", async () => {
    holdReply(undefined, proposed())
    render(<RoomHandoffCard part={part(proposed())} sessionId={ROOM} />)
    expect(screen.getByTestId("room-handoff-confirm")).toBeDisabled()
    await userEvent.click(screen.getByTestId("room-handoff-decline"))
    expect(requestDecision).toHaveBeenCalledWith({
      roomId: ROOM,
      toolUseId: "tu-1",
      decision: "decline",
    })
  })

  it("says why a decision was refused, and that the Host was unreachable", async () => {
    holdReply()
    requestDecision.mockResolvedValueOnce({ ok: false, reason: "squad_not_found" })
    render(<RoomHandoffCard part={part(proposed("sq-1"))} sessionId={ROOM} />)
    await userEvent.click(screen.getByTestId("room-handoff-confirm"))
    expect(screen.getByRole("alert")).toHaveTextContent(t.refusal.squad_not_found)
    requestDecision.mockRejectedValueOnce(new Error("offline"))
    await userEvent.click(screen.getByTestId("room-handoff-confirm"))
    expect(screen.getByRole("alert")).toHaveTextContent(t.refusal.failed)
  })

  it("names no Squads to pick when there are none", () => {
    const teams = teamState.teams
    teamState.teams = {}
    try {
      holdReply(undefined, proposed())
      render(<RoomHandoffCard part={part(proposed())} sessionId={ROOM} />)
      expect(screen.getByText(t.noSquads)).toBeInTheDocument()
      expect(screen.getByTestId("room-handoff-confirm")).toBeDisabled()
    } finally {
      teamState.teams = teams
    }
  })

  it("shows a decline and a start that failed, with who decided", () => {
    holdReply({ status: "declined", decidedAt: 1, decidedBy: { kind: "auto" } })
    const { unmount } = render(<RoomHandoffCard part={part(proposed("sq-1"))} sessionId={ROOM} />)
    expect(screen.getByTestId("room-handoff-declined")).toHaveTextContent(
      t.declined.replace("{by}", t.decidedBy.auto)
    )
    expect(screen.queryByTestId("room-handoff-confirm")).not.toBeInTheDocument()
    unmount()
    holdReply({
      status: "failed",
      squadId: "sq-1",
      reason: "engine_refused",
      decidedAt: 1,
      decidedBy: { kind: "local" },
    })
    render(<RoomHandoffCard part={part(proposed("sq-1"))} sessionId={ROOM} />)
    expect(screen.getByTestId("room-handoff-failed")).toHaveTextContent("engine_refused")
  })

  it("follows a started Squad run and steers and stops it through the delegation", async () => {
    holdReply(started)
    delegationRun = { latestSnapshot: { allowedActions: ["steer", "stop"] } }
    render(<RoomHandoffCard part={part(proposed("sq-1"))} sessionId={ROOM} />)
    expect(screen.getByTestId("room-handoff-started")).toHaveTextContent(
      t.started.replace("{squad}", "Builders").replace("{by}", t.decidedBy.device)
    )
    expect(screen.getByTestId("squad-run-part")).toHaveTextContent(
      "execution:team:r1: Write a hello script"
    )
    expect(screen.getByTestId("room-handoff-steer")).toBeDisabled()
    await userEvent.type(screen.getByTestId("room-handoff-steer-input"), "Use Python")
    await userEvent.click(screen.getByTestId("room-handoff-steer"))
    expect(dispatchRunControl).toHaveBeenCalledWith({
      runId: "execution:delegation:room-handoff:tu-1",
      action: "steer",
      surface: "room-handoff",
      hostProfile: "desktop",
      steerMessage: "Use Python",
      steerSequence: 1,
    })
    expect(screen.getByTestId("room-handoff-steer-input")).toHaveValue("")
    dispatchRunControl.mockResolvedValueOnce({ accepted: false })
    await userEvent.click(screen.getByTestId("room-handoff-stop"))
    expect(dispatchRunControl).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "stop", runId: "execution:delegation:room-handoff:tu-1" })
    )
    expect(screen.getByRole("alert")).toHaveTextContent(t.controlFailed.stop)
  })

  it("offers no controls once the run offers none, and reads an auto start from the call's output", async () => {
    const output = {
      status: "started",
      proposalId: "tu-1",
      brief: "Write a hello script",
      squadId: "sq-1",
      squadName: "Builders",
      delegationRunId: "execution:delegation:room-handoff:tu-1",
      squadRunId: "execution:team:r1",
      decidedAt: 3,
    }
    holdReply(undefined, output)
    delegationRun = { latestSnapshot: { allowedActions: ["open_details"] } }
    render(<RoomHandoffCard part={part(output)} sessionId={ROOM} />)
    expect(screen.getByTestId("room-handoff-started")).toHaveTextContent(t.decidedBy.auto)
    expect(screen.queryByTestId("room-handoff-stop")).not.toBeInTheDocument()
    expect(screen.queryByTestId("room-handoff-steer")).not.toBeInTheDocument()
  })

  it("says an auto start that did not happen, and draws nothing for no output", async () => {
    const refused = { ...proposed("sq-1"), status: "refused", reason: "write_failed" }
    const { unmount } = render(<RoomHandoffCard part={part(refused)} sessionId={ROOM} />)
    expect(screen.getByTestId("room-handoff-refused")).toHaveTextContent("write_failed")
    unmount()
    const { container } = render(<RoomHandoffCard part={part(undefined)} sessionId={ROOM} />)
    expect(container).toBeEmptyDOMElement()
    await act(async () => undefined)
  })
})
