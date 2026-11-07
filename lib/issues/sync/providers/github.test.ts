import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import type { IssueExternalRef, IssueProject } from "@/types/issues"
import type { OctokitLike } from "@/lib/github/issues"
import { fetchGithubIssuePage } from "@/lib/github/issues"
import type { IssueSyncBinding } from "../types"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import {
  githubReadAccountsFor,
  resolveGithubAccountGitAccess,
} from "@/lib/integrations/github-read-credential"
import { getOctokitForRepo } from "@/lib/github/octokit-factory"
import { ghCliToken } from "@/lib/squads/pr-feedback/resolvers"
import {
  createGithubSyncProvider,
  resolveGithubSyncReadClient,
  extractIssueMentions,
  githubLoginOfAssignee,
  nextGithubAssignees,
  iterationExternalId,
  milestoneExternalId,
  statusToGithubState,
  toRemoteIssue,
  toUpdateIssueInput,
} from "./github"
import { ExternalSyncCursorInvalid } from "@/lib/external-services/sync/types"

it("describes its built-in resource through the shared descriptor", () => {
  const descriptor = createGithubSyncProvider().resource!
  expect(descriptor).toMatchObject({ kind: "github-repo", schemaVersion: 1, label: "GitHub" })
  expect(descriptor.describe({ repoFullName: "org/repo" })).toEqual({
    key: "org/repo",
    label: "org/repo",
  })
})

jest.mock("@/lib/squads/pr-feedback/resolvers", () => ({
  ghCliToken: jest.fn(async () => null),
  createResolveOctokit: jest.fn(() => async () => null),
}))
jest.mock("@/lib/integrations/github-read-credential", () => ({
  githubReadAccountsFor: jest.fn(),
  resolveGithubAccountGitAccess: jest.fn(),
}))
jest.mock("@/lib/github/octokit-factory", () => ({ getOctokitForRepo: jest.fn() }))
jest.mock("@/lib/integrations/action-runner", () => ({ executeIntegrationAction: jest.fn() }))
jest.mock("@/lib/issues/github-writeback", () => ({
  GITHUB_DELIVERY_PLUGIN_ID: "github-delivery",
  GITHUB_INTEGRATION_ID: "github",
  resolveGithubWritebackAccount: jest.fn(),
}))

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

const importRepo = {
  kind: "github-repo" as const,
  repoFullName: "acme/one",
  addedAt: 1,
  sync: { mode: "import" as const, projectV2Number: 4 },
}

function binding(): IssueSyncBinding {
  return {
    providerId: "github",
    projectId: "w1",
    issueProjectId: "p1",
    projectKey: "MERC",
    resource: importRepo,
    key: "acme/one",
  }
}

it("shares the mirror's tie-bucket continuation with the import provider", async () => {
  const client: OctokitLike = {
    request: async (route) => ({
      status: 200,
      headers: route.endsWith("/issues") ? { link: '<x>; rel="next"' } : {},
      data: route.endsWith("/issues")
        ? [
            {
              number: 7,
              title: "Issue",
              state: "open",
              html_url: "url",
              created_at: "2026-01-01",
              updated_at: "2026-01-02",
            },
          ]
        : [],
    }),
  }
  const b = { ...binding(), resource: { ...importRepo, sync: { mode: "import" as const } } }
  const options = {
    mode: "full" as const,
    cursor: "0",
    page: JSON.stringify({ since: Date.parse("2026-01-02"), page: 2, floor: 10_000, max: 20_000 }),
  }
  const mirrorPage = await fetchGithubIssuePage(client, { ...options, repoFullName: b.key })
  const importedPage = await createGithubSyncProvider({ resolveOctokitOrNull: async () => client })
    .pullPage!(b, options)
  expect(importedPage.nextPage).toBe(mirrorPage.nextPage)
  expect(JSON.parse(importedPage.nextPage!)).toMatchObject({
    floor: 10_000,
    max: Date.parse("2026-01-02"),
  })
  expect(importedPage.items[0].externalId).toBe("acme/one#7")
})

