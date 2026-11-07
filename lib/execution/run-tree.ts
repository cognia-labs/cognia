/**
 * The one nesting rule for runs (ADR-0252 §2): a run is the child of the run
 * its `parentRunId` names, and of nothing else. A Squad's delegations, a
 * dispatched subagent, a best-of-N candidate and a workflow's team step all
 * hang off their parent through that column, so the tree any surface draws and
 * the chain any policy walks (the delegation depth cap, the cycle check) come
 * from here instead of from a tracker of its own.
 *
 *   - `buildTree`: the shape, generic over the item, for surfaces whose items
 *     are not run rows but nest by the same rule (subagent parts, the runtime
 *     registry). A missing parent makes a root; a parent cycle is broken so
 *     every item is placed exactly once.
 *   - `childrenOf` / `buildRunTree`: the same over `ExecutionRun` rows.
 *   - `readRunAncestors` / `readRunSubtree`: the chain above a run and the
 *     tree below it, read from `executionRuns` (`parentRunId` is indexed).
 */

import type { ExecutionRun } from "@cognia/plugin-contract/types/execution/run"
import { getExecutionRun, listChildExecutionRuns } from "@/lib/db/execution-runs"

export interface TreeNode<T> {
  item: T
  /** 0 for a root. */
  depth: number
  children: TreeNode<T>[]
}

export interface TreeKeys<T> {
  id(item: T): string
  /** The parent's id, or `undefined` for an item that names none. */
  parent(item: T): string | undefined
  /** Sibling order; insertion order when omitted. */
  compare?(left: T, right: T): number
  /** Root order; `compare` when omitted. */
  compareRoots?(left: T, right: T): number
}

/**
 * Nest `items` by their parent id. An item whose parent is absent from the set
 * (or is itself) is a root rather than dropped: a parent may already have been
 * pruned, and losing its children would under-report what ran. Items trapped
 * in a parent cycle, which no root reaches, are surfaced as roots too.
 */
export function buildTree<T>(items: readonly T[], keys: TreeKeys<T>): TreeNode<T>[] {
  const ids = new Set(items.map((item) => keys.id(item)))
  const childrenById = new Map<string, T[]>()
  const roots: T[] = []
  for (const item of items) {
    const id = keys.id(item)
    const parentId = keys.parent(item)
    if (parentId !== undefined && parentId !== id && ids.has(parentId)) {
      const bucket = childrenById.get(parentId)
      if (bucket) bucket.push(item)
      else childrenById.set(parentId, [item])
    } else {
      roots.push(item)
    }
  }

  const placed = new Set<string>()
  const sorted = (list: T[], compare?: (left: T, right: T) => number): T[] =>
    compare ? [...list].sort(compare) : list
  const toNode = (item: T, depth: number): TreeNode<T> => {
    placed.add(keys.id(item))
    const node: TreeNode<T> = { item, depth, children: [] }
    for (const child of sorted(childrenById.get(keys.id(item)) ?? [], keys.compare)) {
      // Checked per child: an earlier sibling's subtree may have placed it.
      if (!placed.has(keys.id(child))) node.children.push(toNode(child, depth + 1))
    }
    return node
  }

  const forest: TreeNode<T>[] = []
  for (const root of sorted(roots, keys.compareRoots ?? keys.compare)) {
    if (!placed.has(keys.id(root))) forest.push(toNode(root, 0))
  }
  for (const item of items) {
    if (!placed.has(keys.id(item))) forest.push(toNode(item, 0))
  }
  return forest
}

/** Depth-first, parents before their children: the order rows render in. */
export function flattenTree<T>(nodes: readonly TreeNode<T>[]): TreeNode<T>[] {
  const out: TreeNode<T>[] = []
  const walk = (list: readonly TreeNode<T>[]) => {
    for (const node of list) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

const RUN_KEYS: TreeKeys<ExecutionRun> = {
  id: (run) => run.id,
  parent: (run) => run.parentRunId,
  compare: (left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id),
}

/** The runs in `runs` whose parent is `parentRunId`, oldest first. */
export function childrenOf(runs: readonly ExecutionRun[], parentRunId: string): ExecutionRun[] {
  return runs
    .filter((run) => run.parentRunId === parentRunId && run.id !== parentRunId)
    .sort(RUN_KEYS.compare)
}

/** Nest run rows by `parentRunId`; siblings and roots oldest first. */
export function buildRunTree(runs: readonly ExecutionRun[]): TreeNode<ExecutionRun>[] {
  return buildTree(runs, RUN_KEYS)
}

/** Deep enough for any tree the depth caps allow; a longer chain is corrupt. */
export const MAX_RUN_TREE_DEPTH = 64

export interface RunTreeReader {
  getRun(runId: string): Promise<ExecutionRun | undefined>
  listChildren(parentRunId: string): Promise<ExecutionRun[]>
}

const dbReader: RunTreeReader = {
  getRun: getExecutionRun,
  listChildren: (parentRunId) => listChildExecutionRuns(parentRunId),
}

/**
 * The runs above `runId`, nearest first (its parent, then that run's parent),
 * ending at the root. The run itself is not included. The walk stops at a
 * parent that no longer exists, at a cycle, and at `MAX_RUN_TREE_DEPTH`.
 */
export async function readRunAncestors(
  runId: string,
  reader: RunTreeReader = dbReader
): Promise<ExecutionRun[]> {
  const start = await reader.getRun(runId)
  const ancestors: ExecutionRun[] = []
  const seen = new Set<string>([runId])
  let parentId = start?.parentRunId
  while (parentId && !seen.has(parentId) && ancestors.length < MAX_RUN_TREE_DEPTH) {
    seen.add(parentId)
    const parent = await reader.getRun(parentId)
    if (!parent) break
    ancestors.push(parent)
    parentId = parent.parentRunId
  }
  return ancestors
}

/**
 * The tree rooted at `rootRunId`, read level by level through the
 * `parentRunId` index. `undefined` when the root does not exist. A run reached
 * twice (a corrupt cycle) is placed once.
 */
export async function readRunSubtree(
  rootRunId: string,
  reader: RunTreeReader = dbReader
): Promise<TreeNode<ExecutionRun> | undefined> {
  const root = await reader.getRun(rootRunId)
  if (!root) return undefined
  const rows: ExecutionRun[] = [root]
  const seen = new Set<string>([root.id])
  let level = [root.id]
  for (let depth = 0; level.length > 0 && depth < MAX_RUN_TREE_DEPTH; depth += 1) {
    const children = (await Promise.all(level.map((id) => reader.listChildren(id)))).flat()
    level = []
    for (const child of children) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      rows.push(child)
      level.push(child.id)
    }
  }
  // The root is the only run here without its parent in the set, unless the
  // corrupt cycle loops back to it; either way it heads the first tree.
  const tree = buildTree(rows, {
    ...RUN_KEYS,
    parent: (run) => (run.id === root.id ? undefined : run.parentRunId),
  })
  return tree[0]
}
