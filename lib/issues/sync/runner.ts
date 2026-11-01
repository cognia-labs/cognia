/**
 * One entry point for "refresh everything bound in this workspace".
 *
 * Two kinds of binding coexist (spec 2026-09-06, D1):
 *   - `github-repo` in `mirror` mode keeps the ADR-0132 read-only mirror,
 *     refreshed by `runWorkspaceGithubSync` exactly as before.
 *   - every other binding (`github-repo` in `import` mode, Lark tasklists and
 *     Bitables, plugin providers) goes through `reconcileBinding`.
 *
 * The toolbar button, the scheduler executor and the RPC all call this, so a
 * schedule can never drift from the manual path.
 */

import { listIssueProjects } from "@/lib/db/issue-projects"
import { runWorkspaceGithubSync, type RunWorkspaceGithubSyncResult } from "@/lib/issues/sync-runner"
import { issueSyncTarget, type reconcileBinding } from "./engine"
import { getIssueSyncRegistry, type IssueSyncRegistry } from "./registry"
import type { IssueSyncBinding, IssueSyncFailure, ReconcileOutcome } from "./types"
import { IssueSyncOutcomeError } from "./types"
import { resolvePluginSyncBindings } from "./plugin-resources"
import { reconcileIssueSyncRegistrations, runRegisteredIssueSync } from "./runtime"

export interface RunWorkspaceIssueSyncInput {
  credentialContext?: import("@/lib/execution/personal-credential").PersonalCredentialContext
  /** Workspace scope. Omit to sweep every workspace. */
  projectId?: string
  /** Only this provider's bindings (the mirror still runs unless `mirror: false`). */
  providerId?: string
  /** Skip the GitHub mirror refresh. */
  mirror?: boolean
  /** Rebuild the stored cursor with a full scan. */
  full?: boolean
}

export interface RunWorkspaceIssueSyncResult {
  /** Mirror bindings plus provider bindings considered. Zero means nothing is bound. */
  bindingCount: number
  mirror: RunWorkspaceGithubSyncResult
  outcomes: ReconcileOutcome[]
  failures: IssueSyncFailure[]
}

export interface RunWorkspaceIssueSyncDeps {
  registry?: IssueSyncRegistry
  runMirror?: typeof runWorkspaceGithubSync
  reconcile?: typeof reconcileBinding
  listContainers?: typeof listIssueProjects
}

/** Every provider binding in scope, in provider registration order. */
export async function resolveWorkspaceSyncBindings(
  projectId?: string,
  registry: IssueSyncRegistry = getIssueSyncRegistry(),
  listContainers: typeof listIssueProjects = listIssueProjects
): Promise<IssueSyncBinding[]> {
  const containers = await listContainers(projectId === undefined ? {} : { projectId })
  return [
    ...registry
      .list()
      .filter((provider) => !provider.id.startsWith("plugin:"))
      .flatMap((provider) => provider.resolveBindings(containers)),
    ...resolvePluginSyncBindings(containers, registry),
  ]
}

export async function runWorkspaceIssueSync(
  input: RunWorkspaceIssueSyncInput = {},
  deps: RunWorkspaceIssueSyncDeps = {}
): Promise<RunWorkspaceIssueSyncResult> {
  const registry = deps.registry ?? getIssueSyncRegistry()
  const runMirror = deps.runMirror ?? runWorkspaceGithubSync
  await reconcileIssueSyncRegistrations({
    registry,
    importBindings: () => resolveWorkspaceSyncBindings(undefined, registry, deps.listContainers),
  })

  const mirror =
    input.mirror === false
      ? { repoCount: 0, results: [], failures: [] }
      : await runMirror({
          ...(input.credentialContext ? { credentialContext: input.credentialContext } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.full ? { full: true } : {}),
        })

  const registrations = new Map(
    registry
      .list()
      .map((provider) => [
        provider.id,
        { provider, signal: registry.signal(provider.id, provider) },
      ])
  )
  // Reconcile again after the mirror wait and run exactly that snapshot: a
  // binding added meanwhile has a registration, one removed meanwhile does not.
  const { imported } = await reconcileIssueSyncRegistrations({
    registry,
    importBindings: () => resolveWorkspaceSyncBindings(undefined, registry, deps.listContainers),
  })
  const bindings = imported.filter(
    (binding) =>
      (input.projectId === undefined || binding.projectId === input.projectId) &&
      (!input.providerId || binding.providerId === input.providerId)
  )

  const outcomes: ReconcileOutcome[] = []
  const failures: IssueSyncFailure[] = []
  // Sequential on purpose: bindings of one provider share a credential and a
  // rate limit, and two bindings can write the same label catalogue.
  for (const binding of bindings) {
    const registration = registrations.get(binding.providerId)
    if (
      !registration ||
      registration.signal.aborted ||
      registry.get(binding.providerId) !== registration.provider
    )
      continue
    const { signal } = registration
    try {
      const outcome = await runRegisteredIssueSync(issueSyncTarget(binding).key, {
        ...(input.full ? { full: true } : {}),
        signal,
        ...(deps.reconcile ? { reconcile: deps.reconcile } : {}),
        ...(input.credentialContext ? { credentialContext: input.credentialContext } : {}),
      })
      if (outcome && "binding" in outcome && !signal.aborted) {
        outcomes.push(outcome)
        if (outcome.status === "failed" || outcome.status === "backoff")
          failures.push({
            binding,
            error: new IssueSyncOutcomeError(outcome.errorCode ?? outcome.status),
          })
      }
    } catch (error) {
      if (!signal.aborted) failures.push({ binding, error })
    }
  }

  return { bindingCount: mirror.repoCount + bindings.length, mirror, outcomes, failures }
}
