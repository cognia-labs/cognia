import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { withLarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import type { LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import type { IssueProject, LarkBitableFieldMap } from "@/types/issues"
import type { IssueSyncBinding } from "../types"
import {
  resolveLarkConnection,
  larkConnectionAdapter,
} from "@/lib/connectors/adapters/lark/host-auth"
import {
  bitableFieldsFromIssue,
  bitableFieldsFromPatch,
  bitableRecordToRemote,
  createLarkBitableSyncProvider,
  mappedFields,
} from "./lark-bitable"

it("describes its built-in resource without migrating its account binding", () => {
  const descriptor = createLarkBitableSyncProvider().resource!
  expect(descriptor).toMatchObject({ kind: "lark-bitable", schemaVersion: 1 })
  expect(
    descriptor.describe({
      adapterId: "account",
      appToken: "app",
      tableId: "table",
      name: "Backlog",
    })
  ).toEqual({ key: "account:app:table", label: "Backlog" })
})

jest.mock("@/lib/connectors/adapters/lark/authed-api", () => ({
  withLarkAuthedApi: jest.fn(),
}))
jest.mock("@/lib/connectors/adapters/lark/host-auth", () => ({
  resolveLarkConnection: jest.fn(),
  larkConnectionAdapter: jest.fn(),
}))

it("uses the same identity's restored adapter and epoch for the prepared table", async () => {
  jest.mocked(larkConnectionAdapter).mockResolvedValueOnce({
    adapterId: "restored-adapter",
    connection: { id: "restored-ref", hostMetadata: { authorizationEpoch: "restored-epoch" } },
  } as never)
  const b = { ...binding(), connectionRef: "restored-ref" as never }
  const prepared = await createLarkBitableSyncProvider().prepare!(b)
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

const fieldMap: LarkBitableFieldMap = {
  title: "Name",
  description: "Notes",
  status: "State",
  statusValues: { todo: "To do", done: "Finished" },
  priority: "Priority",
  assignee: "Owner",
  dueDate: "Due",
  estimate: "Points",
}

const resource = {
  kind: "lark-bitable" as const,
  adapterId: "cai_1",
  appToken: "app",
  tableId: "tbl",
  name: "Backlog",
  fieldMap,
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
    providerId: "lark-bitable",
    projectId: "w1",
    issueProjectId: "p1",
    projectKey: "MERC",
    resource,
    key: "cai_1:app:tbl",
  }
}

describe("pure transforms", () => {
  it("lists the fields the map covers", () => {
    expect(mappedFields({ title: "Name" })).toEqual(["title"])
    expect(mappedFields(fieldMap)).toEqual([
      "title",
      "description",
      "status",
      "priority",
      "assignee",
      "dueDate",
      "estimate",
    ])
  })

  it("maps a record through the field map, tolerating option casing and missing cells", () => {
    const remote = bitableRecordToRemote(
      {
        recordId: "r1",
        fields: {
          Name: [{ text: "Fix login" }],
          Notes: "body",
          State: "finished",
          Priority: "High",
          Owner: [{ name: "Ada" }],
          Due: 1700000000000,
          Points: "3",
        },
        lastModifiedAt: 9,
      },
      fieldMap,
      100
    )
    expect(remote).toEqual({
      externalId: "r1",
      label: "Fix login",
      title: "Fix login",
      status: "done",
      remoteUpdatedAt: 9,
      description: "body",
      priority: "high",
      assigneeLabel: "Ada",
      dueDate: 1700000000000,
      estimate: 3,
    })
    expect(
      bitableRecordToRemote({ recordId: "r2", fields: { Name: "" } }, fieldMap, 100)
    ).toBeNull()
    expect(
      bitableRecordToRemote({ recordId: "r3", fields: { Name: "x", State: "???" } }, fieldMap, 100)
    ).toMatchObject({
      status: "backlog",
      remoteUpdatedAt: 100,
      assigneeLabel: null,
      dueDate: null,
      estimate: null,
    })
  })

  it("writes only mapped columns, using the option text for status", () => {
    expect(
      bitableFieldsFromPatch(
        { title: "T", status: "todo", labels: ["x"], dueDate: null, estimate: 2 },
        fieldMap
      )
    ).toEqual({
      Name: "T",
      State: "To do",
      Due: null,
      Points: 2,
    })
    expect(
      bitableFieldsFromPatch({ status: "in_review", description: "d" }, { title: "Name" })
    ).toEqual({})
    expect(
      bitableFieldsFromIssue(
        { title: "T", status: "in_review", priority: "low" } as never,
        fieldMap
      )
    ).toEqual({
      Name: "T",
      Notes: "",
      State: "in_review",
      Priority: "low",
      Due: null,
      Points: null,
    })
  })
})

describe("provider", () => {
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

  it("binds lark-bitable resources once each", () => {
    const provider = createLarkBitableSyncProvider({ withApi: async () => undefined as never })
    expect(provider.resolveBindings([container([resource]), container([resource], "p2")])).toEqual([
      expect.objectContaining({
        providerId: "lark-bitable",
        issueProjectId: "p1",
        key: "cai_1:app:tbl",
      }),
      expect.objectContaining({
        providerId: "lark-bitable",
        issueProjectId: "p2",
        key: "cai_1:app:tbl",
      }),
    ])
  })

  it("pulls, pushes and creates through the bound account", async () => {
    const { api, calls } = fakeApi({
      "/open-apis/bitable/v1/apps/app/tables/tbl/records/search": () => ({
        items: [
          { record_id: "r1", fields: { Name: "A" }, last_modified_time: 50 },
          { record_id: "r0", fields: { Name: "Old" }, last_modified_time: 1 },
        ],
      }),
      "/open-apis/bitable/v1/apps/app/tables/tbl/records/r1": () => ({}),
      "/open-apis/bitable/v1/apps/app/tables/tbl/records": () => ({ record: { record_id: "r9" } }),
    })
    const provider = createLarkBitableSyncProvider({
      withApi: (async (_id: string, fn: (api: LarkAuthedApi) => Promise<unknown>) =>
        fn(api)) as never,
      now: () => 1000,
    })
    const pulled = await provider.pull(binding(), { since: 10 })
    expect(pulled.items.map((item) => item.externalId)).toEqual(["r1"])
    const outcome = await provider.push!(
      binding(),
      { provider: "lark-bitable", externalId: "r1" },
      { title: "B" },
      {} as never,
      {
        idempotencyKey: "k",
        by: { kind: "agent" },
      }
    )
    expect(outcome).toEqual({ status: "applied", remoteUpdatedAt: 1000 })
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { fields: { Name: "B" } } })
    expect(
      await provider.push!(
        binding(),
        { provider: "lark-bitable", externalId: "r1" },
        { labels: ["x"] },
        {} as never,
        { idempotencyKey: "k", by: { kind: "agent" } }
      )
    ).toEqual({ status: "applied" })
    const ref = await provider.create!(binding(), {
      title: "N",
      status: "todo",
      priority: "none",
    } as never)
    expect(ref).toMatchObject({
      provider: "lark-bitable",
      externalId: "r9",
      label: "N",
      meta: { binding: "cai_1:app:tbl" },
    })
  })
})

it("uses the selected account's user identity for configured resources", async () => {
  jest.mocked(withLarkAuthedApi).mockResolvedValueOnce({ items: [], notModified: false } as never)
  await createLarkBitableSyncProvider().pull(binding(), { full: true })
  expect(withLarkAuthedApi).toHaveBeenCalledWith(
    expect.objectContaining({ adapterId: "cai_1", identity: "user" }),
    expect.any(Function)
  )
})

it("pages all Bitable records with a terminal cursor and no since filter", async () => {
  const paths: string[] = []
  const api: LarkAuthedApi = {
    get: async () => {
      throw new Error("Unexpected read")
    },
    post: async <T>(path: string): Promise<T> => {
      paths.push(path)
      return (
        paths.length === 1
          ? {
              items: [{ record_id: "one", fields: { Name: "One", State: "To do" } }],
              has_more: true,
              page_token: "next",
            }
          : { items: [{ record_id: "two", fields: { Name: "Done", State: "Finished" } }] }
      ) as T
    },
  }
  const provider = createLarkBitableSyncProvider({
    withApi: async (_id, fn) => fn(api),
    now: () => 5000,
  })
  expect(provider).toMatchObject({ fullScanOnly: true, completeFullScan: true })
  const first = await provider.pullPage!(binding(), { mode: "full", cursor: "9999" })
  expect(first.cursor).toBeUndefined()
  expect(first.nextPage).toBe("next")
  expect(first.items).toHaveLength(1)
  const terminal = await provider.pullPage!(binding(), { mode: "full", page: first.nextPage })
  expect(terminal).toMatchObject({
    cursor: "5000",
    items: [expect.objectContaining({ status: "done" })],
  })
  expect(terminal.nextPage).toBeUndefined()
  expect(paths[1]).toContain("page_token=next")
})

it("resolves the Bitable adapter's Host connection before sync", async () => {
  jest.mocked(resolveLarkConnection).mockResolvedValueOnce({
    id: "lark-connection",
    hostMetadata: { authorizationEpoch: "epoch-a" },
  } as never)
  const provider = createLarkBitableSyncProvider()
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
import { createDbTestFixture } from "@/lib/db/test-fixture"
const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("forwards a per-call admission without capturing it in the registered provider", async () => {
  const credentialContext = { localAuthorization: LOCAL_PERSON_RUN } as const
  const withApi = jest.fn(async () => ({ items: [], notModified: true }))
  const provider = createLarkBitableSyncProvider({ withApi: withApi as never })
  await provider.pull(binding(), { credentialContext })
  expect(withApi).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.any(Function),
    credentialContext
  )
  await provider.pull(binding(), {})
  expect(withApi).toHaveBeenLastCalledWith(expect.any(String), expect.any(Function), undefined)
})
