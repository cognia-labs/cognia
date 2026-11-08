/**
 * What a managed worktree gets provisioned with, for any caller that is about
 * to acquire one.
 *
 * # Why this is not inside `session-bundle`
 *
 * Six places acquire a workspace bundle — a chat turn, an Agent Team dispatch,
 * a scheduled task, a connector auto-reply, an agent child process, and the
 * legacy chat path. Until now exactly one of them passed `provisioning`, so a
 * repository's approved `.cognia/workspace.json` reached chat worktrees and no
 * others: an Agent Team fanning five tasks out paid five cold installs while
 * the declaration sat there being honoured on one path. Putting the resolution
 * behind one function keyed by the source root is what lets all six ask.
 *
 * # Two sources, merged only here
 *
 * The repository declaration is the repository author asking, gated on the user
 * approving that file's exact content. The local set is Cognia's own suggestion
 * from a lockfile, gated on the user accepting it in the environment settings.
 * They stay apart everywhere upstream so neither can be mistaken for the other
 * — see `lib/workspace/provisioning-inference` for why that matters — and are
 * unioned at this edge.
 *
 * # Never throws
 *
 * Every caller is on the path between a person asking for something and getting
 * a worktree. A missing Dexie (CLI), an unhydrated store (headless), an
 * unreadable declaration: all of them degrade to "no provisioning", which is a
 * full checkout with a cold cache — slower, never broken.
 *
 * # One repository, one declaration
 *
 * A workspace can mount several repositories. Each has its own
 * `.cognia/workspace.json`, written by its own author, so each is read at its
 * own root and approved at its own root (ADR-0147, 2026-11-08 amendment). The
 * primary keeps the workspace's approval, so no existing approval is asked
 * again; the device-local suggestions came from the primary's lockfiles and
 * stay with it. Every declaration travels with the checkout it was read in,
 * and the host, which sees each root's git repository, decides which
 * repository it belongs to: paths alone cannot tell a subfolder from a
 * separate repository nested inside one.
 */

import { pathKey } from "@/lib/claude/instructions/paths"
import { mergeProvisioning, provisioningFromConsent } from "@/lib/workspace/provisioning-inference"
import { loadDeclaredWorkspace, type DeclaredWorkspace } from "@/lib/workspace/repo-declared"
import { primaryRootOf } from "@/lib/workspace/roots"
import type { Project } from "@/types"

import type { AcquireWorkspaceBundle, WorkspaceProvisioning } from "./types"

/** The workspace fields provisioning is derived from. */
export type ProvisioningProject = Pick<Project, "roots" | "workspaceProvisioning">

export interface WorkspaceProvisioningDeps {
  /**
   * The repository's approved declaration, or null. `configRoot` is the
   * checkout to read it from when that is not the workspace's primary folder:
   * a clone on an always-on Host, or another repository of the workspace.
   * `approvalRoot` is that other repository's own root, whose approval it
   * needs; absent means the workspace's (`approvalKeyFor`).
   */
  declared: (
    project: ProvisioningProject,
    configRoot?: string,
    approvalRoot?: string
  ) => Promise<WorkspaceProvisioning | undefined>
  /** Every workspace known to this device, for the path lookup. */
  projects: () => Promise<Project[]>
}

/**
 * The approved declaration at `configRoot` (the workspace's primary folder by
 * default), under the workspace's approval or `approvalRoot`'s, with this
 * device's trust setting. Null for anything not approved.
 */
export async function approvedDeclaration(
  project: Pick<Project, "roots"> | null | undefined,
  configRoot?: string,
  approvalRoot?: string
): Promise<DeclaredWorkspace | null> {
  const [{ useSettingsStore }, { isTauri }] = await Promise.all([
    import("@/stores/settings"),
    import("@/lib/tauri"),
  ])
  return loadDeclaredWorkspace(project ?? { roots: [] }, {
    ...(configRoot ? { configRoot } : {}),
    ...(approvalRoot ? { approvalRoot } : {}),
    trustEnabled: useSettingsStore.getState().settings?.workspaceTrust?.enabled !== false,
    onWeb: !isTauri(),
  })
}

const DEFAULT_DEPS: WorkspaceProvisioningDeps = {
  declared: async (project, configRoot, approvalRoot) =>
    (await approvedDeclaration(project, configRoot, approvalRoot))?.provisioning,
  projects: async () => {
    // The hydrated store first: it is already in memory on every renderer path
    // and reading Dexie behind it would be a database round-trip per worktree.
    // Dexie is the fallback for the shells that have no store — the CLI, a
    // scheduled run in a headless host.
    try {
      const { useProjectStore } = await import("@/stores/project/project-store")
      const loaded = useProjectStore.getState().projects
      if (loaded.length) return loaded
    } catch {
      // No store in this shell.
    }
    const { getAllProjects } = await import("@/lib/db/projects")
    return getAllProjects()
  },
}

/**
 * Provisioning for a workspace the caller already has in hand.
 *
 * The local half is rebuilt from stored ids, so this costs nothing beyond the
 * declaration read — no directory listing, no process spawn. `configRoot`
 * reads the declaration from that checkout instead of the primary folder; the
 * approval is still the workspace's (`approvalKeyFor`).
 */
