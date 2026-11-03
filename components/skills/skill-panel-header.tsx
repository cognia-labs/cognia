"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  BarChart3Icon,
  LayersIcon,
  LayoutListIcon,
  PencilIcon,
  ShoppingBagIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  FeaturePageHeader,
  type FeatureHeaderTab,
} from "@/components/feature-shell/feature-page-header"
import { useSkillsStore, type SkillPanelTab } from "@/stores/skills"
import { useSkillPanelToolbar } from "./skill-panel-toolbar"
import { SkillPreferencesPopover } from "./skill-preferences"

const TAB_DEFS: { id: SkillPanelTab; labelKey: string; icon: LucideIcon }[] = [
  { id: "my-skills", labelKey: "mySkills", icon: SparklesIcon },
  { id: "browse", labelKey: "browse", icon: ShoppingBagIcon },
  { id: "editor", labelKey: "editor", icon: PencilIcon },
  { id: "analytics", labelKey: "analytics", icon: BarChart3Icon },
]

interface Props {
  totalCount: number
  filteredCount: number
  /**
   * The panel is inside a host that already owns the page's identity and its
   * way back: the Settings shell, or `/me/skills` under `SubPageShell`.
   *
   * Without it this header put a second back arrow next to the host's, and
   * that one pointed at `/`, so the control that looked like "up one level"
   * actually left Settings altogether. It also emitted a second `<h1>` for a
   * page that already had one, and on a 375px phone the two titles competed
   * for the same row until this one truncated to "S…".
   */
  embedded?: boolean
}

export function SkillPanelHeader({ totalCount, filteredCount, embedded }: Props) {
  const t = useTranslations("skills")
  const tTabs = useTranslations("skills.tabs")
  const setCategorySheetOpen = useSkillsStore((s) => s.setCategorySheetOpen)
  const activeTab = useSkillsStore((s) => s.activeTab)
  const setActiveTab = useSkillsStore((s) => s.setActiveTab)
  const dirtyCount = useSkillsStore(
    (s) => s.editorWorkspace.openFiles.filter((f) => f.draftContent !== f.savedContent).length
  )
  const toolbar = useSkillPanelToolbar()

  const tabItems = useMemo<FeatureHeaderTab[]>(
    () =>
      TAB_DEFS.map((tab) => ({
        value: tab.id,
        label: tTabs(tab.labelKey),
        icon: tab.icon,
        // Unsaved editor files, so leaving the editor tab does not hide them.
        count: tab.id === "editor" && dirtyCount > 0 ? dirtyCount : undefined,
        testId: `panel-tab-${tab.id}`,
      })),
    [tTabs, dirtyCount]
  )

  return (
    <FeaturePageHeader
      icon={<LayersIcon />}
      back={embedded ? undefined : { label: t("back"), href: "/" }}
      title={t("panel.headerTitle")}
      description={t("panel.headerDescription")}
      summary={
        <span className="tabular-nums">
          {filteredCount === totalCount
            ? t("panel.headerSubtitle", { count: totalCount })
            : `${filteredCount}/${totalCount}`}
        </span>
      }
      headingLevel={embedded ? 2 : 1}
      // A leading pane toggle, not a way back: below lg the category rail is a
      // sheet, and this is the only way to open it.
      breadcrumb={
        activeTab === "my-skills" ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 lg:hidden"
            onClick={() => setCategorySheetOpen(true)}
            aria-label={t("panel.openCategoriesAria")}
            data-testid="skill-panel-open-categories"
          >
            {/* Not `LayersIcon`: that is the page's own identity glyph, and
                two of it side by side read as a rendering glitch. Same glyph
                as the plugin category sheet. */}
            <LayoutListIcon className="size-4" />
          </Button>
        ) : undefined
      }
      tabs={{
        items: tabItems,
        value: activeTab,
        onValueChange: (next) => setActiveTab(next as SkillPanelTab),
        ariaLabel: tTabs("label"),
      }}
      actions={
        <>
          {toolbar.importMenu}
          <SkillPreferencesPopover />
        </>
      }
      secondaryActions={toolbar.secondaryActions}
      overflowActions={toolbar.overflowActions}
      primaryAction={toolbar.primaryAction}
    />
  )
}
