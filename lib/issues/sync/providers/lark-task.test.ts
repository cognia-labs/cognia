import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { withLarkAuthedApi } from "@/lib/auth-providers/feishu/authed-api"
import type { LarkAuthedApi } from "@/lib/auth-providers/feishu/authed-api"
import type { IssueProject } from "@/types/issues"
import type { IssueSyncBinding } from "../types"
import { resolveLarkConnection, larkConnectionAdapter } from "@/lib/auth-providers/feishu/host-auth"
import {
  createLarkTaskSyncProvider,
  larkTaskToRemote,
  sectionExternalId,
  statusToLarkCompleted,
  toLarkTaskPatch,
} from "./lark-task"

it("describes its built-in resource without migrating its account binding", () => {
  const descriptor = createLarkTaskSyncProvider().resource!
  expect(descriptor).toMatchObject({ kind: "lark-tasklist", schemaVersion: 1 })
  expect(
    descriptor.describe({ adapterId: "account", tasklistGuid: "list", name: "Tasks" })
  ).toEqual({ key: "account:list", label: "Tasks" })
})

jest.mock("@/lib/auth-providers/feishu/authed-api", () => ({
  withLarkAuthedApi: jest.fn(),
}))
jest.mock("@/lib/auth-providers/feishu/host-auth", () => ({
  resolveLarkConnection: jest.fn(),
  larkConnectionAdapter: jest.fn(),
}))

it("uses the same identity's restored adapter and epoch for the prepared tasklist", async () => {
  jest.mocked(larkConnectionAdapter).mockResolvedValueOnce({
    adapterId: "restored-adapter",
    connection: { id: "restored-ref", hostMetadata: { authorizationEpoch: "restored-epoch" } },
  } as never)
  const b = { ...binding(), connectionRef: "restored-ref" as never }
  const prepared = await createLarkTaskSyncProvider().prepare!(b)
  expect(prepared.connectionRef).toBe("restored-ref")
  jest.mocked(withLarkAuthedApi).mockResolvedValueOnce({ items: [], cursor: "done" })
  await prepared.provider.pullPage!(b, { mode: "full" })
  expect(withLarkAuthedApi).toHaveBeenLastCalledWith(
    expect.objectContaining({
      adapterId: "restored-adapter",
      expectedAuthorizationEpoch: "restored-epoch",
    }),
    expect.any(Function)
  )
})

const resource = {
  kind: "lark-tasklist" as const,
  adapterId: "cai_1",
  tasklistGuid: "tl",
  name: "Team",
  addedAt: 1,
}

function container(resources: IssueProject["resources"], id = "p1"): IssueProject {
  return {
    id,
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    status: "backlog",
    priority: "none",
    resources,
    createdAt: 1,
    updatedAt: 1,
  }
}

function binding(): IssueSyncBinding {
  return {
    providerId: "lark-task",
    projectId: "w1",
    issueProjectId: "p1",
    projectKey: "MERC",
    resource,
    key: "cai_1:tl",
  }
}

function fakeApi(routes: Record<string, (body?: unknown) => unknown>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const handle = (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, ...(body !== undefined ? { body } : {}) })
    const key = Object.keys(routes).find((candidate) => path.startsWith(candidate))
    if (!key) throw new Error(`unexpected ${method} ${path}`)
    return Promise.resolve(routes[key](body))
  }
  const api: LarkAuthedApi = {
    get: (path) => handle("GET", path) as never,
    post: (path, body) => handle("POST", path, body) as never,
    patch: (path, body) => handle("PATCH", path, body) as never,
    put: (path, body) => handle("PUT", path, body) as never,
    delete: (path) => handle("DELETE", path) as never,
  }
  return { api, calls }
}

describe("pure transforms", () => {
  it("maps a task onto the remote shape with a coarse status", () => {
    expect(
      larkTaskToRemote(
        {
          guid: "t1",
          summary: "Do it",
          description: "d",
          dueAt: 5,
          members: [{ id: "ou", role: "assignee", name: "Ada" }],
          tasklists: [{ tasklistGuid: "tl", sectionGuid: "s1" }],
          url: "u",
          updatedAt: 9,
        },
        "tl"
      )
    ).toEqual({
      externalId: "t1",
      url: "u",
      label: "Do it",
      title: "Do it",
      description: "d",
      status: "todo",
      coarseStatus: true,
      assigneeLabel: "Ada",
      dueDate: 5,
      cycleExternalId: sectionExternalId("s1"),
      remoteUpdatedAt: 9,
    })
    expect(
      larkTaskToRemote(
        { guid: "t2", summary: "Done", completedAt: 3, members: [], tasklists: [] },
        "tl"
      )
    ).toMatchObject({
      status: "done",
      assigneeLabel: null,
      dueDate: null,
      cycleExternalId: null,
      remoteUpdatedAt: 0,
    })
  })

  it("maps status and patches onto the task's two states", () => {
    expect(statusToLarkCompleted("in_progress")).toBe(false)
    expect(statusToLarkCompleted("done")).toBe(true)
    expect(statusToLarkCompleted("canceled")).toBe(true)
    expect(
      toLarkTaskPatch({
        title: "T",
        description: null,
        dueDate: null,
        status: "done",
        labels: ["x"],
      })
    ).toEqual({
      summary: "T",
      description: "",
      dueAt: null,
      completed: true,
    })
  })
})

