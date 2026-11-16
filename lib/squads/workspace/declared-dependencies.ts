/**
 * Repository edges a team's repositories declare themselves (ADR-0147,
 * 2026-11-08 amendment; ADR-0227 cross-root integration).
 *
 * A consumer names what it builds against in its own approved
 * `.cognia/workspace.json`: `"dependsOn": [{ "repository": "github.com/org/sdk" }]`.
 * A declaration names a repository, not a folder, because folders differ on
 * every machine and the file is shared; the run's repositories are matched to
 * it by the remote their checkout reads (`parseOrigin`).
 *
 * Exactly one match is an edge, the same root-to-root edge a Squad's
 * repository binding declares with `dependsOn`, and the two are unioned. No
 * match, or several (a fork and its upstream both bound, say), is never
 * guessed: it is returned as unresolved, and merge-all holds that consumer
 * for a person with the declaration named in its hold record.
 *
 * Only an approved declaration counts, read at the repository's own root and
 * approved there (the workspace's primary keeps its existing approval). A
 * repository whose file is pending, invalid or absent declares nothing.
 */

import type { WorkspaceConfigDependency } from "@/lib/project-environment/workspace-config"
import { originKey, parseOrigin } from "@/lib/workspace/repository-origin"
import type { Project } from "@/types"

export interface DeclaringRepository {
  /** The logical root id the run's bundles use for it. */
  id: string
  /** Its checkout, where the declaration and the remote are read. */
  path: string
}

export interface UnresolvedRepositoryDependency {
  /** The declared repository, canonical `host/path`. */
  repository: string
  /** No repository of the run reads that remote, or more than one does. */
  reason: "noMatch" | "ambiguous"
  /** The run's repositories that matched (two or more when ambiguous). */
  matches: string[]
}

export interface DeclaredRepositoryDependencies {
  /** consumer id → provider ids, from the declarations that resolved. */
  edges: Record<string, string[]>
  /** consumer id → the declarations that did not. */
  unresolved: Record<string, UnresolvedRepositoryDependency[]>
}

export interface DeclaredDependencyDeps {
  /** The repository's approved `dependsOn`, or empty when it has none. */
  declared(repository: DeclaringRepository): Promise<readonly WorkspaceConfigDependency[]>
  /** `origin`'s URL (else the first remote's) of the checkout, or null. */
  remoteOf(path: string): Promise<string | null>
}

export async function resolveDeclaredDependencies(
  repositories: readonly DeclaringRepository[],
  deps: DeclaredDependencyDeps
): Promise<DeclaredRepositoryDependencies> {
  const [declarations, identities] = await Promise.all([
    Promise.all(repositories.map((repository) => deps.declared(repository).catch(() => []))),
    Promise.all(
      repositories.map(async (repository) => {
        const origin = parseOrigin(await deps.remoteOf(repository.path).catch(() => null))
        return origin ? originKey(origin) : null
      })
    ),
  ])
  const edges: Record<string, string[]> = {}
  const unresolved: Record<string, UnresolvedRepositoryDependency[]> = {}
  repositories.forEach((consumer, index) => {
    for (const { repository } of declarations[index] ?? []) {
      const matches = repositories
        .filter(
          (other, otherIndex) => otherIndex !== index && identities[otherIndex] === repository
        )
        .map((other) => other.id)
      if (matches.length === 1) {
        const providers = edges[consumer.id] ?? []
        if (!providers.includes(matches[0]!)) providers.push(matches[0]!)
        edges[consumer.id] = providers
        continue
      }
      ;(unresolved[consumer.id] ??= []).push({
        repository,
        reason: matches.length === 0 ? "noMatch" : "ambiguous",
        matches,
      })
    }
  })
  return { edges, unresolved }
}

/** Two edge maps as one, each consumer's providers deduplicated. */
export function unionRepositoryEdges(
  ...maps: ReadonlyArray<Readonly<Record<string, readonly string[]>> | undefined>
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const map of maps) {
    for (const [consumer, providers] of Object.entries(map ?? {})) {
      const merged = out[consumer] ?? []
      for (const provider of providers) if (!merged.includes(provider)) merged.push(provider)
      if (merged.length) out[consumer] = merged
    }
  }
  return out
}

/**
 * The production lookups: the approved declaration at the repository's own
 * root (the workspace's primary keeps its approval key, another repository
 * is approved at its own root), and the remote its checkout reads.
 */
export function declaredDependencyDepsFor(
  project: Pick<Project, "roots"> | null | undefined
): DeclaredDependencyDeps {
  return {
    declared: async (repository) => {
      const [{ approvedDeclaration }, { primaryRootOf }, { pathKey }] = await Promise.all([
        import("@/lib/task-workspace/workspace-provisioning"),
        import("@/lib/workspace/roots"),
        import("@/lib/agents/instructions/paths"),
      ])
      // The workspace primary's own folder keeps the workspace's approval;
      // any other folder's file is approved at that folder.
      const primary = project ? primaryRootOf(project)?.path : undefined
      const ownApproval = !primary || pathKey(primary) !== pathKey(repository.path)
      const declared = await approvedDeclaration(
        project,
        repository.path,
        ownApproval ? repository.path : undefined
      )
      return declared?.dependsOn ?? []
    },
    remoteOf: async (path) => {
      const { defaultProjectRepositoryReader } = await import("@/lib/workspace/project-repository")
      return defaultProjectRepositoryReader().remoteOf(path)
    },
  }
}
