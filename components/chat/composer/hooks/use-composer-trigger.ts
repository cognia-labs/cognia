"use client"

import type { ComposerInnerProps } from "../../composer"
import { detectTrigger, type ComposerTrigger, type MentionMode } from "../../composer-trigger"
import { hasSlashCompletion } from "../slash-completion"
import { type RouteTargetsState } from "@/hooks/chat/use-route-targets"
import { isLeadingTokenPosition } from "@/lib/chat/turn-route/parse"
import { requestRouteStores } from "@/lib/chat/turn-route/snapshot"
import { type SlashCommand } from "@/lib/slash-commands/builtin"
import { useCallback, useEffect, useMemo } from "react"

export interface ComposerTriggerInput {
  textValue: string
  caret: number
  popoverDismissed: { tokenStart: number; kind: string } | null
  routes: RouteTargetsState
  resolvedMentionMode: MentionMode
  slashCommands: SlashCommand[]
  isLinkToken: (token: string) => boolean
  props: Pick<ComposerInnerProps, "session">
}

/**
 * Which completion the caret is in: the trigger, the narrower one the popover
 * acts on, and the turn routes offered for a leading bare `@`.
 */
export function useComposerTrigger(input: ComposerTriggerInput) {
  const {
    textValue,
    caret,
    popoverDismissed,
    routes,
    resolvedMentionMode,
    slashCommands,
    isLinkToken,
    props,
  } = input

  // Lets `detectTrigger` tell a chained command (`/compact /cl`) from a path
  // argument (`/add-dir /usr/loc`): only a token that could still become a real
  // command name takes the popover anchor.
  const hasCommandPrefix = useCallback(
    (query: string) => slashCommands.some((c) => c.name.startsWith(query)),
    [slashCommands]
  )

  const trigger = useMemo<ComposerTrigger | null>(() => {
    if (props.session?.platformBinding) return null
    const tg = detectTrigger(textValue, caret, {
      mentionMode: resolvedMentionMode,
      hasCommandPrefix,
      isLinkToken,
    })
    if (!tg) return null
    if (
      popoverDismissed &&
      popoverDismissed.kind === tg.kind &&
      popoverDismissed.tokenStart === tg.tokenStart
    ) {
      return null
    }
    return tg
  }, [
    textValue,
    caret,
    popoverDismissed,
    props.session?.platformBinding,
    resolvedMentionMode,
    hasCommandPrefix,
    isLinkToken,
  ])

  // The trigger the COMPLETION PANEL acts on. `trigger` itself stays wider on
  // purpose (the hint bar and ghost-text suppression still want to know which
  // command the caret is in); this one is null whenever the panel has nothing
  // left to offer, and it gates the popover, its keyboard capture and pill
  // delete together. One verdict, so a panel that is not showing can never eat
  // a keystroke — which is how Enter used to overwrite the first command of a
  // chained line instead of sending the message.
  const completionTrigger = useMemo(
    () => (hasSlashCompletion(trigger, slashCommands) ? trigger : null),
    [trigger, slashCommands]
  )
  // Route rows are offered only while the bare `@` being completed is the
  // message's FIRST token — the one position the send path reads a route from
  // — so `@codex` typed mid-sentence is never offered as something that would
  // move the turn. Either the live list or nothing: no new array per keystroke.
  const routeOptionsForTrigger =
    completionTrigger?.kind === "file" &&
    routes.options.length > 0 &&
    isLeadingTokenPosition(textValue, completionTrigger.tokenStart)
      ? routes.options
      : undefined
  // The Squad members section reads the Squad mirror, which boots with the
  // `knowledge-agents` capability — not requested by the chat route on its own
  // in the development profile. Asked for the first time the route rows open,
  // so the members fill in while the user is still choosing.
  const routeRowsOpen = routeOptionsForTrigger !== undefined
  useEffect(() => {
    if (routeRowsOpen) requestRouteStores()
  }, [routeRowsOpen])
  return { trigger, hasCommandPrefix, completionTrigger, routeOptionsForTrigger }
}
