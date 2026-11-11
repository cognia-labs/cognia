import type { IrreversibleReason, PatchSet } from "./types"

/** Message keys under `artifacts.workspace.taskResources` that say why Undo is off. */
export type UndoUnavailableKey =
  | "undoUnavailableIrreversible"
  | "undoUnavailableStopUnproven"
  | "undoUnavailableOverlap"
  | "undoUnavailablePathUnsupported"
  | "undoUnavailableFidelityUnknown"
  | "undoUnavailableUnknownReason"

const KEY_BY_REASON: Record<IrreversibleReason, UndoUnavailableKey> = {
  capacity: "undoUnavailableIrreversible",
  stopUnproven: "undoUnavailableStopUnproven",
  overlap: "undoUnavailableOverlap",
  pathUnsupported: "undoUnavailablePathUnsupported",
  fidelityUnknown: "undoUnavailableFidelityUnknown",
}

/**
 * The message that explains why a patch cannot be undone, or null when it can.
 * A patch without a reason, or with one this build does not know, is still not
 * reversible and gets the unknown-reason message.
 */
export function undoUnavailableKey(
  patch: Pick<PatchSet, "reversible" | "irreversibleReason"> | null | undefined
): UndoUnavailableKey | null {
  if (patch?.reversible !== false) return null
  const reason = patch.irreversibleReason
  return (reason && KEY_BY_REASON[reason]) || "undoUnavailableUnknownReason"
}
