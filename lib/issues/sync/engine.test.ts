/**
 * @jest-environment jsdom
 */

const mockAfterCycleRead = jest.fn()
const mockAfterLabelRead = jest.fn()
jest.mock("@/lib/db/labels", () => {
  const actual = jest.requireActual("@/lib/db/labels")
  return {
    ...actual,
    listLabels: async (...args: unknown[]) => {
      const rows = await actual.listLabels(...args)
      await mockAfterLabelRead()
      return rows
    },
  }
})
jest.mock("@/lib/db/issue-cycles", () => {
  const actual = jest.requireActual("@/lib/db/issue-cycles")
  return {
    ...actual,
    listIssueCycles: async (...args: unknown[]) => {
      const rows = await actual.listIssueCycles(...args)
      mockAfterCycleRead()
      return rows
    },
  }
})

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import {
  createIssue,
  getIssue,
  getIssueByExternalKey,
  linkIssueExternal,
  linkIssueToGithub,
  setIssueAssignee,
  setIssueCycle,
  setIssueDueDate,
  updateIssue,
} from "@/lib/db/issues"
import { listIssueEvents, __resetIssueEventClockForTesting } from "@/lib/db/issue-events"
import { createIssueCycle, listIssueCycles } from "@/lib/db/issue-cycles"
import { listLabels } from "@/lib/db/labels"
import { getDb } from "@/lib/db/schema"
import { ExternalSyncRateLimited } from "@/lib/external-services/sync/types"
import { claimSyncLease } from "@/lib/db/sync-leases"
import { purgePluginExternalServices } from "@/lib/external-services/lifecycle"
import { createLarkTaskSyncProvider } from "./providers/lark-task"
import { createGithubSyncProvider, type GithubSyncProviderDeps } from "./providers/github"
import type { IssueActor, IssueProject } from "@/types/issues"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import {
  issueSyncTarget,
  pushIdempotencyKey,
  reconcileBinding,
  tombstoneIssueSyncRefs,
  triageOnImport,
} from "./engine"
import type {
  IssueSyncBinding,
  IssueSyncProvider,
  PullResult,
  PushOutcome,
  RemoteIssue,
  RemotePatch,
  PullPage,
} from "./types"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  mockAfterCycleRead.mockReset()
  mockAfterLabelRead.mockReset()
  await dbFixture.restore()
  __resetIssueEventClockForTesting()
})
afterAll(dbFixture.dispose)

const HUMAN: IssueActor = { kind: "human" }

it("stops cycle/import writes when disposed during local reads after a pull", async () => {
  const controller = new AbortController()
  mockAfterCycleRead.mockImplementationOnce(() => controller.abort())
  const { provider } = fake({
    pull: {
      items: [remote()],
      notModified: false,
      cycles: [{ externalId: "cycle", kind: "cycle", name: "Remote cycle" }],
    },
  })
  await expect(
    reconcileBinding(binding(), provider, { signal: controller.signal })
  ).resolves.toMatchObject({ status: "cancelled" })
  expect(await getDb().issueCycles.count()).toBe(0)
  expect(await getDb().issues.count()).toBe(0)
})

let container: IssueProject
beforeEach(async () => {
  container = await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })
})

function binding(over: Partial<IssueSyncBinding> = {}): IssueSyncBinding {
  return {
    providerId: "fake",
    projectId: "w1",
    issueProjectId: container.id,
    projectKey: "MERC",
    resource: { kind: "github-repo", repoFullName: "o/r", addedAt: 1 },
    key: "o/r",
    ...over,
  }
}

function remote(over: Partial<RemoteIssue> = {}): RemoteIssue {
  return {
    externalId: "o/r#1",
    url: "https://x/1",
    label: "o/r#1",
    title: "Remote title",
    description: "Remote body",
    status: "todo",
    assigneeLabel: "octocat",
    labels: ["bug"],
    cycleExternalId: null,
    remoteUpdatedAt: 1_000,
    ...over,
  }
}

interface FakeOptions {
  pull?: PullResult
  push?: (patch: RemotePatch) => PushOutcome
  pushFields?: IssueSyncProvider["pushFields"]
}

function fake(options: FakeOptions = {}) {
  const pushes: Array<{
    externalId: string
    patch: RemotePatch
    key: string
    editedBy?: "person" | "automation"
  }> = []
  const pulls: Array<{ since?: number; full?: boolean }> = []
  const provider: IssueSyncProvider = {
    id: "fake",
    label: "Fake",
    pullFields: ["title", "description", "status", "assignee", "labels", "dueDate", "cycle"],
    pushFields: options.pushFields ?? ["title", "description", "status", "labels", "dueDate"],
    resolveBindings: () => [],
    pull: async (_b, opts) => {
      pulls.push(opts)
      return options.pull ?? { items: [], notModified: true }
    },
    push: async (_b, ref, patch, _issue, context) => {
      pushes.push({
        externalId: ref.externalId,
        patch,
        key: context.idempotencyKey,
        ...(context.editedBy ? { editedBy: context.editedBy } : {}),
      })
      return options.push ? options.push(patch) : { status: "applied", remoteUpdatedAt: 5_000 }
    },
  }
  return { provider, pushes, pulls }
}

it("authoritative departures affect only the exact binding and emit one transition", async () => {
  const { provider } = fake({ pull: { items: [remote()], notModified: false } })
  await reconcileBinding(binding(), provider)
  const issue = (await getIssueByExternalKey("fake", "o/r#1"))!
  expect(await tombstoneIssueSyncRefs(binding({ key: "other/repo" }), ["o/r#1"])).toBe(0)
  expect(await tombstoneIssueSyncRefs(binding({ issueProjectId: "other" }), ["o/r#1"])).toBe(0)
  expect(await tombstoneIssueSyncRefs(binding(), ["o/r#1"], { now: () => 1234 })).toBe(1)
  expect(await tombstoneIssueSyncRefs(binding(), ["o/r#1"], { now: () => 5678 })).toBe(0)
  expect((await getIssue(issue.id))?.externalRefs?.[0].departedAt).toBe(1234)
  expect(
    (await listIssueEvents({ issueId: issue.id })).filter(
      (event) => event.kind === "external_departed"
    )
  ).toHaveLength(1)
})

it("a push finishing after an authoritative departure cannot erase its remote version", async () => {
  const { provider } = fake({ pull: { items: [remote()], notModified: false } })
  await reconcileBinding(binding(), provider, { now: () => 2000 })
  const issue = (await getIssueByExternalKey("fake", "o/r#1"))!
  await updateIssue(issue.id, { title: "Local edit" }, HUMAN)
  provider.pullPage = async () => ({ items: [], cursor: "1000" })
  let entered!: () => void
  let release!: () => void
  const pushing = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  provider.push = async () => {
    entered()
    await gate
    return { status: "applied", remoteUpdatedAt: 5000 }
  }
  const run = reconcileBinding(binding(), provider)
  await pushing
  try {
    await tombstoneIssueSyncRefs(binding(), ["o/r#1"], { departedRemoteAt: 3000, now: () => 4000 })
  } finally {
    release()
  }
  expect((await run).status).toBe("completed")
  expect((await getIssue(issue.id))?.externalRefs?.[0]).toMatchObject({
    departedAt: 4000,
    meta: { departedRemoteAt: 3000 },
  })
  provider.pullPage = async () => ({ items: [remote({ remoteUpdatedAt: 3000 })], cursor: "3000" })
  await reconcileBinding(binding(), provider)
  expect((await getIssue(issue.id))?.externalRefs?.[0].departedAt).toBe(4000)
  expect(
    (await listIssueEvents({ issueId: issue.id })).filter(
      (event) => event.kind === "external_returned"
    )
  ).toHaveLength(0)
})