describe("provider", () => {
  it("binds lark-tasklist resources once each", () => {
    const provider = createLarkTaskSyncProvider({ withApi: async () => undefined as never })
    const bindings = provider.resolveBindings([
      container([resource, { kind: "github-repo", repoFullName: "o/r", addedAt: 1 }], "p2"),
      container([resource], "p1"),
    ])
    expect(bindings).toEqual([
      expect.objectContaining({ providerId: "lark-task", issueProjectId: "p1", key: "cai_1:tl" }),
      expect.objectContaining({ providerId: "lark-task", issueProjectId: "p2", key: "cai_1:tl" }),
    ])
  })

  it("pulls sections as cycles and tasks as items, filtered by the watermark", async () => {
    const { api } = fakeApi({
      "/open-apis/task/v2/sections?": () => ({ items: [{ guid: "s1", name: "Sprint 1" }] }),
      "/open-apis/task/v2/tasklists/tl/tasks": () => ({
        items: [{ guid: "old" }, { guid: "new" }],
      }),
      "/open-apis/task/v2/tasks/old": () => ({
        task: { guid: "old", summary: "Old", updated_at: "5" },
      }),
      "/open-apis/task/v2/tasks/new": () => ({
        task: { guid: "new", summary: "New", updated_at: "50" },
      }),
    })
    const withApi = jest.fn(async (_id: string, fn: (api: LarkAuthedApi) => Promise<unknown>) =>
      fn(api)
    )
    const provider = createLarkTaskSyncProvider({ withApi: withApi as never })
    const result = await provider.pull(binding(), { since: 10 })
    expect(withApi).toHaveBeenCalledWith("cai_1", expect.any(Function), undefined)
    expect(result.cycles).toEqual([
      { externalId: "section/s1", kind: "cycle", name: "Sprint 1", status: "active" },
    ])
    expect(result.items.map((item) => item.externalId)).toEqual(["new"])
    expect((await provider.pull(binding(), { full: true })).items).toHaveLength(2)
  })

  it("pushes through PATCH and creates through POST, returning the ref", async () => {
    const { api, calls } = fakeApi({
      "/open-apis/task/v2/tasks/t1": () => ({
        task: { guid: "t1", summary: "T", updated_at: "77" },
      }),
      "/open-apis/task/v2/tasks?": () => ({
        task: { guid: "new", summary: "N", url: "u", updated_at: "88" },
      }),
    })
    const provider = createLarkTaskSyncProvider({
      withApi: (async (_id: string, fn: (api: LarkAuthedApi) => Promise<unknown>) =>
        fn(api)) as never,
      now: () => 1000,
    })
    const outcome = await provider.push!(
      binding(),
      { provider: "lark-task", externalId: "t1" },
      { title: "T", status: "done" },
      {} as never,
      {
        idempotencyKey: "k",
        by: { kind: "agent" },
      }
    )
    expect(outcome).toEqual({ status: "applied", remoteUpdatedAt: 77 })
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      body: { task: { summary: "T", completed_at: "1000" } },
    })
    const ref = await provider.create!(binding(), {
      title: "N",
      description: "d",
      dueDate: 5,
    } as never)
    expect(ref).toEqual({
      provider: "lark-task",
      externalId: "new",
      url: "u",
      label: "N",
      syncedAt: 1000,
      remoteUpdatedAt: 88,
      meta: { binding: "cai_1:tl" },
    })
  })
})

it("uses the selected account's user identity for configured resources", async () => {
  jest.mocked(withLarkAuthedApi).mockResolvedValueOnce({ items: [], notModified: false } as never)
  await createLarkTaskSyncProvider().pull(binding(), { full: true })
  expect(withLarkAuthedApi).toHaveBeenCalledWith(
    expect.objectContaining({ adapterId: "cai_1", identity: "user" }),
    expect.any(Function)
  )
})

