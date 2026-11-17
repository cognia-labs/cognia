/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import type { TextInputContext } from "@/components/ai-elements/prompt-input"
import type { RouteTargetsState } from "@/hooks/chat/use-route-targets"
import type { SlashCommand } from "@/lib/slash-commands/builtin"
import type { MentionSegment } from "@/lib/slash-commands/parse-segments"

import { useComposerSegments, type ComposerSegmentsInput } from "./use-composer-segments"

const noRoutes = { targets: [], options: [] } as unknown as RouteTargetsState

function render(textValue: string, extra: Partial<ComposerSegmentsInput> = {}) {
  return renderHook(() =>
    useComposerSegments({
      composerBehavior: undefined,
      textValue,
      textInput: { value: textValue, setInput: jest.fn() } as unknown as TextInputContext,
      textareaRef: { current: null },
      setCaret: jest.fn(),
      routes: noRoutes,
      commandMap: new Map([["deploy", { name: "deploy" } as SlashCommand]]),
      ...extra,
    })
  ).result.current
}

it("splits known commands out of the text for the submit pipeline", () => {
  const { segments } = render("/deploy now")
  expect(segments.map((s) => s.kind)).toContain("command")

  const unknown = render("/nothing here")
  expect(unknown.segments.every((s) => s.kind !== "command")).toBe(true)
})

it("paints mentions and parameters as pills but leaves `{{ }}` inside code alone", () => {
  const { overlaySegments } = render("ask @alice about {{module}} and `{{literal}}`")
  const kinds = overlaySegments.map((s) => s.kind)
  expect(kinds).toContain("mention")
  expect(overlaySegments.filter((s) => s.kind === "param")).toHaveLength(1)
})

it("treats a URL as a link token", () => {
  const { isLinkToken, foldedLinks } = render("see https://example.com")
  expect(isLinkToken("https://example.com")).toBe(true)
  expect(isLinkToken("example")).toBe(false)
  expect(foldedLinks).toBeDefined()
})

it("tints only the leading route mention, by whether its lane can answer", () => {
  const target = { handle: "codex", name: "Codex" }
  const routes = {
    targets: [target],
    options: [{ target, lane: { ok: false } }],
  } as unknown as RouteTargetsState
  const { overlaySegments, routeState } = render("@codex fix it, cc @codex", { routes })
  const mentions = overlaySegments.filter((s): s is MentionSegment => s.kind === "mention")

  expect(routeState(mentions[0])).toBe("unavailable")
  expect(routeState(mentions[1])).toBeUndefined()

  const ready = render("@codex go", {
    routes: {
      targets: [target],
      options: [{ target, lane: { ok: true } }],
    } as unknown as RouteTargetsState,
  })
  const first = ready.overlaySegments.find((s): s is MentionSegment => s.kind === "mention")!
  expect(ready.routeState(first)).toBe("ready")
})
