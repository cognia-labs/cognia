// Orchestrates one turn of the pet CHAT panel (the multi-turn counterpart of
// the `usePetSpeak` bubble side channel). Same guarantees — a hard PII gate
// before anything reaches the embedder/model, a rate limiter, and the utility
// client — but it returns a DISCRIMINATED RESULT so the panel can tell the user
// WHY a turn degraded (the bubble path fails silently). Completed turns are
// recorded to `petConversation`, so they flow straight into the transcript's
// live query.
//
// Every collaborator is injectable (`deps`) so this is unit-tested without a
// model, IndexedDB, or the twin/vector stack; production uses the defaults.

import type { AppSettings } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { MemoryRetrieverDeps } from "@/lib/memory/retrieve/retriever"
import type { PetOneShot, PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"

import { hasNoLeakingPii } from "@cognia/redact"
import { getSpeakLimiter } from "@/lib/pet/bubbles/speak-limiter"
import {
  buildUtilityLlmClient,
  type BuildUtilityClientArgs,
} from "@/lib/ai/generation/utility-client"
import { chatAsPet } from "@/lib/pet/bubbles/speak"
import {
  formatHistoryLines,
  loadHistoryForPrompt,
  tryRecordTurn,
  type PetHistoryDeps,
} from "@/lib/pet/llm/history"
import { appendPetTurn, listRecentPetTurns, PET_CONVERSATION_CAP } from "@/lib/db/pet-conversation"
import {
  capturePetScope,
  isPetConversationScopeCurrent,
  PetScopeInvalidatedError,
} from "@/lib/pet/runtime/pet-scope"
import { recallAboutUser } from "@/lib/pet/llm/recall"
import { EMOTION_TO_ONESHOT, parseEmotion } from "@/lib/pet/llm/emotion-tags"
import { resolveMemoryConfig } from "@/types/memory/memory"

/** Why a chat turn did not produce a real reply (surfaced in the panel). */
export type PetChatDegradeReason =
  "disabled" | "pii" | "rateLimited" | "noClient" | "empty" | "error"

export type PetChatResult =
  | {
      status: "ok"
      reply: string
      emotion?: PetOneShot
      /** Set to `false` when memory is off or best-effort persistence failed. */
      persisted?: false
    }
  | {
      status: "degraded"
      reason: PetChatDegradeReason
      /** True when the turn was fenced out by clear, reset, or account switch/lock. */
      invalidated?: true
    }

export interface RespondAsPetInput {
  userText: string
  view: PetView | undefined
  profile: PetProfile | undefined
  appSettings: AppSettings | null | undefined
  locale: string
  activeCharacterId?: string | null
  /** Epoch ms for the turn (injected — never read the clock in here). */
  at: number
}

export interface PetChatDeps {
  hasNoLeakingPii: (text: string) => boolean
  tryAcquire: (now: number) => boolean
  buildClient: (args: BuildUtilityClientArgs) => LlmClient | null
  chat: (client: LlmClient | null, args: Parameters<typeof chatAsPet>[1]) => Promise<string | null>
  history: PetHistoryDeps
  loadMemoryDeps: (
    appSettings: AppSettings | null | undefined
  ) => Promise<MemoryRetrieverDeps | null>
  recall: typeof recallAboutUser
  resolveCharacterPersona: (id: string) => Promise<string | null>
  parseEmotion: typeof parseEmotion
}

const HISTORY_DEPS: PetHistoryDeps = { append: appendPetTurn, listRecent: listRecentPetTurns }

async function defaultLoadMemoryDeps(
  appSettings: AppSettings | null | undefined
): Promise<MemoryRetrieverDeps | null> {
  return (
    (await import("@/lib/memory/runtime/build-deps")
      .then((m) => m.tryBuildMemoryDeps(resolveMemoryConfig(appSettings?.memory)))
      .catch(() => null)) ?? null
  )
}

async function defaultResolveCharacterPersona(id: string): Promise<string | null> {
  return (
    (await import("@/lib/pet/llm/character-persona")
      .then((m) => m.resolveCharacterPersona(id))
      .catch(() => null)) ?? null
  )
}

const DEFAULT_DEPS: PetChatDeps = {
  hasNoLeakingPii,
  tryAcquire: (now) => getSpeakLimiter().tryAcquire(now),
  buildClient: buildUtilityLlmClient,
  chat: chatAsPet,
  history: HISTORY_DEPS,
  loadMemoryDeps: defaultLoadMemoryDeps,
  recall: recallAboutUser,
  resolveCharacterPersona: defaultResolveCharacterPersona,
  parseEmotion,
}

/**
 * Produce one pet chat reply. Never throws — every failure is a `degraded`
 * result with a reason. On success the turn is recorded to history (when pet
 * memory is on) so the transcript's live query picks it up.
 */
export async function respondAsPet(
  input: RespondAsPetInput,
  overrides: Partial<PetChatDeps> = {}
): Promise<PetChatResult> {
  const d = { ...DEFAULT_DEPS, ...overrides }
  const userText = (input.userText ?? "").trim()
  const llmSpeak = input.appSettings?.petSettings?.llmSpeak
  const soul = input.profile?.soul

  // Degradations that never reach the model. Check PII and client availability
  // before spending a shared speak-limiter slot.
  if (!userText || !llmSpeak?.enabled || !soul || !input.view) {
    return { status: "degraded", reason: "disabled" }
  }
  // Privacy gate: the text feeds BOTH the recall embedding (possibly cloud) and
  // the model prompt, so gate here BEFORE recall — mirrors `usePetSpeak`.
  if (!d.hasNoLeakingPii(userText)) return { status: "degraded", reason: "pii" }

  const client = d.buildClient({
    session: null,
    appSettings: input.appSettings,
    override: llmSpeak,
    featureId: "pet-chat",
  })
  if (!client) return { status: "degraded", reason: "noClient" }
  if (!d.tryAcquire(input.at)) return { status: "degraded", reason: "rateLimited" }

  const originScope = capturePetScope()
  const memoryOn = input.appSettings?.petSettings?.petMemory?.enabled !== false
  const view = input.view

  // Prompt layers, each degrading independently.
  const historyText = memoryOn ? formatHistoryLines(await loadHistoryForPrompt(d.history)) : ""
  if (!isPetConversationScopeCurrent(originScope)) {
    return { status: "degraded", reason: "empty", invalidated: true }
  }
  const memDeps = await d.loadMemoryDeps(input.appSettings)
  if (!isPetConversationScopeCurrent(originScope)) {
    return { status: "degraded", reason: "empty", invalidated: true }
  }
  const recallText = await d.recall(memDeps ?? undefined, {
    queryText: userText,
    recencyHalfLifeDays: resolveMemoryConfig(input.appSettings?.memory).decayHalfLifeDays,
  })
  if (!isPetConversationScopeCurrent(originScope)) {
    return { status: "degraded", reason: "empty", invalidated: true }
  }

  let persona: string | undefined
  const charId = input.activeCharacterId ?? null
  if (charId) {
    const resolved = await d.resolveCharacterPersona(charId)
    if (resolved && d.hasNoLeakingPii(resolved)) persona = resolved
  }
  if (!isPetConversationScopeCurrent(originScope)) {
    return { status: "degraded", reason: "empty", invalidated: true }
  }

  let raw: string | null
  try {
    raw = await d.chat(client, {
      soul,
      bones: view.effectiveBones,
      userText,
      persona,
      state: {
        mood: view.mood,
        energy: Math.round(view.needs.energy),
        bond: Math.round(view.needs.bond),
        level: input.profile?.level ?? 1,
      },
      historyText: historyText || undefined,
      recallText: recallText || undefined,
      emotionInstruction: true,
      locale: input.locale,
    })
  } catch {
    return { status: "degraded", reason: "error" }
  }

  // Re-check account partition, reset generation, and clear generation after
  // the slow model wait before persisting or returning a reply.
  if (!isPetConversationScopeCurrent(originScope)) {
    return { status: "degraded", reason: "empty", invalidated: true }
  }

  const parsed = raw ? d.parseEmotion(raw) : null
  if (!parsed || !parsed.cleanText) return { status: "degraded", reason: "empty" }

  let persisted = false
  if (memoryOn) {
    const scopedHistory: PetHistoryDeps =
      d.history === HISTORY_DEPS
        ? {
            listRecent: d.history.listRecent,
            append: (row) => appendPetTurn(row, PET_CONVERSATION_CAP, { scope: originScope }),
          }
        : {
            listRecent: d.history.listRecent,
            append: async (row) => {
              if (!isPetConversationScopeCurrent(originScope)) {
                throw new PetScopeInvalidatedError("conversation-cleared")
              }
              return d.history.append(row)
            },
          }
    persisted = await tryRecordTurn(scopedHistory, {
      userText,
      reply: parsed.cleanText,
      at: input.at,
    })
    // If history was cleared, reset, or the account switched mid-transaction,
    // treat the turn as invalidated rather than exposing it ephemerally.
    if (!isPetConversationScopeCurrent(originScope)) {
      return { status: "degraded", reason: "empty", invalidated: true }
    }
  }
  return {
    status: "ok",
    reply: parsed.cleanText,
    emotion: parsed.emotion ? EMOTION_TO_ONESHOT[parsed.emotion] : undefined,
    ...(persisted ? {} : { persisted: false as const }),
  }
}
