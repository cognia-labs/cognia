/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  __resetIntegrationRegistryForTesting,
  registerIntegrationDefinitions,
} from "@/lib/integrations/registry"
import * as botBinding from "./bot-integration-binding"
import * as actionRunner from "@/lib/integrations/action-runner"
import * as githubAuth from "@/lib/integrations/github-auth"
import { setIntegrationAuthenticatedRequestExecutorForTesting } from "@/lib/integrations/action-runner"
import { setIntegrationAccountOutboundRecipients } from "@/lib/db/integrations"
import { createIntegrationsAPI, toPluginAccount } from "./integrations-api"
import { routePythonHostRequest } from "@/lib/plugin/python/host-request-router"
import type { PluginContext } from "@/types/plugin/plugin"
import { getAuthConnection, type AuthConnectionRow } from "@/lib/db/auth-connections"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import {
  registerAuthenticationProvider,
  __resetAuthRegistryForTesting,
} from "@cognia/plugin-contract/lib/plugin/auth/auth-provider-registry"
import { getConnectionManager } from "@/lib/plugin/auth/connection-manager"

jest.mock("@/lib/plugin/auth/connection-manager", () => ({
  ...jest.requireActual("@/lib/plugin/auth/connection-manager"),
  getConnectionManager: jest.fn(
    jest.requireActual("@/lib/plugin/auth/connection-manager").getConnectionManager
  ),
}))

// Mutable namespace seams retain the real implementations unless a boundary test spies on one.
jest.mock("@/lib/db/integrations", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/db/integrations"),
}))
jest.mock("@/lib/integrations/action-runner", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/integrations/action-runner"),
}))
jest.mock("@/lib/integrations/ingress-client", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/integrations/ingress-client"),
}))
jest.mock("@/lib/integrations/events", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/integrations/events"),
}))
jest.mock("@/lib/integrations/github-auth", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/integrations/github-auth"),
}))
jest.mock("@/lib/integrations/migration", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/integrations/migration"),
}))

let outboundSettings: object = { agentPermissions: {} }
jest.mock("@/lib/policy/action-review/plan-context", () => ({
  ...jest.requireActual("@/lib/policy/action-review/plan-context"),
  readAppSettings: jest.fn(async () => outboundSettings),
}))

jest.mock("./bot-integration-binding", () => ({
  ...jest.requireActual("./bot-integration-binding"),
  resolveBotIntegrationBinding: jest.fn(),
}))

