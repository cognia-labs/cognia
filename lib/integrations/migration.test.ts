/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { WorkflowNodeKind } from "@/types/workflow/visual"
import { migrateLegacyIntegration, rollbackIntegrationMigration } from "./migration"
import { pruneIntegrationRetention } from "@/lib/db/integrations"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

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
