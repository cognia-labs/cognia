/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import { PERMALINK_HYDRATION_TIMEOUT_MS, useMessagePermalink } from "./use-message-permalink"
import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"

const mockLookup = jest.fn(async (id: string) => ({ id, title: id }))
const mockReveal = jest.fn(async (..._args: unknown[]) => true)
jest.mock("@/lib/db/sessions", () => ({ getSession: (id: string) => mockLookup(id) }))
jest.mock("@/lib/slash-commands/actions/side-chat", () => ({
  revealSideChat: (...args: unknown[]) => mockReveal(...args),
}))

async function renderPermalinkHook<Result, Props>(
  ...args: Parameters<typeof renderHook<Result, Props>>
) {
  let result!: ReturnType<typeof renderHook<Result, Props>>
  await act(async () => {
    result = renderHook(...args)
  })
  return {
    ...result,
    unmount: async () => {
      await act(async () => result.unmount())
    },
    rerender: async (props?: Props) => {
      await act(async () => result.rerender(props))
    },
  }
}

const message = (id: string, role: "user" | "assistant" = "assistant") =>
  ({ id, role, parts: [{ type: "text", text: id }] }) as never

function seedSession(sessionId: string, ids: string[], loading = false) {
  act(() => {
    useChatStore.setState({
      activeSessionId: sessionId,
      messages: ids.map((id) => message(id)),
      messagesLoading: loading,
    })
  })
}

let jump: jest.Mock

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] })
  mockLookup.mockReset().mockImplementation(async (id: string) => ({ id, title: id }))
  mockReveal.mockClear()
  jump = jest.fn(() => true)
  act(() => {
    useChatViewportStore.setState({ jumpToMessage: jump })
    useChatStore.setState({ activeSessionId: null, messages: [], messagesLoading: false })
  })
})

afterEach(() => {
  act(() => {
    useChatViewportStore.setState({ jumpToMessage: null })
  })
  jest.useRealTimers()
})

const params = (search: string) => new URLSearchParams(search)

