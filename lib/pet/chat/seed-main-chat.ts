// "Open full chat" escape hatch from the pet chat panel: create a fresh main
// chat session, seed its composer draft with a reviewable handoff carrying the
// recent pet exchanges (both user + pet replies) and optional character context
// (F7), and make it active. The caller then routes to `/` (the composer reads
// the draft back on mount — see `components/chat/composer.tsx`).
//
// Collaborators are injectable so this is unit-tested without the store/Dexie.

import { useSessionStore } from "@/stores/chat/session-store"
import { setDraft } from "@/lib/db/chat-drafts"
import type { PetConversationRow } from "@/types/pet"

const MAX_HANDOFF_TURNS = 5
const MAX_HANDOFF_CHARS = 2000

export interface SeedMainChatSessionOptions {
  characterId?: string
  projectId?: string
  title?: string
}

export interface SeedMainChatDeps {
  createSession?: (options?: SeedMainChatSessionOptions) => { id: string }
  setActiveSession?: (id: string) => void
  setDraft?: (sessionId: string, text: string) => Promise<void>
  sessionOptions?: SeedMainChatSessionOptions
}

export interface PetHandoffSeedInput {
  pending?: string | null
  recentTurns?: ReadonlyArray<Pick<PetConversationRow, "userText" | "reply">>
  petName?: string | null
  labels?: {
    contextHeader: string
    userLabel: string
    petFallbackName: string
  }
}

/**
 * Format recent pet conversation turns (user + pet replies) plus any pending
 * prompt into an editable composer draft so continuing in main chat preserves
 * conversation context instead of dropping pet replies (F7).
 */
export function formatPetHandoffSeed({
  pending,
  recentTurns = [],
  petName,
  labels,
}: PetHandoffSeedInput): string {
  const pendingText = pending?.trim() ?? ""
  const completedTurns = recentTurns
    .filter((t) => t.userText.trim() || t.reply.trim())
    .slice(-MAX_HANDOFF_TURNS)

  if (completedTurns.length === 0) return pendingText

  const userLabel = labels?.userLabel ?? "You"
  const petLabel = petName?.trim() || labels?.petFallbackName || "Pet"
  const header = labels?.contextHeader ?? `Context from pet chat (${petLabel}):`

  const lines: string[] = [header]
  for (const turn of completedTurns) {
    const u = turn.userText.trim()
    const r = turn.reply.trim()
    if (u) lines.push(`${userLabel}: ${u}`)
    if (r) lines.push(`${petLabel}: ${r}`)
  }

  let contextBlock = lines.join("\n")
  if (contextBlock.length > MAX_HANDOFF_CHARS) {
    contextBlock = contextBlock.slice(0, MAX_HANDOFF_CHARS - 1).trimEnd() + "…"
  }
  return pendingText ? `${contextBlock}\n\n${pendingText}` : contextBlock
}

/**
 * Create a new chat session seeded with `seedText` and activate it. Returns the
 * new session id. The draft write is best-effort — a failed persist must not
 * block navigation, so the session is still activated.
 */
export async function seedMainChat(seedText: string, deps: SeedMainChatDeps = {}): Promise<string> {
  const store = useSessionStore.getState()
  const createSession =
    deps.createSession ?? ((opts?: SeedMainChatSessionOptions) => store.createSession(opts))
  const setActiveSession = deps.setActiveSession ?? ((id: string) => store.setActiveSession(id))
  const setDraftFn = deps.setDraft ?? setDraft

  const session = deps.sessionOptions ? createSession(deps.sessionOptions) : createSession()
  const text = seedText.trim()
  if (text) await setDraftFn(session.id, text).catch(() => {})
  setActiveSession(session.id)
  return session.id
}
