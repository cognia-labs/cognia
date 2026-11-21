"use client"

/**
 * Unified Personal Responsibility Center (`/inbox/needs-me`, F10).
 *
 * Surfaces everything waiting on the owner in one actionable Inbox view:
 *  - Pending outbound drafts (`connectorDrafts`)
 *  - Live & durable HITL approvals (`AttentionItem`s / `executionRunInterrupts`)
 *  - Overdue SLA conversations (`conversationOverrides`)
 *  - Blocked commitments (stalled inbound jobs, paused/limited Goals, failed tasks)
 *  - Undecided Attention Radar suggestions (`radarReports`)
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ClockIcon,
  ExternalLinkIcon,
  FileTextIcon,
  ShieldAlertIcon,
  SparklesIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Surface } from "@/components/surface/surface"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
import { dismissConnectorInboundJobRecovery } from "@/lib/db/connector-inbound-jobs"
import { respondRunApproval } from "@/lib/execution/run-approvals"
import { inboxSessionHref } from "@/lib/inbox/conversation-href"
import { decideRadarSuggestion } from "@/lib/radar/suggestions"
import {
  usePersonalResponsibilities,
  type PersonalResponsibilityItem,
  type ResponsibilityKind,
} from "@/hooks/inbox/use-personal-responsibilities"
import { parseConversationKey } from "@/types/connectors/event"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { DraftEditor } from "./draft-editor"
import { PlatformBadge } from "./platform-badge"
import { StateCard } from "./state/state-card"

type FilterKind = "all" | ResponsibilityKind

const FILTER_ORDER: readonly FilterKind[] = [
  "all",
  "hitl_approval",
  "sla_overdue",
  "outbound_draft",
  "blocked_commitment",
  "radar_suggestion",
]

export function NeedsMeCenter() {
  const t = useTranslations("inbox.needsMe")
  const router = useRouter()
  const { loading, items, countsByKind } = usePersonalResponsibilities()
  const [filter, setFilter] = useState<FilterKind>("all")
  const [busyId, setBusyId] = useState<string | null>(null)

  const filtered = filter === "all" ? items : items.filter((item) => item.kind === filter)

  const runAction = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id)
    try {
      await fn()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("actionFailed"))
    } finally {
      setBusyId(null)
    }
  }

  const openChatSession = (sessionId: string) => {
    void import("@/lib/chat/focus-session").then(({ CHAT_ROUTE, focusSessionInItsWorkspace }) =>
      focusSessionInItsWorkspace(sessionId).then(() => router.push(CHAT_ROUTE))
    )
  }

  if (loading && items.length === 0) {
    return (
      <div
        className="flex-1"
        role="status"
        aria-busy="true"
        aria-label={t("loading")}
        data-testid="needs-me-loading"
      >
        <StateCard.Loading rows={3} className="gap-3 p-4" />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="needs-me-center">
      <div className="flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">{t("title")}</h3>
            <p className="text-xs text-muted-foreground">{t("subtitle")}</p>
          </div>
          <Badge variant="secondary" data-testid="needs-me-total-badge">
            {items.length}
          </Badge>
        </div>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("filterAria")}>
          {FILTER_ORDER.map((kind) => {
            const count = kind === "all" ? items.length : countsByKind[kind]
            const active = filter === kind
            return (
              <Button
                key={kind}
                type="button"
                size="sm"
                variant={active ? "secondary" : "ghost"}
                aria-pressed={active}
                className="h-7 gap-1.5 px-2.5 text-xs"
                data-testid={`needs-me-filter-${kind}`}
                onClick={() => setFilter(kind)}
              >
                <span>{t(`filters.${kind}`)}</span>
                {count > 0 && (
                  <Badge variant="outline" className="h-4 px-1 text-[10px] leading-none">
                    {count}
                  </Badge>
                )}
              </Button>
            )
          })}
        </div>
      </div>

      {filtered.length === 0 ? (
        <Empty className="flex-1 border-0" data-testid="needs-me-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CheckCircle2Icon />
            </EmptyMedia>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-4">
            {filtered.map((item) => (
              <ResponsibilityCard
                key={item.id}
                item={item}
                busy={busyId === item.id}
                onRunAction={(fn) => runAction(item.id, fn)}
                onOpenConversation={(conversationKey, sessionId) =>
                  router.push(inboxSessionHref(conversationKey, sessionId))
                }
                onOpenSession={openChatSession}
                onNavigate={(href) => router.push(href)}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

function safePlatform(conversationKey: string): PlatformKind | undefined {
  try {
    return parseConversationKey(conversationKey).platform as PlatformKind
  } catch {
    return undefined
  }
}

function ResponsibilityCard({
  item,
  busy,
  onRunAction,
  onOpenConversation,
  onOpenSession,
  onNavigate,
}: {
  item: PersonalResponsibilityItem
  busy: boolean
  onRunAction: (fn: () => Promise<void>) => Promise<void>
  onOpenConversation: (conversationKey: string, sessionId?: string) => void
  onOpenSession: (sessionId: string) => void
  onNavigate: (href: string) => void
}) {
  const t = useTranslations("inbox.needsMe")

  if (item.kind === "outbound_draft") {
    const platform = safePlatform(item.conversationKey)
    return (
      <Surface
        variant="panel"
        padding="sm"
        className="space-y-2"
        data-testid={`needs-me-item-${item.id}`}
      >
        <div className="flex items-center gap-2 text-xs">
          <FileTextIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
          <Badge variant="outline" className="text-[10px]">
            {t("kinds.outbound_draft")}
          </Badge>
          {platform ? <PlatformBadge platform={platform} /> : null}
          <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onOpenConversation(item.conversationKey, item.sessionId)}
          >
            {t("actions.openConversation")}
          </Button>
        </div>
        <DraftEditor draft={item.draft} />
      </Surface>
    )
  }

  return (
    <Surface variant="panel" padding="sm" data-testid={`needs-me-item-${item.id}`}>
      <ItemGroup>
        <Item size="sm" className="px-0 py-0">
          <ItemContent className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {item.kind === "hitl_approval" && (
                <ShieldAlertIcon className="size-3.5 shrink-0 text-amber-500" aria-hidden />
              )}
              {item.kind === "sla_overdue" && (
                <ClockIcon className="size-3.5 shrink-0 text-destructive" aria-hidden />
              )}
              {item.kind === "blocked_commitment" && (
                <AlertTriangleIcon className="size-3.5 shrink-0 text-amber-500" aria-hidden />
              )}
              {item.kind === "radar_suggestion" && (
                <SparklesIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
              )}
              <Badge
                variant={item.priority === "urgent" ? "destructive" : "outline"}
                className="text-[10px]"
              >
                {t(`kinds.${item.kind}`)}
              </Badge>
              <ItemTitle className="max-w-full truncate text-sm">{item.title}</ItemTitle>
            </div>
            {item.kind === "sla_overdue" ? (
              <p className="text-xs text-destructive">
                {t("slaOverdueDetail", { minutes: item.overdueMinutes })}
              </p>
            ) : item.subtitle ? (
              <p className="truncate text-xs text-muted-foreground">{item.subtitle}</p>
            ) : null}
          </ItemContent>

          <ItemActions className="flex flex-wrap items-center gap-1.5">
            {item.kind === "hitl_approval" && (
              <>
                {item.attention.interrupt && (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      disabled={busy}
                      data-testid={`needs-me-approve-${item.id}`}
                      onClick={() =>
                        void onRunAction(async () => {
                          const res = await respondRunApproval({
                            interruptId: item.attention.interrupt!.id,
                            decision: "approve",
                            callerDeviceId: "local-inbox-operator",
                          })
                          if (!res.ok) throw new Error(res.reason)
                          toast.success(t("toasts.approved"))
                        })
                      }
                    >
                      {t("actions.approve")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2.5 text-xs"
                      disabled={busy}
                      data-testid={`needs-me-deny-${item.id}`}
                      onClick={() =>
                        void onRunAction(async () => {
                          const res = await respondRunApproval({
                            interruptId: item.attention.interrupt!.id,
                            decision: "deny",
                            callerDeviceId: "local-inbox-operator",
                          })
                          if (!res.ok) throw new Error(res.reason)
                          toast.success(t("toasts.denied"))
                        })
                      }
                    >
                      {t("actions.deny")}
                    </Button>
                  </>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => {
                    if (item.attention.sessionId) {
                      onOpenSession(item.attention.sessionId)
                    } else if (item.attention.runId) {
                      onNavigate(`/agent-runs?run=${encodeURIComponent(item.attention.runId)}`)
                    } else if (item.attention.teamId) {
                      onNavigate(`/squads?id=${encodeURIComponent(item.attention.teamId)}`)
                    } else {
                      onNavigate("/agent-runs")
                    }
                  }}
                >
                  <ExternalLinkIcon className="size-3" aria-hidden />
                  {t("actions.open")}
                </Button>
              </>
            )}

            {item.kind === "sla_overdue" && (
              <>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => onOpenConversation(item.conversationKey, item.sessionId)}
                >
                  {t("actions.replyNow")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-xs"
                  disabled={busy}
                  data-testid={`needs-me-resolve-sla-${item.id}`}
                  onClick={() =>
                    void onRunAction(async () => {
                      await mutateConversationOverride({
                        kind: "upsert",
                        input: {
                          conversationKey: item.conversationKey,
                          sessionId: item.sessionId,
                          status: "resolved",
                        },
                      })
                      toast.success(t("toasts.resolved"))
                    })
                  }
                >
                  {t("actions.markResolved")}
                </Button>
              </>
            )}

            {item.kind === "blocked_commitment" && (
              <>
                {item.commitmentKind === "inbound_recovery" && item.inboundJob && (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => onOpenConversation(item.inboundJob!.conversationKey)}
                    >
                      {t("actions.openConversation")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={busy}
                      data-testid={`needs-me-dismiss-recovery-${item.id}`}
                      onClick={() =>
                        void onRunAction(async () => {
                          await dismissConnectorInboundJobRecovery(item.inboundJob!.id)
                          toast.success(t("toasts.dismissed"))
                        })
                      }
                    >
                      {t("actions.dismiss")}
                    </Button>
                  </>
                )}
                {item.commitmentKind === "goal" && item.sessionId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => onOpenSession(item.sessionId!)}
                  >
                    {t("actions.openGoal")}
                  </Button>
                )}
                {item.commitmentKind === "scheduled_task" && item.taskId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2.5 text-xs"
                    onClick={() =>
                      onNavigate(`/scheduler?taskId=${encodeURIComponent(item.taskId!)}`)
                    }
                  >
                    {t("actions.openTask")}
                  </Button>
                )}
              </>
            )}

            {item.kind === "radar_suggestion" && (
              <>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={busy}
                  data-testid={`needs-me-accept-radar-${item.id}`}
                  onClick={() =>
                    void onRunAction(async () => {
                      await decideRadarSuggestion(
                        item.radar.reportId,
                        item.radar.suggestionId,
                        "accepted"
                      )
                      toast.success(t("toasts.radarAccepted"))
                    })
                  }
                >
                  {t("actions.acceptAndRun")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={busy}
                  data-testid={`needs-me-dismiss-radar-${item.id}`}
                  onClick={() =>
                    void onRunAction(async () => {
                      await decideRadarSuggestion(
                        item.radar.reportId,
                        item.radar.suggestionId,
                        "dismissed"
                      )
                      toast.success(t("toasts.dismissed"))
                    })
                  }
                >
                  {t("actions.dismiss")}
                </Button>
              </>
            )}
          </ItemActions>
        </Item>
      </ItemGroup>
    </Surface>
  )
}