describe("useMessagePermalink", () => {
  it("does nothing on an ordinary visit", async () => {
    const onConsumed = jest.fn()
    await renderPermalinkHook(() => useMessagePermalink({ params: params(""), onConsumed }))
    expect(jump).not.toHaveBeenCalled()
    expect(onConsumed).not.toHaveBeenCalled()
  })

  it("focuses the linked conversation", async () => {
    const originalSetActive = useChatStore.getState().setActiveSession
    const setActiveSession = jest.spyOn(useChatStore.getState(), "setActiveSession")
    await renderPermalinkHook(() =>
      useMessagePermalink({ params: params("?session=ses_1&message=m1"), onConsumed: jest.fn() })
    )
    expect(setActiveSession).toHaveBeenCalledWith("ses_1")
    setActiveSession.mockRestore()
    useChatStore.setState({ setActiveSession: originalSetActive })
  })

  it("waits for the message to exist before jumping", async () => {
    // A jump fired before hydration is a silent no-op: the list can only reach
    // a row it renders.
    const onConsumed = jest.fn()
    seedSession("ses_1", [], true)
    const { rerender } = await renderPermalinkHook(() =>
      useMessagePermalink({ params: params("?session=ses_1&message=m1"), onConsumed })
    )
    expect(jump).not.toHaveBeenCalled()

    seedSession("ses_1", ["m0", "m1"], false)
    await rerender()

    expect(jump).toHaveBeenCalledWith("m1", undefined, { align: "center" })
    expect(onConsumed).toHaveBeenCalledTimes(1)
  })

  it("keeps waiting while history is loading even if the id happens to be present", async () => {
    const onConsumed = jest.fn()
    seedSession("ses_1", ["m1"], true)
    await renderPermalinkHook(() =>
      useMessagePermalink({ params: params("?session=ses_1&message=m1"), onConsumed })
    )
    expect(jump).not.toHaveBeenCalled()
  })

  it("waits for a message list to register its jump", async () => {
    act(() => useChatViewportStore.setState({ jumpToMessage: null }))
    const onConsumed = jest.fn()
    seedSession("ses_1", ["m1"], false)
    const { rerender } = await renderPermalinkHook(() =>
      useMessagePermalink({ params: params("?session=ses_1&message=m1"), onConsumed })
    )
    expect(onConsumed).not.toHaveBeenCalled()

    act(() => useChatViewportStore.setState({ jumpToMessage: jump }))
    await rerender()
    expect(jump).toHaveBeenCalledWith("m1", undefined, { align: "center" })
  })

  it("consumes the link exactly once, so the user can scroll away", async () => {
    // Leaving the query in place would re-fire the jump on every later render
    // and pin the view to the linked message.
    const onConsumed = jest.fn()
    seedSession("ses_1", ["m1"], false)
    const { rerender } = await renderPermalinkHook(() =>
      useMessagePermalink({ params: params("?session=ses_1&message=m1"), onConsumed })
    )
    await rerender()
    await rerender()
    expect(jump).toHaveBeenCalledTimes(1)
    expect(onConsumed).toHaveBeenCalledTimes(1)
  })

  it("gives up on a link whose conversation never hydrates", async () => {
    // A deleted conversation, or a link from another device. Without a ceiling
    // the hook would stay armed and fire at whatever appeared later.
    const onConsumed = jest.fn()
    seedSession("ses_1", [], true)
    await renderPermalinkHook(() =>
      useMessagePermalink({ params: params("?session=ses_1&message=ghost"), onConsumed })
    )

    act(() => jest.advanceTimersByTime(PERMALINK_HYDRATION_TIMEOUT_MS + 1))
    expect(jump).not.toHaveBeenCalled()
    // Still cleared, so a reload does not replay the dead link.
    expect(onConsumed).toHaveBeenCalledTimes(1)
  })

  it("reports a link that never resolved rather than expiring in silence", async () => {
    const onUnresolved = jest.fn()
    seedSession("ses_1", [], true)
    await renderPermalinkHook(() =>
      useMessagePermalink({
        params: params("?session=ses_1&message=ghost"),
        onConsumed: jest.fn(),
        onUnresolved,
      })
    )

    act(() => jest.advanceTimersByTime(PERMALINK_HYDRATION_TIMEOUT_MS + 1))
    expect(onUnresolved).toHaveBeenCalledTimes(1)
  })

  it("still clears the link when the list refuses the jump, so it can be retried", async () => {
    // The row is in the store but the list cannot reach it. The jump is
    // attempted first, so the refusal is real — but the query is cleared all
    // the same. Keeping it looks like it preserves a retry and does the
    // opposite: re-pushing the identical URL is a router no-op, so the second
    // "Locate in conversation" for one terminal tab did nothing at all.
    jump.mockReturnValue(false)
    const onConsumed = jest.fn()
    const onUnresolved = jest.fn()
    seedSession("ses_1", ["m1"], false)
    await renderPermalinkHook(() =>
      useMessagePermalink({
        params: params("?session=ses_1&message=m1"),
        onConsumed,
        onUnresolved,
      })
    )

    expect(jump).toHaveBeenCalledWith("m1", undefined, { align: "center" })
    expect(onConsumed).toHaveBeenCalledTimes(1)
    expect(onUnresolved).toHaveBeenCalledTimes(1)
  })

  it("re-arms for the same permalink after a refusal, not only once per target", async () => {
    // The retry path end to end: refuse, let the consumer clear the query, then
    // push the same link again. Before the fix the hook stayed disarmed with
    // the query still set, so this second attempt never fired.
    jump.mockReturnValue(false)
    const onConsumed = jest.fn()
    seedSession("ses_1", ["m1"], false)
    const link = "?session=ses_1&message=m1"
    const { rerender } = await renderPermalinkHook(
      ({ search }: { search: string }) =>
        useMessagePermalink({ params: params(search), onConsumed }),
      { initialProps: { search: link } }
    )
    expect(jump).toHaveBeenCalledTimes(1)

    // The consumer strips the query (`router.replace("/")`)…
    await rerender({ search: "" })
    // …and the user clicks "Locate in conversation" again.
    jump.mockReturnValue(true)
    await rerender({ search: link })
    expect(jump).toHaveBeenCalledTimes(2)
  })

  it("stays quiet when the jump lands", async () => {
    const onUnresolved = jest.fn()
    seedSession("ses_1", ["m1"], false)
    await renderPermalinkHook(() =>
      useMessagePermalink({
        params: params("?session=ses_1&message=m1"),
        onConsumed: jest.fn(),
        onUnresolved,
      })
    )

    expect(onUnresolved).not.toHaveBeenCalled()
  })

  it("drops the link when the user navigates to another conversation first", async () => {
    const onConsumed = jest.fn()
    seedSession("ses_1", [], true)
    const { rerender } = await renderPermalinkHook(() =>
      useMessagePermalink({ params: params("?session=ses_1&message=m1"), onConsumed })
    )

    // They moved on; dragging them back would be worse than dropping the link.
    seedSession("ses_2", ["m1"], false)
    await rerender()

    expect(jump).not.toHaveBeenCalled()
    expect(onConsumed).not.toHaveBeenCalled()
  })

  it("arms a second, different link", async () => {
    const onConsumed = jest.fn()
    seedSession("ses_1", ["m1", "m2"], false)
    const { rerender } = await renderPermalinkHook(
      ({ search }) => useMessagePermalink({ params: params(search), onConsumed }),
      { initialProps: { search: "?session=ses_1&message=m1" } }
    )
    expect(jump).toHaveBeenLastCalledWith("m1", undefined, { align: "center" })

    await rerender({ search: "?session=ses_1&message=m2" })
    expect(jump).toHaveBeenLastCalledWith("m2", undefined, { align: "center" })
    expect(jump).toHaveBeenCalledTimes(2)
  })

  it("leaves no timer behind on unmount", async () => {
    seedSession("ses_1", [], true)
    const { unmount } = await renderPermalinkHook(() =>
      useMessagePermalink({ params: params("?session=ses_1&message=m1"), onConsumed: jest.fn() })
    )
    await unmount()
    expect(jest.getTimerCount()).toBe(0)
  })

  it("strips the query itself when no consumer is supplied", async () => {
    window.history.replaceState({}, "", "/?session=ses_1&message=m1")
    seedSession("ses_1", ["m1"], false)
    await renderPermalinkHook(() => useMessagePermalink({ params: params(window.location.search) }))
    expect(jump).toHaveBeenCalledWith("m1", undefined, { align: "center" })
    expect(window.location.search).toBe("")
  })
})

