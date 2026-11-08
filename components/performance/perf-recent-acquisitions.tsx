"use client"

import { useCallback, useEffect, useId, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatMs } from "@/lib/perf/backend/format"
import { listWorkspaceAcquisitions } from "@/lib/task-workspace/client"
import type { WorkspaceAcquisition, WorkspaceAcquisitionPhase } from "@/lib/task-workspace/types"
import { PIN_START } from "./perf-table-pin"

/** How many acquisitions the table shows. The host keeps more. */
const SHOWN = 20

const KINDS = new Set(["run", "bundle", "restore", "remoteSource"])
const PHASES = new Set([
  "fetch",
  "clone",
  "backfill",
  "derive",
  "worktreeAdd",
  "sparse",
  "checkout",
  "provisioning",
])
const CLASSES = new Set([
  "notFound",
  "auth",
  "network",
  "timedOut",
  "cancelled",
  "lock",
  "diskFull",
  "other",
])
const NOTES = new Set(["hit", "refreshed", "created", "recent"])

type Load =
  { state: "loading" } | { state: "ready"; items: WorkspaceAcquisition[] } | { state: "error" }

/**
 * The host's newest checkout acquisitions with each phase's time (ADR-0176
 * A1): where a slow or failed acquisition spent its time, and why it failed.
 */
export function PerfRecentAcquisitions() {
  const t = useTranslations("performance.acquisitions")
  const format = useFormatter()
  const id = useId()
  const [load, setLoad] = useState<Load>({ state: "loading" })

  const refresh = useCallback(async () => {
    setLoad({ state: "loading" })
    try {
      const page = await listWorkspaceAcquisitions({ pageSize: SHOWN })
      setLoad({ state: "ready", items: page.items })
    } catch {
      setLoad({ state: "error" })
    }
  }, [])

  useEffect(() => {
    let current = true
    listWorkspaceAcquisitions({ pageSize: SHOWN })
      .then((page) => {
        if (current) setLoad({ state: "ready", items: page.items })
      })
      .catch(() => {
        if (current) setLoad({ state: "error" })
      })
    return () => {
      current = false
    }
  }, [])

  const className = (value: string | null) =>
    t(`classes.${value && CLASSES.has(value) ? value : "other"}`)
  const phaseLabel = (phase: WorkspaceAcquisitionPhase) => {
    const name = PHASES.has(phase.phase) ? t(`phases.${phase.phase}`) : phase.phase
    const parts = [`${name} ${formatMs(phase.durationMs)}`]
    if (phase.attempt > 1) parts.push(t("attempt", { attempt: phase.attempt }))
    if (phase.note) parts.push(NOTES.has(phase.note) ? t(`notes.${phase.note}`) : phase.note)
    if (!phase.ok) parts.push(className(phase.failureClass))
    return parts.join(" · ")
  }

  return (
    <section className="min-w-0 border-y bg-background" aria-labelledby={`${id}-title`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div>
          <h2 id={`${id}-title`} className="text-base font-medium">
            {t("title")}
          </h2>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void refresh()}
          disabled={load.state === "loading"}
        >
          {t("refresh")}
        </Button>
      </header>
      {load.state === "loading" && (
        <p className="p-4 text-sm text-muted-foreground" role="status">
          {t("loading")}
        </p>
      )}
      {load.state === "error" && (
        <p className="p-4 text-sm text-destructive" role="alert">
          {t("error")}
        </p>
      )}
      {load.state === "ready" && load.items.length === 0 && (
        <p className="p-4 text-sm text-muted-foreground">{t("empty")}</p>
      )}
      {load.state === "ready" && load.items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={PIN_START}>{t("columns.startedAt")}</TableHead>
              <TableHead>{t("columns.kind")}</TableHead>
              <TableHead>{t("columns.subject")}</TableHead>
              <TableHead className="text-right">{t("columns.total")}</TableHead>
              <TableHead>{t("columns.result")}</TableHead>
              <TableHead>{t("columns.phases")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {load.items.map((item) => (
              <TableRow key={item.acquisitionId}>
                <TableCell className={`whitespace-nowrap ${PIN_START}`}>
                  {format.dateTime(new Date(item.startedAt), {
                    dateStyle: "short",
                    timeStyle: "medium",
                  })}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {KINDS.has(item.kind) ? t(`kinds.${item.kind}`) : item.kind}
                </TableCell>
                <TableCell className="max-w-64 truncate font-mono text-xs" title={item.subject}>
                  {item.subject}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
                  {formatMs(item.totalMs)}
                </TableCell>
                <TableCell className="min-w-32">
                  {item.ok ? (
                    <span>{t("ok")}</span>
                  ) : (
                    <>
                      <span className="text-destructive">{className(item.failureClass)}</span>
                      {item.error && (
                        <p
                          className="mt-1 line-clamp-2 max-w-72 text-xs text-muted-foreground"
                          title={item.error}
                        >
                          {item.error}
                        </p>
                      )}
                    </>
                  )}
                </TableCell>
                <TableCell className="min-w-64 text-xs text-muted-foreground">
                  <ul className="space-y-0.5">
                    {item.phases.map((phase, index) => (
                      <li key={`${phase.phase}-${phase.startedMs}-${index}`}>
                        {phaseLabel(phase)}
                      </li>
                    ))}
                  </ul>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
