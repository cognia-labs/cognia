/**
 * One registration set for the mirror runner, import runner and webhook consumer.
 * Keeping ownership here prevents a workspace-scoped run from unregistering
 * another workspace's bindings. Factories always resolve the current binding.
 */
import {
  hasExternalSyncRegistration,
  registerExternalSync,
} from "@/lib/external-services/sync/runtime"
import { runExternalSync } from "@/lib/external-services/sync/core"
import type { ExternalSyncTarget } from "@/lib/external-services/sync/types"
import {
  githubMirrorSyncTarget,
  prepareGithubMirrorSync,
  type SyncRepoIssuesDeps,
  type SyncRepoIssuesResult,
} from "../github-sync"
import { resolveWorkspaceGithubBindings, type WorkspaceGithubBinding } from "../sync-runner"
import { issueSyncTarget, prepareIssueSync, type reconcileBinding } from "./engine"
import { getIssueSyncRegistry, type IssueSyncRegistry } from "./registry"
import { resolveWorkspaceSyncBindings } from "./runner"
import type { IssueSyncBinding, IssueSyncProvider, ReconcileOutcome } from "./types"

export interface IssueSyncRuntimeDeps {
  mirrorBindings?: () => Promise<WorkspaceGithubBinding[]>
  importBindings?: () => Promise<IssueSyncBinding[]>
  registry?: IssueSyncRegistry
  mirrorDeps?: SyncRepoIssuesDeps
}

type PreparedRegistration =
  | { kind: "mirror"; value: Awaited<ReturnType<typeof prepareGithubMirrorSync>> }
  | {
      kind: "import"
      value: Awaited<ReturnType<typeof prepareIssueSync>>
      binding: IssueSyncBinding
      provider: IssueSyncProvider
    }

interface Registration {
  dispose: () => void
  deps: IssueSyncRuntimeDeps
  controllers: Set<AbortController>
  prepare: (signal: AbortSignal) => Promise<PreparedRegistration | undefined>
}
const registrations = new Map<string, Registration>()
let revision = 0
interface BindingSnapshot {
  mirror: WorkspaceGithubBinding[]
  imported: IssueSyncBinding[]
}
let latestReconciliation: Promise<BindingSnapshot> | undefined

