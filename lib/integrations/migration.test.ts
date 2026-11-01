/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { WorkflowNodeKind } from "@/types/workflow/visual"
import { migrateLegacyIntegration, rollbackIntegrationMigration } from "./migration"
import { pruneIntegrationRetention } from "@/lib/db/integrations"
import { getPlugin } from "@/lib/db/plugins"
import { registerLegacySessionMigration } from "@/lib/plugin/auth/legacy-session-migrations"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
jest.mock("@/lib/db/plugins", () => ({ getPlugin: jest.fn() }))
import {
  getProvider,
  registerAuthenticationProvider,
  releaseAuthProviderOwnership,
} from "@/lib/plugin/auth/auth-provider-registry"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("legacy connection rebinding", () => {
  const plan = {
    id: "calendar-connection-v1",
    integrationId: "calendar",
    accounts: [],
    subscriptions: [],
    workflowKindAliases: {},
    rebindLegacyConnections: { service: "auth.calendar" },
  }
  async function setup(matched = true, concurrentEdit = false) {
    const db = getDb()
    const ref = "calendar-ref" as AuthConnectionRef
    const account = {
      id: "old-account",
      pluginId: "calendar-consumer",
      integrationId: "calendar",
      providerId: "calendar-legacy",
      providerOwnerPluginId: "calendar-owner",
      authSessionId: "old-session",
      remoteAccountId: "remote",
      label: "Calendar",
      enabled: true,
      health: "healthy" as const,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    }
    await db.integrationAccounts.put(account)
    const subscription = {
      id: "old-subscription",
      pluginId: "calendar-consumer",
      integrationId: "calendar",
      accountId: account.id,
      resourceKind: "calendar",
      resourceId: "cal",
      eventTypes: ["updated"],
      enabled: true,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    }
    await db.integrationSubscriptions.put(subscription)
    const issue = {
      id: "linked-issue",
      identifier: "CAL-1",
      externalRefs: [
        { provider: "calendar", externalId: "event", meta: { accountId: account.id } },
      ],
    }
    await db.issues.put(issue as never)
    await db.authConnections.put({
      id: ref,
      providerId: account.providerId,
      ownerPluginId: "calendar-owner",
      publisher: null,
      contractMajor: 1,
      issuer: "https://accounts.feishu.cn",
      clientId: "app",
      principalId: "remote",
      principalKind: "user",
      accountLabel: "Calendar",
      scopes: [],
      revision: 1,
      credentialRevision: 1,
      lineageId: "lineage",
      identityKey: "identity",
      legacySessionId: "old-session",
      status: "connected",
      createdAt: 1,
      updatedAt: 1,
    })
    jest.mocked(getPlugin).mockImplementation(
      async (id) =>
        ({
          manifest:
            id === "calendar-owner"
              ? { providesServices: { "auth.calendar": "1.0.0" } }
              : { requiresServices: { "auth.calendar": "^1.0.0" } },
        }) as never
    )
    const disposeProvider = registerAuthenticationProvider({
      id: account.providerId,
      pluginId: "calendar-owner",
      label: "Calendar",
      getSessions: async () => [],
      createSession: async () => {
        throw new Error("unused")
      },
      removeSession: async () => {},
    })
    const disposeMigration = registerLegacySessionMigration("calendar-owner", account.providerId, {
      migrate: async () => {},
      aliases: async () => {
        if (concurrentEdit) await db.integrationAccounts.update(account.id, { label: "User edit" })
        return matched ? new Map([["old-session", ref]]) : new Map()
      },
    })
    return {
      db,
      ref,
      account,
      subscription,
      issue,
      dispose: () => {
        disposeMigration()
        disposeProvider()
        releaseAuthProviderOwnership("calendar-owner")
      },
    }
  }

  it("rebinds once through the alias ledger, preserving subscriptions and external refs, and rolls back", async () => {
    const f = await setup()
    try {
      expect(await migrateLegacyIntegration("calendar-consumer", plan)).toMatchObject({
        migratedAccounts: 1,
        alreadyApplied: false,
      })
      expect(await f.db.integrationAccounts.get(f.account.id)).toMatchObject({
        ...f.account,
        connectionId: f.ref,
        health: "unknown",
        updatedAt: expect.any(String),
      })
      expect(await f.db.integrationSubscriptions.get(f.subscription.id)).toEqual(f.subscription)
      expect(await f.db.issues.get(f.issue.id)).toEqual(f.issue)
      expect(await migrateLegacyIntegration("calendar-consumer", plan)).toMatchObject({
        alreadyApplied: true,
      })
      expect(
        (await f.db.integrationAudit.toArray()).filter((row) => row.kind.endsWith(".backup"))
      ).toHaveLength(1)
      expect(await rollbackIntegrationMigration("calendar-consumer", plan.id)).toMatchObject({
        conflictedIds: { accounts: [], subscriptions: [], workflows: [] },
      })
      expect(await f.db.integrationAccounts.get(f.account.id)).toEqual(f.account)
      expect(await f.db.integrationSubscriptions.get(f.subscription.id)).toEqual(f.subscription)
    } finally {
      f.dispose()
    }
  })

  it("records needs-attention without inventing a connection or dropping any data", async () => {
    const f = await setup(false)
    try {
      expect(await migrateLegacyIntegration("calendar-consumer", plan)).toMatchObject({
        migratedAccounts: 0,
      })
      expect(await f.db.integrationAccounts.get(f.account.id)).toMatchObject({
        authSessionId: "old-session",
        status: { code: "legacy-connection-unmatched", recoveryAction: "reconnect" },
      })
      expect(await f.db.integrationAccounts.get(f.account.id)).not.toHaveProperty("connectionId")
      expect(await f.db.integrationSubscriptions.get(f.subscription.id)).toEqual(f.subscription)
      expect(await f.db.issues.get(f.issue.id)).toEqual(f.issue)
      expect(
        (await f.db.integrationAudit.toArray()).some((row) => row.kind.endsWith("needs-attention"))
      ).toBe(true)
      expect(
        (await f.db.integrationAudit.toArray()).some((row) => row.kind.endsWith("completed"))
      ).toBe(false)
    } finally {
      f.dispose()
    }
  })

  it.each(["concurrent-edit", "duplicate-connection"])(
    "rolls back all migration work on %s conflict",
    async (mode) => {
      const f = await setup(true, mode === "concurrent-edit")
      try {
        if (mode === "duplicate-connection")
          await f.db.integrationAccounts.put({
            ...f.account,
            id: "other-account",
            connectionId: f.ref,
            remoteAccountId: "other",
          })
        await expect(migrateLegacyIntegration("calendar-consumer", plan)).rejects.toThrow(
          "migration conflict"
        )
        expect(await f.db.integrationAccounts.get(f.account.id)).not.toHaveProperty("connectionId")
        if (mode === "concurrent-edit")
          expect((await f.db.integrationAccounts.get(f.account.id))?.label).toBe("User edit")
        expect(await f.db.integrationSubscriptions.get(f.subscription.id)).toEqual(f.subscription)
        expect(await f.db.integrationAudit.count()).toBe(0)
      } finally {
        f.dispose()
      }
    }
  )
})

