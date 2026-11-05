/**
 * `ctx.issues`: the plugin face of the tracker. The service is mocked, so
 * what is pinned here is the gate map, the actor stamp, and how a patch
 * becomes board actions.
 */
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"

const mockResolve = jest.fn(async (_ref: string): Promise<unknown> => undefined)
const mockCreate = jest.fn(async (req: unknown) => ({
  id: "n",
  identifier: "MERC-9",
  externalKeys: [],
  ...(req as object),
}))
const mockQuery = jest.fn(async (_q: unknown): Promise<unknown[]> => [])
const mockApply = jest.fn(
  async (
    ..._a: Parameters<typeof import("@/lib/issues/service").applyIssueAction>
  ): ReturnType<typeof import("@/lib/issues/service").applyIssueAction> => ({
    applied: 1,
    skipped: 0,
    failed: 0,
  })
)
jest.mock("@/lib/issues/service", () => {
  const actual = jest.requireActual("@/lib/issues/service")
  return {
    ...actual,
    resolveIssue: (ref: string) => mockResolve(ref),
    createIssueRecord: (req: unknown) => mockCreate(req),
    queryIssues: (q: unknown) => mockQuery(q),
    applyIssueAction: (...a: Parameters<typeof mockApply>) => mockApply(...a),
  }
})
const mockListEvents = jest.fn(async (_q: unknown) => [{ id: "e1" }])
jest.mock("@/lib/db/issue-events", () => ({ listIssueEvents: (q: unknown) => mockListEvents(q) }))
jest.mock("@/lib/issues/sync/apply", () => ({
  ensureIssueLabels: async (names: readonly string[]) =>
    names.map((name) => ({ id: `l:${name}`, name })),
}))
jest.mock("@/lib/db/labels", () => ({ listLabels: async () => [{ id: "l:bug", name: "Bug" }] }))
const mockRegister = jest.fn((_p: unknown) => () => {})
jest.mock("@/lib/issues/sync/registry", () => ({
  registerIssueSyncProvider: (p: unknown) => mockRegister(p),
}))
const guarded = jest.fn()
const mockHasWrite = jest.fn(() => true)
jest.mock("./sync-api", () => ({
  assertSyncConnection: jest.fn(async (_id, _ref, check) => check()),
}))
jest.mock("@/lib/plugin/security/permission-guard", () => ({
  getPermissionGuard: () => ({ check: (...args: unknown[]) => mockHasWrite(...(args as [])) }),
  createGuardedAPI: (_id: string, api: unknown, map: Record<string, string>) => {
    guarded(map)
    return api
  },
}))

import { emitIssueEvent } from "@/lib/issues/event-bus"
import type { IssueEvent } from "@/types/issues"
import { createIssuesAPI, pluginIssueActor } from "./issues-api"
import { assertSyncConnection } from "./sync-api"

const issue = { id: "i1", identifier: "MERC-1", projectId: "w1", externalKeys: ["k"] }

beforeEach(() => {
  jest.clearAllMocks()
  mockHasWrite.mockReturnValue(true)
  mockResolve.mockResolvedValue(issue)
  jest.mocked(assertSyncConnection).mockImplementation(async (_id, _ref, check) => check())
})

