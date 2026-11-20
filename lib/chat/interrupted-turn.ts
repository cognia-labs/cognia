/**
 * Continuing a chat turn that a crash or restart cut off (ADR-0123).
 *
 * The work outbox parks such a turn as `recovery_required` rather than sending
 * it again on its own: nothing proves the runtime had not already acted. The
 * person decides. Continuing sends one new turn into the same conversation,
 * which already holds the interrupted user message and whatever reply was
 * saved, with an instruction to carry on from there instead of starting over.
 */

import { resolvePrompt } from "@/lib/prompts/resolve"
import { definePrompt } from "@/lib/prompts/types"

/**
 * Why a turn was parked, for the reasons that mean it may already have had
 * effects: it reached a tool, left a tool call without a result, or was cut
 * off with nothing to show whether it had started. Continuing one of these
 * can repeat work, so the person confirms first.
 */
const EFFECT_UNCERTAIN_REASONS = new Set([
  "observed-tool-activity",
  "ambiguous-side-effects",
  "unconfirmed-attempt",
])

export function interruptedTurnMayRepeatEffects(errorCode: string | undefined): boolean {
  return errorCode !== undefined && EFFECT_UNCERTAIN_REASONS.has(errorCode)
}

export const INTERRUPTED_TURN_RESUME_PROMPT = definePrompt({
  id: "chat.interrupted-turn.resume",
  contractVersion: 1,
  kind: "protocol",
  group: "chat",
  // The silent instruction the continuation sends: the person sees their own
  // message and the partial reply, never this text.
  operation: "inspect-only",
  scopes: [],
  activation: "next-operation",
  risk: "protocol",
  hosts: ["app"],
  consumers: ["lib/chat/interrupted-turn.ts"],
  defaultBody: `[Interrupted turn — continue]

Your reply to the last user message was cut off before the turn finished (the app or its host stopped). Continue that same task from where it stopped. Use what the conversation already shows, and do not repeat steps that already completed. Before acting again on anything you were changing, check its current state: an action you started may already have taken effect.`,
})

/** The text of the continuation turn. */
export function interruptedTurnResumeMessage(): string {
  return resolvePrompt(INTERRUPTED_TURN_RESUME_PROMPT).text
}
