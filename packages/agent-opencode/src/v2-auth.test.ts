import type { OpenCodeClient } from "@opencode/client"
import { OpenCodeV2Auth, initialOAuthAnswers, visibleOAuthFields } from "./v2-auth"

function fixture() {
  const attempt = {
    attemptID: "attempt-1",
    url: "https://opencode.ai/device",
    instructions: "Enter ABC",
    mode: "auto" as const,
    time: { created: Date.now(), expires: Date.now() + 60_000 },
  }
  const api = {
    list: jest.fn(async () => ({
      data: [
        {
          id: "opencode",
          name: "OpenCode",
          methods: [{ id: "device", type: "oauth", label: "Console" }],
          connections: [],
        },
      ],
    })),
    oauth: {
      connect: jest.fn(async () => ({ data: attempt })),
      status: jest.fn(async () => ({ data: { status: "pending" } })),
      complete: jest.fn(async () => {}),
      cancel: jest.fn(async () => {}),
    },
  }
  const auth = new OpenCodeV2Auth({ integration: api } as unknown as OpenCodeClient, "/repo")
  return { auth, api, attempt }
}

afterEach(() => jest.useRealTimers())

it("discovers OAuth methods and safe account summaries without reading credentials", async () => {
  const { auth, api } = fixture()
  api.list.mockResolvedValueOnce({
    data: [
      {
        id: "opencode",
        name: "OpenCode",
        methods: [{ id: "device", type: "oauth", label: "Console" }],
        connections: [
          {
            type: "credential",
            id: "a",
            label: "Work",
            method: "oauth",
            status: { status: "needs_auth", message: "Sign in" },
            secret: "must-not-survive",
          },
        ],
      },
    ],
  } as never)
  await auth.refresh()
  expect(auth.getSnapshot().integrations[0]).toMatchObject({
    id: "opencode",
    connections: [{ label: "Work", needsAuth: true }],
  })
  expect(JSON.stringify(auth.getSnapshot())).not.toContain("must-not-survive")
  expect(api.list).toHaveBeenCalledWith({ location: { directory: "/repo" } }, expect.anything())
  auth.dispose()
})

it("polls completion and refreshes service-owned login state", async () => {
  jest.useFakeTimers()
  const { auth, api } = fixture()
  api.oauth.status.mockResolvedValueOnce({ data: { status: "complete" } } as never)
  await auth.start("opencode", "device", {})
  await jest.advanceTimersByTimeAsync(1_000)
  expect(auth.getSnapshot().phase).toBe("complete")
  expect(api.list).toHaveBeenCalledTimes(1)
  expect(api.oauth.connect).toHaveBeenCalledWith(
    { integrationID: "opencode", methodID: "device", answer: {}, location: { directory: "/repo" } },
    expect.anything()
  )
  auth.dispose()
})

it("cancels a late authorization response after dismissal", async () => {
  const { auth, api, attempt } = fixture()
  let resolve!: (value: { data: typeof attempt }) => void
  api.oauth.connect.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    })
  )
  const starting = auth.start("opencode", "device", {})
  await auth.cancel()
  resolve({ data: attempt })
  await starting
  expect(api.oauth.cancel).toHaveBeenCalledWith(
    expect.objectContaining({ attemptID: "attempt-1" }),
    expect.anything()
  )
  expect(auth.getSnapshot().phase).toBe("idle")
  auth.dispose()
})

it("keeps cancellation failures visible and retryable", async () => {
  const { auth, api } = fixture()
  await auth.start("opencode", "device", {})
  api.oauth.cancel.mockRejectedValueOnce(new Error("offline"))
  expect(await auth.cancel()).toBe(false)
  expect(auth.getSnapshot()).toMatchObject({ phase: "pending", error: "cancel" })
  expect(await auth.cancel()).toBe(true)
  auth.dispose()
})