describe("createIssuesAPI", () => {
  it("retries authorization on prepare after the same connection's grant is restored", async () => {
    let granted = false
    jest.mocked(assertSyncConnection).mockImplementation(async (_id, _ref, check) => {
      check()
      if (!granted) throw new Error("Sync consumer grant required")
    })
    const api = createIssuesAPI("restored", {
      id: "restored",
      issueSyncProviders: [{ id: "tracker", label: "Tracker", schemaVersion: 1 }],
    })
    const pull = jest.fn(async () => ({ items: [], notModified: true }))
    api.registerSyncProvider({
      id: "tracker",
      label: "Tracker",
      connectionRef: "same-connection" as never,
      pullFields: [],
      pushFields: [],
      resource: {
        label: "Tracker",
        schemaVersion: 1,
        schema: { type: "object", properties: {} },
        describe: () => ({ key: "a", label: "A" }),
      },
      pull,
    })
    const registered = mockRegister.mock
      .calls[0][0] as import("@/lib/issues/sync/types").IssueSyncProvider
    const binding = { resource: { kind: "plugin" } } as never
    await expect(registered.prepare!(binding)).rejects.toThrow(/grant/)
    granted = true
    const prepared = await registered.prepare!(binding)
    expect(prepared.connectionRef).toBe("same-connection")
    await expect(prepared.provider.pull(binding, {})).resolves.toMatchObject({ notModified: true })
    expect(pull).toHaveBeenCalledTimes(1)
    expect(mockRegister).toHaveBeenCalledTimes(1)
  })
  it("grant-checks an immutable connection before registration execution and every read", async () => {
    const api = createIssuesAPI("bound", {
      id: "bound",
      issueSyncProviders: [{ id: "tracker", label: "Tracker", schemaVersion: 1 }],
    })
    const input = {
      id: "tracker",
      label: "Tracker",
      connectionRef: "connection" as never,
      pullFields: [],
      pushFields: [],
      resource: {
        label: "Tracker",
        schemaVersion: 1,
        schema: { type: "object" as const, properties: {} },
        describe: () => ({ key: "a", label: "A" }),
      },
      pull: jest.fn(async () => ({ items: [], notModified: true })),
      pullPage: jest.fn(async () => ({ items: [], cursor: "next" })),
      confirmDeparted: jest.fn(async () => ["one"]),
      push: jest.fn(async () => ({ status: "applied" as const })),
      create: jest.fn(async () => ({ provider: "tracker", externalId: "one" })),
    }
    api.registerSyncProvider(input)
    const registered = mockRegister.mock
      .calls[0][0] as import("@/lib/issues/sync/types").IssueSyncProvider
    input.connectionRef = "changed" as never
    expect(registered.connectionRef).toBe("connection")
    expect(() => Object.assign(registered, { connectionRef: "changed" })).toThrow()
    const b = { resource: { kind: "plugin" } } as never
    expect((await registered.prepare!(b)).connectionRef).toBe("connection")
    expect(assertSyncConnection).toHaveBeenCalledWith("bound", "connection", expect.any(Function))
    input.pull.mockImplementationOnce(async (...args: unknown[]) => {
      const pluginBinding = args[0] as { connectionRef?: string }
      pluginBinding.connectionRef = "other-granted-ref"
      return { items: [], notModified: true }
    })
    const stableBinding = { connectionRef: "connection", resource: { kind: "plugin" } } as never
    await expect(registered.pull(stableBinding, {})).rejects.toThrow()
    expect(stableBinding).toMatchObject({ connectionRef: "connection" })
    input.pull.mockClear()
    jest.mocked(assertSyncConnection).mockRejectedValue(new Error("Sync consumer grant required"))
    await expect(registered.pull(b, {})).rejects.toThrow(/grant/)
    expect(input.pull).not.toHaveBeenCalled()
    await expect(registered.pullPage!(b, { mode: "full" })).rejects.toThrow(/grant/)
    await expect(registered.confirmDeparted!(b, ["one"], {})).rejects.toThrow(/grant/)
    await expect(
      registered.push!(b, {} as never, {}, {} as never, {
        by: { kind: "human" },
        idempotencyKey: "one",
      })
    ).rejects.toThrow(/grant/)
    await expect(registered.create!(b, {} as never)).rejects.toThrow(/grant/)
    expect(input.pullPage).not.toHaveBeenCalled()
    expect(input.confirmDeparted).not.toHaveBeenCalled()
    expect(input.push).not.toHaveBeenCalled()
    expect(input.create).not.toHaveBeenCalled()
  })
  it("gates every method, reads and subscriptions on issue:read, the rest on issue:write", () => {
    const api = createIssuesAPI("p")
    const map = guarded.mock.calls[0][0] as Record<string, string>
    expect(Object.keys(map).sort()).toEqual(Object.keys(api).sort())
    expect(map.get).toBe("issue:read")
    expect(map.onEvent).toBe("issue:read")
    expect(map.create).toBe("issue:write")
    expect(map.registerSyncProvider).toBe("issue:write")
  })

  it("stamps the plugin as the actor on creates and actions", async () => {
    const api = createIssuesAPI("acme")
    const created = await api.create({ title: "x" })
    expect(mockCreate).toHaveBeenCalledWith({ title: "x", by: pluginIssueActor("acme") })
    expect("externalKeys" in created).toBe(false)
    await api.comment("MERC-1", " hi ")
    expect(mockApply).toHaveBeenCalledWith(
      issue,
      { kind: "comment", body: "hi" },
      pluginIssueActor("acme")
    )
  })

  it("turns a patch into ordered board actions and sums the outcomes", async () => {
    const api = createIssuesAPI("p")
    mockApply.mockResolvedValueOnce({ applied: 1, skipped: 0, failed: 0 })
    mockApply.mockResolvedValueOnce({ applied: 0, skipped: 1, failed: 0 })
    const out = await api.update("MERC-1", { status: "done", cycleId: null })
    expect(mockApply.mock.calls.map((c) => (c[1] as { kind: string }).kind)).toEqual([
      "status",
      "cycle",
    ])
    expect(out).toEqual({ applied: 1, skipped: 1, failed: 0 })
    await expect(api.update("MERC-1", {})).rejects.toThrow(/Nothing/)
    await expect(api.update("MERC-1", { status: "closed" })).rejects.toThrow(/status/)
  })

  it("stages and triages through board actions, refusing illegal values", async () => {
    const api = createIssuesAPI("p")
    await api.update("MERC-1", { stage: 2, triage: "pending" })
    await api.update("MERC-1", { stage: null, triage: null })
    expect(mockApply.mock.calls.map((c) => c[1])).toEqual([
      { kind: "stage", to: 2 },
      { kind: "triage", to: "pending" },
      { kind: "stage", to: null },
      { kind: "triage", to: null },
    ])
    mockApply.mockClear()
    await expect(api.update("MERC-1", { stage: 0 })).rejects.toThrow(/Stage/)
    await expect(api.update("MERC-1", { triage: "later" as unknown as "pending" })).rejects.toThrow(
      /triage/
    )
    expect(mockApply).not.toHaveBeenCalled()
  })

  it("refuses a malformed action from plugin code before anything applies", async () => {
    const api = createIssuesAPI("p")
    await expect(api.assign("MERC-1", { kind: "robot", id: "r" } as never)).rejects.toThrow(
      /invalid to/
    )
    expect(mockApply).not.toHaveBeenCalled()
  })

  it("returns null for an unknown ref on get, and throws on writes", async () => {
    const api = createIssuesAPI("p")
    mockResolve.mockResolvedValue(undefined)
    expect(await api.get("MERC-404")).toBeNull()
    await expect(api.assign("MERC-404", null)).rejects.toThrow(/No issue/)
  })

  it("labels by name, reads the trail newest first, and registers a sync provider", async () => {
    const api = createIssuesAPI("p", {
      id: "p",
      issueSyncProviders: [{ id: "acme-tracker", label: "Acme", schemaVersion: 1 }],
    })
    await api.label("MERC-1", { add: ["Docs"], remove: ["bug"] })
    expect(mockApply.mock.calls.map((c) => c[1])).toEqual([
      { kind: "addLabel", labelId: "l:Docs" },
      { kind: "removeLabel", labelId: "l:bug" },
    ])
    await api.listEvents("MERC-1", 5)
    expect(mockListEvents).toHaveBeenCalledWith({ issueId: "i1", descending: true, limit: 5 })
    const provider = {
      id: "acme-tracker",
      label: "Acme",
      pullFields: [],
      pushFields: [],
      resource: {
        label: "Acme",
        schemaVersion: 1,
        schema: { type: "object" as const, properties: {} },
        describe: () => ({ key: "a", label: "a" }),
      },
      pull: async () => ({ items: [], notModified: true }),
    }
    api.registerSyncProvider(provider)
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "plugin:p/acme-tracker",
        resource: expect.objectContaining({ kind: "plugin" }),
      })
    )
    expect(() => api.registerSyncProvider({ ...provider, id: "undeclared" })).toThrow(/declared/)
    expect(() => api.registerSyncProvider({ id: " " } as never)).toThrow(/id/)
    mockHasWrite.mockReturnValue(false)
    expect(() => api.registerSyncProvider(provider)).toThrow(/issue:write/)
    mockHasWrite.mockReturnValue(true)
    expect(() =>
      api.registerSyncProvider({
        ...provider,
        resource: { ...provider.resource, schemaVersion: 2 },
      })
    ).toThrow(/manifest/)
    expect(() =>
      api.registerSyncProvider({
        ...provider,
        resource: {
          ...provider.resource,
          schema: { type: "object", properties: { connectionRef: { type: "string" } } },
        },
      })
    ).toThrow(/portable/)
  })

  it("delivers bus events to a subscriber until disposed", () => {
    const api = createIssuesAPI("p")
    const seen: string[] = []
    const off = api.onEvent((e) => seen.push(e.id), { kinds: ["commented"] })
    const event = {
      id: "e1",
      issueId: "i1",
      kind: "commented",
      ts: 1,
      payload: { kind: "commented" },
    } as unknown as IssueEvent
    emitIssueEvent(event)
    emitIssueEvent({ ...event, id: "e2", kind: "created" } as IssueEvent)
    off()
    emitIssueEvent({ ...event, id: "e3" })
    expect(seen).toEqual(["e1"])
  })

  it("drops results when issue:write is revoked during pull or push", async () => {
    const api = createIssuesAPI("revoked", {
      id: "revoked",
      issueSyncProviders: [{ id: "tracker", label: "Tracker", schemaVersion: 1 }],
    })
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    api.registerSyncProvider({
      id: "tracker",
      label: "Tracker",
      pullFields: [],
      pushFields: [],
      resource: {
        label: "Tracker",
        schemaVersion: 1,
        schema: { type: "object", properties: {} },
        describe: () => ({ key: "a", label: "A" }),
      },
      pull: async () => {
        await pending
        return { items: [], notModified: true }
      },
      completeFullScan: true,
      fullScanOnly: true,
      pullPage: async () => {
        await pending
        return { items: [], cursor: "next" }
      },
      confirmDeparted: async () => {
        await pending
        return ["removed"]
      },
      push: async () => {
        await pending
        return { status: "applied", remoteUpdatedAt: 9999 }
      },
    })
    const registered = mockRegister.mock
      .calls[0][0] as import("@/lib/issues/sync/types").IssueSyncProvider
    const pulled = registered.pull({} as never, {})
    const paged = registered.pullPage!({} as never, { mode: "full" })
    const confirmed = registered.confirmDeparted!({} as never, ["removed"], {})
    const pushed = registered.push!({} as never, {} as never, {}, {} as never, {
      idempotencyKey: "test",
      by: { kind: "human" },
    })
    mockHasWrite.mockReturnValue(false)
    finish()
    await expect(pulled).rejects.toThrow(/issue:write/)
    await expect(paged).rejects.toThrow(/issue:write/)
    await expect(confirmed).rejects.toThrow(/issue:write/)
    await expect(pushed).rejects.toThrow(/issue:write/)
  })

  it("drops paged results after cancellation or provider disposal", async () => {
    const api = createIssuesAPI("paged", {
      id: "paged",
      issueSyncProviders: [{ id: "tracker", label: "Tracker", schemaVersion: 1 }],
    })
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const input = {
      id: "tracker",
      label: "Tracker",
      pullFields: [],
      pushFields: [],
      resource: {
        label: "Tracker",
        schemaVersion: 1,
        schema: { type: "object" as const, properties: {} },
        describe: () => ({ key: "one", label: "One" }),
      },
      pull: async () => ({ items: [], notModified: true }),
      pullPage: jest.fn(async () => {
        await pending
        return { items: [], cursor: "next" }
      }),
      confirmDeparted: jest.fn(async () => {
        await pending
        return ["removed"]
      }),
      completeFullScan: true,
      fullScanOnly: true,
    }
    const dispose = api.registerSyncProvider(input)
    const registered = mockRegister.mock
      .calls[0][0] as import("@/lib/issues/sync/types").IssueSyncProvider
    const controller = new AbortController()
    const cancelled = registered.pullPage!({} as never, { mode: "full", signal: controller.signal })
    const cancelledConfirmation = registered.confirmDeparted!({} as never, ["removed"], {
      signal: controller.signal,
    })
    controller.abort()
    finish()
    await expect(cancelled).rejects.toThrow()
    await expect(cancelledConfirmation).rejects.toThrow()
    await expect(
      registered.pullPage!({} as never, { mode: "full", signal: controller.signal })
    ).rejects.toThrow()
    expect(input.pullPage).toHaveBeenCalledTimes(1)
    await expect(
      registered.confirmDeparted!({} as never, ["removed"], { signal: controller.signal })
    ).rejects.toThrow()
    expect(input.confirmDeparted).toHaveBeenCalledTimes(1)
    dispose()
    await expect(registered.pullPage!({} as never, { mode: "full" })).rejects.toThrow(/issue:write/)
    await expect(registered.confirmDeparted!({} as never, ["removed"], {})).rejects.toThrow(
      /issue:write/
    )
    expect(registered).toMatchObject({ completeFullScan: true, fullScanOnly: true })
    expect(() => api.registerSyncProvider({ ...input, pullPage: undefined })).toThrow(/descriptor/)
    expect(() => api.registerSyncProvider({ ...input, confirmDeparted: true } as never)).toThrow(
      /descriptor/
    )
  })
})

