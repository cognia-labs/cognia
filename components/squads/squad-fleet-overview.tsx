"use client"

/**
 * `/squads` with no Squad selected: what to do next across the whole fleet.
 *
 * The centre used to be the full runs cockpit for every Squad, a list and a
 * detail beside a rail that is itself a list, so the page opened on three
 * columns of rows and no answer to "what needs me". It now answers that in
 * triage order:
 *
 *  1. Needs you: every open review on any Squad's run. These are the only
 *     things that will not move until someone answers, so they come first and
 *     each one links straight to its run in that Squad's Runs tab.
 *  2. Working now: the Squads planning or executing, one click from their page.
 *  3. Recent runs: the last few, with the way to the full cockpit on
 *     `/agent-runs`, which already lists every Squad's runs with filters.
 *
 * Laid out as `ConsoleSection` cards in the console-pane grid, the composition
 * `/bots` and `/devices` use, so the page reads as one of them.
 */

import Link from "next/link"
import { useMemo } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { ActivityIcon, AlertCircleIcon, ChevronRightIcon, HistoryIcon } from "lucide-react"

import { ExecutionStatusPill } from "@/components/agent-runs/agent-run-status-pill"
import { AgentTeamAvatar } from "@/components/agent/workspace/agent-team-avatar"
import { StatusBadge } from "@/components/status-badge"
import { ConsoleSection } from "@/components/surface/console-section"
import { Badge } from "@/components/ui/badge"
import { useExecutionCockpit } from "@/hooks/agent-runs/use-agent-runs"
import { usePendingSquadReviews } from "@/hooks/squads/use-pending-squad-reviews"
import { useSquadFleet, type SquadFleetRow } from "@/hooks/squads/use-squad-fleet"
import type { SquadRouteState } from "@/hooks/squads/use-squad-route-state"
import { cn } from "@/lib/utils"

/** How many runs the overview shows before handing over to `/agent-runs`. */
export const RECENT_RUN_LIMIT = 5

/** Every Squad run, in the cockpit that owns them. */
export const ALL_SQUAD_RUNS_HREF = "/agent-runs?kind=team"

/**
 * One run's address. Inside its Squad's Runs tab when the run names its Squad,
 * so the reader lands among that Squad's controls; otherwise the cockpit.
 */
export function squadRunHref(teamId: string | undefined, runId: string): string {
  const run = encodeURIComponent(runId)
  return teamId
    ? `/squads?id=${encodeURIComponent(teamId)}&tab=runs&run=${run}`
    : `${ALL_SQUAD_RUNS_HREF}&run=${run}`
}

export interface SquadFleetOverviewProps {
  route: SquadRouteState
  className?: string
}

export function SquadFleetOverview({ route, className }: SquadFleetOverviewProps) {
  const t = useTranslations("squads.fleetOverview")
  // The whole fleet, not the rail's narrowed copy: a search in the rail must
  // not hide a review waiting on someone.
  const fleet = useSquadFleet()
  const reviews = usePendingSquadReviews()
  const { rows: runs } = useExecutionCockpit({ kind: "team" })

  const squadsById = useMemo(
    () => new Map(fleet.squads.map((squad) => [squad.id, squad])),
    [fleet.squads]
  )
  const working = fleet.squads.filter((squad) => squad.live)
  const recent = runs.slice(0, RECENT_RUN_LIMIT)

  return (
    <div
      className={cn(
        "@container/console-pane h-full min-h-0 overflow-y-auto px-4 py-3.5",
        className
      )}
      data-testid="squad-fleet-overview"
    >
      <div className="mx-auto grid max-w-5xl items-start gap-3.5 @3xl/console-pane:grid-cols-2">
        <NeedsYouCard reviews={reviews} squadsById={squadsById} />
        <ConsoleSection
          id="working"
          idPrefix="squad-fleet-overview"
          title={t("working.title")}
          description={t("working.description")}
          icon={ActivityIcon}
          meta={working.length > 0 ? working.length : undefined}
        >
          {working.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="squad-fleet-overview-idle">
              {t("working.none")}
            </p>
          ) : (
            <ul className="-mx-1.5 space-y-0.5">
              {working.map((squad) => (
                <li key={squad.id}>
                  <WorkingRow squad={squad} onSelect={() => route.setSelectedId(squad.id)} />
                </li>
              ))}
            </ul>
          )}
        </ConsoleSection>

        <ConsoleSection
          id="recent-runs"
          idPrefix="squad-fleet-overview"
          title={t("recentRuns.title")}
          icon={HistoryIcon}
          wide
          action={
            <Link
              href={ALL_SQUAD_RUNS_HREF}
              className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
              data-testid="squad-fleet-overview-all-runs"
            >
              {t("recentRuns.viewAll")}
              <ChevronRightIcon aria-hidden className="size-3.5" />
            </Link>
          }
        >
          {recent.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="squad-fleet-overview-no-runs">
              {t("recentRuns.none")}
            </p>
          ) : (
            <ul className="-mx-1.5 divide-y divide-border/60">
              {recent.map((run) => (
                <li key={run.rowId}>
                  <RecentRunRow
                    href={squadRunHref(run.teamId, run.runId ?? run.nativeId)}
                    label={run.label}
                    status={run.status}
                    startedAt={run.startedAt}
                    squadName={run.teamId ? squadsById.get(run.teamId)?.name : undefined}
                  />
                </li>
              ))}
            </ul>
          )}
        </ConsoleSection>
      </div>
    </div>
  )
}

