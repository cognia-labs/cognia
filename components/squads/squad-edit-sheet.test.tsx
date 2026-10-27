/** @jest-environment jsdom */

// The Squad's editor over `/squads`. Its body is the Settings library's panel,
// which has its own suite; these cases are about the drawer: when it is open,
// what it is titled, where it scrolls, and what it reports.

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => false }))
jest.mock("@/components/settings/squads/squad-detail-panel", () => ({
  SquadDetailPanel: ({
    squadId,
    onDeleted,
    onOpenSquad,
  }: {
    squadId: string
    onDeleted?: (id: string) => void
    onOpenSquad?: (id: string) => void
  }) => (
    <div data-testid="squad-detail-panel" data-squad={squadId}>
      <div data-setting-id="squad-roster" data-testid="roster-anchor" />
      <button type="button" onClick={() => onDeleted?.(squadId)}>
        delete
      </button>
      <button type="button" onClick={() => onOpenSquad?.("copy")}>
        duplicate
      </button>
    </div>
  ),
}))

import { SquadEditSheet } from "./squad-edit-sheet"
import type { SquadEditFocus } from "@/hooks/squads/use-squad-route-state"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam } from "@/types/agent/agent-team"

const onFocusChange = jest.fn()
const onDeleted = jest.fn()
const onOpenSquad = jest.fn()
const scrollIntoView = jest.fn()

function mount(focus: SquadEditFocus | undefined) {
  return render(
    <SquadEditSheet
      squadId="a"
      focus={focus}
      onFocusChange={onFocusChange}
      onDeleted={onDeleted}
      onOpenSquad={onOpenSquad}
    />
  )
}

beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView
})

beforeEach(() => {
  jest.clearAllMocks()
  useAgentTeamStore.setState({
    teams: { a: { id: "a", name: "Review Crew", status: "idle", config: {} } as AgentTeam },
  } as never)
})

it("stays closed, and mounts no editor, until the URL opens it", () => {
  mount(undefined)
  expect(screen.queryByTestId("squad-detail-panel")).not.toBeInTheDocument()
})

it("opens the Squad's own editor, titled with its name", () => {
  mount("general")
  expect(screen.getByRole("dialog")).toHaveTextContent("Edit Review Crew")
  expect(screen.getByTestId("squad-detail-panel")).toHaveAttribute("data-squad", "a")
  expect(screen.getByTestId("squad-edit-sheet")).toHaveAttribute("data-focus", "general")
})

/** "Edit roster" and "Add a teammate" ask for the members, not the name field. */
it("scrolls to the roster when opened on it", () => {
  jest.useFakeTimers()
  try {
    mount("roster")
    act(() => {
      jest.runOnlyPendingTimers()
    })
  } finally {
    jest.useRealTimers()
  }
  expect(scrollIntoView).toHaveBeenCalledTimes(1)
  expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByTestId("roster-anchor"))
})

it("does not scroll when opened on the general fields", () => {
  jest.useFakeTimers()
  try {
    mount("general")
    act(() => {
      jest.runOnlyPendingTimers()
    })
  } finally {
    jest.useRealTimers()
  }
  expect(scrollIntoView).not.toHaveBeenCalled()
})

it("reports closing to the URL", async () => {
  mount("general")
  await userEvent.keyboard("{Escape}")
  expect(onFocusChange).toHaveBeenCalledWith(undefined)
})

it("passes delete and duplicate through to the host", async () => {
  mount("general")
  await userEvent.click(screen.getByRole("button", { name: "delete" }))
  expect(onDeleted).toHaveBeenCalledWith("a")
  await userEvent.click(screen.getByRole("button", { name: "duplicate" }))
  expect(onOpenSquad).toHaveBeenCalledWith("copy")
})
