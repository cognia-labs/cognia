"use client"

/**
 * "Restore to here": every way back to before one user message, in one place,
 * each saying what it covers.
 *
 * The mechanisms already existed as separate buttons — edit (keeps the
 * original as a branch), branch, delete-from-here, the per-turn Undo card, the
 * SDK checkpoint icon — and none of them said what the others cover, so a user
 * could not tell whether "back to here" would restore files, conversation, or
 * both. This dialog is the map: the conversation half (edit / branch / delete)
 * and the files half (undo every later turn's ledger patch, or rewind an SDK
 * checkpoint), with a plain reason whenever an option is not available.
 *
 * It owns no mechanism of its own. Conversation choices hand back to the
 * message row, which already holds the edit box and the branch and delete
 * dialogs; file restore runs the same `undoTaskWorkspace` the turn card uses
 * (`lib/chat/restore-point.ts` plans the order) and the existing
 * `CheckpointAction`.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { GitBranchIcon, PencilIcon, ScissorsIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { CheckpointAction, useSdkCheckpointCapability } from "@/components/chat/checkpoint-action"
import {
  assistantMessagesAfter,
  planFileRestore,
  runFileRestore,
  turnPatchRunId,
  type FileRestorePlan,
  type RestoreTurnState,
} from "@/lib/chat/restore-point"
import { getCodeAdoptionTurnForMessage } from "@/lib/code-adoption/persist"
import { getTaskPatchSet, undoTaskWorkspace } from "@/lib/task-workspace/client"
import type { RewindFilesResult } from "@/lib/claude/ipc"
import { selectVisibleMessages, useChatStore } from "@/stores/chat"

export interface RestorePointDialogProps {
  sessionId: string
  messageId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The session is mid-turn: rewriting the conversation or the tree is refused. */
  busy?: boolean
  /** Open this message's edit box; absent where editing is not offered. */
  onEdit?: () => void
  /** Open the branch dialog at this message. */
  onBranch?: () => void
  /** Open the delete-from-here confirmation. */
  onTruncate?: () => void
  /**
   * The Agent SDK checkpoint for this message. `eligible` is false when the
   * turn did not run on the SDK; the dialog then says why the option is absent.
   */
  checkpoint?: {
    eligible: boolean
    rewindFiles: (checkpointId: string, dryRun: boolean) => Promise<RewindFilesResult>
  }
}

async function loadRestoreTurns(
  sessionId: string,
  assistantIds: readonly string[]
): Promise<RestoreTurnState[]> {
  const states: RestoreTurnState[] = []
  for (const messageId of assistantIds) {
    const row = await getCodeAdoptionTurnForMessage(sessionId, messageId)
    if (!row) throw new Error("Turn change record is unavailable")
    const runId = turnPatchRunId(row)
    const runs =
      row.taskWorkspaceRuns ??
      (runId ? [{ runId, workspaceRoot: row.workspaceRoot, origin: row.origin }] : [])
    if (runs.length === 0) states.push({ row, patch: null })
    for (const run of runs) {
      const patch = run.origin
        ? await getTaskPatchSet(run.runId, run.origin).catch(() => null)
        : null
      states.push({ row, run, patch })
    }
  }
  return states
}

