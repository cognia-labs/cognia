"use client"

/**
 * What the Editor tab shows before a skill is open.
 *
 * It used to say "Pick a skill from the list", but the Editor tab has no list:
 * the list lives on My Skills, one tab over, so the sentence pointed at nothing.
 * Now the tab offers the skills that can actually be edited (built-ins are
 * duplicated first, never edited in place), most recently changed first, and
 * the two ways out: back to the list, or a new skill.
 */

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { FilePenLineIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { inferCategory, listSkills } from "@/lib/db/skills"
import { getCategoryMeta } from "@/lib/skills/categories"
import { cn } from "@/lib/utils"
import { useSkillsStore } from "@/stores/skills"
import type { Skill } from "@cognia/agent-config-types"

/** How many recent skills the picker offers before deferring to My Skills. */
export const EDITOR_EMPTY_RECENT_LIMIT = 6

/** The skills the Editor can open, most recently changed first. */
export function editableSkills(skills: readonly Skill[], limit = EDITOR_EMPTY_RECENT_LIMIT) {
  return skills
    .filter((skill) => !skill.isBuiltIn)
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, limit)
}

export function SkillEditorEmpty() {
  const t = useTranslations("skills.editor")
  const openSkillInEditor = useSkillsStore((s) => s.openSkillInEditor)
  const openCreate = useSkillsStore((s) => s.openCreate)
  const setActiveTab = useSkillsStore((s) => s.setActiveTab)
  const skills = useLiveQuery(() => listSkills(), [])
  const recent = Array.isArray(skills) ? editableSkills(skills) : []
  const loaded = Array.isArray(skills)

  return (
    <Empty className="flex-1 border-0" data-testid="skill-editor-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FilePenLineIcon />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{t("emptyTitle")}</EmptyTitle>
        <EmptyDescription className="text-xs">
          {loaded && recent.length === 0 ? t("emptyNone") : t("emptyHint")}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-sm">
        {recent.length > 0 ? (
          <section className="w-full text-left" aria-labelledby="skill-editor-empty-recent">
            <h3
              id="skill-editor-empty-recent"
              className="px-2 pb-1 text-[11px] font-medium text-muted-foreground"
            >
              {t("emptyRecent")}
            </h3>
            <ul className="flex flex-col gap-px" data-testid="skill-editor-empty-recent">
              {recent.map((skill) => {
                const category = getCategoryMeta(inferCategory(skill))
                const Icon = category.icon
                return (
                  <li key={skill.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto w-full justify-start gap-2.5 px-2 py-1.5 text-left font-normal"
                      onClick={() => openSkillInEditor(skill.id, skill.content)}
                      data-testid={`skill-editor-empty-open-${skill.id}`}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "flex size-6 shrink-0 items-center justify-center rounded-md",
                          category.color
                        )}
                      >
                        <Icon className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{skill.name}</span>
                        {skill.description ? (
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {skill.description}
                          </span>
                        ) : null}
                      </span>
                    </Button>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}
        <div className="flex items-center justify-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setActiveTab("my-skills")}
            data-testid="skill-editor-empty-list"
          >
            {t("emptyGoToList")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => openCreate()}
            data-testid="skill-editor-empty-create"
          >
            <PlusIcon className="mr-1.5 size-3.5" />
            {t("emptyCreate")}
          </Button>
        </div>
      </EmptyContent>
    </Empty>
  )
}
