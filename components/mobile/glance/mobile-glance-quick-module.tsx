"use client"

/**
 * The quick module on a phone (ADR-0225 §9): the layout's shortcut list,
 * which used to be the home screen's quick-action grid.
 *
 * `standard` is an app-grid row of four (wrapping in rows of four): the
 * illustrated style sets each artwork on a soft plate, the ordinary style a
 * bare line icon; `compact` is one row of icons. Tiles are buttons on the
 * module's surface, not cards: the module already sits in the glance container, and a card in it would be
 * a card in a card (§3). Editing the list is the layout editor's job; the
 * module's own "Edit" opens it.
 */

import { useMemo } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { SlidersHorizontalIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { useGlance } from "@/components/glance/glance-context"
import {
  GlanceCompactSection,
  GlanceLinkButton,
  GlanceSection,
} from "@/components/glance/glance-primitives"
import { MobileSpotIcon } from "@/components/mobile/mobile-spot-icon"
import { useIllustratedNavigationIcons } from "@/components/shell/navigation-icon"
import { selectionFeedback } from "@/lib/capacitor/haptics"
import { getMobileQuickActionCatalog, type MobileQuickActionItem } from "@/lib/shell/mobile-home-nav"
import { MOBILE_SPRING, STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import type { GlanceModuleSize } from "@/types/glance/layout"

import { useMobileGlanceContext } from "./mobile-glance-provider"

export function MobileGlanceQuickModule({ size }: { size: GlanceModuleSize }) {
  const t = useTranslations("glance.modules.quick")
  const tActions = useTranslations("mobile.home.actions")
  const router = useRouter()
  const reduce = useReducedMotion()
  const illustrated = useIllustratedNavigationIcons()
  const { route } = useGlance()
  const { settings, actions } = useMobileGlanceContext()

  const items = useMemo(() => {
    const byId = new Map(getMobileQuickActionCatalog().map((item) => [item.id, item]))
    return settings.shortcuts
      .map((id) => byId.get(id))
      .filter((item): item is MobileQuickActionItem => item !== undefined)
  }, [settings.shortcuts])

  const dispatch = (item: MobileQuickActionItem) => {
    void selectionFeedback()
    if (item.kind === "newChat") actions.newChat()
    else if (item.kind === "search") actions.search()
    else if (item.kind === "route" && item.route) router.push(item.route)
  }
  const edit = () => route({ kind: "open-owner", owner: "tray-actions" })
  const title = t("label")

  if (items.length === 0) {
    return (
      <GlanceCompactSection moduleId="quick" title={title} label={t("editShortcuts")} onClick={edit}>
        <span className="text-muted-foreground">{t("noShortcuts")}</span>
      </GlanceCompactSection>
    )
  }

  if (size === "compact") {
    return (
      <section data-glance-module="quick" aria-label={title} className="min-w-0 px-5 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          <span className="w-14 shrink-0 text-[13px] font-semibold text-muted-foreground">
            {title}
          </span>
          <div className="-my-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {items.map((item) => {
              const label = tActions(item.i18nKey)
              return (
                <button
                  key={item.id}
                  type="button"
                  data-glance-nav
                  aria-label={label}
                  title={label}
                  data-testid={`mobile-quick-action-${item.id}`}
                  onClick={() => dispatch(item)}
                  className="grid size-11 shrink-0 place-items-center rounded-lg text-foreground transition-colors active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <item.Icon aria-hidden className="size-5" />
                </button>
              )
            })}
          </div>
        </div>
      </section>
    )
  }

  return (
    <GlanceSection
      moduleId="quick"
      title={title}
      aside={
        <GlanceLinkButton label={t("editShortcuts")} onClick={edit}>
          <SlidersHorizontalIcon aria-hidden className="size-3" />
          {t("edit")}
        </GlanceLinkButton>
      }
    >
      {/* One row of four, like a phone's app grid: each shortcut is its
          icon (on a soft plate when illustrated) with a short label under
          it, and a fifth wraps to a second row of four. The two-column grid
          of large illustrations it replaced spent two tall rows (~200px) on
          four buttons and pushed the usage module below the fold. The tiles
          deal themselves in on a first launch, and each takes a press. */}
      <motion.div
        className="-mx-1 grid grid-cols-4 gap-x-1 gap-y-2"
        variants={reduce ? undefined : STAGGER_CONTAINER}
        initial={reduce ? false : "initial"}
        animate="animate"
        data-testid="mobile-quick-actions"
      >
        {items.map((item) => (
          <motion.button
            key={item.id}
            type="button"
            data-glance-nav
            data-testid={`mobile-quick-action-${item.id}`}
            onClick={() => dispatch(item)}
            variants={reduce ? undefined : STAGGER_CHILD}
            whileTap={reduce ? undefined : { scale: 0.94 }}
            transition={MOBILE_SPRING}
            className="group flex min-w-0 flex-col items-center gap-1.5 rounded-xl px-0.5 py-1 text-center focus-visible:outline-none"
          >
            <span
              aria-hidden
              data-slot="quick-action-plate"
              data-style={illustrated ? "plate" : "plain"}
              className={cn(
                "grid place-items-center rounded-2xl transition-colors group-focus-visible:ring-2 group-focus-visible:ring-ring/50",
                illustrated
                  ? "size-14 overflow-hidden bg-foreground/[0.05] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--foreground)_7%,transparent)] group-active:bg-foreground/[0.1]"
                  : // A line icon needs no frame: the plate boxed each glyph
                    // in a grey tile, and four of them in a card made a card
                    // of cards. The glyph stands on the card at the label's
                    // tone and only the press paints a fill.
                    "size-12 text-foreground/85 group-hover:text-foreground group-active:bg-foreground/[0.07] group-active:text-foreground"
              )}
            >
              {illustrated ? (
                <MobileSpotIcon name={item.spotIcon} size={44} />
              ) : (
                <item.Icon aria-hidden className="size-6 stroke-[1.5]" />
              )}
            </span>
            <span className="w-full truncate text-[11px] leading-tight text-muted-foreground group-active:text-foreground">
              {tActions(item.i18nKey)}
            </span>
          </motion.button>
        ))}
      </motion.div>
    </GlanceSection>
  )
}

