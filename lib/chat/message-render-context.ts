/**
 * What a message list supplies to every `MessageRenderer` it draws, and to the
 * renderers nested inside a message (D10): the characters a reply may speak
 * as, the row actions, which rows may change, the project root links resolve
 * against, the resolved display settings, and whether the host opens a
 * long-press action sheet.
 *
 * List shells keep owning scroll, virtualization and their data source; this
 * carries only what every row reads the same way. A prop passed to one
 * `MessageRenderer` still overrides the context for that row.
 *
 * Pure types and merge rules; the React context lives in
 * `components/chat/message-render-context.tsx`.
 */

import type { ComponentType } from "react"
import type { UIMessage } from "ai"
import type { Character } from "@cognia/agent-config-types"

import type { RewindFilesResult } from "@/lib/ai/agent/execution/sidecar-client"
import type { ResolvedMessageDisplayOptions } from "@/lib/chat/message-display"
import type { MessageMotion } from "@/types/appearance"

/**
 * What a shell's long-press sheet is drawn with. The surface decides which
 * actions the pressed row allows; the shell's component draws them.
 */
export interface MessageActionSheetHostProps {
  /** The pressed row, or null while the sheet is closed. */
  message: UIMessage | null
  onOpenChange: (open: boolean) => void
  /** The character that spoke (the read-aloud voice). */
  character?: Character | null
  messageMotion?: MessageMotion
  onRegenerate?: () => void | Promise<void>
  onEditResend?: (message: UIMessage, newText: string) => void | Promise<void>
}

/** A change to a row that writes the transcript. */
export type MessageMutationKind = "edit" | "regenerate"

export interface MessageRenderContextValue {
  /** senderId → character, for team and room messages. */
  characterById?: Map<string, Character>
  /** The session's character in a 1:1 chat (the read-aloud voice). */
  directCharacter?: Character | null
  onCopy?: () => void
  onRegenerate?: () => void | Promise<void>
  onEditResend?: (messageId: string, newText: string) => void | Promise<void>
  onRewindFiles?: (
    sessionId: string,
    checkpointId: string,
    dryRun: boolean
  ) => Promise<RewindFilesResult>
  /**
   * Whether this row may be edited or regenerated: a transcript drawn from a
   * Host window lets only its writable rows change. Absent means every row
   * may. Nested providers narrow it: each level must allow.
   */
  canMutate?: (messageId: string, kind: MessageMutationKind) => boolean
  /** Root used to resolve project-relative links in a message. */
  projectRoot?: string | null
  /** The display settings resolved for this transcript (session override included). */
  messageDisplay?: ResolvedMessageDisplayOptions
  /**
   * The shell's long-press action sheet (phone shells), which carries every
   * action the inline bar does. Supplied by the shell, so the surfaces that
   * open it do not import it; present means rows are long-pressable.
   */
  actionSheet?: ComponentType<MessageActionSheetHostProps>
}

/**
 * `child` inside `parent`: every key the child sets wins, except
 * {@link MessageRenderContextValue.canMutate}, where both must allow.
 */
export function mergeMessageRenderContext(
  parent: MessageRenderContextValue,
  child: MessageRenderContextValue
): MessageRenderContextValue {
  const merged: MessageRenderContextValue = { ...parent }
  for (const key of Object.keys(child) as Array<keyof MessageRenderContextValue>) {
    if (child[key] !== undefined) (merged as Record<string, unknown>)[key] = child[key]
  }
  if (parent.canMutate && child.canMutate) {
    const outer = parent.canMutate
    const inner = child.canMutate
    merged.canMutate = (messageId, kind) => outer(messageId, kind) && inner(messageId, kind)
  }
  return merged
}

/** The props one row is drawn with: what it was handed, else the context's. */
export interface MessageRenderProps {
  message: { id: string }
  characterById?: Map<string, Character>
  directCharacter?: Character | null
  onCopy?: () => void
  onRegenerate?: () => void | Promise<void>
  onEditResend?: (messageId: string, newText: string) => void | Promise<void>
  onRewindFiles?: MessageRenderContextValue["onRewindFiles"]
  projectRoot?: string | null
  messageDisplay?: ResolvedMessageDisplayOptions
  actionSheetHost?: boolean
}

/**
 * Fill a row's unset props from the context. A mutation the context supplies
 * is offered only where its `canMutate` allows; one passed to the row itself
 * is the caller's decision and is kept.
 */
export function resolveMessageRenderProps<P extends MessageRenderProps>(
  props: P,
  context: MessageRenderContextValue
): P & MessageRenderProps {
  const allows = (kind: MessageMutationKind) =>
    context.canMutate ? context.canMutate(props.message.id, kind) : true
  const pick = <K extends keyof P>(key: K, fallback: P[K]): P[K] =>
    props[key] !== undefined ? props[key] : fallback
  return {
    ...props,
    characterById: pick("characterById", context.characterById as P["characterById"]),
    directCharacter: pick("directCharacter", context.directCharacter as P["directCharacter"]),
    onCopy: pick("onCopy", context.onCopy as P["onCopy"]),
    onRegenerate: pick(
      "onRegenerate",
      (allows("regenerate") ? context.onRegenerate : undefined) as P["onRegenerate"]
    ),
    onEditResend: pick(
      "onEditResend",
      (allows("edit") ? context.onEditResend : undefined) as P["onEditResend"]
    ),
    onRewindFiles: pick("onRewindFiles", context.onRewindFiles as P["onRewindFiles"]),
    projectRoot: pick("projectRoot", context.projectRoot as P["projectRoot"]),
    messageDisplay: pick("messageDisplay", context.messageDisplay as P["messageDisplay"]),
    actionSheetHost: pick(
      "actionSheetHost",
      (context.actionSheet ? true : undefined) as P["actionSheetHost"]
    ),
  }
}
