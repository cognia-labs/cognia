/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { IntegrationActionHandlerContext } from "@/types/plugin/plugin-integration"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import * as botBinding from "@/lib/plugin/api/bot-integration-binding"
import {
  createIntegrationAccount,
  cancelIntegrationActionJobRecord,
  cancelIntegrationActionJobsByPlugin,
  enqueueIntegrationActionJob,
  getIntegrationActionJob,
  setIntegrationAccountOutboundRecipients,
} from "@/lib/db/integrations"
import { putCapabilityGrant, putServiceConnection } from "@/lib/db/external-services"
import { registerAuthenticationProvider } from "@/lib/plugin/auth/auth-provider-registry"
import {
  __resetIntegrationRegistryForTesting,
  registerIntegrationDefinitions,
  unregisterIntegrationsByPlugin,
} from "./registry"
import { pushHeldIntegrationJob, withdrawHeldIntegrationJob } from "./outbound-hold"
import { buildShadowReport } from "@/lib/policy/action-review/shadow-report"
import { configuredGithubHosts } from "./github-auth"
import { parseGithubHost } from "@/lib/github/host"
import { isIntegrationRuntimeOwner } from "./runtime-owner"
import {
  approveIntegrationActionJob,
  authenticatedIntegrationRequest,
  cancelIntegrationActionJob,
  executeIntegrationAction,
  drainIntegrationActionJobs,
  runIntegrationActionJob,
  resolveIntegrationActionAvailability,
  setGithubIssueLoopDesktopHostAvailableForTesting,
  setGithubIssueLoopExecutorForTesting,
  setIntegrationAuthenticatedRequestExecutorForTesting,
} from "./action-runner"

jest.mock("@/lib/plugin/api/bot-integration-binding", () => ({
  ...jest.requireActual("@/lib/plugin/api/bot-integration-binding"),
  assertBotIntegrationAction: jest.fn(),
}))

let outboundSettings: object = { agentPermissions: {} }
jest.mock("@/lib/policy/action-review/plan-context", () => ({
  ...jest.requireActual("@/lib/policy/action-review/plan-context"),
  readAppSettings: jest.fn(async () => outboundSettings),
}))

jest.mock("./outbound-hold", () => ({
  pushHeldIntegrationJob: jest.fn(async () => undefined),
  withdrawHeldIntegrationJob: jest.fn(),
}))

jest.mock("./runtime-owner", () => ({ isIntegrationRuntimeOwner: jest.fn(async () => true) }))

jest.mock("./github-auth", () => ({
  ...jest.requireActual("./github-auth"),
  configuredGithubHosts: jest.fn(async () => []),
}))

