const state = {
  teams: {} as Record<string, { id: string; status: string }>,
  templates: {} as Record<string, { id: string; isBuiltIn?: boolean }>,
  createTeam: jest.fn((input: unknown) => ({ id: "team-new", input })),
  addTeammate: jest.fn((_input: unknown) => ({ id: "mate-new" })),
  createTask: jest.fn((_input: unknown) => ({ id: "task-new" })),
  deleteTeam: jest.fn(),
  updateTeammate: jest.fn(),
  updateTeam: jest.fn(),
  getTeam: (id: string) => state.teams[id],
  getTeammates: (_id: string) => [{ id: "mate-1" }],
  getTeamTasks: (_id: string) => [{ id: "task-1", run: () => undefined }],
}
jest.mock("@/stores/squads/agent-team-store/store", () => ({
  useAgentTeamStore: { getState: () => state },
}))

import { port } from "./squad-templates"

const ids = (id: string) => [{ domain: "agentTeam", id }]

beforeEach(() => {
  state.teams = { "team-1": { id: "team-1", status: "executing" } }
  state.templates = {}
  jest.clearAllMocks()
})

describe("squad-templates port", () => {
  it("creates Squads, teammates and tasks in the agent-team store", () => {
    expect(port.agentTeam.createTeam({ name: "A" })).toMatchObject({ id: "team-new" })
    expect(state.createTeam).toHaveBeenCalledWith({ name: "A" })
    port.agentTeam.addTeammate({ teamId: "team-new" })
    port.agentTeam.createTask({ teamId: "team-new" })
    port.agentTeam.deleteTeam("team-new")
    port.agentTeam.updateTeammate!("mate-1", { name: "B" })
    expect(state.addTeammate).toHaveBeenCalled()
    expect(state.createTask).toHaveBeenCalled()
    expect(state.deleteTeam).toHaveBeenCalledWith("team-new")
    expect(state.updateTeammate).toHaveBeenCalledWith("mate-1", { name: "B" })
  })

  it("snapshots a Squad as plain JSON and refuses one that is gone", () => {
    expect(port.agentTeam.snapshot(ids("team-1"))).toEqual({
      team: { id: "team-1", status: "executing" },
      teammates: [{ id: "mate-1" }],
      tasks: [{ id: "task-1" }],
    })
    expect(() => port.agentTeam.snapshot(ids("ghost"))).toThrow("AgentTeam ghost no longer exists")
    expect(() => port.agentTeam.snapshot([])).toThrow("has no resource")
  })

  it("updates a Squad from a payload with a team, and refuses anything else", () => {
    expect(port.agentTeam.update!(ids("team-1"), { team: { name: "C" } })).toEqual({
      resources: [{ domain: "agentTeam", id: "team-1" }],
    })
    expect(state.updateTeam).toHaveBeenCalledWith("team-1", { name: "C" })
    expect(() => port.agentTeam.update!(ids("team-1"), [] as never)).toThrow("invalid")
    expect(() => port.agentTeam.update!(ids("team-1"), { team: "x" })).toThrow("has no team")
  })

  it("counts a planning or executing Squad as active", () => {
    expect(port.agentTeam.isActive!(ids("team-1"))).toBe(true)
    state.teams["team-1"].status = "idle"
    expect(port.agentTeam.isActive!(ids("team-1"))).toBe(false)
    expect(port.agentTeam.isActive!(ids("ghost"))).toBe(false)
  })

  it("reads the user's own squad templates, not the built-in ones", () => {
    state.templates = { mine: { id: "mine" }, shipped: { id: "shipped", isBuiltIn: true } }
    expect(port.legacyTemplates()).toEqual([{ id: "mine" }])
  })
})
