"use client"

import type React from "react"
import { type RouteChipState } from "../../composer-chip-overlay"
import { useLinkFolding } from "./use-link-folding"
import { type TextInputContext } from "@/components/ai-elements/prompt-input"
import { type RouteTargetsState } from "@/hooks/chat/use-route-targets"
import { isHttpUrlToken } from "@/lib/chat/link-token"
import { computeCodeRanges } from "@/lib/chat/template/code-ranges"
import { splitParamSegments } from "@/lib/chat/template/param-segments"
import { parseLeadingRoute } from "@/lib/chat/turn-route/parse"
import { type SlashCommand } from "@/lib/slash-commands/builtin"
import {
  parseSegments,
  splitLinkSegments,
  splitMentionSegments,
  type MentionSegment,
} from "@/lib/slash-commands/parse-segments"
import { type AppSettings } from "@cognia/agent-config-types"
import { useCallback, useMemo } from "react"

export interface ComposerSegmentsInput {
  composerBehavior: AppSettings["composerBehavior"]
  textValue: string
  textInput: TextInputContext
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  setCaret: React.Dispatch<React.SetStateAction<number>>
  routes: RouteTargetsState
  commandMap: Map<string, SlashCommand>
}

/**
 * The composer input split into segments: folded links, the command view submit
 * runs, the overlay's mention/link/parameter pills and the leading route chip's
 * state.
 */
export function useComposerSegments(input: ComposerSegmentsInput) {
  const { composerBehavior, textValue, textInput, textareaRef, setCaret, routes, commandMap } =
    input

  // A pasted URL is FOLDED to its short label in the text, with the full URL
  // held aside (`lib/chat/link-fold.ts`). Every consumer below therefore has to
  // treat a label as a link: the parser (so a command beside one still runs),
  // the overlay (so it paints blue), and the send/clipboard paths (so the URL
  // comes back).
  const linkFolding = useLinkFolding({
    value: textValue,
    setInput: textInput.setInput,
    textareaRef,
    setCaret,
    display: composerBehavior?.linkChips,
  })
  // Destructured so this depends on the PREDICATE, not on the whole hook
  // object: `isFoldedToken` only changes when the folded-link map does, whereas
  // the object also carries `fold`/`onCut`, whose identities track the textarea
  // callbacks. Widening this dep re-ran the `parseSegments` memo hanging off it
  // — and the overlay/trigger memos below it — on every composer render.
  const { isFoldedToken } = linkFolding
  const isLinkToken = useCallback(
    (token: string) => isHttpUrlToken(token) || isFoldedToken(token),
    [isFoldedToken]
  )
  // The `useState` setter behind the hook — referentially stable, so the draft
  // effects can depend on it without re-running on every render.
  const setFoldedLinks = linkFolding.setLinks
  // The MAP, not the hook object: `submit` is the biggest callback in this file
  // and this is the only field of the hook it reads. Depending on the whole
  // object rebuilt it on every render, since `fold`/`onCut` track the textarea
  // callbacks — the same trap the two destructures above exist to avoid.
  const foldedLinks = linkFolding.links

  // Segment the live input for the submit-time command pipeline (`runSegments`)
  // and the `hasCommand` check. NO mentions here — `runSegments` expects the
  // plain command/text view.
  const segments = useMemo(
    () => parseSegments(textValue, (name) => commandMap.has(name), { isLinkToken }),
    [textValue, commandMap, isLinkToken]
  )

  // Which spans of the input are code, so `{{parameter}}` tokens inside a fenced
  // block or an inline span stay ordinary text. `{{ }}` belongs to Vue,
  // Handlebars and Jinja too, and pasting one of those into a prompt is
  // completely ordinary.
  const codeRanges = useMemo(() => computeCodeRanges(textValue), [textValue])

  // The chip overlay's view: derive `@mention` and `{{parameter}}` pills from
  // the already-parsed `segments` (commands pass through, only text is
  // sub-split) so we don't run a second full tokenizer pass over the input on
  // every keystroke.
  const overlaySegments = useMemo(
    // mentions → links → params. Each pass only ever sub-splits TEXT segments,
    // so the order is about which pill wins a shared span: an `@mention` and a
    // link cannot overlap (a link token has no `@` start), and `{{param}}`
    // braces never appear inside a URL run.
    () =>
      splitParamSegments(
        splitLinkSegments(splitMentionSegments(segments), linkFolding.spans),
        codeRanges
      ),
    [segments, codeRanges, linkFolding.spans]
  )
  // The leading `@handle`, read by the very parser the send uses, so the pill
  // is tinted exactly when the turn will be addressed: sky when its runtime can
  // answer, amber when the send would be refused. Every other mention keeps
  // the ordinary chip. The callback is keyed on primitives, so typing past the
  // handle does not hand the overlay a new function.
  const leadingRoute = useMemo(
    () => (routes.targets.length > 0 ? parseLeadingRoute(textValue, routes.targets) : null),
    [textValue, routes.targets]
  )
  const leadingRouteStart = textValue.length - textValue.trimStart().length
  const leadingRouteToken = leadingRoute?.rawToken ?? null
  const leadingRouteHandle = leadingRoute?.target.handle ?? null
  const leadingRouteState = useMemo<RouteChipState | undefined>(() => {
    if (!leadingRouteHandle) return undefined
    const option = routes.options.find(
      (candidate) => candidate.target.handle === leadingRouteHandle
    )
    return option && !option.lane.ok ? "unavailable" : "ready"
  }, [leadingRouteHandle, routes.options])
  const routeState = useCallback(
    (segment: MentionSegment): RouteChipState | undefined =>
      leadingRouteToken && segment.start === leadingRouteStart && segment.raw === leadingRouteToken
        ? leadingRouteState
        : undefined,
    [leadingRouteToken, leadingRouteStart, leadingRouteState]
  )
  return {
    overlaySegments,
    isLinkToken,
    foldedLinks,
    setFoldedLinks,
    segments,
    linkFolding,
    routeState,
  }
}