it("rejects unsafe authorization URLs and cleans up the attempt", async () => {
  const { auth, api, attempt } = fixture()
  api.oauth.connect.mockResolvedValueOnce({ data: { ...attempt, url: "javascript:alert(1)" } })
  await auth.start("opencode", "device", {})
  expect(auth.getSnapshot().error).toBe("invalidUrl")
  expect(api.oauth.cancel).toHaveBeenCalledTimes(1)
  auth.dispose()
})

it("preserves form defaults and filters conditional fields", () => {
  const fields = [
    { key: "server", type: "string" as const, hidden: true, default: "https://opencode.ai" },
    {
      key: "org",
      type: "string" as const,
      when: [{ key: "enterprise", op: "eq" as const, value: true }],
    },
  ]
  expect(initialOAuthAnswers(fields)).toEqual({ server: "https://opencode.ai" })
  expect(visibleOAuthFields(fields, {}).map((field) => field.key)).toEqual(["server"])
})

it("coalesces repeated cancellation and disposal into one remote request", async () => {
  const { auth, api } = fixture()
  await auth.start("opencode", "device", {})
  let finish!: () => void
  api.oauth.cancel.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  const first = auth.cancel()
  const second = auth.cancel()
  auth.dispose()
  expect(first).toBe(second)
  expect(api.oauth.cancel).toHaveBeenCalledTimes(1)
  finish()
  expect(await first).toBe(true)
})

it("reports an unavailable discovery result without showing stale connected accounts", async () => {
  const { auth, api } = fixture()
  await auth.refresh()
  api.list.mockRejectedValueOnce(new Error("offline"))
  await auth.refresh()
  expect(auth.getSnapshot()).toMatchObject({ integrations: [], error: "load" })
  auth.dispose()
})

it.each(["failed", "expired"] as const)("makes %s authorization retryable", async (status) => {
  const { auth, api } = fixture()
  await auth.start("opencode", "device", {})
  api.oauth.status.mockResolvedValueOnce({ data: { status } } as never)
  await auth.check()
  expect(auth.getSnapshot()).toMatchObject({ phase: "idle", error: status })
  expect(auth.getSnapshot().attempt).toBeUndefined()
  auth.dispose()
})

it("keeps a failed status check retryable without starting another authorization", async () => {
  const { auth, api } = fixture()
  await auth.start("opencode", "device", {})
  api.oauth.status.mockRejectedValueOnce(new Error("offline"))
  await auth.check()
  expect(auth.getSnapshot()).toMatchObject({ phase: "pending", error: "status" })
  api.oauth.status.mockResolvedValueOnce({ data: { status: "complete" } } as never)
  await auth.check()
  expect(auth.getSnapshot().phase).toBe("complete")
  expect(api.oauth.connect).toHaveBeenCalledTimes(1)
  auth.dispose()
})

it("does not publish a status response from an attempt disposed during a service switch", async () => {
  const { auth, api } = fixture()
  await auth.start("opencode", "device", {})
  let resolve!: (value: { data: { status: string } }) => void
  api.oauth.status.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    }) as never
  )
  const checking = auth.check()
  const listener = jest.fn()
  auth.subscribe(listener)
  auth.dispose()
  resolve({ data: { status: "complete" } })
  await checking
  expect(listener).not.toHaveBeenCalled()
  expect(api.list).not.toHaveBeenCalled()
})

it("ignores an older in-flight poll when submitting a code completes the attempt", async () => {
  const { auth, api } = fixture()
  await auth.start("opencode", "device", {})
  let resolve!: (value: { data: { status: string } }) => void
  api.oauth.status.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    }) as never
  )
  const previous = auth.check()
  api.oauth.status.mockResolvedValueOnce({ data: { status: "complete" } } as never)
  await auth.complete("submitted-code")
  resolve({ data: { status: "pending" } })
  await previous
  expect(auth.getSnapshot().phase).toBe("complete")
  expect(api.oauth.complete).toHaveBeenCalledTimes(1)
  auth.dispose()
})
