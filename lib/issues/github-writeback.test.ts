import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import {
  createGithubIssue,
  GITHUB_DELIVERY_PLUGIN_ID,
  GITHUB_INTEGRATION_ID,
  GithubWritebackError,
  isGithubWritebackPending,
  issueWritebackKey,
  resolveGithubWritebackAccount,
  runGithubWriteback,
  stopGithubWritebackTracking,
  toIntegrationAction,
} from "./github-writeback"
import type { IntegrationAccount, IntegrationActionJob } from "@/types/plugin/plugin-integration"

const mockListAccounts = jest.fn()
const mockHostForSession = jest.fn()
jest.mock("@/lib/db/integrations", () => ({
  listIntegrationAccounts: (...args: unknown[]) => mockListAccounts(...args),
  getIntegrationActionJob: async () => undefined,
  isIntegrationActionJobTerminal: (status: string) =>
    ["succeeded", "failed", "cancelled", "deadlettered"].includes(status),
}))
jest.mock("@/lib/integrations/github-auth", () => ({
  githubHostForSession: (...args: unknown[]) => mockHostForSession(...args),
}))

jest.mock("@/lib/integrations/action-runner", () => ({
  executeIntegrationAction: jest.fn(),
  approveIntegrationActionJob: jest.fn(),
}))

const account = (over: Partial<IntegrationAccount> = {}): IntegrationAccount =>
  ({
    id: "acct-1",
    pluginId: GITHUB_DELIVERY_PLUGIN_ID,
    integrationId: GITHUB_INTEGRATION_ID,
    enabled: true,
    providerId: "github-pat",
    authSessionId: "public-session",
    label: "acme (PAT)",
    ...over,
  }) as IntegrationAccount

const job = (over: Partial<IntegrationActionJob> = {}): IntegrationActionJob =>
  ({ id: "job-1", status: "awaiting_approval", ...over }) as IntegrationActionJob

const target = { repoFullName: "acme/one", number: 7 }

afterEach(stopGithubWritebackTracking)

beforeEach(() => {
  jest.clearAllMocks()
  mockHostForSession.mockImplementation(async (id: string) =>
    id === "enterprise-session"
      ? {
          id: "ghe.example",
          apiBaseUrl: "https://ghe.example/api/v3",
          webBaseUrl: "https://ghe.example",
        }
      : { id: "github.com", apiBaseUrl: "https://api.github.com", webBaseUrl: "https://github.com" }
  )
})

describe("toIntegrationAction", () => {
  it("maps a comment onto the plugin's commentIssue contract", () => {
    expect(toIntegrationAction(target, { kind: "comment", body: "hi" })).toEqual({
      actionId: "commentIssue",
      input: { repoFullName: "acme/one", issueNumber: 7, body: "hi" },
    })
  })

  it("copies the labels array so a frozen caller value can't leak through", () => {
    const labels = Object.freeze(["bug", "p1"])
    const mapped = toIntegrationAction(target, { kind: "label", labels })
    expect(mapped).toEqual({
      actionId: "labelIssue",
      input: { repoFullName: "acme/one", issueNumber: 7, labels: ["bug", "p1"] },
    })
    expect(mapped.input.labels).not.toBe(labels)
  })

  it("defaults a close to `completed` rather than leaving GitHub to guess", () => {
    expect(toIntegrationAction(target, { kind: "close" }).input).toMatchObject({
      reason: "completed",
    })
  })

  it("preserves an explicit not_planned close — it is a different outcome", () => {
    expect(
      toIntegrationAction(target, { kind: "close", reason: "not_planned" }).input
    ).toMatchObject({ reason: "not_planned" })
  })
})

