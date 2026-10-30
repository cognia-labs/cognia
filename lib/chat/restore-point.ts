/**
 * "Go back to before this message" — what can actually be restored, and how.
 *
 * Restoring sits on several mechanisms that each cover part of the job:
 * editing a message keeps the original as a branch, branching copies the
 * thread up to a point, truncating deletes the tail, a turn's Undo reverts the
 * files that one turn changed, and an Agent SDK checkpoint rewinds files for
 * SDK turns when checkpointing is on. Offered as separate buttons, none of them
 * says what the others cover, so a user cannot tell what "back to here" would
 * give them. This module answers that for one user message; the restore
 * dialog (`components/chat/restore-point-dialog.tsx`) shows the answer and
 * routes each choice to the mechanism that owns it.
 *
 * Files are restored through the Task Workspace ledger — the same per-turn
 * patch the turn card's Undo reverts — newest turn first, so each undo applies
 * against the state the next-newer one left. That works for every runtime the
 * ledger measured, not only SDK sessions with checkpointing switched on.
 */

import type { UIMessage } from "ai"

import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import type {
  ApplyOutcome,
  ContributionOrigin,
  PatchSet,
  TaskWorkspaceOrigin,
  TaskWorkspaceRunRef,
} from "@/lib/task-workspace/types"

/** The Task Workspace run whose patch is this turn's diff, when there is one. */
export function turnPatchRunId(row: CodeAdoptionTurnRow): string | null {
  return row.measurement === "taskWorkspace" && row.taskWorkspaceRunId
    ? row.taskWorkspaceRunId
    : null
}

/**
 * The assistant messages after `messageId` in `messages` (pass the VISIBLE
 * thread), oldest first: the turns whose changes a restore to before this
 * message would take back. Empty when the message is not in the list.
 */
export function assistantMessagesAfter(
  messages: readonly Pick<UIMessage, "id" | "role">[],
  messageId: string
): string[] {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) return []
  return messages
    .slice(index + 1)
    .filter((message) => message.role === "assistant")
    .map((message) => message.id)
}

/** One later turn's change record and the current state of its patch. */
export interface RestoreTurnState {
  row: CodeAdoptionTurnRow
  run?: TaskWorkspaceRunRef
  /** `null` when the turn has no ledger patch or it could not be read. */
  patch: PatchSet | null
}

export type FileRestoreBlock =
  /** A turn changed files the ledger only fingerprinted: there is no patch to revert. */
  | "untracked"
  /** A turn's patch kept no inverse, or is not in an applied state. */
  | "irreversible"

/** The same captured scope drives both confirmation and mutation. */
export interface FileRestoreTarget {
  run: TaskWorkspaceRunRef
  files: Array<{ path: string; origin: ContributionOrigin; hunkIds: string[] }>
}

export type FileRestorePlan =
  /** No file changes were recorded after this message. */
  | { kind: "none" }
  /** Every change after this message has already been undone. */
  | { kind: "undone" }
  /** Revertible: these runs, newest first. */
  | {
      kind: "undoable"
      runIds: string[]
      runRefs?: TaskWorkspaceRunRef[]
      targets: FileRestoreTarget[]
      turns: number
      files: number
    }
  /** At least one turn cannot be reverted; nothing is undone. */
  | { kind: "blocked"; reason: FileRestoreBlock; turns: number; files: number }

/**
 * Decide whether the files changed after a message can be restored, from the
 * later turns' records (oldest first). All or nothing: undoing only the turns
 * that happen to be revertible would leave the tree in a state no point in
 * the conversation ever had.
 */