describe("reconcileBinding: import", () => {
  it("creates a local issue per unknown remote item, with labels, assignee and the ref", async () => {
    const { provider } = fake({ pull: { items: [remote()], notModified: false } })
    const outcome = await reconcileBinding(binding(), provider, { now: () => 2_000 })
    expect(outcome).toMatchObject({ created: 1, updated: 0, pushed: 0, conflicts: 0 })

    const issue = (await getIssueByExternalKey("fake", "o/r#1"))!
    expect(issue).toMatchObject({
      title: "Remote title",
      description: "Remote body",
      status: "todo",
      issueProjectId: container.id,
      assignee: { kind: "human", label: "octocat" },
      createdBy: { kind: "agent", id: "sync:fake" },
    })
    const labels = await listLabels("issue")
    expect(labels.some((row) => row.name === "bug")).toBe(true)
    expect(issue.labelIds).toHaveLength(1)
    expect(issue.externalRefs).toEqual([
      {
        provider: "fake",
        externalId: "o/r#1",
        url: "https://x/1",
        label: "o/r#1",
        syncedAt: 2_000,
        remoteUpdatedAt: 1_000,
        meta: { binding: "o/r" },
      },
    ])
    expect((await getDb().externalSyncCursors.get(issueSyncTarget(binding()).key))?.cursor).toBe(
      "1000"
    )
  })

  it("is idempotent: a second pass with the same remote changes nothing", async () => {
    const { provider } = fake({ pull: { items: [remote()], notModified: false } })
    await reconcileBinding(binding(), provider, { now: () => 2_000 })
    const outcome = await reconcileBinding(binding(), provider, { now: () => 3_000 })
    expect(outcome).toMatchObject({ created: 0, updated: 0, pushed: 0, conflicts: 0 })
    expect((await getDb().issues.toArray()).length).toBe(1)
  })

  it("passes the watermark to the provider and skips it on a full pass", async () => {
    const { provider, pulls } = fake({ pull: { items: [remote()], notModified: false } })
    await reconcileBinding(binding(), provider)
    await reconcileBinding(binding(), provider)
    await reconcileBinding(binding(), provider, { full: true })
    expect(pulls[0]).toEqual({ full: true, signal: expect.any(AbortSignal) })
    expect(pulls[1]).toEqual({ since: 1_000, signal: expect.any(AbortSignal) })
    expect(pulls[2]).toEqual({ full: true, signal: expect.any(AbortSignal) })
  })
})

describe("triage on import", () => {
  const triaging = () =>
    binding({
      resource: {
        kind: "github-repo",
        repoFullName: "o/r",
        addedAt: 1,
        sync: { mode: "import", triageNewIssues: true },
      },
    })

  it("files open, unassigned new items into triage when the binding opted in", async () => {
    const { provider } = fake({
      pull: {
        items: [
          remote({ externalId: "o/r#1", assigneeLabel: undefined }),
          remote({ externalId: "o/r#2" }),
          remote({ externalId: "o/r#3", assigneeLabel: undefined, status: "done" }),
        ],
        notModified: false,
      },
    })
    await reconcileBinding(triaging(), provider, { now: () => 2_000 })
    expect((await getIssueByExternalKey("fake", "o/r#1"))!.triage).toBe("pending")
    expect((await getIssueByExternalKey("fake", "o/r#2"))!.triage).toBeUndefined()
    expect((await getIssueByExternalKey("fake", "o/r#3"))!.triage).toBeUndefined()
  })

  it("leaves imports alone without the opt-in", () => {
    const open = { status: "todo" as const, assigneeLabel: undefined }
    expect(triageOnImport(triaging(), open)).toBe(true)
    expect(triageOnImport(binding(), open)).toBe(false)
    expect(
      triageOnImport(
        binding({ resource: { kind: "workspace-root", rootId: "r", addedAt: 1 } as never }),
        open
      )
    ).toBe(false)
  })
})