describe("ctx.integrations", () => {
  it("keeps migration available during activation before Integration registration", async () => {
    const api = createIntegrationsAPI("example-delivery", () => true)
    await expect(
      api.migrateLegacy({
        id: "activation-migration",
        integrationId: "not-yet-registered",
        accounts: [],
        subscriptions: [],
        workflowKindAliases: {},
        rebindLegacyConnections: { service: "auth.example" },
      })
    ).resolves.toMatchObject({ migratedAccounts: 0, alreadyApplied: false })
  })

  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetIntegrationRegistryForTesting()
    registerIntegrationDefinitions({
      pluginId: "example-delivery",
      definitions: [
        {
          id: "example",
          label: "Example",
          authStrategies: [],
          resourceKinds: ["issue"],
          resourceProvider: { handler: "listResources", kinds: ["issue", "repository"] },
          healthProvider: { handler: "checkHealth" },
          eventTypes: [],
          inboxProjections: [
            {
              id: "issue-thread",
              label: "Issue thread",
              eventTypes: ["issue.updated"],
              threadKeyPointer: "/issue/id",
              titlePointer: "/issue/title",
              bodyPointer: "/issue/body",
            },
          ],
          actions: [],
        },
      ],
      handlers: {},
      resourceProviders: {
        example: async (query) => ({
          items: [{ kind: query.kind, id: "cognia/cognia-next", name: "cognia-next" }],
          syncedAt: "2026-08-09T00:00:00.000Z",
        }),
      },
      accountStatusProviders: {
        example: async () => ({
          health: "healthy",
          checkedAt: "2026-08-09T00:00:00.000Z",
          grantedPermissions: ["issues:write"],
          requiredPermissions: ["issues:write"],
        }),
      },
    })
  })

  it("keeps account and subscription mutations behind integrations:manage", async () => {
    const readOnly = createIntegrationsAPI(
      "example-delivery",
      (permission) => permission === "integrations:read"
    )
    await expect(
      readOnly.createAccount({
        integrationId: "example",
        providerId: "oauth",
        authSessionId: "opaque",
        remoteAccountId: "one",
        label: "One",
      })
    ).rejects.toThrow('requires the "integrations:manage" permission')
  })

  it("validates connectionId visibility, status, provider and registration and stamps Host identity", async () => {
    __resetAuthRegistryForTesting()
    localStorage.clear()
    const getConnection = jest.fn((ref: AuthConnectionRef) => getAuthConnection(ref))
    jest.mocked(getConnectionManager).mockReturnValue({ getConnection } as never)
    registerAuthenticationProvider({
      id: "oauth",
      pluginId: "example-delivery",
      label: "OAuth",
      getSessions: async () => [],
      createSession: async () => {
        throw new Error("unused")
      },
      removeSession: async () => {},
    })
    registerIntegrationDefinitions({
      pluginId: "example-delivery",
      definitions: [
        {
          id: "example",
          label: "Example",
          authStrategies: [{ id: "oauth", label: "OAuth", type: "oauth2", providerId: "oauth" }],
          resourceKinds: [],
          eventTypes: [],
          actions: [],
        },
      ],
      handlers: {},
    })
    const row: AuthConnectionRow = {
      id: "ref" as AuthConnectionRef,
      providerId: "oauth",
      ownerPluginId: "example-delivery",
      publisher: null,
      contractMajor: 1,
      issuer: "https://issuer.test",
      clientId: "client",
      principalId: "host-principal",
      principalKind: "user",
      accountLabel: "Host account",
      scopes: ["read"],
      revision: 1,
      credentialRevision: 1,
      lineageId: "lineage",
      identityKey: "identity",
      status: "connected",
      legacySessionId: "host-legacy-session",
      createdAt: 1,
      updatedAt: 1,
    }
    await getDb().authConnections.put(row)
    const api = createIntegrationsAPI("example-delivery", () => true)
    const input = {
      integrationId: "example",
      providerId: "oauth",
      connectionId: "ref",
      authSessionId: "forged",
      remoteAccountId: "forged",
      label: "Forged",
    }
    try {
      expect(await api.createAccount(input)).toMatchObject({
        connectionId: "ref",
        authSessionId: "host-legacy-session",
        remoteAccountId: "host-principal",
        label: "Host account",
      })
      getConnection.mockImplementationOnce(async (ref) => {
        input.connectionId = "invisible-ref"
        return getAuthConnection(ref)
      })
      expect(await api.createAccount(input)).toMatchObject({ connectionId: "ref" })
      input.connectionId = "ref"
      await expect(api.createAccount({ ...input, providerId: "different" })).rejects.toMatchObject({
        code: "provider-mismatch",
      })
      await expect(api.createAccount({ ...input, integrationId: "missing" })).rejects.toMatchObject(
        { code: "integration-unregistered" }
      )
      await expect(api.createAccount({ ...input, connectionId: "missing" })).rejects.toMatchObject({
        code: "connection-unavailable",
      })
      await getDb().authConnections.update("ref", { status: "revoked" })
      await expect(api.createAccount(input)).rejects.toMatchObject({
        code: "connection-unavailable",
      })
      await getDb().authConnections.update("ref", {
        status: "connected",
        ownerPluginId: "unrelated",
      })
      await expect(api.createAccount(input)).rejects.toMatchObject({
        code: "connection-unavailable",
      })
    } finally {
      __resetAuthRegistryForTesting()
      jest
        .mocked(getConnectionManager)
        .mockImplementation(
          jest.requireActual("@/lib/plugin/auth/connection-manager").getConnectionManager
        )
    }
  })

  it.each([
    "approvedOrigins",
    "authSessionId",
    "providerId",
    "providerOwnerPluginId",
    "pluginId",
    "id",
    "health",
  ])(
    "rejects a forged plugin account patch for %s without applying allowed fields",
    async (key) => {
      const api = createIntegrationsAPI("example-delivery", () => true)
      const account = await api.createAccount({
        integrationId: "example",
        providerId: "oauth",
        authSessionId: "session",
        remoteAccountId: "user",
        label: "User",
      })
      const before = await getDb().integrationAccounts.get(account.id)
      await expect(
        api.updateAccount(account.id, { label: "Changed", [key]: "forged" })
      ).rejects.toThrow(/unsupported/i)
      expect(await getDb().integrationAccounts.get(account.id)).toEqual(before)
    }
  )

  it.each([null, [], "label", 1, { label: false }, { enabled: "yes" }])(
    "rejects invalid account patches without changing persistence: %j",
    async (patch) => {
      const api = createIntegrationsAPI("example-delivery", () => true)
      const account = await api.createAccount({
        integrationId: "example",
        providerId: "oauth",
        authSessionId: "session",
        remoteAccountId: "user",
        label: "User",
      })
      const before = await getDb().integrationAccounts.get(account.id)
      await expect(
        api.updateAccount(account.id, patch as unknown as Parameters<typeof api.updateAccount>[1])
      ).rejects.toThrow()
      expect(await getDb().integrationAccounts.get(account.id)).toEqual(before)
    }
  )

  it("manages only the calling plugin's accounts through opaque handles", async () => {
    const api = createIntegrationsAPI("example-delivery", () => true)
    const account = await api.createAccount({
      integrationId: "example",
      providerId: "oauth",
      authSessionId: "opaque-session-id",
      remoteAccountId: "one",
      label: "One",
    })
    const subscription = await api.createSubscription({
      integrationId: "example",
      accountId: account.id,
      eventTypes: ["issue.updated"],
    })

    expect(account.authSessionId).toBe("opaque-session-id")
    await expect(api.listAccounts()).resolves.toEqual([account])
    await expect(api.listSubscriptions()).resolves.toEqual([subscription])
    expect(api.listDefinitions().map((definition) => definition.id)).toEqual(["example"])
  })

  it("never shows or takes the account's unattended repository list (ADR-0239)", async () => {
    const api = createIntegrationsAPI("example-delivery", () => true)
    const account = await api.createAccount({
      integrationId: "example",
      providerId: "oauth",
      authSessionId: "opaque-session-id",
      remoteAccountId: "one",
      label: "One",
    })
    const listed = [
      {
        recipient: {
          kind: "repository" as const,
          channel: "github",
          recipient: "github:github.com/acme/web",
        },
        addedAt: 1,
        addedBy: "local-user" as const,
      },
    ]
    await setIntegrationAccountOutboundRecipients("example-delivery", account.id, listed)

    const [seen] = await api.listAccounts()
    expect(seen).not.toHaveProperty("outboundRecipients")
    await expect(
      api.updateAccount(account.id, {
        label: "Renamed",
        outboundRecipients: [],
      } as Parameters<typeof api.updateAccount>[1])
    ).rejects.toThrow(/unsupported.*outboundRecipients/i)
    const updated = await api.updateAccount(account.id, { label: "Renamed" })
    expect(updated).toMatchObject({ label: "Renamed" })
    expect(updated).not.toHaveProperty("outboundRecipients")
    expect((await getDb().integrationAccounts.get(account.id))?.outboundRecipients).toEqual(listed)
  })

  it("strips only the host-only field from an account", () => {
    const row = {
      id: "a",
      pluginId: "p",
      integrationId: "i",
      providerId: "o",
      authSessionId: "s",
      remoteAccountId: "r",
      label: "L",
      enabled: true,
      health: "unknown" as const,
      createdAt: "t",
      updatedAt: "t",
    }
    expect(toPluginAccount({ ...row, outboundRecipients: [] })).toEqual(row)
  })

  it.each(["typescript", "python"])(
    "rejects unknown %s account patch keys including Dexie paths",
    async (runtime) => {
      const api = createIntegrationsAPI("example-delivery", () => true)
      const account = await api.createAccount({
        integrationId: "example",
        providerId: "oauth",
        authSessionId: "opaque-session-id",
        remoteAccountId: "one",
        label: "One",
      })
      const recipients = [
        {
          recipient: {
            kind: "repository" as const,
            channel: "github",
            recipient: "github:github.com/acme/web",
          },
          addedAt: 1,
          addedBy: "local-user" as const,
        },
      ]
      await setIntegrationAccountOutboundRecipients("example-delivery", account.id, recipients)
      const patch = {
        label: "Renamed",
        "outboundRecipients.0.recipient.recipient": "github:github.com/attacker/repo",
        "settings.token": "injected",
      }
      if (runtime === "python") {
        const outcome = await routePythonHostRequest(
          {
            pluginId: "example-delivery",
            generation: "gen-1",
            requestId: 1,
            method: "integrations.updateAccount",
            params: { args: [account.id, patch] },
          },
          { getContext: () => ({ integrations: api }) as PluginContext }
        )
        expect(outcome.ok).toBe(false)
      } else {
        await expect(api.updateAccount(account.id, patch)).rejects.toThrow(/unsupported/i)
      }

      const stored = await getDb().integrationAccounts.get(account.id)
      expect(stored).toMatchObject({ label: "One", authSessionId: "opaque-session-id" })
      expect(stored?.outboundRecipients).toEqual(recipients)
      expect(stored).not.toHaveProperty("settings")
      expect(Object.keys(stored ?? {})).not.toContain("settings.token")
    }
  )

  it("discovers resources and persists normalized account health", async () => {
    const api = createIntegrationsAPI("example-delivery", () => true)
    const account = await api.createAccount({
      integrationId: "example",
      providerId: "oauth",
      authSessionId: "opaque-session-id",
      remoteAccountId: "one",
      label: "One",
    })

    await expect(
      api.listResources({ accountId: account.id, kind: "repository", query: "cognia" })
    ).resolves.toEqual({
      items: [{ kind: "repository", id: "cognia/cognia-next", name: "cognia-next" }],
      syncedAt: "2026-08-09T00:00:00.000Z",
    })
    await expect(api.checkAccountHealth(account.id)).resolves.toMatchObject({
      health: "healthy",
      grantedPermissions: ["issues:write"],
    })
    await expect(api.listAccounts()).resolves.toEqual([
      expect.objectContaining({
        id: account.id,
        health: "healthy",
        status: expect.objectContaining({ checkedAt: "2026-08-09T00:00:00.000Z" }),
      }),
    ])
  })

  it("rejects an undeclared Inbox projection", async () => {
    const api = createIntegrationsAPI("example-delivery", () => true)
    const account = await api.createAccount({
      integrationId: "example",
      providerId: "oauth",
      authSessionId: "opaque-session-id",
      remoteAccountId: "one",
      label: "One",
    })

    await expect(
      api.createSubscription({
        integrationId: "example",
        accountId: account.id,
        eventTypes: ["issue.updated"],
        inboxProjectionId: "missing",
      })
    ).rejects.toThrow("Inbox projection")
  })

  it("keeps ingress recovery behind read and manage permissions", async () => {
    const readOnly = createIntegrationsAPI(
      "example-delivery",
      (permission) => permission === "integrations:read"
    )
    await expect(readOnly.listIngressDeadletters("account-1")).resolves.toEqual([])
    await expect(
      readOnly.requeueIngressDeadletter("account-1", "route-1", "delivery-1")
    ).rejects.toThrow('requires the "integrations:manage" permission')
  })
  afterEach(() => {
    jest.restoreAllMocks()
    setIntegrationAuthenticatedRequestExecutorForTesting()
  })

  it("allows repository-scoped paginated GET through the bound provider only", async () => {
    const provider = createIntegrationsAPI("example-delivery", () => true)
    const account = await provider.createAccount({
      integrationId: "example",
      providerId: "oauth",
      authSessionId: "opaque",
      remoteAccountId: "one",
      label: "One",
    })
    jest
      .spyOn(botBinding, "resolveBotIntegrationBinding")
      .mockResolvedValue({ account, repository: "owner/repo" } as Awaited<
        ReturnType<typeof botBinding.resolveBotIntegrationBinding>
      >)
    const request = jest
      .fn()
      .mockResolvedValue({ status: 200, headers: { link: "next" }, data: [] })
    setIntegrationAuthenticatedRequestExecutorForTesting(request)
    const api = createIntegrationsAPI("bot", () => true)
    const ref = { runId: "run", slotId: "github" }
    await expect(
      api.authenticatedRequest(ref, "https://api.github.com/repos/owner/repo/issues?page=2", {
        headers: { "if-none-match": "etag" },
      })
    ).resolves.toMatchObject({ headers: { link: "next" } })
    expect(request).toHaveBeenCalledWith("example-delivery", account.id, expect.any(String), {
      headers: { "if-none-match": "etag" },
    })
    for (const url of [
      "https://api.github.com/repos/owner/other/issues",
      "https://evil.test/repos/owner/repo/issues",
      "https://api.github.com/repos/owner/repo/../other/issues",
      "https://api.github.com/repos/owner/repo/%2e%2e%2fother",
      "https://api.github.com/user/repos",
    ]) {
      await expect(api.authenticatedRequest(ref, url)).rejects.toThrow("scope")
    }
    await expect(
      api.authenticatedRequest(ref, "https://api.github.com/repos/owner/repo/issues", {
        method: "POST",
        body: "{}",
      })
    ).rejects.toThrow("read-only")
    await expect(
      api.authenticatedRequest(account.id, "https://api.github.com/repos/owner/repo/issues")
    ).rejects.toThrow("not found")
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("plans a plugin's own GitHub write before it is sent (ADR-0239 phase 2)", async () => {
    registerIntegrationDefinitions({
      pluginId: "github-delivery",
      definitions: [
        {
          id: "github",
          label: "GitHub",
          authStrategies: [],
          resourceKinds: ["repository"],
          eventTypes: [],
          actions: [],
        },
      ],
      handlers: {},
    })
    const api = createIntegrationsAPI("github-delivery", () => true)
    const account = await api.createAccount({
      integrationId: "github",
      providerId: "oauth",
      authSessionId: "opaque",
      remoteAccountId: "octocat",
      label: "GitHub",
    })
    const request = jest.fn().mockResolvedValue({ status: 201, headers: {}, data: {} })
    setIntegrationAuthenticatedRequestExecutorForTesting(request)
    const url = "https://api.github.com/repos/acme/web/issues/3/comments"
    try {
      // Shadow mode: sent, and recorded.
      await expect(
        api.authenticatedRequest(account.id, url, { method: "POST", body: "{}" })
      ).resolves.toMatchObject({ status: 201 })
      const [observed] = await getDb().actionReviewReceipts.toArray()
      expect(observed).toMatchObject({
        request: {
          subject: { kind: "integration-action", ref: "plugin:github-delivery", title: "POST" },
          plan: { outcome: "park", enforced: false },
        },
      })

      // Enforced: a write nothing authorized cannot be sent; a read still can.
      outboundSettings = {
        agentPermissions: { outboundAuthorizationByCategory: { github: "enforce" } },
      }
      await expect(
        api.authenticatedRequest(account.id, url, { method: "POST", body: "{}" })
      ).rejects.toThrow(/^outbound_held/)
      await expect(api.authenticatedRequest(account.id, url)).resolves.toMatchObject({
        status: 201,
      })
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      outboundSettings = { agentPermissions: {} }
      setIntegrationAuthenticatedRequestExecutorForTesting()
    }
  })

  it("does not expose unrelated subscriptions or resource discovery through a binding", async () => {
    const api = createIntegrationsAPI("example-delivery", () => true)
    const account = await api.createAccount({
      integrationId: "example",
      providerId: "oauth",
      authSessionId: "opaque",
      remoteAccountId: "one",
      label: "One",
    })
    const own = await api.createSubscription({
      integrationId: "example",
      accountId: account.id,
      resourceKind: "repository",
      resourceId: "cognia/cognia-next",
      eventTypes: [],
    })
    await api.createSubscription({
      integrationId: "example",
      accountId: account.id,
      resourceKind: "repository",
      resourceId: "private/other",
      eventTypes: [],
    })
    jest
      .spyOn(botBinding, "resolveBotIntegrationBinding")
      .mockResolvedValue({ account, repository: "cognia/cognia-next" } as Awaited<
        ReturnType<typeof botBinding.resolveBotIntegrationBinding>
      >)
    const bot = createIntegrationsAPI("bot", () => true)
    const ref = { runId: "run", slotId: "github" }
    await expect(bot.listSubscriptions(ref)).resolves.toEqual([own])
    await expect(bot.listResources({ accountId: ref, kind: "repository" })).resolves.toMatchObject({
      items: [{ id: "cognia/cognia-next" }],
    })
    await expect(bot.listResources({ accountId: ref, kind: "issue" })).rejects.toThrow(
      "scoped repository"
    )
    await expect(bot.checkAccountHealth(ref)).resolves.toMatchObject({ health: "healthy" })
  })
})

