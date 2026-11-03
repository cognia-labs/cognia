"use client"

/**
 * Left rail of the Template Studio, laid out like the Plugins rail: the
 * shelves first, then (on the shelves that list definitions) the types under
 * their own heading, each with its count and one click from being the filter.
 *
 * The shelves used to be a tab strip over the grid and the types a dropdown in
 * the filter row, so "how many squads do I have" took opening a menu, and the
 * page had two chrome rows before the first card.
 */

import { useTranslations } from "next-intl"
import {
  AppWindowIcon,
  BadgeCheckIcon,
  BotIcon,
  BoxesIcon,
  CalendarClockIcon,
  FileTextIcon,
  KeyRoundIcon,
  LayersIcon,
  LibraryIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  PackageIcon,
  PencilLineIcon,
  SlidersHorizontalIcon,
  TargetIcon,
  UserRoundIcon,
  UsersIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { TEMPLATE_TABS, type TemplateTab } from "@/hooks/templates/use-template-route-state"
import { cn } from "@/lib/utils"
import type { TemplateDefinitionEnvelope, TemplateDomain } from "@/lib/templates/contracts"

const DOMAIN_ICONS: Record<TemplateDomain, LucideIcon> = {
  agentTeam: UsersIcon,
  workflow: WorkflowIcon,
  subagent: BotIcon,
  customMode: SlidersHorizontalIcon,
  character: UserRoundIcon,
  skill: LayersIcon,
  a2ui: AppWindowIcon,
  goal: TargetIcon,
  scheduler: CalendarClockIcon,
  prompt: MessageSquareTextIcon,
  subscription: KeyRoundIcon,
  document: FileTextIcon,
  chatTemplate: MessagesSquareIcon,
}

const SHELF_ICONS: Record<TemplateTab, LucideIcon> = {
  library: LibraryIcon,
  drafts: PencilLineIcon,
  published: BadgeCheckIcon,
  packages: PackageIcon,
  instances: BoxesIcon,
}

/** The shelves whose rows are definitions, and so can be narrowed by type. */
export const DEFINITION_SHELVES: readonly TemplateTab[] = ["library", "drafts", "published"]

/** A template type's glyph on a small neutral tile, shared by the rail and the cards. */
export function TemplateDomainIcon({
  domain,
  className,
}: {
  domain: TemplateDomain
  className?: string
}) {
  const Icon = DOMAIN_ICONS[domain] ?? LayersIcon
  return (
    <span
      aria-hidden
      data-template-domain-icon={domain}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md bg-foreground/[0.06] text-foreground/75",
        className
      )}
    >
      <Icon className="size-3.5" />
    </span>
  )
}

/** Count the distinct definitions per type, most-populated first. */
export function countByDomain(
  definitions: readonly TemplateDefinitionEnvelope[]
): Array<[TemplateDomain, number]> {
  // One definition id holds a draft and each release published from it; the
  // grid lists the definition once per envelope, but "how many squads do I
  // have" means ids.
  const ids = new Map<TemplateDomain, Set<string>>()
  for (const definition of definitions) {
    const set = ids.get(definition.domain) ?? new Set<string>()
    set.add(definition.id)
    ids.set(definition.domain, set)
  }
  return Array.from(ids, ([domain, set]): [TemplateDomain, number] => [domain, set.size]).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )
}

export interface TemplateNavSidebarProps {
  shelf: TemplateTab
  onSelectShelf(shelf: TemplateTab): void
  /** Row count per shelf; a shelf without one shows none. */
  counts: Partial<Record<TemplateTab, number>>
  /**
   * The active shelf's rows under every filter except the type, so each type
   * row counts what picking it would show.
   */
  facetDefinitions: readonly TemplateDefinitionEnvelope[]
  domain: TemplateDomain | "all"
  onSelectDomain(domain: TemplateDomain | "all"): void
}

const ROW_CLASS = "w-full justify-start gap-2 px-2 font-normal pointer-coarse:h-10"

export function TemplateNavSidebar({
  shelf,
  onSelectShelf,
  counts,
  facetDefinitions,
  domain,
  onSelectDomain,
}: TemplateNavSidebarProps) {
  const t = useTranslations("templateStudio")
  const types = countByDomain(facetDefinitions)
  const total = types.reduce((sum, [, count]) => sum + count, 0)

  return (
    <nav
      aria-label={t("nav.label")}
      className="flex h-full min-h-0 flex-col overflow-y-auto p-2"
      data-testid="template-nav"
    >
      <ul className="space-y-0.5">
        {TEMPLATE_TABS.map((item) => {
          const Icon = SHELF_ICONS[item]
          const active = shelf === item
          const count = counts[item]
          return (
            <li key={item}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-current={active ? "page" : undefined}
                onClick={() => onSelectShelf(item)}
                className={cn(
                  ROW_CLASS,
                  active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground"
                )}
                data-testid={`template-nav-${item}`}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{t(`tabs.${item}`)}</span>
                {count !== undefined ? (
                  <span
                    className="ml-auto text-[11px] tabular-nums text-muted-foreground"
                    data-testid={`template-nav-count-${item}`}
                  >
                    {count}
                  </span>
                ) : null}
              </Button>
            </li>
          )
        })}
      </ul>

      {DEFINITION_SHELVES.includes(shelf) ? (
        <section
          className="mt-5"
          aria-labelledby="template-nav-types-heading"
          data-testid="template-nav-types"
        >
          <h2
            id="template-nav-types-heading"
            className="px-2 pb-1.5 text-[11px] font-medium text-muted-foreground"
          >
            {t("nav.byType")}
          </h2>
          <ul className="space-y-0.5">
            <li>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={domain === "all"}
                onClick={() => onSelectDomain("all")}
                className={cn(
                  ROW_CLASS,
                  domain === "all"
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground"
                )}
                data-testid="template-nav-type-all"
              >
                <LayersIcon className="size-4 shrink-0" />
                <span className="truncate">{t("filters.allDomains")}</span>
                <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                  {total}
                </span>
              </Button>
            </li>
            {types.map(([item, count]) => {
              const active = domain === item
              const Icon = DOMAIN_ICONS[item] ?? LayersIcon
              return (
                <li key={item}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-pressed={active}
                    // A second click on the active type clears it, the way a
                    // toggled facet does.
                    onClick={() => onSelectDomain(active ? "all" : item)}
                    className={cn(
                      ROW_CLASS,
                      active
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground"
                    )}
                    data-testid={`template-nav-type-${item}`}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{t(`domains.${item}`)}</span>
                    <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                      {count}
                    </span>
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </nav>
  )
}
