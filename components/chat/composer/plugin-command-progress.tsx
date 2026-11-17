"use client"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"

export interface PluginCommandProgressState {
  command: string
  value?: number
  message?: string
}

/** A running plugin slash command: its message or name, its progress, and Cancel. */
export function PluginCommandProgress({
  progress,
  onCancel,
}: {
  progress: PluginCommandProgressState
  onCancel: () => void
}) {
  const tCommands = useTranslations("chat.composer.commands")
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-sm">
      <div role="status" className="min-w-0 flex-1" aria-live="polite">
        <span className="block truncate">
          {progress.message || tCommands("running", { command: progress.command })}
        </span>
        {progress.value !== undefined && (
          <Progress
            className="h-1 w-full"
            aria-label={tCommands("progress", { command: progress.command })}
            value={progress.value * 100}
          />
        )}
      </div>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        {tCommands("cancel")}
      </Button>
    </div>
  )
}