it("exposes only the bound GitHub actor identity and rejects broader identity routes", async () => {
  const account = { id: "account", pluginId: "github-delivery" }
  jest
    .spyOn(botBinding, "resolveBotIntegrationBinding")
    .mockResolvedValue({ account, repository: "owner/repo" } as never)
  const request = jest.fn().mockResolvedValue({
    status: 200,
    headers: {},
    data: { login: "actor", id: 3, email: "private", plan: { name: "private" } },
  })
  setIntegrationAuthenticatedRequestExecutorForTesting(request)
  const api = createIntegrationsAPI("bot", () => true)
  const ref = { runId: "run", slotId: "github" }
  expect((await api.authenticatedRequest(ref, "https://api.github.com/user")).data).toEqual({
    login: "actor",
    id: 3,
  })
  for (const url of [
    "https://api.github.com/user?extra=true",
    "https://api.github.com/user/repos",
    "https://evil.test/user",
  ])
    await expect(api.authenticatedRequest(ref, url)).rejects.toThrow("scope")
  request.mockResolvedValue({ status: 403, headers: {}, data: null })
  expect((await api.authenticatedRequest(ref, "https://api.github.com/user")).data).toEqual({})
})

it("answers an App account's identity with its bot user, which an installation token cannot ask", async () => {
  const account = {
    id: "account",
    pluginId: "github-delivery",
    providerId: "github-app",
    authSessionId: "session",
  }
  jest
    .spyOn(botBinding, "resolveBotIntegrationBinding")
    .mockResolvedValue({ account, repository: "owner/repo" } as never)
  const identity = jest.spyOn(githubAuth, "githubAppIdentity").mockResolvedValue({
    slug: "cognia-bot",
    login: "cognia-bot[bot]",
    id: 77,
    resolvedAt: 0,
  })
  const request = jest.fn()
  setIntegrationAuthenticatedRequestExecutorForTesting(request)
  const api = createIntegrationsAPI("bot", () => true)
  const ref = { runId: "run", slotId: "github" }
  expect(await api.authenticatedRequest(ref, "/user")).toEqual({
    status: 200,
    headers: {},
    data: { login: "cognia-bot[bot]", id: 77 },
  })
  expect(identity).toHaveBeenCalledWith("session")
  expect(request).not.toHaveBeenCalled()
  // Only the bare identity route is answered this way.
  await expect(api.authenticatedRequest(ref, "/user/repos")).rejects.toThrow("scope")
  identity.mockRestore()
})

