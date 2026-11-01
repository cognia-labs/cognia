import type {
  IntegrationAccount,
  IntegrationAuditEntry,
  IntegrationMigrationPlan,
  IntegrationMigrationResult,
  IntegrationMigrationRollbackResult,
  IntegrationSubscription,
} from "@/types/plugin/plugin-integration"
import type { WorkflowNodeKind, WorkflowRow } from "@/types/workflow/visual"
import { getDb } from "@/lib/db/schema"
import { getProvider } from "@/lib/plugin/auth/auth-provider-registry"
import {
  legacySessionAliases,
  runLegacySessionMigrations,
} from "@/lib/plugin/auth/legacy-session-migrations"
import { connectionAccess } from "@/lib/plugin/auth/connection-access"
import { getAuthConnection, type AuthConnectionRow } from "@/lib/db/auth-connections"
import { reprojectIntegrationAccountsForPlugin } from "@/lib/db/integrations"

interface MigrationBackup {
  accounts: IntegrationAccount[]
  subscriptions: IntegrationSubscription[]
  workflows: WorkflowRow[]
  createdAccountIds: string[]
  createdSubscriptionIds: string[]
}

type MigrationRevisions = {
  accounts: Record<string, string>
  subscriptions: Record<string, string>
  workflows: Record<string, number>
}

function migrationKind(migrationId: string, suffix: "backup" | "completed"): string {
  return `migration.${migrationId}.${suffix}`
}

function auditRow(
  pluginId: string,
  integrationId: string,
  kind: string,
  detail?: Record<string, unknown>
): IntegrationAuditEntry {
  return {
    id: crypto.randomUUID(),
    pluginId,
    integrationId,
    kind,
    outcome: "succeeded",
    detail,
    createdAt: new Date().toISOString(),
  }
}

function validatePlan(pluginId: string, plan: IntegrationMigrationPlan): void {
  if (!plan.id.trim() || !plan.integrationId.trim()) {
    throw new Error("Integration migration requires non-empty ids")
  }
  const accountIds = new Set<string>()
  for (const account of plan.accounts) {
    if (!account.id || accountIds.has(account.id)) {
      throw new Error(`Integration migration has duplicate account id "${account.id}"`)
    }
    if (account.integrationId !== plan.integrationId) {
      throw new Error(`Integration migration account "${account.id}" targets another integration`)
    }
    accountIds.add(account.id)
  }
  const subscriptionIds = new Set<string>()
  for (const subscription of plan.subscriptions) {
    if (!subscription.id || subscriptionIds.has(subscription.id)) {
      throw new Error(`Integration migration has duplicate subscription id "${subscription.id}"`)
    }
    if (
      subscription.integrationId !== plan.integrationId ||
      !accountIds.has(subscription.accountId)
    ) {
      throw new Error(
        `Integration migration subscription "${subscription.id}" has an invalid account`
      )
    }
    subscriptionIds.add(subscription.id)
  }
  for (const targetKind of Object.values(plan.workflowKindAliases)) {
    if (
      targetKind !== "trigger.integration.event" &&
      !targetKind.startsWith(`${pluginId}.action.`)
    ) {
      throw new Error(`Integration migration alias target "${targetKind}" is outside the plugin`)
    }
  }
}

