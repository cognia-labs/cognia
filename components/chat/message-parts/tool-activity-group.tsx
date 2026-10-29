"use client"

/**
 * Collapsible tool run with lazy bodies and per-call controlled disclosure state.
 *
 * Disclosure state is remembered by identity (`lib/chat/disclosure-memory`):
 * the group's own open/closed by `memoryKey`, each row by its entry's
 * `memoryKey`. A row the reader opened therefore stays open when the virtual
 * list remounts the message, when the turn seals and moves the group under its
 * fold, and when a lone call grows into a group as a second one streams in.
 * Without keys (a sub-agent's rolling tool window) the choices are scoped to
 * this mount.
 *
 * Inside an open turn fold a group of up to {@link FLAT_GROUP_MAX} calls drops
 * its header and renders its rows directly — the fold already says "these are
 * the turn's steps", so the header was a second disclosure to click through.
 */

import { useCallback, useId, useMemo, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon } from "lucide-react"
import type { ToolUIPart } from "ai"

import { ReadingCollapse } from "@/components/chat/motion/motion-reveal"
import { ToolStatusDot } from "@/components/chat/message-parts/tool-row"
import { useInsideTurnFold } from "@/components/chat/message-parts/turn-process-fold"
import {
  useRememberedDisclosure,
  useRememberedDisclosures,
} from "@/hooks/chat/use-remembered-disclosure"
import { readDisclosure } from "@/lib/chat/disclosure-memory"
import {
  aggregateToolStatus,
  countErroredTools,
  summarizeContextCounts,
} from "@/lib/chat/tool-summary"
import type { AgentFlowMode } from "@/types/appearance"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Inside a turn fold, groups this size or smaller render as plain rows. */
export const FLAT_GROUP_MAX = 8

export interface ToolActivityGroupEntry {
  part: ToolUIPart
  key: string
  /** Caller-specific default; otherwise only detailed rows start expanded. */
  defaultOpen?: boolean
  /**
   * Where the reader's choice for this row is remembered — the same key the
   * call uses when it renders on its own, so the choice follows the call.
   */
  memoryKey?: string
}

/** Controlled disclosure options, shared by every row shape. */
export interface ToolActivityChildOptions {
  expanded?: boolean
  onToggle?: () => void
}

export interface ToolActivityGroupProps {
  entries: ToolActivityGroupEntry[]
  mode: AgentFlowMode
  /**
   * Explicit display preference: `true` opens the group, `false` closes it
   * unless a call still needs the reader (running, awaiting approval, denied,
   * failed).
   */
  defaultOpen?: boolean
  /** Where the group's own open/closed choice is remembered. */
  memoryKey?: string
  /** Renders one child (a compact row or a full tool card — the caller decides). */
  renderChild: (part: ToolUIPart, key: string, opts: ToolActivityChildOptions) => ReactNode
}