it("returns one task page at a time without filtering unchanged or completed tasks", async () => {
  let listReads = 0
  const { api, calls } = fakeApi({
    "/open-apis/task/v2/tasklists/tl/tasks?": () =>
      ++listReads === 1
        ? { items: [{ guid: "t1" }], has_more: true, page_token: "next" }
        : { items: [{ guid: "t2" }] },
    "/open-apis/task/v2/tasks/t1?": () => ({
      task: { guid: "t1", summary: "Open", updated_at: "1" },
    }),
    "/open-apis/task/v2/tasks/t2?": () => ({
      task: { guid: "t2", summary: "Done", updated_at: "2", completed_at: "2" },
    }),
    "/open-apis/task/v2/sections?": () => ({ items: [] }),
  })
  const provider = createLarkTaskSyncProvider({
    withApi: async (_id, fn) => fn(api),
    now: () => 5000,
  })
  expect(provider).toMatchObject({ completeFullScan: true, fullScanOnly: true })
  const first = await provider.pullPage!(binding(), { mode: "full", cursor: "9999" })
  expect(first).toMatchObject({
    nextPage: "next",
    items: [expect.objectContaining({ externalId: "t1" })],
  })
  expect(first.cursor).toBeUndefined()
  expect(await provider.pullPage!(binding(), { mode: "full", page: first.nextPage })).toMatchObject(
    { cursor: "5000", items: [expect.objectContaining({ externalId: "t2", status: "done" })] }
  )
  expect(calls.some((call) => call.path.includes("page_token=next"))).toBe(true)
})

it("resolves the bound adapter's Host connection before sync", async () => {
  jest.mocked(resolveLarkConnection).mockResolvedValueOnce({
    id: "lark-connection",
    hostMetadata: { authorizationEpoch: "epoch-a" },
  } as never)
  const provider = createLarkTaskSyncProvider()
  const prepared = await provider.prepare!(binding())
  expect(prepared.connectionRef).toBe("lark-connection")
  expect(prepared.provider.prepare).toBeUndefined()
  jest.mocked(withLarkAuthedApi).mockResolvedValueOnce({ items: [], cursor: "next" })
  await prepared.provider.pullPage!(binding(), { mode: "full" })
  expect(withLarkAuthedApi).toHaveBeenLastCalledWith(
    expect.objectContaining({
      adapterId: "cai_1",
      expectedAuthorizationEpoch: "epoch-a",
      identity: "user",
    }),
    expect.any(Function)
  )
  expect(resolveLarkConnection).toHaveBeenCalledWith("cai_1", undefined, undefined)
})

it("refuses a pending push if another context switches the prepared adapter's authorization", async () => {
  jest.mocked(resolveLarkConnection).mockResolvedValueOnce({
    id: "connection-a",
    hostMetadata: { authorizationEpoch: "epoch-a" },
  } as never)
  const prepared = await createLarkTaskSyncProvider().prepare!(binding())
  const patch = jest.fn(async () => ({}))
  let currentEpoch = "epoch-a"
  jest.mocked(withLarkAuthedApi).mockImplementation(async (opts, fn) => {
    // The real harness asserts this against the native snapshot before credential capture or I/O.
    if (opts.expectedAuthorizationEpoch !== currentEpoch)
      throw new Error("authorization epoch changed")
    return fn(
      { get: async () => ({}) as never, post: async () => ({}) as never, patch: patch as never },
      { adapterId: opts.adapterId, displayName: "Account" }
    )
  })
  currentEpoch = "epoch-b"
  await expect(
    prepared.provider.push!(
      binding(),
      { provider: "lark-task", externalId: "task-a" },
      { title: "Account A data" },
      {} as never,
      { by: { kind: "human" }, idempotencyKey: "a" }
    )
  ).rejects.toThrow(/epoch changed/)
  expect(patch).not.toHaveBeenCalled()
  expect(withLarkAuthedApi).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedAuthorizationEpoch: "epoch-a" }),
    expect.any(Function)
  )
})
import { createDbTestFixture } from "@/lib/db/test-fixture"
const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("forwards a per-call admission without capturing it in the registered provider", async () => {
  const credentialContext = { localAuthorization: LOCAL_PERSON_RUN } as const
  const withApi = jest.fn(async () => ({ items: [], notModified: true }))
  const provider = createLarkTaskSyncProvider({ withApi: withApi as never })
  await provider.pull(binding(), { credentialContext })
  expect(withApi).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.any(Function),
    credentialContext
  )
  await provider.pull(binding(), {})
  expect(withApi).toHaveBeenLastCalledWith(expect.any(String), expect.any(Function), undefined)
})
