// An optional follow-up a speech bubble can offer, like "Open Insights" on the
// bubble that announces a fresh Attention Radar report.
//
// Pure and dependency-light on purpose: the store, the cross-window wire
// protocol and the bubble view all import it, and the wire decoder must be
// able to validate an action arriving from another window without pulling in
// React or the event bus.

import { isPetConsoleTab, type PetConsoleTab } from "@/lib/pet/console-tabs"
import type { PetEventKind } from "@/types/pet"

/**
 * What clicking a bubble's action does:
 *  - `open-console`: open the pet console at a tab (e.g. radar Insights).
 *  - `open-attention`: jump directly to a pending attention item (chat
 *    approval, team HITL gate, durable run interrupt, or fleet session) (F6).
 */
export type PetBubbleAttentionSource = "chat" | "team" | "run" | "fleet"

export type PetBubbleAction =
  | { kind: "open-console"; tab: PetConsoleTab }
  | {
      kind: "open-attention"
      source: PetBubbleAttentionSource
      sessionId?: string
      teamId?: string
      runId?: string
    }

const ATTENTION_SOURCES: ReadonlySet<string> = new Set<PetBubbleAttentionSource>([
  "chat",
  "team",
  "run",
  "fleet",
])

function boundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined
}

/**
 * Validate an action from an untrusted source (another window's broadcast).
 * Rebuilds a clean object from the known fields so extra keys never ride
 * along; anything malformed decodes to `null`, and the caller keeps the
 * bubble's text without the action.
 */
export function decodePetBubbleAction(value: unknown): PetBubbleAction | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (raw.kind === "open-console") {
    if (!isPetConsoleTab(raw.tab)) return null
    return { kind: "open-console", tab: raw.tab }
  }
  if (raw.kind === "open-attention") {
    if (typeof raw.source !== "string" || !ATTENTION_SOURCES.has(raw.source)) return null
    const sessionId = boundedId(raw.sessionId)
    const teamId = boundedId(raw.teamId)
    const runId = boundedId(raw.runId)
    return {
      kind: "open-attention",
      source: raw.source as PetBubbleAttentionSource,
      ...(sessionId ? { sessionId } : {}),
      ...(teamId ? { teamId } : {}),
      ...(runId ? { runId } : {}),
    }
  }
  return null
}

/** The follow-up a bubble for this event kind offers, if any. */
const ACTION_BY_KIND: Partial<Record<PetEventKind, PetBubbleAction>> = {
  // The radar report is read in the console's Insights tab.
  radarReport: { kind: "open-console", tab: "insights" },
}

/** The action a bubble announcing `kind` should carry, or `undefined`. */
export function bubbleActionForKind(kind: PetEventKind): PetBubbleAction | undefined {
  const action = ACTION_BY_KIND[kind]
  return action ? { ...action } : undefined
}