export function RestorePointDialog({
  sessionId,
  messageId,
  open,
  onOpenChange,
  busy = false,
  onEdit,
  onBranch,
  onTruncate,
  checkpoint,
}: RestorePointDialogProps) {
  const t = useTranslations("chat.restorePoint")
  const tChanges = useTranslations("chat.turnChanges")
  const checkpointsOn = useSdkCheckpointCapability()
  const slice = useChatStore((state) => state.sessions[sessionId])
  const assistantIds = useMemo(
    () =>
      slice
        ? assistantMessagesAfter(
            selectVisibleMessages(slice.messages, slice.activeBranchByGroup),
            messageId
          )
        : [],
    [slice, messageId]
  )
  // Keyed by the replies it was computed for, so a reply landing while the
  // dialog is open re-plans instead of acting on a stale list.
  const assistantKey = JSON.stringify([sessionId, assistantIds])
  const [planned, setPlanned] = useState<{ key: string; plan: FileRestorePlan } | null>(null)
  const [epoch, setEpoch] = useState(0)
  const [confirmFiles, setConfirmFiles] = useState(false)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    loadRestoreTurns(sessionId, assistantIds)
      .then((states) => {
        if (!cancelled) setPlanned({ key: assistantKey, plan: planFileRestore(states) })
      })
      .catch(() => {
        if (!cancelled)
          setPlanned({
            key: assistantKey,
            plan: { kind: "blocked", reason: "untracked", turns: assistantIds.length, files: 0 },
          })
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId, assistantKey, assistantIds, epoch])

  const plan = planned?.key === assistantKey ? planned.plan : null
  const targets = plan?.kind === "undoable" ? plan.targets : []
  const targetFiles = targets.flatMap((target) => target.files)
  const userContributions = targetFiles.filter((file) => file.origin === "user").length
  const unknownContributions = targetFiles.filter((file) => file.origin === "unknown").length

  const choose = useCallback(
    (action: (() => void) | undefined) => {
      onOpenChange(false)
      action?.()
    },
    [onOpenChange]
  )

  const restoreFiles = async () => {
    if (plan?.kind !== "undoable") return
    setConfirmFiles(false)
    setRestoring(true)
    try {
      const outcome = await runFileRestore(plan.runIds, undoTaskWorkspace, plan.runRefs)
      if (outcome.state === "reverted") {
        toast.success(t("files.restored", { turns: plan.turns }))
      } else if (outcome.state === "conflict") {
        toast.error(t("files.conflict", { undone: outcome.undone, count: outcome.conflicts }))
      } else {
        toast.error(t("files.notReverted", { undone: outcome.undone }))
      }
    } catch (error) {
      toast.error(
        t("files.failed", { error: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setRestoring(false)
      setEpoch((value) => value + 1)
    }
  }

  const checkpointReason = !checkpoint
    ? null
    : !checkpoint.eligible
      ? t("files.checkpointSdkOnly")
      : !checkpointsOn
        ? t("files.checkpointOff")
        : null

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg" data-testid="restore-point-dialog">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <section className="space-y-2" aria-labelledby="restore-conversation-heading">
            <h3
              id="restore-conversation-heading"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("conversation.heading")}
            </h3>
            {busy ? (
              <p className="text-xs text-muted-foreground" data-testid="restore-point-busy">
                {t("busy")}
              </p>
            ) : null}
            {onEdit ? (
              <RestoreRow
                icon={<PencilIcon className="size-4" aria-hidden />}
                title={t("conversation.edit")}
                detail={t("conversation.editDetail")}
                action={t("conversation.editAction")}
                disabled={busy}
                onAction={() => choose(onEdit)}
                testId="restore-point-edit"
              />
            ) : null}
            {onBranch ? (
              <RestoreRow
                icon={<GitBranchIcon className="size-4" aria-hidden />}
                title={t("conversation.branch")}
                detail={t("conversation.branchDetail")}
                action={t("conversation.branchAction")}
                disabled={busy}
                onAction={() => choose(onBranch)}
                testId="restore-point-branch"
              />
            ) : null}
            {onTruncate ? (
              <RestoreRow
                icon={<ScissorsIcon className="size-4" aria-hidden />}
                title={t("conversation.truncate")}
                detail={t("conversation.truncateDetail")}
                action={t("conversation.truncateAction")}
                destructive
                disabled={busy}
                onAction={() => choose(onTruncate)}
                testId="restore-point-truncate"
              />
            ) : null}
          </section>

          <section className="space-y-2" aria-labelledby="restore-files-heading">
            <h3 id="restore-files-heading" className="text-xs font-medium text-muted-foreground">
              {t("files.heading")}
            </h3>
            <div className="rounded-md border p-3 text-sm" data-testid="restore-point-files">
              {plan === null ? (
                <p className="text-muted-foreground">{t("files.loading")}</p>
              ) : plan.kind === "none" ? (
                <p className="text-muted-foreground">{t("files.none")}</p>
              ) : plan.kind === "undone" ? (
                <p className="text-muted-foreground">{t("files.alreadyUndone")}</p>
              ) : plan.kind === "blocked" ? (
                <p className="text-muted-foreground" data-reason={plan.reason}>
                  {t(`files.blocked.${plan.reason}`, { files: plan.files, turns: plan.turns })}
                </p>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <p>{t("files.undoable", { files: plan.files, turns: plan.turns })}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || restoring}
                    onClick={() => setConfirmFiles(true)}
                    data-testid="restore-point-undo-files"
                  >
                    {t("files.undoAction")}
                  </Button>
                </div>
              )}
            </div>
            {/* Only where this surface can rewind at all; a surface without
                the SDK control shows no row rather than a reason that does not
                apply to it. */}
            {checkpoint ? (
              <div className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                <div className="min-w-0">
                  <p>{t("files.checkpoint")}</p>
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="restore-point-checkpoint"
                  >
                    {checkpointReason ?? t("files.checkpointDetail")}
                  </p>
                </div>
                {!checkpointReason ? (
                  <CheckpointAction
                    checkpointId={messageId}
                    enabled={!busy}
                    rewindFiles={checkpoint.rewindFiles}
                    triggerLabel={t("files.checkpointAction")}
                  />
                ) : null}
              </div>
            ) : null}
          </section>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmFiles} onOpenChange={setConfirmFiles}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("files.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {plan?.kind === "undoable"
                ? t("files.confirmBody", { files: plan.files, turns: plan.turns })
                : null}
              {userContributions > 0 ? (
                <span className="mt-1 block">
                  {tChanges("undoUserContributions", { count: userContributions })}
                </span>
              ) : null}
              {unknownContributions > 0 ? (
                <span className="mt-1 block">
                  {tChanges("undoUnattributedContributions", { count: unknownContributions })}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <section
            className="max-h-64 overflow-y-auto text-sm"
            aria-label={t("files.scopeHeading")}
          >
            {targets.map((target, index) => (
              <div key={`${JSON.stringify(target.run)}:${index}`} className="mb-3 space-y-1">
                <p className="break-all font-medium">{target.run.workspaceRoot}</p>
                <p className="text-xs text-muted-foreground">
                  {target.run.origin?.kind === "remote"
                    ? t("files.scopeHost", { host: target.run.origin.hostId })
                    : t("files.scopeLocal")}
                </p>
                {target.run.origin?.kind === "remote" && target.run.origin.accountId ? (
                  <p className="text-xs text-muted-foreground">
                    {t("files.scopeAccount", { account: target.run.origin.accountId })}
                  </p>
                ) : null}
                <ul
                  className="space-y-1"
                  aria-label={t("files.scopeFiles", { root: target.run.workspaceRoot })}
                >
                  {target.files.map((file) => (
                    <li key={file.path} className="break-all text-xs">
                      <span>{file.path}</span>
                      {file.origin === "user" ? (
                        <span className="ml-2 text-muted-foreground">
                          {tChanges("userContribution")}
                        </span>
                      ) : null}
                      {file.origin === "unknown" ? (
                        <span className="ml-2 text-muted-foreground">
                          {tChanges("unattributedContribution")}
                        </span>
                      ) : null}
                      {file.hunkIds.length > 0 ? (
                        <span className="ml-2 text-muted-foreground">
                          {tChanges("undoAppliedHunks", { count: file.hunkIds.length })}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void restoreFiles()}
              data-testid="restore-point-undo-confirm"
            >
              {t("files.undoAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function RestoreRow({
  icon,
  title,
  detail,
  action,
  onAction,
  disabled,
  destructive,
  testId,
}: {
  icon: React.ReactNode
  title: string
  detail: string
  action: string
  onAction: () => void
  disabled?: boolean
  destructive?: boolean
  testId: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <div className="min-w-0">
          <p>{title}</p>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={onAction}
        data-testid={testId}
        className={destructive ? "text-destructive hover:text-destructive" : undefined}
      >
        {action}
      </Button>
    </div>
  )
}
