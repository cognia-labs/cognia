"use client"

/**
 * One Squad at a glance: what needs you, how the last run went, where its
 * tasks stand, whether it can run, and who is on it.
 *
 * Before this the Squad had no home on `/squads`. Selecting one narrowed the
 * runs list and opened an inspector holding the run controls and the
 * readiness card, and that was all: no roster, no last result, no cost, and a
 * "Needs you" badge with nowhere to answer it. Every one of those answers
 * already existed in the data; nothing put them in front of the reader.
 *
 * Laid out as `ConsoleSection` cards in the console-pane grid, the composition
 * `/bots`, `/devices` and the fleet overview use, so a Squad's page reads like
 * every other console's detail rather than as its own idiom.
 *
 * The order is triage, not a fixed template. Open reviews come first because
 * they are the only thing that will not move until answered, and a Squad that
 * cannot start leads with what to fix. Then the latest run and the tasks side
 * by side, then the roster, paired with readiness once readiness is settled.
 * The grid splits off this pane's own width, not the window's, because the
 * pane is narrower than the window by however wide the rail is.
 *
 * Editing the roster opens the Squad's edit drawer (`onEditRoster`) instead of
 * leaving for Settings.
 */

import Link from "next/link"
import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  ChevronRightIcon,
  ListChecksIcon,
  PlayCircleIcon,
  ShieldCheckIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react"

import { ExecutionStatusPill } from "@/components/agent-runs/agent-run-status-pill"
import { AgentTeamAvatar } from "@/components/agent/workspace/agent-team-avatar"
import { RuntimeBadge } from "@/components/agent/workspace/runtime-badge"
import { SquadReadinessCard } from "@/components/squads/squad-readiness-card"
import { StatusBadge } from "@/components/status-badge"
import { ConsoleSection } from "@/components/surface/console-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { PendingSquadReview } from "@/hooks/squads/use-pending-squad-reviews"
import type { SquadRunControl } from "@/hooks/squads/use-squad-run-control"
import { useSquadReadiness, type SquadReadinessState } from "@/hooks/squads/use-squad-readiness"
import { mapExecutionStatus } from "@/lib/execution/monitor-model"
import { formatTokens, formatUsd } from "@/lib/observability/format-utils"
import { cn, formatDurationShort } from "@/lib/utils"
import {
  DEFAULT_TEAMMATE_RUNTIME,
  TEAMMATE_STATUS_CONFIG,
  type AgentTeam,
  type AgentTeamTask,
  type AgentTeammate,
  type TeamTaskStatus,
} from "@/types/agent/agent-team"

/**
 * The board's eight statuses folded into the four a glance needs. `review`
 * counts as in progress because the work is not done until it passes;
 * `cancelled` sits with failed because neither will finish on its own.
 */
export const TASK_GLANCE_GROUPS = ["open", "active", "blocked", "done", "failed"] as const
export type TaskGlanceGroup = (typeof TASK_GLANCE_GROUPS)[number]

const TASK_GLANCE_OF: Record<TeamTaskStatus, TaskGlanceGroup> = {
  pending: "open",
  claimed: "open",
  in_progress: "active",
  review: "active",
  blocked: "blocked",
  completed: "done",
  failed: "failed",
  cancelled: "failed",
}

export function countTasksByGlance(
  tasks: readonly Pick<AgentTeamTask, "status">[]
): Record<TaskGlanceGroup, number> {
  const counts: Record<TaskGlanceGroup, number> = {
    open: 0,
    active: 0,
    blocked: 0,
    done: 0,
    failed: 0,
  }
  for (const task of tasks) counts[TASK_GLANCE_OF[task.status] ?? "open"] += 1
  return counts
}

