/**
 * The production wiring of the changeset pipeline and the integration queue
 * (ADR-0227): the real host, the real diff and blob readers, the model the
 * user configured for AI review, and the ADR-0188 acceptance port for the
 * changeset's project.
 *
 * One factory so the Agent Team `merge-all`, the Source Control panel and the
 * workflow node all review and verify the same way; each passes only what it
 * knows (a project id, a signal).
 */

import type { AcceptancePort } from "@cognia/router-fusion"

import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { acceptanceProfileResolver } from "@/lib/router-fusion/runtime/delegate-host-ports"
import {
  createDelegateAcceptancePort,
  defaultAcceptanceSandboxHost,
  resolveProjectContainerImage,
  type AcceptanceSandboxHost,
} from "@/lib/router-fusion/verify/code-acceptance-host"
import { deleteWorkspaceEntry, statWorkspaceFile } from "@/lib/files/workspace-fs"
import {
  acquireWorkspaceBundle,
  archiveManagedWorkspace,
  pinManagedWorkspace,
} from "@/lib/task-workspace/client"
import { bundleProvisioningForPath } from "@/lib/task-workspace/workspace-provisioning"
import { runWorkspaceUserAction } from "@/lib/task-workspace/user-action"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { AppSettings } from "@cognia/agent-config-types"
import { DEFAULT_GIT_SETTINGS } from "@/types/git"

import type { ScmHost } from "./host"
import {
  integrateChangesets,
  integrationRootForRevision,
  type IntegrateChangesetsInput,
  type IntegrationOutcome,
} from "./integration/orchestrator"
import { reviewChangeset, type ChangesetReviewResult } from "./review/review-changeset"
import { getSourceControlService, type SourceControlService } from "./service"
import { composedItems, type IntegrationRun } from "./types"
import { readReviewPolicyAtRef } from "./review/review-policy"

export interface ScmRuntimeInput {
  /** The project whose approved acceptance profiles verify the change. Null: no checks can run. */
  projectId: string | null
  /** The checkout `.cognia/workspace.json` approvals are keyed by, when it is not the project's own. */
  configRoot?: string | null
  appSettings: AppSettings | null | undefined
  /** The source-control backend (Git unless a caller passes another). */
  service?: SourceControlService
  host?: ScmHost
}

export interface ScmRuntime {
  host: ScmHost
  review(changesetId: string, signal: AbortSignal): Promise<ChangesetReviewResult>
  integrate(input: IntegrateChangesetsInput): Promise<IntegrationOutcome>
}

/**
 * The reviewer model: the Source Control panel's AI-review choice, and only
 * when the user turned AI review on (`gitSettings.reviewAI.enabled`, off by
 * default). With it off there is no reviewer, which the review records as
 * `unavailable` — a human approval, never a silent pass, and never a diff sent
 * to a model the user did not agree to.
 */
export function reviewClientFor(appSettings: AppSettings | null | undefined): LlmClient | null {
  const config = appSettings?.gitSettings?.reviewAI ?? DEFAULT_GIT_SETTINGS.reviewAI
  if (config?.enabled !== true) return null
  return buildUtilityLlmClient({
    session: null,
    appSettings,
    override: { providerOverride: config.providerOverride, model: config.model },
    featureId: "scm.reviewChangeset",
  })
}

function acceptancePort(
  input: ScmRuntimeInput,
  runId: string,
  rootForRevision: (revision: string) => Promise<string | null>,
  executionRoot: string,
  sandbox: AcceptanceSandboxHost = defaultAcceptanceSandboxHost()
): AcceptancePort | null {
  if (!input.projectId) return null
  const projectId = input.projectId
  return createDelegateAcceptancePort({
    runId,
    rootForRevision,
    resolveProfile: acceptanceProfileResolver(projectId, input.configRoot),
    sandbox,
    newId: () => crypto.randomUUID(),
    resolveImage: () => resolveProjectContainerImage({ projectId, executionRoot }),
  })
}

/** The existing acceptance runner still owns execution/report collection.
 * This boundary resets only its disposable checkout and clears stale reports. */
function verificationSandbox(scm: SourceControlService, revision: string) {
  const sandbox = defaultAcceptanceSandboxHost()
  let stopUnproven = false
  return {
    stopUnproven: () => stopUnproven,
    sandbox: {
      availability: (target) => sandbox.availability(target),
      async run(spec) {
        if (stopUnproven)
          throw new Error("verification executor stop is unproven; checkout retained")
        spec.signal.throwIfAborted()
        if (!scm.resetVerificationCheckout)
          throw new Error("verification checkout reset is unavailable")
        await scm.resetVerificationCheckout(spec.worktreeRoot, revision)
        if ((await statWorkspaceFile(spec.worktreeRoot, spec.reportPath)).exists) {
          await deleteWorkspaceEntry(spec.worktreeRoot, spec.reportPath)
        }
        spec.signal.throwIfAborted()
        stopUnproven = true
        const result = await sandbox.run(spec)
        stopUnproven = false
        return result
      },
    } satisfies AcceptanceSandboxHost,
  }
}

