/**
 * Projects durable Task Workspace review decisions into local adoption rows.
 * Patch bodies never enter Dexie: partial-apply accounting uses only the
 * per-hunk added/deleted counters persisted by the patch ledger.
 */

import type { PatchSet, TaskWorkspaceOrigin } from "@/lib/task-workspace/types"

import {
  assertCodeAdoptionDatabaseScope,
  captureCodeAdoptionDatabaseScope,
  getCodeAdoptionTurnByTaskWorkspaceRun,
  persistCodeAdoptionTurn,
} from "./persist"
import type { CodeAdoptionFile, CodeAdoptionState, CodeAdoptionTurnRow } from "./types"

export type TaskWorkspaceOutcomeKind = "apply" | "undo" | "keepCurrent"

function zeroAccepted(file: CodeAdoptionFile, state: CodeAdoptionState): CodeAdoptionFile {
  return { ...file, acceptedAdded: 0, acceptedRemoved: 0, adoptionState: state }
}

function acceptedFile(
  file: CodeAdoptionFile,
  patch: PatchSet["files"][number] | undefined,
  hunkIds: string[] | null
): CodeAdoptionFile {
  if (hunkIds === null || hunkIds.length === 0) {
    return {
      ...file,
      acceptedAdded: file.added,
      acceptedRemoved: file.removed,
      adoptionState: "accepted",
    }
  }
  const selected = new Set(hunkIds)
  const hunks = patch?.hunks.filter((hunk) => selected.has(hunk.id)) ?? []
  const acceptedAdded = Math.min(
    file.added,
    hunks.reduce((sum, hunk) => sum + (hunk.additions ?? 0), 0)
  )
  const acceptedRemoved = Math.min(
    file.removed,
    hunks.reduce((sum, hunk) => sum + (hunk.deletions ?? 0), 0)
  )
  const complete = acceptedAdded === file.added && acceptedRemoved === file.removed
  return {
    ...file,
    acceptedAdded,
    acceptedRemoved,
    adoptionState: complete ? "accepted" : "partiallyAccepted",
  }
}

function summarize(row: CodeAdoptionTurnRow, files: CodeAdoptionFile[]): CodeAdoptionTurnRow {
  const acceptedAdded = files.reduce((sum, file) => sum + (file.acceptedAdded ?? 0), 0)
  const acceptedRemoved = files.reduce((sum, file) => sum + (file.acceptedRemoved ?? 0), 0)
  const acceptedFiles = files.filter(
    (file) => file.adoptionState === "accepted" || file.adoptionState === "partiallyAccepted"
  ).length
  const proposedFiles = row.proposedFiles ?? row.totalFiles
  const proposedAdded = row.proposedAdded ?? row.totalAdded
  const proposedRemoved = row.proposedRemoved ?? row.totalRemoved
  const complete =
    acceptedFiles === proposedFiles &&
    acceptedAdded === proposedAdded &&
    acceptedRemoved === proposedRemoved
  const state: CodeAdoptionState =
    files.length === 0
      ? "notApplicable"
      : files.every((file) => file.adoptionState === "reverted")
        ? "reverted"
        : files.every((file) => file.adoptionState === "rejected")
          ? "rejected"
          : acceptedFiles === 0 && files.some((file) => file.adoptionState === "pending")
            ? "pending"
            : complete
              ? "accepted"
              : "partiallyAccepted"
  return {
    ...row,
    files,
    proposedFiles,
    proposedAdded,
    proposedRemoved,
    acceptedFiles,
    acceptedAdded,
    acceptedRemoved,
    adoptionState: state,
    adoptionReason: undefined,
  }
}

/** Best-effort caller: failures must never alter the already-completed apply/undo action. */
export async function recordTaskWorkspaceOutcome(
  patch: PatchSet,
  kind: TaskWorkspaceOutcomeKind = patch.state === "reverted" ? "undo" : "apply",
  origin?: TaskWorkspaceOrigin,
  databaseScope = captureCodeAdoptionDatabaseScope()
): Promise<void> {
  const row = await getCodeAdoptionTurnByTaskWorkspaceRun(patch.runId, origin, databaseScope)
  assertCodeAdoptionDatabaseScope(databaseScope)
  if (!row || row.measurement !== "taskWorkspace") return

  const ownsFile = (file: CodeAdoptionFile) =>
    (file.taskWorkspaceRunId ?? row.taskWorkspaceRunId) === patch.runId

  if (kind === "undo" || kind === "keepCurrent" || patch.state === "reverted") {
    const state: CodeAdoptionState = kind === "keepCurrent" ? "rejected" : "reverted"
    const files = row.files.map((file) => (ownsFile(file) ? zeroAccepted(file, state) : file))
    await persistCodeAdoptionTurn(
      {
        ...summarize(row, files),
        ...(row.capturedFiles
          ? {
              capturedFiles: row.capturedFiles.map((file) =>
                ownsFile(file) ? zeroAccepted(file, state) : file
              ),
            }
          : {}),
      },
      databaseScope
    )
    return
  }
  if (patch.state !== "applied") return
  if (patch.appliedSelectionKnown !== true) {
    await persistCodeAdoptionTurn(
      {
        ...summarize(
          row,
          row.files.map((file) => (ownsFile(file) ? zeroAccepted(file, "unavailable") : file))
        ),
        adoptionState: "unavailable",
        adoptionReason: "appliedSelectionUnknown",
        ...(row.capturedFiles
          ? {
              capturedFiles: row.capturedFiles.map((file) =>
                ownsFile(file) ? zeroAccepted(file, "unavailable") : file
              ),
            }
          : {}),
      },
      databaseScope
    )
    return
  }

  const appliesAll = (patch.appliedSelection?.length ?? 0) === 0
  const selections = new Map(
    (patch.appliedSelection ?? []).map((selection) => [selection.path, selection.hunkIds])
  )
  const files = row.files.map((file) => {
    if (!ownsFile(file)) return file
    const selected = appliesAll ? null : selections.get(file.path)
    if (selected === undefined) return zeroAccepted(file, "rejected")
    return acceptedFile(
      file,
      patch.files.find((candidate) => candidate.path === file.path),
      selected
    )
  })
  const capturedFiles = row.capturedFiles?.map((file) => {
    if (!ownsFile(file)) return file
    const selected = appliesAll ? null : selections.get(file.path)
    return selected === undefined
      ? zeroAccepted(file, "rejected")
      : acceptedFile(
          file,
          patch.files.find((candidate) => candidate.path === file.path),
          selected
        )
  })
  await persistCodeAdoptionTurn(
    {
      ...summarize(row, files),
      ...(capturedFiles ? { capturedFiles } : {}),
    },
    databaseScope
  )
}
