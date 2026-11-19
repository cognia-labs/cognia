"use client"

/**
 * AttentionPanel — the Control Center: one status-bar surface for every
 * pending item across chat tool approvals, agent-team HITL gates, and
 * external fleet agents. Modeled on `components/shell/job-center-panel.tsx`
 * (Sheet + badge trigger).
 *
 * Actions are honest about ownership: chat/team rows NAVIGATE to the surface
 * that owns the answer (the pane's ToolApprovalDialog / the workspace's
 * GateModalsHost), fleet permission rows answer inline via the same
 * `IslandPermissionActions` the island uses (window-agnostic invoke), and
 * stale rows offer only Dismiss.
 */

import { useRouter } from "next/navigation"
import { BellRingIcon, ExternalLinkIcon, FileTextIcon, TerminalIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useId } from "react"

import { useAttentionItems, useAttentionCount } from "@/hooks/attention/use-attention"
import { useChatStore } from "@/stores/chat/chat-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { IslandPermissionActions } from "@/components/fleet/island-permission-actions"
import { activityLine } from "@/lib/fleet/format"
import { fleetFocusTerminal, fleetRevealTranscript } from "@/lib/tauri/fleet"
import type { AttentionItem } from "@/lib/attention/types"
import { CHAT_ROUTE, focusSessionInItsWorkspace } from "@/lib/chat/focus-session"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

function AttentionRow({ item, onNavigated }: { item: AttentionItem; onNavigated: () => void }) {
  const t = useTranslations("attention")
  const router = useRouter()

  /**
   * The conversation that asked, in its own workspace and guild. A fixed
   * Direct Messages guild and the current workspace used to open a team's
   * approval, or another workspace's, onto the wrong conversation or none:
   * the chat pane only reads the active workspace's conversations. Routed
   * after the focus, so the pane never renders the previous one first.
   */
  const openChatSession = () => {
    const sessionId = item.sessionId
    if (!sessionId) return
    void focusSessionInItsWorkspace(sessionId).then(() => {
      router.push(CHAT_ROUTE)
      onNavigated()
    })
  }
  /**
   * A durable run approval is answered where the run lives, not here: the
   * cockpit has the run's revision, its pending interrupt id and the control
   * plane. Sending the user there beats an inline button that would have to
   * re-derive all three from a list row.
   */
  const openRunCockpit = () => {
    if (!item.runId) return
    router.push(`/agent-runs?run=${encodeURIComponent(item.runId)}`)
    onNavigated()
  }
  const openTeamWorkspace = () => {
    router.push(item.teamId ? `/squads?id=${encodeURIComponent(item.teamId)}` : "/squads")
    onNavigated()
  }
  /**
   * Whether Dismiss can actually clear this row.
   *
   * A `human_handoff` is deliberately excluded even past its deadline:
   * `recoverPendingRunInterrupts` refuses to expire that type for the same
   * reason, because expiring it would silently un-assign work a person still
   * owns. Fleet rows have no clearing path at all. Rendering the button for
   * either would be an affordance that does nothing.
   */
  const canDismiss =
    (item.source === "chat" && Boolean(item.approval)) ||
    (item.source === "team" && Boolean(item.gate)) ||
    (item.source === "run" && Boolean(item.interrupt) && item.interrupt?.type !== "human_handoff")

  const dismiss = () => {
    if (item.source === "chat" && item.approval) {
      useChatStore.getState().clearApproval(item.approval.requestId, item.sessionId)
    } else if (item.source === "team" && item.gate) {
      usePendingGatesStore.getState().close(item.gate.key)
    } else if (item.source === "run" && item.interrupt) {
      // Only ever reached from the stale branch, i.e. the row is already past
      // its deadline — this is the sweep the recovery pass would have run.
      const { runId, id } = item.interrupt
      void import("@/lib/execution/run-control").then(({ expireRunInterruptFromSource }) =>
        expireRunInterruptFromSource(runId, id)
      )
    }
  }

  return (
    <div
      data-testid={`attention-row-${item.id}`}
      className={cn(
        "flex items-start gap-2 rounded-md border p-2 text-sm",
        item.stale && "opacity-60"
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {t(`source.${item.source}`)}
          </Badge>
          <span className="truncate font-medium">{item.title}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {item.stale
            ? t("interrupted")
            : (item.detail ??
              (item.fleetSession
                ? (activityLine(item.fleetSession) ?? t(`kind.${item.kind}`))
                : t(`kind.${item.kind}`)))}
        </p>
        {!item.stale &&
          item.kind === "fleet-permission" &&
          item.fleetSession?.pendingPermission && (
            <IslandPermissionActions
              pending={item.fleetSession.pendingPermission}
              className="mt-1"
            />
          )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!item.stale && item.source === "chat" && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("openOwner")}
            onClick={openChatSession}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        )}
        {!item.stale && item.source === "run" && item.runId && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("openOwner")}
            data-testid={`attention-open-run-${item.id}`}
            onClick={openRunCockpit}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        )}
        {!item.stale && item.source === "team" && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("openOwner")}
            onClick={openTeamWorkspace}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        )}
        {!item.stale &&
          item.source === "fleet" &&
          item.fleetSession?.capabilities.openTranscript &&
          item.fleetSession?.transcriptPath && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("revealTranscript")}
              data-testid={`attention-reveal-transcript-${item.id}`}
              onClick={() => {
                const path = item.fleetSession?.transcriptPath
                if (path) void fleetRevealTranscript(path)
              }}
            >
              <FileTextIcon className="size-3.5" />
            </Button>
          )}
        {!item.stale &&
          item.source === "fleet" &&
          item.fleetSession?.capabilities.focusTerminal && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("focusTerminal")}
              data-testid={`attention-focus-terminal-${item.id}`}
              onClick={() => {
                const s = item.fleetSession
                if (s) void fleetFocusTerminal(s.agent, s.sessionId)
              }}
            >
              <TerminalIcon className="size-3.5" />
            </Button>
          )}
        {item.stale && canDismiss && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("dismiss")}
            onClick={dismiss}
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * The same items inline, on the page the navigation's Agent Runs badge sends
 * people to (`lib/shell/nav-badges.ts`: the badge counts these, and
 * `/agent-runs` is where runs are). The run list there shows runs, not chat
 * approvals, team gates or waiting fleet agents, so a badge of 3 opened onto
 * a list with none of the three in it (sidebar audit item 13). Same rows, same
 * actions as the sheet; nothing at all while nothing waits.
 */
