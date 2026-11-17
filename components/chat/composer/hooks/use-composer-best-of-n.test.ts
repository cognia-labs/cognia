/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"

import { useComposerBestOfN, type ComposerBestOfNInput } from "./use-composer-best-of-n"

const toast = { error: jest.fn() }
jest.mock("sonner", () => ({ toast: { error: (m: string) => toast.error(m) } }))
const prepared = { groupId: "g1" }
const prepareBestOfNChat = jest.fn(async (..._args: unknown[]) => prepared)
jest.mock("@/lib/best-of-n/entry", () => ({
  prepareBestOfNChat: (...args: unknown[]) => prepareBestOfNChat(...args),
}))

const direct = { id: "s1", kind: "direct" } as ChatSession
const tBestOfN = ((key: string) => key) as unknown as ComposerBestOfNInput["tBestOfN"]

function render(extra: Partial<ComposerBestOfNInput> = {}) {
  return renderHook((p: ComposerBestOfNInput) => useComposerBestOfN(p), {
    initialProps: { session: direct, disabled: false, status: "idle", tBestOfN, ...extra },
  })
}

beforeEach(() => jest.clearAllMocks())

it("offers the run count in a direct chat and keeps the choice to that conversation", () => {
  const hook = render()
  expect(hook.result.current.bestOfNControl?.value).toBeNull()

  act(() => hook.result.current.bestOfNControl?.onChange(3))
  expect(hook.result.current.bestOfNCount).toBe(3)

  hook.rerender({
    session: { id: "s2", kind: "direct" } as ChatSession,
    disabled: false,
    status: "idle",
    tBestOfN,
  })
  expect(hook.result.current.bestOfNCount).toBeNull()
})

it("offers no control in an IM-bound or non-direct conversation", () => {
  const bound = {
    id: "s1",
    kind: "direct",
    platformBinding: { platform: "lark" },
  } as unknown as ChatSession
  expect(render({ session: bound }).result.current.bestOfNControl).toBeUndefined()
  expect(
    render({ session: { id: "t", kind: "team" } as ChatSession }).result.current.bestOfNControl
  ).toBeUndefined()
})

it("refuses to start while a turn runs", async () => {
  const hook = render({ status: "streaming" })
  await expect(hook.result.current.requestBestOfN("p", 2)).resolves.toBe(false)
  expect(toast.error).toHaveBeenCalledWith("busy")
  expect(prepareBestOfNChat).not.toHaveBeenCalled()
})

it("holds the prepared run for the start dialog and resolves with its answer", async () => {
  const hook = render()
  let started: Promise<boolean> = Promise.resolve(false)
  act(() => {
    started = hook.result.current.requestBestOfN("compare", 3, ["a"])
  })
  await waitFor(() => expect(hook.result.current.bestOfNStart?.prepared).toBe(prepared))
  expect(prepareBestOfNChat).toHaveBeenCalledWith("s1", "compare", 3, ["a"])

  act(() => hook.result.current.bestOfNStart?.resolve(true))
  await expect(started).resolves.toBe(true)
})

it("declines a pending start when the composer goes away", async () => {
  const hook = render()
  let started: Promise<boolean> = Promise.resolve(true)
  act(() => {
    started = hook.result.current.requestBestOfN("compare", 2)
  })
  await waitFor(() => expect(hook.result.current.bestOfNStart).not.toBeNull())

  hook.unmount()
  await expect(started).resolves.toBe(false)
})