describe("pure transforms", () => {
  it("scopes milestone identity by repository and GitHub host", () => {
    expect(milestoneExternalId(1, "acme/one")).not.toBe(milestoneExternalId(1, "acme/two"))
    expect(milestoneExternalId(1, "acme/one", "ghe.example")).not.toBe(
      milestoneExternalId(1, "acme/one")
    )
  })

  it("extracts identifiers of this container and #numbers of this repo", () => {
    const out = extractIssueMentions(
      "Fixes MERC-12 and merc-3, also closes #7 and see #7 again, not VEN-1 nor foo#9",
      "MERC",
      "acme/one"
    )
    expect(out.identifiers).toEqual(["MERC-12", "MERC-3"])
    expect(out.externalIds).toEqual(["acme/one#7"])
  })

  it("maps a mirror row to a remote issue, preferring the iteration over the milestone", () => {
    const base = {
      number: 5,
      title: "T",
      body: "B",
      state: "closed" as const,
      stateReason: "not_planned",
      assigneeLogins: ["a", "b"],
      labels: [{ name: "bug" }],
      htmlUrl: "https://x/5",
      updatedAt: 99,
      milestoneNumber: 2,
      etag: "e",
    }
    expect(toRemoteIssue(base, "acme/one", new Map())).toMatchObject({
      externalId: "acme/one#5",
      status: "canceled",
      assigneeLabel: "a",
      labels: ["bug"],
      cycleExternalId: milestoneExternalId(2, "acme/one"),
      remoteUpdatedAt: 99,
      meta: { etag: "e" },
    })
    expect(toRemoteIssue(base, "acme/one", new Map([[5, "it1"]])).cycleExternalId).toBe(
      iterationExternalId("it1")
    )
    expect(
      toRemoteIssue({ ...base, milestoneNumber: undefined }, "acme/one", new Map()).cycleExternalId
    ).toBeNull()
  })

  it("maps board statuses onto the two GitHub states through the category", () => {
    expect(statusToGithubState("backlog")).toEqual({ state: "open" })
    expect(statusToGithubState("in_review")).toEqual({ state: "open" })
    expect(statusToGithubState("done")).toEqual({ state: "closed", state_reason: "completed" })
    expect(statusToGithubState("canceled")).toEqual({
      state: "closed",
      state_reason: "not_planned",
    })
  })

  it("builds the updateIssue input from a patch, milestones only", () => {
    expect(
      toUpdateIssueInput("acme/one", 5, {
        title: "T",
        description: null,
        status: "done",
        labels: ["a"],
        cycleExternalId: milestoneExternalId(3, "acme/one"),
      })
    ).toEqual({
      repoFullName: "acme/one",
      issueNumber: 5,
      title: "T",
      body: "",
      state: "closed",
      stateReason: "completed",
      labels: ["a"],
      milestone: 3,
    })
    expect(toUpdateIssueInput("acme/one", 5, { cycleExternalId: null })).toEqual({
      repoFullName: "acme/one",
      issueNumber: 5,
      milestone: null,
    })
    expect(() => toUpdateIssueInput("acme/one", 5, { cycleExternalId: "iteration/x" })).toThrow(
      /iteration/
    )
    expect(
      toUpdateIssueInput("acme/one", 5, { cycleExternalId: milestoneExternalId(3, "acme/one") })
    ).toMatchObject({ milestone: 3 })
    expect(() =>
      toUpdateIssueInput("acme/one", 5, { cycleExternalId: milestoneExternalId(3, "acme/two") })
    ).toThrow(/repository/)
    expect(() => toUpdateIssueInput("acme/one", 5, { cycleExternalId: "milestone/3" })).toThrow(
      /repository/
    )
  })
})

describe("resolveBindings", () => {
  it("binds only import-mode repos, once each, with the container's key", () => {
    const provider = createGithubSyncProvider()
    const mirror = { kind: "github-repo" as const, repoFullName: "acme/mirror", addedAt: 1 }
    const bindings = provider.resolveBindings([
      container([mirror, importRepo], "p2"),
      container([importRepo], "p1"),
    ])
    expect(bindings).toEqual([
      expect.objectContaining({
        providerId: "github",
        issueProjectId: "p1",
        projectKey: "MERC",
        key: "acme/one",
      }),
      expect.objectContaining({ providerId: "github", issueProjectId: "p2", key: "acme/one" }),
    ])
  })
})