/** Reconcile the entire install, even when the caller is syncing one workspace. */
export function reconcileIssueSyncRegistrations(
  deps: IssueSyncRuntimeDeps = {}
): Promise<BindingSnapshot> {
  const requestedRevision = ++revision
  const readMirror = deps.mirrorBindings ?? resolveWorkspaceGithubBindings
  const readImported =
    deps.importBindings ?? (() => resolveWorkspaceSyncBindings(undefined, deps.registry))
  const reconciliation: Promise<BindingSnapshot> = Promise.all([readMirror(), readImported()]).then(
    ([mirror, imported]) => {
      // A slower event/poll snapshot must not undo a newer removal.
      if (requestedRevision !== revision) return latestReconciliation!
      // Waiting callers request keys only after the winning registration set exists.
      const desired = new Map<string, { target: ExternalSyncTarget; mirror: boolean }>()
      for (const binding of mirror) {
        const target = githubMirrorSyncTarget(binding)
        desired.set(target.key, { target, mirror: true })
      }
      for (const binding of imported) {
        const target = issueSyncTarget(binding)
        desired.set(target.key, { target, mirror: false })
      }
      for (const [key, entry] of registrations) {
        if (!desired.has(key)) {
          entry.dispose()
          registrations.delete(key)
        }
      }
      for (const [key, spec] of desired) {
        const existing = registrations.get(key)
        if (existing && hasExternalSyncRegistration(key)) {
          existing.deps = deps
          continue
        }
        const entry: Registration = {
          deps,
          controllers: new Set(),
          dispose: () => {
            if (registrations.get(key) === entry) registrations.delete(key)
            unregister()
            for (const controller of entry.controllers) controller.abort()
          },
          prepare: async (signal) => {
            const current = () =>
              registrations.get(key) === entry &&
              hasExternalSyncRegistration(key) &&
              !signal.aborted
            if (!current()) return undefined
            if (spec.mirror) {
              const read = () => (entry.deps.mirrorBindings ?? resolveWorkspaceGithubBindings)()
              const binding = (await read()).find(
                (candidate) => githubMirrorSyncTarget(candidate).key === key
              )
              if (!current()) return undefined
              if (!binding) {
                entry.dispose()
                return undefined
              }
              const value = await prepareGithubMirrorSync(binding, entry.deps.mirrorDeps)
              if (!current()) return undefined
              // Credential preparation can await a keyring/provider while the user unbinds.
              const stillBound = (await read()).some(
                (candidate) => githubMirrorSyncTarget(candidate).key === key
              )
              if (!current()) return undefined
              if (!stillBound) {
                entry.dispose()
                return undefined
              }
              return { kind: "mirror", value }
            }
            const registry = entry.deps.registry ?? getIssueSyncRegistry()
            const read = () =>
              (
                entry.deps.importBindings ??
                (() => resolveWorkspaceSyncBindings(undefined, registry))
              )()
            const binding = (await read()).find(
              (candidate) => issueSyncTarget(candidate).key === key
            )
            if (!current()) return undefined
            const provider = binding && registry.get(binding.providerId)
            if (!binding || !provider) {
              entry.dispose()
              return undefined
            }
            const providerSignal = registry.signal(provider.id, provider)
            providerSignal.addEventListener("abort", entry.dispose, { once: true })
            const value = await prepareIssueSync(binding, provider, { signal })
            if (!current()) return undefined
            const stillBound = (await read()).some(
              (candidate) => issueSyncTarget(candidate).key === key
            )
            if (!current()) return undefined
            if (!stillBound || providerSignal.aborted || registry.get(provider.id) !== provider) {
              entry.dispose()
              return undefined
            }
            return { kind: "import", value, binding, provider }
          },
        }
        const target = spec.target
        const unregister = registerExternalSync<unknown>(target, async () => {
          const controller = new AbortController()
          entry.controllers.add(controller)
          try {
            const prepared = await entry.prepare(controller.signal)
            if (!prepared)
              throw Object.assign(new Error("Issue sync binding removed"), { name: "AbortError" })
            return { driver: prepared.value.driver, target: prepared.value.target }
          } finally {
            entry.controllers.delete(controller)
          }
        })
        registrations.set(key, entry)
      }
      return { mirror, imported }
    }
  )
  latestReconciliation = reconciliation
  return reconciliation
}

/** Direct sweeps use the same fresh factory as pushes, with an unregister fence during preparation. */
export async function runRegisteredIssueSync(
  key: string,
  options: {
    full?: boolean
    now?: () => number
    signal?: AbortSignal
    reconcile?: typeof reconcileBinding
  } = {}
): Promise<SyncRepoIssuesResult | ReconcileOutcome | undefined> {
  const entry = registrations.get(key)
  if (!entry || !hasExternalSyncRegistration(key) || options.signal?.aborted) return undefined
  const controller = new AbortController()
  entry.controllers.add(controller)
  const abort = () => controller.abort()
  options.signal?.addEventListener("abort", abort, { once: true })
  const current = () =>
    registrations.get(key) === entry &&
    hasExternalSyncRegistration(key) &&
    !controller.signal.aborted
  try {
    const prepared = await entry.prepare(controller.signal)
    if (!prepared || !current()) return undefined
    if (prepared.kind === "import" && options.reconcile) {
      const result = await options.reconcile(prepared.binding, prepared.provider, {
        ...(options.full ? { full: true } : {}),
        ...(options.now ? { now: options.now } : {}),
        signal: controller.signal,
      })
      return current() ? result : undefined
    }
    const outcome = await runExternalSync<unknown>(prepared.value.target, prepared.value.driver, {
      mode: options.full ? "full" : "auto",
      now: options.now,
      signal: controller.signal,
    })
    if (!current()) return undefined
    return prepared.kind === "mirror"
      ? {
          ...prepared.value.result,
          status: outcome.status,
          truncated: outcome.truncated ?? false,
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        }
      : {
          ...prepared.value.tally,
          status: outcome.status,
          pages: outcome.pages,
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        }
  } catch (error) {
    if (!current()) return undefined
    throw error
  } finally {
    entry.controllers.delete(controller)
    options.signal?.removeEventListener("abort", abort)
  }
}
