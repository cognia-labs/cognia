"use client"

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  BotIcon,
  ChevronRightIcon,
  ClockIcon,
  DownloadIcon,
  ListFilterIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getDb } from "@/lib/db/schema"
import type { AuditEntry, AuditKind } from "@/types/connectors/audit"
import type { AdapterInstanceRow, ConnectorAuditRow } from "@/lib/db/connector-types"
import { cn } from "@/lib/utils"
import { exportAuditView } from "@/lib/connectors/audit-export"
import { auditKindLabel } from "./audit-kind-label"

// All possible AuditKind values for the filter UI
const ALL_AUDIT_KINDS: AuditKind[] = [
  "delivery.success",
  "delivery.error",
  "delivery.deadlettered",
  "delivery.downgraded",
  "inbound.received",
  "inbound.deduped",
  "inbound.policy_blocked",
  "inbound.signature_failed",
  "outbound.enqueued",
  "circuit.opened",
  "circuit.half_opened",
  "circuit.closed",
  "rate_limit.tripped",
  "credential.refreshed",
  "oauth.scope_changed",
  "adapter.started",
  "adapter.stopped",
  "adapter.error",
  "adapter.reauth_required",
  // SLA escalation chain (slice 1B).
  "sla.escalated",
  "sla.escalation_action_failed",
]

type TimeRange = "1h" | "24h" | "7d" | "all"

const TIME_RANGE_OPTIONS: TimeRange[] = ["1h", "24h", "7d", "all"]

/** Matches the `limit(500)` on the live query; surfaced in the footer. */
const AUDIT_VIEW_LIMIT = 500

function timeRangeToMs(range: TimeRange): number | null {
  switch (range) {
    case "1h":
      return 60 * 60 * 1000
    case "24h":
      return 24 * 60 * 60 * 1000
    case "7d":
      return 7 * 24 * 60 * 60 * 1000
    case "all":
      return null
  }
}

type KindTone = "danger" | "success" | "warning" | "protection" | "neutral"

function kindTone(entry: AuditEntry): KindTone {
  if (entry.reason === "content_safety_blocked") return "protection"
  const kind = entry.kind
  if (
    kind.includes("error") ||
    kind.includes("deadlettered") ||
    kind.includes("failed") ||
    kind.includes("reauth")
  )
    return "danger"
  if (
    kind.includes("success") ||
    kind.includes("started") ||
    kind.includes("refreshed") ||
    kind === "circuit.closed"
  )
    return "success"
  if (
    kind.includes("tripped") ||
    kind.includes("blocked") ||
    kind.includes("opened") ||
    kind.includes("downgraded") ||
    kind.includes("escalated")
  )
    return "warning"
  return "neutral"
}

const TONE_CLASS: Record<KindTone, string> = {
  danger:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300",
  success:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300",
  warning:
    "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300",
  protection:
    "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300",
  neutral: "text-muted-foreground",
}

/**
 * One grid template per layout so every row lines up with the header,
 * whether or not it is expandable. Below the container breakpoint rows fall
 * back to a wrapping flex line.
 */
const ROW_GRID_WITH_ADAPTER =
  "@2xl/audit:grid @2xl/audit:grid-cols-[1rem_9rem_minmax(0,11rem)_13rem_minmax(0,1fr)]"
