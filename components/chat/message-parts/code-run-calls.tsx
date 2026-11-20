"use client"

/**
 * The nested calls a `run_code` program made (ADR-0117, CM-12), listed one per
 * row under its tool card, in program order: the call's place, the tool, and
 * how it ended (time and result size, or the failure kind).
 *
 * The list comes from the part's `codeRunCalls` (`lib/chat/code-run-calls.ts`),
 * which carries safe facts only — never a call's input or output — so there is
 * nothing here to expand further.
 */

import { memo } from "react"
import { useFormatter, useTranslations } from "next-intl"

import { ToolStatusDot, type ToolDotStatus } from "@/components/chat/message-parts/tool-row"
import type { CodeRunCall } from "@/lib/chat/code-run-calls"
import { cn, formatDurationShort } from "@/lib/utils"

/** How a call is shown: a call still running when its program ended was stopped with it. */
type ShownState = CodeRunCall["state"] | "stopped"

const DOT: Record<ShownState, ToolDotStatus> = {
  running: "running",
  succeeded: "complete",
  failed: "error",
  stopped: "pending",
}

const KILOBYTE = 1024
const MEGABYTE = 1024 * 1024

export interface CodeRunCallListProps {
  calls: readonly CodeRunCall[]
  /** The `run_code` call has ended, so nothing under it is still running. */
  settled: boolean
}

export const CodeRunCallList = memo(function CodeRunCallList({
  calls,
  settled,
}: CodeRunCallListProps) {
  const t = useTranslations("codeRunCalls")
  const format = useFormatter()

  const size = (bytes: number) =>
    bytes < KILOBYTE
      ? format.number(bytes, { style: "unit", unit: "byte", unitDisplay: "narrow" })
      : bytes < MEGABYTE
        ? format.number(bytes / KILOBYTE, {
            style: "unit",
            unit: "kilobyte",
            unitDisplay: "narrow",
            maximumFractionDigits: 1,
          })
        : format.number(bytes / MEGABYTE, {
            style: "unit",
            unit: "megabyte",
            unitDisplay: "narrow",
            maximumFractionDigits: 1,
          })

  const outcome = (call: CodeRunCall, shown: ShownState): string => {
    if (shown === "failed") {
      const key = `failure.${call.failure ?? ""}`
      return call.failure && t.has(key as never) ? t(key as never) : t("state.failed")
    }
    if (shown !== "succeeded") return t(`state.${shown}`)
    const parts = [
      call.durationMs !== undefined ? formatDurationShort(call.durationMs) : null,
      call.resultBytes !== undefined ? size(call.resultBytes) : null,
    ].filter((part): part is string => part !== null)
    return parts.length > 0 ? parts.join(" · ") : t("state.succeeded")
  }

  return (
    <section className="mb-2" aria-label={t("title")} data-testid="code-run-calls">
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">
        {t("summary", { count: calls.length })}
      </div>
      <ol className="space-y-0.5">
        {calls.map((call) => {
          const shown: ShownState = call.state === "running" && settled ? "stopped" : call.state
          const detail = outcome(call, shown)
          return (
            <li
              key={call.ordinal}
              className="flex min-w-0 items-center gap-2 text-xs"
              data-testid="code-run-call"
              data-state={shown}
              aria-label={t("rowAria", {
                ordinal: call.ordinal,
                tool: call.tool,
                status: t(`state.${shown}`),
              })}
            >
              <ToolStatusDot status={DOT[shown]} />
              <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">
                {call.ordinal}
              </span>
              <span className="min-w-0 truncate font-mono text-foreground">{call.tool}</span>
              <span
                className={cn(
                  "ml-auto shrink-0 text-[11px]",
                  shown === "failed" ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {detail}
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
})