it("projects portable sync options instead of leaking Host admission to plugin callbacks", async () => {
  const pull = jest.fn(async () => {
    expect(pluginExecutionContext("p")?.localAuthorization).toBe(LOCAL_PERSON_RUN)
    return { items: [], notModified: true }
  })
  const push = jest.fn(async (..._args: unknown[]) => ({ status: "applied" as const }))
  const create = jest.fn(async (..._args: unknown[]) => ({ provider: "p", externalId: "1" }))
  createIssuesAPI("p", {
    id: "p",
    issueSyncProviders: [{ id: "private", label: "Private", schemaVersion: 1 }],
  }).registerSyncProvider({
    id: "private",
    label: "Private",
    pullFields: [],
    pushFields: [],
    resource: {
      label: "Private",
      schemaVersion: 1,
      schema: { type: "object", properties: {} },
      describe: () => ({ key: "private", label: "Private" }),
    },
    pull,
    push,
    create,
  } as never)
  const wrapped = mockRegister.mock
    .calls[0][0] as import("@/lib/issues/sync/types").IssueSyncProvider
  const credentialContext = { localAuthorization: LOCAL_PERSON_RUN } as const
  await wrapped.pull({} as never, { credentialContext, full: true })
  await wrapped.push!({} as never, {} as never, {}, {} as never, {
    idempotencyKey: "k",
    by: { kind: "agent" },
    credentialContext,
  })
  await wrapped.create!({} as never, {} as never, credentialContext)
  expect(pull).toHaveBeenCalledWith({}, { full: true, since: undefined, signal: undefined })
  expect(push.mock.calls[0]).toHaveLength(5)
  expect(push.mock.calls[0][4]).not.toHaveProperty("credentialContext")
  expect(create.mock.calls[0]).toHaveLength(2)
})
import { pluginExecutionContext } from "../core/invocation-identity"