describe("pull", () => {
  function fakeOctokit(
    handlers: Record<string, (params: Record<string, unknown>) => unknown>
  ): OctokitLike {
    return {
      request: async (route, params = {}) => {
        const handler = handlers[route]
        if (!handler) throw new Error(`unexpected ${route}`)
        return { status: 200, headers: {}, data: handler(params) }
      },
    }
  }

  it("reads issues, milestones, the Projects v2 iterations and PR links in one pass", async () => {
    const octokit = fakeOctokit({
      "GET /repos/{owner}/{repo}/issues": () => [
        {
          number: 1,
          title: "One",
          body: "b",
          state: "open",
          html_url: "https://x/1",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          milestone: { number: 9, title: "M9" },
          labels: [{ name: "bug" }],
          assignees: [],
        },
        {
          number: 2,
          title: "PR",
          state: "open",
          html_url: "h",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          pull_request: {},
        },
      ],
      "GET /repos/{owner}/{repo}/milestones": () => [
        { number: 9, title: "M9", state: "open", due_on: "2026-03-01T00:00:00Z", html_url: "m" },
      ],
      "POST /graphql": () => ({
        data: {
          repository: {
            projectV2: {
              fields: {
                nodes: [
                  {
                    __typename: "ProjectV2IterationField",
                    name: "Iteration",
                    configuration: {
                      iterations: [
                        { id: "it1", title: "Sprint 1", startDate: "2026-01-01", duration: 14 },
                      ],
                      completedIterations: [],
                    },
                  },
                ],
              },
              items: {
                nodes: [
                  {
                    content: {
                      __typename: "Issue",
                      number: 1,
                      repository: { nameWithOwner: "acme/one" },
                    },
                    fieldValues: { nodes: [{ iterationId: "it1", title: "Sprint 1" }] },
                  },
                  {
                    content: {
                      __typename: "Issue",
                      number: 1,
                      repository: { nameWithOwner: "acme/two" },
                    },
                    fieldValues: { nodes: [{ iterationId: "wrong-repo" }] },
                  },
                  {
                    content: {
                      __typename: "PullRequest",
                      number: 1,
                      repository: { nameWithOwner: "acme/one" },
                    },
                    fieldValues: { nodes: [{ iterationId: "wrong-type" }] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
      "GET /repos/{owner}/{repo}/pulls": () => [
        {
          number: 20,
          title: "Fix MERC-4",
          body: "closes #1",
          html_url: "p",
          head: { ref: "merc-4-fix" },
          state: "closed",
          merged_at: "2026-02-01T00:00:00Z",
        },
        { number: 21, title: "unrelated", body: "", html_url: "q", head: { ref: "main" } },
      ],
    })
    const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => octokit })
    const result = await provider.pull(binding(), { since: 1 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      externalId: "acme/one#1",
      cycleExternalId: iterationExternalId("it1"),
      labels: ["bug"],
    })
    expect(result.cycles?.map((c) => c.externalId).sort()).toEqual([
      iterationExternalId("it1"),
      milestoneExternalId(9, "acme/one"),
    ])
    const iteration = result.cycles?.find((c) => c.kind === "cycle")
    expect(iteration).toMatchObject({ name: "Sprint 1", startsAt: Date.parse("2026-01-01") })
    expect(result.links).toEqual([
      expect.objectContaining({
        provider: "github-pr",
        externalId: "acme/one#20",
        mentionsIdentifiers: ["MERC-4"],
        mentionsExternalIds: ["acme/one#1"],
        prState: "merged",
      }),
    ])
  })

  it("reads CI for open linked pull requests only, within the per-pass budget", async () => {
    const ciCalls: string[] = []
    const octokit = fakeOctokit({
      "GET /repos/{owner}/{repo}/issues": () => [],
      "GET /repos/{owner}/{repo}/milestones": () => [],
      "POST /graphql": () => ({ data: { repository: { projectV2: null } } }),
      "GET /repos/{owner}/{repo}/pulls": () => [
        { number: 30, title: "MERC-1", state: "open", head: { ref: "a", sha: "s30" } },
        { number: 31, title: "MERC-2", state: "open", head: { ref: "b", sha: "s31" } },
        { number: 32, title: "MERC-3", state: "closed", head: { ref: "c", sha: "s32" } },
      ],
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": (params) => {
        ciCalls.push(String(params.ref))
        if (params.ref === "s31") throw new Error("403 checks:read")
        return {
          total_count: 1,
          check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }],
        }
      },
      "GET /repos/{owner}/{repo}/commits/{ref}/status": () => ({ statuses: [] }),
    })
    const provider = createGithubSyncProvider({
      resolveOctokitOrNull: async () => octokit,
      pullRequestCiLimit: 5,
    })
    const result = await provider.pull(binding(), { since: 1 })
    const byId = new Map(result.links?.map((link) => [link.externalId, link]))
    expect(byId.get("acme/one#30")).toMatchObject({ prState: "open", ciState: "failing" })
    // An unreadable CI leaves the link and its state in place.
    expect(byId.get("acme/one#31")).toMatchObject({ prState: "open" })
    expect(byId.get("acme/one#31")).not.toHaveProperty("ciState")
    expect(byId.get("acme/one#32")).not.toHaveProperty("ciState")
    expect(ciCalls).toEqual(["s30", "s31"])

    ciCalls.length = 0
    const budgeted = createGithubSyncProvider({
      resolveOctokitOrNull: async () => octokit,
      pullRequestCiLimit: 1,
    })
    await budgeted.pull(binding(), { since: 1 })
    expect(ciCalls).toEqual(["s30"])
  })

  it("fails the binding, not the run, when no credential resolves", async () => {
    const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => null })
    await expect(provider.pull(binding(), {})).rejects.toMatchObject({
      name: "MissingGithubCredentialError",
    })
  })
})

describe("push", () => {
  it.each([
    { cycleExternalId: "iteration/new" },
    { cycleExternalId: "iteration/new", title: "new title" },
  ])("rejects iteration changes without publishing or consuming the patch: %j", async (patch) => {
    const execute = jest.fn()
    const provider = createGithubSyncProvider({ execute: execute as never })
    await expect(
      provider.push!(
        binding(),
        { provider: "github", externalId: "acme/one#5" },
        patch,
        { id: "i1" } as never,
        { idempotencyKey: "k", by: { kind: "agent" } }
      )
    ).rejects.toThrow(/iteration/i)
    expect(execute).not.toHaveBeenCalled()
  })

  const ref: IssueExternalRef = { provider: "github", externalId: "acme/one#5" }
  const issue = { id: "i1" } as never

  it.each([null, "milestone/github.com/acme/one/3"])(
    "refuses replacing an existing Project iteration with %s",
    async (cycleExternalId) => {
      const execute = jest.fn()
      const request = jest.fn(async () => ({
        status: 200,
        headers: {},
        data: {
          data: {
            repository: {
              projectV2: {
                items: {
                  nodes: [
                    {
                      content: {
                        __typename: "Issue",
                        number: 5,
                        repository: { nameWithOwner: "acme/one" },
                      },
                      fieldValues: { nodes: [{ iterationId: "current" }] },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        },
      }))
      const provider = createGithubSyncProvider({
        execute: execute as never,
        resolveOctokitOrNull: async () => ({ request }) as OctokitLike,
      })
      await expect(
        provider.push!(binding(), ref, { cycleExternalId }, issue, {
          idempotencyKey: "k",
          by: { kind: "agent" },
        })
      ).rejects.toThrow(/iteration/)
      expect(execute).not.toHaveBeenCalled()
    }
  )

  it.each([
    { errors: [{ message: "Forbidden" }] },
    { data: { repository: { projectV2: null } } },
    { data: { repository: { projectV2: { fields: { pageInfo: { hasNextPage: true } } } } } },
    {
      data: {
        repository: {
          projectV2: { items: { nodes: [{ fieldValues: { pageInfo: { hasNextPage: true } } }] } },
        },
      },
    },
  ])(
    "refuses milestone writes when the configured Project cannot be fully verified",
    async (data) => {
      const execute = jest.fn()
      const provider = createGithubSyncProvider({
        execute: execute as never,
        resolveOctokitOrNull: async () =>
          ({ request: async () => ({ status: 200, headers: {}, data }) }) as OctokitLike,
      })
      await expect(
        provider.push!(binding(), ref, { cycleExternalId: null }, issue, {
          idempotencyKey: "k",
          by: { kind: "agent" },
        })
      ).rejects.toThrow(/iteration/)
      expect(execute).not.toHaveBeenCalled()
    }
  )

  it("still queues milestone changes when the Project confirms no iteration assignment", async () => {
    const execute = jest.fn(async () => ({ id: "job", status: "awaiting_approval" }))
    const provider = createGithubSyncProvider({
      execute: execute as never,
      resolveAccount: async () => ({ id: "acct" }) as never,
      resolveOctokitOrNull: async () =>
        ({
          request: async () => ({
            status: 200,
            headers: {},
            data: {
              data: {
                repository: {
                  projectV2: { items: { nodes: [], pageInfo: { hasNextPage: false } } },
                },
              },
            },
          }),
        }) as OctokitLike,
    })
    await expect(
      provider.push!(
        binding(),
        { ...ref, meta: { cycleKind: "iteration" } },
        { cycleExternalId: milestoneExternalId(3, "acme/one") },
        issue,
        { idempotencyKey: "k", by: { kind: "agent" } }
      )
    ).resolves.toMatchObject({ status: "queued" })
    expect(execute).toHaveBeenCalledWith(
      "github-delivery",
      expect.objectContaining({
        input: { repoFullName: "acme/one", issueNumber: 5, milestone: 3 },
      }),
      undefined,
      undefined
    )
  })

  it("queues an updateIssue action under the engine's idempotency key", async () => {
    const execute = jest.fn(async () => ({ id: "job-1", status: "awaiting_approval" }))
    const provider = createGithubSyncProvider({
      resolveOctokitOrNull: async () => null,
      execute: execute as never,
      resolveAccount: async () => ({ id: "acct", enabled: true }) as never,
    })
    const outcome = await provider.push!(binding(), ref, { title: "T" }, issue, {
      idempotencyKey: "k",
      by: { kind: "agent" },
    })
    expect(outcome).toEqual({ status: "queued", jobId: "job-1" })
    expect(execute).toHaveBeenCalledWith(
      "github-delivery",
      {
        integrationId: "github",
        accountId: "acct",
        actionId: "updateIssue",
        input: { repoFullName: "acme/one", issueNumber: 5, title: "T" },
        source: "workflow",
        idempotencyKey: "k",
      },
      undefined,
      undefined
    )
  })

  it("names a person's own edits as that person's write, and nobody for an agent's (ADR-0239)", async () => {
    const execute = jest.fn(async (..._args: unknown[]) => ({ id: "job-2", status: "running" }))
    const provider = createGithubSyncProvider({
      resolveOctokitOrNull: async () => null,
      execute: execute as never,
      resolveAccount: async () => ({ id: "acct", enabled: true }) as never,
    })
    await provider.push!(binding(), ref, { title: "T" }, issue, {
      idempotencyKey: "k1",
      by: { kind: "agent" },
      editedBy: "person",
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
    })
    await provider.push!(binding(), ref, { title: "T" }, issue, {
      idempotencyKey: "k2",
      by: { kind: "agent" },
      editedBy: "automation",
      credentialContext: { executionRunId: "agent-sync" },
    })
    expect(execute.mock.calls.map((call) => call[2])).toEqual([
      { kind: "person", surface: "issue-sync", localAuthorization: LOCAL_PERSON_RUN },
      undefined,
    ])
    expect(execute.mock.calls.map((call) => call[3])).toEqual([
      { localAuthorization: LOCAL_PERSON_RUN },
      { executionRunId: "agent-sync" },
    ])
  })

  it("reports applied when the job already completed, and refuses without an account", async () => {
    const provider = createGithubSyncProvider({
      resolveOctokitOrNull: async () => null,
      execute: (async () => ({ id: "j", status: "succeeded" })) as never,
      resolveAccount: async () => ({ id: "acct", enabled: true }) as never,
    })
    await expect(
      provider.push!(binding(), ref, { title: "T" }, issue, {
        idempotencyKey: "k",
        by: { kind: "agent" },
      })
    ).resolves.toEqual({ status: "applied" })

    const noAccount = createGithubSyncProvider({
      resolveOctokitOrNull: async () => null,
      execute: jest.fn() as never,
      resolveAccount: async () => null,
    })
    await expect(
      noAccount.push!(binding(), ref, { title: "T" }, issue, {
        idempotencyKey: "k",
        by: { kind: "agent" },
      })
    ).rejects.toMatchObject({ name: "MissingGithubCredentialError" })
  })
})

describe("assignee push", () => {
  const ref: IssueExternalRef = { provider: "github", externalId: "acme/one#5" }

  function setup(remoteAssignees: string[]) {
    const request = jest.fn(async () => ({
      status: 200,
      headers: {},
      data: { assignees: remoteAssignees.map((login) => ({ login })) },
    }))
    const execute = jest.fn(async () => ({ id: "job", status: "awaiting_approval" }))
    const provider = createGithubSyncProvider({
      resolveOctokitOrNull: async () => ({ request }) as unknown as OctokitLike,
      execute: execute as never,
      resolveAccount: async () => ({ id: "acct", enabled: true }) as never,
    })
    return { provider, request, execute }
  }

  it("recognises only an assignee that came from GitHub", () => {
    expect(githubLoginOfAssignee({ assignee: { kind: "human", label: "octo-cat" } })).toBe(
      "octo-cat"
    )
    expect(githubLoginOfAssignee({ assignee: { kind: "human", id: "u1", label: "octocat" } })).toBe(
      undefined
    )
    expect(githubLoginOfAssignee({ assignee: { kind: "agent", id: "a1", label: "Coder" } })).toBe(
      undefined
    )
    expect(githubLoginOfAssignee({ assignee: { kind: "human", label: "Ada Lovelace" } })).toBe(
      undefined
    )
    expect(githubLoginOfAssignee({})).toBe(undefined)
  })

  it("replaces the first assignee and keeps the others", () => {
    expect(nextGithubAssignees(["old", "b", "c"], "new")).toEqual(["new", "b", "c"])
    expect(nextGithubAssignees(["old", "New"], "new")).toEqual(["new"])
    expect(nextGithubAssignees([], "new")).toEqual(["new"])
    expect(nextGithubAssignees(["a", "b"], null)).toEqual([])
  })

  it("sends the full assignee list read from GitHub", async () => {
    const { provider, request, execute } = setup(["alice", "bob"])
    const issue = { id: "i1", assignee: { kind: "human", label: "carol" } } as never
    await provider.push!(binding(), ref, { assignee: "carol" }, issue, {
      idempotencyKey: "k",
      by: { kind: "agent" },
    })
    expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      owner: "acme",
      repo: "one",
      issue_number: 5,
    })
    expect(execute).toHaveBeenCalledWith(
      "github-delivery",
      expect.objectContaining({
        input: { repoFullName: "acme/one", issueNumber: 5, assignees: ["carol", "bob"] },
      }),
      undefined,
      undefined
    )
  })

  it("clears GitHub's assignees when the local issue is unassigned", async () => {
    const { provider, execute } = setup(["alice", "bob"])
    await provider.push!(binding(), ref, { assignee: null }, { id: "i1" } as never, {
      idempotencyKey: "k",
      by: { kind: "agent" },
    })
    expect(execute).toHaveBeenCalledWith(
      "github-delivery",
      expect.objectContaining({ input: expect.objectContaining({ assignees: [] }) }),
      undefined,
      undefined
    )
  })

  it("keeps an agent assignee local and sends the rest of the patch", async () => {
    const { provider, request, execute } = setup(["alice"])
    const issue = { id: "i1", assignee: { kind: "agent", id: "a1", label: "Coder" } } as never
    await provider.push!(binding(), ref, { assignee: "Coder", title: "T" }, issue, {
      idempotencyKey: "k",
      by: { kind: "agent" },
    })
    expect(request).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledWith(
      "github-delivery",
      expect.objectContaining({ input: { repoFullName: "acme/one", issueNumber: 5, title: "T" } }),
      undefined,
      undefined
    )
  })

  it("sends nothing when the only change was a local-only assignee", async () => {
    const { provider, execute } = setup(["alice"])
    const issue = { id: "i1", assignee: { kind: "agent", id: "a1", label: "Coder" } } as never
    await expect(
      provider.push!(binding(), ref, { assignee: "Coder" }, issue, {
        idempotencyKey: "k",
        by: { kind: "agent" },
      })
    ).resolves.toEqual({ status: "applied" })
    expect(execute).not.toHaveBeenCalled()
  })
})

it("pages GitHub updates by keyset and commits only a terminal cursor", async () => {
  let reads = 0
  const request = jest.fn(async (route: string, _params: Record<string, unknown> = {}) => {
    if (route.endsWith("/issues")) {
      reads += 1
      return {
        status: 200,
        headers:
          reads === 1
            ? { link: '<https://api.github.com/repos/acme/one/issues?page=2>; rel="next"' }
            : {},
        data: [
          {
            number: reads === 1 ? 1 : 2,
            title: "Issue",
            state: reads === 1 ? "open" : "closed",
            html_url: "https://github.com/acme/one/issues/1",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: reads === 1 ? "2026-01-02T00:00:00Z" : "2026-01-03T00:00:00Z",
          },
        ],
      }
    }
    return { status: 200, headers: {}, data: [] }
  })
  const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => ({ request }) })
  const b = { ...binding(), resource: { ...importRepo, sync: { mode: "import" as const } } }
  const first = await provider.pullPage!(b, { mode: "full" })
  expect(first.cursor).toBeUndefined()
  expect(JSON.parse(first.nextPage!)).toEqual({
    since: Date.parse("2026-01-02T00:00:00Z"),
    page: 1,
    max: Date.parse("2026-01-02T00:00:00Z"),
  })
  const last = await provider.pullPage!(b, { mode: "full", page: first.nextPage })
  expect(last).toMatchObject({
    cursor: String(Date.parse("2026-01-03T00:00:00Z")),
    items: [expect.objectContaining({ status: "done" })],
  })
  expect(last.nextPage).toBeUndefined()
  expect(
    request.mock.calls.filter(([route]) => route.endsWith("/issues")).map(([, params]) => params)
  ).toEqual([
    expect.objectContaining({
      page: 1,
      state: "all",
      sort: "updated",
      direction: "asc",
      per_page: 100,
      since: new Date(0).toISOString(),
    }),
    expect.objectContaining({
      page: 1,
      state: "all",
      sort: "updated",
      direction: "asc",
      per_page: 100,
      since: "2026-01-01T23:59:59.000Z",
    }),
  ])
  await provider.pullPage!(b, { mode: "incremental", cursor: last.cursor })
  expect(
    request.mock.calls.filter(([route]) => route.endsWith("/issues")).at(-1)?.[1]
  ).toMatchObject({ since: "2026-01-02T23:59:59.000Z" })
})

it("keeps earlier pages' progress when the terminal page holds only pull requests", async () => {
  let reads = 0
  const request = jest.fn(async (route: string) => {
    if (route !== "GET /repos/{owner}/{repo}/issues") return { status: 200, headers: {}, data: [] }
    reads += 1
    return {
      status: 200,
      headers:
        reads === 1
          ? { link: '<https://api.github.com/repos/acme/one/issues?page=2>; rel="next"' }
          : {},
      data:
        reads === 1
          ? [
              {
                number: 1,
                title: "Issue",
                state: "open",
                html_url: "https://github.com/acme/one/issues/1",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-02T00:00:00Z",
              },
            ]
          : [
              {
                number: 2,
                title: "PR",
                state: "open",
                html_url: "https://github.com/acme/one/pull/2",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-05T00:00:00Z",
                pull_request: {},
              },
            ],
    }
  })
  const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => ({ request }) })
  const b = { ...binding(), resource: { ...importRepo, sync: { mode: "import" as const } } }
  const first = await provider.pullPage!(b, { mode: "incremental", cursor: "0" })
  const last = await provider.pullPage!(b, {
    mode: "incremental",
    cursor: "0",
    page: first.nextPage,
  })
  expect(last.items).toEqual([])
  // Not "0": the next incremental pass must not rescan the whole history.
  expect(last.cursor).toBe(String(Date.parse("2026-01-05T00:00:00Z")))
})

it.each([
  [429, { "retry-after": "123" }, undefined, 123_000],
  [403, { "x-ratelimit-remaining": "0" }, undefined, 60_000],
  [403, {}, "You have exceeded a secondary rate limit", 60_000],
] as const)(
  "translates GitHub %s into sanitized retry backoff",
  async (status, headers, message, delay) => {
    const provider = createGithubSyncProvider({
      resolveOctokitOrNull: async () => ({
        request: async () => {
          throw { status, response: { headers, data: { message } } }
        },
      }),
    })
    await expect(provider.pullPage!(binding(), { mode: "full" })).rejects.toMatchObject({
      name: "ExternalSyncRateLimited",
      retryAfterMs: delay,
      message: "External sync rate limited",
    })
  }
)

it("prepares the exact read connection alongside a client reused for that pass", async () => {
  const request = jest.fn(async () => ({ status: 200, headers: {}, data: [] }))
  const provider = createGithubSyncProvider({
    resolveReadClient: async () => ({
      octokit: { request },
      connectionRef: "read-connection" as AuthConnectionRef,
    }),
  })
  const prepared = await provider.prepare!(binding())
  expect(prepared.connectionRef).toBe("read-connection")
  await prepared.provider.pullPage!(
    { ...binding(), resource: { ...importRepo, sync: { mode: "import" } } },
    { mode: "full" }
  )
  expect(request).toHaveBeenCalled()
})

it("uses x-ratelimit-reset when Retry-After is absent", async () => {
  const clock = jest.spyOn(Date, "now").mockReturnValue(1000)
  try {
    const provider = createGithubSyncProvider({
      resolveOctokitOrNull: async () => ({
        request: async () => ({
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "91" },
          data: { message: "private" },
        }),
      }),
    })
    await expect(provider.pullPage!(binding(), { mode: "full" })).rejects.toMatchObject({
      retryAfterMs: 90_000,
      message: "External sync rate limited",
    })
  } finally {
    clock.mockRestore()
  }
})

it("binds the first usable read account rather than the first listed account", async () => {
  const unavailable = { id: "first", connectionId: "wrong-connection" }
  const selected = { id: "second", connectionId: "actual-connection", pluginId: "github-delivery" }
  jest.mocked(githubReadAccountsFor).mockResolvedValueOnce([unavailable, selected] as never)
  jest
    .mocked(resolveGithubAccountGitAccess)
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce({ host: { id: "github.com" }, token: "test-credential" } as never)
  const octokit = { request: jest.fn() }
  jest.mocked(getOctokitForRepo).mockResolvedValueOnce(octokit as never)
  const client = await resolveGithubSyncReadClient("acme/one")
  expect(client).toEqual({
    octokit,
    connectionRef: "actual-connection",
    consumerPluginId: "github-delivery",
  })
  expect(resolveGithubAccountGitAccess).toHaveBeenNthCalledWith(2, selected)
  expect(getOctokitForRepo).toHaveBeenCalledWith(
    expect.objectContaining({ repoFullName: "acme/one", pat: { token: "test-credential" } })
  )
  expect(ghCliToken).not.toHaveBeenCalled()
})

it("uses a named-lock target when only gh can provide a read credential", async () => {
  jest.mocked(githubReadAccountsFor).mockResolvedValueOnce([])
  jest.mocked(ghCliToken).mockResolvedValueOnce("cli-test-credential")
  const octokit = { request: jest.fn() }
  jest.mocked(getOctokitForRepo).mockResolvedValueOnce(octokit as never)
  expect(await resolveGithubSyncReadClient("acme/one")).toEqual({ octokit })
})

it("only selects a bound read connection and never falls through to another identity or gh", async () => {
  const selected = { id: "selected", connectionId: "bound", pluginId: "github-delivery" }
  const other = { id: "other", connectionId: "other" }
  jest.mocked(githubReadAccountsFor).mockResolvedValueOnce([other, selected] as never)
  jest
    .mocked(resolveGithubAccountGitAccess)
    .mockResolvedValueOnce({ host: { id: "github.com" }, token: "bound-token" } as never)
  const octokit = { request: jest.fn() }
  jest.mocked(getOctokitForRepo).mockResolvedValueOnce(octokit as never)
  expect(await resolveGithubSyncReadClient("acme/one", "bound" as AuthConnectionRef)).toMatchObject(
    { connectionRef: "bound", consumerPluginId: "github-delivery" }
  )
  expect(resolveGithubAccountGitAccess).toHaveBeenLastCalledWith(selected)
  jest.mocked(githubReadAccountsFor).mockResolvedValueOnce([other] as never)
  const before = jest.mocked(ghCliToken).mock.calls.length
  await expect(
    resolveGithubSyncReadClient("acme/one", "bound" as AuthConnectionRef)
  ).rejects.toThrow()
  expect(ghCliToken).toHaveBeenCalledTimes(before)
})

it("advances page indices for identical boundary timestamps", async () => {
  const timestamp = Date.parse("2026-01-02T00:00:00Z")
  const request = jest.fn(async (route: string, params: Record<string, unknown> = {}) => ({
    status: 200,
    headers:
      route.endsWith("/issues") && params.page === 1
        ? { link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next"' }
        : {},
    data: route.endsWith("/issues")
      ? [
          {
            number: params.page,
            title: "Same update time",
            state: "open",
            html_url: "https://github.com/o/r/issues/1",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: new Date(timestamp).toISOString(),
          },
        ]
      : [],
  }))
  const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => ({ request }) })
  const b = { ...binding(), resource: { ...importRepo, sync: { mode: "import" as const } } }
  const first = await provider.pullPage!(b, { mode: "incremental", cursor: String(timestamp) })
  expect(JSON.parse(first.nextPage!)).toEqual({
    since: timestamp,
    page: 2,
    floor: timestamp,
    max: timestamp,
  })
  const terminal = await provider.pullPage!(b, {
    mode: "incremental",
    cursor: String(timestamp),
    page: first.nextPage,
  })
  expect(terminal).toMatchObject({
    cursor: String(timestamp),
    items: [expect.objectContaining({ externalId: "acme/one#2" })],
  })
  expect(
    request.mock.calls.filter(([route]) => route.endsWith("/issues")).map(([, params]) => params)
  ).toEqual([
    expect.objectContaining({ since: "2026-01-01T23:59:59.000Z", page: 1, sort: "updated" }),
    expect.objectContaining({ since: "2026-01-01T23:59:59.000Z", page: 2, sort: "updated" }),
  ])
})

