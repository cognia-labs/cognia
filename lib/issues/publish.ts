/**
 * Publish a local issue to a remote tracker: create its counterpart there and
 * link the two, so the next sync keeps them in step.
 *
 * Before this, a locally filed issue could never reach GitHub (`push` only
 * touches rows that already carry an external ref) and `IssueSyncProvider.create`
 * — implemented by the Lark tasklist and Bitable providers — had no caller at
 * all. This module is that caller, and the GitHub path beside it.
 *
 * Always a person's explicit act, never automatic: the dialog shows the exact
 * title and body before anything is created, which is why the GitHub job is
 * approved in the same step (see `createGithubIssue`).
 */

import { getIssue, linkIssueExternal, linkIssueToGithub, githubExternalRef } from "@/lib/db/issues"
import type { Issue, IssueActor, IssueExternalRef, IssueProject } from "@/types/issues"
import { createGithubIssue, resolveGithubWritebackAccount } from "./github-writeback"
import { getIssueSyncRegistry, type IssueSyncRegistry } from "./sync/registry"
import { GITHUB_SYNC_PROVIDER_ID } from "./sync/providers/github"
import type { IssueSyncBinding } from "./sync/types"
import { assertIssueSyncSource, resolveIssueSyncSource } from "./sync/kept-copy-source"
import { KeptCopySourceError } from "@/lib/docs-providers/kept-copy-source"
import { getDb } from "@/lib/db/schema"

function capturedGithubBinding(
  project: IssueProject,
  resource: IssueProject["resources"][number]
): IssueSyncBinding | undefined {
  if (resource.kind !== "github-repo" || !resource.captureId) return undefined
  return {
    providerId: GITHUB_SYNC_PROVIDER_ID,
    projectId: project.projectId,
    issueProjectId: project.id,
    projectKey: project.key,
    key: resource.repoFullName,
    resource,
  }
}

export type PublishTarget =
  | {
      kind: "github"
      /** Stable id for a picker: `github:owner/repo`. */
      id: string
      repoFullName: string
      /** Present when the repository is bound in `import` mode. */
      binding?: IssueSyncBinding
    }
  | {
      kind: "binding"
      id: string
      providerId: string
      providerLabel: string
      /** What the user recognises: the tasklist or table name. */
      resourceName: string
      binding: IssueSyncBinding
    }

function resourceName(binding: IssueSyncBinding): string {
  const resource = binding.resource
  if ("name" in resource && typeof resource.name === "string" && resource.name) {
    return resource.name
  }
  return binding.key
}

function linkedTo(issue: Pick<Issue, "externalRefs">, providerId: string, bindingKey?: string) {
  return (issue.externalRefs ?? []).some(
    (ref) =>
      ref.provider === providerId &&
      (bindingKey === undefined ||
        ref.meta?.binding === undefined ||
        ref.meta.binding === bindingKey)
  )
}

/**
 * Where this issue can be published: every GitHub repository bound to its
 * container, and every other binding whose provider can create items. A
 * target the issue is already linked to is left out — publishing twice would
 * leave two remote copies of one issue.
 */
export function listPublishTargets(
  issue: Pick<Issue, "externalRefs" | "githubRef">,
  container: IssueProject | undefined,
  registry: IssueSyncRegistry = getIssueSyncRegistry()
): PublishTarget[] {
  if (!container) return []
  const targets: PublishTarget[] = []
  const githubBindings = new Map(
    (registry.get(GITHUB_SYNC_PROVIDER_ID)?.resolveBindings([container]) ?? []).map((binding) => [
      binding.key,
      binding,
    ])
  )
  // One GitHub link per issue: the run adapter and write-back act on a single
  // `githubRef`, so an issue already on GitHub is not offered a second repo.
  const onGithub = Boolean(issue.githubRef) || linkedTo(issue, GITHUB_SYNC_PROVIDER_ID)
  if (!onGithub) {
    const seen = new Set<string>()
    for (const resource of container.resources) {
      if (resource.kind !== "github-repo" || seen.has(resource.repoFullName)) continue
      seen.add(resource.repoFullName)
      const binding =
        githubBindings.get(resource.repoFullName) ?? capturedGithubBinding(container, resource)
      targets.push({
        kind: "github",
        id: `github:${resource.repoFullName}`,
        repoFullName: resource.repoFullName,
        ...(binding ? { binding } : {}),
      })
    }
  }
  for (const provider of registry.list()) {
    if (provider.id === GITHUB_SYNC_PROVIDER_ID || !provider.create) continue
    for (const binding of provider.resolveBindings([container])) {
      if (linkedTo(issue, provider.id, binding.key)) continue
      targets.push({
        kind: "binding",
        id: `${provider.id}:${binding.key}`,
        providerId: provider.id,
        providerLabel: provider.label,
        resourceName: resourceName(binding),
        binding,
      })
    }
  }
  return targets
}