it.each(["migration-provider-owner", null, undefined])(
  "stamps migrated accounts with the live provider owner %s",
  async (owner) => {
    const providerId = "migration-owner-provider"
    const dispose =
      owner === undefined
        ? undefined
        : registerAuthenticationProvider({
            id: providerId,
            pluginId: owner,
            label: "Migration provider",
            getSessions: async () => [],
            createSession: async () => {
              throw new Error("not used")
            },
            removeSession: async () => undefined,
          })
    try {
      if (owner === undefined) expect(getProvider(providerId)).toBeUndefined()
      await migrateLegacyIntegration("migration-consumer", {
        id: "provider-owner",
        integrationId: "example",
        accounts: [
          {
            id: "migrated-account",
            integrationId: "example",
            providerId,
            authSessionId: "opaque",
            remoteAccountId: "remote",
            label: "Migrated account",
          },
        ],
        subscriptions: [],
        workflowKindAliases: {},
      })
      const account = await getDb().integrationAccounts.get("migrated-account")
      expect(account).toBeDefined()
      expect(account?.providerOwnerPluginId).toBe(owner)
    } finally {
      dispose?.()
      if (owner) releaseAuthProviderOwnership(owner)
    }
  }
)

it("migrates accounts, subscriptions, and workflow aliases transactionally and idempotently", async () => {
  const db = getDb()
  await db.workflows.add({
    id: "wf-legacy",
    schemaVersion: 2,
    name: "Legacy",
    nodes: [
      {
        id: "trigger",
        type: "trigger.test.legacy" as WorkflowNodeKind,
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Legacy trigger", params: {} },
      },
    ],
    edges: [],
    settings: {} as never,
    createdAt: 1,
    updatedAt: 1,
  })
  const plan = {
    id: "github-v4",
    integrationId: "github",
    accounts: [
      {
        id: "github-account",
        integrationId: "github",
        providerId: "github-pat",
        authSessionId: "opaque",
        remoteAccountId: "octocat",
        label: "GitHub",
      },
    ],
    subscriptions: [
      {
        id: "github-subscription",
        integrationId: "github",
        accountId: "github-account",
        resourceKind: "repository",
        resourceId: "cognia/cognia-next",
        eventTypes: ["pull_request.opened"],
        ingressSecretHandle: "legacy-secret-handle",
      },
    ],
    workflowKindAliases: {
      "trigger.test.legacy": "trigger.integration.event",
    },
  }

  await expect(migrateLegacyIntegration("github-delivery", plan)).resolves.toMatchObject({
    migratedAccounts: 1,
    migratedSubscriptions: 1,
    migratedWorkflows: 1,
    alreadyApplied: false,
  })
  await expect(migrateLegacyIntegration("github-delivery", plan)).resolves.toMatchObject({
    alreadyApplied: true,
  })
  expect((await db.workflows.get("wf-legacy"))?.nodes[0].type).toBe("trigger.integration.event")
  const migratedAccount = await db.integrationAccounts.get("github-account")
  const migratedSubscription = await db.integrationSubscriptions.get("github-subscription")
  expect(migratedAccount?.authSessionId).toBe("opaque")
  expect(migratedAccount?.providerId).toBe("github-pat")
  expect(migratedAccount?.ingressEndpoint).toBeDefined()
  expect(migratedAccount?.ingressEndpoint?.routeId).toBe(migratedSubscription?.ingressRouteId)
  await pruneIntegrationRetention(Date.now() + 100 * 24 * 60 * 60 * 1000)
  await expect(migrateLegacyIntegration("github-delivery", plan)).resolves.toMatchObject({
    alreadyApplied: true,
  })
  await expect(rollbackIntegrationMigration("github-delivery", plan.id)).resolves.toMatchObject({
    conflictedIds: { accounts: [], subscriptions: [], workflows: [] },
  })
})