it("rejects obsolete offset checkpoints so the core can rebuild a full scan", async () => {
  const request = jest.fn()
  const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => ({ request }) })
  await expect(
    provider.pullPage!(binding(), { mode: "full", page: JSON.stringify({ page: 2, newest: 1000 }) })
  ).rejects.toBeInstanceOf(ExternalSyncCursorInvalid)
  expect(request).not.toHaveBeenCalled()
})

it("persists the earliest tie floor across keyset boundaries and resumed providers", async () => {
  const request = jest.fn(async (route: string) => ({
    status: 200,
    headers: route.endsWith("/issues")
      ? { link: '<https://api.github.com/repos/acme/one/issues?page=3>; rel="next"' }
      : {},
    data: route.endsWith("/issues")
      ? [
          {
            number: 1,
            title: "Issue",
            state: "open",
            html_url: "https://github.com/acme/one/issues/1",
            created_at: new Date(1000).toISOString(),
            updated_at: new Date(30_000).toISOString(),
          },
        ]
      : [],
  }))
  const b = { ...binding(), resource: { ...importRepo, sync: { mode: "import" as const } } }
  const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => ({ request }) })
  const page = await provider.pullPage!(b, {
    mode: "full",
    cursor: "90000",
    page: JSON.stringify({ since: 20_000, page: 2, floor: 20_000 }),
  })
  expect(JSON.parse(page.nextPage!)).toEqual({
    since: 30_000,
    page: 1,
    floor: 20_000,
    max: 30_000,
  })
  const resumed = createGithubSyncProvider({
    resolveOctokitOrNull: async () => ({
      request: async (route) => ({
        status: 200,
        headers: {},
        data: route.endsWith("/issues")
          ? [
              {
                number: 2,
                title: "Later",
                state: "open",
                html_url: "https://github.com/acme/one/issues/2",
                created_at: new Date(1000).toISOString(),
                updated_at: new Date(40_000).toISOString(),
              },
            ]
          : [],
      }),
    }),
  })
  expect(
    await resumed.pullPage!(b, { mode: "full", cursor: "90000", page: page.nextPage })
  ).toMatchObject({ cursor: "20000" })
})

