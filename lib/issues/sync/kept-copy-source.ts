/** Host-owned provenance for imported issues. The imported issues remain user-kept copies. */
import { getDb } from "@/lib/db/schema"
import { getAuthConnection } from "@/lib/db/auth-connections"
import {
  captureKeptCopyConnection,
  KeptCopySourceError,
  requireKeptCopySource,
  resolveKeptCopyConnection,
  resolveKeptCopySource,
  recordKeptCopySourceFailure,
  type KeptCopySourceReference,
} from "@/lib/docs-providers/kept-copy-source"
import { resourceKey } from "./bindings"
import type { IssueProjectResource } from "@/types/issues"
import type { IssueSyncBinding } from "./types"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { DocsProviderError } from "@/lib/docs-providers/types"

/** Only wrap the container read, never optional linked issues, milestones or projects. */
export async function readIssueSyncSource<T>(
  binding: IssueSyncBinding,
  read: () => Promise<T>
): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (
      error instanceof Error &&
      "status" in error &&
      (error.status === 403 || error.status === 404)
    )
      await recordKeptCopySourceFailure(
        issueResourceProvenance(binding.resource, binding.providerId),
        new DocsProviderError(error.status === 404 ? "notFound" : "noPermission")
      )
    throw error
  }
}

export function issueResourceProvenance(
  resource: IssueProjectResource,
  bindingProviderId?: string
): KeptCopySourceReference | undefined {
  if (!resource.captureId) return undefined
  const providerId =
    bindingProviderId ??
    (resource.kind === "plugin"
      ? resource.providerId
      : resource.kind === "github-repo"
        ? "github"
        : resource.kind === "lark-tasklist"
          ? "lark-task"
          : "lark-bitable")
  return { captureId: resource.captureId, providerId, connectionScoped: true }
}

export function resolveIssueResourceSource(resource: IssueProjectResource) {
  return resolveKeptCopySource(issueResourceProvenance(resource))
}

async function currentResource(binding: IssueSyncBinding) {
  const project = await getDb().issueProjects.get(binding.issueProjectId)
  return (
    project?.resources.find(
      (resource) => resourceKey(resource) === resourceKey(binding.resource)
    ) ?? binding.resource
  )
}

export async function resolveIssueSyncSource(binding: IssueSyncBinding) {
  const provenance = issueResourceProvenance(await currentResource(binding), binding.providerId)
  await requireKeptCopySource(provenance)
  return provenance ? resolveKeptCopyConnection(provenance) : undefined
}

/** A prepared write must not move to a different connection during execution. */
export async function assertIssueSyncSource(
  binding: IssueSyncBinding,
  expectedConnectionRef = binding.connectionRef
) {
  const connection = await resolveIssueSyncSource(binding)
  if (connection && expectedConnectionRef && connection.id !== expectedConnectionRef)
    throw new KeptCopySourceError("source-disconnected")
  return connection
}

/** Persist only the handle on the resource; never migrate or replace its config implicitly. */
export async function captureIssueSyncSource(
  binding: IssueSyncBinding,
  connectionRef: AuthConnectionRef,
  consumerPluginId?: string,
  consumerKind?: "integration"
): Promise<void> {
  const resource = await currentResource(binding)
  const existing = issueResourceProvenance(resource, binding.providerId)
  const connection = await getAuthConnection(connectionRef)
  if (connection?.status !== "connected") throw new KeptCopySourceError("source-disconnected")
  if (existing) {
    const restored = await resolveIssueSyncSource(binding)
    if (restored?.id !== connection.id) throw new KeptCopySourceError("source-disconnected")
    return
  }
  const db = getDb()
  await db.transaction(
    "rw",
    db.issueProjects,
    db.authConnections,
    db.remoteDocumentConnections,
    async () => {
      const project = await db.issueProjects.get(binding.issueProjectId)
      const index =
        project?.resources.findIndex((item) => resourceKey(item) === resourceKey(resource)) ?? -1
      // Re-read under the same transaction: two initial syncs must not replace provenance.
      if (project && index >= 0 && project.resources[index].captureId) {
        const captured = await db.remoteDocumentConnections.get(project.resources[index].captureId!)
        if (
          captured?.identityKey !== connection.identityKey ||
          captured.providerId !== binding.providerId
        )
          throw new KeptCopySourceError("source-disconnected")
        binding.resource = { ...binding.resource, captureId: project.resources[index].captureId }
        return
      }
      const captureId = await captureKeptCopyConnection({
        providerId: binding.providerId,
        connectionRef,
        revision: connection.revision,
        consumerPluginId,
        consumerKind,
      })
      if (project && index >= 0) {
        const resources = [...project.resources]
        resources[index] = { ...resources[index], captureId }
        await db.issueProjects.update(project.id, { resources })
      }
      binding.resource = { ...binding.resource, captureId }
    }
  )
}
