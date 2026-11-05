"use client"

/**
 * Open sync conflicts of the active workspace (spec 2026-09-06, D2).
 *
 * The engine already picked a winner by timestamp and wrote it. This panel
 * exists so a person can see what lost and put it back with one click.
 * Sits beside `CollabConflictsPanel`, which handles the collaboration plane's
 * own revision conflicts through the outbound queue. The two look alike on
 * purpose and stay separate because their resolutions go to different
 * places: one re-writes a local field, the other re-submits a queued patch.
 */

import { useTranslations } from "next-intl"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useClientLiveQuery } from "@/hooks/data"
import {
  listWorkspaceSyncConflicts,
  resolveSyncConflict,
  type OpenSyncConflict,
} from "@/lib/issues/sync/conflicts"
import { ConflictResolutionActions, useConflictResolution } from "./conflict-resolution-actions"

export interface SyncConflictsPanelProps {
  /** Workspace id. Nothing renders without one. */
  projectId: string | null | undefined
  /** Identifier per issue id, so a row says `MERC-4` and not an opaque id. */
  identifiersById?: ReadonlyMap<string, string>
  onOpenIssue?: (issueId: string) => void
}

function printValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  return JSON.stringify(value)
}

export function SyncConflictsPanel({
  projectId,
  identifiersById,
  onOpenIssue,
}: SyncConflictsPanelProps) {
  const t = useTranslations("issues.syncConflicts")
  const { busyId, error, run } = useConflictResolution()
  const conflicts = useClientLiveQuery(
    () => (projectId ? listWorkspaceSyncConflicts(projectId) : Promise.resolve([])),
    [projectId],
    [] as OpenSyncConflict[]
  )
  if (!conflicts?.length) return null

  const resolve = (conflict: OpenSyncConflict, kept: "local" | "remote") =>
    run(conflict.eventId, () => resolveSyncConflict(conflict, kept, { kind: "human" }))

  return (
    <Card className="border-amber-500/50" data-testid="sync-conflicts-panel">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t("title", { count: conflicts.length })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        {conflicts.map((conflict) => (
          <div
            key={conflict.eventId}
            className="space-y-2 rounded-md border p-3"
            data-testid={`sync-conflict-${conflict.eventId}`}
          >
            <p className="flex flex-wrap items-center gap-2 text-xs font-medium">
              {onOpenIssue ? (
                <button
                  type="button"
                  className="font-mono hover:underline"
                  onClick={() => onOpenIssue(conflict.issueId)}
                >
                  {identifiersById?.get(conflict.issueId) ?? conflict.issueId}
                </button>
              ) : (
                <span className="font-mono">
                  {identifiersById?.get(conflict.issueId) ?? conflict.issueId}
                </span>
              )}
              <span>{t(`field.${conflict.field}`)}</span>
              <span className="text-muted-foreground">
                {t("via", { provider: conflict.provider })}
              </span>
              <span className="text-muted-foreground">{t(`kept.${conflict.winner}`)}</span>
            </p>
            <div className="grid gap-2 md:grid-cols-2">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t("localValue")}</p>
                <pre className="max-h-32 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap">
                  {printValue(conflict.localValue)}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t("remoteValue")}</p>
                <pre className="max-h-32 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap">
                  {printValue(conflict.remoteValue)}
                </pre>
              </div>
            </div>
            <ConflictResolutionActions
              disabled={busyId === conflict.eventId}
              keepLocal={{
                label: t("keepLocal"),
                recommended: conflict.winner === "local",
                onSelect: () => void resolve(conflict, "local"),
                testId: `sync-conflict-keep-local-${conflict.eventId}`,
              }}
              keepRemote={{
                label: t("keepRemote"),
                recommended: conflict.winner === "remote",
                onSelect: () => void resolve(conflict, "remote"),
                testId: `sync-conflict-keep-remote-${conflict.eventId}`,
              }}
            />
          </div>
        ))}
        {error ? (
          <p role="status" className="text-xs text-destructive">
            {t("failed", { reason: error })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
