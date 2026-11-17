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
 * The bar commands that fold into the "…" menu when the message row is
 * narrow, the first listed folding first. Copy never folds, and read-aloud
 * does not either: it is a live toggle with its own progress, which a menu
 * item that closes on select could not show.
 */
const BAR_FOLD_ORDER: readonly MessageActionCommandId[] = [
  "saveAsIssue",
  "saveAsMemory",
  "rerunTemplate",
  "resend",
  "reply",
  "edit",
  "regenerate",
]

/** Width the action line keeps for the run summary, gaps and branch arrows. */
export const ACTION_FOLD_RESERVE_REM = 10
/** One bar button with its gap (`size-8` + `gap-1`). */
export const ACTION_BUTTON_REM = 2.25

/**
 * The class that hides a bar command below the row width its slot needs,
 * indexed by how many buttons the line holds once that command is on it:
 * `ACTION_FOLD_RESERVE_REM + n × ACTION_BUTTON_REM`. Whole literals, because
 * Tailwind only generates the container queries it finds verbatim; the
 * container is the message row (`@container/msgrow`). A test pins each one to
 * its number, so the CSS and {@link foldedBarCommandIds} cannot drift.
 */
export const BAR_FOLD_HIDE_CLASS: readonly string[] = [
  "",
  "@max-[12.25rem]/msgrow:hidden",
  "@max-[14.5rem]/msgrow:hidden",
  "@max-[16.75rem]/msgrow:hidden",
  "@max-[19rem]/msgrow:hidden",
  "@max-[21.25rem]/msgrow:hidden",
  "@max-[23.5rem]/msgrow:hidden",
  "@max-[25.75rem]/msgrow:hidden",
  "@max-[28rem]/msgrow:hidden",
  "@max-[30.25rem]/msgrow:hidden",
  "@max-[32.5rem]/msgrow:hidden",
  "@max-[34.75rem]/msgrow:hidden",
  "@max-[37rem]/msgrow:hidden",
  "@max-[39.25rem]/msgrow:hidden",
]

/** Row width, in rem, below which a command needing `buttons` slots folds. */
export function barFoldThresholdRem(buttons: number): number {
  return ACTION_FOLD_RESERVE_REM + buttons * ACTION_BUTTON_REM
}

/**
 * How many buttons the line holds once each foldable bar command is on it.
 * The ones that never fold, the reaction picker and the "…" itself are always
 * there; the foldable ones are added last-to-fold first. A command missing
 * from the map never folds.
 */
export function barFoldNeeds(
  bar: readonly MessageActionCommand[]
): Map<MessageActionCommandId, number> {
  const foldable = BAR_FOLD_ORDER.filter((id) => bar.some((command) => command.id === id))
  // + the reaction picker and the "…" trigger.
  const fixed = bar.length - foldable.length + 2
  const needs = new Map<MessageActionCommandId, number>()
  foldable.forEach((id, rank) => {
    needs.set(id, Math.min(fixed + foldable.length - rank, BAR_FOLD_HIDE_CLASS.length - 1))
  })
  return needs
}

/** The hide class for one bar command ("" for one that never folds). */
export function barFoldHideClass(
  needs: ReadonlyMap<MessageActionCommandId, number>,
  id: MessageActionCommandId
): string {
  const n = needs.get(id)
  return n === undefined ? "" : (BAR_FOLD_HIDE_CLASS[n] ?? "")
}

/**
 * The bar commands the row's width has folded away, in bar order, for the
 * "…" menu to list first. Uses the thresholds the hide classes encode. A row
 * that has not been laid out (width 0) folds nothing.
 */
export function foldedBarCommandIds(
  bar: readonly MessageActionCommand[],
  rowWidthPx: number,
  remPx = 16
): MessageActionCommandId[] {
  if (!(rowWidthPx > 0) || !(remPx > 0)) return []
  const needs = barFoldNeeds(bar)
  return bar
    .filter((command) => {
      const n = needs.get(command.id)
      return n !== undefined && rowWidthPx < barFoldThresholdRem(n) * remPx
    })
    .map((command) => command.id)
}

/**
 * What a thumb reaches for first on the touch sheet, in this order. The sheet
 * draws the first {@link MESSAGE_SHEET_PRIMARY_MAX} of these that the message
 * offers as one strip above the list, so the common actions never sit below
 * the fold of a long list (D15).
 */
const SHEET_PRIMARY_ORDER: readonly MessageActionCommandId[] = [
  "copy",
  "edit",
  "regenerate",
  "reply",
  "share",
  "readAloud",
  "quote",
]

/** How many commands the touch sheet's primary strip holds. */
export const MESSAGE_SHEET_PRIMARY_MAX = 4

/**
 * Split the resolved commands for the touch sheet: the primary strip, in
 * {@link SHEET_PRIMARY_ORDER}, and every other command in its resolved order.
 * A destructive command is never primary.
 */
export function splitSheetCommands(
  commands: readonly MessageActionCommand[],
  max: number = MESSAGE_SHEET_PRIMARY_MAX
): { primary: MessageActionCommand[]; rest: MessageActionCommand[] } {
  const byId = new Map(commands.map((command) => [command.id, command]))
  const primary: MessageActionCommand[] = []
  for (const id of SHEET_PRIMARY_ORDER) {
    if (primary.length >= max) break
    const command = byId.get(id)
    if (command && !command.destructive) primary.push(command)
  }
  const taken = new Set(primary.map((command) => command.id))
  return { primary, rest: commands.filter((command) => !taken.has(command.id)) }
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