it("fences cursor and departure callbacks with operation identity and hides Host proof", async () => {
  const { HOST_BACKGROUND, bindPluginContextCallbacks } =
    await import("../core/invocation-identity")
  const seen: unknown[] = []
  const pullPage = jest.fn(async (..._args: unknown[]) => {
    seen.push(pluginExecutionContext("cursor-owner"))
    await Promise.resolve()
    seen.push(pluginExecutionContext("cursor-owner"))
    return { items: [], cursor: "next" }
  })
  const confirmDeparted = jest.fn(async (..._args: unknown[]) => {
    seen.push(pluginExecutionContext("cursor-owner"))
    return []
  })
  bindPluginContextCallbacks(
    "cursor-owner",
    createIssuesAPI("cursor-owner", {
      id: "cursor-owner",
      issueSyncProviders: [{ id: "private", label: "Private", schemaVersion: 1 }],
    })
  ).registerSyncProvider({
    id: "private",
    label: "Private",
    pullFields: [],
    pushFields: [],
    resource: {
      label: "Private",
      schemaVersion: 1,
      schema: { type: "object", properties: {} },
      describe: () => ({ key: "private", label: "Private" }),
    },
    pull: async () => ({ items: [], notModified: true }),
    pullPage,
    confirmDeparted,
  } as never)
  const wrapped = mockRegister.mock
    .calls[0][0] as import("@/lib/issues/sync/types").IssueSyncProvider
  const credentialContext = { sessionId: "s", executionRunId: "exact-run" }
  await wrapped.pullPage!({} as never, { mode: "full", credentialContext })
  await wrapped.confirmDeparted!({} as never, [], { credentialContext })
  expect(seen).toEqual([credentialContext, credentialContext, credentialContext])
  expect(pullPage.mock.calls[0][1]).not.toHaveProperty("credentialContext")
  expect(confirmDeparted.mock.calls[0][2]).not.toHaveProperty("credentialContext")
  seen.length = 0
  await wrapped.pullPage!({} as never, { mode: "full", executionRunId: "forged" } as never)
  expect(seen).toEqual([HOST_BACKGROUND, HOST_BACKGROUND])
  expect(pluginExecutionContext("cursor-owner")).toBeUndefined()
})
