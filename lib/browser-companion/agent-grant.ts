/**
 * The capability grant a Browser Companion agent conversation runs with
 * (ADR-0228 §6, ADR-0198), contributed by this module to every run of such a
 * conversation.
 *
 * Instructions only. The browser tools are admitted at the plugin-manifest gate
 * in `lib/claude/build-options.ts` for a conversation bound to a paired
 * browser — not through `tools.add`, which joins an allow list and would narrow
 * a turn that had no allow list down to the browser tools alone.
 */
import { extensionBindingFor } from "@/lib/browser/extension-engine"
import type { CapabilityContribution } from "@/lib/modules/manifest-types"
import { resolvePrompt } from "@/lib/prompts/resolve"
import { definePrompt } from "@/lib/prompts/types"

/** What the model is told about where its browser tools act (the shipped text). */
export const BROWSER_COMPANION_AGENT_INSTRUCTION =
  "This conversation was started from the user's own web browser through the Cognia browser " +
  "extension, with permission to act in that browser. The browser_* tools operate on the " +
  "user's real, signed-in tabs: the conversation's tabs are grouped under “Cognia”, and the " +
  "tab the user started from is the first one. Before acting on a site for the first time the " +
  "user is asked to allow it in the side panel; if a tool answers " +
  "browser_site_permission_required, ask the user to decide there rather than retrying. If a " +
  "tool answers browser_user_takeover, the user has taken control: stop acting and wait for " +
  "them. Never type into password or one-time-code fields; ask the user to do it. Prefer " +
  "browser_snapshot over screenshots, and keep actions to what the user asked for."

/**
 * The instruction as a Prompt Center entry (ADR-0236). Editable wording only:
 * the grant still adds nothing but instructions, so an override cannot widen
 * what the browser tools may do. It must keep naming the two tool answers the
 * model has to hand back to the user, because the site-permission approval and
 * the takeover pause depend on the model recognising them.
 */
export const BROWSER_COMPANION_AGENT_PROMPT = definePrompt({
  id: "agent.browser-companion.grant",
  contractVersion: 1,
  kind: "feature-template",
  group: "agents",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  // Teaches how the per-site approval in the side panel and a user takeover
  // are handled; a bad edit could have the model retry around the approval.
  risk: "approval-sensitive",
  hosts: ["app"],
  maxChars: 6_000,
  requiredFragments: ["browser_site_permission_required", "browser_user_takeover"],
  outputContract:
    "Added as the Browser Companion capability grant's instruction on every turn of a conversation bound to a paired browser.",
  consumers: ["lib/browser-companion/agent-grant.ts"],
  defaultBody: BROWSER_COMPANION_AGENT_INSTRUCTION,
})

/**
 * The grant as browser-companion's capability contribution (ADR-0198
 * amendment): every run of a conversation bound to a paired browser gets the
 * instruction, resolved against the run's frozen Prompt Center view. It only
 * adds, so a failure leaves it out instead of failing the turn.
 */
export const contributions: readonly CapabilityContribution[] = [
  {
    id: "agent-mode",
    failure: "skip",
    produce: ({ session, prompts }) => {
      if (!session?.id || !extensionBindingFor(session.id)) return null
      return {
        instructions: [
          resolvePrompt(BROWSER_COMPANION_AGENT_PROMPT, {
            snapshot: prompts.snapshot,
            context: prompts.context,
          }).text,
        ],
      }
    },
  },
]
