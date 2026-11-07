/**
 * Groups the flat runtime registry into the parent→child→grandchild shape the
 * nesting policy actually produces.
 *
 * The runtime tab rendered a flat list even though every record carries
 * `depth` and `parentSubagentId`, which made the panel directly above it — the
 * one configuring nested dispatch — impossible to verify from the UI.
 *
 * `components/chat/message-parts/subagent-tree.tsx` renders the same hierarchy
 * for the chat transcript, but consumes message *parts*; this operates on the
 * store's `SubAgent` records. The nesting rule is shared (`buildTree` in
 * `lib/execution/run-tree.ts`), the input type is not.
 */

import { buildTree, type TreeNode } from "@/lib/execution/run-tree"
import type { SubAgent, SubAgentStatus } from "@/types/agent/sub-agent"

export interface RuntimeNode {
  run: SubAgent
  depth: number
  children: RuntimeNode[]
}

const TERMINAL: ReadonlySet<SubAgentStatus> = new Set<SubAgentStatus>([
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "rejected",
])

/** True once the run can no longer change on its own. */
export function isTerminal(status: SubAgentStatus): boolean {
  return TERMINAL.has(status)
}

/** True while the run is actually executing (started, not yet finished). */
export function isRunning(run: SubAgent): boolean {
  return (
    !isTerminal(run.status) && run.startedAt instanceof Date && !(run.completedAt instanceof Date)
  )
}

function activityTime(run: SubAgent): number {
  return run.lastActivityAt instanceof Date ? run.lastActivityAt.getTime() : 0
}

function createdTime(run: SubAgent): number {
  return run.createdAt instanceof Date ? run.createdAt.getTime() : 0
}

/**
 * Build the forest. A run whose parent is not in the set becomes a root rather
 * than disappearing — the registry is ephemeral and a parent may already have
 * been cleared, and silently dropping its children would under-report what ran.
 * The nesting is the run tree's one rule (`buildTree`), which also breaks a
 * parent cycle so each run is placed once.
 */
export function buildRuntimeTree(runs: readonly SubAgent[]): RuntimeNode[] {
  const toNode = (node: TreeNode<SubAgent>): RuntimeNode => ({
    run: node.item,
    depth: node.depth,
    children: node.children.map(toNode),
  })
  return buildTree(runs, {
    id: (run) => run.id,
    parent: (run) => run.parentSubagentId,
    compare: (a, b) => createdTime(a) - createdTime(b),
    compareRoots: (a, b) => activityTime(b) - activityTime(a),
  }).map(toNode)
}

/** Flatten depth-first — the order the rows render in. */
export function flattenRuntimeTree(nodes: readonly RuntimeNode[]): RuntimeNode[] {
  const out: RuntimeNode[] = []
  const walk = (list: readonly RuntimeNode[]) => {
    for (const node of list) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** Ids of every run that has settled — what "clear finished" removes. */
export function terminalRunIds(runs: readonly SubAgent[]): string[] {
  return runs.filter((r) => isTerminal(r.status)).map((r) => r.id)
}