export function createScmRuntime(input: ScmRuntimeInput): ScmRuntime {
  const scm = input.service ?? getSourceControlService()
  const host = input.host ?? scm.changesets
  const customInstructions = input.appSettings?.gitSettings?.reviewAI?.customInstructions
  return {
    host,
    review: async (changesetId, signal) => {
      const changeset = await host.getChangeset(changesetId)
      const verification = verificationSandbox(scm, changeset?.headSha ?? "")
      let bundle: Awaited<ReturnType<typeof acquireWorkspaceBundle>> | undefined
      let checkout: Promise<string> | undefined
      const rootForRevision = async (revision: string): Promise<string | null> => {
        if (!changeset || revision !== changeset.headSha) return null
        checkout ??= (async () => {
          signal.throwIfAborted()
          const provisioning = await bundleProvisioningForPath(changeset.sourceRoot)
          signal.throwIfAborted()
          bundle = await runWorkspaceUserAction("task_workspace_bundle_acquire", () =>
            acquireWorkspaceBundle(
              {
                ownerType: "team",
                ownerRef: `changeset-check:${changesetId}:${crypto.randomUUID()}`,
                ...(input.projectId ? { projectId: input.projectId } : {}),
                environmentKind: "managed",
                base: { kind: "gitRef", gitRef: changeset.headSha },
                roots: [
                  { logicalRootId: "primary", role: "primary", sourceRoot: changeset.sourceRoot },
                ],
                ...provisioning,
              },
              { signal }
            )
          )
          const lease = bundle.leases[0]
          if (
            bundle.state !== "active" ||
            bundle.leases.length !== 1 ||
            lease?.role !== "primary"
          ) {
            throw new Error("changeset verification workspace is invalid")
          }
          const current = await host.getChangeset(changesetId)
          if (!current || current.headSha !== changeset.headSha)
            throw new Error("changeset head changed before verification")
          await runWorkspaceUserAction("task_workspace_managed_pin", () =>
            pinManagedWorkspace(lease.workspaceId, true)
          )
          return lease.aliasPath
        })()
        return checkout
      }
      const port =
        changeset && input.projectId
          ? acceptancePort(
              input,
              `changeset:${changesetId}`,
              rootForRevision,
              changeset.sourceRoot,
              verification.sandbox
            )
          : null
      try {
        return await reviewChangeset(changesetId, {
          host,
          readBlob: (repo, ref, path) => scm.readFileAt(repo, ref, path),
          agent: {
            loadDiff: (repo, base, head, path) => scm.diffRevisionFile(repo, base, head, path),
            client: reviewClientFor(input.appSettings),
            ...(customInstructions ? { customInstructions } : {}),
          },
          acceptancePort: port,
          signal,
        })
      } finally {
        if (verification.stopUnproven()) {
          throw new Error("verification executor stop is unproven; pinned checkout retained")
        }
        const cleanup = await Promise.allSettled(
          (bundle?.leases ?? []).map(async (lease) => {
            await runWorkspaceUserAction("task_workspace_managed_pin", () =>
              pinManagedWorkspace(lease.workspaceId, false)
            )
            await runWorkspaceUserAction("task_workspace_managed_archive", () =>
              archiveManagedWorkspace(lease.workspaceId)
            )
          })
        )
        const failures = cleanup.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected"
        )
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "changeset check workspace cleanup failed"
          )
      }
    },
    integrate: (integration) => {
      let verification: ReturnType<typeof verificationSandbox> | undefined
      return integrateChangesets(integration, {
        host,
        executorStopUnproven: () => verification?.stopUnproven() ?? false,
        readPolicyAtRef: async (run) => {
          const item = composedItems(run)[0]
          const changeset = item ? await host.getChangeset(item.changesetId) : null
          if (!changeset?.sourceRoot || !run.expectedOldSha) {
            throw new Error("integration target policy source is unavailable")
          }
          return readReviewPolicyAtRef(
            changeset.sourceRoot,
            run.expectedOldSha,
            (repo, ref, path) => scm.readFileAt(repo, ref, path)
          )
        },
        acceptancePortFor: input.projectId
          ? (run: IntegrationRun) => {
              verification = verificationSandbox(scm, run.candidateSha ?? "")
              return acceptancePort(
                input,
                `integration:${run.integrationId}`,
                integrationRootForRevision(run),
                run.worktreePath ?? "",
                verification.sandbox
              ) as AcceptancePort
            }
          : null,
      })
    },
  }
}

/** Git helpers `integrateTeamRun` needs, over the source-control port. */
export function scmGitPortsFor(scm: SourceControlService = getSourceControlService()) {
  return {
    currentBranch: async (sourceRoot: string): Promise<string | null> =>
      (await scm.status(sourceRoot)).branch,
    branchExists: async (sourceRoot: string, name: string): Promise<boolean> =>
      (await scm.branches(sourceRoot)).some((branch) => !branch.isRemote && branch.name === name),
    createBranch: (sourceRoot: string, name: string, from: string): Promise<void> =>
      scm.createBranch(sourceRoot, name, from),
  }
}
