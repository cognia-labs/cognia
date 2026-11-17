"use client"

/**
 * Right-rail step inspector for a run. A step can execute several times in
 * one run (retry attempts, loop iterations); the inspector splits its events
 * into those executions (`groupStepExecutions`) and shows one execution's
 * inputs, error, output, status, usage and logs at a time, with an aggregate
 * summary kept separate. Reads only from the durable event log so the data is
 * identical to what the orchestrator actually produced.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import {
  workflowNodeCategory,
  type VisualWorkflow,
  type WorkflowRunEventRow,
} from "@/types/workflow/visual"
import { nodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import { tNode } from "@/lib/workflow/i18n/node-translate"
import { reduceStepStream } from "@/hooks/workflow/use-step-stream"
import { formatCostUsd } from "@/lib/workflow/runs/usage-aggregate"
import {
  groupStepExecutions,
  summarizeStepExecutions,
  type StepExecutionView,
} from "@/lib/workflow/runs/step-executions"
import { formatTokens } from "@/types/system/usage"
import { formatDurationMs } from "./format"

type LogLevel = "debug" | "info" | "warn" | "error"
const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"]

const CATEGORY_BADGE = {
  trigger: "bg-wf-trigger/15 text-wf-trigger border-wf-trigger/30",
  action: "bg-wf-action/15 text-wf-action border-wf-action/30",
  ai: "bg-wf-ai/15 text-wf-ai border-wf-ai/30",
  flow: "bg-wf-flow/15 text-wf-flow border-wf-flow/30",
  data: "bg-wf-data/15 text-wf-data border-wf-data/30",
  io: "bg-wf-io/15 text-wf-io border-wf-io/30",
  annotation: "bg-wf-annotation/15 text-wf-annotation border-wf-annotation/30",
} as const

interface StartedPayload {
  inputs?: unknown
  inputsTruncatedBytes?: number
  pinned?: boolean
}

interface ErrorCauseView {
  name?: string
  message?: string
  stack?: string
  cause?: unknown
}

interface FailedPayload extends ErrorCauseView {
  retryable?: boolean
  truncated?: boolean
}

/** Flatten a recorded `cause` chain (bounded at write time) for display. */
function causeChain(cause: unknown): ErrorCauseView[] {
  const chain: ErrorCauseView[] = []
  let current = cause
  while (current !== undefined && current !== null && chain.length < 8) {
    if (typeof current === "object" && "message" in current) {
      const view = current as ErrorCauseView
      chain.push(view)
      current = view.cause
    } else {
      chain.push({ message: typeof current === "string" ? current : safeStringify(current) })
      break
    }
  }
  return chain
}

