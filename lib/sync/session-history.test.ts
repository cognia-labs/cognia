/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import {
  setActiveRuntimeTargetContext,
  clearActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  CompanionTransport,
  __setCompanionConfigCacheForTests,
} from "@/lib/tauri/transport-companion"

import {
  __resetHydratedSessionHistoryForTests,
  hydrateSessionHistory,
  readCompleteSessionHistory,
  invalidateSessionHistory,
  getSessionHistoryMode,
} from "./session-history"

function createTransport(call: jest.Mock, capabilities = { version: 1 }): Transport {
  return {
    call: (async (method: string, args?: Record<string, unknown>) => {
      if (method === "transcript_capabilities") return capabilities
      return call(method, args)
    }) as Transport["call"],
    subscribe: () => () => {},
  }
}

/** Drain the microtask queue so an in-flight negotiation reaches its first RPC. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("hydrateSessionHistory", () => {
  beforeEach(async () => {
    __resetHydratedSessionHistoryForTests()
    clearActiveRuntimeTargetContext()
    await getDb().messages.clear()
  })

  it("refuses a new Host scope while the companion still has the previous Host config", async () => {
    setActiveRuntimeTargetContext("acct-history", "host-two", 2)
    __setCompanionConfigCacheForTests({
      baseUrl: "https://host-one.invalid",
      deviceId: "device-one",
      serverVersion: "0.1.0",
      accountId: "acct-history",
      targetId: "host-one",
    })
    const transport = new CompanionTransport()
    const call = jest.spyOn(transport, "call").mockResolvedValue({ version: 1 })
    try {
      await expect(hydrateSessionHistory(transport, "same")).rejects.toMatchObject({
        code: "companion_target_scope_changed",
      })
      await expect(readCompleteSessionHistory(transport, "same")).rejects.toMatchObject({
        code: "companion_target_scope_changed",
      })
      expect(call).not.toHaveBeenCalled()
      expect(await getDb().messages.count()).toBe(0)
      expect(getSessionHistoryMode("same")).toBeNull()

      __setCompanionConfigCacheForTests({
        baseUrl: "https://host-two.invalid",
        deviceId: "device-two",
        serverVersion: "0.1.0",
        accountId: "acct-history",
        targetId: "host-two",
      })
      await expect(hydrateSessionHistory(transport, "same")).resolves.toMatchObject({
        mode: "timeline",
      })
      expect(call).toHaveBeenCalledTimes(2)
    } finally {
      transport.destroy()
      __setCompanionConfigCacheForTests(null)
    }
  })

  it("rechecks companion binding after a pending history RPC without publishing ownership", async () => {
    setActiveRuntimeTargetContext("acct-history", "host-two", 2)
    const config = {
      baseUrl: "https://host-two.invalid",
      deviceId: "device-two",
      serverVersion: "0.1.0",
      accountId: "acct-history",
      targetId: "host-two",
    }
    __setCompanionConfigCacheForTests(config)
    const transport = new CompanionTransport()
    let resolveCapabilities: (value: unknown) => void = () => {}
    const call = jest
      .spyOn(transport, "call")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCapabilities = resolve
          })
      )
      .mockResolvedValue({ version: 1 })
    try {
      const pending = hydrateSessionHistory(transport, "same")
      const outcome = pending.catch((error: unknown) => error)
      __setCompanionConfigCacheForTests({ ...config, targetId: "host-one" })
      resolveCapabilities({ version: 1 })
      await expect(outcome).resolves.toMatchObject({ code: "companion_target_scope_changed" })
      expect(call).toHaveBeenCalledTimes(1)
      expect(getSessionHistoryMode("same")).toBeNull()
    } finally {
      transport.destroy()
      __setCompanionConfigCacheForTests(null)
    }
  })

  it("does not reuse another Host's ownership result for the same session id", async () => {
    const firstHost = createTransport(jest.fn().mockRejectedValue({ code: "SESSION_NOT_FOUND" }), {
      version: 1,
    })
    const secondCall = jest.fn().mockResolvedValue({ items: [] })
    const secondHost = createTransport(secondCall, { version: 1 })
    await hydrateSessionHistory(firstHost, "s1")
    await expect(hydrateSessionHistory(secondHost, "s1")).resolves.toMatchObject({
      mode: "timeline",
    })
    expect(secondCall).toHaveBeenCalledTimes(1)
  })

  it("invalidates completed and pending ownership without accepting stale responses", async () => {
    let resolve: (value: unknown) => void = () => {}
    const call = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      .mockResolvedValue({ items: [] })
    const transport = createTransport(call, { version: 1 })
    const pending = hydrateSessionHistory(transport, "s1")
    await flush()
    invalidateSessionHistory("s1")
    expect(getSessionHistoryMode("s1")).toBeNull()
    resolve({ items: [] })

    // The stale answer is discarded, and the question it was asking is re-put
    // to the Host rather than reported as a failed transcript load.
    await expect(pending).resolves.toMatchObject({ mode: "timeline" })
    expect(call).toHaveBeenCalledTimes(2)
    expect(getSessionHistoryMode("s1")).toBe("timeline")
  })

  // The reported defect: two `session_history_scope_changed` errors on every
  // web boot, and a chat pane left on an error card with an empty transcript.
  // A companion transport publishes `reconnecting` then `connected` while the
  // first pane is already negotiating, and `watchConnection` invalidates on
  // both — so the negotiation that was going to answer "timeline" died, and
  // nothing re-ran it (the mode the pane subscribes to never left `null`).
  it("re-negotiates when the transport settles its own connection mid-flight", async () => {
    let resolveTimeline: (value: unknown) => void = () => {}
    const call = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveTimeline = done
          })
      )
      .mockResolvedValue({ items: [] })
    let connectionChanged: (state: string) => void = () => {}
    const transport = {
      ...createTransport(call, { version: 1 }),
      onConnectionStateChange: (listener: (state: string) => void) => {
        connectionChanged = listener
        return jest.fn()
      },
    }

    const pending = hydrateSessionHistory(transport, "s1")
    await flush()
    connectionChanged("reconnecting")
    connectionChanged("connected")
    resolveTimeline({ items: [] })

    await expect(pending).resolves.toEqual({ applied: 0, total: 0, mode: "timeline" })
    expect(getSessionHistoryMode("s1")).toBe("timeline")
  })

  it("keeps a later caller on the same hydration after a supersession", async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    let resolveSecond: (value: unknown) => void = () => {}
    const call = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveFirst = done
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveSecond = done
          })
      )
    const transport = createTransport(call, { version: 1 })

    const first = hydrateSessionHistory(transport, "s1")
    await flush()
    invalidateSessionHistory("s1")
    resolveFirst({ items: [] })
    await flush()

    expect(hydrateSessionHistory(transport, "s1")).toBe(first)
    resolveSecond({ items: [] })
    await expect(first).resolves.toMatchObject({ mode: "timeline" })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("reports failure rather than re-asking forever when nothing settles", async () => {
    let connectionChanged: (state: string) => void = () => {}
    const call = jest.fn(async () => {
      connectionChanged("reconnecting")
      return { items: [] }
    })
    const transport = {
      ...createTransport(call, { version: 1 }),
      onConnectionStateChange: (listener: (state: string) => void) => {
        connectionChanged = listener
        return jest.fn()
      },
    }

    await expect(hydrateSessionHistory(transport, "s1")).rejects.toThrow(
      "session_history_scope_changed"
    )
    expect(call).toHaveBeenCalledTimes(6)
    expect(getSessionHistoryMode("s1")).toBeNull()
  })

  it("scopes ownership by account and routing generation", async () => {
    const call = jest.fn().mockResolvedValue({ items: [] })
    const transport = createTransport(call, { version: 1 })
    setActiveRuntimeTargetContext("acct-history", "host-one", 1)
    await hydrateSessionHistory(transport, "same")
    setActiveRuntimeTargetContext("acct-history", "host-one", 2)
    expect(getSessionHistoryMode("same")).toBeNull()
    await hydrateSessionHistory(transport, "same")
    setActiveRuntimeTargetContext("acct-second", "host-one", 3)
    await hydrateSessionHistory(transport, "same")
    expect(call).toHaveBeenCalledTimes(3)
  })

  it("does not retry an old Host's negotiation into the new scope", async () => {
    let resolveTimeline: (value: unknown) => void = () => {}
    const call = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveTimeline = resolve
          })
      )
      .mockResolvedValue({ items: [] })
    setActiveRuntimeTargetContext("acct-history", "host-one", 1)
    const pending = hydrateSessionHistory(createTransport(call), "same")
    const outcome = pending.then(
      () => null,
      (error: unknown) => error
    )
    await flush()
    setActiveRuntimeTargetContext("acct-history", "host-two", 2)
    resolveTimeline({ items: [] })

    expect(await outcome).toMatchObject({ message: "session_history_scope_changed" })
    expect(call).toHaveBeenCalledTimes(1)
    expect(getSessionHistoryMode("same")).toBeNull()
  })

  it("does not reclaim ownership from a replacement transport", async () => {
    let resolveOld: (value: unknown) => void = () => {}
    const oldCall = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    const pending = hydrateSessionHistory(createTransport(oldCall, { version: 1 }), "s1")
    const outcome = pending.then(
      () => null,
      (error: unknown) => error
    )
    await flush()
    const nextCall = jest.fn().mockResolvedValue({ items: [] })
    await hydrateSessionHistory(createTransport(nextCall, { version: 1 }), "s1")
    resolveOld({ items: [] })

    expect(await outcome).toMatchObject({ message: "session_history_scope_changed" })
    expect(oldCall).toHaveBeenCalledTimes(1)
    expect(getSessionHistoryMode("s1")).toBe("timeline")
  })

  it("invalidates remote ownership on reconnect and re-negotiates", async () => {
    const call = jest.fn().mockResolvedValue({ items: [] })
    let connectionChanged: (state: string) => void = () => {}
    const transport = {
      ...createTransport(call, { version: 1 }),
      onConnectionStateChange: (listener: (state: string) => void) => {
        connectionChanged = listener
        return jest.fn()
      },
    }
    await hydrateSessionHistory(transport, "s1")
    connectionChanged("reconnecting")
    expect(getSessionHistoryMode("s1")).toBeNull()
    connectionChanged("connected")
    await hydrateSessionHistory(transport, "s1")
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("coalesces concurrent hydration for the same session and caches completion", async () => {
    let resolveTimeline: ((page: { items: never[] }) => void) | undefined
    const call = jest.fn(
      () =>
        new Promise<{ items: never[] }>((resolve) => {
          resolveTimeline = resolve
        })
    )
    const transport = createTransport(call)

    const first = hydrateSessionHistory(transport, "s1")
    const second = hydrateSessionHistory(transport, "s1")

    expect(second).toBe(first)
    await flush()
    expect(call).toHaveBeenCalledTimes(1)
    resolveTimeline?.({ items: [] })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { applied: 0, total: 0, mode: "timeline" },
      { applied: 0, total: 0, mode: "timeline" },
    ])
    await hydrateSessionHistory(transport, "s1")
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("does not hydrate full history when transcript V1 is available", async () => {
    const hostCall = jest.fn(async () => ({ items: [], revision: 0, hasMore: false }))
    const transport = createTransport(hostCall, { version: 1 })

    await expect(hydrateSessionHistory(transport, "s1")).resolves.toEqual({
      applied: 0,
      total: 0,
      mode: "timeline",
    })
    // One newest turn settles ownership.
    expect(hostCall.mock.calls).toEqual([
      ["session_timeline", { session_id: "s1", direction: "backward", limit: 1 }],
    ])
  })

  // The defect: capability was read as ownership, so a conversation this
  // browser created was handed to the host's projection. The host answered
  // that it had no such session and the pane rendered that refusal instead of
  // the transcript sitting in local Dexie.
  it("keeps a session the host has never seen on the local transcript", async () => {
    const hostCall = jest.fn(async () => {
      throw Object.assign(new Error("SESSION_NOT_FOUND"), { code: "SESSION_NOT_FOUND" })
    })
    const transport = createTransport(hostCall, { version: 1 })

    await expect(hydrateSessionHistory(transport, "s1")).resolves.toEqual({
      applied: 0,
      total: 0,
      mode: "local",
    })
    expect(hostCall).toHaveBeenCalledTimes(1)
  })

  it("leaves any other timeline refusal visible rather than guessing an owner", async () => {
    const hostCall = jest.fn(async () => {
      throw Object.assign(new Error("INVALID_PARAMS"), { code: "INVALID_PARAMS" })
    })

    await expect(
      hydrateSessionHistory(createTransport(hostCall, { version: 1 }), "s1")
    ).rejects.toThrow("INVALID_PARAMS")
  })

  it("surfaces a failing capability probe", async () => {
    const transport: Transport = {
      call: jest.fn().mockRejectedValue(new Error("network timeout")) as Transport["call"],
      subscribe: () => () => {},
    }

    await expect(hydrateSessionHistory(transport, "s1")).rejects.toThrow("network timeout")
    expect(getSessionHistoryMode("s1")).toBeNull()
  })

  it("refuses a Host that does not speak transcript V1", async () => {
    const call = jest.fn()
    await expect(
      hydrateSessionHistory(createTransport(call, { version: 2 }), "s1")
    ).rejects.toThrow("invalid transcript capability response")
    expect(call).not.toHaveBeenCalled()
  })
})

describe("readCompleteSessionHistory", () => {
  beforeEach(async () => {
    __resetHydratedSessionHistoryForTests()
    clearActiveRuntimeTargetContext()
    await getDb().messages.clear()
  })

  const session = { id: "s1", title: "Host", createdAt: 1, updatedAt: 2, transcriptRevision: 3 }
  const row = (id: string) => ({
    id,
    sessionId: "s1",
    role: "user",
    parts: [],
    createdAt: 1,
    workingSetSnapshot: { contractVersion: 1, revision: 1, entries: [], updatedAt: 1 },
  })

  it("reads all opaque-token pages without hydrating the local mirror", async () => {
    const call = jest.fn(async (method: string, args?: Record<string, unknown>) => {
      if (method === "session_list") return { items: [session] }
      return args?.pageToken === undefined
        ? { items: [row("older")], total: 2, nextPageToken: "opaque-next" }
        : { items: [row("tail")], total: 2 }
    })
    const result = await readCompleteSessionHistory(createTransport(call), "s1")
    expect(result?.messages.map((message) => message.id)).toEqual(["older", "tail"])
    expect(result?.messages[0].workingSetSnapshot?.revision).toBe(1)
    expect(call).toHaveBeenCalledWith(
      "message_get_by_session",
      expect.objectContaining({ pageToken: "opaque-next" })
    )
    expect(await getDb().messages.count()).toBe(0)
  })

  it.each([
    { items: [row("tail")], total: 2 },
    { items: [row("same"), row("same")], total: 2 },
    { items: [{ ...row("wrong"), sessionId: "other" }], total: 1 },
  ])("refuses incomplete or untrusted history pages %#", async (page) => {
    const call = jest.fn(async (method: string) =>
      method === "session_list" ? { items: [session] } : page
    )
    await expect(readCompleteSessionHistory(createTransport(call), "s1")).rejects.toThrow()
    expect(await getDb().messages.count()).toBe(0)
  })

  it("refuses a changing transcript instead of constructing a mixed snapshot", async () => {
    let reads = 0
    const call = jest.fn(async (method: string) =>
      method === "session_list"
        ? { items: [{ ...session, transcriptRevision: ++reads }] }
        : { items: [row("m")], total: 1 }
    )
    await expect(readCompleteSessionHistory(createTransport(call), "s1")).rejects.toThrow("changed")
  })

  it("returns null only when the authoritative session list has no matching session", async () => {
    const call = jest.fn(async () => ({ items: [] }))
    await expect(readCompleteSessionHistory(createTransport(call), "local")).resolves.toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("propagates host failure instead of treating it as an absent local session", async () => {
    await expect(
      readCompleteSessionHistory(
        createTransport(jest.fn().mockRejectedValue(new Error("offline"))),
        "s1"
      )
    ).rejects.toThrow("offline")
  })

  it("rejects a target switch during paging", async () => {
    const call = jest.fn(async (method: string) => {
      if (method === "session_list") return { items: [session] }
      setActiveRuntimeTargetContext("other-account", "host", 2)
      return { items: [row("m")], total: 1 }
    })
    await expect(readCompleteSessionHistory(createTransport(call), "s1")).rejects.toThrow(
      "scope_changed"
    )
  })

  it("fails explicitly when a complete export exceeds its page bound", async () => {
    const call = jest.fn(async (method: string) =>
      method === "session_list"
        ? { items: [session] }
        : { items: [row("m")], nextPageToken: "more" }
    )
    await expect(
      readCompleteSessionHistory(createTransport(call), "s1", { maxPages: 1 })
    ).rejects.toThrow("page limit")
  })
})
