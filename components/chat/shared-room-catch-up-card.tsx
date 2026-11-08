"use client"

/**
 * The catch-up card of a shared room (ADR-0177 batch 5, ADR-0252 §6).
 *
 * Drawn by the message list above the "new messages" line when the room is
 * shared and enough is unread to be worth a summary. It asks nothing until
 * the reader presses "Catch me up"; then one model call
 * (`lib/collab/shared-room-catch-up.ts`) summarises the unread messages,
 * each point citing the messages it comes from, and a citation jumps to its
 * message. The utility model is tried first, then one headless turn over the
 * chat's own transport; with neither, the card says no model is available
 * rather than offering a button that cannot work.
 */

import { useMemo, useRef, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Loader2Icon, SparklesIcon, XIcon } from "lucide-react"

import type { ChatSession } from "@cognia/agent-config-types"
import { Button } from "@/components/ui/button"
import { useClientLiveQuery } from "@/hooks/data"
import { buildHeadlessTurnLlmClient } from "@/lib/ai/headless-turn-llm-client"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import {
  catchUpLines,
  catchUpSharedRoom,
  offersCatchUp,
  type CatchUpMessage,
  type CatchUpPoint,
} from "@/lib/collab/shared-room-catch-up"
import { getSession } from "@/lib/db/sessions"
import { getSettings } from "@/lib/db/settings"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"

type CardState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; points: CatchUpPoint[]; covered: number }
  | { kind: "skipped"; reason: "pii" | "empty" | "no-output" | "no-model" }
  | { kind: "failed" }

/** The language the summary is written in, named the way a model reads it. */
export function catchUpLanguage(locale: string): string {
  return locale.toLowerCase().startsWith("zh") ? "简体中文" : "English"
}

export function SharedRoomCatchUpCard({
  sessionId,
  messages,
  firstUnreadId,
}: {
  sessionId: string
  messages: readonly CatchUpMessage[]
  firstUnreadId: string
}) {
  const t = useTranslations("chatCollaboration.catchUp")
  const locale = useLocale()
  const session = useClientLiveQuery<ChatSession | undefined>(
    () => getSession(sessionId),
    [sessionId],
    undefined
  )
  const lines = useMemo(() => catchUpLines(messages, firstUnreadId), [messages, firstUnreadId])
  const [state, setState] = useState<CardState>({ kind: "idle" })
  const [dismissed, setDismissed] = useState(false)
  const [missing, setMissing] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  if (!session?.collaboration || dismissed || !offersCatchUp(lines)) return null

  const run = async () => {
    const abort = new AbortController()
    abortRef.current = abort
    setState({ kind: "busy" })
    try {
      // The persisted settings, read when asked: the card needs them once.
      const appSettings = await getSettings().catch(() => null)
      if (abort.signal.aborted) return
      const client =
        buildUtilityLlmClient({ session, appSettings, featureId: "shared-room-catch-up" }) ??
        buildHeadlessTurnLlmClient({ session, label: t("runLabel") })
      if (!client) {
        setState({ kind: "skipped", reason: "no-model" })
        return
      }
      const result = await catchUpSharedRoom(lines, {
        client,
        language: catchUpLanguage(locale),
        abortSignal: abort.signal,
      })
      if (abort.signal.aborted) return
      setState(
        result.kind === "summary"
          ? { kind: "done", points: result.points, covered: result.covered }
          : { kind: "skipped", reason: result.reason }
      )
    } catch {
      if (!abort.signal.aborted) setState({ kind: "failed" })
    } finally {
      if (abortRef.current === abort) abortRef.current = null
    }
  }

  const cancel = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setState({ kind: "idle" })
  }

  const jump = (messageId: string) => {
    const jumped = useChatViewportStore.getState().jumpToMessage?.(messageId, undefined, {
      align: "center",
    })
    setMissing(jumped ? null : messageId)
  }

  return (
    <section
      aria-label={t("title")}
      data-testid="shared-room-catch-up"
      data-state={state.kind}
      className="my-2 rounded-xl border border-border/70 bg-muted/40 px-3 py-2 text-sm"
    >
      <div className="flex items-center gap-2">
        <SparklesIcon className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {state.kind === "done"
            ? t("covered", { count: state.covered })
            : t("unread", { count: lines.length })}
        </span>
        {state.kind === "busy" ? (
          <Button type="button" size="sm" variant="ghost" className="h-7" onClick={cancel}>
            <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
            {t("cancel")}
          </Button>
        ) : state.kind === "done" ? null : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7"
            onClick={() => void run()}
            data-testid="shared-room-catch-up-run"
          >
            {state.kind === "idle" ? t("run") : t("retry")}
          </Button>
        )}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("dismiss")}
          onClick={() => {
            cancel()
            setDismissed(true)
          }}
        >
          <XIcon className="size-3.5" aria-hidden />
        </Button>
      </div>

      {state.kind === "done" ? (
        <ul className="mt-2 list-disc space-y-1 pl-5" data-testid="shared-room-catch-up-points">
          {state.points.map((point, index) => (
            <li key={index} className="leading-relaxed">
              {point.segments.map((segment, at) =>
                segment.kind === "text" ? (
                  <span key={at}>{segment.text}</span>
                ) : (
                  <button
                    key={at}
                    type="button"
                    onClick={() => jump(segment.messageId)}
                    aria-label={t("citation", { ordinal: segment.ordinal })}
                    data-testid="shared-room-catch-up-citation"
                    data-message-id={segment.messageId}
                    className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-primary/10 px-1 text-[11px] font-medium text-primary align-baseline hover:bg-primary/20"
                  >
                    {segment.ordinal}
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {state.kind === "skipped" || state.kind === "failed" ? (
        <p className="mt-1 text-xs text-muted-foreground" role="status">
          {t(state.kind === "failed" ? "failed" : `skipped.${state.reason}`)}
        </p>
      ) : null}
      {missing ? (
        <p className="mt-1 text-xs text-muted-foreground" role="status">
          {t("citationMissing")}
        </p>
      ) : null}
      <p className="mt-1 text-[11px] text-muted-foreground/80">{t("note")}</p>
    </section>
  )
}
