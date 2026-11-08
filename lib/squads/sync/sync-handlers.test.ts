jest.mock("./agent-team-definitions", () => ({
  syncAgentTeamTasks: jest.fn(),
  syncAgentTeammates: jest.fn(),
  syncAgentTeams: jest.fn(),
}))

import { syncAgentTeamTasks, syncAgentTeammates, syncAgentTeams } from "./agent-team-definitions"
import { syncHandlers } from "./sync-handlers"

describe("squads sync handlers", () => {
  it("contributes the team definition pulls and leaves reading to the host", () => {
    expect(syncHandlers).toEqual({
      agentTeams: { pull: syncAgentTeams },
      agentTeammates: { pull: syncAgentTeammates },
      agentTeamTasks: { pull: syncAgentTeamTasks },
    })
  })
})
