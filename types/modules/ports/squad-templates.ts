// The `squad-templates` capability port (ADR-0250 §14): the Squad side of the
// template platform. The templates module instantiates, snapshots, updates
// and removes the Squads a squad template describes through it, and reads the
// user's squad templates from before the catalog for the one-time migration.
// The squads module (`lib/squads/module.ts`) provides it: squads builds on
// templates (its template tools, the apply and publish seams), so templates
// does not import the agent-team store. With no provider, instantiating a
// squad template fails and no legacy squad templates are migrated.

import type { AgentTeamTemplatePort } from "@/lib/templates/adapters"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"

export interface SquadTemplatesPort {
  /** The template platform's port onto the agent-team store. */
  agentTeam: AgentTeamTemplatePort
  /** The user's own (not built-in) squad templates from the agent-team store. */
  legacyTemplates(): readonly AgentTeamTemplate[]
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "squad-templates": SquadTemplatesPort
  }
}
