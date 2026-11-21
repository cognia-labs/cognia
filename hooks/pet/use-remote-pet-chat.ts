// Pet chat with the DESKTOP's pet from a paired device (ADR-0219).
//
// The transcript is not mirrored (`petConversationV2` holds the user's own
// words and stays on the desktop), so this reads it live with `pet_chat_list`
// and sends each turn with `pet_chat_send`, which runs `respondAsPet` on the
// desktop with its settings, PII gate and speak limiter.
//
// A reply can outlive the bridge window: the desktop then answers `pending`
// and records the turn when it lands. The user's text stays on screen as
// pending, with a note that the reply is coming, and the transcript is polled
// a few times until the recorded turn appears. A later refresh (re-entering
// the tab, the window regaining focus) settles it too.
//
// Returns outcomes and never toasts: the remote actions hook decides what the
// user is told.

"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CHAT_TRANSCRIPT_LIMIT } from "@/hooks/pet/use-pet-chat"
import type { PetRemoteClient } from "@/lib/pet/remote/client"
import { livePetRemoteClient } from "@/lib/pet/remote/live-transport"
import type { PetChatLocale, PetRemoteChatTurn } from "@/lib/pet/remote/types"
import type { PetChatDegradeReason } from "@/lib/pet/chat/respond"
import {
  PET_ACTION_OK,
  PET_REMOTE_UNREACHABLE,
  petActionFailed,
  petRemoteRefusalMessage,
  type PetActionOutcome,
} from "@/lib/pet/console/outcome-messages"
import type { PetConversationRow } from "@/types/pet"

/** When to look for a reply the desktop answered `pending`, after sending. */
export const REMOTE_CHAT_PENDING_POLLS_MS: readonly number[] = [3_000, 7_000, 15_000, 30_000]

export interface UseRemotePetChatDeps {
  getClient?: () => PetRemoteClient
  now?: () => number
  pendingPollsMs?: readonly number[]
  newKey?: () => string
}

export interface RemotePetChat {
  /** Undefined until the first list arrives (or a reply is shown). */
  turns: PetConversationRow[] | undefined
  /** The text being sent, or left on screen after a degrade / a pending reply. */
  pending: string | null
  inFlight: boolean
  degradeReason: PetChatDegradeReason | null
  /** The desktop accepted the turn and is still producing the reply. */
  awaitingReply: boolean
  refresh: () => Promise<PetActionOutcome>
  send: (text: string) => Promise<PetActionOutcome>
  clear: () => Promise<PetActionOutcome>
}

interface EphemeralRemoteTurn {
  row: PetConversationRow
  /** Persisted turn ids known when this turn was sent, so an older identical turn never hides it. */
  beforeIds: ReadonlySet<string>
}

interface AwaitingRemoteTurn {
  text: string
  locale: PetChatLocale
  idempotencyKey: string
  sentAt: number
  beforeIds: ReadonlySet<string>
}

