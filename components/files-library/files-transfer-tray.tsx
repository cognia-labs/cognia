"use client"

/**
 * Session-scoped Files transfer tray (G03): surfaces per-file upload and zip
 * export progress, cancellation, retry on failed/cancelled items, and quick
 * cleanup of finished items without persisting `File` blobs in IndexedDB.
 */

import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  ArchiveIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  Loader2Icon,
  RotateCcwIcon,
  UploadIcon,
  XIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { formatBytes } from "@/lib/storage/usage"
import { cn } from "@/lib/utils"
import { useFilesTransferStore, type FilesTransferTask } from "@/stores/files-library"

export function FilesTransferTray({ touch = false }: { touch?: boolean } = {}) {
  const t = useTranslations("files.transfers")
  const tasks = useFilesTransferStore((s) => s.tasks)
  const open = useFilesTransferStore((s) => s.open)
  const setOpen = useFilesTransferStore((s) => s.setOpen)
  const cancelTask = useFilesTransferStore((s) => s.cancelTask)
  const retryTask = useFilesTransferStore((s) => s.retryTask)
  const dismissTask = useFilesTransferStore((s) => s.dismissTask)
  const clearFinished = useFilesTransferStore((s) => s.clearFinished)

  if (tasks.length === 0) return null

  const activeCount = tasks.filter(
    (task) => task.status === "queued" || task.status === "running"
  ).length
  const failedCount = tasks.filter((task) => task.status === "failed").length
  const hasFinished = tasks.some(
    (task) => task.status === "completed" || task.status === "cancelled"
  )

  return (
    <aside
      aria-label={t("aria")}
      data-testid="files-transfer-tray"
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden rounded-xl border bg-background/95 shadow-lg backdrop-blur",
        touch ? "right-3 bottom-16 left-3" : "right-4 bottom-4 w-84 max-w-[calc(100vw-2rem)]"
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium"
          aria-expanded={open}
          data-testid="files-transfer-toggle"
        >
          {activeCount > 0 ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          ) : failedCount > 0 ? (
            <AlertCircleIcon className="size-3.5 shrink-0 text-destructive" aria-hidden />
          ) : (
            <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-500" aria-hidden />
          )}
          <span className="truncate">
            {activeCount > 0
              ? t("summaryActive", { count: activeCount })
              : failedCount > 0
                ? t("summaryFailed", { count: failedCount })
                : t("summaryDone", { count: tasks.length })}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {hasFinished ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={clearFinished}
              data-testid="files-transfer-clear-finished"
            >
              {t("clearFinished")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => setOpen(!open)}
            aria-label={open ? t("collapse") : t("expand")}
          >
            {open ? (
              <ChevronDownIcon className="size-3.5" aria-hidden />
            ) : (
              <ChevronUpIcon className="size-3.5" aria-hidden />
            )}
          </Button>
        </div>
      </div>

      {open ? (
        <ul
          className="flex max-h-60 flex-col divide-y overflow-y-auto"
          data-testid="files-transfer-list"
        >
          {tasks.map((task) => (
            <TransferRow
              key={task.id}
              task={task}
              onCancel={() => cancelTask(task.id)}
              onRetry={() => void retryTask(task.id)}
              onDismiss={() => dismissTask(task.id)}
            />
          ))}
        </ul>
      ) : null}
    </aside>
  )
}

function TransferRow({
  task,
  onCancel,
  onRetry,
  onDismiss,
}: {
  task: FilesTransferTask
  onCancel: () => void
  onRetry: () => void
  onDismiss: () => void
}) {
  const t = useTranslations("files.transfers")
  const percent =
    task.totalBytes > 0
      ? Math.min(100, Math.round((task.loadedBytes / task.totalBytes) * 100))
      : task.status === "completed"
        ? 100
        : 0
  const isRunning = task.status === "queued" || task.status === "running"
  const canRetry =
    (task.status === "failed" || task.status === "cancelled") && Boolean(task.retryFn)

  return (
    <li
      className="flex flex-col gap-1.5 px-3 py-2 text-xs"
      data-testid={`files-transfer-item-${task.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {task.kind === "export-zip" ? (
            <ArchiveIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <UploadIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="truncate font-medium" title={task.name}>
            {task.name}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Badge
            variant={task.status === "failed" ? "destructive" : "secondary"}
            className="h-4 px-1.5 text-[10px]"
          >
            {t(`status.${task.status}`)}
          </Badge>
          {isRunning ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={onCancel}
              aria-label={t("cancelItem", { name: task.name })}
              data-testid={`files-transfer-cancel-${task.id}`}
            >
              <XIcon className="size-3.5" aria-hidden />
            </Button>
          ) : null}
          {canRetry ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={onRetry}
              aria-label={t("retryItem", { name: task.name })}
              data-testid={`files-transfer-retry-${task.id}`}
            >
              <RotateCcwIcon className="size-3.5" aria-hidden />
            </Button>
          ) : null}
          {!isRunning ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={onDismiss}
              aria-label={t("dismissItem", { name: task.name })}
              data-testid={`files-transfer-dismiss-${task.id}`}
            >
              <XIcon className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>

      {isRunning || task.totalBytes > 0 ? (
        <div className="flex items-center gap-2">
          <Progress value={percent} className="h-1.5 flex-1" />
          <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
            {formatBytes(task.loadedBytes)} / {formatBytes(task.totalBytes)}
          </span>
        </div>
      ) : null}

      {task.error ? <p className="text-[11px] text-destructive">{task.error}</p> : null}
    </li>
  )
}