describe("reconcileBinding: field reconciliation", () => {
  async function importOne(): Promise<string> {
    const { provider } = fake({ pull: { items: [remote()], notModified: false } })
    await reconcileBinding(binding(), provider, { now: () => 2_000 })
    return (await getIssueByExternalKey("fake", "o/r#1"))!.id
  }

  it("applies a remote-only change and records synced_in", async () => {
    const id = await importOne()
    const { provider } = fake({
      pull: {
        items: [remote({ title: "Renamed remotely", remoteUpdatedAt: 3_000 })],
        notModified: false,
      },
    })
    // The ref is stamped no earlier than the newest event it examined, so a
    // fixed `now` must sit after the wall clock the events were written at.
    const T = Date.now() + 100_000
    const outcome = await reconcileBinding(binding(), provider, { now: () => T })
    expect(outcome).toMatchObject({ updated: 1, conflicts: 0, pushed: 0 })
    const issue = (await getIssue(id))!
    expect(issue.title).toBe("Renamed remotely")
    const kinds = (await listIssueEvents({ issueId: id })).map((e) => e.kind)
    expect(kinds).toContain("synced_in")
    expect(issue.externalRefs?.[0]).toMatchObject({ syncedAt: T, remoteUpdatedAt: 3_000 })
  })

  it("pushes a local-only change and advances the ref", async () => {
    const id = await importOne()
    await updateIssue(id, { title: "Renamed locally" }, HUMAN)
    await setIssueDueDate(id, 9_999, HUMAN)
    const { provider, pushes } = fake({ pull: { items: [remote()], notModified: false } })
    const T = Date.now() + 100_000
    const outcome = await reconcileBinding(binding(), provider, { now: () => T })
    expect(outcome).toMatchObject({ pushed: 1, conflicts: 0, updated: 0 })
    expect(pushes).toHaveLength(1)
    expect(pushes[0].patch).toEqual({ title: "Renamed locally", dueDate: 9_999 })
    expect(pushes[0].key).toBe(pushIdempotencyKey(id, pushes[0].patch))
    // A person made every edit it carries (ADR-0239).
    expect(pushes[0].editedBy).toBe("person")
    const issue = (await getIssue(id))!
    expect(issue.title).toBe("Renamed locally")
    expect(issue.externalRefs?.[0]).toMatchObject({ syncedAt: T, remoteUpdatedAt: 5_000 })
  })

  it("says an agent's edit was made by automation, even beside a person's (ADR-0239)", async () => {
    const id = await importOne()
    await updateIssue(id, { title: "Renamed by a person" }, HUMAN)
    await setIssueDueDate(id, 9_999, { kind: "agent", id: "agent-1" })
    const { provider, pushes } = fake({ pull: { items: [], notModified: true } })
    await reconcileBinding(binding(), provider, { now: () => Date.now() + 100_000 })
    expect(pushes[0].patch).toEqual({ title: "Renamed by a person", dueDate: 9_999 })
    expect(pushes[0].editedBy).toBe("automation")
  })

  it("hands a local assignee change to a provider that pushes assignees", async () => {
    const id = await importOne()
    await setIssueAssignee(id, { kind: "human", label: "hubot" }, HUMAN)
    const { provider, pushes } = fake({
      pull: { items: [], notModified: true },
      pushFields: ["title", "assignee"],
    })
    await reconcileBinding(binding(), provider, { now: () => Date.now() + 100_000 })
    expect(pushes[0].patch).toEqual({ assignee: "hubot" })
  })

  it("hands an unassignment to the provider as null", async () => {
    const id = await importOne()
    await setIssueAssignee(id, null, HUMAN)
    const { provider, pushes } = fake({
      pull: { items: [], notModified: true },
      pushFields: ["assignee"],
    })
    await reconcileBinding(binding(), provider, { now: () => Date.now() + 100_000 })
    expect(pushes[0].patch).toEqual({ assignee: null })
  })

  it("pushes local edits on rows an incremental pull did not mention", async () => {
    const id = await importOne()
    await updateIssue(id, { title: "Edited while remote was quiet" }, HUMAN)
    const { provider, pushes } = fake({ pull: { items: [], notModified: true } })
    const outcome = await reconcileBinding(binding(), provider, { now: () => 6_000 })
    expect(outcome.pushed).toBe(1)
    expect(pushes[0].patch).toEqual({ title: "Edited while remote was quiet" })
  })

  it("resolves a two-sided change by the newer side and records the conflict", async () => {
    const id = await importOne()
    // Local edit at ~now (well after 2_000), remote edit at 3_000: local is newer.
    await updateIssue(id, { title: "Local wins" }, HUMAN)
    const { provider, pushes } = fake({
      pull: {
        items: [remote({ title: "Remote loses", remoteUpdatedAt: 3_000 })],
        notModified: false,
      },
    })
    const outcome = await reconcileBinding(binding(), provider, { now: () => Date.now() + 10 })
    expect(outcome.conflicts).toBe(1)
    expect(outcome.pushed).toBe(1)
    expect((await getIssue(id))!.title).toBe("Local wins")
    expect(pushes[0].patch).toEqual({ title: "Local wins" })
    const conflict = (await listIssueEvents({ issueId: id })).find(
      (e) => e.kind === "sync_conflict"
    )!
    expect(conflict.payload).toMatchObject({
      kind: "sync_conflict",
      provider: "fake",
      field: "title",
      winner: "local",
      localValue: "Local wins",
      remoteValue: "Remote loses",
    })
  })

  it("lets a newer remote win a two-sided change", async () => {
    const id = await importOne()
    await updateIssue(id, { title: "Local loses" }, HUMAN)
    const { provider, pushes } = fake({
      pull: {
        items: [remote({ title: "Remote wins", remoteUpdatedAt: Date.now() + 60_000 })],
        notModified: false,
      },
    })
    const outcome = await reconcileBinding(binding(), provider)
    expect(outcome.conflicts).toBe(1)
    expect(pushes).toHaveLength(0)
    expect((await getIssue(id))!.title).toBe("Remote wins")
  })

  it("leaves the ref alone when a push is queued behind approval", async () => {
    const id = await importOne()
    await updateIssue(id, { title: "Pending" }, HUMAN)
    const { provider } = fake({
      pull: { items: [remote()], notModified: false },
      push: () => ({ status: "queued", jobId: "job-1" }),
    })
    const outcome = await reconcileBinding(binding(), provider, { now: () => 7_000 })
    expect(outcome).toMatchObject({ queued: 1, pushed: 0 })
    expect((await getIssue(id))!.externalRefs?.[0].syncedAt).toBe(2_000)
  })

  it("compares a coarse remote status by category, so a started issue stays started", async () => {
    const id = await importOne()
    const { moveIssue } = await import("@/lib/db/issues")
    await moveIssue({ id, to: "in_progress", by: HUMAN })
    const { provider, pushes } = fake({
      pull: {
        items: [remote({ status: "todo", coarseStatus: true, remoteUpdatedAt: 3_000 })],
        notModified: false,
      },
    })
    const T = Date.now() + 100_000
    const outcome = await reconcileBinding(binding(), provider, { now: () => T })
    expect(outcome.conflicts).toBe(0)
    expect((await getIssue(id))!.status).toBe("in_progress")
    // The local move is a status change in the same category, so nothing pushes either.
    expect(pushes).toHaveLength(0)
    // A remote close is a category change and still lands.
    const closed = fake({
      pull: {
        items: [remote({ status: "done", coarseStatus: true, remoteUpdatedAt: T + 1 })],
        notModified: false,
      },
    })
    await reconcileBinding(binding(), closed.provider, { now: () => T + 2 })
    expect((await getIssue(id))!.status).toBe("done")
  })

  it("never pushes a field the provider does not accept", async () => {
    const id = await importOne()
    await updateIssue(id, { priority: "urgent" }, HUMAN)
    const { provider, pushes } = fake({ pull: { items: [remote()], notModified: false } })
    await reconcileBinding(binding(), provider)
    expect(pushes).toHaveLength(0)
  })

  it("does not import into another workspace's container and ignores foreign locals", async () => {
    const other = await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    await createIssue({
      projectId: "w2",
      issueProjectId: other.id,
      title: "foreign",
      createdBy: HUMAN,
      externalRefs: [{ provider: "fake", externalId: "o/r#1" }],
    })
    const { provider } = fake({ pull: { items: [remote()], notModified: false } })
    const outcome = await reconcileBinding(binding(), provider)
    expect(outcome).toMatchObject({ created: 0, updated: 0 })
  })
})

