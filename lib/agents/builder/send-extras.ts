/**
 * What an agent-builder turn adds to its send options itself (ADR-0220): the
 * live draft as a per-turn section in the dynamic tail. The builder tools and
 * the session-stable protocol are the `agent-builder` module's tool
 * contribution (`lib/agent-builder/agent-tools.ts`).
 */

import type { ChatSession } from "@cognia/agent-config-types"
import { renderDraftForModel, type DraftCatalogs } from "./draft-ops"
import { isAgentBuilderSession } from "./builder-session"

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