const ROW_GRID_SCOPED = "@2xl/audit:grid @2xl/audit:grid-cols-[1rem_9rem_13rem_minmax(0,1fr)]"

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function AuditRow({
  entry,
  adapterLabel,
  showAdapter,
}: {
  entry: AuditEntry
  adapterLabel?: string
  showAdapter: boolean
}) {
  const t = useTranslations("settings.connections.audit")
  const tKind = useTranslations("settings.connections.audit.kind")
  const format = useFormatter()
  const [expanded, setExpanded] = useState(false)
  const fields = entry.fields && Object.keys(entry.fields).length > 0 ? entry.fields : undefined
  const expandable = Boolean(fields || entry.conversationKey)
  const protectionBlocked = entry.reason === "content_safety_blocked"
  const at = new Date(entry.at)

  const summary = (
    <>
      <ChevronRightIcon
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          !expandable && "invisible",
          expanded && "rotate-90"
        )}
        aria-hidden
      />
      <time
        dateTime={at.toISOString()}
        title={format.dateTime(at, { dateStyle: "full", timeStyle: "long" })}
        className="shrink-0 text-xs tabular-nums text-muted-foreground"
      >
        {format.dateTime(at, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
      </time>
      {showAdapter && (
        <span className="min-w-0 truncate text-sm" title={entry.adapterId}>
          {adapterLabel ?? entry.adapterId}
        </span>
      )}
      <span className="min-w-0">
        <Badge
          variant="outline"
          className={cn("max-w-full gap-1 font-normal", TONE_CLASS[kindTone(entry)])}
        >
          {protectionBlocked && <ShieldAlertIcon className="size-3" aria-hidden />}
          <span className="truncate">
            {protectionBlocked ? t("contentProtectionBlocked") : auditKindLabel(tKind, entry.kind)}
          </span>
        </Badge>
      </span>
      <span
        className="min-w-0 basis-full truncate text-xs text-muted-foreground @2xl/audit:basis-auto"
        title={entry.reason}
      >
        {entry.reason && !protectionBlocked ? entry.reason : null}
      </span>
    </>
  )
  const rowClass = cn(
    "flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left",
    showAdapter ? ROW_GRID_WITH_ADAPTER : ROW_GRID_SCOPED
  )

  return (
    <li className="text-sm">
      {expandable ? (
        <button
          type="button"
          className={cn(
            rowClass,
            "w-full transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
            expanded && "bg-muted/40"
          )}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={expanded ? t("collapseAria") : t("expandAria")}
        >
          {summary}
        </button>
      ) : (
        <div className={rowClass}>{summary}</div>
      )}
      {expanded && (
        <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t bg-muted/30 px-3 py-3 pl-10 text-xs">
          {entry.conversationKey && (
            <>
              <dt className="text-muted-foreground">{t("detail.conversationKey")}</dt>
              <dd className="break-all font-mono">{entry.conversationKey}</dd>
            </>
          )}
          {fields &&
            Object.entries(fields).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="truncate font-mono text-muted-foreground" title={key}>
                  {key}
                </dt>
                <dd className="break-all font-mono">{formatFieldValue(value)}</dd>
              </div>
            ))}
        </dl>
      )}
    </li>
  )
}

interface AuditTabProps {
  /** Injected in tests to override initial time range. */
  initialTimeRange?: TimeRange
  /**
   * When supplied (im-refactored-crayon), scopes the view to a single
   * adapter and hides the adapter-filter chip row. Used by the per-adapter
   * detail panel's Audit tab to avoid duplicating the entire component.
   */
  adapterId?: string
}