export async function provisioningForProject(
  project: ProvisioningProject,
  deps?: Partial<WorkspaceProvisioningDeps>,
  options?: { configRoot?: string }
): Promise<WorkspaceProvisioning | undefined> {
  const local = provisioningFromConsent(project.workspaceProvisioning)
  try {
    const declared = await (deps?.declared ?? DEFAULT_DEPS.declared)(project, options?.configRoot)
    return mergeProvisioning(declared, local)
  } catch {
    // The declaration is what failed to read. The local acceptance is already
    // in hand and is not collateral damage.
    return local
  }
}

/**
 * The bundle's `provisioning` and `provisioningSource`: the workspace
 * primary's declaration and the checkout it was read in. The host applies it
 * to the repository that checkout is in, whichever root of the bundle that is.
 */
export interface BundleProvisioning {
  provisioning?: WorkspaceProvisioning
  provisioningSource?: string
}

/** {@link provisioningForProject}, with the checkout it was read in. */
export async function bundleProvisioningForProject(
  project: ProvisioningProject,
  deps?: Partial<WorkspaceProvisioningDeps>,
  options?: { configRoot?: string }
): Promise<BundleProvisioning> {
  const provisioning = await provisioningForProject(project, deps, options)
  const source = options?.configRoot?.trim() || primaryRootOf(project)?.path?.trim()
  return provisioning ? { provisioning, ...(source ? { provisioningSource: source } : {}) } : {}
}

/**
 * The declaration read at one of the workspace's other roots, approved at that
 * root: a second repository's own file. Never the device-local suggestions,
 * which came from the primary's lockfiles.
 */
export async function provisioningForRepositoryRoot(
  project: ProvisioningProject,
  repositoryRoot: string,
  deps?: Partial<WorkspaceProvisioningDeps>
): Promise<WorkspaceProvisioning | undefined> {
  try {
    return await (deps?.declared ?? DEFAULT_DEPS.declared)(project, repositoryRoot, repositoryRoot)
  } catch {
    return undefined
  }
}

/**
 * The declaration that governs `sourceRoot`, and where it was read.
 *
 * For the acquisition sites that know a directory and nothing else. A path in
 * the workspace's primary root gets the workspace's provisioning; a path in
 * another of its roots gets the file read at that root, under that root's own
 * approval (ADR-0147, 2026-11-08 amendment). Which repository either belongs
 * to is the host's decision, from git, by the source path. Nothing when no
 * workspace mounts the path — an adopted folder, a bare path from a CLI flag.
 *
 * A clone an always-on Host made for a workspace (`host-clone-roots`) counts as
 * that workspace's, with the declaration read from the clone. That is also
 * where the supply reads the cone it backfills (`host-project-source`), so a
 * clone's worktree never checks out files its mirror was not asked for.
 */
export async function bundleProvisioningForPath(
  sourceRoot: string | null | undefined,
  deps?: Partial<WorkspaceProvisioningDeps>
): Promise<BundleProvisioning> {
  const root = sourceRoot?.trim()
  if (!root) return {}
  try {
    const projects = await (deps?.projects ?? DEFAULT_DEPS.projects)()
    const { locateWorkspaceForPath } = await import("@/lib/workspace/locate-workspace")
    const location = locateWorkspaceForPath(root, projects)
    if (location) {
      if (location.root === primaryRootOf(location.project)) {
        return await bundleProvisioningForProject(location.project, deps)
      }
      const own = await provisioningForRepositoryRoot(location.project, location.root.path, deps)
      return own ? { provisioning: own, provisioningSource: location.root.path } : {}
    }
    const { hostCloneFor } = await import("./host-clone-roots")
    const clone = hostCloneFor(root)
    const owner = clone ? projects.find((candidate) => candidate.id === clone.projectId) : undefined
    if (!clone || !owner) return {}
    return await bundleProvisioningForProject(owner, deps, { configRoot: clone.root })
  } catch {
    return {}
  }
}

/** The provisioning half of {@link bundleProvisioningForPath}. */
export async function provisioningForWorkspaceRoot(
  sourceRoot: string | null | undefined,
  deps?: Partial<WorkspaceProvisioningDeps>
): Promise<WorkspaceProvisioning | undefined> {
  return (await bundleProvisioningForPath(sourceRoot, deps)).provisioning
}

type BundleRoot = AcquireWorkspaceBundle["roots"][number]

/**
 * Each root of a bundle with the declaration read at it (ADR-0147,
 * 2026-11-08 amendment), so every repository is provisioned from its own file.
 *
 * The root the bundle's own `provisioning` was read at (`skip`) is left alone,
 * and so is a root that already carries one. Roots that turn out to be one
 * repository are resolved by the host: the bundle's declaration wins in its
 * repository, then the one read at the repository's top. `resolve` is the
 * per-root lookup, {@link provisioningForWorkspaceRoot} by default.
 */
export async function withRootProvisioning<R extends BundleRoot>(
  roots: readonly R[],
  resolve: (sourceRoot: string) => Promise<WorkspaceProvisioning | undefined> = (sourceRoot) =>
    provisioningForWorkspaceRoot(sourceRoot),
  skip?: string
): Promise<R[]> {
  const skipped = skip?.trim() ? pathKey(skip) : null
  return Promise.all(
    roots.map(async (root) => {
      if (root.provisioning || pathKey(root.sourceRoot) === skipped) return root
      const provisioning = await resolve(root.sourceRoot).catch(() => undefined)
      return provisioning ? { ...root, provisioning } : root
    })
  )
}
