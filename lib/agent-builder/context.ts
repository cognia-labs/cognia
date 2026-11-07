/**
 * The live agent draft a builder conversation's model reads every turn
 * (ADR-0220), as the module's context contribution (ADR-0250 §14 `context`
 * amendment): it changes with every edit, so it is a turn section in the
 * dynamic tail. The builder tools and the session-stable protocol are the
 * module's tool contribution (`./agent-tools.ts`).
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { ContextContribution } from "@/lib/modules/manifest-types"
import { renderDraftForModel, type DraftCatalogs } from "./draft-ops"
import { isAgentBuilderSession } from "./builder-session"
import { resolveAgentBuilderToolDeps } from "./tool-deps"

/** The live draft section, or `undefined` for anything but a builder session with a draft. */
export async function resolveAgentBuilderTurnSection(
  session: Pick<ChatSession, "kind" | "agentBuilder">,
  catalogs: () => Promise<DraftCatalogs>
): Promise<string | undefined> {
  if (!isAgentBuilderSession(session) || !session.agentBuilder) return undefined
  const state = session.agentBuilder
  const draft =
    state.status === "created"
      ? `The agent was created (id ${state.createdCharacterId ?? "unknown"}). The draft is closed; point the user to the agent's Settings for further changes.`
      : JSON.stringify(renderDraftForModel(state.draft, await catalogs()), null, 2)
  return `## Current agent draft (revision ${state.revision}, last edited by ${state.editedBy})\n\n${draft}`
}

export const contributions: readonly ContextContribution[] = [
  {
    id: "draft",
    cache: "turn",
    // Rendering the draft resolves its ids against the skill, MCP server and
    // knowledge base lists in Dexie; a busy disk must not drop the draft.
    deadlineMs: 5_000,
    produce: async ({ session }) => {
      if (!session) return null
      const text = await resolveAgentBuilderTurnSection(
        session,
        resolveAgentBuilderToolDeps().catalogs
      )
      return text ? { text } : null
    },
  },
]