describe("reconcileBinding: cycles and links", () => {
  it("keeps equal external cycle identities separate across workspaces and bindings", async () => {
    const first = fake({
      pull: {
        items: [],
        notModified: false,
        cycles: [{ externalId: "shared", kind: "milestone", name: "First" }],
      },
    })
    await reconcileBinding(binding(), first.provider)
    const other = await createIssueProject({ projectId: "w2", name: "Other", key: "OTHER" })
    const second = fake({
      pull: {
        items: [],
        notModified: false,
        cycles: [{ externalId: "shared", kind: "milestone", name: "Second" }],
      },
    })
    await reconcileBinding(
      binding({ projectId: "w2", issueProjectId: other.id, key: "o/other" }),
      second.provider
    )
    await reconcileBinding(
      binding({ projectId: "w2", issueProjectId: other.id, key: "o/other" }),
      second.provider
    )
    expect((await listIssueCycles({ projectId: "w1" })).map((c) => c.name)).toEqual(["First"])
    expect((await listIssueCycles({ projectId: "w2" })).map((c) => c.name)).toEqual(["Second"])
  })

  it("upgrades a legacy cycle ref in place without breaking existing issue references", async () => {
    const old = await createIssueCycle({
      projectId: "w1",
      issueProjectId: container.id,
      kind: "milestone",
      name: "Old",
      externalRefs: [{ provider: "fake", externalId: "milestone/3", meta: { binding: "o/r" } }],
    })
    const local = await createIssue({
      projectId: "w1",
      issueProjectId: container.id,
      title: "Already planned",
      createdBy: HUMAN,
    })
    await setIssueCycle(local.id, old.id, HUMAN)
    const { provider } = fake({
      pull: {
        items: [remote({ cycleExternalId: "milestone/github.com/o/r/3" })],
        cycles: [
          {
            externalId: "milestone/github.com/o/r/3",
            legacyExternalIds: ["milestone/3"],
            kind: "milestone",
            name: "New",
          },
        ],
        notModified: false,
      },
    })
    await reconcileBinding(binding(), provider)
    const cycles = await listIssueCycles({ projectId: "w1" })
    expect(cycles).toHaveLength(1)
    expect(cycles[0]).toMatchObject({
      id: old.id,
      name: "New",
      externalKeys: ["fake:milestone/github.com/o/r/3"],
    })
    expect((await getIssueByExternalKey("fake", "o/r#1"))!.cycleId).toBe(old.id)
    expect((await getIssue(local.id))!.cycleId).toBe(old.id)
  })

  it("does not migrate a legacy ref belonging to another binding in the same container", async () => {
    const old = await createIssueCycle({
      projectId: "w1",
      issueProjectId: container.id,
      kind: "milestone",
      name: "Other",
      externalRefs: [{ provider: "fake", externalId: "milestone/3", meta: { binding: "o/other" } }],
    })
    const { provider } = fake({
      pull: {
        items: [],
        cycles: [
          {
            externalId: "milestone/github.com/o/r/3",
            legacyExternalIds: ["milestone/3"],
            kind: "milestone",
            name: "This repository",
          },
        ],
        notModified: false,
      },
    })
    await reconcileBinding(binding(), provider)
    const cycles = await listIssueCycles({ projectId: "w1" })
    expect(cycles).toHaveLength(2)
    expect(cycles.find((cycle) => cycle.id === old.id)).toMatchObject({
      name: "Other",
      externalKeys: ["fake:milestone/3"],
    })
  })

  it("does not consume pending changes when the provider rejects unsupported planning writes", async () => {
    const initial = fake({ pull: { items: [remote()], notModified: false } })
    await reconcileBinding(binding(), initial.provider, { now: () => 2000 })
    const local = (await getIssueByExternalKey("fake", "o/r#1"))!
    const cycle = await createIssueCycle({
      projectId: "w1",
      issueProjectId: container.id,
      kind: "cycle",
      name: "Iteration",
      externalRefs: [{ provider: "fake", externalId: "iteration/new", meta: { binding: "o/r" } }],
    })
    await setIssueCycle(local.id, cycle.id, HUMAN)
    const failing = fake({
      pushFields: ["cycle"],
      push: () => {
        throw new Error("iteration writes unsupported")
      },
    })
    await expect(reconcileBinding(binding(), failing.provider)).resolves.toMatchObject({
      status: "failed",
      errorCode: "sync-failed",
    })
    const after = (await getIssue(local.id))!
    expect(after.externalRefs![0].syncedAt).toBe(local.externalRefs![0].syncedAt)
    expect(after.cycleId).toBe(cycle.id)
    await expect(reconcileBinding(binding(), failing.provider)).resolves.toMatchObject({
      status: "backoff",
      errorCode: "sync-failed",
    })
    expect(failing.pushes).toHaveLength(1)
    await expect(
      reconcileBinding(binding(), failing.provider, { now: () => Date.now() + 60_000 })
    ).resolves.toMatchObject({ status: "failed" })
    expect(failing.pushes).toHaveLength(2)
    expect(failing.pushes[0].key).toBe(failing.pushes[1].key)
  })

  it("upserts remote cycles and plans imported issues into them", async () => {
    const { provider } = fake({
      pull: {
        items: [remote({ cycleExternalId: "milestone/3" })],
        cycles: [{ externalId: "milestone/3", kind: "milestone", name: "v1.0", status: "active" }],
        notModified: false,
      },
    })
    await reconcileBinding(binding(), provider)
    const cycles = await listIssueCycles({ projectId: "w1" })
    expect(cycles).toHaveLength(1)
    expect(cycles[0]).toMatchObject({
      name: "v1.0",
      kind: "milestone",
      issueProjectId: container.id,
    })
    expect((await getIssueByExternalKey("fake", "o/r#1"))!.cycleId).toBe(cycles[0].id)

    const renamed = fake({
      pull: {
        items: [],
        cycles: [
          { externalId: "milestone/3", kind: "milestone", name: "v1.1", status: "completed" },
        ],
        notModified: false,
      },
    })
    await reconcileBinding(binding(), renamed.provider)
    const after = await listIssueCycles({ projectId: "w1" })
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ name: "v1.1", status: "completed" })
  })

  it("attaches link refs to the issues a pull request names, by identifier or remote id", async () => {
    const local = await createIssue({
      projectId: "w1",
      issueProjectId: container.id,
      title: "Local only",
      createdBy: HUMAN,
    })
    const { provider } = fake({
      pull: {
        items: [remote()],
        links: [
          {
            provider: "github-pr",
            externalId: "o/r#7",
            url: "https://x/pull/7",
            label: "PR #7",
            mentionsIdentifiers: [local.identifier],
            mentionsExternalIds: ["o/r#1"],
          },
        ],
        notModified: false,
      },
    })
    const outcome = await reconcileBinding(binding(), provider)
    expect(outcome.linked).toBe(2)
    expect((await getIssue(local.id))!.externalKeys).toContain("github-pr:o/r#7")
    expect((await getIssueByExternalKey("fake", "o/r#1"))!.externalKeys).toContain(
      "github-pr:o/r#7"
    )
    // Linking again is a no-op.
    expect((await reconcileBinding(binding(), provider)).linked).toBe(0)
  })

  it("records a pull request's state on every issue carrying it, including run-made links", async () => {
    const named = await createIssue({
      projectId: "w1",
      issueProjectId: container.id,
      title: "Named in the PR",
      createdBy: HUMAN,
    })
    // Linked by the run that opened the PR; the PR text never names it.
    const opener = await createIssue({
      projectId: "w1",
      issueProjectId: container.id,
      title: "Opened by a run",
      createdBy: HUMAN,
    })
    await linkIssueExternal(
      opener.id,
      { provider: "github-pr", externalId: "o/r#8", url: "https://x/pull/8" },
      HUMAN
    )
    const pass = (prState: "open" | "merged") =>
      fake({
        pull: {
          items: [],
          links: [
            {
              provider: "github-pr",
              externalId: "o/r#8",
              url: "https://x/pull/8",
              label: "PR #8",
              mentionsIdentifiers: [named.identifier],
              mentionsExternalIds: [],
              prState,
            },
          ],
          notModified: false,
        },
      }).provider
    await reconcileBinding(binding(), pass("open"))
    await reconcileBinding(binding(), pass("open"))
    await reconcileBinding(binding(), pass("merged"))
    for (const id of [named.id, opener.id]) {
      const states = (await listIssueEvents({ issueId: id }))
        .filter((event) => event.kind === "pr_state_changed")
        .map((event) => (event.payload as { to: string }).to)
      expect(states).toEqual(["open", "merged"])
    }
  })

  it("records a linked pull request's CI once per change beside its state", async () => {
    const named = await createIssue({
      projectId: "w1",
      issueProjectId: container.id,
      title: "Waiting on CI",
      createdBy: HUMAN,
    })
    const pass = (ciState?: "pending" | "passing") =>
      fake({
        pull: {
          items: [],
          links: [
            {
              provider: "github-pr",
              externalId: "o/r#9",
              mentionsIdentifiers: [named.identifier],
              mentionsExternalIds: [],
              prState: "open",
              ...(ciState ? { ciState } : {}),
            },
          ],
          notModified: false,
        },
      }).provider
    await reconcileBinding(binding(), pass("pending"))
    await reconcileBinding(binding(), pass("pending"))
    // A pass whose CI read failed changes nothing.
    await reconcileBinding(binding(), pass())
    await reconcileBinding(binding(), pass("passing"))
    const checks = (await listIssueEvents({ issueId: named.id }))
      .filter((event) => event.kind === "pr_checks_changed")
      .map((event) => (event.payload as { to: string }).to)
    expect(checks).toEqual(["pending", "passing"])
  })
})