export async function migrateLegacyIntegration(
  pluginId: string,
  plan: IntegrationMigrationPlan
): Promise<IntegrationMigrationResult> {
  validatePlan(pluginId, plan)
  if (plan.rebindLegacyConnections) return rebindLegacyConnections(pluginId, plan)
  const db = getDb()
  const completedKind = migrationKind(plan.id, "completed")
  const completed = await db.integrationAudit
    .where("pluginId")
    .equals(pluginId)
    .filter((entry) => entry.kind === completedKind)
    .first()
  if (completed) {
    return {
      migrationId: plan.id,
      migratedAccounts: plan.accounts.length,
      migratedSubscriptions: plan.subscriptions.length,
      migratedWorkflows: Number(completed.detail?.migratedWorkflows ?? 0),
      alreadyApplied: true,
    }
  }

  let migratedWorkflows = 0
  await db.transaction(
    "rw",
    [db.integrationAccounts, db.integrationSubscriptions, db.integrationAudit, db.workflows],
    async () => {
      const priorAccounts = await db.integrationAccounts
        .where("pluginId")
        .equals(pluginId)
        .toArray()
      const priorSubscriptions = await db.integrationSubscriptions
        .where("pluginId")
        .equals(pluginId)
        .toArray()
      const workflows = await db.workflows.toArray()
      const affected = workflows.filter((workflow) =>
        workflow.nodes.some((node) => plan.workflowKindAliases[node.type])
      )
      const backup: MigrationBackup = {
        accounts: priorAccounts,
        subscriptions: priorSubscriptions,
        workflows: affected,
        createdAccountIds: plan.accounts.map((account) => account.id),
        createdSubscriptionIds: plan.subscriptions.map((subscription) => subscription.id),
      }
      await db.integrationAudit.add(
        auditRow(pluginId, plan.integrationId, migrationKind(plan.id, "backup"), {
          backup,
        })
      )

      const now = new Date().toISOString()
      const ingressByAccount = new Map(
        plan.accounts.flatMap((account) => {
          const subscription = plan.subscriptions.find(
            (candidate) =>
              candidate.accountId === account.id && Boolean(candidate.ingressSecretHandle)
          )
          if (!subscription?.ingressSecretHandle) return []
          const routeId = crypto.randomUUID()
          return [
            [
              account.id,
              {
                id: crypto.randomUUID(),
                accountId: account.id,
                routeId,
                secretHandle: subscription.ingressSecretHandle,
                enabled: true,
                createdAt: now,
                updatedAt: now,
              },
            ] as const,
          ]
        })
      )
      const accounts: IntegrationAccount[] = plan.accounts.map((account) => ({
        ...account,
        providerOwnerPluginId: getProvider(account.providerId)?.pluginId,
        pluginId,
        enabled: account.enabled ?? true,
        health: "unknown",
        ingressEndpoint: ingressByAccount.get(account.id),
        createdAt: now,
        updatedAt: now,
      }))
      const subscriptions: IntegrationSubscription[] = plan.subscriptions.map((subscription) => ({
        ...subscription,
        pluginId,
        eventTypes: [...new Set(subscription.eventTypes)].sort(),
        enabled: subscription.enabled ?? true,
        ingressRouteId: ingressByAccount.get(subscription.accountId)?.routeId,
        ingressSecretHandle:
          ingressByAccount.get(subscription.accountId)?.secretHandle ??
          subscription.ingressSecretHandle,
        createdAt: now,
        updatedAt: now,
      }))
      await db.integrationAccounts.bulkPut(accounts)
      await db.integrationSubscriptions.bulkPut(subscriptions)

      const postMigration: MigrationRevisions = {
        accounts: Object.fromEntries(accounts.map((row) => [row.id, row.updatedAt])),
        subscriptions: Object.fromEntries(subscriptions.map((row) => [row.id, row.updatedAt])),
        workflows: {},
      }

      for (const workflow of affected) {
        const nodes = workflow.nodes.map((node) => {
          const target = plan.workflowKindAliases[node.type]
          return target ? { ...node, type: target as WorkflowNodeKind } : node
        })
        const updatedAt = Date.now()
        await db.workflows.put({ ...workflow, nodes, updatedAt })
        postMigration.workflows[workflow.id] = updatedAt
        migratedWorkflows += 1
      }
      if (
        (await db.integrationAccounts.bulkGet(accounts.map((account) => account.id))).filter(
          Boolean
        ).length !== accounts.length ||
        (
          await db.integrationSubscriptions.bulkGet(
            subscriptions.map((subscription) => subscription.id)
          )
        ).filter(Boolean).length !== subscriptions.length
      ) {
        throw new Error("Integration migration verification failed")
      }
      await db.integrationAudit.add(
        auditRow(pluginId, plan.integrationId, completedKind, {
          migratedAccounts: accounts.length,
          migratedSubscriptions: subscriptions.length,
          migratedWorkflows,
          postMigration,
        })
      )
    }
  )
  return {
    migrationId: plan.id,
    migratedAccounts: plan.accounts.length,
    migratedSubscriptions: plan.subscriptions.length,
    migratedWorkflows,
    alreadyApplied: false,
  }
}