export function RunStepDetail({
  workflow,
  events,
  stepId,
}: {
  workflow: VisualWorkflow
  events: WorkflowRunEventRow[]
  stepId: string | null
}) {
  const t = useTranslations("workflows.runs.step")
  const tLogs = useTranslations("workflows.runs.logs")
  const tNodes = useTranslations("workflows.nodes")
  const [logQuery, setLogQuery] = useState("")
  const [logLevels, setLogLevels] = useState<string[]>(LOG_LEVELS)
  const [stackOpen, setStackOpen] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const { node, stepEvents, executions, stepLevelEvents, aggregate } = useMemo(() => {
    if (!stepId) {
      return {
        node: null,
        stepEvents: [],
        executions: [] as StepExecutionView[],
        stepLevelEvents: [] as WorkflowRunEventRow[],
        aggregate: null,
      }
    }
    const node = workflow.nodes.find((n) => n.id === stepId) ?? null
    const stepEvents = events.filter((e) => e.stepId === stepId)
    const grouped = groupStepExecutions(stepEvents)
    return {
      node,
      stepEvents,
      executions: grouped.executions,
      stepLevelEvents: grouped.stepLevelEvents,
      aggregate: summarizeStepExecutions(grouped.executions),
    }
  }, [stepId, workflow.nodes, events])

  // The chosen execution, or the latest one. A selection that does not exist
  // for this step (another step was picked) falls back to the latest.
  const current = executions.find((e) => e.key === selectedKey) ?? executions.at(-1) ?? null

  // For a running execution, elapsed time comes from the most recent event in
  // the run rather than `Date.now()` so the render stays pure.
  const latestTs = useMemo(() => events.reduce((m, e) => (e.ts > m ? e.ts : m), 0), [events])

  const logEvents = useMemo(
    () =>
      [...(current?.events ?? []), ...stepLevelEvents]
        .filter((e) => e.type === "run_log")
        .sort((a, b) => a.ts - b.ts),
    [current, stepLevelEvents]
  )

  // Retry history across every execution (step_retrying — one per backoff wait).
  const retryEvents = useMemo(
    () => stepEvents.filter((e) => e.type === "step_retrying"),
    [stepEvents]
  )

  const stream = useMemo(() => reduceStepStream(current?.events ?? [], stepId), [current, stepId])

  const filteredLogs = useMemo(() => {
    const q = logQuery.trim().toLowerCase()
    return logEvents.filter((e) => {
      const level = (e.level ?? "info") as LogLevel
      if (!logLevels.includes(level)) return false
      if (!q) return true
      const payload = e.payload as { message?: string; data?: unknown } | undefined
      return (
        payload?.message?.toLowerCase().includes(q) ||
        JSON.stringify(payload?.data ?? "")
          .toLowerCase()
          .includes(q)
      )
    })
  }, [logEvents, logQuery, logLevels])

  if (!stepId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t("selectPrompt")}
      </div>
    )
  }

  if (!node) {
    return <div className="p-6 text-sm text-muted-foreground">{t("notInSnapshot", { stepId })}</div>
  }

  const entry = nodeCatalogEntry(node.type)
  const category = workflowNodeCategory(node.type)
  const startedEv = current?.started
  const endedEv = current?.terminal
  const started = (startedEv?.payload as StartedPayload | undefined) ?? undefined
  const pinned = started?.pinned === true
  const completedOutput = (current?.completed?.payload as { output?: unknown } | undefined)?.output
  const failedError = (current?.failed?.payload as FailedPayload | undefined) ?? null
  const causes = failedError ? causeChain(failedError.cause) : []
  const skippedReason = (current?.skipped?.payload as { reason?: string } | undefined)?.reason
  const usage = current?.usage
  const durationMs = startedEv
    ? Math.max(0, (endedEv?.ts ?? Math.max(latestTs, startedEv.ts)) - startedEv.ts)
    : null

  const executionLabel = (execution: StepExecutionView, index: number) =>
    [
      t("executionNumber", { n: index + 1 }),
      typeof execution.attempt === "number" ? t("attemptN", { attempt: execution.attempt }) : null,
      typeof execution.iterationIndex === "number"
        ? t("iterationN", { index: execution.iterationIndex + 1 })
        : null,
      t(`status.${execution.status}`),
    ]
      .filter(Boolean)
      .join(" · ")

  return (
    <ScrollArea className="h-full">
      {/* `@container/run-step`: this detail renders both on the full-width
          runs page and inside the editor's Context Workbench panel, which
          drags down to 240px. A viewport `sm:` breakpoint reads the window,
          so on a wide desktop it split the stat grid into two columns inside
          a 208px panel. */}
      <div className="@container/run-step space-y-5 p-5">
        <div className="space-y-1.5">
          <Badge variant="outline" className={cn("font-normal", CATEGORY_BADGE[category])}>
            {entry.kind}
          </Badge>
          <h3 className="text-base font-semibold leading-tight">{node.data.label}</h3>
          <p className="text-xs text-muted-foreground">
            {tNode(tNodes, `${entry.kind}.description`, entry.description)}
          </p>
        </div>

        {aggregate && executions.length > 1 ? (
          <Section title={t("allExecutions")}>
            <div
              className="grid grid-cols-1 gap-2 rounded-md border border-transparent bg-muted/60 p-3 text-xs @xs/run-step:grid-cols-2"
              data-testid="step-executions-summary"
            >
              <Stat label={t("executionCount")} value={String(aggregate.executionCount)} />
              <Stat label={t("statusLabel")} value={t(`status.${aggregate.status}`)} />
              <Stat label={t("totalDuration")} value={formatDurationMs(aggregate.durationMs)} />
              {aggregate.totalTokens > 0 ? (
                <Stat
                  label={t("tokens")}
                  value={`${formatTokens(aggregate.totalTokens)} (${formatTokens(aggregate.inputTokens)} / ${formatTokens(aggregate.outputTokens)})`}
                />
              ) : null}
              {aggregate.costUsd !== undefined ? (
                <Stat
                  label={t("cost")}
                  value={`${formatCostUsd(aggregate.costUsd)} ${t("costEstimateSuffix")}`}
                />
              ) : null}
            </div>
            <Select value={current?.key} onValueChange={setSelectedKey}>
              <SelectTrigger
                className="h-8 w-full text-xs"
                aria-label={t("executionPicker")}
                data-testid="step-execution-picker"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {executions.map((execution, index) => (
                  <SelectItem key={execution.key} value={execution.key} className="text-xs">
                    {executionLabel(execution, index)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Section>
        ) : null}

        {current ? (
          <div className="grid grid-cols-1 gap-2 rounded-md border border-transparent bg-muted/60 p-3 text-xs @xs/run-step:grid-cols-2">
            {durationMs !== null ? (
              <Stat label={t("duration")} value={formatDurationMs(durationMs)} />
            ) : null}
            <Stat label={t("statusLabel")} value={t(`status.${current.status}`)} />
            {startedEv ? (
              <Stat label={t("started")} value={new Date(startedEv.ts).toLocaleTimeString()} />
            ) : null}
            {endedEv ? (
              <Stat label={t("ended")} value={new Date(endedEv.ts).toLocaleTimeString()} />
            ) : null}
            {usage ? (
              <>
                <Stat
                  label={t("tokens")}
                  value={`${formatTokens(usage.totalTokens ?? 0)} (${formatTokens(usage.inputTokens ?? 0)} / ${formatTokens(usage.outputTokens ?? 0)})`}
                />
                <Stat
                  label={t("cost")}
                  value={
                    usage.costUsd !== undefined
                      ? `${formatCostUsd(usage.costUsd)} ${t("costEstimateSuffix")}`
                      : "—"
                  }
                />
                {usage.providerId ? (
                  <Stat
                    label={t("servedBy")}
                    value={`${usage.providerId}${usage.modelId ? ` · ${usage.modelId}` : ""}`}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {stream.isStreaming ? (
          <Section title={t("streaming")}>
            <pre
              className="whitespace-pre-wrap rounded-md border border-wf-status-running/40 bg-wf-status-running/5 p-3 text-xs"
              data-testid="step-streaming-output"
            >
              {stream.text}
              <span className="animate-pulse">▌</span>
            </pre>
          </Section>
        ) : null}

        {retryEvents.length > 0 ? (
          <Section title={t("attempts")}>
            <div
              className="space-y-1.5 rounded-md border border-transparent bg-muted/60 p-2"
              data-testid="step-attempts"
            >
              {retryEvents.map((e) => {
                const payload = e.payload as
                  | { attempt?: number; maxAttempts?: number; delayMs?: number; error?: string }
                  | undefined
                return (
                  <div key={e.id} className="flex items-start gap-2 text-xs">
                    <Badge variant="outline" className="shrink-0 font-mono text-wf-status-running">
                      {t("attemptBadge", {
                        attempt: payload?.attempt ?? 0,
                        max: payload?.maxAttempts ?? 0,
                      })}
                    </Badge>
                    <div className="min-w-0 flex-1 break-words text-muted-foreground">
                      {payload?.error ?? "—"}
                      {typeof payload?.delayMs === "number" ? (
                        <span className="ml-1 opacity-70">
                          {t("retryIn", { delay: formatDurationMs(payload.delayMs) })}
                        </span>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </Section>
        ) : null}

        {failedError ? (
          <Section title={t("error")}>
            <pre className="whitespace-pre-wrap rounded-md border border-wf-status-failed/40 bg-wf-status-failed/5 p-3 text-xs">
              {failedError.name && failedError.name !== "Error"
                ? `${failedError.name}: ${failedError.message ?? ""}`
                : (failedError.message ?? t("error"))}
            </pre>
            {failedError.stack || causes.length > 0 ? (
              <Collapsible open={stackOpen} onOpenChange={setStackOpen} className="mt-1.5">
                <CollapsibleTrigger className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
                  {stackOpen ? tLogs("stackToggleHide") : tLogs("stackToggleShow")}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {failedError.stack ? (
                    <pre
                      className="mt-1 whitespace-pre overflow-x-auto rounded-md border border-transparent bg-muted/60 p-2 text-[11px] font-mono leading-relaxed"
                      data-testid="step-error-stack"
                    >
                      {failedError.stack}
                    </pre>
                  ) : null}
                  {causes.map((cause, index) => (
                    <div key={index} className="mt-1.5">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {t("causedBy")}{" "}
                        <span className="font-mono">
                          {cause.name ? `${cause.name}: ` : ""}
                          {cause.message ?? ""}
                        </span>
                      </p>
                      {cause.stack ? (
                        <pre className="mt-1 whitespace-pre overflow-x-auto rounded-md border border-transparent bg-muted/60 p-2 text-[11px] font-mono leading-relaxed">
                          {cause.stack}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                  {failedError.truncated ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">{t("errorTruncated")}</p>
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
            ) : null}
            {failedError.retryable === false ? (
              <p className="text-[11px] text-muted-foreground mt-1">{t("nonRetryable")}</p>
            ) : null}
          </Section>
        ) : null}

        {skippedReason ? (
          <Section title={t("skipReason")}>
            <p className="text-sm text-muted-foreground">{skippedReason}</p>
          </Section>
        ) : null}

        {pinned ? (
          <Section title={t("pinnedTitle")}>
            <p className="text-xs text-muted-foreground" data-testid="step-pinned-note">
              {t("pinnedNote")}
            </p>
          </Section>
        ) : started && "inputs" in started ? (
          <Section title={t("resolvedInputs")}>
            {typeof started.inputsTruncatedBytes === "number" ? (
              <p className="text-[11px] text-muted-foreground">
                {t("inputsTruncated", { kb: Math.ceil(started.inputsTruncatedBytes / 1024) })}
              </p>
            ) : null}
            <JsonView value={started.inputs} emptyText={t("noValue")} />
          </Section>
        ) : (
          <Section title={t("configuredParams")}>
            <p className="text-[11px] text-muted-foreground">{t("configuredParamsNote")}</p>
            <JsonView value={node.data.params} emptyText={t("noValue")} />
          </Section>
        )}

        {completedOutput !== undefined ? (
          <Section title={pinned ? t("pinnedOutput") : t("output")}>
            <JsonView value={completedOutput} emptyText={t("noValue")} />
          </Section>
        ) : null}

        {logEvents.length > 0 ? (
          <Section title={t("logs")}>
            <div className="flex items-center gap-2 mb-2">
              <div className="relative flex-1">
                <SearchIcon className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={logQuery}
                  onChange={(e) => setLogQuery(e.target.value)}
                  placeholder={tLogs("searchPlaceholder")}
                  className="h-7 pl-7 text-xs"
                  aria-label={tLogs("searchPlaceholder")}
                />
              </div>
              <ToggleGroup
                type="multiple"
                size="sm"
                value={logLevels}
                onValueChange={(v) => setLogLevels(v.length > 0 ? v : LOG_LEVELS)}
                aria-label={tLogs("levelFilter")}
              >
                {LOG_LEVELS.map((level) => (
                  <ToggleGroupItem
                    key={level}
                    value={level}
                    className="h-7 px-2 text-[10px] uppercase"
                  >
                    {tLogs(`levels.${level}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            {filteredLogs.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                {tLogs("noResults")}
              </p>
            ) : (
              <div className="space-y-1.5 rounded-md border border-transparent bg-muted/60 p-2">
                {filteredLogs.map((e) => {
                  const payload = e.payload as { message?: string; data?: unknown } | undefined
                  return (
                    <div key={e.id} className="flex items-start gap-2 text-xs">
                      <Badge
                        variant="outline"
                        className={cn(
                          "shrink-0 font-mono uppercase",
                          e.level === "error" && "text-wf-status-failed",
                          e.level === "warn" && "text-wf-status-running"
                        )}
                      >
                        {e.level ?? "info"}
                      </Badge>
                      <div className="flex-1 min-w-0 break-words">
                        {payload?.message ?? "—"}
                        {payload?.data !== undefined ? (
                          <pre className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
                            {safeStringify(payload.data)}
                          </pre>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Section>
        ) : null}

        <Separator />
        <p className="text-[11px] text-muted-foreground">
          {t("stepIdLabel")} <code className="font-mono">{stepId}</code>
        </p>
      </div>
    </ScrollArea>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</p>
      {children}
    </div>
  )
}

function JsonView({ value, emptyText }: { value: unknown; emptyText: string }) {
  if (value === undefined) {
    return <p className="text-xs text-muted-foreground italic">{emptyText}</p>
  }
  return (
    <pre className="whitespace-pre-wrap rounded-md border border-transparent bg-muted/60 p-3 text-xs font-mono leading-relaxed">
      {safeStringify(value)}
    </pre>
  )
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