// Stored checkpoints, rather than the newest ref touched by an incomplete pass.
describe("incremental core", () => {
  it("resumes page two after failure even though page one already touched a newer ref", async () => {
    const { provider } = fake()
    let fail = true
    const fetch = jest.fn(async ({ page }: { page?: string }): Promise<PullPage> => {
      if (!page) return { items: [remote({ remoteUpdatedAt: 10_000 })], nextPage: "second" }
      if (fail) throw new Error("page two unavailable")
      return { items: [remote({ externalId: "o/r#2", remoteUpdatedAt: 500 })], cursor: "10000" }
    })
    provider.pullPage = (_binding, input) => fetch(input)
    expect(await reconcileBinding(binding(), provider, { now: () => 20_000 })).toMatchObject({
      status: "failed",
      pages: 1,
    })
    expect((await getIssueByExternalKey("fake", "o/r#1"))?.externalRefs?.[0].remoteUpdatedAt).toBe(
      10_000
    )
    expect(
      (await getDb().externalSyncCursors.get(issueSyncTarget(binding()).key))?.cursor
    ).toBeUndefined()
    fail = false
    expect(await reconcileBinding(binding(), provider, { now: () => 100_000 })).toMatchObject({
      status: "completed",
      pages: 2,
      created: 1,
    })
    expect(fetch.mock.calls.map(([input]) => input.page)).toEqual([undefined, "second", "second"])
    expect(await getIssueByExternalKey("fake", "o/r#2")).toBeDefined()
    expect((await getDb().externalSyncCursors.get(issueSyncTarget(binding()).key))?.cursor).toBe(
      "10000"
    )
  })

  it("does not seed a first scan from old refs or advance a truncated legacy cursor", async () => {
    await createIssue({
      projectId: "w1",
      issueProjectId: container.id,
      title: "Old gap",
      createdBy: HUMAN,
      externalRefs: [
        { provider: "fake", externalId: "old", remoteUpdatedAt: 99_999, meta: { binding: "o/r" } },
      ],
    })
    const { provider, pulls } = fake({
      pull: { items: [remote()], notModified: false, truncated: true },
    })
    expect(await reconcileBinding(binding(), provider)).toMatchObject({
      status: "completed",
      truncated: true,
    })
    expect(pulls[0]).toMatchObject({ full: true })
    expect(pulls[0].since).toBeUndefined()
    const key = issueSyncTarget(binding()).key
    expect((await getDb().externalSyncCursors.get(key))?.cursor).toBe("0")
    await getDb().externalSyncCursors.update(key, { cursor: "500" })
    await reconcileBinding(binding(), provider)
    expect(pulls[1]).toMatchObject({ since: 500 })
    expect((await getDb().externalSyncCursors.get(key))?.cursor).toBe("500")
  })

  it("keeps departed issues, emits one event per transition and excludes them from pushes", async () => {
    const { provider, pushes } = fake()
    Object.assign(provider, { completeFullScan: true, fullScanOnly: true })
    let items = [remote()]
    provider.pullPage = async () => ({ items, cursor: "full" })
    await reconcileBinding(binding(), provider, { now: () => 2000 })
    const issue = (await getIssueByExternalKey("fake", "o/r#1"))!
    await updateIssue(issue.id, { title: "Keep my copy" }, HUMAN)
    items = []
    expect(await reconcileBinding(binding(), provider, { now: () => 3000 })).toMatchObject({
      status: "completed",
      tombstoned: 1,
    })
    await reconcileBinding(binding(), provider, { now: () => 4000 })
    expect(pushes).toEqual([])
    expect((await getIssue(issue.id))?.externalRefs?.[0].departedAt).toBe(3000)
    expect(
      (await listIssueEvents({ issueId: issue.id })).filter(
        (event) => event.kind === "external_departed"
      )
    ).toHaveLength(1)
    items = [remote()]
    await reconcileBinding(binding(), provider, { now: () => 5000 })
    expect((await getIssue(issue.id))?.externalRefs?.[0].departedAt).toBeUndefined()
    expect(
      (await listIssueEvents({ issueId: issue.id })).filter(
        (event) => event.kind === "external_returned"
      )
    ).toHaveLength(1)
    expect((await getIssue(issue.id))?.title).toBe("Keep my copy")
  })

  it("tombstones explicit deletions but never infers absence without completeFullScan", async () => {
    const { provider } = fake({ pull: { items: [remote()], notModified: false } })
    await reconcileBinding(binding(), provider)
    const issue = (await getIssueByExternalKey("fake", "o/r#1"))!
    provider.pullPage = async () => ({ items: [], cursor: "next" })
    await reconcileBinding(binding(), provider, { full: true })
    expect((await getIssue(issue.id))?.externalRefs?.[0].departedAt).toBeUndefined()
    provider.pullPage = async () => ({ items: [], deleted: ["o/r#1"], cursor: "deleted" })
    expect(await reconcileBinding(binding(), provider)).toMatchObject({
      status: "completed",
      tombstoned: 1,
    })
  })

  it("honours 429 retryAfter even for fullScanOnly and sends no local edits during backoff", async () => {
    const { provider, pushes } = fake({ pull: { items: [remote()], notModified: false } })
    await reconcileBinding(binding(), provider, { now: () => 1000 })
    const issue = (await getIssueByExternalKey("fake", "o/r#1"))!
    await updateIssue(issue.id, { title: "Wait for retry" }, HUMAN)
    Object.assign(provider, { fullScanOnly: true })
    provider.pullPage = jest.fn(async () => {
      throw new ExternalSyncRateLimited(123_000)
    })
    expect(await reconcileBinding(binding(), provider, { now: () => 2000 })).toMatchObject({
      status: "backoff",
      errorCode: "rate-limited",
    })
    const key = issueSyncTarget(binding()).key
    expect((await getDb().externalSyncCursors.get(key))?.backoffUntil).toBe(125_000)
    expect(await reconcileBinding(binding(), provider, { now: () => 124_999 })).toMatchObject({
      status: "backoff",
    })
    expect(provider.pullPage).toHaveBeenCalledTimes(1)
    expect(pushes).toEqual([])
    provider.pullPage = async () => ({ items: [], cursor: "next" })
    expect(await reconcileBinding(binding(), provider, { now: () => 125_000 })).toMatchObject({
      status: "completed",
      pushed: 1,
    })
  })

  it("returns busy when another context holds its connection lease", async () => {
    const { provider, pushes } = fake()
    const pull = jest.spyOn(provider, "pull")
    provider.prepare = async () => ({ provider, connectionRef: "connection" as AuthConnectionRef })
    const key = issueSyncTarget(binding()).key
    await getDb().authConnections.put({ id: "connection", status: "connected" } as never)
    expect(await claimSyncLease("connection", `sync:${key}`, "other-tab", 30_000)).not.toBeNull()
    expect(await reconcileBinding(binding(), provider)).toMatchObject({ status: "busy" })
    expect(pull).not.toHaveBeenCalled()
    expect(pushes).toEqual([])
  })

  it("keeps the named lock through the final local-edits pass", async () => {
    const { provider } = fake({ pull: { items: [remote()], notModified: false } })
    await reconcileBinding(binding(), provider, { now: () => 1000 })
    const issue = (await getIssueByExternalKey("fake", "o/r#1"))!
    await updateIssue(issue.id, { title: "Push once" }, HUMAN)
    provider.pull = async () => ({ items: [], notModified: true })
    let finish!: () => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    provider.push = async () => {
      started()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { status: "applied" }
    }
    const first = reconcileBinding(binding(), provider)
    await ready
    expect(await reconcileBinding(binding(), provider)).toMatchObject({ status: "busy" })
    finish()
    expect(await first).toMatchObject({ status: "completed", pushed: 1 })
  })

  it("purges only plugin-owned cursor state, retaining user-kept issues", async () => {
    const { provider } = fake({ pull: { items: [remote()], notModified: false } })
    const pluginBinding = binding({ providerId: "plugin:tracker/business" })
    await reconcileBinding(pluginBinding, provider)
    expect((await getDb().externalSyncCursors.get(issueSyncTarget(pluginBinding).key))?.owner).toBe(
      "plugin:tracker"
    )
    // Targets are local-container + binding-key; exercise distinct Host state too.
    const hostBinding = binding({ key: "another" })
    await reconcileBinding(hostBinding, provider)
    await purgePluginExternalServices("tracker")
    expect(
      await getDb().externalSyncCursors.get(issueSyncTarget(pluginBinding).key)
    ).toBeUndefined()
    expect(await getDb().externalSyncCursors.get(issueSyncTarget(hostBinding).key)).toBeDefined()
    expect(await getIssueByExternalKey(pluginBinding.providerId, "o/r#1")).toBeDefined()
  })
})