/** Existing account ids own subscriptions, external refs and plugin cursor keys: never replace them. */
async function rebindLegacyConnections(
  pluginId: string,
  plan: IntegrationMigrationPlan
): Promise<IntegrationMigrationResult> {
  if (
    plan.accounts.length ||
    plan.subscriptions.length ||
    Object.keys(plan.workflowKindAliases).length
  )
    throw new Error("Connection rebinding cannot replace accounts, subscriptions or workflows")
  const db = getDb()
  const completedKind = migrationKind(plan.id, "completed")
  const ledger = () => db.integrationAudit.where("pluginId").equals(pluginId)
  const previous = await ledger()
    .filter((row) => row.kind === completedKind)
    .first()
  const result = (count: number, alreadyApplied: boolean): IntegrationMigrationResult => ({
    migrationId: plan.id,
    migratedAccounts: count,
    migratedSubscriptions: 0,
    migratedWorkflows: 0,
    alreadyApplied,
  })
  if (previous) return result(Number(previous.detail?.migratedAccounts ?? 0), true)
  const accounts = (
    await db.integrationAccounts.where("pluginId").equals(pluginId).toArray()
  ).filter((row) => row.integrationId === plan.integrationId && !row.connectionId)
  const access = connectionAccess(pluginId, () => {})
  const changes: Array<{ account: IntegrationAccount; connection: AuthConnectionRow }> = []
  const missing: IntegrationAccount[] = []
  for (const account of accounts) {
    const provider = getProvider(account.providerId)
    if (provider) await runLegacySessionMigrations(provider)
    const ref = provider
      ? (await legacySessionAliases(provider)).get(account.authSessionId)
      : undefined
    const connection = ref ? await getAuthConnection(ref) : undefined
    if (
      !connection ||
      connection.providerId !== account.providerId ||
      (account.providerOwnerPluginId !== undefined &&
        account.providerOwnerPluginId !== connection.ownerPluginId) ||
      !(await access.visible(connection, plan.rebindLegacyConnections!.service))
    ) {
      missing.push(account)
    } else changes.push({ account, connection })
  }
  let racedResult: IntegrationMigrationResult | undefined
  await db.transaction(
    "rw",
    [db.integrationAccounts, db.integrationAudit, db.authConnections, db.serviceConnections],
    async () => {
      // Recheck completion and every source row under the same write transaction.
      const raced = await ledger()
        .filter((row) => row.kind === completedKind)
        .first()
      if (raced) {
        racedResult = result(Number(raced.detail?.migratedAccounts ?? 0), true)
        return
      }
      const currentAccounts = (
        await db.integrationAccounts.where("pluginId").equals(pluginId).toArray()
      ).filter((row) => row.integrationId === plan.integrationId && !row.connectionId)
      if (currentAccounts.length !== accounts.length)
        throw new Error("Integration migration conflict: account inventory changed")
      for (const snapshot of accounts) {
        const current = await db.integrationAccounts.get(snapshot.id)
        if (JSON.stringify(current) !== JSON.stringify(snapshot))
          throw new Error("Integration migration conflict: account changed")
      }
      const now = new Date().toISOString()
      if (missing.length) {
        for (const account of missing)
          await db.integrationAccounts.put({
            ...account,
            health: "degraded",
            status: {
              health: "degraded",
              code: "legacy-connection-unmatched",
              checkedAt: now,
              recoveryAction: "reconnect",
            },
            updatedAt: now,
          })
        const kind = `migration.${plan.id}.needs-attention`
        if (
          !(await ledger()
            .filter((row) => row.kind === kind)
            .first())
        )
          await db.integrationAudit.add({
            ...auditRow(pluginId, plan.integrationId, kind, {
              accountIds: missing.map((row) => row.id),
            }),
            outcome: "failed",
          })
        return
      }
      const existing = await db.integrationAccounts.where("pluginId").equals(pluginId).toArray()
      const refs = new Set<string>()
      for (const { account, connection } of changes) {
        const current = await db.authConnections.get(connection.id)
        if (
          !current ||
          current.revision !== connection.revision ||
          current.providerId !== connection.providerId ||
          current.ownerPluginId !== connection.ownerPluginId
        )
          throw new Error("Integration migration conflict: connection changed")
        if (
          refs.has(connection.id) ||
          existing.some(
            (row) =>
              row.id !== account.id &&
              row.integrationId === plan.integrationId &&
              row.connectionId === connection.id
          )
        )
          throw new Error("Integration migration conflict: connection already bound")
        refs.add(connection.id)
      }
      const backup: MigrationBackup = {
        accounts,
        subscriptions: [],
        workflows: [],
        createdAccountIds: accounts.map((row) => row.id),
        createdSubscriptionIds: [],
      }
      await db.integrationAudit.add(
        auditRow(pluginId, plan.integrationId, migrationKind(plan.id, "backup"), { backup })
      )
      const revisions: MigrationRevisions = { accounts: {}, subscriptions: {}, workflows: {} }
      for (const { account, connection } of changes) {
        await db.integrationAccounts.put({
          ...account,
          connectionId: connection.id,
          providerOwnerPluginId: connection.ownerPluginId,
          health: "unknown",
          status: undefined,
          updatedAt: now,
        })
        revisions.accounts[account.id] = now
      }
      await reprojectIntegrationAccountsForPlugin(pluginId)
      await db.integrationAudit.add(
        auditRow(pluginId, plan.integrationId, completedKind, {
          migratedAccounts: changes.length,
          postMigration: revisions,
        })
      )
    }
  )
  return racedResult ?? result(missing.length ? 0 : changes.length, false)
}