export function AuditTab({ initialTimeRange = "24h", adapterId }: AuditTabProps = {}) {
  const t = useTranslations("settings.connections.audit")
  const tKind = useTranslations("settings.connections.audit.kind")
  const [selectedAdapters, setSelectedAdapters] = useState<string[]>(adapterId ? [adapterId] : [])
  const [selectedKinds, setSelectedKinds] = useState<AuditKind[]>([])
  const [timeRange, setTimeRange] = useState<TimeRange>(initialTimeRange)
  const [safetyOnly, setSafetyOnly] = useState(false)
  const [conversationKeyFilter, setConversationKeyFilter] = useState<string>("")

  const adapters = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined" ? Promise.resolve([]) : getDb().adapterInstances.toArray(),
    []
  )

  const cutoff = timeRangeToMs(timeRange)

  const auditEntries = useLiveQuery<AuditEntry[]>(() => {
    if (typeof window === "undefined") return Promise.resolve([])
    const cutoffAt = cutoff !== null ? Date.now() - cutoff : null
    let coll = getDb().connectorAudit.orderBy("at").reverse()
    if (cutoffAt !== null) {
      coll = coll.filter((r) => r.at >= cutoffAt)
    }
    return coll.limit(AUDIT_VIEW_LIMIT).toArray()
  }, [cutoff])

  const toggleAdapter = (id: string) => {
    setSelectedAdapters((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    )
  }

  const toggleKind = (kind: AuditKind) => {
    setSelectedKinds((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]
    )
  }

  const trimmedConversationKey = conversationKeyFilter.trim().toLowerCase()
  const scopedEntries = (auditEntries ?? []).filter((e) => {
    if (selectedAdapters.length > 0 && !selectedAdapters.includes(e.adapterId)) return false
    if (selectedKinds.length > 0) {
      if (!selectedKinds.includes(e.kind)) return false
    } else {
      // Default view excludes `adapter.heartbeat`. As of v51 heartbeats live
      // in their own `connectorHeartbeats` table and no longer land here, so
      // this now only hides legacy heartbeat rows written to `connectorAudit`
      // before the migration (they age out under the 5 000-row cap). The
      // guard is cheap and also catches any future "noisy by default" kinds.
      if (e.kind === "adapter.heartbeat") return false
    }
    if (trimmedConversationKey) {
      const key = e.conversationKey?.toLowerCase() ?? ""
      if (!key.includes(trimmedConversationKey)) return false
    }
    return true
  })
  const safetyCount = scopedEntries.filter(
    (entry) => entry.reason === "content_safety_blocked"
  ).length
  const filtered = safetyOnly
    ? scopedEntries.filter((entry) => entry.reason === "content_safety_blocked")
    : scopedEntries

  const showAdapterFilter = !adapterId && Boolean(adapters?.length)
  const adapterFilterActive = !adapterId && selectedAdapters.length > 0
  const filtersActive =
    selectedKinds.length > 0 ||
    safetyOnly ||
    Boolean(conversationKeyFilter) ||
    timeRange !== initialTimeRange ||
    adapterFilterActive
  const resetFilters = () => {
    setSelectedKinds([])
    setSelectedAdapters(adapterId ? [adapterId] : [])
    setSafetyOnly(false)
    setConversationKeyFilter("")
    setTimeRange(initialTimeRange)
  }

  const exportScope = adapterId ?? (selectedAdapters.length === 1 ? selectedAdapters[0] : null)
  const handleExport = (format: "csv" | "json") => {
    exportAuditView({
      rows: filtered as ConnectorAuditRow[],
      format,
      adapterId: exportScope,
    })
  }

  const adapterSummary =
    selectedAdapters.length === 0
      ? t("allAdapters")
      : selectedAdapters.length === 1
        ? (adapters?.find((adapter) => adapter.id === selectedAdapters[0])?.displayName ??
          t("selectedCount", { count: 1 }))
        : t("selectedCount", { count: selectedAdapters.length })
  const kindSummary =
    selectedKinds.length === 0
      ? t("allKinds")
      : selectedKinds.length === 1
        ? auditKindLabel(tKind, selectedKinds[0])
        : t("selectedCount", { count: selectedKinds.length })
  const triggerClass = (active: boolean) =>
    cn(
      "h-8 max-w-56 justify-start gap-1.5 font-normal",
      active && "border-primary/40 bg-primary/5 text-foreground"
    )

  return (
    <div className="@container/audit min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="h-8 min-w-48 flex-1 basis-56">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            id="audit-conv-key"
            value={conversationKeyFilter}
            onChange={(event) => setConversationKeyFilter(event.target.value)}
            placeholder={t("filterByConversationKeyPlaceholder")}
            aria-label={t("filterByConversationKey")}
            data-testid="audit-conv-key-input"
            className="text-xs"
          />
        </InputGroup>
        {showAdapterFilter && adapters && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                id="audit-adapter-filter"
                type="button"
                variant="outline"
                size="sm"
                className={triggerClass(adapterFilterActive)}
                aria-label={t("adapterFilterLabel")}
              >
                <BotIcon className="size-3.5 text-muted-foreground" aria-hidden />
                <span className="truncate">{adapterSummary}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
              <DropdownMenuGroup>
                <DropdownMenuCheckboxItem
                  checked={selectedAdapters.length === 0}
                  onCheckedChange={() => setSelectedAdapters([])}
                  onSelect={(event) => event.preventDefault()}
                >
                  {t("allAdapters")}
                </DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {adapters.map((adapter) => (
                  <DropdownMenuCheckboxItem
                    key={adapter.id}
                    checked={selectedAdapters.includes(adapter.id)}
                    onCheckedChange={() => toggleAdapter(adapter.id)}
                    onSelect={(event) => event.preventDefault()}
                    aria-label={t("filterByAdapterAria", { name: adapter.displayName })}
                  >
                    {adapter.displayName}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              id="audit-kind-filter"
              type="button"
              variant="outline"
              size="sm"
              className={triggerClass(selectedKinds.length > 0)}
              aria-label={t("kindFilterLabel")}
            >
              <ListFilterIcon className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="truncate">{kindSummary}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
            <DropdownMenuGroup>
              <DropdownMenuCheckboxItem
                checked={selectedKinds.length === 0}
                onCheckedChange={() => setSelectedKinds([])}
                onSelect={(event) => event.preventDefault()}
              >
                {t("allKinds")}
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {ALL_AUDIT_KINDS.map((kind) => (
                <DropdownMenuCheckboxItem
                  key={kind}
                  checked={selectedKinds.includes(kind)}
                  onCheckedChange={() => toggleKind(kind)}
                  onSelect={(event) => event.preventDefault()}
                  aria-label={t("filterByKindAria", { kind: auditKindLabel(tKind, kind) })}
                >
                  {auditKindLabel(tKind, kind)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Select value={timeRange} onValueChange={(value) => setTimeRange(value as TimeRange)}>
          <SelectTrigger
            id="audit-time-range"
            aria-label={t("timeRangeLabel")}
            size="sm"
            className={cn(
              "h-8 w-auto gap-1.5",
              timeRange !== initialTimeRange && "border-primary/40 bg-primary/5"
            )}
          >
            <ClockIcon className="size-3.5 text-muted-foreground" aria-hidden />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {TIME_RANGE_OPTIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`timeRange.${value}`)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              disabled={filtered.length === 0}
              data-testid="audit-export-trigger"
            >
              <DownloadIcon className="size-3.5" aria-hidden />
              {t("exportLabel", { count: filtered.length })}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => handleExport("csv")} data-testid="audit-export-csv">
                {t("exportCsv")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => handleExport("json")}
                data-testid="audit-export-json"
              >
                {t("exportJson")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <p className="flex flex-wrap items-center gap-x-2">
          <span className="font-medium text-foreground">
            {t("entryCount", { count: filtered.length })}
          </span>
          <span aria-hidden>·</span>
          <span className={cn(safetyCount > 0 && "text-violet-700 dark:text-violet-300")}>
            {t("safetySummary", { count: safetyCount })}
          </span>
        </p>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="audit-safety-only"
              checked={safetyOnly}
              onCheckedChange={(checked) => setSafetyOnly(checked === true)}
            />
            <Label htmlFor="audit-safety-only" className="text-xs font-normal">
              {t("safetyOnly")}
            </Label>
          </div>
          {filtersActive && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={resetFilters}
            >
              {t("resetFilters")}
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        {filtered.length === 0 ? (
          <Empty className="border-0 py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchIcon />
              </EmptyMedia>
              <EmptyDescription>{t("empty")}</EmptyDescription>
            </EmptyHeader>
            {filtersActive && (
              <EmptyContent>
                <Button type="button" variant="outline" size="sm" onClick={resetFilters}>
                  {t("resetFilters")}
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <>
            <div
              aria-hidden
              className={cn(
                "hidden gap-x-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground",
                adapterId ? ROW_GRID_SCOPED : ROW_GRID_WITH_ADAPTER
              )}
            >
              <span />
              <span>{t("columns.time")}</span>
              {!adapterId && <span>{t("columns.adapter")}</span>}
              <span>{t("columns.event")}</span>
              <span>{t("columns.details")}</span>
            </div>
            <ul className="max-h-[36rem] divide-y overflow-y-auto">
              {filtered.map((entry) => (
                <AuditRow
                  key={entry.id}
                  entry={entry}
                  showAdapter={!adapterId}
                  adapterLabel={
                    adapters?.find((adapter) => adapter.id === entry.adapterId)?.displayName
                  }
                />
              ))}
            </ul>
          </>
        )}
      </div>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          {t("redactionNotice")} {t("limitNotice", { count: AUDIT_VIEW_LIMIT })}
        </span>
      </p>
    </div>
  )
}