it("resolves an API-root-relative path against the bound account's own deployment", async () => {
  const account = { id: "account", pluginId: "github-delivery" }
  jest
    .spyOn(botBinding, "resolveBotIntegrationBinding")
    .mockResolvedValue({ account, repository: "owner/repo" } as never)
  const request = jest.fn().mockResolvedValue({ status: 200, headers: {}, data: [] })
  setIntegrationAuthenticatedRequestExecutorForTesting(request)
  const api = createIntegrationsAPI("bot", () => true)
  const ref = { runId: "run", slotId: "github" }

  await api.authenticatedRequest(ref, "/repos/owner/repo/issues")
  expect(request).toHaveBeenLastCalledWith(
    "github-delivery",
    "account",
    "https://api.github.com/repos/owner/repo/issues",
    undefined
  )

  const base = jest
    .spyOn(actionRunner, "integrationApiBaseUrl")
    .mockResolvedValue("https://ghe.acme.io/api/v3")
  await api.authenticatedRequest(ref, "/repos/owner/repo/pulls/1")
  expect(request).toHaveBeenLastCalledWith(
    "github-delivery",
    "account",
    "https://ghe.acme.io/api/v3/repos/owner/repo/pulls/1",
    undefined
  )
  // Relative paths get the same scope checks as absolute URLs.
  for (const path of ["/repos/owner/other", "/user/repos", "//evil.test/repos/owner/repo"])
    await expect(api.authenticatedRequest(ref, path)).rejects.toThrow()
  base.mockRestore()
})