export function AttentionSection({ className }: { className?: string }) {
  const t = useTranslations("attention")
  const items = useAttentionItems()
  const count = useAttentionCount()
  const headingId = useId()
  if (items.length === 0) return null
  return (
    <section
      aria-labelledby={headingId}
      data-testid="attention-section"
      className={cn("flex min-h-0 flex-col gap-2", className)}
    >
      <div className="flex items-baseline gap-2">
        <h2 id={headingId} className="text-sm font-medium">
          {t("section.title")}
        </h2>
        {count > 0 ? (
          <span
            className="text-xs font-medium text-amber-600"
            data-testid="attention-section-count"
          >
            {count}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t("section.description")}</p>
      <div className="grid min-h-0 gap-2 overflow-y-auto md:grid-cols-2">
        {items.map((item) => (
          <AttentionRow key={item.id} item={item} onNavigated={() => {}} />
        ))}
      </div>
    </section>
  )
}

export function AttentionPanel() {
  const t = useTranslations("attention")
  const items = useAttentionItems()
  const count = useAttentionCount()

  // Nothing to attend to means no trigger: it used to sit in the status bar all
  // day showing a bell with no number. Self-gating also lets the surviving
  // affordance stay loud (amber + pulse + count) instead of being flattened
  // into a neighbouring menu to save space.
  //
  // Gated on `items`, NOT `count` — `liveAttentionCount` excludes stale rows,
  // and those still need their Dismiss. Hiding on a zero count would strand a
  // list of dead approvals with no way to open the sheet that clears them.
  if (items.length === 0) return null

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          data-testid="attention-trigger"
          aria-label={t("badgeAria", { count })}
          className={cn(
            "relative flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground",
            "hover:bg-accent hover:text-accent-foreground"
          )}
        >
          <BellRingIcon className={cn("size-3.5", count > 0 && "animate-pulse text-amber-500")} />
          {count > 0 && (
            <span data-testid="attention-count" className="font-medium text-amber-600">
              {count}
            </span>
          )}
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-96 flex-col gap-3 sm:max-w-96">
        <SheetHeader className="pb-0">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        {items.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BellRingIcon />
              </EmptyMedia>
              <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
              <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-2 pr-3">
              {items.map((item) => (
                <AttentionRow key={item.id} item={item} onNavigated={() => {}} />
              ))}
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  )
}
