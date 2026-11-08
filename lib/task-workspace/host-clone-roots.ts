/**
 * Which workspace each clone on an always-on Host stands in for (ADR-0224
 * A11, ADR-0176 A2).
 *
 * A workspace names folders on the device that created it. When the Host has
 * none of them, its work runs in a clone of the workspace's repository, at a
 * path no workspace mounts. Anything that starts from a directory and asks
 * "which workspace is this" (`provisioningForWorkspaceRoot`) would find
 * nothing for that path and provision the worktree with nothing, while the
 * supply that made the clone knows exactly which workspace it was for.
 *
 * The supply records the pair here (`lib/remote-host/code-supply`) and the
 * provisioning lookup reads it back, so a clone's worktrees are provisioned
 * from its repository's declaration, and the supply narrows its mirror
 * backfill to the same cone. Correctness does not hang on the two agreeing: a
 * worktree backfills its own base and cone before it is added (ADR-0176 A2,
 * D29), so a mismatch costs a fetch, never a failed checkout.
 *
 * In memory only. After a Host restart a clone counts as no workspace's until
 * its workspace's source is resolved again: its worktrees are then full
 * checkouts without the declaration's provisioning, as before A2.
 *
 * Clones are keyed by remote, so two workspaces of one repository share one.
 * Such a clone is no single workspace's: a declaration is approved per
 * workspace, and one workspace's approval must not provision another's
 * worktrees.
 */

export interface HostClone {
  projectId: string
  /** The clone's checkout root. */
  root: string
}

const clones = new Map<string, string>()

/**
 * A path in the separator-neutral, trailing-separator-free form both sides of
 * a comparison are put in. Case is kept: a clone path is one the Host made,
 * and the same Host is what hands it back.
 */
function comparable(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "")
}

function isUnder(path: string, root: string): boolean {
  const target = comparable(path)
  const base = comparable(root)
  return Boolean(base) && (target === base || target.startsWith(`${base}/`))
}

/** Record that `root` is the clone `projectId`'s work runs in. */
export function rememberHostClone(projectId: string, root: string): void {
  const trimmed = root.trim()
  if (!projectId || !trimmed) return
  clones.set(projectId, trimmed)
}

/** `projectId`'s work no longer runs in a clone (a folder of its is here now). */
export function forgetHostClone(projectId: string): void {
  clones.delete(projectId)
}

/** Every workspace recorded for exactly the clone at `root`. */
export function hostCloneOwners(root: string): string[] {
  const base = comparable(root)
  return [...clones].filter(([, other]) => comparable(other) === base).map(([id]) => id)
}

/** The clone recorded for `projectId`, if any. */
export function hostCloneRootOf(projectId: string): string | undefined {
  return clones.get(projectId)
}

/**
 * The clone `path` is in, the deepest when clones nest, or `null` when it is
 * in none or the clone is shared by several workspaces.
 */
export function hostCloneFor(path: string | null | undefined): HostClone | null {
  const target = path?.trim()
  if (!target) return null
  let best: HostClone | null = null
  for (const [projectId, root] of clones) {
    if (!isUnder(target, root)) continue
    if (!best || comparable(root).length > comparable(best.root).length) best = { projectId, root }
  }
  if (!best || hostCloneOwners(best.root).length !== 1) return null
  return best
}

/** Forget every recorded clone (tests). */
export function resetHostClones(): void {
  clones.clear()
}
