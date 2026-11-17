/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import type { UseComposerGhostTextResult } from "@/hooks/chat/use-composer-ghost-text"

import type { ComposerTrigger } from "../../composer-trigger"
import { useComposerGhostFeed, type ComposerGhostFeedInput } from "./use-composer-ghost-feed"

function input(extra: Partial<ComposerGhostFeedInput> = {}): ComposerGhostFeedInput {
  return {
    textValue: "hel",
    caret: 3,
    ghost: { feed: jest.fn() } as unknown as UseComposerGhostTextResult,
    trigger: null,
    isStreaming: false,
    props: { disabled: false },
    ...extra,
  }
}

it("feeds the draft with the caret at its end", () => {
  const deps = input()
  renderHook(() => useComposerGhostFeed(deps))
  expect(deps.ghost.feed).toHaveBeenCalledWith("hel", { suppress: false })
})

it("suppresses under a trigger, mid-text, while streaming or disabled", () => {
  for (const extra of [
    { trigger: { kind: "slash" } as ComposerTrigger },
    { caret: 1 },
    { isStreaming: true },
    { props: { disabled: true } },
  ] as Partial<ComposerGhostFeedInput>[]) {
    const deps = input(extra)
    renderHook(() => useComposerGhostFeed(deps))
    expect(deps.ghost.feed).toHaveBeenCalledWith("hel", { suppress: true })
  }
})
