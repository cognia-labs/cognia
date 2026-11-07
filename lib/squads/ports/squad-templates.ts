// The squads module's implementation of the `squad-templates` port
// (`types/modules/ports/squad-templates.ts`, ADR-0250 §14): the template
// platform's view of the agent-team store.

import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import type { TemplateJson } from "@/lib/templates/contracts"
import type { AddTeammateInput, CreateTaskInput, CreateTeamInput } from "@/types/agent/agent-team"
import type { SquadTemplatesPort } from "@/types/modules/ports/squad-templates"

function json(value: unknown): TemplateJson {
  return JSON.parse(JSON.stringify(value)) as TemplateJson
}

function teamIdOf(resourceIds: Array<{ id: string }>): string {
  const id = resourceIds[0]?.id
  if (!id) throw new Error("AgentTeam template instance has no resource")
  return id
}

const store = () => useAgentTeamStore.getState()

export const port: SquadTemplatesPort = {
  agentTeam: {
    createTeam: (input) => store().createTeam(input as unknown as CreateTeamInput),
    addTeammate: (input) => store().addTeammate(input as unknown as AddTeammateInput),
    createTask: (input) => store().createTask(input as unknown as CreateTaskInput),
    deleteTeam: (teamId) => store().deleteTeam(teamId),
    updateTeammate: (teammateId, patch) => store().updateTeammate(teammateId, patch),
    snapshot: (resourceIds) => {
      const teamId = teamIdOf(resourceIds)
      const state = store()
      const team = state.getTeam(teamId)
      if (!team) throw new Error(`AgentTeam ${teamId} no longer exists`)
      return json({
        team,
        teammates: state.getTeammates(teamId),
        tasks: state.getTeamTasks(teamId),
      })
    },
    update: (resourceIds, payload) => {
      const teamId = teamIdOf(resourceIds)
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("AgentTeam update payload is invalid")
      }
      const team = payload.team
      if (!team || typeof team !== "object" || Array.isArray(team)) {
        throw new Error("AgentTeam update payload has no team")
      }
      store().updateTeam(teamId, team)
      return { resources: [{ domain: "agentTeam", id: teamId }] }
    },
    isActive: (resourceIds) => {
      const team = store().getTeam(teamIdOf(resourceIds))
      return team?.status === "planning" || team?.status === "executing"
    },
  },
  legacyTemplates: () => Object.values(store().templates).filter((template) => !template.isBuiltIn),
}