describe("Integration action runner", () => {
  beforeEach(async () => {
    outboundSettings = { agentPermissions: {} }
    jest.mocked(isIntegrationRuntimeOwner).mockResolvedValue(true)
    jest.mocked(configuredGithubHosts).mockReset().mockResolvedValue([])
    jest.mocked(pushHeldIntegrationJob).mockClear()
    jest.mocked(withdrawHeldIntegrationJob).mockClear()
    jest.mocked(botBinding.assertBotIntegrationAction).mockReset()
    await getDb().delete()
    __resetDbForTesting()
    __resetIntegrationRegistryForTesting()
    setIntegrationAuthenticatedRequestExecutorForTesting(async <T>() => ({
      status: 200,
      headers: {},
      data: { ok: true } as T,
    }))
  })

  afterEach(() => {
    jest.restoreAllMocks()
    setIntegrationAuthenticatedRequestExecutorForTesting()
    setGithubIssueLoopExecutorForTesting()
    setGithubIssueLoopDesktopHostAvailableForTesting()
  })

  async function setup(
    updateHandler: (
      input: Record<string, unknown>,
      context: IntegrationActionHandlerContext
    ) => Promise<unknown> = async (input) => ({
      updated: input.issueId,
    }),
    allowedOrigins = ["https://api.example.test"],
    idempotency: "required" | "supported" = "required"
  ) {
    registerIntegrationDefinitions({
      pluginId: "example-delivery",
      definitions: [
        {
          id: "example",
          label: "Example",
          authStrategies: [
            {
              id: "oauth",
              type: "oauth2",
              label: "OAuth",
              providerId: "example-oauth",
            },
          ],
          resourceKinds: ["issue"],
          eventTypes: [],
          actions: [
            {
              id: "issue.read",
              label: "Read issue",
              handler: "readIssue",
              inputSchema: { type: "object" },
              risk: "read",
              idempotency: "supported",
            },
            {
              id: "issue.update",
              label: "Update issue",
              handler: "updateIssue",
              inputSchema: { type: "object" },
              risk: "write",
              idempotency,
            },
            {
              id: "issue.delete",
              label: "Delete issue",
              handler: "deleteIssue",
              inputSchema: { type: "object" },
              risk: "destructive",
              idempotency: "none",
            },
          ],
          allowedOrigins,
        },
      ],
      handlers: {
        "example:issue.read": async (_input, context) =>
          context.authenticatedRequest("https://api.example.test/issues/1"),
        "example:issue.update": updateHandler,
        "example:issue.delete": async () => ({ deleted: true }),
      },
    })
    const account = await createIntegrationAccount("example-delivery", {
      integrationId: "example",
      providerId: "example-oauth",
      authSessionId: "opaque",
      remoteAccountId: "acct",
      label: "Example account",
    })
    return account
  }

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  async function queue(accountId: string, actionId = "issue.update") {
    return enqueueIntegrationActionJob({
      pluginId: "example-delivery",
      integrationId: "example",
      accountId,
      actionId,
      input: {},
      status: "queued",
      risk: "write",
      attempts: 0,
      maxAttempts: 5,
      idempotencyKey: "once",
      source: "manual",
    })
  }

  it("claims one queued job once when two executors race", async () => {
    const handler = jest.fn(async () => ({ updated: true }))
    const account = await setup(handler)
    const job = await queue(account.id)
    await Promise.all([runIntegrationActionJob(job.id), runIntegrationActionJob(job.id)])
    expect(handler).toHaveBeenCalledTimes(1)
    expect(await getIntegrationActionJob(job.id)).toMatchObject({
      status: "succeeded",
      attempts: 1,
    })
  })

  it("keeps cancellation terminal when a handler ignores abort and resolves late", async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const account = await setup(async () => {
      entered.resolve()
      await release.promise
      return { updated: true }
    })
    const job = await queue(account.id)
    const execution = runIntegrationActionJob(job.id)
    await entered.promise
    await cancelIntegrationActionJob(job.id)
    release.resolve()
    expect(await execution).toMatchObject({ status: "cancelled" })
    expect(await getIntegrationActionJob(job.id)).toMatchObject({ status: "cancelled" })
    expect(
      await getDb()
        .integrationAudit.filter((entry) => entry.outcome === "succeeded")
        .count()
    ).toBe(0)
  })

  it.each(["GET", "POST"])(
    "passes the signal to fetch and records ambiguity only for writes (%s)",
    async (method) => {
      const dispatched = deferred<AbortSignal | null | undefined>()
      const response = deferred<Response>()
      let handlerSignal: AbortSignal | undefined
      const account = await setup(async (_input, context) => {
        handlerSignal = context.signal
        return context.authenticatedRequest("https://api.example.test/issues", { method })
      })
      const dispose = registerAuthenticationProvider({
        id: "example-oauth",
        label: "Example",
        pluginId: "example-delivery",
        getSessions: async () => [
          {
            id: "opaque",
            accessToken: "secret",
            account: { id: "acct", label: "Example" },
            scopes: [],
          },
        ],
        createSession: async () => {
          throw new Error("not used")
        },
        removeSession: async () => undefined,
      })
      setIntegrationAuthenticatedRequestExecutorForTesting()
      const originalFetch = global.fetch
      const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        dispatched.resolve(init?.signal)
        return response.promise
      })
      global.fetch = fetchMock
      try {
        const job = await queue(account.id)
        const execution = runIntegrationActionJob(job.id)
        const signal = await dispatched.promise
        expect(signal).toBe(handlerSignal)
        expect(signal?.aborted).toBe(false)
        const cancelled = await cancelIntegrationActionJob(job.id)
        expect(signal?.aborted).toBe(true)
        expect(cancelled.remoteOutcome).toBe(method === "POST" ? "unknown" : undefined)
        response.resolve({
          status: 200,
          headers: new Headers(),
          text: async () => "ok",
        } as Response)
        expect(await execution).toMatchObject({ status: "cancelled" })
        const audit = await getDb()
          .integrationAudit.where("kind")
          .equals("action.issue.update.cancelled")
          .first()
        expect(audit?.detail?.remoteOutcome).toBe(method === "POST" ? "unknown" : undefined)
        expect(fetchMock).toHaveBeenCalledTimes(1)
      } finally {
        global.fetch = originalFetch
        dispose()
      }
    }
  )

  it("aborts running work on unregister; disable cancels queued and held work", async () => {
    const entered = deferred<IntegrationActionHandlerContext>()
    const release = deferred<void>()
    const handler = jest.fn(async (_input, context: IntegrationActionHandlerContext) => {
      entered.resolve(context)
      await release.promise
      await expect(
        context.authenticatedRequest("https://api.example.test/issues", { method: "POST" })
      ).rejects.toThrow(/cancelled|claim/)
      return { updated: true }
    })
    const account = await setup(handler)
    const active = await queue(account.id)
    const queued = await enqueueIntegrationActionJob({ ...active, idempotencyKey: "queued" })
    const held = await enqueueIntegrationActionJob({
      ...active,
      idempotencyKey: "held",
      status: "awaiting_approval",
    })
    const unrelated = await enqueueIntegrationActionJob({
      ...active,
      pluginId: "other",
      idempotencyKey: "other",
    })
    const execution = runIntegrationActionJob(active.id)
    const context = await entered.promise
    unregisterIntegrationsByPlugin("example-delivery")
    expect(context.signal.aborted).toBe(true)
    release.resolve()
    expect(await execution).toMatchObject({ status: "cancelled" })
    // Unregister also runs on every re-activation, so the durable queue survives it.
    expect(await getIntegrationActionJob(queued.id)).toMatchObject({ status: "queued" })
    expect(await getIntegrationActionJob(held.id)).toMatchObject({ status: "awaiting_approval" })
    // Disabling the plugin (manager.cancelIntegrationJobsOnDisable) cancels the rest.
    await cancelIntegrationActionJobsByPlugin("example-delivery")
    expect(await getIntegrationActionJob(queued.id)).toMatchObject({ status: "cancelled" })
    expect(await getIntegrationActionJob(held.id)).toMatchObject({ status: "cancelled" })
    expect(await getIntegrationActionJob(unrelated.id)).toMatchObject({ status: "queued" })
  })

  it("observes cancellation persisted by another window and aborts its in-flight request", async () => {
    const dispatched = deferred<AbortSignal>()
    setIntegrationAuthenticatedRequestExecutorForTesting(
      async (_pluginId, _accountId, _input, init) => {
        const signal = init!.signal!
        dispatched.resolve(signal)
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Request aborted")), {
            once: true,
          })
        })
      }
    )
    const account = await setup(async (_input, context) =>
      context.authenticatedRequest("https://api.example.test/issues")
    )
    const job = await queue(account.id)
    const execution = runIntegrationActionJob(job.id)
    const signal = await dispatched.promise
    await cancelIntegrationActionJobRecord(job.id)
    expect(await execution).toMatchObject({ status: "cancelled" })
    expect(signal.aborted).toBe(true)
  })

  it("does not replay an expired non-idempotent job", async () => {
    const account = await setup()
    const job = await queue(account.id, "issue.delete")
    await getDb().integrationActionJobs.update(job.id, {
      status: "running",
      claimToken: "crashed",
      claimOwner: "old-window",
      claimLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    const [recovered] = await drainIntegrationActionJobs()
    expect(recovered).toMatchObject({ status: "cancelled", remoteOutcome: "unknown", attempts: 0 })
    expect(
      await getDb().integrationAudit.where("kind").equals("action.issue.delete.cancelled").first()
    ).toMatchObject({ detail: { jobId: job.id, remoteOutcome: "unknown" } })
  })

  it("recovers an action declared idempotent with a new claim token", async () => {
    const handler = jest.fn(async () => ({ updated: true }))
    const account = await setup(handler, ["https://api.example.test"], "supported")
    const job = await queue(account.id)
    await getDb().integrationActionJobs.update(job.id, {
      status: "running",
      claimToken: "crashed",
      claimOwner: "old-window",
      claimLeaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      remoteWriteStartedAt: new Date().toISOString(),
      idempotencyKey: undefined,
    })
    const [recovered] = await drainIntegrationActionJobs()
    expect(recovered).toMatchObject({ status: "succeeded", attempts: 1 })
    expect(recovered.claimToken).not.toBe("crashed")
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("queues secondary-window approval for the owner drain without executing there", async () => {
    const handler = jest.fn(async () => ({ updated: true }))
    const account = await setup(handler)
    const awaiting = await executeIntegrationAction("example-delivery", {
      integrationId: "example",
      accountId: account.id,
      actionId: "issue.update",
      input: {},
      idempotencyKey: "owner",
    })
    jest.mocked(isIntegrationRuntimeOwner).mockResolvedValue(false)
    expect(await approveIntegrationActionJob(awaiting.id)).toMatchObject({ status: "queued" })
    expect(await drainIntegrationActionJobs()).toEqual([])
    expect(handler).not.toHaveBeenCalled()
    jest.mocked(isIntegrationRuntimeOwner).mockResolvedValue(true)
    expect(await drainIntegrationActionJobs()).toEqual([
      expect.objectContaining({ status: "succeeded" }),
    ])
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("executes read actions immediately through the host request boundary", async () => {
    const account = await setup()
    const job = await executeIntegrationAction("example-delivery", {
      integrationId: "example",
      accountId: account.id,
      actionId: "issue.read",
      input: {},
    })

    expect(job.status).toBe("succeeded")
    expect(job.output).toEqual({ status: 200, headers: {}, data: { ok: true } })
  })

  it("fails closed before an authenticated request can send PII", async () => {
    await expect(
      authenticatedIntegrationRequest(
        "example-delivery",
        "account-1",
        "https://api.example.test/issues",
        { body: JSON.stringify({ email: "person@example.com" }) }
      )
    ).rejects.toThrow("blocked by the PII gate")
  })

  it("requires host approval before write actions and preserves idempotency", async () => {
    const account = await setup()
    const input = {
      integrationId: "example",
      accountId: account.id,
      actionId: "issue.update",
      input: { issueId: "EX-1" },
      idempotencyKey: "workflow-run-1",
    } as const

    const awaiting = await executeIntegrationAction("example-delivery", input)
    const duplicate = await executeIntegrationAction("example-delivery", input)
    expect(awaiting.status).toBe("awaiting_approval")
    expect(duplicate.id).toBe(awaiting.id)

    const approved = await approveIntegrationActionJob(awaiting.id)
    expect(approved).toMatchObject({
      status: "succeeded",
      output: { updated: "EX-1" },
    })
  })

  it("routes the first-party Issue Loop through the allowlisted host executor", async () => {
    const hostExecutor = jest.fn(async () => ({ pullRequestNumber: 11 }))
    setGithubIssueLoopExecutorForTesting(hostExecutor)
    setGithubIssueLoopDesktopHostAvailableForTesting(true)
    registerIntegrationDefinitions({
      pluginId: "github-delivery",
      definitions: [
        {
          id: "github",
          label: "GitHub",
          authStrategies: [
            {
              id: "pat",
              type: "personal-access-token",
              label: "PAT",
              providerId: "github-pat",
            },
          ],
          resourceKinds: ["repository"],
          eventTypes: [],
          actions: [
            {
              id: "runIssueLoop",
              label: "Issue Loop",
              handler: "pluginRunIssueLoop",
              inputSchema: { type: "object" },
              risk: "write",
              idempotency: "required",
            },
          ],
        },
      ],
      handlers: {
        "github:runIssueLoop": async () => {
          throw new Error("plugin handler must not receive host privileges")
        },
      },
    })
    const account = await createIntegrationAccount("github-delivery", {
      integrationId: "github",
      providerId: "github-pat",
      authSessionId: "opaque",
      remoteAccountId: "acct",
      label: "GitHub account",
    })
    const awaiting = await executeIntegrationAction("github-delivery", {
      integrationId: "github",
      accountId: account.id,
      actionId: "runIssueLoop",
      input: {},
      idempotencyKey: "issue-loop-1",
    })

    const completed = await approveIntegrationActionJob(awaiting.id)
    expect(completed).toMatchObject({ status: "succeeded", output: { pullRequestNumber: 11 } })
    expect(hostExecutor).toHaveBeenCalledTimes(1)
  })

  it("gates Issue Loop outside the desktop host while leaving HTTP actions available", async () => {
    const hostExecutor = jest.fn(async () => ({ pullRequestNumber: 11 }))
    setGithubIssueLoopExecutorForTesting(hostExecutor)
    setGithubIssueLoopDesktopHostAvailableForTesting(false)
    registerIntegrationDefinitions({
      pluginId: "github-delivery",
      definitions: [
        {
          id: "github",
          label: "GitHub",
          authStrategies: [
            {
              id: "pat",
              type: "personal-access-token",
              label: "PAT",
              providerId: "github-pat",
            },
          ],
          resourceKinds: ["repository"],
          eventTypes: [],
          actions: [
            {
              id: "runIssueLoop",
              label: "Issue Loop",
              handler: "pluginRunIssueLoop",
              inputSchema: { type: "object" },
              risk: "write",
              idempotency: "required",
            },
          ],
        },
      ],
      handlers: { "github:runIssueLoop": async () => ({}) },
    })
    const account = await createIntegrationAccount("github-delivery", {
      integrationId: "github",
      providerId: "github-pat",
      authSessionId: "opaque",
      remoteAccountId: "acct",
      label: "GitHub account",
    })
    const awaiting = await executeIntegrationAction("github-delivery", {
      integrationId: "github",
      accountId: account.id,
      actionId: "runIssueLoop",
      input: {},
      idempotencyKey: "issue-loop-browser",
    })

    await expect(approveIntegrationActionJob(awaiting.id)).resolves.toMatchObject({
      status: "failed",
      error: "GitHub Issue Loop requires a desktop host.",
    })
    expect(hostExecutor).not.toHaveBeenCalled()
    expect(resolveIntegrationActionAvailability("github-delivery", "github", "openPr")).toEqual({
      available: true,
    })
  })

  it("never bypasses approval for destructive actions and supports cancellation", async () => {
    const account = await setup()
    const awaiting = await executeIntegrationAction("example-delivery", {
      integrationId: "example",
      accountId: account.id,
      actionId: "issue.delete",
      input: { issueId: "EX-1" },
    })

    expect(awaiting.status).toBe("awaiting_approval")
    await expect(cancelIntegrationActionJob(awaiting.id)).resolves.toMatchObject({
      status: "cancelled",
    })
  })

  it("honors retry-after signals for idempotent actions", async () => {
    const account = await setup(async () => {
      throw Object.assign(new Error("rate limited"), {
        retryAfter: "30",
        requestId: "github-request-1",
        status: 429,
        category: "rate_limit",
        rateLimitReset: "1786240000",
      })
    })
    const awaiting = await executeIntegrationAction("example-delivery", {
      integrationId: "example",
      accountId: account.id,
      actionId: "issue.update",
      input: { issueId: "EX-1" },
      idempotencyKey: "retry-1",
    })
    const before = Date.now()
    const retrying = await approveIntegrationActionJob(awaiting.id)
    expect(retrying.status).toBe("retry_wait")
    expect(new Date(retrying.nextAttemptAt!).getTime()).toBeGreaterThanOrEqual(before + 29_000)
    await expect(
      getDb().integrationAudit.where("kind").equals("action.issue.update").first()
    ).resolves.toMatchObject({
      detail: expect.objectContaining({
        requestId: "github-request-1",
        status: 429,
        statusClass: "rate_limit",
        nextRetryAt: retrying.nextAttemptAt,
      }),
    })
  })

  it("injects provider-specific credential headers inside the host boundary", async () => {
    setIntegrationAuthenticatedRequestExecutorForTesting()
    registerIntegrationDefinitions({
      pluginId: "header-delivery",
      definitions: [
        {
          id: "header",
          label: "Header",
          authStrategies: [
            {
              id: "token",
              type: "personal-access-token",
              label: "Token",
              providerId: "header-token",
              requestAuth: { type: "header", name: "private-token", prefix: "token " },
            },
          ],
          resourceKinds: [],
          eventTypes: [],
          actions: [],
          allowedOrigins: ["https://gitlab.example.test"],
        },
      ],
      handlers: {},
    })
    const dispose = registerAuthenticationProvider({
      id: "header-token",
      label: "Header token",
      pluginId: "header-delivery",
      getSessions: async () => [
        {
          id: "opaque-session",
          accessToken: "secret-value",
          account: { id: "remote", label: "Remote" },
          scopes: [],
        },
      ],
      createSession: async () => {
        throw new Error("not used")
      },
      removeSession: async () => undefined,
    })
    const account = await createIntegrationAccount("header-delivery", {
      integrationId: "header",
      providerId: "header-token",
      authSessionId: "opaque-session",
      remoteAccountId: "remote",
      label: "Header account",
    })
    const originalFetch = global.fetch
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ok: true }),
      text: async () => "",
    } as Response)
    global.fetch = fetchMock as unknown as typeof fetch

    try {
      await authenticatedIntegrationRequest(
        "header-delivery",
        account.id,
        "https://gitlab.example.test/api/v4/user",
        { headers: { "Private-Token": "plugin-attempt" } }
      )

      const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers
      expect(headers.get("private-token")).toBe("token secret-value")
      expect(headers.get("authorization")).toBeNull()
    } finally {
      global.fetch = originalFetch
      dispose()
    }
  })

  it("resolves short-lived credentials inside the host request boundary", async () => {
    setIntegrationAuthenticatedRequestExecutorForTesting()
    registerIntegrationDefinitions({
      pluginId: "app-delivery",
      definitions: [
        {
          id: "app",
          label: "App",
          authStrategies: [
            {
              id: "app",
              type: "app",
              label: "App",
              providerId: "dynamic-app",
              requestAuth: { type: "bearer" },
            },
          ],
          resourceKinds: [],
          eventTypes: [],
          actions: [],
          allowedOrigins: ["https://api.example.test"],
        },
      ],
      handlers: {},
    })
    const resolveRequestCredential = jest.fn(async () => ({
      accessToken: "short-lived-token",
      expiresAt: "2026-08-09T12:00:00.000Z",
    }))
    const dispose = registerAuthenticationProvider({
      id: "dynamic-app",
      label: "Dynamic App",
      pluginId: null,
      getSessions: async () => [
        {
          id: "app-session",
          accessToken: "host-owned-placeholder",
          account: { id: "42", label: "Installation 42" },
          scopes: [],
        },
      ],
      createSession: async () => {
        throw new Error("not used")
      },
      removeSession: async () => undefined,
      resolveRequestCredential,
    })
    const account = await createIntegrationAccount("app-delivery", {
      integrationId: "app",
      providerId: "dynamic-app",
      authSessionId: "app-session",
      remoteAccountId: "42",
      label: "Installation 42",
    })
    const originalFetch = global.fetch
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ok: true }),
      text: async () => "",
    } as Response)
    global.fetch = fetchMock as unknown as typeof fetch

    try {
      await authenticatedIntegrationRequest(
        "app-delivery",
        account.id,
        "https://api.example.test/app/installations/42"
      )

      expect(resolveRequestCredential).toHaveBeenCalledWith("app-session", {
        connectorAccountId: account.id,
        origin: "https://api.example.test",
      })
      const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers
      expect(headers.get("authorization")).toBe("Bearer short-lived-token")
    } finally {
      global.fetch = originalFetch
      dispose()
    }
  })
  it("runs an exact approved Bot action through its bound provider and replays once", async () => {
    const handler = jest.fn().mockResolvedValue({ updated: true })
    const account = await setup(handler)
    const authorize = jest
      .spyOn(botBinding, "assertBotIntegrationAction")
      .mockResolvedValue({ account } as Awaited<
        ReturnType<typeof botBinding.assertBotIntegrationAction>
      >)
    const input = {
      integrationId: "example",
      accountId: "",
      actionId: "issue.update",
      input: { issueId: "1", repoFullName: "owner/repo" },
      binding: { runId: "run", slotId: "github" },
      approval: { interruptId: "approval" },
      idempotencyKey: "once",
    }
    const first = await executeIntegrationAction("bot", input)
    expect(first).toMatchObject({
      status: "succeeded",
      pluginId: "example-delivery",
      botBinding: { pluginId: "bot", runId: "run", approvalId: "approval" },
      idempotencyKey: "bot:run:once",
    })
    expect(authorize).toHaveBeenCalledTimes(2)
    expect((await executeIntegrationAction("bot", input)).id).toBe(first.id)
    expect(handler).toHaveBeenCalledTimes(1)
    await expect(
      executeIntegrationAction("bot", { ...input, input: { issueId: "2" } })
    ).rejects.toThrow("different approved content")
    await expect(
      executeIntegrationAction("bot", { ...input, accountId: "someone-else" })
    ).rejects.toThrow("does not match")
  })

  it("rechecks Bot approval at dispatch and refuses revoked authority before writes", async () => {
    const handler = jest.fn().mockResolvedValue({ updated: true })
    const account = await setup(handler)
    jest
      .spyOn(botBinding, "assertBotIntegrationAction")
      .mockResolvedValueOnce({ account } as Awaited<
        ReturnType<typeof botBinding.assertBotIntegrationAction>
      >)
      .mockRejectedValueOnce(new Error("Approval expired"))
    const job = await executeIntegrationAction("bot", {
      integrationId: "example",
      accountId: "",
      actionId: "issue.update",
      input: { issueId: "1" },
      binding: { runId: "run", slotId: "github" },
      approval: { interruptId: "approval" },
      idempotencyKey: "once",
    })
    expect(job).toMatchObject({ status: "failed", error: "Approval expired" })
    expect(handler).not.toHaveBeenCalled()
  })

  it("injects only the host publication SHA and revalidates even a succeeded action replay", async () => {
    const handler = jest.fn().mockResolvedValue({ updated: true })
    const account = await setup(handler)
    const sha = "a".repeat(40)
    jest.mocked(botBinding.assertBotIntegrationAction).mockResolvedValue({
      account,
      repository: "owner/repo",
      approvedPublication: { branch: "bot/fix", headSha: sha },
    } as Awaited<ReturnType<typeof botBinding.assertBotIntegrationAction>>)
    let remoteSha = sha
    setIntegrationAuthenticatedRequestExecutorForTesting(async <T>() => ({
      status: 200,
      headers: {},
      data: { sha: remoteSha } as T,
    }))
    const input = {
      integrationId: "example",
      accountId: "",
      actionId: "issue.update",
      input: { issueId: "1", expectedHeadSha: "caller-controlled" },
      binding: { runId: "run", slotId: "github" },
      approval: { interruptId: "approval" },
      idempotencyKey: "head-check",
    }
    const result = await executeIntegrationAction("bot", input)
    expect(result.status).toBe("succeeded")
    expect(handler.mock.calls[0][0].expectedHeadSha).toBe(sha)
    expect(result.input).toEqual(input.input)
    remoteSha = "b".repeat(40)
    await expect(executeIntegrationAction("bot", input)).rejects.toThrow("head SHA changed")
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("refuses a publication when approval is revoked during provider preparation", async () => {
    const handler = jest.fn().mockImplementation(async (_input, context) =>
      context.authenticatedRequest("https://api.github.com/repos/owner/repo/pulls", {
        method: "POST",
        body: JSON.stringify({ title: "Fix" }),
      })
    )
    const account = await setup(handler)
    const binding = { account } as Awaited<ReturnType<typeof botBinding.assertBotIntegrationAction>>
    jest
      .mocked(botBinding.assertBotIntegrationAction)
      .mockResolvedValueOnce(binding)
      .mockResolvedValueOnce(binding)
      .mockRejectedValueOnce(new Error("Approval expired during preparation"))
    const request = jest.fn()
    setIntegrationAuthenticatedRequestExecutorForTesting(request)
    const result = await executeIntegrationAction("bot", {
      integrationId: "example",
      accountId: "",
      actionId: "issue.update",
      input: { issueId: "1" },
      binding: { runId: "run", slotId: "github" },
      approval: { interruptId: "approval" },
      idempotencyKey: "late-revoke",
    })
    expect(result.error).toContain("Approval expired during preparation")
    expect(request).not.toHaveBeenCalled()
  })

  describe("raw integration write authorization", () => {
    const enforceIntegration = {
      agentPermissions: { outboundAuthorizationByCategory: { integration: "enforce" } },
    }
    const url = "https://api.example.test/calendar/events/1?view=private-query#private-fragment"

    it("observes a calendar DELETE with metadata and a shadow report, without query or body", async () => {
      const account = await setup()
      const request = jest.fn().mockResolvedValue({ status: 204, headers: {}, data: {} })
      setIntegrationAuthenticatedRequestExecutorForTesting(request)
      await expect(
        authenticatedIntegrationRequest("example-delivery", account.id, url, {
          method: "delete",
          body: '{"event":"private-body"}',
        })
      ).resolves.toMatchObject({ status: 204 })
      expect(request).toHaveBeenCalledTimes(1)
      const receipts = await getDb().actionReviewReceipts.toArray()
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        request: {
          origin: { scope: "integration" },
          subject: {
            ref: "plugin:example-delivery",
            title: "DELETE",
            input: {
              integrationAccount: { pluginId: "example-delivery", accountId: account.id },
              integrationRequest: {
                integrationId: "example",
                method: "DELETE",
                url: "https://api.example.test/calendar/events/1",
              },
            },
            targets: [{ channel: "integration", fingerprint: expect.any(String) }],
          },
          plan: { outcome: "park", enforced: false },
        },
        decision: { outcome: "allow" },
      })
      expect(JSON.stringify(receipts)).not.toMatch(/private-query|private-fragment|private-body/)
      const report = buildShadowReport({
        receipts,
        candidates: [],
        botLists: new Map(),
        adapterLists: new Map(),
      })
      expect(report.integration).toMatchObject({ sends: 1, totals: { park: 1 } })
      expect(report.github.sends).toBe(0)
    })

    it("blocks a calendar DELETE before fetching under integration enforcement", async () => {
      outboundSettings = enforceIntegration
      const account = await setup()
      const request = jest.fn()
      setIntegrationAuthenticatedRequestExecutorForTesting(request)
      await expect(
        authenticatedIntegrationRequest("example-delivery", account.id, url, { method: "DELETE" })
      ).rejects.toThrow(/^outbound_held/)
      expect(request).not.toHaveBeenCalled()
      expect(await getDb().actionReviewReceipts.toArray()).toEqual([
        expect.objectContaining({
          request: expect.objectContaining({ plan: { outcome: "park", enforced: true } }),
          decision: expect.objectContaining({ outcome: "deny" }),
        }),
      ])
    })

    it.each([undefined, "GET", "head", "OPTIONS"])("never plans a read (%s)", async (method) => {
      outboundSettings = enforceIntegration
      const account = await setup()
      await expect(
        authenticatedIntegrationRequest("example-delivery", account.id, url, { method })
      ).resolves.toMatchObject({ status: 200 })
      expect(await getDb().actionReviewReceipts.toArray()).toEqual([])
    })

    it("routes a non-GitHub-id integration's api.github.com POST through GitHub policy", async () => {
      outboundSettings = {
        agentPermissions: { outboundAuthorizationByCategory: { github: "enforce" } },
      }
      const account = await setup(undefined, ["https://api.github.com"])
      const request = jest.fn()
      setIntegrationAuthenticatedRequestExecutorForTesting(request)
      await expect(
        authenticatedIntegrationRequest(
          "example-delivery",
          account.id,
          "https://api.github.com/repos/acme/web/pulls",
          { method: "POST" }
        )
      ).rejects.toThrow(/^outbound_held/)
      expect(request).not.toHaveBeenCalled()
      const receipts = await getDb().actionReviewReceipts.toArray()
      expect(receipts[0]).toMatchObject({
        request: {
          origin: { scope: "github", channel: "github-delivery" },
          subject: { targets: [{ channel: "github", fingerprint: expect.any(String) }] },
          plan: { enforced: true, outcome: "park" },
        },
      })
      // GitHub receipts retain the existing fingerprint-only recipient contract.
      expect(JSON.stringify(receipts)).not.toContain("acme/web")
    })

    it("uses GitHub policy for a generic provider writing to a configured Enterprise host", async () => {
      outboundSettings = {
        agentPermissions: {
          outboundAuthorizationByCategory: { github: "enforce", integration: "shadow" },
        },
      }
      const host = parseGithubHost("https://ghe.corp.test:8443/api/v3")!
      jest.mocked(configuredGithubHosts).mockResolvedValue([host])
      const account = await setup(undefined, [new URL(host.apiBaseUrl).origin])
      const request = jest.fn()
      setIntegrationAuthenticatedRequestExecutorForTesting(request)
      await expect(
        authenticatedIntegrationRequest(
          "example-delivery",
          account.id,
          `${host.apiBaseUrl}/repos/acme/web/pulls`,
          { method: "POST" }
        )
      ).rejects.toThrow(/^outbound_held/)
      expect(request).not.toHaveBeenCalled()
      expect((await getDb().actionReviewReceipts.toArray())[0]).toMatchObject({
        request: {
          origin: { scope: "github" },
          subject: { targets: [{ channel: "github", fingerprint: expect.any(String) }] },
          plan: { enforced: true, outcome: "park" },
        },
      })
    })

    it.each([
      undefined,
      { kind: "tool-call", sessionId: "s1" },
      {
        kind: "workflow",
        workflowId: "wf1",
        runId: "wr1",
      },
    ] as const)("also blocks handler requests for caller %j without retrying", async (caller) => {
      outboundSettings = enforceIntegration
      const request = jest.fn()
      setIntegrationAuthenticatedRequestExecutorForTesting(request)
      const account = await setup(async (_input, context) =>
        context.authenticatedRequest(url, { method: "DELETE" })
      )
      const held = await executeIntegrationAction(
        "example-delivery",
        {
          integrationId: "example",
          accountId: account.id,
          actionId: "issue.update",
          input: {},
          idempotencyKey: "calendar-delete",
        },
        caller
      )
      const failed = await approveIntegrationActionJob(held.id)
      expect(failed).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/^outbound_held/),
      })
      expect(request).not.toHaveBeenCalled()
    })
  })

  describe("outbound authorization of GitHub writes (ADR-0239 phase 2)", () => {
    const enforceGithub = {
      agentPermissions: { outboundAuthorizationByCategory: { github: "enforce" } },
    }

    async function setupGithub(
      comment: (
        input: Record<string, unknown>,
        context: Parameters<
          Parameters<typeof registerIntegrationDefinitions>[0]["handlers"][string]
        >[1]
      ) => Promise<unknown> = async () => ({ commented: true })
    ) {
      registerIntegrationDefinitions({
        pluginId: "github-delivery",
        definitions: [
          {
            id: "github",
            label: "GitHub",
            authStrategies: [
              { id: "oauth", type: "oauth2", label: "OAuth", providerId: "github-oauth" },
            ],
            resourceKinds: ["repository"],
            eventTypes: [],
            actions: [
              {
                id: "commentPr",
                label: "Comment on pull request",
                handler: "commentPr",
                inputSchema: { type: "object" },
                risk: "write",
                idempotency: "required",
                scopeSelectors: [{ kind: "repository", jsonPointer: "/repoFullName" }],
              },
            ],
          },
        ],
        handlers: { "github:commentPr": comment },
      })
      return createIntegrationAccount("github-delivery", {
        integrationId: "github",
        providerId: "github-oauth",
        authSessionId: "opaque",
        remoteAccountId: "octocat",
        label: "GitHub",
      })
    }

    const comment = (accountId: string, key: string, prNumber = 12) => ({
      integrationId: "github",
      accountId,
      actionId: "commentPr",
      input: { repoFullName: "acme/web", prNumber, body: "hi" },
      idempotencyKey: key,
    })

    const receipts = () => getDb().actionReviewReceipts.toArray()

    it("holds a write nothing authorized, pushes it, and lets only a person release it", async () => {
      outboundSettings = enforceGithub
      const handler = jest.fn(async () => ({ commented: true }))
      const account = await setupGithub(handler)
      const held = await executeIntegrationAction("github-delivery", comment(account.id, "k1"))
      expect(held).toMatchObject({
        status: "awaiting_approval",
        outbound: { ownerRef: "plugin:github-delivery", held: { receiptId: expect.any(String) } },
      })
      expect(held.authorizedBy).toBeUndefined()
      expect(pushHeldIntegrationJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: held.id,
          origin: "plugin",
          toolName: "integration__github-delivery__github__commentpr",
          label: "GitHub: Comment on pull request",
          review: expect.objectContaining({
            enforced: true,
            targets: [
              expect.objectContaining({
                kind: "repository",
                recipient: "github:github.com/acme/web",
                thread: "12",
              }),
            ],
          }),
        })
      )
      const [hold] = await receipts()
      expect(hold).toMatchObject({
        id: held.outbound!.held!.receiptId,
        request: {
          origin: { channel: "github-delivery" },
          subject: { kind: "integration-action", ref: "plugin:github-delivery" },
          plan: { outcome: "park", enforced: true },
        },
      })

      // An automatic approval (a bridge with a capability grant) leaves it held.
      await expect(approveIntegrationActionJob(held.id)).resolves.toMatchObject({
        status: "awaiting_approval",
      })
      expect(handler).not.toHaveBeenCalled()

      const released = await approveIntegrationActionJob(held.id, { actor: "person" })
      expect(released).toMatchObject({
        status: "succeeded",
        outbound: { ownerRef: "plugin:github-delivery" },
        authorizedBy: { authority: "human", grantScope: "once" },
      })
      expect(released.outbound?.held).toBeUndefined()
      expect(withdrawHeldIntegrationJob).toHaveBeenCalledWith(held.id)
      expect(handler).toHaveBeenCalledTimes(1)
      const answer = (await receipts()).find((r) => r.id === released.authorizedBy?.receiptId)
      expect(answer?.decision).toMatchObject({ outcome: "allow", authority: "human" })

      // A replay keeps the job's plan: no second hold, no second push.
      await executeIntegrationAction("github-delivery", comment(account.id, "k1"))
      expect(pushHeldIntegrationJob).toHaveBeenCalledTimes(1)
    })

    it("holds a chat call's write even after its capability grant approves it", async () => {
      outboundSettings = enforceGithub
      const account = await setupGithub()
      const held = await executeIntegrationAction(
        "github-delivery",
        { ...comment(account.id, "k1", 13), source: "chat" },
        { kind: "tool-call", sessionId: "s1" }
      )
      expect(held.outbound?.ownerRef).toBe("tool-call:s1")
      await expect(approveIntegrationActionJob(held.id)).resolves.toMatchObject({
        status: "awaiting_approval",
      })
    })

    it("holds a Bot's policy-approved write that leaves the event's thread instead of queueing it", async () => {
      outboundSettings = enforceGithub
      const handler = jest.fn(async () => ({ commented: true }))
      const account = await setupGithub(handler)
      jest.mocked(botBinding.assertBotIntegrationAction).mockResolvedValue({
        account,
        installation: { id: "boti_1" },
      } as Awaited<ReturnType<typeof botBinding.assertBotIntegrationAction>>)
      const job = await executeIntegrationAction("comment-bot", {
        ...comment("", "k1"),
        binding: { runId: "run_bot_1", slotId: "github" },
        approval: { interruptId: "approval" },
      })
      expect(job).toMatchObject({
        status: "awaiting_approval",
        outbound: { ownerRef: "bot:boti_1", rootSessionId: "bot:boti_1", held: expect.any(Object) },
      })
      expect(pushHeldIntegrationJob).toHaveBeenCalledWith(
        expect.objectContaining({ origin: "bot" })
      )
      expect(handler).not.toHaveBeenCalled()
    })

    const repoGrant = (repository: string) => ({
      recipient: {
        kind: "repository" as const,
        channel: "github",
        recipient: `github:github.com/${repository}`,
      },
      addedAt: 1,
      addedBy: "local-user" as const,
    })

    it("lets a write go to a repository on the account's list, and its raw requests", async () => {
      outboundSettings = enforceGithub
      const handler = jest.fn(async () => ({ commented: true }))
      const account = await setupGithub(handler)
      await setIntegrationAccountOutboundRecipients("github-delivery", account.id, [
        repoGrant("acme/web"),
      ])
      const job = await executeIntegrationAction("github-delivery", comment(account.id, "k1"))
      expect(job.outbound?.held).toBeUndefined()
      expect(job.authorizedBy).toMatchObject({
        authority: "policy-rule",
        policyRef: `integration-account:${account.id}`,
      })
      expect(pushHeldIntegrationJob).not.toHaveBeenCalled()
      await expect(
        authenticatedIntegrationRequest(
          "github-delivery",
          account.id,
          "https://api.github.com/repos/acme/web/issues/3/comments",
          { method: "POST", body: "{}" }
        )
      ).resolves.toMatchObject({ status: 200 })
      // Another repository is still held.
      await expect(
        authenticatedIntegrationRequest(
          "github-delivery",
          account.id,
          "https://api.github.com/repos/acme/api/issues/3/comments",
          { method: "POST", body: "{}" }
        )
      ).rejects.toThrow(/^outbound_held/)
    })

    it("lets a repository-scoped capability grant cover the action, not a raw request", async () => {
      outboundSettings = enforceGithub
      const account = await setupGithub()
      const now = new Date().toISOString()
      await putServiceConnection({
        id: "conn_1",
        pluginId: "github-delivery",
        serviceId: "github",
        providerId: "github",
        runtimeTargetId: "local",
        status: "connected",
        providerFingerprint: "fp",
        providerRef: { kind: "integration", accountId: account.id },
        enabledSurfaces: ["chat"],
        createdAt: now,
        updatedAt: now,
      } as Parameters<typeof putServiceConnection>[0])
      await putCapabilityGrant({
        id: "grant_1",
        connectionId: "conn_1",
        providerFingerprint: "fp",
        operationPatterns: ["commentPr"],
        resourceScopes: [{ kind: "repository", values: ["acme/web"] }],
        createdAt: now,
        updatedAt: now,
      })
      const job = await executeIntegrationAction("github-delivery", comment(account.id, "k1"))
      expect(job.outbound?.held).toBeUndefined()
      expect(job.authorizedBy).toMatchObject({ policyRef: "capability-grant:grant_1" })
      await expect(
        authenticatedIntegrationRequest(
          "github-delivery",
          account.id,
          "https://api.github.com/repos/acme/web/issues/3/comments",
          { method: "POST", body: "{}" }
        )
      ).rejects.toThrow(/^outbound_held/)
    })

    it("lets a Bot that publishes without a person write to its installation's repository", async () => {
      outboundSettings = enforceGithub
      const account = await setupGithub()
      jest.mocked(botBinding.assertBotIntegrationAction).mockResolvedValue({
        account,
        installation: { id: "boti_1" },
        repository: "acme/web",
      } as Awaited<ReturnType<typeof botBinding.assertBotIntegrationAction>>)
      const job = await executeIntegrationAction("comment-bot", {
        ...comment("", "k1"),
        binding: { runId: "run_bot_1", slotId: "github" },
      })
      expect(job.outbound?.held).toBeUndefined()
      expect(job.status).toBe("succeeded")
      expect(job.authorizedBy).toMatchObject({ policyRef: "bot-scope:boti_1" })
    })

    it("lets a write a person confirmed by hand through, as theirs", async () => {
      outboundSettings = enforceGithub
      const handler = jest.fn(async () => ({ commented: true }))
      const account = await setupGithub(handler)
      const job = await executeIntegrationAction("github-delivery", comment(account.id, "k1"), {
        kind: "person",
        surface: "issue-writeback",
      })
      expect(job.outbound).toEqual({ ownerRef: "person:issue-writeback" })
      expect(job.authorizedBy).toMatchObject({ authority: "human", grantScope: "once" })
      expect(pushHeldIntegrationJob).not.toHaveBeenCalled()
      // The dialog's own approval runs it.
      await expect(approveIntegrationActionJob(job.id)).resolves.toMatchObject({
        status: "succeeded",
      })
      expect((await receipts())[0]).toMatchObject({
        request: { subject: { ref: "person:issue-writeback" }, plan: { outcome: "allow" } },
        decision: { authority: "human", actor: { kind: "local-user" } },
      })
    })

    it("fences the recipients a person refused for the rest of the request", async () => {
      outboundSettings = enforceGithub
      const account = await setupGithub()
      const workflow = { kind: "workflow", workflowId: "wf_1", runId: "wr_1" } as const
      const held = await executeIntegrationAction(
        "github-delivery",
        comment(account.id, "k1"),
        workflow
      )
      expect(held.outbound).toMatchObject({ rootSessionId: "workflow-run:wr_1" })
      const cancelled = await cancelIntegrationActionJob(held.id, { actor: "person" })
      expect(cancelled.status).toBe("cancelled")
      expect(withdrawHeldIntegrationJob).toHaveBeenCalledWith(held.id)
      expect(
        (await receipts()).map((r) => [r.decision.outcome, r.decision.authority])
      ).toContainEqual(["deny", "human"])

      // Another write to the same repository in the same run is refused, not asked.
      const fenced = await executeIntegrationAction(
        "github-delivery",
        comment(account.id, "k2", 40),
        workflow
      )
      expect(fenced).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/^outbound_fenced/),
      })
      expect(pushHeldIntegrationJob).toHaveBeenCalledTimes(1)
      expect(
        (await getDb().integrationAudit.toArray()).some(
          (entry) => entry.kind === "action.commentPr.fenced"
        )
      ).toBe(true)
      // A new run is a new request.
      await expect(
        executeIntegrationAction("github-delivery", comment(account.id, "k3", 40), {
          ...workflow,
          runId: "wr_2",
        })
      ).resolves.toMatchObject({ status: "awaiting_approval" })
    })

    it("withdraws a held job's push when its plugin cancels it, without a person's refusal", async () => {
      outboundSettings = enforceGithub
      const account = await setupGithub()
      const held = await executeIntegrationAction("github-delivery", comment(account.id, "k1"))
      const cancelled = await cancelIntegrationActionJob(held.id)
      expect(cancelled).toMatchObject({ status: "cancelled" })
      expect(cancelled.outbound?.held).toBeUndefined()
      expect(withdrawHeldIntegrationJob).toHaveBeenCalledWith(held.id)
      expect((await receipts()).some((r) => r.decision.authority === "human")).toBe(false)
    })

    it("changes nothing in shadow mode but records what enforcement would have held", async () => {
      const account = await setupGithub()
      const job = await executeIntegrationAction("github-delivery", comment(account.id, "k1"))
      expect(job.status).toBe("awaiting_approval")
      expect(job.outbound).toEqual({ ownerRef: "plugin:github-delivery" })
      expect(pushHeldIntegrationJob).not.toHaveBeenCalled()
      await expect(approveIntegrationActionJob(job.id)).resolves.toMatchObject({
        status: "succeeded",
      })
      const [observed] = await receipts()
      expect(observed).toMatchObject({
        request: { plan: { outcome: "park", enforced: false } },
        decision: { outcome: "allow", authority: "policy-default" },
      })
    })

    it("keeps action approval separate and observes other integrations' raw writes", async () => {
      outboundSettings = enforceGithub
      const account = await setup()
      const job = await executeIntegrationAction("example-delivery", {
        integrationId: "example",
        accountId: account.id,
        actionId: "issue.update",
        input: { issueId: "1" },
        idempotencyKey: "x",
      })
      expect(job.status).toBe("awaiting_approval")
      expect(job.outbound).toBeUndefined()
      await expect(
        authenticatedIntegrationRequest(
          "example-delivery",
          account.id,
          "https://api.example.test/x",
          {
            method: "POST",
          }
        )
      ).resolves.toMatchObject({ status: 200 })
      expect(await receipts()).toEqual([
        expect.objectContaining({
          request: expect.objectContaining({
            origin: expect.objectContaining({ scope: "integration" }),
            plan: { outcome: "park", enforced: false },
          }),
        }),
      ])
    })

    describe("raw requests", () => {
      it("refuses a write the policy holds, since a request cannot wait", async () => {
        outboundSettings = enforceGithub
        const account = await setupGithub()
        await expect(
          authenticatedIntegrationRequest(
            "github-delivery",
            account.id,
            "https://api.github.com/repos/acme/web/issues/3/comments",
            { method: "POST", body: "{}" }
          )
        ).rejects.toThrow(/^outbound_held/)
        await expect(
          authenticatedIntegrationRequest(
            "github-delivery",
            account.id,
            "https://api.github.com/graphql",
            { method: "post", body: "{}" }
          )
        ).rejects.toThrow(/^outbound_held/)
        await expect(
          authenticatedIntegrationRequest(
            "github-delivery",
            account.id,
            "https://api.github.com/repos/acme/web/pulls"
          )
        ).resolves.toMatchObject({ status: 200 })
        expect((await receipts()).map((r) => r.request.subject.title)).toEqual(["POST", "POST"])
      })

      it("only records in shadow mode", async () => {
        const account = await setupGithub()
        await expect(
          authenticatedIntegrationRequest(
            "github-delivery",
            account.id,
            "https://api.github.com/repos/acme/web/pulls",
            { method: "POST", body: "{}" }
          )
        ).resolves.toMatchObject({ status: 200 })
        expect((await receipts())[0]).toMatchObject({
          request: { plan: { outcome: "park", enforced: false } },
        })
      })
    })

    describe("requests a running job makes", () => {
      it("lets the Issue Loop open its pull request in the repository it was approved for", async () => {
        outboundSettings = enforceGithub
        setGithubIssueLoopDesktopHostAvailableForTesting(true)
        const request = jest.fn().mockResolvedValue({ status: 201, headers: {}, data: {} })
        setIntegrationAuthenticatedRequestExecutorForTesting(request)
        setGithubIssueLoopExecutorForTesting(async (input, context) =>
          context.authenticatedRequest(
            `https://api.github.com/repos/${String(input.repoFullName)}/pulls`,
            { method: "POST", body: "{}" }
          )
        )
        registerIntegrationDefinitions({
          pluginId: "github-delivery",
          definitions: [
            {
              id: "github",
              label: "GitHub",
              authStrategies: [
                { id: "oauth", type: "oauth2", label: "OAuth", providerId: "github-oauth" },
              ],
              resourceKinds: ["repository"],
              eventTypes: [],
              actions: [
                {
                  id: "runIssueLoop",
                  label: "Issue Loop",
                  handler: "runIssueLoop",
                  inputSchema: { type: "object" },
                  risk: "write",
                  idempotency: "required",
                  scopeSelectors: [{ kind: "repository", jsonPointer: "/repoFullName" }],
                },
              ],
            },
          ],
          handlers: { "github:runIssueLoop": async () => ({}) },
        })
        const account = await createIntegrationAccount("github-delivery", {
          integrationId: "github",
          providerId: "github-oauth",
          authSessionId: "opaque",
          remoteAccountId: "octocat",
          label: "GitHub",
        })
        const held = await executeIntegrationAction("github-delivery", {
          integrationId: "github",
          accountId: account.id,
          actionId: "runIssueLoop",
          input: { repoFullName: "acme/web", issueNumber: 7, head: "fix", base: "main" },
          idempotencyKey: "loop-1",
        })
        expect(held.outbound?.held).toBeDefined()
        await expect(
          approveIntegrationActionJob(held.id, { actor: "person" })
        ).resolves.toMatchObject({ status: "succeeded" })
        expect(request).toHaveBeenCalledWith(
          "github-delivery",
          account.id,
          "https://api.github.com/repos/acme/web/pulls",
          expect.objectContaining({ method: "POST" })
        )
      })

      it("covers the job's own repository and refuses another without retrying", async () => {
        outboundSettings = enforceGithub
        let target = "https://api.github.com/repos/acme/web/pulls"
        const request = jest.fn().mockResolvedValue({ status: 201, headers: {}, data: {} })
        setIntegrationAuthenticatedRequestExecutorForTesting(request)
        const account = await setupGithub(async (_input, context) =>
          context.authenticatedRequest(target, { method: "POST", body: "{}" })
        )
        const first = await executeIntegrationAction("github-delivery", comment(account.id, "k1"))
        await expect(
          approveIntegrationActionJob(first.id, { actor: "person" })
        ).resolves.toMatchObject({ status: "succeeded" })
        expect(request).toHaveBeenCalledTimes(1)

        target = "https://api.github.com/repos/acme/other/pulls"
        const second = await executeIntegrationAction("github-delivery", comment(account.id, "k2"))
        const failed = await approveIntegrationActionJob(second.id, { actor: "person" })
        expect(failed).toMatchObject({
          status: "failed",
          error: expect.stringMatching(/^outbound_held/),
        })
        expect(request).toHaveBeenCalledTimes(1)
      })
    })
  })
})