export function planFileRestore(states: readonly RestoreTurnState[]): FileRestorePlan {
  if (
    states.some(
      ({ row }) =>
        row.trackingState === "unavailable" ||
        row.trackingState === "truncated" ||
        row.measurement === "unavailable"
    )
  ) {
    return {
      kind: "blocked",
      reason: "untracked",
      turns: new Set(states.map(({ row }) => row.id)).size,
      files: new Set(
        states.flatMap(({ row }) =>
          (row.capturedFiles ?? row.files).map((file) =>
            JSON.stringify([file.workspaceRoot ?? row.workspaceRoot, file.path])
          )
        )
      ).size,
    }
  }
  const changed = states.filter(
    ({ row, patch }) =>
      (row.totalFiles > 0 ||
        (row.capturedFiles?.length ?? 0) > 0 ||
        (patch?.files.length ?? 0) > 0) &&
      row.trackingState !== "unavailable"
  )
  if (changed.length === 0) return { kind: "none" }
  const pending = changed.filter(
    ({ row, patch, run }) =>
      patch?.state !== "reverted" && (run ? true : row.adoptionState !== "reverted")
  )
  if (pending.length === 0) return { kind: "undone" }
  const paths = new Set(
    pending.flatMap(({ row, run, patch }) => {
      if (patch?.files?.length) {
        const selected = new Set(patch.appliedSelection?.map((selection) => selection.path) ?? [])
        return patch.files
          .filter((file) => selected.size === 0 || selected.has(file.path))
          .map((file) =>
            JSON.stringify([
              run?.origin ?? row.origin,
              run?.workspaceRoot ?? row.workspaceRoot,
              file.path,
            ])
          )
      }
      return (row.capturedFiles ?? row.files)
        .filter((file) => !run || !file.taskWorkspaceRunId || file.taskWorkspaceRunId === run.runId)
        .map((file) =>
          JSON.stringify([
            run?.origin ?? row.origin,
            file.workspaceRoot ?? row.workspaceRoot,
            file.path,
          ])
        )
    })
  )
  const files = paths.size || pending.reduce((sum, { row }) => sum + row.totalFiles, 0)
  for (const { row, patch } of pending) {
    if (!turnPatchRunId(row) || !patch) {
      return { kind: "blocked", reason: "untracked", turns: pending.length, files }
    }
    if (patch.state !== "applied" || !patch.reversible || patch.appliedSelectionKnown !== true) {
      return { kind: "blocked", reason: "irreversible", turns: pending.length, files }
    }
  }
  const ordered = [...pending].reverse()
  const targets: FileRestoreTarget[] = ordered.map(({ row, run, patch }) => {
    const ref = run ?? {
      runId: turnPatchRunId(row)!,
      workspaceRoot: row.workspaceRoot,
      origin: row.origin,
    }
    const retained = (row.capturedFiles ?? row.files).filter(
      (file) =>
        (!file.taskWorkspaceRunId || file.taskWorkspaceRunId === ref.runId) &&
        (!file.workspaceRoot || file.workspaceRoot === ref.workspaceRoot)
    )
    const selected = new Map(
      patch?.appliedSelection?.map((entry) => [entry.path, entry.hunkIds]) ?? []
    )
    const captured = patch?.files.length ? patch.files : retained
    return {
      run: ref,
      files: captured
        .filter((file) => selected.size === 0 || selected.has(file.path))
        .map((file) => ({
          path: file.path,
          origin:
            file.origin ?? retained.find((entry) => entry.path === file.path)?.origin ?? "unknown",
          hunkIds: selected.get(file.path) ?? [],
        })),
    }
  })
  const runIds = ordered.map(({ row, run }) => run?.runId ?? turnPatchRunId(row)!)
  return {
    kind: "undoable",
    runIds,
    targets,
    ...(ordered.some(({ run }) => run)
      ? {
          runRefs: ordered.map(
            ({ row, run }) =>
              run ?? {
                runId: turnPatchRunId(row)!,
                workspaceRoot: row.workspaceRoot,
                origin: row.origin,
              }
          ),
        }
      : {}),
    turns: new Set(pending.map(({ row }) => row.id)).size,
    files,
  }
}

export type FileRestoreOutcome =
  | { state: "reverted"; undone: number }
  /** Stopped at `runId`: a later edit conflicts with its inverse. */
  | { state: "conflict"; undone: number; runId: string; conflicts: number }
  /** Stopped at `runId`: the ledger did not revert it (already moved on). */
  | { state: "notReverted"; undone: number; runId: string }

/**
 * Undo `runIds` (newest first) one at a time, stopping at the first that does
 * not revert cleanly — the ledger reports a conflict rather than overwriting a
 * later edit, and continuing past it would undo older turns underneath it.
 */
export async function runFileRestore(
  runIds: readonly string[],
  undo: (runId: string, origin?: TaskWorkspaceOrigin) => Promise<ApplyOutcome>,
  runRefs?: readonly TaskWorkspaceRunRef[]
): Promise<FileRestoreOutcome> {
  let undone = 0
  for (const [index, runId] of runIds.entries()) {
    const origin = runRefs?.[index]?.origin
    const outcome = origin ? await undo(runId, origin) : await undo(runId)
    if (outcome.state === "conflict") {
      return { state: "conflict", undone, runId, conflicts: outcome.conflicts.length }
    }
    if (outcome.state !== "reverted") return { state: "notReverted", undone, runId }
    undone += 1
  }
  return { state: "reverted", undone }
}