it("uses the Lark full listing, including done tasks, to detect departure and return on every pass", async () => {
  let includeDone = true
  const pages: string[] = []
  const provider = createLarkTaskSyncProvider({
    withApi: async (_adapter, fn) =>
      fn({
        get: async <T>(path: string): Promise<T> => {
          if (path.includes("/sections?")) return { items: [] } as T
          if (path.includes("/tasklists/tl/tasks?")) {
            pages.push(path)
            return (
              path.includes("page_token=second")
                ? { items: [{ guid: "done" }] }
                : {
                    items: [{ guid: "open" }],
                    ...(includeDone ? { has_more: true, page_token: "second" } : {}),
                  }
            ) as T
          }
          return {
            task: {
              guid: path.includes("/done?") ? "done" : "open",
              summary: "Kept task",
              completed_at: path.includes("/done?") ? "1000" : "0",
              tasklists: [{ tasklist_guid: "tl" }],
              updated_at: "1000",
            },
          } as T
        },
        post: async () => {
          throw new Error("Unexpected write")
        },
      }),
  })
  const b = binding({
    providerId: "lark-task",
    key: "adapter:tl",
    resource: {
      kind: "lark-tasklist",
      adapterId: "adapter",
      tasklistGuid: "tl",
      name: "Tasks",
      addedAt: 1,
    },
  })
  expect(await reconcileBinding(b, provider)).toMatchObject({
    status: "completed",
    created: 2,
    pages: 2,
  })
  const done = (await getIssueByExternalKey("lark-task", "done"))!
  expect(done.status).toBe("done")
  includeDone = false
  expect(await reconcileBinding(b, provider)).toMatchObject({ status: "completed", tombstoned: 1 })
  expect((await getIssue(done.id))?.externalRefs?.[0].departedAt).toBeDefined()
  includeDone = true
  expect(await reconcileBinding(b, provider)).toMatchObject({ status: "completed", pages: 2 })
  expect((await getIssue(done.id))?.externalRefs?.[0].departedAt).toBeUndefined()
  expect(pages.some((path) => path.includes("page_token=second"))).toBe(true)
})

it("defers offline before credential resolution and binds the actual connection on recovery", async () => {
  await getDb().authConnections.put({ id: "resolved-online", status: "connected" } as never)
  const { provider } = fake({ pull: { items: [remote()], notModified: false } })
  provider.prepare = jest.fn(async () => ({
    provider,
    connectionRef: "resolved-online" as AuthConnectionRef,
  }))
  const pull = jest.spyOn(provider, "pull")
  const offline = jest.spyOn(navigator, "onLine", "get").mockReturnValue(false)
  try {
    expect(await reconcileBinding(binding(), provider)).toMatchObject({
      status: "deferred-offline",
    })
    expect(provider.prepare).not.toHaveBeenCalled()
    expect(pull).not.toHaveBeenCalled()
  } finally {
    offline.mockRestore()
  }
  expect(await reconcileBinding(binding(), provider)).toMatchObject({
    status: "completed",
    created: 1,
  })
  expect(
    (await getDb().externalSyncCursors.get(issueSyncTarget(binding()).key))?.connectionRef
  ).toBe("resolved-online")
})

function mutableGithubRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    title: `Remote ${i + 1}`,
    state: "open",
    html_url: `https://github.com/o/r/issues/${i + 1}`,
    created_at: new Date(1000 + i).toISOString(),
    updated_at: new Date(2000 + i * 2000).toISOString(),
  }))
}

function mutableGithubProvider(
  rows: ReturnType<typeof mutableGithubRows>,
  beforeRead?: (read: number) => void,
  deps: GithubSyncProviderDeps = {}
) {
  const requests: Record<string, unknown>[] = []
  const confirmations: number[] = []
  const provider = createGithubSyncProvider({
    ...deps,
    resolveOctokitOrNull: async () => ({
      request: async (route, params = {}) => {
        if (route.endsWith("/issues/{issue_number}")) {
          confirmations.push(Number(params.issue_number))
          const row = rows.find((item) => item.number === params.issue_number)
          return { status: row ? 200 : 404, headers: {}, data: row ? { ...row } : {} }
        }
        if (!route.endsWith("/issues")) return { status: 200, headers: {}, data: [] }
        requests.push(params)
        beforeRead?.(requests.length)
        const since = typeof params.since === "string" ? Date.parse(params.since) : -Infinity
        const sorted = rows
          .filter((row) => Date.parse(row.updated_at) > since)
          .sort((a, b) =>
            params.sort === "updated"
              ? Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.number - b.number
              : a.number - b.number
          )
        const offset = (Number(params.page) - 1) * Number(params.per_page)
        const next = offset + Number(params.per_page) < sorted.length
        return {
          status: 200,
          headers: next
            ? {
                link: `<https://api.github.com/repos/o/r/issues?page=${Number(params.page) + 1}>; rel="next"`,
              }
            : {},
          data: sorted.slice(offset, offset + Number(params.per_page)).map((row) => ({ ...row })),
        }
      },
    }),
  })
  return { provider, requests, confirmations }
}

it("does not skip the first unread GitHub item when a page-one push changes updated_at", async () => {
  const rows = mutableGithubRows(101)
  const local = await createIssue({
    projectId: "w1",
    issueProjectId: container.id,
    title: "Remote 1",
    status: "todo",
    createdBy: HUMAN,
    externalRefs: [
      {
        provider: "github",
        externalId: "o/r#1",
        syncedAt: 1000,
        remoteUpdatedAt: 2000,
        meta: { binding: "o/r" },
      },
    ],
  })
  await updateIssue(local.id, { title: "Local edit" }, HUMAN)
  const { provider } = mutableGithubProvider(rows, undefined, {
    resolveAccount: async () => ({ id: "account" }) as never,
    execute: async () => {
      rows[0].updated_at = new Date(Date.now()).toISOString()
      rows[0].title = "Local edit"
      return { status: "succeeded" } as never
    },
  })
  expect(await reconcileBinding(binding({ providerId: "github" }), provider)).toMatchObject({
    status: "completed",
    pages: 2,
    pushed: 1,
    created: 100,
  })
  expect(await getIssueByExternalKey("github", "o/r#101")).toBeDefined()
  expect((await getIssue(local.id))?.title).toBe("Local edit")
})

