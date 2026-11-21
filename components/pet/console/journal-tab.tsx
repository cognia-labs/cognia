// Journal tab: the pet's diary — the activity ledger (`petActivityLog`,
// written on every XP-bearing event since v67 but never surfaced before)
// grouped by local day, newest first, with per-day event/XP totals. Read
// reactively so a fresh interaction appears while the tab is open.
//
// It used to stop at a fixed 300 rows with no way further back. The head page
// is now live and "Load older" pages backwards by id; once an older page is
// loaded the live head is pinned from the oldest head row up
// (`listPetActivitySince`), so a new row arriving at the top cannot push a row
// out of the head and into the seam above the older pages. A kind the journal
// has no wording for reads as a generic entry, never as its raw id.

"use client"

import { useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import {
  AwardIcon,
  BellIcon,
  BellRingIcon,
  CakeIcon,
  ExternalLinkIcon,
  HandIcon,
  EggIcon,
  FlameIcon,
  Loader2Icon,
  PartyPopperIcon,
  PlugIcon,
  RadarIcon,
  BotIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  CookieIcon,
  DropletsIcon,
  EyeIcon,
  Gamepad2Icon,
  HandHeartIcon,
  HeartPulseIcon,
  InboxIcon,
  MessageCircleIcon,
  MoonIcon,
  SparklesIcon,
  TargetIcon,
  TrophyIcon,
  TrendingUpIcon,
  ThermometerIcon,
  UserRoundCheckIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription } from "@/components/ui/empty"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { getAttentionSnapshot, subscribeAttention } from "@/lib/attention/attention-store"
import type { AttentionItem } from "@/lib/attention/types"
import { listPetActivityPage, listPetActivitySince } from "@/lib/db/pet"
import { localDayKey } from "@/lib/pet/economy/streak"
import type { PetActivityRow } from "@/types/pet"
import { PetTabSkeleton } from "./pet-console-skeleton"

/** Rows per page — the live head and each "Load older" step. */
export const JOURNAL_PAGE = 100

/**
 * Kinds with an authored `pet.journal.kinds.<kind>` label. Anything else (a
 * future event kind, a plugin's) falls back to `journal.kinds.other`; the
 * co-located test checks both locales author every key listed here.
 */
export const JOURNAL_KIND_ICONS: Record<string, LucideIcon> = {
  review: EyeIcon,
  success: CheckCircle2Icon,
  goalProgress: TrendingUpIcon,
  goalComplete: TargetIcon,
  teamRun: BotIcon,
  workflowRun: WorkflowIcon,
  inboundMessage: InboxIcon,
  scheduledRun: CalendarClockIcon,
  scheduledRunStarting: BellIcon,
  fed: CookieIcon,
  played: Gamepad2Icon,
  petted: HandHeartIcon,
  talked: MessageCircleIcon,
  slept: MoonIcon,
  cleaned: DropletsIcon,
  treated: HeartPulseIcon,
  hatched: EggIcon,
  levelUp: AwardIcon,
  evolved: PartyPopperIcon,
  achievementUnlocked: TrophyIcon,
  birthday: CakeIcon,
  streakDay: FlameIcon,
  pluginReward: PlugIcon,
  radarReport: RadarIcon,
  twinMilestone: UserRoundCheckIcon,
  unwell: ThermometerIcon,
  greeting: HandIcon,
}

interface DayGroup {
  day: string
  /** Epoch ms of the newest row in the group (formats the heading). */
  ts: number
  rows: PetActivityRow[]
  totalXp: number
}

/** Group newest-first rows into contiguous local-day sections. Pure. */
export function groupByLocalDay(rows: PetActivityRow[]): DayGroup[] {
  const groups: DayGroup[] = []
  for (const row of rows) {
    const day = localDayKey(row.ts)
    const last = groups[groups.length - 1]
    if (last && last.day === day) {
      last.rows.push(row)
      last.totalXp += row.xp
    } else {
      groups.push({ day, ts: row.ts, rows: [row], totalXp: row.xp })
    }
  }
  return groups
}

const EMPTY_ATTENTION: readonly AttentionItem[] = []

export function JournalTab() {
  const t = useTranslations("pet")
  const locale = useLocale()
  const router = useRouter()
  const attentionItems = useSyncExternalStore(
    subscribeAttention,
    getAttentionSnapshot,
    () => EMPTY_ATTENTION
  )
  const pendingAttention = attentionItems.filter((item) => !item.stale)
  // Older pages, appended by "Load older"; immutable once read.
  const [older, setOlder] = useState<PetActivityRow[]>([])
  // Set on the first "Load older": the live head becomes "this id and up".
  const [floorId, setFloorId] = useState<number | undefined>(undefined)
  const [exhausted, setExhausted] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const head = useLiveQuery(
    () =>
      floorId === undefined
        ? listPetActivityPage(undefined, JOURNAL_PAGE)
        : listPetActivitySince(floorId),
    [floorId]
  )

  const openAttentionItem = (item: AttentionItem) => {
    if (item.source === "chat" && item.sessionId) {
      const sessionId = item.sessionId
      void import("@/lib/chat/focus-session").then(({ CHAT_ROUTE, focusSessionInItsWorkspace }) =>
        focusSessionInItsWorkspace(sessionId).then(() => router.push(CHAT_ROUTE))
      )
      return
    }
    if (item.source === "run" && item.runId) {
      router.push(`/agent-runs?run=${encodeURIComponent(item.runId)}`)
      return
    }
    if (item.source === "team") {
      router.push(item.teamId ? `/squads?id=${encodeURIComponent(item.teamId)}` : "/squads")
      return
    }
    router.push("/agent-runs")
  }

  const attentionSection =
    pendingAttention.length > 0 ? (
      <section
        data-testid="pet-attention-list"
        className="flex flex-col gap-2 rounded-lg border bg-card/60 p-3"
      >
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          <BellRingIcon className="size-3.5 text-primary" aria-hidden />
          <span>{t("journal.attention.title", { count: pendingAttention.length })}</span>
        </div>
        <ItemGroup>
          {pendingAttention.map((item) => (
            <Item
              key={item.id}
              data-testid={`pet-attention-item-${item.id}`}
              size="sm"
              className="min-w-0 px-0"
            >
              <ItemContent className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {t(`journal.attention.sources.${item.source}`)}
                  </Badge>
                  <ItemTitle className="max-w-full truncate">{item.title}</ItemTitle>
                </div>
                {item.detail ? (
                  <p className="truncate text-xs text-muted-foreground">{item.detail}</p>
                ) : null}
              </ItemContent>
              <ItemActions className="shrink-0">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => openAttentionItem(item)}
                >
                  <ExternalLinkIcon className="size-3.5" aria-hidden />
                  {t("journal.attention.open")}
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      </section>
    ) : null

  if (!head) {
    return <PetTabSkeleton testId="pet-journal-loading" />
  }
  const rows = [...head, ...older]
  if (rows.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        {attentionSection}
        <Empty data-testid="pet-journal-empty" className="py-8">
          <EmptyDescription>{t("journal.empty")}</EmptyDescription>
        </Empty>
      </div>
    )
  }

  // Until the first older page arrives, "more" means the head page was full.
  const hasMore = !exhausted && (older.length > 0 || head.length >= JOURNAL_PAGE)

  const loadOlder = async () => {
    const oldestId = rows[rows.length - 1]?.id
    if (oldestId === undefined || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await listPetActivityPage(oldestId, JOURNAL_PAGE)
      if (floorId === undefined) setFloorId(head[head.length - 1]?.id)
      setOlder((prev) => [...prev, ...page])
      if (page.length < JOURNAL_PAGE) setExhausted(true)
    } catch {
      toast.error(t("journal.loadOlderFailed"))
    } finally {
      setLoadingOlder(false)
    }
  }

  const dayFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" })
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" })

  return (
    <div data-testid="pet-journal" className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {attentionSection}
      {groupByLocalDay(rows).map((group) => (
        <section key={group.day} data-journal-day={group.day} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {dayFormat.format(group.ts)}
            </h3>
            <Badge variant="secondary" className="tabular-nums">
              {t("journal.dayTotals", { count: group.rows.length, xp: group.totalXp })}
            </Badge>
          </div>
          <ItemGroup>
            {group.rows.map((row) => {
              const Icon = JOURNAL_KIND_ICONS[row.kind] ?? SparklesIcon
              const known = row.kind in JOURNAL_KIND_ICONS
              return (
                <Item
                  key={row.id ?? `${row.kind}-${row.ts}`}
                  data-journal-entry={row.kind}
                  size="sm"
                  className="min-w-0 px-0"
                >
                  <ItemMedia>
                    <Icon className="size-4 text-primary" />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="max-w-full truncate">
                      {known ? t(`journal.kinds.${row.kind}`) : t("journal.kinds.other")}
                    </ItemTitle>
                  </ItemContent>
                  <ItemActions className="shrink-0 flex-wrap justify-end">
                    {row.xp > 0 ? (
                      <Badge variant="outline" className="tabular-nums">
                        {t("journal.xp", { xp: row.xp })}
                      </Badge>
                    ) : null}
                    <time className="text-xs tabular-nums text-muted-foreground">
                      {timeFormat.format(row.ts)}
                    </time>
                  </ItemActions>
                </Item>
              )
            })}
          </ItemGroup>
        </section>
      ))}
      {hasMore ? (
        <Button
          variant="outline"
          className="min-h-11 self-center"
          data-testid="pet-journal-load-older"
          disabled={loadingOlder}
          aria-busy={loadingOlder || undefined}
          onClick={() => void loadOlder()}
        >
          {loadingOlder ? <Loader2Icon className="size-4 animate-spin" aria-hidden /> : null}
          {t("journal.loadOlder")}
        </Button>
      ) : null}
    </div>
  )
}
