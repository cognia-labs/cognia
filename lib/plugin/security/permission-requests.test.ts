/**
 * Tests for Plugin Permission Requests queue
 */

import {
  requestPluginPermission,
  resolvePluginPermission,
  subscribePermissionRequests,
  clearPermissionRequests,
} from "./permission-requests"
import { isHeadlessHost } from "@/lib/platform/detect"

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isHeadlessHost: jest.fn(() => false),
}))

describe("permission-requests", () => {
  beforeEach(() => {
    clearPermissionRequests()
    ;(isHeadlessHost as jest.Mock).mockReturnValue(false)
  })

  it.each(["manifest", "api"] as const)(
    "H01: immediately denies %s requests on Headless without enqueueing",
    async (kind) => {
      ;(isHeadlessHost as jest.Mock).mockReturnValue(true)
      const listener = jest.fn()
      const unsubscribe = subscribePermissionRequests(listener)
      listener.mockClear()
      let result: boolean | undefined
      const pending = requestPluginPermission({
        pluginId: "headless-plugin",
        permission: "shell:execute",
        kind,
      }).then((value) => {
        result = value
      })
      try {
        await Promise.resolve()
        expect(result).toBe(false)
        await pending
        expect(listener).not.toHaveBeenCalled()
      } finally {
        unsubscribe()
        clearPermissionRequests()
      }
    }
  )

  it("H01: retains an interactive request until its dialog mounts after boot", async () => {
    const request = requestPluginPermission({
      pluginId: "interactive-plugin",
      permission: "shell:execute",
      kind: "api",
    })
    const listener = jest.fn()
    const unsubscribe = subscribePermissionRequests(listener)
    try {
      const state = listener.mock.calls[0][0]
      expect(state.current?.pluginId).toBe("interactive-plugin")
      resolvePluginPermission(state.current.id, true)
      await expect(request).resolves.toBe(true)
    } finally {
      unsubscribe()
      clearPermissionRequests()
    }
  })

  it("B02: clearing the queue denies both current and queued requests", async () => {
    const resolved: boolean[] = []
    const first = requestPluginPermission({
      pluginId: "a",
      permission: "filesystem:read",
      kind: "api",
    }).then((value) => resolved.push(value))
    const second = requestPluginPermission({
      pluginId: "b",
      permission: "network:fetch",
      kind: "api",
    }).then((value) => resolved.push(value))
    clearPermissionRequests()
    await Promise.resolve()
    expect(resolved).toEqual([false, false])
    await Promise.all([first, second])
  })

  it("B02: stale approval IDs cannot resolve a new profile's prompt", async () => {
    let currentId: string | undefined
    const unsubscribe = subscribePermissionRequests((state) => {
      currentId = state.current?.id
    })
    try {
      const old = requestPluginPermission({
        pluginId: "a",
        permission: "filesystem:read",
        kind: "api",
      })
      const staleId = currentId!
      clearPermissionRequests()
      await expect(old).resolves.toBe(false)
      const next = requestPluginPermission({
        pluginId: "a",
        permission: "filesystem:read",
        kind: "api",
      })
      const nextId = currentId!
      resolvePluginPermission(staleId, true)
      expect(currentId).toBe(nextId)
      resolvePluginPermission(nextId, false)
      await expect(next).resolves.toBe(false)
    } finally {
      unsubscribe()
      clearPermissionRequests()
    }
  })

  it("should resolve a single permission request", async () => {
    const updates: Array<{ current: string | null; queue: number }> = []
    const unsubscribe = subscribePermissionRequests((state) => {
      updates.push({
        current: state.current?.id ?? null,
        queue: state.queue.length,
      })
    })

    const requestPromise = requestPluginPermission({
      pluginId: "plugin-a",
      permission: "session:read",
      reason: "Need session access",
      kind: "api",
    })

    const currentId = updates[updates.length - 1]?.current
    expect(currentId).toBeTruthy()
    expect(updates[updates.length - 1]?.queue).toBe(0)

    resolvePluginPermission(currentId!, true)
    const result = await requestPromise

    expect(result).toBe(true)
    expect(updates[updates.length - 1]?.current).toBeNull()

    unsubscribe()
  })

  it("should dequeue requests in order", async () => {
    const states: Array<{ current: string | null; queue: number }> = []
    const unsubscribe = subscribePermissionRequests((state) => {
      states.push({
        current: state.current?.id ?? null,
        queue: state.queue.length,
      })
    })

    const firstPromise = requestPluginPermission({
      pluginId: "plugin-a",
      permission: "session:read",
      kind: "api",
    })
    const firstId = states[states.length - 1]?.current

    const secondPromise = requestPluginPermission({
      pluginId: "plugin-b",
      permission: "session:write",
      kind: "api",
    })

    expect(states[states.length - 1]?.queue).toBe(1)

    resolvePluginPermission(firstId!, false)
    const firstResult = await firstPromise
    expect(firstResult).toBe(false)

    const secondId = states[states.length - 1]?.current
    expect(secondId).toBeTruthy()

    resolvePluginPermission(secondId!, true)
    const secondResult = await secondPromise
    expect(secondResult).toBe(true)

    unsubscribe()
  })
})