it("re-reads an item updated on an already-consumed GitHub page before committing the cursor", async () => {
  const rows = mutableGithubRows(201)
  const { provider } = mutableGithubProvider(rows, (read) => {
    if (read !== 2) return
    rows[0].title = "Updated during scan"
    rows[0].updated_at = new Date(Date.parse(rows[149].updated_at) + 500).toISOString()
  })
  expect(await reconcileBinding(binding({ providerId: "github" }), provider)).toMatchObject({
    status: "completed",
    created: 201,
  })
  expect((await getIssueByExternalKey("github", "o/r#1"))?.title).toBe("Updated during scan")
  expect(
    (await getDb().externalSyncCursors.get(issueSyncTarget(binding({ providerId: "github" })).key))
      ?.cursor
  ).toBe(String(Date.parse(rows[200].updated_at)))
})

it("deleting a consumed GitHub item neither hides nor falsely tombstones unread live items", async () => {
  const b = binding({ providerId: "github" })
  for (const number of [101, 999])
    await createIssue({
      projectId: "w1",
      issueProjectId: container.id,
      title: `Previously linked ${number}`,
      createdBy: HUMAN,
      externalRefs: [{ provider: "github", externalId: `o/r#${number}`, meta: { binding: b.key } }],
    })
  const rows = mutableGithubRows(201)
  const { provider } = mutableGithubProvider(rows, (read) => {
    if (read === 2) rows.splice(0, 1)
  })
  expect(await reconcileBinding(b, provider)).toMatchObject({ status: "completed", tombstoned: 1 })
  for (const row of rows)
    expect(
      (await getIssueByExternalKey("github", `o/r#${row.number}`))?.externalRefs?.[0]
    ).toMatchObject({ meta: { binding: b.key } })
  expect(
    (await getIssueByExternalKey("github", "o/r#101"))?.externalRefs?.[0].departedAt
  ).toBeUndefined()
  const departed = (await getDb().issues.toArray()).flatMap((issue) =>
    (issue.externalRefs ?? [])
      .filter((ref) => ref.departedAt !== undefined)
      .map((ref) => ref.externalId)
  )
  expect(departed).toEqual(["o/r#999"])
})

it("pages identical GitHub timestamps without repeating a core page token", async () => {
  const rows = mutableGithubRows(201).map((row) => ({
    ...row,
    updated_at: new Date(20_000).toISOString(),
  }))
  const { provider, requests } = mutableGithubProvider(rows)
  expect(await reconcileBinding(binding({ providerId: "github" }), provider)).toMatchObject({
    status: "completed",
    pages: 4,
    created: 201,
    tombstoned: 0,
  })
  expect(requests.map((request) => request.page)).toEqual([1, 1, 2, 3])
  expect(requests.map((request) => request.since)).toEqual([
    new Date(0).toISOString(),
    ...Array(3).fill(new Date(19_000).toISOString()),
  ])
})

it("does not tombstone a live item when deletion shifts an equal-timestamp boundary", async () => {
  const b = binding({ providerId: "github" })
  for (const number of [101, 999])
    await createIssue({
      projectId: "w1",
      issueProjectId: container.id,
      title: `Previously linked ${number}`,
      createdBy: HUMAN,
      externalRefs: [{ provider: "github", externalId: `o/r#${number}`, meta: { binding: b.key } }],
    })
  const rows = mutableGithubRows(202).map((row, index) => ({
    ...row,
    updated_at: new Date(index < 201 ? 20_000 : 40_000).toISOString(),
  }))
  const { provider, confirmations } = mutableGithubProvider(rows, (read) => {
    if (read === 3) rows.splice(0, 1)
  })
  const outcome = await reconcileBinding(b, provider)
  expect(outcome.status).toBe("completed")
  expect((await getDb().externalSyncCursors.get(issueSyncTarget(b).key))?.cursor).toBe("20000")
  expect(
    (await getIssueByExternalKey("github", "o/r#101"))?.externalRefs?.[0].departedAt
  ).toBeUndefined()
  expect(outcome.tombstoned).toBe(1)
  expect(confirmations.sort((a, b) => a - b)).toEqual([101, 999])
  expect(await reconcileBinding(b, provider)).toMatchObject({ status: "completed", tombstoned: 0 })
  expect(await getIssueByExternalKey("github", "o/r#101")).toMatchObject({
    title: "Remote 101",
    externalRefs: [expect.objectContaining({ remoteUpdatedAt: 20_000 })],
  })
})

it("shares the departure-verification budget across pages and the full-scan sweep", async () => {
  const b = binding()
  const ids = Array.from({ length: 60 }, (_, index) => `o/r#${index + 1}`)
  for (const externalId of ids)
    await createIssue({
      projectId: b.projectId,
      issueProjectId: b.issueProjectId,
      title: externalId,
      createdBy: HUMAN,
      externalRefs: [{ provider: b.providerId, externalId, meta: { binding: b.key } }],
    })
  const provider: IssueSyncProvider = {
    ...fake({ pushFields: [] }).provider,
    completeFullScan: true,
    pullPage: async (_binding, options) =>
      options.page
        ? { items: [], cursor: "1" }
        : { items: [], deleted: ids.slice(0, 20), nextPage: "terminal" },
  }
  const confirm = jest.fn(async (_binding: IssueSyncBinding, checked: string[]) => checked)
  provider.confirmDeparted = confirm
  expect(await reconcileBinding(b, provider)).toMatchObject({ status: "completed", tombstoned: 50 })
  expect(confirm.mock.calls.map(([, checked]) => checked.length)).toEqual([20, 30])
  expect(new Set(confirm.mock.calls.flatMap(([, checked]) => checked)).size).toBe(50)
  const active = (await getDb().issues.toArray()).filter(
    (issue) => issue.externalRefs?.[0]?.departedAt === undefined
  )
  expect(active).toHaveLength(10)
  confirm.mockClear()
  expect(await reconcileBinding(b, provider, { full: true })).toMatchObject({
    status: "completed",
    tombstoned: 10,
  })
  expect(confirm.mock.calls.flatMap(([, checked]) => checked)).toHaveLength(10)
})

it.each([
  [new Error("verification failed"), "failed"],
  [new ExternalSyncRateLimited(7000), "backoff"],
] as const)(
  "does not tombstone any ref when departure verification rejects: %s",
  async (error, status) => {
    const b = binding()
    const local = await createIssue({
      projectId: b.projectId,
      issueProjectId: b.issueProjectId,
      title: "Keep",
      createdBy: HUMAN,
      externalRefs: [{ provider: b.providerId, externalId: "o/r#1", meta: { binding: b.key } }],
    })
    const provider: IssueSyncProvider = {
      ...fake({ pushFields: [] }).provider,
      completeFullScan: true,
      pullPage: async () => ({ items: [], cursor: "1000" }),
    }
    provider.confirmDeparted = async () => {
      throw error
    }
    expect(await reconcileBinding(b, provider, { now: () => 1000 })).toMatchObject({
      status,
      tombstoned: 0,
    })
    expect((await getIssue(local.id))?.externalRefs?.[0]?.departedAt).toBeUndefined()
    expect((await listIssueEvents({ issueId: local.id })).map((event) => event.kind)).toEqual([
      "created",
    ])
    const stored = await getDb().externalSyncCursors.get(issueSyncTarget(b).key)
    expect(stored?.cursor).toBeUndefined()
    if (status === "backoff") expect(stored?.backoffUntil).toBe(8000)
  }
)

