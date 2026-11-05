/**
 * Plugin Issues API (spec 2026-09-06 D9): `ctx.issues`.
 *
 * Reads and writes go through `lib/issues/service.ts`, the same face the
 * board's bulk menu, the /issue command, the workflow nodes and the External
 * Bridge use, so a plugin is refused the same moves for the same reasons and
 * every write lands in the trail with a plugin actor. Subscriptions ride
 * `lib/issues/event-bus.ts`, which publishes after each trail write commits.
 * A plugin that speaks to another tracker registers an `IssueSyncProvider`,
 * and the engine (`lib/issues/sync/engine.ts`) pulls and pushes through it
 * exactly as it does for the built-in GitHub and Lark providers.
 *
 * Gated by `issue:read` (reads, subscriptions) and `issue:write` (mutations,
 * sync-provider registration).
 */

import { listIssueEvents } from "@/lib/db/issue-events"
import {
  bindPluginCallbacks,
  HOST_BACKGROUND,
  withPluginExecutionContext,
} from "../core/invocation-identity"
import { onIssueEvent } from "@/lib/issues/event-bus"
import {
  applyIssueAction,
  createIssueRecord,
  parseIssueAction,
  isIssuePriority,
  isIssueStage,
  isIssueStatus,
  isIssueTriageState,
  queryIssues,
  resolveIssue,
  toIssueWire,
  type IssueBulkAction,
  type IssueBulkOutcome,
} from "@/lib/issues/service"
import { registerIssueSyncProvider } from "@/lib/issues/sync/registry"
import { ensureIssueLabels } from "@/lib/issues/sync/apply"
import { createGuardedAPI, getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import type { PluginManifest } from "@/types/plugin"
import type { PluginIssueSyncProviderDef, IssueSyncProvider } from "@/lib/issues/sync/types"
import {
  assertPortableIssueSyncConfig,
  validatePluginIssueSyncProviderDef,
} from "@cognia/plugin-contract/lib/issues/sync/resources"
import { ISSUE_STAGE_MAX, type IssueActor } from "@/types/issues"
import type { PluginIssuesAPI } from "@cognia/plugin-contract/lib/plugin/api/issues-api"
import { assertSyncConnection } from "./sync-api"
import { getAuthConnection } from "@/lib/db/auth-connections"
import { getRemoteDocumentConnection } from "@/lib/db/remote-document-connections"
import { resolveIssueSyncSource } from "@/lib/issues/sync/kept-copy-source"
export type {
  PluginIssueCreateInput,
  PluginIssueEventOptions,
  PluginIssueQuery,
  PluginIssueUpdatePatch,
  PluginIssuesAPI,
} from "@cognia/plugin-contract/lib/plugin/api/issues-api"

/** The actor stamped on everything a plugin writes. */
export function pluginIssueActor(pluginId: string): IssueActor {
  return { kind: "agent", id: `plugin:${pluginId}`, label: pluginId }
}

async function requireIssue(ref: string) {
  const issue = await resolveIssue(ref)
  if (!issue) throw new Error(`No issue matches '${ref}'`)
  return issue
}

const declarations = new Map<string, readonly PluginIssueSyncProviderDef[]>()
const registrations = new Map<string, Set<() => void>>()
const activations = new Map<string, symbol>()

export function registerIssueSyncProviderDeclarationsForPlugin(
  manifest: Pick<PluginManifest, "id" | "issueSyncProviders">
): void {
  const defs = manifest.issueSyncProviders ?? []
  const ids = new Set<string>()
  for (const def of defs) {
    const errors = validatePluginIssueSyncProviderDef(def)
    if (errors.length) throw new Error(errors.join("; "))
    if (ids.has(def.id)) throw new Error("Duplicate issue-sync provider declaration")
    ids.add(def.id)
  }
  declarations.set(
    manifest.id,
    defs.map((def) => ({ ...def }))
  )
}

export function clearIssueSyncProvidersForPlugin(pluginId: string): void {
  activations.delete(pluginId)
  declarations.delete(pluginId)
  for (const dispose of [...(registrations.get(pluginId) ?? [])]) dispose()
  registrations.delete(pluginId)
}

export function createIssuesAPI(
  pluginId: string,
  manifest?: Pick<PluginManifest, "id" | "issueSyncProviders">
): PluginIssuesAPI {
  clearIssueSyncProvidersForPlugin(pluginId)
  registerIssueSyncProviderDeclarationsForPlugin({
    id: pluginId,
    issueSyncProviders: manifest?.issueSyncProviders,
  })
  const activation = Symbol(pluginId)
  activations.set(pluginId, activation)
  const by = pluginIssueActor(pluginId)

  async function apply(
    ref: string,
    actions: readonly IssueBulkAction[]
  ): Promise<IssueBulkOutcome> {
    // Plugin code is not type-checked against this host: every action is
    // checked before any of them applies, so a malformed one writes nothing.
    const checked = actions.map((action) => parseIssueAction(action))
    const issue = await requireIssue(ref)
    let applied = 0
    let skipped = 0
    let failed = 0
    let reason: IssueBulkOutcome["reason"]
    for (const action of checked) {
      const outcome = await applyIssueAction(issue, action, by)
      applied += outcome.applied
      skipped += outcome.skipped
      failed += outcome.failed
      reason ??= outcome.reason
    }
    return { applied, skipped, failed, ...(reason ? { reason } : {}) }
  }

  const api: PluginIssuesAPI = {
    get: async (ref) => {
      const issue = await resolveIssue(ref)
      return issue ? toIssueWire(issue) : null
    },
    list: async (query = {}) => (await queryIssues(query)).map(toIssueWire),
    listEvents: async (ref, limit = 100) => {
      const issue = await requireIssue(ref)
      return listIssueEvents({ issueId: issue.id, descending: true, limit })
    },
    create: async (input) => toIssueWire(await createIssueRecord({ ...input, by })),
    update: async (ref, patch) => {
      const actions: IssueBulkAction[] = []
      if (typeof patch.title === "string" && patch.title.trim()) {
        actions.push({ kind: "title", to: patch.title.trim() })
      }
      if (typeof patch.description === "string") {
        actions.push({ kind: "description", to: patch.description })
      }
      if (patch.status !== undefined) {
        if (!isIssueStatus(patch.status)) throw new Error(`Unknown status '${patch.status}'`)
        actions.push({ kind: "status", to: patch.status })
      }
      if (patch.priority !== undefined) {
        if (!isIssuePriority(patch.priority))
          throw new Error(`Unknown priority '${patch.priority}'`)
        actions.push({ kind: "priority", to: patch.priority })
      }
      if (patch.dueDate !== undefined) actions.push({ kind: "dueDate", to: patch.dueDate })
      if (patch.estimate !== undefined) actions.push({ kind: "estimate", to: patch.estimate })
      if (patch.cycleId !== undefined) actions.push({ kind: "cycle", cycleId: patch.cycleId })
      if (patch.stage !== undefined) {
        if (patch.stage !== null && !isIssueStage(patch.stage))
          throw new Error(`Stage must be an integer from 1 to ${ISSUE_STAGE_MAX}`)
        actions.push({ kind: "stage", to: patch.stage })
      }
      if (patch.triage !== undefined) {
        if (patch.triage !== null && !isIssueTriageState(patch.triage))
          throw new Error(`Unknown triage state '${String(patch.triage)}'`)
        actions.push({ kind: "triage", to: patch.triage })
      }
      if (actions.length === 0) throw new Error("Nothing to change")
      return apply(ref, actions)
    },
    assign: (ref, assignee) => apply(ref, [{ kind: "assignee", to: assignee }]),
    comment: (ref, body) => {
      const trimmed = body.trim()
      if (!trimmed) throw new Error("Comment body is required")
      return apply(ref, [{ kind: "comment", body: trimmed }])
    },
    label: async (ref, change) => {
      const actions: IssueBulkAction[] = []
      for (const row of await ensureIssueLabels(change.add ?? [])) {
        actions.push({ kind: "addLabel", labelId: row.id })
      }
      if (change.remove?.length) {
        const { listLabels } = await import("@/lib/db/labels")
        const wanted = new Set(change.remove.map((name) => name.trim().toLowerCase()))
        for (const row of await listLabels("issue")) {
          if (wanted.has(row.name.toLowerCase()))
            actions.push({ kind: "removeLabel", labelId: row.id })
        }
      }
      if (actions.length === 0) throw new Error("Give label names to add or remove")
      return apply(ref, actions)
    },
    onEvent: (handler, options) => onIssueEvent(bindPluginCallbacks(pluginId, handler), options),
    registerSyncProvider: (provider) => {
      if (!provider?.id?.trim()) throw new Error("A sync provider needs an id")
      const def = declarations.get(pluginId)?.find((entry) => entry.id === provider.id)
      if (!def)
        throw new Error("Issue-sync provider must be declared in manifest.issueSyncProviders")
      if (activations.get(pluginId) !== activation)
        throw new Error("Issue-sync provider activation is unavailable")
      const descriptor = provider.resource
      if (
        !descriptor ||
        descriptor.schemaVersion !== def.schemaVersion ||
        descriptor.label !== def.label ||
        typeof descriptor.describe !== "function" ||
        descriptor.schema?.type !== "object" ||
        !descriptor.schema.properties ||
        typeof provider.pull !== "function" ||
        (provider.pullPage !== undefined && typeof provider.pullPage !== "function") ||
        (provider.confirmDeparted !== undefined &&
          typeof provider.confirmDeparted !== "function") ||
        (provider.completeFullScan !== undefined &&
          typeof provider.completeFullScan !== "boolean") ||
        (provider.fullScanOnly !== undefined && typeof provider.fullScanOnly !== "boolean") ||
        (provider.completeFullScan && !provider.pullPage) ||
        (descriptor.kind && descriptor.kind !== "plugin")
      )
        throw new Error("Issue-sync provider does not match its manifest descriptor")
      // A resource form must never solicit a device-local identity or secret.
      assertPortableIssueSyncConfig(descriptor.schema as unknown as Record<string, unknown>)
      const input = { ...provider }
      const connectionRef = input.connectionRef
      if (connectionRef !== undefined && (typeof connectionRef !== "string" || !connectionRef))
        throw new Error("Invalid sync connectionRef")
      let active = true
      const check = () => {
        if (
          !active ||
          activations.get(pluginId) !== activation ||
          !getPermissionGuard().check(pluginId, "issue:write")
        )
          throw new Error("Issue-sync provider unavailable or permission denied: issue:write")
      }
      check()
      const checkConnection = () => {
        check()
        if (!getPermissionGuard().check(pluginId, "auth:consume"))
          throw new Error("Permission denied: auth:consume is required")
      }
      const verify = async (binding?: Parameters<IssueSyncProvider["pull"]>[0]) => {
        check()
        const source = binding?.resource?.captureId
          ? await resolveIssueSyncSource(binding)
          : undefined
        if (connectionRef) {
          checkConnection()
          const ref = binding?.connectionRef ?? connectionRef
          if (source && source.id !== ref) throw new Error("Issue-sync connection identity changed")
          if (ref !== connectionRef && binding) {
            const restored = await resolveIssueSyncSource(binding)
            const captured = binding.resource.captureId
              ? await getRemoteDocumentConnection(binding.resource.captureId)
              : undefined
            const registeredConnection = await getAuthConnection(connectionRef)
            if (
              restored?.id !== ref ||
              (captured?.connectionRef !== connectionRef &&
                registeredConnection?.identityKey !== restored.identityKey)
            )
              throw new Error("Issue-sync connection identity changed")
          }
          await assertSyncConnection(pluginId, ref, checkConnection)
          checkConnection()
        }
      }
      if (connectionRef) checkConnection()
      // Synchronous registration follows ctx.sync; all executions await authorization.
      if (connectionRef) void verify().catch(() => {})
      // Plugins receive a disposable copy, never the Host's mutable authority snapshot.
      const callbackBinding = (binding: Parameters<IssueSyncProvider["pull"]>[0]) =>
        !connectionRef && !binding.resource?.captureId
          ? binding
          : Object.freeze({
              ...binding,
              resource: Object.freeze(structuredClone(binding.resource)),
            })
      const invoke = <T>(
        binding: Parameters<IssueSyncProvider["pull"]>[0],
        credentialContext:
          import("@/lib/execution/personal-credential").PersonalCredentialContext | undefined,
        signal: AbortSignal | undefined,
        callback: () => Promise<T>
      ): Promise<T> =>
        withPluginExecutionContext(pluginId, credentialContext ?? HOST_BACKGROUND, async () => {
          if (connectionRef || binding.resource?.captureId) await verify(binding)
          else check()
          signal?.throwIfAborted()
          const result = await withPluginExecutionContext(
            pluginId,
            credentialContext ?? HOST_BACKGROUND,
            callback
          )
          if (connectionRef || binding.resource?.captureId) await verify(binding)
          else check()
          signal?.throwIfAborted()
          return result
        })
      const registered: IssueSyncProvider = {
        ...input,
        id: `plugin:${pluginId}/${def.id}`,
        label: def.label,
        resource: { ...bindPluginCallbacks(pluginId, descriptor), kind: "plugin" },
        prepare: connectionRef
          ? (binding, credentialContext) =>
              invoke(binding, credentialContext, undefined, async () => ({
                provider: registered,
                connectionRef: binding.connectionRef ?? connectionRef,
              }))
          : undefined,
        resolveBindings: () => [],
        pull: (binding, options) =>
          invoke(binding, options.credentialContext, options.signal, () =>
            input.pull(callbackBinding(binding), {
              since: options.since,
              full: options.full,
              signal: options.signal,
            })
          ),
        ...(input.pullPage
          ? {
              pullPage: (
                ...[binding, options]: Parameters<NonNullable<IssueSyncProvider["pullPage"]>>
              ) =>
                invoke(binding, options.credentialContext, options.signal, () =>
                  input.pullPage!(callbackBinding(binding), {
                    mode: options.mode,
                    cursor: options.cursor,
                    page: options.page,
                    signal: options.signal,
                  })
                ),
            }
          : {}),
        ...(input.confirmDeparted
          ? {
              confirmDeparted: (
                ...[binding, ids, options]: Parameters<
                  NonNullable<IssueSyncProvider["confirmDeparted"]>
                >
              ) =>
                invoke(binding, options.credentialContext, options.signal, () =>
                  input.confirmDeparted!(callbackBinding(binding), ids, { signal: options.signal })
                ),
            }
          : {}),
        ...(input.push
          ? {
              push: (
                ...[binding, ref, patch, issue, context]: Parameters<
                  NonNullable<IssueSyncProvider["push"]>
                >
              ) =>
                invoke(binding, context.credentialContext, context.signal, () =>
                  input.push!(callbackBinding(binding), ref, patch, issue, {
                    idempotencyKey: context.idempotencyKey,
                    by: context.by,
                    editedBy: context.editedBy,
                    signal: context.signal,
                  })
                ),
            }
          : {}),
        ...(input.create
          ? {
              create: (
                ...[binding, issue, credentialContext]: Parameters<
                  NonNullable<IssueSyncProvider["create"]>
                >
              ) =>
                invoke(binding, credentialContext, undefined, () =>
                  input.create!(callbackBinding(binding), issue)
                ),
            }
          : {}),
      }
      Object.defineProperty(registered, "connectionRef", {
        value: connectionRef,
        enumerable: true,
        writable: false,
        configurable: false,
      })
      const unregister = registerIssueSyncProvider(registered)
      const owned = registrations.get(pluginId) ?? new Set<() => void>()
      registrations.set(pluginId, owned)
      const dispose = () => {
        active = false
        unregister()
        owned.delete(dispose)
      }
      owned.add(dispose)
      return dispose
    },
  }

  return createGuardedAPI(
    pluginId,
    api,
    {
      get: "issue:read",
      list: "issue:read",
      listEvents: "issue:read",
      onEvent: "issue:read",
      create: "issue:write",
      update: "issue:write",
      assign: "issue:write",
      comment: "issue:write",
      label: "issue:write",
      registerSyncProvider: "issue:write",
    },
    { consentExempt: ["registerSyncProvider"] }
  )
}
