/**
 * Stamping the replies of a branched turn (`lib/chat/branch-regen.ts`) as they
 * arrive.
 *
 * A regenerate's reply joins the group of the replies it replaces, in the next
 * slot; everything an edit's turn writes hangs off the replacement question.
 * The stamp has to land on the row when it is first written, or the reply
 * shows beside the sibling it replaces until the turn settles.
 *
 * The desktop chat controller arms its own sends in its refs. A turn the Host
 * runs for a paired device never passes through that controller, so the
 * HostState dispatcher arms it here, by session and turn, and every consumer
 * of the Host's runtime events — the desktop event loop and the headless
 * settlement listener — stamps through {@link stampBranchReply}.
 */

import type { UIMessage } from "ai"

export interface BranchReplyTag {
  groupId: string
  index: number
}

export interface BranchReplyArm {
  /** The turn the stamp is for. A frame of another turn never takes it. */
  turnId?: string
  /** A regenerate: the first reply takes this slot. One-shot. */
  tag?: BranchReplyTag
  /** An edit: every row the turn adds hangs off this message. */
  owner?: string
}

export interface BranchStampResult {
  messages: UIMessage[]
  /** Set when the tag was spent on a reply, so the caller can select it. */
  tagged?: { groupId: string; messageId: string }
}

type Metadata = Record<string, unknown>

function metadataOf(message: UIMessage): Metadata {
  return ((message as { metadata?: unknown }).metadata ?? {}) as Metadata
}

/**
 * `applied` with the arm's stamps, given the rows before the event (`current`).
 *
 * The tag goes on the assistant row the event appended. The owner goes on every
 * row after the owner that the event added and that hangs off no nearer
 * sibling already; a row that was there before the event (a steer's bubble
 * appended mid-turn) is not this turn's output.
 */
export function stampBranchReply(
  current: readonly UIMessage[],
  applied: UIMessage[],
  arm: Pick<BranchReplyArm, "tag" | "owner">
): BranchStampResult {
  let messages = applied
  let tagged: BranchStampResult["tagged"]
  if (arm.tag && applied !== current && applied.length > current.length) {
    const lastIndex = applied.length - 1
    const last = applied[lastIndex]
    if (last?.role === "assistant") {
      messages = [
        ...applied.slice(0, lastIndex),
        {
          ...last,
          metadata: {
            ...metadataOf(last),
            branchGroupId: arm.tag.groupId,
            branchIndex: arm.tag.index,
          },
        } as UIMessage,
      ]
      tagged = { groupId: arm.tag.groupId, messageId: last.id }
    }
  }
  if (arm.owner) {
    const ownerIndex = messages.findIndex((message) => message.id === arm.owner)
    if (ownerIndex >= 0) {
      const preexisting = new Set(current.map((message) => message.id))
      let owned: UIMessage[] | null = null
      for (let index = ownerIndex + 1; index < messages.length; index += 1) {
        const message = messages[index]
        if (preexisting.has(message.id)) continue
        const metadata = metadataOf(message)
        if (metadata.branchOwnerId !== undefined) continue
        owned ??= messages.slice()
        owned[index] = {
          ...message,
          metadata: { ...metadata, branchOwnerId: arm.owner },
        } as UIMessage
      }
      if (owned) messages = owned
    }
  }
  return { messages, ...(tagged ? { tagged } : {}) }
}

const arms = new Map<string, BranchReplyArm>()

/** Arm the session's next turn. Replaces whatever an earlier turn left. */
export function armBranchReply(sessionId: string, arm: BranchReplyArm): void {
  if (!arm.tag && !arm.owner) arms.delete(sessionId)
  else arms.set(sessionId, arm)
}

/** Any turn that is not a branch never answers into one. */
export function disarmBranchReply(sessionId: string): void {
  arms.delete(sessionId)
}

/**
 * The arm a frame of `turnId` may spend. A frame with no turn id is taken to
 * be the armed turn's: the runtime stamps the id on every frame it can.
 */
export function armedBranchReply(
  sessionId: string,
  turnId: string | undefined
): BranchReplyArm | undefined {
  const arm = arms.get(sessionId)
  if (!arm) return undefined
  if (arm.turnId && turnId && arm.turnId !== turnId) return undefined
  return arm
}

/**
 * Stamp one runtime event's rows for the session's armed turn, spending the
 * tag once it lands and dropping the arm when the turn ends. Returns `applied`
 * unchanged when nothing is armed for this frame.
 */
export function applyArmedBranchReply(
  sessionId: string,
  turnId: string | undefined,
  current: readonly UIMessage[],
  applied: UIMessage[],
  turnEnded: boolean
): BranchStampResult {
  const arm = armedBranchReply(sessionId, turnId)
  if (!arm) return { messages: applied }
  const result = stampBranchReply(current, applied, arm)
  if (turnEnded) arms.delete(sessionId)
  else if (result.tagged) {
    const { tag: _spent, ...rest } = arm
    armBranchReply(sessionId, rest)
  }
  return result
}

/** Forget every arm. Tests only. */
export function resetBranchReplyArmsForTests(): void {
  arms.clear()
}