it("limits confirmed departures to the requested binding refs", async () => {
  const b = binding()
  const local = await createIssue({
    projectId: b.projectId,
    issueProjectId: b.issueProjectId,
    title: "Keep",
    createdBy: HUMAN,
    externalRefs: [{ provider: b.providerId, externalId: "o/r#1", meta: { binding: b.key } }],
  })
  const { provider } = fake({ pushFields: [] })
  provider.pullPage = async () => ({ items: [], deleted: ["foreign-id"], cursor: "1" })
  const confirm = jest.fn(async () => ["o/r#1"])
  provider.confirmDeparted = confirm
  expect(await reconcileBinding(b, provider)).toMatchObject({ status: "completed", tombstoned: 0 })
  expect(confirm).not.toHaveBeenCalled()
  expect((await getIssue(local.id))?.externalRefs?.[0]?.departedAt).toBeUndefined()
  const other = await createIssue({
    projectId: b.projectId,
    issueProjectId: b.issueProjectId,
    title: "Also keep",
    createdBy: HUMAN,
    externalRefs: [{ provider: b.providerId, externalId: "o/r#2", meta: { binding: b.key } }],
  })
  provider.pullPage = async () => ({ items: [], deleted: ["o/r#2"], cursor: "2" })
  expect(await reconcileBinding(b, provider)).toMatchObject({ status: "completed", tombstoned: 0 })
  expect(confirm).toHaveBeenCalledWith(b, ["o/r#2"], { signal: expect.any(AbortSignal) })
  expect((await getIssue(local.id))?.externalRefs?.[0]?.departedAt).toBeUndefined()
  expect((await getIssue(other.id))?.externalRefs?.[0]?.departedAt).toBeUndefined()
})

it("never lowers an existing GitHub cursor on a full rescan", async () => {
  const b = binding({ providerId: "github" })
  await getDb().externalSyncCursors.put({ ...issueSyncTarget(b), cursor: "1000000", failures: 0 })
  const { provider, requests } = mutableGithubProvider(mutableGithubRows(1))
  expect(await reconcileBinding(b, provider, { full: true })).toMatchObject({
    status: "completed",
    created: 1,
  })
  expect(requests[0].since).toBe(new Date(0).toISOString())
  expect((await getDb().externalSyncCursors.get(issueSyncTarget(b).key))?.cursor).toBe("1000000")
})

it("adopts a bare GitHub link actually read by this binding and reconciles later updates", async () => {
  const local = await createIssue({
    projectId: "w1",
    issueProjectId: container.id,
    title: "Before sync",
    createdBy: HUMAN,
  })
  await linkIssueToGithub(
    local.id,
    { repoFullName: "o/r", number: 1, htmlUrl: "https://github.com/o/r/issues/1" },
    HUMAN
  )
  const b = binding({ providerId: "github" })
  const { provider } = fake({
    pull: { items: [remote({ title: "Remote linked title" })], notModified: false },
  })
  expect(await reconcileBinding(b, provider)).toMatchObject({
    status: "completed",
    updated: 1,
    created: 0,
  })
  expect(await getIssue(local.id)).toMatchObject({
    title: "Remote linked title",
    externalRefs: [expect.objectContaining({ meta: { binding: b.key } })],
  })
  const updated = fake({
    pull: {
      items: [remote({ title: "Later remote title", remoteUpdatedAt: Date.now() + 1000 })],
      notModified: false,
    },
  })
  expect(await reconcileBinding(b, updated.provider)).toMatchObject({
    status: "completed",
    updated: 1,
  })
  expect((await getIssue(local.id))?.title).toBe("Later remote title")
})

it("adopts and reconciles a GitHub link created concurrently with an import", async () => {
  const local = await createIssue({
    projectId: "w1",
    issueProjectId: container.id,
    title: "Before concurrent link",
    createdBy: HUMAN,
  })
  // The field-context read precedes the external-key lookup. Label resolution
  // during import is the next read, after that lookup but before createIssue.
  mockAfterLabelRead.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    await linkIssueToGithub(
      local.id,
      { repoFullName: "o/r", number: 1, htmlUrl: "https://github.com/o/r/issues/1" },
      HUMAN
    )
  })
  const b = binding({ providerId: "github" })
  const { provider } = fake({
    pull: { items: [remote({ title: "Concurrent remote title" })], notModified: false },
  })
  expect(await reconcileBinding(b, provider)).toMatchObject({
    status: "completed",
    created: 0,
    updated: 1,
  })
  expect(await getDb().issues.count()).toBe(1)
  expect(await getIssue(local.id)).toMatchObject({
    title: "Concurrent remote title",
    externalRefs: [expect.objectContaining({ meta: { binding: b.key } })],
  })
  expect((await getDb().externalSyncCursors.get(issueSyncTarget(b).key))?.cursor).toBe("1000")
})

it("does not adopt refs owned by another binding or another local container", async () => {
  const other = await createIssueProject({ projectId: "w1", name: "Other", key: "OTHER" })
  for (const [number, issueProjectId, meta] of [
    [1, container.id, { binding: "another" }],
    [2, other.id, undefined],
  ] as const) {
    await createIssue({
      projectId: "w1",
      issueProjectId,
      title: "Keep original",
      createdBy: HUMAN,
      externalRefs: [{ provider: "fake", externalId: `o/r#${number}`, ...(meta ? { meta } : {}) }],
    })
  }
  const { provider } = fake({
    pull: { items: [remote(), remote({ externalId: "o/r#2" })], notModified: false },
  })
  expect(await reconcileBinding(binding(), provider)).toMatchObject({
    status: "completed",
    updated: 0,
    created: 0,
  })
  expect((await getIssueByExternalKey("fake", "o/r#1"))?.externalRefs?.[0].meta?.binding).toBe(
    "another"
  )
  expect(
    (await getIssueByExternalKey("fake", "o/r#2"))?.externalRefs?.[0].meta?.binding
  ).toBeUndefined()
})

it("does not tombstone unowned or differently owned refs that this full scan did not read", async () => {
  for (const [number, meta] of [
    [2, undefined],
    [3, { binding: "o/r" }],
    [4, { binding: "another" }],
  ] as const)
    await createIssue({
      projectId: "w1",
      issueProjectId: container.id,
      title: "Kept copy",
      createdBy: HUMAN,
      externalRefs: [{ provider: "fake", externalId: `o/r#${number}`, ...(meta ? { meta } : {}) }],
    })
  const { provider } = fake()
  Object.assign(provider, { completeFullScan: true })
  provider.pullPage = async () => ({ items: [remote()], cursor: "1000" })
  expect(await reconcileBinding(binding(), provider)).toMatchObject({
    status: "completed",
    tombstoned: 1,
  })
  expect((await getIssueByExternalKey("fake", "o/r#2"))?.externalRefs?.[0]).toEqual({
    provider: "fake",
    externalId: "o/r#2",
  })
  expect(
    (await getIssueByExternalKey("fake", "o/r#4"))?.externalRefs?.[0].departedAt
  ).toBeUndefined()
  expect((await getIssueByExternalKey("fake", "o/r#3"))?.externalRefs?.[0].departedAt).toBeDefined()
})
