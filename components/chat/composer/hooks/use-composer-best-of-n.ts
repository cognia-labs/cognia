"use client"

import { type PreparedBestOfN } from "@/lib/best-of-n/entry"
import { type ChatStatus } from "@/stores/chat/chat-store"
import { type ChatSession } from "@cognia/agent-config-types"
import { type useTranslations } from "next-intl"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

export interface ComposerBestOfNInput {
  session: ChatSession | null | undefined
  disabled: boolean | undefined
  status: ChatStatus
  tBestOfN: ReturnType<typeof useTranslations<"bestOfNEntry">>
}

/**
 * Best-of-N in the composer: the toolbar's run count for this conversation and
 * the start dialog's pending request, which a new request or an unmount
 * resolves as declined.
 */
export function useComposerBestOfN(input: ComposerBestOfNInput) {
  const { session, disabled, status, tBestOfN } = input

  const [bestOfNChoice, setBestOfNChoice] = useState<{ sessionId: string; n: 2 | 3 | 4 } | null>(
    null
  )
  const bestOfNCount =
    bestOfNChoice && bestOfNChoice.sessionId === session?.id ? bestOfNChoice.n : null
  // A stable object and callback, so the memoized toolbar is not re-rendered
  // by a Composer render that changed neither.
  const bestOfNSessionId =
    session?.kind === "direct" && !session.platformBinding ? session.id : null
  const bestOfNControl = useMemo(
    () =>
      bestOfNSessionId
        ? {
            value: bestOfNCount,
            disabled,
            onChange: (n: 2 | 3 | 4 | null) =>
              setBestOfNChoice(n ? { sessionId: bestOfNSessionId, n } : null),
          }
        : undefined,
    [bestOfNSessionId, bestOfNCount, disabled]
  )
  const [bestOfNStart, setBestOfNStart] = useState<{
    prepared: PreparedBestOfN
    resolve(value: boolean): void
  } | null>(null)
  const bestOfNStartRef = useRef(false)
  const requestBestOfN = useCallback(
    async (prompt: string, n: 2 | 3 | 4, agents?: string[]): Promise<boolean> => {
      if (!session?.id || bestOfNStartRef.current) return false
      if (["streaming", "awaiting_approval"].includes(status)) {
        toast.error(tBestOfN("busy"))
        return false
      }
      bestOfNStartRef.current = true
      try {
        const { prepareBestOfNChat } = await import("@/lib/best-of-n/entry")
        const prepared = await prepareBestOfNChat(session.id, prompt, n, agents)
        return await new Promise<boolean>((resolve) => setBestOfNStart({ prepared, resolve }))
      } catch (error) {
        toast.error(
          tBestOfN("failed", { error: error instanceof Error ? error.message : String(error) })
        )
        return false
      } finally {
        bestOfNStartRef.current = false
      }
    },
    [session, status, tBestOfN]
  )
  useEffect(
    () => () => {
      bestOfNStart?.resolve(false)
    },
    [bestOfNStart]
  )
  return {
    requestBestOfN,
    setBestOfNChoice,
    bestOfNCount,
    bestOfNControl,
    bestOfNStart,
    setBestOfNStart,
  }
}
