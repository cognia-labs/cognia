import type { AgentBuilderSessionState, ChatSession } from "@cognia/agent-config-types"
import { renderDraftForModel, type DraftCatalogs } from "./draft-ops"
import { resolveAgentBuilderTurnSection } from "./send-extras"

const CATALOGS: DraftCatalogs = {
  skills: [{ id: "sk-1", name: "Review" }],
  pluginSkills: [],
  mcpServers: [],
  knowledgeBases: [],
}

function state(overrides: Partial<AgentBuilderSessionState> = {}): AgentBuilderSessionState {
  return {
    draft: { name: "Reviewer", skillIds: ["sk-1"] },
    revision: 4,
    editedBy: "agent",
    status: "drafting",
    updatedAt: 1,
    ...overrides,
  }
}

type SessionInput = Pick<ChatSession, "kind" | "agentBuilder">

describe("resolveAgentBuilderTurnSection", () => {
  it("adds nothing to a session of another kind, without reading catalogs", async () => {
    const catalogs = jest.fn(async () => CATALOGS)
    const session: SessionInput = { kind: undefined, agentBuilder: state() }
    expect(await resolveAgentBuilderTurnSection(session, catalogs)).toBeUndefined()
    expect(catalogs).not.toHaveBeenCalled()
  })

  it("adds nothing to a builder session that carries no draft state", async () => {
    const catalogs = jest.fn(async () => CATALOGS)
    expect(
      await resolveAgentBuilderTurnSection(
        { kind: "agent-builder", agentBuilder: undefined },
        catalogs
      )
    ).toBeUndefined()
    expect(catalogs).not.toHaveBeenCalled()
  })

  it("renders the live draft against the catalogs", async () => {
    const catalogs = jest.fn(async () => CATALOGS)
    const section = await resolveAgentBuilderTurnSection(
      { kind: "agent-builder", agentBuilder: state() },
      catalogs
    )
    const rendered = JSON.stringify(renderDraftForModel(state().draft, CATALOGS), null, 2)
    expect(section).toBe(`## Current agent draft (revision 4, last edited by agent)\n\n${rendered}`)
    expect(section).toContain('"name": "Review"')
    expect(catalogs).toHaveBeenCalledTimes(1)
  })

  it("names the user as last editor when they made the latest revision", async () => {
    const section = await resolveAgentBuilderTurnSection(
      { kind: "agent-builder", agentBuilder: state({ editedBy: "user", revision: 0, draft: {} }) },
      async () => CATALOGS
    )
    expect(section!.startsWith("## Current agent draft (revision 0, last edited by user)")).toBe(
      true
    )
  })

  it("closes the draft once the agent was created, without reading catalogs", async () => {
    const catalogs = jest.fn(async () => CATALOGS)
    const section = await resolveAgentBuilderTurnSection(
      {
        kind: "agent-builder",
        agentBuilder: state({ status: "created", createdCharacterId: "char_7" }),
      },
      catalogs
    )
    expect(section).toBe(
      "## Current agent draft (revision 4, last edited by agent)\n\nThe agent was created (id char_7). The draft is closed; point the user to the agent's Settings for further changes."
    )
    expect(catalogs).not.toHaveBeenCalled()
  })

  it("says unknown when a created state lost its character id", async () => {
    const section = await resolveAgentBuilderTurnSection(
      { kind: "agent-builder", agentBuilder: state({ status: "created" }) },
      async () => CATALOGS
    )
    expect(section).toContain("The agent was created (id unknown).")
  })

  it("propagates a catalog read failure", async () => {
    await expect(
      resolveAgentBuilderTurnSection({ kind: "agent-builder", agentBuilder: state() }, async () => {
        throw new Error("db closed")
      })
    ).rejects.toThrow("db closed")
  })
})
