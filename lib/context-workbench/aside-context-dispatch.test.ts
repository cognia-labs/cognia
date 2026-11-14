import { createAsideContextDispatch } from "./aside-context-dispatch"
import type { UIMessage } from "ai"
import { prepareAsideContext, ASIDE_DELTA_HEADER } from "@/lib/chat/session-aside-context"

const cursor = { parentMessageId: "p1", tailFingerprint: "fingerprint" }

it("acknowledges pinned context only after a successful SDK delivery", async () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({
    id: `p${i}`,
    role: "user",
    parts: [{ type: "text", text: `row ${i}` }],
  })) as UIMessage[]
  const full = prepareAsideContext(messages)
  const saved = { ...full.cursor!, sdkSessionId: "sdk" }
  const delivery = prepareAsideContext(messages, {
    pins: ["p0"],
    cursor: saved,
    resumeSdkSessionId: "sdk",
  })
  const persist = jest.fn().mockResolvedValue(undefined)
  const dispatch = createAsideContextDispatch(delivery.cursor!, persist, "sdk")
  expect(persist).not.toHaveBeenCalled()
  await dispatch.dispatched()
  expect(
    prepareAsideContext(messages, {
      pins: ["p0"],
      cursor: persist.mock.calls[0][0],
      resumeSdkSessionId: "sdk",
    }).context
  ).toBe("")
})

it("persists the bounded snapshot cursor and only acknowledges new rows on a resumed delta", async () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({
    id: `p${i}`,
    role: "user",
    parts: [{ type: "text", text: `row ${i}` }],
  })) as UIMessage[]
  const full = prepareAsideContext(messages)
  expect(full.context).toMatch(/^\[6 earlier messages not included\]/)
  const persist = jest.fn().mockResolvedValue(undefined)
  const dispatch = createAsideContextDispatch(full.cursor!, persist, "sdk")
  await dispatch.dispatched()
  const saved = persist.mock.calls[0][0]
  expect(saved.parentMessageId).toBe("p29")
  const delta = prepareAsideContext(
    [...messages, { id: "new", role: "assistant", parts: [{ type: "text", text: "next" }] }],
    { cursor: saved, resumeSdkSessionId: "sdk" }
  )
  expect(delta.context).toBe("Assistant: next")
  expect(delta.header).toBe(ASIDE_DELTA_HEADER)
  const deltaDispatch = createAsideContextDispatch(delta.cursor!, persist, "sdk")
  await deltaDispatch.dispatched()
  expect(persist).toHaveBeenLastCalledWith({ ...delta.cursor, sdkSessionId: "sdk" })
  expect(persist).toHaveBeenCalledTimes(2)
})

it.each([true, false])(
  "advances only after both dispatch and SDK identity (identity first: %s)",
  async (identityFirst) => {
    const persist = jest.fn().mockResolvedValue(undefined)
    const dispatch = createAsideContextDispatch(cursor, persist)
    if (identityFirst) await dispatch.acknowledgeSdk("sdk")
    else await dispatch.dispatched()
    expect(persist).not.toHaveBeenCalled()
    if (identityFirst) await dispatch.dispatched()
    else await dispatch.acknowledgeSdk("sdk")
    expect(persist).toHaveBeenCalledWith({ ...cursor, sdkSessionId: "sdk" })
    await dispatch.acknowledgeSdk("sdk")
    expect(persist).toHaveBeenCalledTimes(1)
  }
)

it("does not acknowledge context for a rejected dispatch even if an identity arrived", async () => {
  const persist = jest.fn()
  const dispatch = createAsideContextDispatch(cursor, persist, "old")
  await dispatch.acknowledgeSdk("new")
  dispatch.cancel()
  await dispatch.dispatched()
  expect(persist).not.toHaveBeenCalled()
})

it("records the new SDK identity rather than a stale resume id", async () => {
  const persist = jest.fn().mockResolvedValue(undefined)
  const dispatch = createAsideContextDispatch(cursor, persist, "old")
  await dispatch.acknowledgeSdk("new")
  await dispatch.dispatched()
  expect(persist).toHaveBeenCalledWith({ ...cursor, sdkSessionId: "new" })
})

it("ignores a late SDK identity from a replaced turn", async () => {
  const persist = jest.fn().mockResolvedValue(undefined)
  const dispatch = createAsideContextDispatch(cursor, persist, undefined, "current")
  await dispatch.dispatched()
  await dispatch.acknowledgeSdk("stale-sdk", "previous")
  expect(persist).not.toHaveBeenCalled()
  await dispatch.acknowledgeSdk("new-sdk", "current")
  expect(persist).toHaveBeenCalledWith({ ...cursor, sdkSessionId: "new-sdk" })
})