it("requires the declared permission before invoking every integration operation", async () => {
  const api = createIntegrationsAPI("denied", () => false)
  for (const method of Object.values(api)) {
    await expect(
      Promise.resolve().then(() => (method as (...args: unknown[]) => unknown)(undefined))
    ).rejects.toThrow("requires the")
  }
})

it("delegates account, publication and recovery operations with the calling plugin's identity", async () => {
  const database = await import("@/lib/db/integrations")
  const actions = await import("@/lib/integrations/action-runner")
  const ingress = await import("@/lib/integrations/ingress-client")
  const events = await import("@/lib/integrations/events")
  const migrations = await import("@/lib/integrations/migration")
  const api = createIntegrationsAPI("owner", () => true)
  try {
    const list = jest.spyOn(database, "listIntegrationAccounts").mockResolvedValue([])
    await api.listAccounts("github")
    expect(list).toHaveBeenCalledWith("owner", "github")
    const update = jest
      .spyOn(database, "updateIntegrationAccount")
      .mockResolvedValue({ id: "account" } as never)
    await api.updateAccount("account", { enabled: false })
    expect(update).toHaveBeenCalledWith("owner", "account", { enabled: false })
    const remove = jest.spyOn(ingress, "deleteIntegrationAccount").mockResolvedValue(undefined)
    await api.removeAccount("account")
    expect(remove).toHaveBeenCalledWith("owner", "account")
    const unsubscribe = jest
      .spyOn(ingress, "deleteIntegrationSubscription")
      .mockResolvedValue(undefined)
    await api.removeSubscription("subscription")
    expect(unsubscribe).toHaveBeenCalledWith("owner", "subscription")
    const publish = jest
      .spyOn(events, "publishIntegrationEvent")
      .mockResolvedValue({ inserted: false } as never)
    const event = { id: "event" } as never
    expect(await api.publishEvent(event)).toEqual({ inserted: false })
    expect(publish).toHaveBeenCalledWith("owner", event)
    const execute = jest
      .spyOn(actions, "executeIntegrationAction")
      .mockResolvedValue({ id: "job" } as never)
    const action = { actionId: "write", accountId: "account", integrationId: "github", input: {} }
    await api.executeAction(action)
    expect(execute).toHaveBeenCalledWith("owner", action)
    const job = jest
      .spyOn(database, "getIntegrationActionJob")
      .mockResolvedValue({ pluginId: "other" } as never)
    expect(await api.getActionJob("job")).toBeUndefined()
    await expect(api.cancelAction("job")).rejects.toThrow("not found")
    job.mockResolvedValue({ pluginId: "owner" } as never)
    expect(await api.getActionJob("job")).toMatchObject({ pluginId: "owner" })
    const cancel = jest
      .spyOn(actions, "cancelIntegrationActionJob")
      .mockResolvedValue({ id: "job" } as never)
    await api.cancelAction("job")
    expect(cancel).toHaveBeenCalledWith("job")
    job.mockResolvedValue({
      pluginId: "provider",
      accountId: "bound",
      botBinding: { pluginId: "owner", runId: "run", slotId: "github" },
    } as never)
    jest
      .mocked(botBinding.resolveBotIntegrationBinding)
      .mockResolvedValue({ account: { id: "bound" } } as never)
    expect(await api.getActionJob("job")).toMatchObject({ pluginId: "provider" })
    await api.cancelAction("job")
    expect(botBinding.resolveBotIntegrationBinding).toHaveBeenCalledWith(
      "owner",
      expect.objectContaining({ runId: "run" })
    )
    const subscriptions = jest.spyOn(database, "listIntegrationSubscriptions").mockResolvedValue([])
    expect(await api.getIngressPublicUrl("subscription")).toBeUndefined()
    subscriptions.mockResolvedValue([{ id: "subscription", accountId: "account" }] as never)
    const endpoint = jest
      .spyOn(database, "getIntegrationIngressEndpoint")
      .mockResolvedValue(undefined)
    expect(await api.getIngressPublicUrl("subscription")).toBeUndefined()
    endpoint.mockResolvedValue({ routeId: "route" } as never)
    const publicUrl = jest
      .spyOn(ingress, "getIntegrationIngressPublicUrl")
      .mockResolvedValue("https://host.test/route")
    expect(await api.getIngressPublicUrl("subscription")).toBe("https://host.test/route")
    expect(publicUrl).toHaveBeenCalledWith("route")
    const deadletters = jest
      .spyOn(ingress, "listIntegrationIngressDeadletters")
      .mockResolvedValue([])
    await api.listIngressDeadletters("account")
    expect(deadletters).toHaveBeenCalledWith("owner", "account")
    const deadletter = jest
      .spyOn(ingress, "getIntegrationIngressDeadletter")
      .mockResolvedValue(undefined)
    await api.getIngressDeadletter("account", "route", "delivery")
    expect(deadletter).toHaveBeenCalledWith("owner", "account", "route", "delivery")
    const replay = jest
      .spyOn(ingress, "requeueIntegrationIngressDeadletter")
      .mockResolvedValue(true)
    await api.requeueIngressDeadletter("account", "route", "delivery")
    expect(replay).toHaveBeenCalledWith("owner", "account", "route", "delivery")
    const migrate = jest
      .spyOn(migrations, "migrateLegacyIntegration")
      .mockResolvedValue({} as never)
    await api.migrateLegacy({} as never)
    expect(migrate).toHaveBeenCalledWith("owner", {})
    const rollback = jest.spyOn(migrations, "rollbackIntegrationMigration").mockResolvedValue({
      migrationId: "migration",
      conflictedIds: { accounts: [], subscriptions: [], workflows: ["edited"] },
    })
    expect(await api.rollbackMigration("migration")).toMatchObject({
      conflictedIds: { workflows: ["edited"] },
    })
    expect(rollback).toHaveBeenCalledWith("owner", "migration")
  } finally {
    jest.restoreAllMocks()
  }
})