export async function rollbackIntegrationMigration(
  pluginId: string,
  migrationId: string
): Promise<IntegrationMigrationRollbackResult> {
  const db = getDb()
  return db.transaction(
    "rw",
    [
      db.integrationAccounts,
      db.integrationSubscriptions,
      db.integrationAudit,
      db.workflows,
      db.serviceConnections,
    ],
    async () => {
      const ledger = await db.integrationAudit
        .where("pluginId")
        .equals(pluginId)
        .filter(
          (entry) =>
            entry.kind === migrationKind(migrationId, "completed") ||
            entry.kind === migrationKind(migrationId, "backup")
        )
        .toArray()
      const backupEntry = ledger.find(
        (entry) => entry.kind === migrationKind(migrationId, "backup")
      )
      const completed = ledger.find(
        (entry) => entry.kind === migrationKind(migrationId, "completed")
      )
      const backup = backupEntry?.detail?.backup as MigrationBackup | undefined
      if (!backup) throw new Error(`Integration migration "${migrationId}" has no backup`)
      const revisions = completed?.detail?.postMigration as MigrationRevisions | undefined
      const restored = (completed?.detail?.restoredIds as
        IntegrationMigrationRollbackResult["conflictedIds"] | undefined) ?? {
        accounts: [],
        subscriptions: [],
        workflows: [],
      }
      const conflictedIds: IntegrationMigrationRollbackResult["conflictedIds"] = {
        accounts: [],
        subscriptions: [],
        workflows: [],
      }

      const restore = async <T extends { id: string; updatedAt: string | number }>(
        table: import("dexie").Table<T, string>,
        kind: keyof MigrationRevisions,
        ids: string[],
        snapshots: T[]
      ) => {
        const originals = new Map(snapshots.map((row) => [row.id, row]))
        for (const id of ids) {
          if (restored[kind].includes(id)) continue
          if (
            kind === "accounts" &&
            !originals.has(id) &&
            (await db.integrationSubscriptions
              .where("accountId")
              .equals(id)
              .filter((subscription) => !restored.subscriptions.includes(subscription.id))
              .count()) > 0
          ) {
            conflictedIds.accounts.push(id)
            continue
          }
          const current = await table.get(id)
          const expectedRevision = revisions?.[kind]?.[id]
          // Missing revision evidence (old backups) and user deletions are
          // conflicts too. Never guess that an old snapshot is safe to restore.
          if (
            !current ||
            expectedRevision === undefined ||
            current.updatedAt !== expectedRevision
          ) {
            conflictedIds[kind].push(id)
            continue
          }
          const original = originals.get(id)
          if (original) await table.put(original)
          else await table.delete(id)
          restored[kind].push(id)
        }
      }
      await restore(
        db.integrationSubscriptions,
        "subscriptions",
        backup.createdSubscriptionIds,
        backup.subscriptions
      )
      await restore(db.integrationAccounts, "accounts", backup.createdAccountIds, backup.accounts)
      await restore(
        db.workflows,
        "workflows",
        backup.workflows.map((row) => row.id),
        backup.workflows
      )

      if (Object.values(conflictedIds).some((ids) => ids.length > 0)) {
        // Preserve the ledger after partial rollback, both to block re-migration
        // and to allow retry without treating already-restored rows as conflicts.
        if (completed)
          await db.integrationAudit.put({
            ...completed,
            detail: { ...completed.detail, restoredIds: restored },
          })
      } else {
        await db.integrationAudit.bulkDelete(ledger.map((entry) => entry.id))
      }
      await reprojectIntegrationAccountsForPlugin(pluginId)
      return { migrationId, conflictedIds }
    }
  )
}
