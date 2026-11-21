// React shell for the multi-turn pet chat panel. The transcript is the durable
// `petConversation` history read via `useLiveQuery` (read-only — no cold-Dexie
// ReadOnlyError). `send` orchestrates one turn through the pure
// `respondAsPet` and surfaces WHY a turn degraded (the bubble path is silent).
// Main window only — the panel lives on the pet console route.
//
// Optimistic echo: the user's text shows as `pending` while in flight; on a
// successful reply it clears (the recorded turn arrives via the live query); on
// a degrade it STAYS visible under a reason banner so the message isn't lost.

"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocale } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { listRecentPetTurns } from "@/lib/db/pet-conversation"
import { respondAsPet, type PetChatDegradeReason } from "@/lib/pet/chat/respond"
import {
  capturePetScope,
  isPetConversationScopeCurrent,
  onActiveDatabaseChange,
  onPetConversationCleared,
} from "@/lib/pet/runtime/pet-scope"
import { usePetStore } from "@/stores/pet/pet-store"
import { usePetSettingsView } from "@/lib/pet/settings"
import type { PetConversationRow, PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"

/** Newest-N turns shown in the transcript. */
export const CHAT_TRANSCRIPT_LIMIT = 50

export interface UsePetChatArgs {
  profile: PetProfile | undefined
  view: PetView | undefined
  activeCharacterId?: string | null
}

export interface UsePetChatDeps {
  respond?: typeof respondAsPet
  now?: () => number
}

export interface UsePetChat {
  turns: PetConversationRow[]
  /** In-flight (or last-degraded) user text shown optimistically, else null. */
  pending: string | null
  degradeReason: PetChatDegradeReason | null
  inFlight: boolean
  send: (text: string) => Promise<void>
}

export function usePetChat(
  { profile, view, activeCharacterId }: UsePetChatArgs,
  deps: UsePetChatDeps = {}
): UsePetChat {
  const locale = useLocale()
  const appSettings = usePetSettingsView((s) => s)
  const persistedTurns = useLiveQuery(() => listRecentPetTurns(CHAT_TRANSCRIPT_LIMIT), [], [])

  // Ephemeral turns keep successful replies visible when conversation memory is
  // off or a best-effort history append fails (F1). Cleared on transcript clear,
  // pet reset, account switch/lock, or page reload.
  const [ephemeralTurns, setEphemeralTurns] = useState<PetConversationRow[]>([])
  const [pending, setPending] = useState<string | null>(null)
  const [degradeReason, setDegradeReason] = useState<PetChatDegradeReason | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const inFlightRef = useRef(false)
  const mountedRef = useRef(true)
  const clearGenRef = useRef(0)
  const ephemeralSeqRef = useRef(0)

  const respond = deps.respond ?? respondAsPet
  // Stable clock: the `?? (() => Date.now())` fallback would otherwise be a
  // fresh function every render, invalidating `send`'s memoization each time.
  const now = useMemo(() => deps.now ?? (() => Date.now()), [deps.now])

  useEffect(() => {
    mountedRef.current = true
    const resetEphemeral = () => {
      clearGenRef.current += 1
      if (!mountedRef.current) return
      setEphemeralTurns([])
      setPending(null)
      setDegradeReason(null)
    }
    const offClear = onPetConversationCleared(resetEphemeral)
    const offDb = onActiveDatabaseChange(resetEphemeral)
    return () => {
      mountedRef.current = false
      offClear()
      offDb()
    }
  }, [])

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim()
      if (!text || inFlightRef.current) return
      inFlightRef.current = true
      setInFlight(true)
      setDegradeReason(null)
      setPending(text)

      const sentAt = now()
      const startScope = capturePetScope()
      const startClearGen = clearGenRef.current
      try {
        const result = await respond(
          { userText: text, view, profile, appSettings, locale, activeCharacterId, at: sentAt },
          {}
        )
        if (
          !mountedRef.current ||
          clearGenRef.current !== startClearGen ||
          !isPetConversationScopeCurrent(startScope)
        ) {
          return
        }

        if (result.status === "ok") {
          setPending(null)
          if (result.persisted === false) {
            ephemeralSeqRef.current += 1
            const row: PetConversationRow = {
              id: `ephemeral:${sentAt}:${ephemeralSeqRef.current}`,
              at: sentAt,
              userText: text,
              reply: result.reply,
            }
            setEphemeralTurns((prev) => [...prev, row].slice(-CHAT_TRANSCRIPT_LIMIT))
          }
          if (result.emotion) usePetStore.getState().enqueueOneShot(result.emotion)
        } else if (result.invalidated) {
          setPending(null)
          setDegradeReason(null)
        } else {
          // Keep `pending` visible so the failed message isn't lost.
          setDegradeReason(result.reason)
        }
      } catch {
        if (mountedRef.current && clearGenRef.current === startClearGen) {
          setDegradeReason("error")
        }
      } finally {
        inFlightRef.current = false
        if (mountedRef.current) setInFlight(false)
      }
    },
    [view, profile, appSettings, locale, activeCharacterId, respond, now]
  )

  const turns = useMemo(() => {
    const persisted = persistedTurns ?? []
    if (ephemeralTurns.length === 0) return persisted
    if (persisted.length === 0) return ephemeralTurns
    return [...persisted, ...ephemeralTurns]
      .sort((a, b) => a.at - b.at)
      .slice(-CHAT_TRANSCRIPT_LIMIT)
  }, [persistedTurns, ephemeralTurns])

  return { turns, pending, degradeReason, inFlight, send }
}