it("confirms only missing or transferred GitHub issues", async () => {
  const controller = new AbortController()
  const request = jest.fn(async (_route: string, params: Record<string, unknown> = {}) => {
    const number = Number(params.issue_number)
    if (number === 1) return { status: 404, headers: {}, data: { message: "Not Found" } }
    if (number === 2) throw { status: 410, response: { data: { message: "Gone" } } }
    if (number === 5)
      return { status: 200, headers: {}, data: { number, repository: { full_name: "other/repo" } } }
    if (number === 7)
      return {
        status: 200,
        headers: {},
        data: { number, html_url: "https://github.com/other/repo/issues/7" },
      }
    return {
      status: 200,
      headers: {},
      data: {
        number,
        repository_url: `https://api.github.com/repos/${number === 4 ? "other/repo" : "ACME/ONE"}`,
      },
    }
  })
  const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => ({ request }) })
  expect(
    await provider.confirmDeparted!(
      binding(),
      Array.from({ length: 7 }, (_, index) => `acme/one#${index + 1}`),
      { signal: controller.signal }
    )
  ).toEqual(["acme/one#1", "acme/one#2", "acme/one#4", "acme/one#5", "acme/one#7"])
  expect(request).toHaveBeenCalledTimes(7)
  expect(request).toHaveBeenCalledWith(
    "GET /repos/{owner}/{repo}/issues/{issue_number}",
    expect.objectContaining({
      owner: "acme",
      repo: "one",
      issue_number: 3,
      request: { signal: controller.signal },
    })
  )
})

