/**
 * Which messages of a branched conversation are the visible thread.
 *
 * Pure and storage-agnostic: the chat store applies it to the in-memory
 * `UIMessage` list (`selectVisibleMessages`), and the Host's transcript
 * projection to stored rows, so a paired client's folded turn shows the reply
 * the user selected, as the local list does.
 */

interface BranchMetadata {
  branchGroupId?: string
  branchIndex?: number
  /**
   * The sibling this message hangs off. See {@link visibleThread}.
   */
  branchOwnerId?: string
}

/** What the rules read: an id and the branch fields of its metadata. */
export interface BranchedMessage {
  id: string
  metadata?: unknown
}

function branchMeta(m: BranchedMessage): BranchMetadata {
  return (m.metadata ?? {}) as BranchMetadata
}

/**
 * The sibling that should be visible for each `branchGroupId`.
 *
 * Explicit user choice wins; otherwise the highest `branchIndex` — the most
 * recently produced sibling — which is what a fresh regenerate should surface.
 */
export function resolveBranchWinners(
  messages: readonly BranchedMessage[],
  activeBranchByGroup: Record<string, string>
): Map<string, string> {
  // Per group: its member ids plus the highest-index member — the fallback
  // when there is no explicit selection, or the selection is stale. A stale
  // pick is real: `activeBranchByGroup` persists to the sessions table, so a
  // variant deleted on this device (or removed by a sync peer) can leave the
  // recorded choice pointing at a message that no longer exists. Honouring it
  // would emit a group slot with no winner — the whole group would vanish.
  const members = new Map<string, { ids: Set<string>; bestId: string; bestIndex: number }>()
  for (const m of messages) {
    const { branchGroupId, branchIndex } = branchMeta(m)
    if (!branchGroupId) continue
    let g = members.get(branchGroupId)
    if (!g) {
      g = { ids: new Set(), bestId: m.id, bestIndex: -1 }
      members.set(branchGroupId, g)
    }
    g.ids.add(m.id)
    const idx = branchIndex ?? 0
    if (idx > g.bestIndex) {
      g.bestIndex = idx
      g.bestId = m.id
    }
  }

  const winners = new Map<string, string>()
  for (const [groupId, g] of members) {
    const active = activeBranchByGroup[groupId]
    winners.set(groupId, active !== undefined && g.ids.has(active) ? active : g.bestId)
  }
  return winners
}

/**
 * Filter messages down to the currently-visible thread.
 *
 * Two rules compose here:
 *
 *  1. **Siblings** — messages sharing a `branchGroupId` are alternatives, and
 *     exactly one is shown. Produced by regenerating a reply, and by editing a
 *     user message (see `tagBranchSiblings`).
 *
 *  2. **Ownership** — a message carrying `branchOwnerId` hangs off a specific
 *     sibling and is shown only while that sibling is. Editing a user message
 *     mid-thread branches everything that followed it, and without this rule
 *     flipping back to the original would show the original question with the
 *     *other* variant's answers under it.
 *
 * Ownership is **transitive**: hiding a sibling hides what hangs off it, and
 * what hangs off that. A single forward pass suffices because a message always
 * follows the sibling it hangs off — it did not exist until that sibling did.
 *
 * The winner per group is resolved up front rather than during the walk. The
 * old single-pass form retro-actively spliced a later, higher-index sibling
 * over an earlier one, which is fine on its own but cannot work once messages
 * hang off siblings: anything owned by the displaced message has already been
 * emitted by the time it is displaced.
 *
 * Pure function — safe to call from selectors and tests.
 */
export function visibleThread<T extends BranchedMessage>(
  messages: readonly T[],
  activeBranchByGroup: Record<string, string>
): T[] {
  const winners = resolveBranchWinners(messages, activeBranchByGroup)
  const byId = new Map<string, T>()
  for (const m of messages) byId.set(m.id, m)

  const out: T[] = []
  const emittedGroups = new Set<string>()
  const hidden = new Set<string>()

  for (const m of messages) {
    const { branchGroupId, branchOwnerId } = branchMeta(m)

    // Rule 2 first: an owner that is hidden takes its whole subtree with it,
    // whatever this message's own sibling state is.
    if (branchOwnerId !== undefined && hidden.has(branchOwnerId)) {
      hidden.add(m.id)
      continue
    }

    if (!branchGroupId) {
      out.push(m)
      continue
    }

    const winnerId = winners.get(branchGroupId)
    if (m.id !== winnerId) {
      hidden.add(m.id)
      // Emit the winner at the FIRST sibling's position, preserving where the
      // group sits in the thread regardless of which alternative is selected.
      if (!emittedGroups.has(branchGroupId)) {
        const winner = winnerId ? byId.get(winnerId) : undefined
        if (winner) {
          out.push(winner)
          emittedGroups.add(branchGroupId)
        }
      }
      continue
    }

    if (!emittedGroups.has(branchGroupId)) {
      out.push(m)
      emittedGroups.add(branchGroupId)
    }
  }
  return out
}
