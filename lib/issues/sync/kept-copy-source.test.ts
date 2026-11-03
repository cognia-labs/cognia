/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createIssueProject } from "@/lib/db/issue-projects"
import { tombstoneAuthConnection, type AuthConnectionRow } from "@/lib/db/auth-connections"
import { DocsProviderError } from "@/lib/docs-providers/types"
import { purgeDerivedData } from "@/lib/external-services/derived-data-registry"
import { reconcileBinding } from "./engine"
import { captureIssueSyncSource, resolveIssueResourceSource } from "./kept-copy-source"
import { createLarkTaskSyncProvider } from "./providers/lark-task"
import { LarkApiError } from "@/lib/connectors/adapters/lark/auth-retry"
import { withLarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import { createLarkBitableSyncProvider } from "./providers/lark-bitable"
import { listPublishTargets, publishIssue } from "@/lib/issues/publish"
import { createGithubSyncProvider } from "./providers/github"
import { IssueSyncRegistry } from "./registry"
import { createIssue } from "@/lib/db/issues"
import type { LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import type { IssueSyncBinding, IssueSyncProvider } from "./types"

jest.mock("@/lib/connectors/adapters/lark/authed-api", () => ({
  ...jest.requireActual("@/lib/connectors/adapters/lark/authed-api"),
  withLarkAuthedApi: jest.fn(),
}))

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
const connection: AuthConnectionRow = {
  id: "kept-original" as never,
  providerId: "github",
  ownerPluginId: null,
  publisher: "cognia",
  contractMajor: 1,
  issuer: "https://github.com",
  clientId: "client",
  principalId: "person",
  principalKind: "user",
  accountLabel: "Person",
  scopes: ["repo"],
  revision: 1,
  credentialRevision: 1,
  lineageId: "lineage",
  status: "connected",
  identityKey: "kept-person",
  createdAt: 1,
  updatedAt: 1,
}
async function setup() {
  await getDb().authConnections.put(connection)
  const project = await createIssueProject({
    projectId: "ws",
    key: "KC",
    name: "Kept",
    resources: [
      { kind: "github-repo", repoFullName: "owner/repo", addedAt: 1, sync: { mode: "import" } },
    ],
  })
  const binding: IssueSyncBinding = {
    providerId: "github",
    projectId: "ws",
    issueProjectId: project.id,
    projectKey: "KC",
    key: "owner/repo",
    resource: project.resources[0],
  }
  const pull = jest.fn(async () => ({
    notModified: false,
    items: [{ externalId: "one", title: "User copy", status: "todo" as const, remoteUpdatedAt: 1 }],
  }))
  const prepare = jest.fn(async (current: IssueSyncBinding) => ({
    provider,
    connectionRef: current.connectionRef ?? connection.id,
  }))
  const provider: IssueSyncProvider = {
    id: "github",
    label: "GitHub",
    pullFields: ["title"],
    pushFields: [],
    resolveBindings: () => [binding],
    prepare,
    pull,
  }
  const resource = async () => (await getDb().issueProjects.get(project.id))!.resources[0]
  return { binding, provider, pull, prepare, resource }
}

async function larkWriteSetup(kind: "lark-tasklist" | "lark-bitable") {
  const original = {
    ...connection,
    providerId: "lark",
    hostMetadata: { adapterId: "reused", authorizationEpoch: "epoch-A", bot: false },
  } as AuthConnectionRow
  await getDb().authConnections.put(original)
  const resource =
    kind === "lark-tasklist"
      ? { kind, adapterId: "reused", tasklistGuid: "list", name: "Tasks", addedAt: 1 }
      : {
          kind,
          adapterId: "reused",
          appToken: "app",
          tableId: "table",
          fieldMap: { title: "Name" },
          name: "Table",
          addedAt: 1,
        }
  const project = await createIssueProject({
    projectId: "ws",
    key: "LW",
    name: "Lark writes",
    resources: [resource],
  })
  const wire = {
    task: { guid: "created", summary: "Local", updated_at: "1" },
    record: { record_id: "created" },
  }
  const send = jest.fn(async () => wire)
  const api = { get: send, post: send, patch: send, put: send } as unknown as LarkAuthedApi
  const deps = {
    withApi: async (_adapter: string, fn: (api: LarkAuthedApi) => Promise<unknown>) => fn(api),
  }
  const provider =
    kind === "lark-tasklist"
      ? createLarkTaskSyncProvider(deps as never)
      : createLarkBitableSyncProvider(deps as never)
  const binding = provider.resolveBindings([project])[0]
  await captureIssueSyncSource(binding, original.id)
  const issue = await createIssue({
    projectId: "ws",
    issueProjectId: project.id,
    title: "Local",
    createdBy: { kind: "human" },
  })
  return { original, provider, binding, issue, send, api }
}

it.each(["lark-tasklist", "lark-bitable"] as const)(
  "%s refuses publish, direct create and update when A's adapter is reauthorized as B",
  async (kind) => {
    const { original, provider, binding, issue, send } = await larkWriteSetup(kind)
    await getDb().authConnections.put(tombstoneAuthConnection(original, "tombstoned"))
    await getDb().authConnections.put({
      ...original,
      id: "person-B" as never,
      identityKey: "person-B",
      hostMetadata: { adapterId: "reused", authorizationEpoch: "epoch-B", bot: false },
    })
    const registry = new IssueSyncRegistry()
    const create = jest.fn(provider.create!)
    registry.register({ ...provider, create })
    await expect(
      publishIssue(
        issue.id,
        {
          kind: "binding",
          id: binding.key,
          providerId: provider.id,
          providerLabel: provider.label,
          resourceName: "Lark",
          binding,
        },
        { kind: "human" },
        { registry }
      )
    ).rejects.toMatchObject({ code: "source-disconnected" })
    await expect(provider.create!(binding, issue)).rejects.toMatchObject({
      code: "source-disconnected",
    })
    await expect(
      provider.push!(
        binding,
        { provider: provider.id, externalId: "existing" },
        { title: "Changed" },
        issue,
        { by: { kind: "human" }, idempotencyKey: "write" }
      )
    ).rejects.toMatchObject({ code: "source-disconnected" })
    await expect(
      provider.push!(binding, { provider: provider.id, externalId: "existing" }, {}, issue, {
        by: { kind: "human" },
        idempotencyKey: "empty",
      })
    ).rejects.toMatchObject({ code: "source-disconnected" })
    expect(send).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect((await getDb().issues.get(issue.id))?.externalRefs).toEqual([])
  }
)

it.each(["lark-tasklist", "lark-bitable"] as const)(
  "%s pins direct create to the same identity's restored adapter and epoch",
  async (kind) => {
    const { original, binding, issue, api, send } = await larkWriteSetup(kind)
    await getDb().authConnections.put(tombstoneAuthConnection(original, "tombstoned"))
    await getDb().authConnections.put({
      ...original,
      id: "restored-A" as never,
      hostMetadata: {
        adapterId: "restored-adapter",
        authorizationEpoch: "restored-epoch",
        bot: false,
      },
    })
    jest.mocked(withLarkAuthedApi).mockImplementation(async (_options, fn) => fn(api, {} as never))
    const provider =
      kind === "lark-tasklist" ? createLarkTaskSyncProvider() : createLarkBitableSyncProvider()
    await expect(provider.create!(binding, issue)).resolves.toMatchObject({ externalId: "created" })
    expect(withLarkAuthedApi).toHaveBeenLastCalledWith(
      expect.objectContaining({
        adapterId: "restored-adapter",
        expectedAuthorizationEpoch: "restored-epoch",
      }),
      expect.any(Function)
    )
    expect(send).toHaveBeenCalledTimes(1)
  }
)

it.each(["listed", "cached"] as const)(
  "guards a %s GitHub publish target even without a registered provider",
  async (mode) => {
    const { binding } = await setup()
    await captureIssueSyncSource(binding, connection.id)
    const project = (await getDb().issueProjects.get(binding.issueProjectId))!
    const issue = await createIssue({
      projectId: "ws",
      issueProjectId: project.id,
      title: "Local",
      createdBy: { kind: "human" },
    })
    const registry = new IssueSyncRegistry()
    const target =
      mode === "listed"
        ? listPublishTargets(issue, project, registry)[0]
        : { kind: "github" as const, id: "github:owner/repo", repoFullName: "owner/repo" }
    const create = jest.fn(async () => ({ repoFullName: "owner/repo", number: 1, htmlUrl: "url" }))
    await getDb().authConnections.put(tombstoneAuthConnection(connection, "tombstoned"))
    await expect(
      publishIssue(issue.id, target, { kind: "human" }, { registry, createGithubIssue: create })
    ).rejects.toMatchObject({ code: "source-disconnected" })
    expect(create).not.toHaveBeenCalled()
  }
)

it("pins an unprepared GitHub update's preliminary reads to its captured identity", async () => {
  const { binding } = await setup()
  await captureIssueSyncSource(binding, connection.id)
  const issue = await createIssue({
    projectId: "ws",
    issueProjectId: binding.issueProjectId,
    title: "Local",
    assignee: { kind: "human", label: "Coder" },
    createdBy: { kind: "human" },
  })
  const request = jest.fn(async () => ({ status: 200, headers: {}, data: { assignees: [] } }))
  const foreign = jest.fn(async () => ({ status: 200, headers: {}, data: { assignees: [] } }))
  const resolveReadClient = jest.fn(async () => ({
    octokit: { request },
    connectionRef: connection.id,
  }))
  const execute = jest.fn(async () => ({ id: "job", status: "succeeded" as const }))
  const provider = createGithubSyncProvider({
    resolveReadClient,
    resolveOctokitOrNull: async () => ({ request: foreign }),
    resolveAccount: async () => ({ id: "account-A", connectionId: connection.id }) as never,
    execute: execute as never,
  })
  await expect(
    provider.push!(
      binding,
      { provider: "github", externalId: "owner/repo#1" },
      { assignee: "Coder" },
      issue,
      { by: { kind: "human" }, idempotencyKey: "pinned" }
    )
  ).resolves.toMatchObject({ status: "applied" })
  expect(resolveReadClient).toHaveBeenCalledWith("owner/repo", connection.id)
  expect(request).toHaveBeenCalledTimes(1)
  expect(foreign).not.toHaveBeenCalled()
})

it("captures binding provenance, keeps issues on disconnect and restores only the same identity", async () => {
  const { binding, provider, pull, prepare, resource } = await setup()
  expect(await reconcileBinding(binding, provider)).toMatchObject({
    status: "completed",
    created: 1,
  })
  const stored = await resource()
  expect(stored.captureId).toEqual(expect.any(String))
  expect(JSON.stringify(stored)).not.toMatch(/kept-original|kept-person/)
  expect(await getDb().remoteDocumentConnections.get(stored.captureId!)).toMatchObject({
    providerId: "github",
    connectionRef: connection.id,
    identityKey: connection.identityKey,
  })
  await getDb().authConnections.put(tombstoneAuthConnection(connection, "tombstoned"))
  await purgeDerivedData({ kind: "connection", ref: connection.id })
  expect(await resolveIssueResourceSource(stored)).toBe("source-disconnected")
  await getDb().authConnections.put({
    ...connection,
    id: "unrelated" as never,
    identityKey: "other-person",
  })
  await expect(reconcileBinding(binding, provider)).rejects.toMatchObject({
    code: "source-disconnected",
  })
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(pull).toHaveBeenCalledTimes(1)
  expect(await getDb().issues.count()).toBe(1)
  await getDb().authConnections.put({ ...connection, id: "restored" as never })
  expect(await resolveIssueResourceSource(stored)).toBe("available")
  expect(await reconcileBinding(binding, provider)).toMatchObject({ status: "completed" })
  expect(prepare.mock.calls[1][0].connectionRef).toBe("restored")
  expect(pull).toHaveBeenCalledTimes(2)
  expect(await getDb().issues.count()).toBe(1)
})

it("keeps legacy bindings unrestricted and does not fabricate provenance", async () => {
  const { binding, provider, resource } = await setup()
  provider.prepare = undefined
  expect(await resolveIssueResourceSource(await resource())).toBe("unknown")
  expect(await reconcileBinding(binding, provider)).toMatchObject({
    status: "completed",
    created: 1,
  })
  expect((await resource()).captureId).toBeUndefined()
  expect(await getDb().remoteDocumentConnections.count()).toBe(0)
})

it("does not let concurrent first captures bind the same copy to different identities", async () => {
  const { binding, resource } = await setup()
  const other = { ...connection, id: "other" as never, identityKey: "other-person" }
  await getDb().authConnections.put(other)
  const results = await Promise.allSettled([
    captureIssueSyncSource({ ...binding, resource: { ...binding.resource } }, connection.id),
    captureIssueSyncSource({ ...binding, resource: { ...binding.resource } }, other.id),
  ])
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"])
  expect(await getDb().remoteDocumentConnections.count()).toBe(1)
  expect((await resource()).captureId).toBeDefined()
})

it.each(["page", "legacy"] as const)(
  "a missing individual task does not delete its available tasklist (%s)",
  async (mode) => {
    await getDb().authConnections.put({
      ...connection,
      providerId: "lark",
      hostMetadata: { adapterId: "adapter", authorizationEpoch: "1" },
    } as AuthConnectionRow)
    const project = await createIssueProject({
      projectId: "ws",
      key: "LK",
      name: "Lark",
      resources: [
        {
          kind: "lark-tasklist",
          adapterId: "adapter",
          tasklistGuid: "list",
          name: "Tasks",
          addedAt: 1,
        },
      ],
    })
    const binding: IssueSyncBinding = {
      providerId: "lark-task",
      projectId: "ws",
      issueProjectId: project.id,
      projectKey: "LK",
      key: "adapter:list",
      resource: project.resources[0],
    }
    await captureIssueSyncSource(binding, connection.id)
    let deletedContainer = false
    const api = {
      get: async (path: string) => {
        if (path.includes("/tasklists/list/tasks")) {
          if (deletedContainer)
            throw new LarkApiError({ status: 404, code: null, message: "gone list" })
          return { items: [{ guid: "removed-task" }], has_more: false }
        }
        if (path.includes("/tasks/removed-task"))
          throw new LarkApiError({ status: 404, code: null, message: "gone task" })
        return { items: [], has_more: false }
      },
    } as LarkAuthedApi
    const provider = createLarkTaskSyncProvider({ withApi: async (_id, read) => read(api) })
    const pull = () =>
      mode === "page"
        ? provider.pullPage!(binding, { mode: "full" })
        : provider.pull(binding, { full: true })
    await expect(pull()).rejects.toMatchObject({ status: 404 })
    expect(await resolveIssueResourceSource(binding.resource)).toBe("available")
    deletedContainer = true
    await expect(pull()).rejects.toMatchObject({ status: 404 })
    expect(await resolveIssueResourceSource(binding.resource)).toBe("source-deleted")
  }
)

it.each(["notFound", "noPermission"] as const)(
  "pins a confirmed %s without deleting imported issues",
  async (code) => {
    const { binding, provider, pull, resource } = await setup()
    await reconcileBinding(binding, provider)
    pull.mockRejectedValueOnce(new DocsProviderError(code))
    expect(await reconcileBinding(binding, provider)).toMatchObject({ status: "failed" })
    expect(await resolveIssueResourceSource(await resource())).toBe("source-deleted")
    await expect(reconcileBinding(binding, provider)).rejects.toMatchObject({
      code: "source-deleted",
    })
    expect(pull).toHaveBeenCalledTimes(2)
    expect(await getDb().issues.count()).toBe(1)
  }
)
