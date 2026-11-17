/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

import type { RouteTargetsState } from "@/hooks/chat/use-route-targets"
import type { SlashCommand } from "@/lib/slash-commands/builtin"
import type { ChatSession } from "@cognia/agent-config-types"

import { useComposerTrigger, type ComposerTriggerInput } from "./use-composer-trigger"

const requestRouteStores = jest.fn()
jest.mock("@/lib/chat/turn-route/snapshot", () => ({
  requestRouteStores: () => requestRouteStores(),
}))

const commands = [{ name: "compact" }, { name: "clear" }] as SlashCommand[]
const noRoutes = { targets: [], options: [] } as unknown as RouteTargetsState

function render(textValue: string, extra: Partial<ComposerTriggerInput> = {}) {
  return renderHook(() =>
    useComposerTrigger({
      textValue,
      caret: textValue.length,
      popoverDismissed: null,
      routes: noRoutes,
      resolvedMentionMode: "combined",
      slashCommands: commands,
      isLinkToken: () => false,
      props: { session: null },
      ...extra,
    })
  ).result.current
}

beforeEach(() => jest.clearAllMocks())

it("opens the command completion on a partial command name", () => {
  const result = render("/co")
  expect(result.trigger?.kind).toBe("slash")
  expect(result.completionTrigger).toBe(result.trigger)
  expect(result.hasCommandPrefix("cl")).toBe(true)
  expect(result.hasCommandPrefix("usr")).toBe(false)
})

it("keeps the trigger but closes the panel inside an argument the command offers nothing for", () => {
  const result = render("/compact some")
  expect(result.trigger?.kind).toBe("slash")
  expect(result.completionTrigger).toBeNull()
})

it("stays shut once dismissed for this token, and in an IM-bound conversation", () => {
  expect(render("/co", { popoverDismissed: { kind: "slash", tokenStart: 0 } }).trigger).toBeNull()
  const bound = { platformBinding: { platform: "lark" } } as unknown as ChatSession
  expect(render("/co", { props: { session: bound } }).trigger).toBeNull()
})

it("offers turn routes only for a bare `@` at the start of the message", () => {
  const target = { handle: "codex", name: "Codex" }
  const routes = {
    targets: [target],
    options: [{ target, lane: { ok: true } }],
  } as unknown as RouteTargetsState

  const leading = render("@", { routes })
  expect(leading.routeOptionsForTrigger).toBe(routes.options)
  expect(requestRouteStores).toHaveBeenCalled()

  const midSentence = render("hello @", { routes })
  expect(midSentence.routeOptionsForTrigger).toBeUndefined()
})