/** Lead first, then teammates by name, so the roster reads the same everywhere. */
export function orderRoster(
  members: readonly AgentTeammate[],
  leadId: string | undefined
): AgentTeammate[] {
  return [...members].sort((a, b) => {
    const aLead = a.id === leadId || a.role === "lead"
    const bLead = b.id === leadId || b.role === "lead"
    if (aLead !== bLead) return aLead ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export interface SquadOverviewProps {
  squad: AgentTeam
  members: readonly AgentTeammate[]
  tasks: readonly AgentTeamTask[]
  /** Open reviews on THIS Squad's runs, newest first. */
  reviews: readonly PendingSquadReview[]
  control: SquadRunControl
  runHref: (runId: string) => string
  /** Switches the Squad view to its board. */
  onOpenBoard: () => void
  /** Opens the edit drawer on the members. */
  onEditRoster: () => void
  className?: string
}

export function SquadOverview({
  squad,
  members,
  tasks,
  reviews,
  control,
  runHref,
  onOpenBoard,
  onEditRoster,
  className,
}: SquadOverviewProps) {
  const readiness = useSquadReadiness(squad.id)
  // On a companion the Host judges readiness at start time, so there is
  // nothing local to be blocked on and the section stays beside the roster.
  const blocked = !control.remote && !readiness.loading && !readiness.ready

  const readinessSection = (
    <ReadinessSection
      key="readiness"
      squad={squad}
      control={control}
      readiness={readiness}
      wide={blocked}
      onAddTeammate={onEditRoster}
    />
  )

  return (
    <div
      className={cn("@container/console-pane", className)}
      data-testid="squad-overview"
      data-blocked={blocked}
    >
      {/* `items-start` so a short card keeps its own height instead of being
          stretched to match the tall one beside it. */}
      <div className="grid items-start gap-3.5 @3xl/console-pane:grid-cols-2">
        {reviews.length > 0 ? <NeedsYouSection reviews={reviews} runHref={runHref} /> : null}
        {blocked ? readinessSection : null}
        <LatestRunSection control={control} runHref={runHref} />
        <TasksSection tasks={tasks} onOpenBoard={onOpenBoard} />
        <RosterSection squad={squad} members={members} wide={blocked} onEditRoster={onEditRoster} />
        {blocked ? null : readinessSection}
      </div>
    </div>
  )
}

/* ── Section frame ─────────────────────────────────────────────────────── */

function OverviewSection({
  id,
  title,
  icon,
  meta,
  action,
  wide,
  children,
}: {
  id: string
  title: string
  icon: LucideIcon
  meta?: React.ReactNode
  action?: React.ReactNode
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <ConsoleSection
      id={id}
      idPrefix="squad-overview"
      title={title}
      icon={icon}
      meta={meta}
      action={action}
      wide={wide}
    >
      {children}
    </ConsoleSection>
  )
}

/* ── Needs you ─────────────────────────────────────────────────────────── */

function NeedsYouSection({
  reviews,
  runHref,
}: {
  reviews: readonly PendingSquadReview[]
  runHref: (runId: string) => string
}) {
  const t = useTranslations("squads.overview")
  const tKinds = useTranslations("agentRuns.review.kinds")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  return (
    <OverviewSection
      id="needs-you"
      title={t("needsYou.title")}
      icon={AlertCircleIcon}
      wide
      meta={
        <Badge variant="destructive" className="text-[10px] tabular-nums">
          {reviews.length}
        </Badge>
      }
    >
      <ul className="space-y-1">
        {reviews.map((review) => (
          <li key={review.interruptId}>
            <Link
              href={runHref(review.executionRunId)}
              className="group -mx-1.5 flex items-start gap-2.5 rounded-md px-1.5 py-2 hover:bg-accent/60"
              data-testid="squad-overview-review"
            >
              <AlertCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{tKinds(`${review.kind}.title`)}</span>
                <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                  {tKinds(`${review.kind}.description`)}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {t("needsYou.asked", { when: format.relativeTime(review.createdAt, now) })}
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-0.5 self-center text-xs font-medium text-foreground">
                {t("needsYou.answer")}
                <ChevronRightIcon
                  aria-hidden
                  className="size-3.5 transition-transform group-hover:translate-x-0.5"
                />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </OverviewSection>
  )
}

/* ── Latest run ────────────────────────────────────────────────────────── */

function LatestRunSection({
  control,
  runHref,
}: {
  control: SquadRunControl
  runHref: (runId: string) => string
}) {
  const t = useTranslations("squads.overview")
  const format = useFormatter()
  const now = useNow({ updateInterval: 30_000 })
  const { run, record } = control

  if (!run) {
    return (
      <OverviewSection id="latest-run" title={t("latestRun.title")} icon={PlayCircleIcon}>
        <p className="text-xs text-muted-foreground" data-testid="squad-overview-no-run">
          {t("latestRun.none")}
        </p>
      </OverviewSection>
    )
  }

  // The durable record is the host's full tally; a paired device does not
  // carry it, and reads the same numbers off the run's synced snapshot.
  const usage = record?.resourceUsage ?? run.latestSnapshot?.usage
  const end = run.endedAt ?? now.getTime()
  const duration =
    usage?.wallTimeMs && usage.wallTimeMs > 0 ? usage.wallTimeMs : end - run.startedAt
  const objective = record?.objective?.trim() || run.title

  return (
    <OverviewSection
      id="latest-run"
      title={t("latestRun.title")}
      icon={PlayCircleIcon}
      action={
        <Link
          href={runHref(run.id)}
          className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
          data-testid="squad-overview-open-run"
        >
          {t("latestRun.open")}
          <ChevronRightIcon aria-hidden className="size-3.5" />
        </Link>
      }
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 line-clamp-2 text-sm" data-testid="squad-overview-objective">
          {objective}
        </p>
        <ExecutionStatusPill status={mapExecutionStatus(run.status)} className="shrink-0" />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 @lg/console-card:grid-cols-4">
        <Fact label={t("latestRun.started")}>{format.relativeTime(run.startedAt, now)}</Fact>
        <Fact label={t("latestRun.duration")}>{formatDurationShort(duration)}</Fact>
        <Fact label={t("latestRun.tokens")}>
          {usage ? formatTokens(usage.totalTokens) : t("latestRun.unknown")}
        </Fact>
        <Fact label={t("latestRun.cost")}>
          {usage?.costUsd !== undefined ? formatUsd(usage.costUsd) : t("latestRun.unknown")}
        </Fact>
      </dl>
    </OverviewSection>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] leading-tight text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-xs tabular-nums">{children}</dd>
    </div>
  )
}

/* ── Tasks ─────────────────────────────────────────────────────────────── */

function TasksSection({
  tasks,
  onOpenBoard,
}: {
  tasks: readonly AgentTeamTask[]
  onOpenBoard: () => void
}) {
  const t = useTranslations("squads.overview")
  const counts = countTasksByGlance(tasks)
  return (
    <OverviewSection
      id="tasks"
      title={t("tasks.title")}
      icon={ListChecksIcon}
      meta={<span className="text-xs tabular-nums text-muted-foreground">{tasks.length}</span>}
      action={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-0.5 px-2 text-xs text-muted-foreground"
          onClick={onOpenBoard}
          data-testid="squad-overview-open-board"
        >
          {t("tasks.openBoard")}
          <ChevronRightIcon aria-hidden className="size-3.5" />
        </Button>
      }
    >
      {tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="squad-overview-no-tasks">
          {t("tasks.none")}
        </p>
      ) : (
        <dl className="grid grid-cols-3 gap-x-6 gap-y-2 @lg/console-card:grid-cols-5">
          {TASK_GLANCE_GROUPS.map((group) => (
            <div key={group} className="min-w-0" data-testid={`squad-overview-tasks-${group}`}>
              <dt className="text-[11px] leading-tight text-muted-foreground">
                {t(`tasks.groups.${group}`)}
              </dt>
              <dd
                className={cn(
                  "mt-0.5 text-sm font-semibold tabular-nums",
                  counts[group] === 0 && "font-normal text-muted-foreground",
                  group === "blocked" && counts[group] > 0 && "text-destructive",
                  group === "failed" && counts[group] > 0 && "text-destructive"
                )}
              >
                {counts[group]}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </OverviewSection>
  )
}

/* ── Readiness ─────────────────────────────────────────────────────────── */

function ReadinessSection({
  squad,
  control,
  readiness,
  wide,
  onAddTeammate,
}: {
  squad: AgentTeam
  control: SquadRunControl
  readiness: SquadReadinessState
  wide: boolean
  onAddTeammate: () => void
}) {
  const t = useTranslations("squads")
  return (
    <OverviewSection id="readiness" title={t("readiness.title")} icon={ShieldCheckIcon} wide={wide}>
      {control.remote ? (
        <p className="text-xs text-muted-foreground" data-testid="squad-overview-remote-readiness">
          {t("fleet.control.remoteReadiness")}
        </p>
      ) : (
        <SquadReadinessCard
          squadId={squad.id}
          readiness={readiness}
          onAddTeammate={onAddTeammate}
        />
      )}
    </OverviewSection>
  )
}

/* ── Roster ────────────────────────────────────────────────────────────── */

function RosterSection({
  squad,
  members,
  wide,
  onEditRoster,
}: {
  squad: AgentTeam
  members: readonly AgentTeammate[]
  wide: boolean
  onEditRoster: () => void
}) {
  const t = useTranslations("squads.overview")
  const tMembers = useTranslations("agentTeamsWorkspace.members")
  const roster = orderRoster(members, squad.leadId)
  return (
    <OverviewSection
      id="roster"
      title={t("roster.title")}
      icon={UsersIcon}
      wide={wide}
      meta={<span className="text-xs tabular-nums text-muted-foreground">{roster.length}</span>}
      action={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={onEditRoster}
          data-testid="squad-overview-edit-roster"
        >
          {t("roster.edit")}
        </Button>
      }
    >
      {roster.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("roster.none")}</p>
      ) : (
        <ul className="space-y-2.5">
          {roster.map((member) => {
            const isLead = member.id === squad.leadId || member.role === "lead"
            const statusCfg = TEAMMATE_STATUS_CONFIG[member.status]
            return (
              <li
                key={member.id}
                className="flex items-center gap-2.5"
                data-testid={`squad-overview-member-${member.id}`}
              >
                <AgentTeamAvatar
                  subject={member}
                  className="size-7 shrink-0 rounded-full bg-primary/10 ring-1 ring-inset ring-primary/10"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate text-sm">{member.name}</span>
                    {isLead ? (
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {tMembers("lead")}
                      </Badge>
                    ) : null}
                  </div>
                  {member.config?.specialization || member.description ? (
                    <p className="truncate text-[11px] text-muted-foreground">
                      {member.config?.specialization || member.description}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <RuntimeBadge
                    runtime={member.config?.runtime ?? DEFAULT_TEAMMATE_RUNTIME}
                    iconOnly
                  />
                  {statusCfg ? (
                    <StatusBadge
                      value={statusCfg.labelKey ?? member.status}
                      labelNamespace="agentTeam.teammateStatus"
                      pulse={member.status === "executing" || member.status === "planning"}
                      className="text-[10px]"
                    />
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </OverviewSection>
  )
}

export default SquadOverview