it("skips ids that do not name an issue of the bound repository", async () => {
  const request = jest.fn(async () => ({ status: 404, headers: {}, data: {} }))
  const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => ({ request }) })
  expect(
    await provider.confirmDeparted!(binding(), ["other/repo#1", "acme/one#x", "acme/one#2"], {})
  ).toEqual(["acme/one#2"])
  expect(request).toHaveBeenCalledTimes(1)
})

it("caps GitHub departure verification at 50 requests", async () => {
  const request = jest.fn(async () => ({ status: 404, headers: {}, data: {} }))
  const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => ({ request }) })
  const ids = Array.from({ length: 60 }, (_, index) => `acme/one#${index + 1}`)
  expect(await provider.confirmDeparted!(binding(), ids, {})).toEqual(ids.slice(0, 50))
  expect(request).toHaveBeenCalledTimes(50)
})

it.each([500, 403, 429])(
  "stops departure verification on GitHub %s without failing the run or exposing its body",
  async (status) => {
    const request = jest.fn(async (_route: string, params: Record<string, unknown> = {}) => ({
      status: params.issue_number === 1 ? 404 : status,
      headers: { "retry-after": "7" },
      data: { message: "private response body" },
    }))
    const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => ({ request }) })
    const pending = provider.confirmDeparted!(
      binding(),
      ["acme/one#1", "acme/one#2", "acme/one#3"],
      {}
    )
    if (status === 429)
      await expect(pending).rejects.toMatchObject({
        retryAfterMs: 7000,
        message: "External sync rate limited",
      })
    // One unreadable issue must not fail every sync: keep what was proven.
    else await expect(pending).resolves.toEqual(["acme/one#1"])
    expect(request).toHaveBeenCalledTimes(2)
  }
)

it("stops departure verification on cancellation before requesting another id", async () => {
  const controller = new AbortController()
  const request = jest.fn(async () => {
    controller.abort()
    return { status: 404, headers: {}, data: {} }
  })
  const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => ({ request }) })
  await expect(
    provider.confirmDeparted!(binding(), ["acme/one#1", "acme/one#2"], {
      signal: controller.signal,
    })
  ).rejects.toThrow()
  expect(request).toHaveBeenCalledTimes(1)
})
import { createDbTestFixture } from "@/lib/db/test-fixture"
const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("uses a fresh credential resolver with the pull's Host admission", async () => {
  const { createResolveOctokit } = await import("@/lib/squads/pr-feedback/resolvers")
  const credentialContext = { localAuthorization: LOCAL_PERSON_RUN } as const
  await expect(createGithubSyncProvider().pull(binding(), { credentialContext })).rejects.toThrow()
  expect(createResolveOctokit).toHaveBeenLastCalledWith(undefined, credentialContext)
})