describe("resolveGithubWritebackAccount", () => {
  it("pins writes to the captured connection and never falls back to another identity", async () => {
    mockListAccounts.mockResolvedValue([
      account({ id: "B", connectionId: "connection-B" as never }),
      account({ id: "A", connectionId: "connection-A" as never }),
    ])
    await expect(
      resolveGithubWritebackAccount(
        "acme/one",
        undefined,
        { localAuthorization: LOCAL_PERSON_RUN },
        "connection-A"
      )
    ).resolves.toMatchObject({ id: "A" })
    mockListAccounts.mockResolvedValue([
      account({ id: "B", connectionId: "connection-B" as never }),
    ])
    await expect(
      resolveGithubWritebackAccount(
        "acme/one",
        undefined,
        { localAuthorization: LOCAL_PERSON_RUN },
        "connection-A"
      )
    ).resolves.toBeNull()
  })
  it("never selects a newer enterprise account for a public issue", async () => {
    mockListAccounts.mockResolvedValue([
      account({ id: "enterprise", authSessionId: "enterprise-session" }),
      account({ id: "public" }),
    ])
    await expect(
      resolveGithubWritebackAccount("acme/one", undefined, { localAuthorization: LOCAL_PERSON_RUN })
    ).resolves.toMatchObject({ id: "public" })
  })

  it("refuses unreadable or revoked credentials instead of guessing a host", async () => {
    mockListAccounts.mockResolvedValue([
      account({ health: "revoked" }),
      account({ id: "unreadable", authSessionId: "missing" }),
    ])
    mockHostForSession.mockResolvedValue(undefined)
    await expect(
      resolveGithubWritebackAccount("acme/one", undefined, { localAuthorization: LOCAL_PERSON_RUN })
    ).resolves.toBeNull()
  })

  it("keeps the account shown at confirmation even if a newer account appears", async () => {
    mockListAccounts.mockResolvedValue([account({ id: "new" }), account({ id: "shown" })])
    await expect(
      resolveGithubWritebackAccount("acme/one", "shown", { localAuthorization: LOCAL_PERSON_RUN })
    ).resolves.toMatchObject({
      id: "shown",
    })
    await expect(
      resolveGithubWritebackAccount("acme/one", "removed", { localAuthorization: LOCAL_PERSON_RUN })
    ).resolves.toBeNull()
  })

  it("prefers the repository owner's App installation on the correct host", async () => {
    mockListAccounts.mockResolvedValue([
      account({ id: "other-install", providerId: "github-app", label: "other" }),
      account({ id: "owner-install", providerId: "github-app", label: "acme" }),
    ])
    await expect(
      resolveGithubWritebackAccount("acme/one", undefined, { localAuthorization: LOCAL_PERSON_RUN })
    ).resolves.toMatchObject({
      id: "owner-install",
    })
  })
  it("picks the first enabled account (newest, by the query's own ordering)", async () => {
    mockListAccounts.mockResolvedValue([account({ id: "new" }), account({ id: "old" })])

    await expect(
      resolveGithubWritebackAccount(undefined, undefined, { localAuthorization: LOCAL_PERSON_RUN })
    ).resolves.toMatchObject({ id: "new" })
    expect(mockListAccounts).toHaveBeenCalledWith(GITHUB_DELIVERY_PLUGIN_ID, GITHUB_INTEGRATION_ID)
  })

  it("skips disabled accounts", async () => {
    mockListAccounts.mockResolvedValue([
      account({ id: "off", enabled: false }),
      account({ id: "on" }),
    ])

    await expect(
      resolveGithubWritebackAccount(undefined, undefined, { localAuthorization: LOCAL_PERSON_RUN })
    ).resolves.toMatchObject({ id: "on" })
  })

  it("returns null when nothing is connected", async () => {
    mockListAccounts.mockResolvedValue([])
    await expect(
      resolveGithubWritebackAccount(undefined, undefined, { localAuthorization: LOCAL_PERSON_RUN })
    ).resolves.toBeNull()
  })
})