it("restores the original workflow and Integration rows from the transaction backup", async () => {
  const db = getDb()
  await db.workflows.add({
    id: "wf-legacy",
    schemaVersion: 2,
    name: "Legacy",
    nodes: [
      {
        id: "action",
        type: "action.test.legacy" as WorkflowNodeKind,
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Legacy action", params: {} },
      },
    ],
    edges: [],
    settings: {} as never,
    createdAt: 1,
    updatedAt: 1,
  })
  await migrateLegacyIntegration("github-delivery", {
    id: "github-v4",
    integrationId: "github",
    accounts: [
      {
        id: "account",
        integrationId: "github",
        providerId: "github-pat",
        authSessionId: "opaque",
        remoteAccountId: "octocat",
        label: "GitHub",
      },
    ],
    subscriptions: [],
    workflowKindAliases: {
      "action.test.legacy": "github-delivery.action.openPr",
    },
  })
  await rollbackIntegrationMigration("github-delivery", "github-v4")
  expect((await db.workflows.get("wf-legacy"))?.nodes[0].type).toBe("action.test.legacy")
  expect(await db.integrationAccounts.count()).toBe(0)
})

it("preserves edited rows and reports conflicts while restoring the remaining snapshots", async () => {
  const db = getDb()
  const workflow = {
    id: "unchanged",
    schemaVersion: 2 as const,
    name: "Legacy",
    nodes: [
      {
        id: "action",
        type: "action.test.legacy" as WorkflowNodeKind,
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Legacy", params: {} },
      },
    ],
    edges: [],
    settings: {} as never,
    createdAt: 1,
    updatedAt: 1,
  }
  await db.workflows.bulkAdd([workflow, { ...workflow, id: "edited" }])
  const account = {
    id: "account",
    integrationId: "github",
    providerId: "github-pat",
    authSessionId: "opaque",
    remoteAccountId: "octocat",
    label: "Original",
  }
  const subscription = {
    id: "subscription",
    integrationId: "github",
    accountId: "account",
    resourceKind: "repository",
    resourceId: "repo",
    eventTypes: ["opened"],
  }
  await migrateLegacyIntegration("owner", {
    id: "legacy",
    integrationId: "github",
    accounts: [account],
    subscriptions: [subscription],
    workflowKindAliases: { "action.test.legacy": "owner.action.new" },
  })
  await db.workflows.update("edited", { name: "User edit", updatedAt: Date.now() + 1 })
  await db.integrationAccounts.update("account", { label: "User account", updatedAt: "later" })
  await db.integrationSubscriptions.update("subscription", { enabled: false, updatedAt: "later" })
  const result = await rollbackIntegrationMigration("owner", "legacy")
  expect(result.conflictedIds).toEqual({
    accounts: ["account"],
    subscriptions: ["subscription"],
    workflows: ["edited"],
  })
  expect(await db.workflows.get("edited")).toMatchObject({ name: "User edit" })
  expect((await db.workflows.get("unchanged"))?.nodes[0].type).toBe("action.test.legacy")
  expect(await db.integrationAccounts.get("account")).toMatchObject({ label: "User account" })
  expect(await db.integrationSubscriptions.get("subscription")).toMatchObject({ enabled: false })
  // Conflicted migrations keep their ledger so a re-run cannot overwrite user edits.
  expect(await db.integrationAudit.count()).toBe(2)
  expect((await rollbackIntegrationMigration("owner", "legacy")).conflictedIds).toEqual(
    result.conflictedIds
  )
})

