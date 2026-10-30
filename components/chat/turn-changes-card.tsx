"use client"

/** Historical turn changes, bound to their captured roots, runs and Host. */
import { useEffect, useMemo, useState } from "react"
import { FileDiffIcon, Undo2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { splitPath } from "@/components/source-control/status-decoration"
import { useTurnChanges } from "@/hooks/chat/use-turn-changes"
import { turnPatchRunId } from "@/lib/chat/restore-point"
import type {
  CodeAdoptionFile,
  CodeAdoptionRun,
  CodeAdoptionTurnRow,
} from "@/lib/code-adoption/types"
import { getTaskPatchSet, undoTaskWorkspace } from "@/lib/task-workspace/client"
import type { PatchSet } from "@/lib/task-workspace/types"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import type { ReviewScopeChoice } from "@/types/review"

export const TURN_CHANGES_PREVIEW = 6
export interface TurnChangesCardProps {
  sessionId: string
  messageId: string
}
export { turnPatchRunId }
interface RunPatch {
  run: CodeAdoptionRun
  patch: PatchSet | null
}
type PatchRead = { key: string; patches: RunPatch[] }

function recordedRuns(row: CodeAdoptionTurnRow): CodeAdoptionRun[] {
  if (row.measurement !== "taskWorkspace") return []
  if (row.taskWorkspaceRuns?.length) return row.taskWorkspaceRuns
  const runId = turnPatchRunId(row)
  return runId
    ? [{ runId, workspaceRoot: row.workspaceRoot, ...(row.origin ? { origin: row.origin } : {}) }]
    : []
}

function owns(file: CodeAdoptionFile, run: CodeAdoptionRun, runs: CodeAdoptionRun[]): boolean {
  return file.taskWorkspaceRunId
    ? file.taskWorkspaceRunId === run.runId
    : runs.length === 1 && (!file.workspaceRoot || file.workspaceRoot === run.workspaceRoot)
}

/** Patch metadata heals old cards that retained metrics but omitted uploads. */
function displayedFiles(
  row: CodeAdoptionTurnRow,
  patches: RunPatch[],
  runs: CodeAdoptionRun[]
): CodeAdoptionFile[] {
  const retained = row.capturedFiles ?? row.files
  if (patches.length === 0) return retained
  return runs.flatMap((run) => {
    const patch = patches.find((entry) => entry.run.runId === run.runId)?.patch
    if (!patch) return retained.filter((file) => owns(file, run, runs))
    return patch.files.map((file) => {
      const recorded = retained.find(
        (candidate) => candidate.path === file.path && owns(candidate, run, runs)
      )
      const added = file.hunks.reduce((sum, hunk) => sum + (hunk.additions ?? 0), 0)
      const removed = file.hunks.reduce((sum, hunk) => sum + (hunk.deletions ?? 0), 0)
      return {
        ...(recorded ?? {
          path: file.path,
          added,
          removed,
          isNew: file.kind === "created",
          hunks: [],
        }),
        taskWorkspaceRunId: run.runId,
        workspaceRoot: run.workspaceRoot,
        kind: file.kind,
        origin: file.origin ?? recorded?.origin ?? "unknown",
        statsKnown: recorded?.statsKnown ?? (!file.binary && file.hunks.length > 0),
      }
    })
  })
}

export function TurnChangesCard({ sessionId, messageId }: TurnChangesCardProps) {
  const row = useTurnChanges(sessionId, messageId, true)
  if (row?.trackingState === "unavailable") return <TurnChangesUnavailable />
  if (!row) return null
  if (
    row.totalFiles === 0 &&
    !row.capturedFiles?.length &&
    !recordedRuns(row).some((run) => run.origin)
  )
    return null
  return <TurnChangesCardBody key={row.id} sessionId={sessionId} row={row} />
}

function TurnChangesUnavailable() {
  const t = useTranslations("chat.turnChanges")
  return (
    <p
      role="note"
      className="mt-2 text-xs text-muted-foreground"
      data-testid="turn-changes-unavailable"
    >
      {t("trackingUnavailable")}
    </p>
  )
}

function TurnChangesCardBody({ sessionId, row }: { sessionId: string; row: CodeAdoptionTurnRow }) {
  const t = useTranslations("chat.turnChanges")
  const [showAll, setShowAll] = useState(false)
  const [undoTarget, setUndoTarget] = useState<CodeAdoptionRun | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [patchRead, setPatchRead] = useState<PatchRead | null>(null)
  const [patchEpoch, setPatchEpoch] = useState(0)
  const runs = useMemo(() => recordedRuns(row), [row])
  const key = JSON.stringify(runs)

  useEffect(() => {
    if (runs.length === 0) return
    let cancelled = false
    void Promise.all(
      runs.map(async (run): Promise<RunPatch> => {
        if (!run.origin) return { run, patch: null }
        try {
          const patch = await getTaskPatchSet(run.runId, run.origin)
          return { run, patch }
        } catch {
          return { run, patch: null }
        }
      })
    ).then((patches) => {
      if (!cancelled) setPatchRead({ key, patches })
    })
    return () => {
      cancelled = true
    }
  }, [runs, key, row.adoptionState, patchEpoch])

  const patches = useMemo(() => (patchRead?.key === key ? patchRead.patches : []), [patchRead, key])
  const allFiles = useMemo(() => displayedFiles(row, patches, runs), [row, patches, runs])
  const files = showAll ? allFiles : allFiles.slice(0, TURN_CHANGES_PREVIEW)
  const hidden = allFiles.length - files.length
  const added = allFiles.reduce((sum, file) => sum + file.added, 0)
  const removed = allFiles.reduce((sum, file) => sum + file.removed, 0)
  const reverted = row.capturedFiles
    ? patches.length === runs.length &&
      patches.length > 0 &&
      patches.every(({ patch }) => patch?.state === "reverted")
    : (patches.length === runs.length &&
        patches.length > 0 &&
        patches.every(({ patch }) => patch?.state === "reverted")) ||
      row.adoptionState === "reverted"
  const historical = runs.length > 0 && runs.every((run) => run.origin)
  const unavailable = !historical || (patches.length > 0 && patches.some(({ patch }) => !patch))
  const canUndo = (run: CodeAdoptionRun) => {
    const patch = patches.find((entry) => entry.run.runId === run.runId)?.patch
    const captured = allFiles.filter((file) => owns(file, run, runs))
    return Boolean(
      run.origin &&
      patch?.state === "applied" &&
      patch.reversible &&
      patch.appliedSelectionKnown === true &&
      !reverted &&
      captured.length === patch.files.length &&
      patch.files.every((file) => captured.some((candidate) => candidate.path === file.path)) &&
      (patch.appliedSelection ?? []).every((selection) =>
        captured.some((file) => file.path === selection.path)
      )
    )
  }

  const view = (file?: CodeAdoptionFile) => {
    const run = file ? runs.find((candidate) => owns(file, candidate, runs)) : runs[0]
    if (!run?.origin) return
    const scope: ReviewScopeChoice = {
      scope: "lastTurn",
      runId: run.runId,
      ...(run.origin ? { origin: run.origin } : {}),
      ...(!file && runs.length > 1 ? { runs } : {}),
    }
    useArtifactDockLayoutStore.getState().revealWorkspaceReview({
      sessionId,
      rootPath: run.workspaceRoot,
      scope,
      ...(file ? { relPath: file.path } : {}),
    })
  }

  const targetPatch = undoTarget
    ? patches.find(({ run }) => run.runId === undoTarget.runId)?.patch
    : null
  const targetFiles = undoTarget
    ? allFiles.filter(
        (file) =>
          owns(file, undoTarget, runs) &&
          (!targetPatch?.appliedSelection?.length ||
            targetPatch.appliedSelection.some((selection) => selection.path === file.path))
      )
    : []
  const userFiles = targetFiles.filter((file) => file.origin === "user").length
  const unattributedFiles = targetFiles.filter((file) => file.origin === "unknown").length
  const runUndo = async () => {
    const target = undoTarget
    if (!target || !canUndo(target)) return
    const count = targetFiles.length
    setUndoTarget(null)
    setUndoing(true)
    try {
      if (!target.origin) return
      const outcome = await undoTaskWorkspace(target.runId, target.origin)
      if (outcome.state === "reverted") toast.success(t("undoSuccess", { count }))
      else if (outcome.state === "conflict")
        toast.error(t("undoConflict", { count: outcome.conflicts.length }))
      else toast.error(t("undoNotApplied"))
    } catch (error) {
      toast.error(
        t("undoFailed", { error: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setUndoing(false)
      setPatchEpoch((value) => value + 1)
    }
  }

  if (allFiles.length === 0) return null

  return (
    <div
      className="not-prose mt-2 w-full overflow-hidden rounded-xl border bg-muted/20"
      data-testid="turn-changes-card"
      data-reverted={reverted}
    >
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted"
          aria-hidden
        >
          <FileDiffIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium" data-testid="turn-changes-title">
            {reverted
              ? t("reverted", { count: allFiles.length })
              : t("changed", { count: allFiles.length })}
          </p>
          <p className="font-mono text-xs" data-testid="turn-changes-total">
            <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{removed}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {runs.length === 1 && canUndo(runs[0]) ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1 text-xs"
              disabled={undoing}
              onClick={() => setUndoTarget(runs[0])}
              data-testid="turn-changes-undo"
            >
              {t("undo")}
              <Undo2Icon className="size-3.5" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={!historical}
            onClick={() => view()}
            data-testid="turn-changes-view"
          >
            {t("view")}
          </Button>
        </div>
      </div>
      {unavailable ? (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground" role="note">
          {t("historyUnavailable")}
        </p>
      ) : null}
      {runs.length > 1 ? (
        <div className="flex flex-col gap-1 border-t px-3 py-2">
          {runs.map((run) => (
            <div
              key={`${JSON.stringify(run.origin)}:${run.runId}`}
              className="flex min-w-0 items-center justify-between gap-2 text-xs"
            >
              <span className="truncate" title={run.workspaceRoot}>
                {run.workspaceRoot}
              </span>
              {canUndo(run) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={undoing}
                  onClick={() => setUndoTarget(run)}
                  aria-label={t("undoRoot", { root: run.workspaceRoot })}
                >
                  {t("undoRootAction")}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <ul className="border-t py-1" data-testid="turn-changes-files">
        {files.map((file) => {
          const { dir, name } = splitPath(file.path)
          return (
            <li
              key={`${file.taskWorkspaceRunId ?? "legacy"}:${file.workspaceRoot ?? ""}:${file.path}`}
            >
              <button
                type="button"
                className="flex min-h-9 w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent md:min-h-0 md:py-1.5"
                disabled={!historical}
                onClick={() => view(file)}
                title={runs.length > 1 ? `${file.workspaceRoot}/${file.path}` : file.path}
                data-testid={`turn-changes-file-${runs.length > 1 ? `${file.taskWorkspaceRunId}:` : ""}${file.path}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {runs.length > 1 ? (
                    <span className="mr-1 text-muted-foreground">{file.workspaceRoot}</span>
                  ) : null}
                  {dir ? <span className="text-muted-foreground">{dir}/</span> : null}
                  <span className="text-foreground">{name}</span>
                  {file.origin === "user" ? (
                    <span className="ml-2 text-muted-foreground">{t("userContribution")}</span>
                  ) : file.origin === "unknown" ? (
                    <span className="ml-2 text-muted-foreground">
                      {t("unattributedContribution")}
                    </span>
                  ) : null}
                </span>
                {file.statsKnown === false ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {t("statsUnavailable")}
                  </span>
                ) : (
                  <span className="shrink-0 font-mono text-[11px]">
                    <span className="text-emerald-600 dark:text-emerald-400">+{file.added}</span>{" "}
                    <span className="text-red-600 dark:text-red-400">−{file.removed}</span>
                  </span>
                )}
              </button>
            </li>
          )
        })}
        {hidden > 0 ? (
          <li>
            <button
              type="button"
              className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowAll(true)}
              data-testid="turn-changes-show-all"
            >
              {t("showAll", { count: hidden })}
            </button>
          </li>
        ) : null}
        {row.truncated ? (
          <li
            className="px-3 py-1 text-[11px] text-muted-foreground"
            data-testid="turn-changes-truncated"
          >
            {t("truncated")}
          </li>
        ) : null}
      </ul>
      {allFiles.some((file) => file.statsKnown === false) ? (
        <p className="px-3 pb-2 text-[11px] text-muted-foreground">{t("partialLineCounts")}</p>
      ) : null}
      <AlertDialog
        open={Boolean(undoTarget)}
        onOpenChange={(open) => {
          if (!open) setUndoTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(runs.length > 1 ? "undoRootConfirmTitle" : "undoConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {runs.length > 1
                ? t("undoRootConfirmDescription", {
                    root: undoTarget?.workspaceRoot ?? "",
                    count: targetFiles.length,
                  })
                : t("undoConfirmDescription", { count: targetFiles.length })}
              {userFiles > 0 ? ` ${t("undoUserContributions", { count: userFiles })}` : ""}
              {unattributedFiles > 0
                ? ` ${t("undoUnattributedContributions", { count: unattributedFiles })}`
                : ""}
            </AlertDialogDescription>
            <ul className="max-h-48 overflow-y-auto text-xs" aria-label={t("undoAppliedFiles")}>
              {targetFiles.map((file) => {
                const selectedHunks =
                  targetPatch?.appliedSelection?.find((selection) => selection.path === file.path)
                    ?.hunkIds.length ?? 0
                return (
                  <li key={file.path} className="break-all">
                    {file.path}
                    {selectedHunks > 0
                      ? ` · ${t("undoAppliedHunks", { count: selectedHunks })}`
                      : ""}
                  </li>
                )
              })}
            </ul>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="turn-changes-undo-confirm"
              onClick={() => void runUndo()}
            >
              {t("undoConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