describe("runGithubWriteback", () => {
  it("refuses an account change after confirmation before enqueue or approval", async () => {
    const execute = jest.fn()
    const approve = jest.fn()
    await expect(
      runGithubWriteback(
        {
          target,
          connectorAccountId: "shown",
          action: { kind: "close" },
          approval: "user-confirmed",
        },
        { resolveAccount: async () => account({ id: "different" }), execute, approve }
      )
    ).rejects.toMatchObject({ code: "no-account" })
    expect(execute).not.toHaveBeenCalled()
    expect(approve).not.toHaveBeenCalled()
  })
  it("refuses with an actionable code when no account is connected", async () => {
    const execute = jest.fn()
    await expect(
      runGithubWriteback(
        { target, action: { kind: "comment", body: "hi" } },
        { resolveAccount: async () => null, execute }
      )
    ).rejects.toMatchObject({ name: "GithubWritebackError", code: "no-account" })
    expect(execute).not.toHaveBeenCalled()
  })

  it("routes through the github-delivery plugin, not a new write path", async () => {
    const execute = jest.fn().mockResolvedValue(job({ status: "succeeded" }))
    await runGithubWriteback(
      {
        target,
        action: { kind: "comment", body: "hi" },
        credentialContext: { sessionId: "s", executionRunId: "run" },
      },
      { resolveAccount: async () => account(), execute, newAttemptId: () => "a1" }
    )

    expect(execute).toHaveBeenCalledWith(
      GITHUB_DELIVERY_PLUGIN_ID,
      {
        integrationId: GITHUB_INTEGRATION_ID,
        accountId: "acct-1",
        actionId: "commentIssue",
        input: { repoFullName: "acme/one", issueNumber: 7, body: "hi" },
        source: "manual",
        idempotencyKey: "issue-writeback:acme/one#7:comment:a1",
      },
      undefined,
      { sessionId: "s", executionRunId: "run" }
    )
  })

  it("always sends a key, because the plugin's write actions require one, fresh per write", async () => {
    // Without one the action runner refused every board write-back with
    // "requires an idempotency key".
    const execute = jest.fn().mockResolvedValue(job({ status: "succeeded" }))
    const deps = { resolveAccount: async () => account(), execute }
    await runGithubWriteback({ target, action: { kind: "close" } }, deps)
    await runGithubWriteback({ target, action: { kind: "close" } }, deps)

    const [first, second] = execute.mock.calls.map(
      (call) => (call[1] as { idempotencyKey: string }).idempotencyKey
    )
    expect(first).toMatch(/^issue-writeback:acme\/one#7:close:/)
    expect(second).toMatch(/^issue-writeback:acme\/one#7:close:/)
    expect(first).not.toBe(second)
    expect(issueWritebackKey(target, "label", "x")).toBe("issue-writeback:acme/one#7:label:x")
  })

  it("records a write that landed, and does not watch it", async () => {
    const landed = job({ status: "succeeded" })
    const record = jest.fn().mockResolvedValue([])
    const track = jest.fn()
    const result = await runGithubWriteback(
      { target, action: { kind: "comment", body: "hi" }, approval: "user-confirmed" },
      { resolveAccount: async () => account(), execute: async () => landed, record, track }
    )
    expect(result).toBe(landed)
    expect(isGithubWritebackPending(result)).toBe(false)
    expect(record).toHaveBeenCalledWith(landed)
    expect(track).not.toHaveBeenCalled()
  })

  it("keeps a landed write a success when its trail entry fails to write", async () => {
    const landed = job({ status: "succeeded" })
    await expect(
      runGithubWriteback(
        { target, action: { kind: "close" }, approval: "user-confirmed" },
        {
          resolveAccount: async () => account(),
          execute: async () => landed,
          record: async () => {
            throw new Error("trail boom")
          },
          track: jest.fn(),
        }
      )
    ).resolves.toBe(landed)
  })

  it.each(["queued", "running", "retry_wait"] as const)(
    "watches a %s job until it settles instead of calling it done",
    async (status) => {
      const pending = job({ id: "job-p", status })
      const record = jest.fn()
      const track = jest.fn()
      const result = await runGithubWriteback(
        { target, action: { kind: "close" }, approval: "user-confirmed" },
        {
          resolveAccount: async () => account(),
          execute: async () => pending,
          approve: jest.fn(),
          record,
          track,
        }
      )
      expect(isGithubWritebackPending(result)).toBe(true)
      expect(track).toHaveBeenCalledWith("job-p")
      expect(record).not.toHaveBeenCalled()
    }
  )

  it.each(["failed", "deadlettered", "cancelled"] as const)(
    "throws when the job %s, so a refused write never reads as a success",
    async (status) => {
      const record = jest.fn()
      const track = jest.fn()
      await expect(
        runGithubWriteback(
          { target, action: { kind: "comment", body: "hi" }, approval: "user-confirmed" },
          {
            resolveAccount: async () => account(),
            execute: async () => job({ status, error: status === "cancelled" ? undefined : "403" }),
            record,
            track,
          }
        )
      ).rejects.toMatchObject({
        code: "rejected",
        message: status === "cancelled" ? "GitHub did not accept the write (job cancelled)" : "403",
      })
      expect(record).not.toHaveBeenCalled()
      expect(track).not.toHaveBeenCalled()
    }
  )

  it("LEAVES the job parked when the caller has not confirmed", async () => {
    const execute = jest.fn().mockResolvedValue(job())
    const approve = jest.fn()

    const track = jest.fn()

    const result = await runGithubWriteback(
      { target, action: { kind: "close" } },
      { resolveAccount: async () => account(), execute, approve, track }
    )

    // An irreversible external write must never happen without confirmation.
    expect(approve).not.toHaveBeenCalled()
    expect(result.status).toBe("awaiting_approval")
    // A person approving it later still lands on the trail.
    expect(track).toHaveBeenCalledWith("job-1")
  })

  it("approves only once the dialog has confirmed the exact payload", async () => {
    const execute = jest.fn().mockResolvedValue(job())
    const approve = jest.fn().mockResolvedValue(job({ status: "succeeded" }))

    const result = await runGithubWriteback(
      {
        target,
        action: { kind: "close" },
        approval: "user-confirmed",
        credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
      },
      { resolveAccount: async () => account(), execute, approve }
    )

    expect(approve).toHaveBeenCalledWith("job-1")
    expect(result.status).toBe("succeeded")
    // The confirmed write is the person's under the outbound policy (ADR-0239).
    expect(execute.mock.calls[0][2]).toEqual({
      kind: "person",
      surface: "issue-writeback",
      localAuthorization: LOCAL_PERSON_RUN,
    })
  })

  it("leaves an unconfirmed write to the plugin's outbound plan", async () => {
    const execute = jest.fn().mockResolvedValue(job())
    await runGithubWriteback(
      { target, action: { kind: "close" } },
      { resolveAccount: async () => account(), execute, approve: jest.fn() }
    )
    expect(execute.mock.calls[0]).toHaveLength(4)
    expect(execute.mock.calls[0].slice(2)).toEqual([undefined, undefined])
  })

  it("does not re-approve a job that never needed approval", async () => {
    const execute = jest.fn().mockResolvedValue(job({ status: "succeeded" }))
    const approve = jest.fn()

    await runGithubWriteback(
      { target, action: { kind: "comment", body: "hi" }, approval: "user-confirmed" },
      { resolveAccount: async () => account(), execute, approve }
    )

    expect(approve).not.toHaveBeenCalled()
  })

  it("translates an unregistered plugin into a code the UI can explain", async () => {
    const execute = jest.fn().mockRejectedValue(new Error('Integration "github" is not registered'))

    await expect(
      runGithubWriteback(
        { target, action: { kind: "comment", body: "hi" } },
        { resolveAccount: async () => account(), execute }
      )
    ).rejects.toMatchObject({ code: "plugin-unavailable" })
  })

  it("keeps a non-Error rejection readable", async () => {
    const execute = jest.fn().mockRejectedValue("blocked by the PII gate")

    await expect(
      runGithubWriteback(
        { target, action: { kind: "comment", body: "hi" } },
        { resolveAccount: async () => account(), execute }
      )
    ).rejects.toMatchObject({ message: "blocked by the PII gate" })
  })

  it("stays recognisable through instanceof", async () => {
    const error = await runGithubWriteback(
      { target, action: { kind: "close" } },
      { resolveAccount: async () => null }
    ).catch((cause) => cause)

    expect(error).toBeInstanceOf(GithubWritebackError)
  })
})

describe("createGithubIssue", () => {
  const input = {
    repoFullName: "acme/app",
    title: "Crash on save",
    body: "Steps",
    idempotencyKey: "issue-publish:i1:acme/app",
  }

  it("runs createIssue, approves it in the same step and returns the new issue", async () => {
    const execute = jest.fn().mockResolvedValue(job({ id: "j1", status: "awaiting_approval" }))
    const approve = jest.fn().mockResolvedValue(
      job({
        id: "j1",
        status: "succeeded",
        output: {
          number: 42,
          html_url: "https://github.com/acme/app/issues/42",
          updated_at: "2026-09-01T00:00:00Z",
        },
      })
    )
    await expect(
      createGithubIssue(input, { resolveAccount: async () => account(), execute, approve })
    ).resolves.toEqual({
      repoFullName: "acme/app",
      number: 42,
      htmlUrl: "https://github.com/acme/app/issues/42",
      updatedAt: Date.parse("2026-09-01T00:00:00Z"),
    })
    expect(execute).toHaveBeenCalledWith(
      GITHUB_DELIVERY_PLUGIN_ID,
      {
        integrationId: GITHUB_INTEGRATION_ID,
        accountId: "acct-1",
        actionId: "createIssue",
        input: { repoFullName: "acme/app", title: "Crash on save", body: "Steps" },
        source: "manual",
        idempotencyKey: "issue-publish:i1:acme/app",
      },
      // A person confirmed it in the publish dialog (ADR-0239).
      { kind: "person", surface: "issue-publish" },
      undefined
    )
    expect(approve).toHaveBeenCalledWith("j1")
  })

  it("refuses without an account, and when GitHub did not create anything", async () => {
    await expect(
      createGithubIssue(input, { resolveAccount: async () => null, execute: jest.fn() })
    ).rejects.toMatchObject({ code: "no-account" })
    await expect(
      createGithubIssue(input, {
        resolveAccount: async () => account(),
        execute: jest.fn().mockResolvedValue(job({ status: "failed", error: "422 Validation" })),
      })
    ).rejects.toMatchObject({ code: "rejected", message: "422 Validation" })
    await expect(
      createGithubIssue(input, {
        resolveAccount: async () => account(),
        execute: jest.fn().mockRejectedValue(new Error("Integration is not registered")),
      })
    ).rejects.toMatchObject({ code: "plugin-unavailable" })
  })
})

it("never implicitly selects a personal writeback account without admission", async () => {
  mockListAccounts.mockResolvedValue([account()])
  expect(await resolveGithubWritebackAccount("acme/one")).toBeNull()
  expect(
    await resolveGithubWritebackAccount("acme/one", undefined, {
      localAuthorization: LOCAL_PERSON_RUN,
    })
  ).toMatchObject({ id: "acct-1" })
})