it("review regression: preserves the account referenced by a conflicted subscription", async () => {
  const db = getDb()
  await migrateLegacyIntegration("owner", {
    id: "kept-reference",
    integrationId: "example",
    accounts: [
      {
        id: "account",
        integrationId: "example",
        providerId: "oauth",
        authSessionId: "session",
        remoteAccountId: "user",
        label: "User",
      },
    ],
    subscriptions: [
      { id: "subscription", integrationId: "example", accountId: "account", eventTypes: [] },
    ],
    workflowKindAliases: {},
  })
  await db.integrationSubscriptions.update("subscription", {
    enabled: false,
    updatedAt: "user-edit",
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await rollbackIntegrationMigration("owner", "kept-reference")).conflictedIds).toEqual({
      accounts: ["account"],
      subscriptions: ["subscription"],
      workflows: [],
    })
    expect(await db.integrationAccounts.get("account")).toBeDefined()
    expect(await db.integrationSubscriptions.get("subscription")).toMatchObject({
      accountId: "account",
      enabled: false,
    })
  }
})

it("restores existing account and subscription snapshots without rewriting unrelated rows", async () => {
  const db = getDb()
  const account = {
    id: "account",
    pluginId: "owner",
    integrationId: "example",
    providerId: "oauth",
    authSessionId: "old-session",
    remoteAccountId: "remote",
    label: "Before",
    enabled: true,
    health: "unknown" as const,
    createdAt: "before",
    updatedAt: "before",
  }
  const subscription = {
    id: "subscription",
    pluginId: "owner",
    integrationId: "example",
    accountId: account.id,
    resourceKind: "repo",
    resourceId: "old",
    eventTypes: ["old"],
    enabled: true,
    createdAt: "before",
    updatedAt: "before",
  }
  await db.integrationAccounts.bulkPut([
    account,
    { ...account, id: "unrelated", remoteAccountId: "other" },
  ])
  await db.integrationSubscriptions.put(subscription)
  await migrateLegacyIntegration("owner", {
    id: "existing",
    integrationId: "example",
    accounts: [{ ...account, label: "Migrated" }],
    subscriptions: [{ ...subscription, resourceId: "new" }],
    workflowKindAliases: {},
  })
  await db.integrationAccounts.update("unrelated", { label: "Edited unrelated row" })
  expect((await rollbackIntegrationMigration("owner", "existing")).conflictedIds).toEqual({
    accounts: [],
    subscriptions: [],
    workflows: [],
  })
  expect(await db.integrationAccounts.get(account.id)).toEqual(account)
  expect(await db.integrationSubscriptions.get(subscription.id)).toEqual(subscription)
  expect(await db.integrationAccounts.get("unrelated")).toMatchObject({
    label: "Edited unrelated row",
  })
})

it("preserves deleted rows and handles legacy backups without revision evidence conservatively", async () => {
  const db = getDb()
  await migrateLegacyIntegration("owner", {
    id: "legacy-ledger",
    integrationId: "example",
    accounts: [
      {
        id: "account",
        integrationId: "example",
        providerId: "oauth",
        authSessionId: "session",
        remoteAccountId: "remote",
        label: "User",
      },
    ],
    subscriptions: [],
    workflowKindAliases: {},
  })
  const completed = await db.integrationAudit
    .filter((row) => row.kind.endsWith(".completed"))
    .first()
  await db.integrationAudit.update(completed!.id, { detail: {} })
  expect(
    (await rollbackIntegrationMigration("owner", "legacy-ledger")).conflictedIds.accounts
  ).toEqual(["account"])
  expect(await db.integrationAccounts.get("account")).toBeDefined()
  await db.integrationAccounts.delete("account")
  expect(
    (await rollbackIntegrationMigration("owner", "legacy-ledger")).conflictedIds.accounts
  ).toEqual(["account"])
  expect(await db.integrationAccounts.get("account")).toBeUndefined()
})