export function ToolActivityGroup({
  entries,
  mode,
  defaultOpen,
  memoryKey,
  renderChild,
}: ToolActivityGroupProps) {
  const t = useTranslations("chat.agentFlow")

  const instanceScope = useId()
  const insideFold = useInsideTurnFold()
  const flat = insideFold && entries.length <= FLAT_GROUP_MAX

  const status = useMemo(() => aggregateToolStatus(entries.map((e) => e.part.state)), [entries])
  const attentionState = useMemo(
    () =>
      entries.some((entry) => entry.part.state === "approval-requested")
        ? "awaitingApproval"
        : entries.some((entry) => entry.part.state === "output-denied")
          ? "denied"
          : null,
    [entries]
  )
  const errorCount = useMemo(() => countErroredTools(entries.map((e) => e.part.state)), [entries])
  // TUI-style count summary ("3 reads · 2 searches") for the collapsed header —
  // shared by every mode now that the header is a row in all of them.
  const counts = useMemo(() => summarizeContextCounts(entries.map((e) => e.part)), [entries])

  // A manual group toggle wins over later stream/default changes. Pending,
  // approval, denied and failed calls stay visible until explicitly collapsed,
  // even under the "collapsed" display preference. Inside an open fold the
  // reader has already asked to see the process, so the group starts open.
  const autoOpen =
    defaultOpen === false
      ? status !== "complete"
      : (defaultOpen ?? (insideFold || mode !== "simplified" || status !== "complete"))
  const [override, setOverride] = useRememberedDisclosure(memoryKey ?? `${instanceScope}:group`)
  const groupOpen = flat || (override ?? autoOpen)

  // Each row's memory key, in entry order. Rows without a caller key are
  // scoped to this mount so two groups never share a choice by accident.
  // Derived from a signature so a fresh entries array with the same calls
  // (every streamed delta builds one) keeps every derived identity below.
  const identitySignature = entries
    .map((entry) => `${entry.key}\u0001${entry.memoryKey ?? ""}`)
    .join("\u0000")
  const memoryKeyByEntry = useMemo(
    () =>
      new Map(
        (identitySignature ? identitySignature.split("\u0000") : []).map((pair) => {
          const [entryKey = "", memory = ""] = pair.split("\u0001")
          return [entryKey, memory || `${instanceScope}:row:${entryKey}`] as const
        })
      ),
    [identitySignature, instanceScope]
  )
  const rowKeys = useMemo(() => [...memoryKeyByEntry.values()], [memoryKeyByEntry])
  const [rowChoices, setRowChoices] = useRememberedDisclosures(rowKeys)
  const rowDefaults = useMemo(
    () =>
      JSON.stringify(entries.map((entry) => [entry.key, entry.defaultOpen ?? mode === "detailed"])),
    [entries, mode]
  )
  const defaults = useMemo(() => new Map<string, boolean>(JSON.parse(rowDefaults)), [rowDefaults])
  const rowOpen = (entryKey: string) =>
    rowChoices.get(memoryKeyByEntry.get(entryKey) ?? "") ?? defaults.get(entryKey) ?? false

  const expandAllActive = entries.length > 0 && entries.every((entry) => rowOpen(entry.key))
  const toggleExpandAll = () => {
    setOverride(true)
    setRowChoices(rowKeys, !expandAllActive)
  }
  // A row toggle also pins the group open, so a live group the reader has
  // started reading does not fold itself away when its calls complete. The
  // current choice is read at click time, keeping every handler's identity
  // stable across streamed deltas and other rows' toggles.
  const toggleRow = useCallback(
    (entryKey: string, fallback: boolean) => {
      const key = memoryKeyByEntry.get(entryKey)
      if (!key) return
      setOverride(true)
      setRowChoices([key], !(readDisclosure(key) ?? fallback))
    },
    [memoryKeyByEntry, setOverride, setRowChoices]
  )
  const rowToggles = useMemo(
    () => new Map([...defaults].map(([key, fallback]) => [key, () => toggleRow(key, fallback)])),
    [defaults, toggleRow]
  )

  const body: ReactNode = !groupOpen ? null : (
    <div className="space-y-0.5">
      {entries.map((entry) =>
        renderChild(entry.part, entry.key, {
          expanded: rowOpen(entry.key),
          onToggle: rowToggles.get(entry.key),
        })
      )}
    </div>
  )

  if (flat) {
    return (
      <div
        className="not-prose mb-2 w-full"
        data-testid="tool-activity-group"
        data-mode={mode}
        data-status={status}
        data-flat=""
      >
        {body}
      </div>
    )
  }

  return (
    <div
      className="not-prose mb-2 w-full"
      data-testid="tool-activity-group"
      data-mode={mode}
      data-status={status}
    >
      {/* Reserve the bulk button's height while collapsed so the header stays put. */}
      <div className="flex min-h-8 items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/50">
        <button
          type="button"
          onClick={() => setOverride(!groupOpen)}
          aria-expanded={groupOpen}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
          data-testid="tool-activity-group-toggle"
        >
          <ToolStatusDot status={status} />
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            data-testid="tool-activity-group-tally"
          >
            <span className="font-medium text-foreground/80">
              {t("group.summary", { count: entries.length })}
            </span>
            {counts.length > 0 ? <span aria-hidden> · </span> : null}
            {counts.map((bucket, i) => (
              <span key={bucket.category}>
                {i > 0 ? <span aria-hidden> · </span> : null}
                {t(`count.${bucket.category}`, { count: bucket.count })}
              </span>
            ))}
          </span>
          {attentionState ? (
            <span className="shrink-0 text-[11px] text-amber-600">
              {t(`status.${attentionState}`)}
            </span>
          ) : null}
          {errorCount > 0 ? (
            <span
              className="shrink-0 text-[11px] font-medium text-red-600 dark:text-red-500"
              data-testid="tool-activity-group-failed"
            >
              {t("group.failed", { count: errorCount })}
            </span>
          ) : null}
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              groupOpen && "rotate-90"
            )}
            aria-hidden
          />
        </button>
        {groupOpen ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-[11px] text-muted-foreground"
            onClick={toggleExpandAll}
            aria-expanded={expandAllActive}
            data-testid="tool-activity-group-expand-all"
          >
            {expandAllActive ? t("group.collapseAll") : t("group.expandAll")}
          </Button>
        ) : null}
      </div>

      <ReadingCollapse open={groupOpen}>
        {/* The left rule mirrors the expansion indent of a single tool row, so
            a group reads as one row whose children happen to be more rows. */}
        <div className="ml-[15px] border-l-2 border-border/60 pl-1 pt-0.5 pb-0.5">{body}</div>
      </ReadingCollapse>
    </div>
  )
}