const systemNow = () => Date.now()
const defaultNewKey = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `petchat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

function toRow(turn: PetRemoteChatTurn): PetConversationRow {
  return { id: turn.id, at: turn.at, userText: turn.userText, reply: turn.reply }
}

export function useRemotePetChat(
  { enabled, locale, hostId }: { enabled: boolean; locale: PetChatLocale; hostId?: string | null },
  deps: UseRemotePetChatDeps = {}
): RemotePetChat {
  const getClient = deps.getClient ?? livePetRemoteClient
  const now = deps.now ?? systemNow
  const polls = deps.pendingPollsMs ?? REMOTE_CHAT_PENDING_POLLS_MS
  const newKey = deps.newKey ?? defaultNewKey

  const [persistedTurns, setPersistedTurns] = useState<PetConversationRow[] | undefined>(undefined)
  const [ephemeralTurns, setEphemeralTurns] = useState<EphemeralRemoteTurn[]>([])
  const [pending, setPending] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const [degradeReason, setDegradeReason] = useState<PetChatDegradeReason | null>(null)
  const [awaitingReply, setAwaitingReply] = useState(false)

  const inFlightRef = useRef(false)
  const mounted = useRef(true)
  // Monotonic host/clear scope fence: any change in `hostId` or `clear()`
  // increments this so delayed responses from a prior host or pre-clear fetch
  // can never overwrite the current transcript (F4, F22).
  const scopeSeq = useRef(0)
  const refreshSeq = useRef(0)
  const persistedRef = useRef<PetConversationRow[] | undefined>(undefined)
  const awaiting = useRef<AwaitingRemoteTurn | null>(null)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  const stopPolling = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer)
    timers.current.clear()
  }, [])

  useEffect(() => {
    mounted.current = true
    const pendingTimers = timers.current
    return () => {
      mounted.current = false
      scopeSeq.current += 1
      for (const timer of pendingTimers) clearTimeout(timer)
      pendingTimers.clear()
    }
  }, [])

  // Reset host-scoped state whenever the active remote host changes (F22).
  const prevHostId = useRef<string | null | undefined>(hostId)
  useEffect(() => {
    if (prevHostId.current === hostId) return
    prevHostId.current = hostId
    scopeSeq.current += 1
    refreshSeq.current += 1
    awaiting.current = null
    inFlightRef.current = false
    persistedRef.current = undefined
    stopPolling()
    setPersistedTurns(undefined)
    setEphemeralTurns([])
    setPending(null)
    setInFlight(false)
    setDegradeReason(null)
    setAwaitingReply(false)
  }, [hostId, stopPolling])

  const reconcilePersistedRows = useCallback(
    (rows: PetConversationRow[]) => {
      persistedRef.current = rows
      setPersistedTurns(rows)
      // Keep ephemeral successful turns until a newly persisted row (not in
      // `beforeIds`) supersedes them, so memory-off replies survive refresh (F1).
      setEphemeralTurns((prev) =>
        prev.filter(
          (entry) =>
            !rows.some((row) => !entry.beforeIds.has(row.id) && row.userText === entry.row.userText)
        )
      )
      // Legacy-host fallback: a pending turn settles only when a BRAND-NEW row
      // (id absent before the send) arrives with matching text — immune to both
      // older repeated text and cross-device clock skew (F5).
      const waiting = awaiting.current
      if (
        waiting &&
        rows.some((row) => !waiting.beforeIds.has(row.id) && row.userText === waiting.text)
      ) {
        awaiting.current = null
        stopPolling()
        setAwaitingReply(false)
        setPending(null)
      }
    },
    [stopPolling]
  )

  const refresh = useCallback(async (): Promise<PetActionOutcome> => {
    if (!enabled) return PET_ACTION_OK
    const scope = scopeSeq.current
    const ticket = ++refreshSeq.current
    try {
      const page = await getClient().listChat({ pageSize: CHAT_TRANSCRIPT_LIMIT })
      if (!mounted.current || scope !== scopeSeq.current || ticket !== refreshSeq.current) {
        return PET_ACTION_OK
      }
      reconcilePersistedRows(page.items.map(toRow))
      return PET_ACTION_OK
    } catch {
      return petActionFailed("unreachable", PET_REMOTE_UNREACHABLE)
    }
  }, [enabled, getClient, reconcilePersistedRows])

  const pollPendingTurn = useCallback(
    async (scope: number, key: string) => {
      const waiting = awaiting.current
      if (
        !mounted.current ||
        scope !== scopeSeq.current ||
        !waiting ||
        waiting.idempotencyKey !== key
      ) {
        return
      }
      try {
        // Re-query the host with the exact same `idempotencyKey` (F5): a host
        // using HostSemantic intents returns the settled reply/degrade directly
        // even when pet memory is off or clocks are skewed.
        const result = await getClient().sendChat(waiting.text, waiting.locale, {
          idempotencyKey: waiting.idempotencyKey,
        })
        if (
          !mounted.current ||
          scope !== scopeSeq.current ||
          awaiting.current?.idempotencyKey !== key
        ) {
          return
        }
        if (!result.ok) {
          awaiting.current = null
          stopPolling()
          setAwaitingReply(false)
          setPending(null)
          return
        }
        if (result.status === "replied") {
          const settled = waiting
          awaiting.current = null
          stopPolling()
          setAwaitingReply(false)
          setPending(null)
          setEphemeralTurns((prev) => [
            ...prev,
            {
              row: {
                id: `ephemeral:${settled.idempotencyKey}`,
                at: settled.sentAt,
                userText: settled.text,
                reply: result.reply,
              },
              beforeIds: settled.beforeIds,
            },
          ])
          void refresh()
          return
        }
        if (result.status === "degraded") {
          awaiting.current = null
          stopPolling()
          setAwaitingReply(false)
          setDegradeReason(result.reason)
          return
        }
        // Still pending (or older host cached `pending`): check transcript for a new row id.
        await refresh()
      } catch {
        // Transient poll error: let later scheduled polls retry.
      }
    },
    [getClient, refresh, stopPolling]
  )

  const send = useCallback(
    async (raw: string): Promise<PetActionOutcome> => {
      const text = raw.trim()
      if (!enabled || !text || inFlightRef.current) return PET_ACTION_OK
      const scope = scopeSeq.current
      const beforeIds = new Set((persistedRef.current ?? []).map((row) => row.id))
      const idempotencyKey = newKey()
      inFlightRef.current = true
      setInFlight(true)
      setDegradeReason(null)
      setAwaitingReply(false)
      awaiting.current = null
      stopPolling()
      setPending(text)
      const sentAt = now()
      try {
        const result = await getClient().sendChat(text, locale, { idempotencyKey })
        if (!mounted.current || scope !== scopeSeq.current) return PET_ACTION_OK
        if (!result.ok) {
          setPending(null)
          return petActionFailed("refused", petRemoteRefusalMessage(result.refusal))
        }
        if (result.status === "replied") {
          // Kept as an ephemeral turn until `refresh()` confirms a persisted row
          // replaces it; if pet memory is off, it remains visible (F1).
          setEphemeralTurns((prev) => [
            ...prev,
            {
              row: {
                id: `ephemeral:${idempotencyKey}`,
                at: sentAt,
                userText: text,
                reply: result.reply,
              },
              beforeIds,
            },
          ])
          setPending(null)
          void refresh()
          return PET_ACTION_OK
        }
        if (result.status === "degraded") {
          // Kept on screen under the reason, as the desktop console does.
          setDegradeReason(result.reason)
          return PET_ACTION_OK
        }
        awaiting.current = { text, locale, idempotencyKey, sentAt, beforeIds }
        setAwaitingReply(true)
        for (const delay of polls) {
          const timer = setTimeout(() => {
            timers.current.delete(timer)
            void pollPendingTurn(scope, idempotencyKey)
          }, delay)
          timers.current.add(timer)
        }
        return { ok: true, pending: true }
      } catch {
        if (mounted.current && scope === scopeSeq.current) setPending(null)
        return petActionFailed("unreachable", PET_REMOTE_UNREACHABLE)
      } finally {
        if (scope === scopeSeq.current) {
          inFlightRef.current = false
          if (mounted.current) setInFlight(false)
        }
      }
    },
    [enabled, getClient, locale, newKey, now, pollPendingTurn, polls, refresh, stopPolling]
  )

  const clear = useCallback(async (): Promise<PetActionOutcome> => {
    const scopeAtStart = scopeSeq.current
    try {
      const result = await getClient().clearChat()
      if (!result.ok) return petActionFailed("refused", petRemoteRefusalMessage(result.refusal))
      if (mounted.current && scopeAtStart === scopeSeq.current) {
        scopeSeq.current += 1
        refreshSeq.current += 1
        awaiting.current = null
        inFlightRef.current = false
        persistedRef.current = []
        stopPolling()
        setPersistedTurns([])
        setEphemeralTurns([])
        setPending(null)
        setInFlight(false)
        setDegradeReason(null)
        setAwaitingReply(false)
      }
      return PET_ACTION_OK
    } catch {
      return petActionFailed("unreachable", PET_REMOTE_UNREACHABLE)
    }
  }, [getClient, stopPolling])

  const turns = useMemo<PetConversationRow[] | undefined>(() => {
    if (persistedTurns === undefined && ephemeralTurns.length === 0) return undefined
    const persisted = persistedTurns ?? []
    if (ephemeralTurns.length === 0) return persisted
    return [...persisted, ...ephemeralTurns.map((e) => e.row)]
  }, [persistedTurns, ephemeralTurns])

  return { turns, pending, inFlight, degradeReason, awaitingReply, refresh, send, clear }
}