function NeedsYouCard({
  reviews,
  squadsById,
}: {
  reviews: ReturnType<typeof usePendingSquadReviews>
  squadsById: ReadonlyMap<string, SquadFleetRow>
}) {
  const t = useTranslations("squads.fleetOverview")
  const tOverview = useTranslations("squads.overview")
  const tKinds = useTranslations("agentRuns.review.kinds")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  return (
    <ConsoleSection
      id="needs-you"
      idPrefix="squad-fleet-overview"
      title={t("needsYou.title")}
      description={t("needsYou.description")}
      icon={AlertCircleIcon}
      meta={
        reviews.length > 0 ? (
          <Badge variant="destructive" className="text-[10px] tabular-nums">
            {reviews.length}
          </Badge>
        ) : undefined
      }
    >
      {reviews.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="squad-fleet-overview-calm">
          {t("needsYou.none")}
        </p>
      ) : (
        <ul className="-mx-1.5 space-y-0.5">
          {reviews.map((review) => (
            <li key={review.interruptId}>
              <Link
                href={squadRunHref(review.teamId, review.executionRunId)}
                className="group flex items-start gap-2.5 rounded-md px-1.5 py-2 hover:bg-accent/60"
                data-testid="squad-fleet-overview-review"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {tKinds(`${review.kind}.title`)}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {squadsById.get(review.teamId)?.name ?? review.teamId}
                    {" · "}
                    {tOverview("needsYou.asked", {
                      when: format.relativeTime(review.createdAt, now),
                    })}
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-0.5 self-center text-xs font-medium">
                  {tOverview("needsYou.answer")}
                  <ChevronRightIcon
                    aria-hidden
                    className="size-3.5 transition-transform group-hover:translate-x-0.5"
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ConsoleSection>
  )
}

function WorkingRow({ squad, onSelect }: { squad: SquadFleetRow; onSelect: () => void }) {
  const t = useTranslations("squads.fleet")
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="squad-fleet-overview-working-row"
    >
      <AgentTeamAvatar subject={squad} className="size-8 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{squad.name}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {t("memberCount", { count: squad.memberCount })}
        </span>
      </span>
      <StatusBadge
        value={squad.status}
        labelNamespace="agentTeam.status"
        className="shrink-0 text-[10px]"
        pulse
      />
    </button>
  )
}

function RecentRunRow({
  href,
  label,
  status,
  startedAt,
  squadName,
}: {
  href: string
  label: string
  status: React.ComponentProps<typeof ExecutionStatusPill>["status"]
  startedAt: number
  squadName: string | undefined
}) {
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-md px-1.5 py-2 hover:bg-accent/60"
      data-testid="squad-fleet-overview-run"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {squadName ? `${squadName} · ` : ""}
          {format.relativeTime(new Date(startedAt), now)}
        </span>
      </span>
      <ExecutionStatusPill status={status} className="shrink-0" />
    </Link>
  )
}

export default SquadFleetOverview
