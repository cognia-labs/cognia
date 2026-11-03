"use client"

import { useFormatter, useTranslations } from "next-intl"
import { ActivityIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useSkillAnalytics } from "@/hooks/skills"
import { getCategoryMeta, getSourceMeta } from "@/lib/skills/categories"
import { useSkillsStore } from "@/stores/skills"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { SkillUsageTrend } from "./skill-usage-trend"

export function SkillAnalytics() {
  const t = useTranslations("skills.analytics")
  const tCat = useTranslations("skills.category")
  const tSrc = useTranslations("skills.source")
  const data = useSkillAnalytics()
  const openDetail = useSkillsStore((s) => s.openDetail)
  const setActiveTab = useSkillsStore((s) => s.setActiveTab)
  const format = useFormatter()
  const reduce = useReducedMotion()
  // The detail pane lives on My Skills. `openDetail` alone only moved the
  // selection, so on desktop a click here changed nothing on screen.
  const showSkill = (skillId: string) => {
    setActiveTab("my-skills")
    openDetail(skillId)
  }

  if (data.loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-12 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        {t("loading")}
      </div>
    )
  }

  // A source badge on every row says nothing when every row has the same one
  // (a fresh install lists nineteen "Built-in"s).
  const mixedSources = new Set(data.neverUsed.map((skill) => skill.source)).size > 1

  const categoryRows = data.byCategory.map((row) => {
    const meta = getCategoryMeta(row.category)
    return {
      key: row.category,
      label: tCat(meta.labelKey as never),
      count: row.count,
      usage: row.usage,
    }
  })

  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col">
        <motion.div
          className="grid grid-cols-2 divide-x border-b md:grid-cols-4"
          data-testid="skills-summary-strip"
          initial={reduce ? false : "initial"}
          animate="animate"
          variants={STAGGER_CONTAINER}
        >
          <motion.div variants={STAGGER_CHILD}>
            <SummaryMetric label={t("totalSkills")} value={data.totalSkills} />
          </motion.div>
          <motion.div variants={STAGGER_CHILD}>
            <SummaryMetric label={t("totalEnabled")} value={data.totalEnabled} />
          </motion.div>
          <motion.div variants={STAGGER_CHILD}>
            <SummaryMetric label={t("totalUsage")} value={data.totalUsage} />
          </motion.div>
          <motion.div variants={STAGGER_CHILD}>
            <SummaryMetric
              label={t("tokensEstimated")}
              value={data.estimatedTokens.toLocaleString()}
            />
          </motion.div>
        </motion.div>

        {/* Nothing has been counted yet: one sentence says so, where two empty
            axes and two "no data" lists used to. */}
        {data.totalUsage === 0 ? (
          <Empty
            className="rounded-none border-0 border-b border-solid py-10"
            data-testid="skill-analytics-no-usage"
          >
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ActivityIcon />
              </EmptyMedia>
              <EmptyTitle className="text-sm">{t("noUsageTitle")}</EmptyTitle>
              <EmptyDescription className="text-xs">{t("noUsageHint")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <SkillUsageTrend />

            <section className="border-b p-4">
              <p className="mb-2 text-xs font-medium">{t("categoryUsageTitle")}</p>
              {categoryRows.length > 0 ? (
                <div className="h-56">
                  {/* Seed a positive initial size (height matches the h-56 = 224px
                      box) so the chart never renders at recharts' default {-1,-1}
                      on mount — which logs "width(-1)/height(-1)" and flashes empty
                      for a frame on every skills-tab remount (tab-switch jitter). */}
                  <ResponsiveContainer
                    width="100%"
                    height="100%"
                    minWidth={1}
                    minHeight={1}
                    initialDimension={{ width: 320, height: 224 }}
                  >
                    <BarChart data={categoryRows}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 11 }}
                        interval={0}
                        angle={-15}
                        textAnchor="end"
                        height={60}
                      />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip
                        contentStyle={{
                          fontSize: "11px",
                          borderRadius: "6px",
                        }}
                      />
                      {/* The theme tokens are oklch, so `hsl(var(--primary))` was an
                          invalid colour and the bars drew in black. */}
                      <Bar dataKey="usage" fill="var(--primary)" radius={4} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("neverUsedEmpty")}</p>
              )}
            </section>

            <div className="grid border-b md:grid-cols-2 md:divide-x">
              <section className="p-4">
                <p className="mb-2 text-xs font-medium">{t("mostUsedTitle")}</p>
                {data.mostUsed.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("neverUsedEmpty")}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {data.mostUsed.map((skill) => {
                      const cat = getCategoryMeta(skill.category)
                      const Icon = cat.icon
                      return (
                        <li key={skill.id}>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => showSkill(skill.id)}
                            className="h-auto w-full justify-start gap-2 rounded-none px-2 py-1.5 text-left text-xs"
                          >
                            <span
                              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded ${cat.color}`}
                            >
                              <Icon className="size-3" />
                            </span>
                            <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                            <Badge variant="outline" className="h-5 text-[10px]">
                              {skill.usageCount ?? 0}
                            </Badge>
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>

              <section className="border-t p-4 md:border-t-0">
                <p className="mb-2 text-xs font-medium">{t("recentUsageTitle")}</p>
                {data.recentlyUsed.length === 0 ? (
                  <p className="text-xs text-muted-foreground">—</p>
                ) : (
                  <ul className="space-y-1.5">
                    {data.recentlyUsed.map((skill) => (
                      <li key={skill.id}>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => showSkill(skill.id)}
                          className="h-auto w-full justify-start gap-2 rounded-none px-2 py-1.5 text-left text-xs"
                        >
                          <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {skill.lastUsedAt
                              ? format.dateTime(new Date(skill.lastUsedAt), {
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                })
                              : "—"}
                          </span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}

        {data.neverUsed.length > 0 && (
          <section className="border-b p-4">
            <p className="mb-2 text-xs font-medium">{t("neverUsedTitle")}</p>
            <ul className="grid gap-1 sm:grid-cols-2">
              {data.neverUsed.map((skill) => {
                const src = getSourceMeta(skill.source)
                return (
                  <li key={skill.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => showSkill(skill.id)}
                      className="h-auto w-full justify-start gap-2 rounded-none px-2 py-1 text-left text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                      {mixedSources ? (
                        <Badge variant={src.badgeVariant} className="h-5 text-[10px]">
                          {tSrc(src.labelKey as never)}
                        </Badge>
                      ) : null}
                    </Button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </ScrollArea>
  )
}

function SummaryMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="p-4">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}
