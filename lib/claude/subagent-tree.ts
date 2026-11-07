// Pure builder that turns the flat `SubagentPart` list on one assistant message
// into a parent→child→grandchild tree for the chat transcript renderer.
//
// PURE function (no React, no store) so the renderer can call it inside a
// `useMemo` over `message.parts` — derived selection, never set-state-in-effect.
// The tree edges come from `parentSubagentId`; a part's own `depth` wins over
// the computed one. The nesting itself is the run tree's one rule
// (`buildTree`): cycles (which the runtime guards against, but which a corrupt
// transcript could still contain) are broken so the walk always terminates and
// every node renders exactly once.

import { buildTree, type TreeNode } from "@/lib/execution/run-tree"
import type { SubagentPart } from "./parts-extensions"
import { isSubagentPart } from "./parts-extensions"

export interface SubagentTreeNode {
  part: SubagentPart
  children: SubagentTreeNode[]
  /** Resolved nesting level (prefers `part.depth`, else computed from the walk). */
  depth: number
}

function stableSort(a: SubagentPart, b: SubagentPart): number {
  return (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.subagentId.localeCompare(b.subagentId)
}

/**
 * Build the subagent dispatch tree from a message's parts. Non-subagent parts
 * are ignored. Returns root nodes (runs with no resolvable parent) in stable
 * `startedAt` order; children are nested + sorted the same way.
 */
export function buildSubagentTree(parts: readonly unknown[] | undefined): SubagentTreeNode[] {
  const subagentParts = (Array.isArray(parts) ? parts : []).filter(isSubagentPart)
  if (subagentParts.length === 0) return []
  // The shape is the run tree's (`lib/execution/run-tree.ts`): a missing or
  // self parent makes a root, a cycle is broken so every part renders once.
  const tree = buildTree(subagentParts, {
    id: (p) => p.subagentId,
    parent: (p) => p.parentSubagentId,
    compare: stableSort,
  })
  // Transcript depth is 1-based and a part's own `depth` wins; a child sits
  // one below its parent's resolved depth.
  const toNode = (node: TreeNode<SubagentPart>, parentDepth: number): SubagentTreeNode => {
    const depth = node.item.depth ?? parentDepth + 1
    return { part: node.item, depth, children: node.children.map((c) => toNode(c, depth)) }
  }
  return tree.map((node) => toNode(node, 0)).sort((a, b) => stableSort(a.part, b.part))
}
