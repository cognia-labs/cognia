/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createIntegrationAccount, getIntegrationAccount } from "@/lib/db/integrations"
import { __resetIntegrationRegistryForTesting, registerIntegrationDefinitions } from "./registry"
import { checkIntegrationAccountHealth, listIntegrationResources } from "./providers"
import { setIntegrationAuthenticatedRequestExecutorForTesting } from "./action-runner"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
import { HOST_BACKGROUND, pluginExecutionContext } from "@/lib/plugin/core/invocation-identity"

describe("Integration resource and health providers", () => {
  afterEach(() => setIntegrationAuthenticatedRequestExecutorForTesting())
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetIntegrationRegistryForTesting()
  })

  it("keeps a missing migration connection's needs-attention reason without attempting a provider read", async () => {
    const account = {
      id: "unmatched",
      pluginId: "calendar",
      integrationId: "calendar",
      providerId: "legacy",
      authSessionId: "old",
      remoteAccountId: "remote",
      label: "Calendar",
      enabled: true,
      health: "degraded" as const,
      status: {
        health: "degraded" as const,
        code: "legacy-connection-unmatched",
        checkedAt: "2026-11-01T00:00:00.000Z",
        recoveryAction: "reconnect" as const,
      },
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    }
    await getDb().integrationAccounts.put(account)
    expect(await checkIntegrationAccountHealth("calendar", account.id)).toEqual(account.status)
  })

  it.each([
    ["Host person", { localAuthorization: LOCAL_PERSON_RUN }, undefined],
    ["executing run", { sessionId: "session", executionRunId: "run" }, undefined],
    ["unproven plugin", undefined, undefined],
    ["verified Bot binding", undefined, { pluginId: "github-delivery", accountId: "bound" }],
  ] as const)(
    "preserves %s admission through discovery and health requests",
    async (_label, context, binding) => {
      const request = jest.fn().mockResolvedValue({ status: 200, headers: {}, data: {} })
      setIntegrationAuthenticatedRequestExecutorForTesting(request)
      registerIntegrationDefinitions({
        pluginId: "github-delivery",
        definitions: [
          {
            id: "github",
            label: "GitHub",
            authStrategies: [],
            resourceKinds: ["repository"],
            resourceProvider: { handler: "resources", kinds: ["repository"] },
            healthProvider: { handler: "health" },
            eventTypes: [],
            actions: [],
          },
        ],
        handlers: {},
        resourceProviders: {
          github: async (_query, ctx) => {
            expect(pluginExecutionContext("github-delivery")).toEqual(context ?? HOST_BACKGROUND)
            await ctx.authenticatedRequest("https://api.github.com/user/repos")
            return { items: [], syncedAt: "2026-11-01T00:00:00.000Z" }
          },
        },
        accountStatusProviders: {
          github: async (ctx) => {
            expect(pluginExecutionContext("github-delivery")).toEqual(context ?? HOST_BACKGROUND)
            await ctx.authenticatedRequest("https://api.github.com/user")
            return { health: "healthy", checkedAt: "2026-11-01T00:00:00.000Z" }
          },
        },
      })
      const account = await createIntegrationAccount("github-delivery", {
        integrationId: "github",
        providerId: "github-pat",
        authSessionId: "session",
        remoteAccountId: "owner",
        label: "GitHub",
      })
      const verified = binding && { ...binding, accountId: account.id }
      await listIntegrationResources(
        "github-delivery",
        { accountId: account.id, kind: "repository" },
        context as PersonalCredentialContext | undefined,
        verified
      )
      await checkIntegrationAccountHealth(
        "github-delivery",
        account.id,
        context as PersonalCredentialContext | undefined,
        verified
      )
      expect(request).toHaveBeenCalledTimes(2)
      for (const call of request.mock.calls) {
        expect(call).toEqual([
          "github-delivery",
          account.id,
          expect.any(String),
          expect.objectContaining({
            credentialContext: context ?? HOST_BACKGROUND,
            verifiedBotAccount: verified,
          }),
        ])
      }
    }
  )

  it("bounds discovery pages and persists normalized health state", async () => {
    const resourceProvider = jest.fn(async () => ({
      items: [{ kind: "repository", id: "cognia/app", name: "cognia/app" }],
      syncedAt: "2026-08-09T00:00:00.000Z",
    }))
    registerIntegrationDefinitions({
      pluginId: "github-delivery",
      definitions: [
        {
          id: "github",
          label: "GitHub",
          authStrategies: [],
          resourceKinds: ["repository"],
          resourceProvider: { handler: "resources", kinds: ["repository"] },
          healthProvider: { handler: "health" },
          eventTypes: [],
          actions: [],
        },
      ],
      handlers: {},
      resourceProviders: { github: resourceProvider },
      accountStatusProviders: {
        github: async () => ({
          health: "degraded",
          checkedAt: "2026-08-09T00:00:00.000Z",
          requiredPermissions: ["issues:write", "contents:write", "issues:write"],
          grantedPermissions: ["contents:write"],
        }),
      },
    })
    const account = await createIntegrationAccount("github-delivery", {
      integrationId: "github",
      providerId: "github-app",
      authSessionId: "session",
      remoteAccountId: "42",
      label: "GitHub",
    })

    await listIntegrationResources("github-delivery", {
      accountId: account.id,
      kind: "repository",
      limit: 1000,
    })
    expect(resourceProvider).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
      expect.any(Object)
    )

    await checkIntegrationAccountHealth("github-delivery", account.id)
    expect(await getIntegrationAccount("github-delivery", account.id)).toMatchObject({
      health: "degraded",
      status: {
        requiredPermissions: ["contents:write", "issues:write"],
        grantedPermissions: ["contents:write"],
      },
    })
  })

  it("rejects missing accounts and unavailable providers", async () => {
    await expect(
      listIntegrationResources("github-delivery", {
        accountId: "missing",
        kind: "repository",
      })
    ).rejects.toThrow("was not found")

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
    const account = await createIntegrationAccount("github-delivery", {
      integrationId: "github",
      providerId: "github-pat",
      authSessionId: "session",
      remoteAccountId: "octocat",
      label: "GitHub",
    })

    await expect(
      listIntegrationResources("github-delivery", {
        accountId: account.id,
        kind: "repository",
      })
    ).rejects.toThrow("does not provide resource discovery")
    await expect(checkIntegrationAccountHealth("github-delivery", account.id)).rejects.toThrow(
      "does not provide health checks"
    )
  })

  it("validates kinds, provider output, and lower/default page bounds", async () => {
    const resourceProvider = jest
      .fn()
      .mockResolvedValueOnce({ items: [], syncedAt: "2026-08-09T00:00:00.000Z" })
      .mockResolvedValueOnce({
        items: [{ kind: "installation", id: "42", name: "octocat" }],
        syncedAt: "2026-08-09T00:00:00.000Z",
      })
    registerIntegrationDefinitions({
      pluginId: "github-delivery",
      definitions: [
        {
          id: "github",
          label: "GitHub",
          authStrategies: [],
          resourceKinds: ["repository"],
          resourceProvider: { handler: "resources", kinds: ["repository"] },
          eventTypes: [],
          actions: [],
        },
      ],
      handlers: {},
      resourceProviders: { github: resourceProvider },
    })
    const account = await createIntegrationAccount("github-delivery", {
      integrationId: "github",
      providerId: "github-app",
      authSessionId: "session",
      remoteAccountId: "42",
      label: "GitHub",
    })

    await listIntegrationResources("github-delivery", {
      accountId: account.id,
      kind: "repository",
      limit: -10,
    })
    expect(resourceProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 1 }),
      expect.any(Object)
    )

    await expect(
      listIntegrationResources("github-delivery", {
        accountId: account.id,
        kind: "repository",
      })
    ).rejects.toThrow("unexpected resource kind")
    expect(resourceProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 50 }),
      expect.any(Object)
    )

    await expect(
      listIntegrationResources("github-delivery", {
        accountId: account.id,
        kind: "installation",
      })
    ).rejects.toThrow('resource kind "installation" is not discoverable')
  })
})