it("consumes an aside permalink by opening its parent and revealing the referenced message", async () => {
  mockLookup.mockImplementation(
    async (id: string) =>
      (id === "aside"
        ? {
            id,
            title: "Aside",
            kind: "resource-workbench",
            surfaceBinding: { kind: "session", sessionId: "parent" },
          }
        : { id, title: "Parent" }) as never
  )
  const onConsumed = jest.fn()
  await renderPermalinkHook(() =>
    useMessagePermalink({ params: params("session=aside&message=target"), onConsumed })
  )
  expect(useChatStore.getState().activeSessionId).toBe("parent")
  expect(mockReveal).toHaveBeenCalledWith("parent", "aside", "target", expect.any(AbortSignal))
  expect(jump).not.toHaveBeenCalled()
  expect(onConsumed).toHaveBeenCalledTimes(1)
})

it("reports an orphaned aside without activating it", async () => {
  mockLookup.mockImplementation(
    async (id: string) =>
      (id === "aside"
        ? {
            id,
            title: "Aside",
            kind: "resource-workbench",
            surfaceBinding: { kind: "session", sessionId: "gone" },
          }
        : undefined) as never
  )
  const onUnresolved = jest.fn()
  await renderPermalinkHook(() =>
    useMessagePermalink({
      params: params("session=aside&message=target"),
      onUnresolved,
      onConsumed: jest.fn(),
    })
  )
  expect(useChatStore.getState().activeSessionId).toBeNull()
  expect(onUnresolved).toHaveBeenCalledTimes(1)
  expect(mockReveal).not.toHaveBeenCalled()
})

it("does not reopen a target after its metadata lookup timed out", async () => {
  let resolve!: (value: { id: string; title: string }) => void
  mockLookup.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const onConsumed = jest.fn()
  const onUnresolved = jest.fn()
  await renderPermalinkHook(() =>
    useMessagePermalink({ params: params("session=late&message=target"), onConsumed, onUnresolved })
  )
  await act(async () => {
    jest.advanceTimersByTime(PERMALINK_HYDRATION_TIMEOUT_MS)
  })
  expect(onUnresolved).toHaveBeenCalledTimes(1)
  await act(async () => resolve({ id: "late", title: "Late" }))
  expect(useChatStore.getState().activeSessionId).toBeNull()
  expect(onConsumed).toHaveBeenCalledTimes(1)
})
