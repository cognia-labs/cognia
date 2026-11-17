export type MessageActionCommandId =
  | "copy"
  | "share"
  | "copyLink"
  | "quote"
  | "reply"
  | "shareCard"
  | "bookmark"
  | "edit"
  | "resend"
  | "regenerate"
  | "readAloud"
  | "branch"
  | "truncate"
  | "restorePoint"
  | "bringBack"
  | "rerunTemplate"
  | "saveAsMemory"
  | "saveAsIssue"
  | "select"
  | "selectText"
  | "sendToMain"
  | "delete"

/**
 * Where a command sits on a pointer surface (D10, ADR-0114): on the row's
 * action bar, or in its "…" menu. A touch sheet lists every command, the bar's
 * first. With `messageDisplay.actions === "all"` the desktop bar draws both.
 */
export type MessageActionPlacement = "bar" | "menu"

export interface MessageActionCommandContext {
  role: "user" | "assistant" | "system"
  hasContent: boolean
  hasSession: boolean
  canEdit?: boolean
  canRegenerate?: boolean
  canReadAloud?: boolean
  canBringBack?: boolean
  /** This turn recorded the template parameters it was written from. */
  canRerunTemplate?: boolean
  /**
   * The turn's content can be kept as a pending memory draft.
   *
   * Assistant turns only. A user's own message is already theirs to save with
   * `/remember`; what has no path is the thing the AGENT worked out, which is
   * exactly what `lib/memory/agent-findings.ts` was built to take and what
   * nothing has ever called.
   */
  canSaveAsMemory?: boolean
  /**
   * The turn's content can be filed as a tracker issue (spec 2026-09-06 D9).
   * Assistant turns only, for the same reason as `canSaveAsMemory`: what a
   * reply found that still has to be done is the thing with no path.
   */
  canSaveAsIssue?: boolean
  /**
   * The transcript this turn sits in can enter selection mode: tick several
   * messages, then reference, summarize, copy or save them together.
   *
   * A capability the SURFACE supplies, not the message: only a surface that
   * mounts the selection mode passes it — the desktop transcript and the mobile
   * long-press sheet opened from one. A read-only transcript renders the same
   * rows without it, and so offers no "Select" that would open nothing.
   */
  canSelect?: boolean
  /**
   * The surface offers a sheet for selecting PART of the message's text.
   *
   * Touch only. Where the pointer can drag across the transcript, text is
   * selected in place and the selection capsule acts on it; on a phone a long
   * press opens the action sheet instead of selecting a word, so the sheet is
   * the way to a passage.
   */
  canSelectText?: boolean
  canDelete?: boolean
  /**
   * This row sits in a side chat that can send it straight to the main
   * conversation (as opposed to `canBringBack`, which leaves a draft there).
   */
  canSendToMain?: boolean
  /**
   * The commands the surface can carry out, when it supports only some: the
   * phone's view of a Host session can copy, share and read a message aloud,
   * but has no local transcript to branch, truncate or reply into. Absent
   * means every command the other capabilities allow.
   */
  allowed?: ReadonlySet<MessageActionCommandId>
  /**
   * The session is mid-turn (streaming or paused on an approval). Surfaces
   * should feed the SESSION's status, not a per-row flag: commands gated on
   * this rewrite or replay the transcript, which is unsafe while a turn is
   * in flight regardless of which message they hang off.
   */
  streaming?: boolean
}

export interface MessageActionCommand {
  id: MessageActionCommandId
  placement: MessageActionPlacement
  disabled?: boolean
  destructive?: boolean
}

/** The commands at one placement, in order. */
export function messageActionCommandsAt(
  commands: readonly MessageActionCommand[],
  placement: MessageActionPlacement
): MessageActionCommand[] {
  return commands.filter((command) => command.placement === placement)
}

/**
 * Host-owned command availability shared by pointer, keyboard, overflow, and
 * mobile long-press surfaces. Each surface supplies presentation and handlers;
 * this pure model supplies the same command set, its order, where each command
 * sits, and the safety flags. The bar's commands come first.
 */
export function resolveMessageActionCommands(
  context: MessageActionCommandContext
): MessageActionCommand[] {
  const bar: MessageActionCommand[] = []
  const menu: MessageActionCommand[] = []
  const add = (
    placement: MessageActionPlacement,
    id: MessageActionCommandId,
    flags: Pick<MessageActionCommand, "disabled" | "destructive"> = {}
  ) => {
    if (context.allowed && !context.allowed.has(id)) return
    ;(placement === "bar" ? bar : menu).push({ id, placement, ...flags })
  }
  const { role, hasContent, hasSession, streaming } = context

  // ── The bar: what a reader reaches for on this row ─────────────────────
  if (hasContent) add("bar", "copy")
  if (role === "user" && context.canEdit) {
    // Both replay the same `onEditResend` path: "edit" opens the draft first,
    // "resend" re-fires the recorded text unchanged. Disabled mid-turn — a
    // send now would land as a steer, leaving the branch the edit just
    // tagged with no replacement variant.
    add("bar", "edit", { disabled: streaming })
    add("bar", "resend", { disabled: streaming })
  }
  // A reply needs a conversation to answer into and words to quote: a
  // tool-only turn has nothing a preview could show (ADR-0177 batch 2).
  if (hasSession && hasContent) add("bar", "reply")
  // Only ever on the user's own turn: the values belong to the question, and
  // offering it on the answer would read as "regenerate", which is a different
  // command on the same bar.
  if (role === "user" && context.canRerunTemplate) {
    add("bar", "rerunTemplate", { disabled: streaming })
  }
  if (role === "assistant" && context.canSaveAsMemory && hasContent) {
    add("bar", "saveAsMemory", { disabled: streaming })
  }
  if (role === "assistant" && context.canSaveAsIssue && hasContent) {
    add("bar", "saveAsIssue", { disabled: streaming })
  }
  if (role === "assistant" && context.canRegenerate) {
    add("bar", "regenerate", { disabled: streaming })
  }
  if (role === "assistant" && context.canReadAloud) add("bar", "readAloud")

  // ── The "…" menu ─────────────────────────────────────────────────────────
  if (hasContent) add("menu", "share")
  if (hasContent && hasSession) add("menu", "quote")
  if (hasSession) add("menu", "copyLink")
  if (hasContent) add("menu", "shareCard")
  add("menu", "bookmark")
  // Content is not required: a turn that is only tool calls still carries the
  // output a combined reference exists to hand over. A session is — every bulk
  // action stages into, or files under, the conversation.
  if (hasSession && context.canSelect) add("menu", "select")
  // Words are required here, unlike above: the sheet shows the message's text
  // to select from, and a tool-only turn has none.
  if (hasSession && hasContent && context.canSelectText) add("menu", "selectText")
  if (hasSession) add("menu", "branch", { disabled: streaming })
  // One door to every way back to before the user's own turn — conversation
  // and files — with what each covers. Mid-turn it would rewrite what is still
  // being written, like the commands it gathers.
  if (role === "user" && hasSession) add("menu", "restorePoint", { disabled: streaming })
  if (hasSession) add("menu", "truncate", { disabled: streaming, destructive: true })
  if (context.canSendToMain && hasContent) add("menu", "sendToMain")
  if (context.canBringBack) add("menu", "bringBack")
  if (context.canDelete) add("menu", "delete", { destructive: true })
  return [...bar, ...menu]
}