export interface PublishIssueDeps {
  getIssue: typeof getIssue
  linkIssueToGithub: typeof linkIssueToGithub
  linkIssueExternal: typeof linkIssueExternal
  createGithubIssue: typeof createGithubIssue
  registry: IssueSyncRegistry
  now: () => number
}

const DEFAULT_DEPS: PublishIssueDeps = {
  getIssue,
  linkIssueToGithub,
  linkIssueExternal,
  createGithubIssue,
  registry: getIssueSyncRegistry(),
  now: Date.now,
}

/** Create the remote counterpart of a local issue and link it. Returns the new ref. */
export async function publishIssue(
  issueId: string,
  target: PublishTarget,
  by: IssueActor,
  provided: Partial<PublishIssueDeps> = {},
  credentialContext?: import("@/lib/execution/personal-credential").PersonalCredentialContext
): Promise<IssueExternalRef> {
  const deps: PublishIssueDeps = {
    ...DEFAULT_DEPS,
    registry: getIssueSyncRegistry(),
    ...provided,
  }
  const issue = await deps.getIssue(issueId)
  if (!issue) throw new Error(`Issue "${issueId}" was not found`)
  let binding = target.binding
  // A cached picker target may predate provenance or provider registration.
  if (!binding && target.kind === "github" && issue.issueProjectId) {
    const project = await getDb().issueProjects.get(issue.issueProjectId)
    const resource = project?.resources.find(
      (item) =>
        item.kind === "github-repo" &&
        item.repoFullName.toLowerCase() === target.repoFullName.toLowerCase()
    )
    if (project && resource) binding = capturedGithubBinding(project, resource)
  }
  const source = binding ? await resolveIssueSyncSource(binding) : undefined
  if (binding && source) binding = { ...binding, connectionRef: source.id }

  if (target.kind === "github") {
    const input = {
      ...(credentialContext ? { credentialContext } : {}),
      repoFullName: target.repoFullName,
      title: issue.title,
      ...(issue.description?.trim() ? { body: issue.description } : {}),
      idempotencyKey: `issue-publish:${issue.id}:${target.repoFullName}`,
    }
    const created =
      source && binding
        ? await deps.createGithubIssue(input, {
            resolveAccount: async (repo) => {
              await assertIssueSyncSource(binding)
              const account = await resolveGithubWritebackAccount(
                repo,
                undefined,
                credentialContext,
                source.id
              )
              if (!account || account.connectionId !== source.id)
                throw new KeptCopySourceError("source-disconnected")
              return account
            },
          })
        : await deps.createGithubIssue(input)
    if (binding) await assertIssueSyncSource(binding)
    await deps.linkIssueToGithub(
      issueId,
      { repoFullName: created.repoFullName, number: created.number, htmlUrl: created.htmlUrl },
      by
    )
    const ref = githubExternalRef({
      repoFullName: created.repoFullName,
      number: created.number,
      htmlUrl: created.htmlUrl,
    })
    if (!binding) return ref
    // Import mode: mark the ref as in step with the remote as of now, so the
    // next pass does not push the very content it was just created from.
    const now = deps.now()
    const synced: IssueExternalRef = {
      ...ref,
      syncedAt: now,
      remoteUpdatedAt: created.updatedAt ?? now,
      meta: { binding: binding.key },
    }
    await deps.linkIssueExternal(issueId, synced, by)
    return synced
  }

  const provider = deps.registry.get(target.providerId)
  if (!provider?.create) {
    throw new Error(`Issue sync provider "${target.providerId}" cannot create items`)
  }
  const writeBinding = binding ?? target.binding
  await assertIssueSyncSource(writeBinding)
  const ref = await provider.create(writeBinding, issue, credentialContext)
  await assertIssueSyncSource(writeBinding)
  const linked: IssueExternalRef = {
    ...ref,
    meta: { ...(ref.meta ?? {}), binding: target.binding.key },
  }
  await deps.linkIssueExternal(issueId, linked, by)
  return linked
}
