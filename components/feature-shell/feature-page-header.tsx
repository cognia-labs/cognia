"use client"

import { Fragment, useEffect, useRef, useState } from "react"
import Link from "next/link"
import type { LucideIcon } from "lucide-react"
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * The one page header every feature route draws.
 *
 * Two rows, and the rules that make forty pages read as one product:
 *
 *  1. **Identity row** (always): icon tile (or a back button on a sub-page),
 *     title, at most one status chip, and a one-line description. Then, on the
 *     right and in this fixed order: the count (`summary`), a refresh glyph,
 *     free-form `actions`, at most two secondary buttons, the "⋯" overflow,
 *     and the primary button, which is always last.
 *  2. **View bar** (only when the page has one): view tabs on the left in one
 *     underline style, then the search field, then filter/sort/view controls
 *     pushed to the right. Tabs never sit in the identity row.
 *
 * Tabs, search, status, refresh and back are typed props rather than slots so
 * a page passes data and the header owns the look. A page that brought its own
 * `TabsList`, search input or status pill is how the header drifted into five
 * tab styles, three search placements and a different pill on every page.
 * `feature-page-header-usage.test.ts` scans the call sites and pins the rules.
 *
 * How the header meets the page (`variant`):
 *
 *  - `management` — the full-bleed band every feature route uses
 *  - `compact`    — the same band at column-header height, for a header that
 *                   is a column's own title inside a larger shell (Settings'
 *                   detail column, the browser's chrome)
 *  - `card`       — a rounded, raised block with a gap beneath it, for
 *                   scrolling document pages that have no band to sit in
 *
 * `card` exists because three call sites were already producing it by passing
 * `className="rounded-xl border shadow-sm"`, and a fourth header component in
 * `settings/common/settings-section.tsx` had reimplemented the same look as a
 * separate component (ADR-0148).
 */
export type FeaturePageHeaderVariant = "management" | "compact" | "card"

/** Secondary buttons shown before the rest fold into "⋯". */
export const MAX_VISIBLE_SECONDARY_ACTIONS = 2

export interface FeatureHeaderAction {
  id: string
  label: string
  icon?: LucideIcon
  href?: string
  onSelect?: () => void
  disabled?: boolean
  destructive?: boolean
  /** In a menu, a rule before this item opens a new group. */
  separatorBefore?: boolean
  testId?: string
}

/** The primary button, optionally split with a menu of related creations. */
export interface FeatureHeaderPrimaryAction extends FeatureHeaderAction {
  /** Items behind the split chevron ("Create task ▾"). */
  menu?: readonly FeatureHeaderAction[]
  /** Accessible name of the chevron. Required with `menu`. */
  menuLabel?: string
}

export interface FeatureHeaderTab {
  value: string
  label: string
  icon?: LucideIcon
  /** Drawn after the label in muted tabular figures. */
  count?: number
  /** Route tabs: each tab is a link and the current route is `value`. */
  href?: string
  /**
   * A short qualifier drawn after the label ("Desktop" on a place a paired
   * phone can only look at). Not a count; use `count` for numbers.
   */
  badge?: string
  disabled?: boolean
  testId?: string
}

export interface FeatureHeaderTabs {
  items: readonly FeatureHeaderTab[]
  value: string
  /** Omit for route tabs, whose links do the switching. */
  onValueChange?: (value: string) => void
  ariaLabel: string
  /**
   * The page owns the Radix `Tabs` root (its `TabsContent` panels live under
   * the same root, which is what ties each tab to its panel through
   * `aria-controls`). The header then draws only the list, which must render
   * inside that root; `value` and `onValueChange` are the root's.
   */
  inOuterRoot?: boolean
  /** On the tab list. */
  testId?: string
}

export interface FeatureHeaderSearch {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** Defaults to the placeholder. */
  ariaLabel?: string
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
  inputRef?: React.Ref<HTMLInputElement>
  testId?: string
}

export type FeatureHeaderStatusTone = "neutral" | "success" | "warning" | "danger" | "active"

export interface FeatureHeaderStatus {
  label: string
  tone?: FeatureHeaderStatusTone
  /** Longer explanation shown on hover. */
  title?: string
  testId?: string
}

export interface FeatureHeaderRefresh {
  label: string
  onSelect: () => void
  /** Spins the glyph and blocks a second press while a refresh runs. */
  busy?: boolean
  testId?: string
}

export interface FeatureHeaderBack {
  label: string
  href?: string
  onSelect?: () => void
  testId?: string
}

export interface FeaturePageHeaderProps {
  variant?: FeaturePageHeaderVariant
  icon?: React.ReactNode
  /**
   * A picture that stands in for the icon tile: the page's subject drawn as
   * itself (the pet in its console). Same tile, without the icon sizing that would
   * shrink a rendered picture to a 16px glyph. Wins over `icon`.
   */
  avatar?: React.ReactNode
  /** A sub-page's way back. Drawn where the icon tile would be. */
  back?: FeatureHeaderBack
  title: React.ReactNode
  /** One line under the title. Every top-level page has one. */
  description?: React.ReactNode
  /** A short fact that follows the description after a dot. */
  context?: React.ReactNode
  /**
   * A real trail (Files' folder path, Settings' section) or a leading pane
   * toggle. A plain way back is `back`, not this.
   */
  breadcrumb?: React.ReactNode
  status?: FeatureHeaderStatus
  /** The count: "7 agents", "1 of 1 online". Plain text. */
  summary?: React.ReactNode
  tabs?: FeatureHeaderTabs
  /**
   * View-bar navigation that is not a tab set (a lens picker that is also a
   * breadcrumb). Prefer `tabs`; this exists for the few that are not tabs.
   */
  navigation?: React.ReactNode
  search?: FeatureHeaderSearch
  /** Filter, sort and view toggles: the right end of the view bar. */
  controls?: React.ReactNode
  refresh?: FeatureHeaderRefresh
  primaryAction?: FeatureHeaderPrimaryAction
  /** The first two show as buttons; the rest fold into "⋯". */
  secondaryActions?: readonly FeatureHeaderAction[]
  overflowActions?: readonly FeatureHeaderAction[]
  /** Accessible name of "⋯". Defaults to "More actions". */
  overflowLabel?: string
  /**
   * Controls that are not buttons (a host picker, a cogset select). Drawn
   * between the refresh glyph and the secondary buttons.
   */
  actions?: React.ReactNode
  /**
   * Which heading element the title renders as. Defaults to `1` — a feature
   * route's header IS the page title. A header nested inside a page that
   * already has one (a settings section, for instance) must pass `2`, or the
   * document ends up with two `h1`s.
   */
  headingLevel?: 1 | 2
  className?: string
  testId?: string
}

function ActionIcon({ action }: { action: FeatureHeaderAction }) {
  const Icon = action.icon
  return Icon ? <Icon className="size-3.5" aria-hidden="true" /> : null
}

function HeaderActionButton({
  action,
  primary = false,
  responsive = false,
  className,
}: {
  action: FeatureHeaderAction
  primary?: boolean
  responsive?: boolean
  className?: string
}) {
  const content = (
    <>
      <ActionIcon action={action} />
      <span className={cn(responsive && action.icon && "hidden @2xl/feature-header:inline")}>
        {action.label}
      </span>
    </>
  )
  const button = (
    <Button
      asChild={Boolean(action.href)}
      type={action.href ? undefined : "button"}
      variant={action.destructive ? "destructive" : primary ? "default" : "outline"}
      size="sm"
      disabled={action.disabled}
      onClick={action.href ? undefined : action.onSelect}
      aria-label={action.label}
      data-testid={action.testId}
      className={cn(
        "motion-safe:transition-[background-color,color,box-shadow,transform] motion-safe:duration-200",
        primary && "shadow-sm shadow-primary/15",
        responsive &&
          action.icon &&
          "size-8 px-0 @2xl/feature-header:h-8 @2xl/feature-header:w-auto @2xl/feature-header:px-3",
        className
      )}
    >
      {action.href ? <Link href={action.href}>{content}</Link> : content}
    </Button>
  )

  if (!responsive || !action.icon) return button

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{action.label}</TooltipContent>
    </Tooltip>
  )
}

function OverflowActionItem({ action }: { action: FeatureHeaderAction }) {
  const content = (
    <>
      <ActionIcon action={action} />
      <span>{action.label}</span>
    </>
  )

  if (action.href) {
    return (
      <DropdownMenuItem asChild disabled={action.disabled}>
        <Link href={action.href} data-testid={action.testId}>
          {content}
        </Link>
      </DropdownMenuItem>
    )
  }

  return (
    <DropdownMenuItem
      disabled={action.disabled}
      variant={action.destructive ? "destructive" : "default"}
      onSelect={action.onSelect}
      data-testid={action.testId}
    >
      {content}
    </DropdownMenuItem>
  )
}

/** Menu items, with a rule wherever an item opens a new group. */
function MenuItems({ items }: { items: readonly FeatureHeaderAction[] }) {
  return (
    <>
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {item.separatorBefore && index > 0 ? <DropdownMenuSeparator /> : null}
          <OverflowActionItem action={item} />
        </Fragment>
      ))}
    </>
  )
}

function PrimaryAction({ action }: { action: FeatureHeaderPrimaryAction }) {
  const menu = action.menu ?? []
  if (menu.length === 0) return <HeaderActionButton action={action} primary />
  return (
    <div className="flex items-center" data-slot="feature-header-primary-split">
      <HeaderActionButton action={action} primary className="rounded-e-none" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            aria-label={action.menuLabel}
            disabled={action.disabled}
            className="w-7 rounded-s-none border-s border-primary-foreground/20 shadow-sm shadow-primary/15"
            data-testid={action.testId ? `${action.testId}-menu` : undefined}
          >
            <ChevronDownIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <MenuItems items={menu} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

const STATUS_DOT: Record<FeatureHeaderStatusTone, string> = {
  neutral: "bg-muted-foreground/50",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-destructive",
  active: "bg-primary motion-safe:animate-pulse",
}

/** The one status chip: a dot in the tone's colour and a short label. */
function StatusChip({ status }: { status: FeatureHeaderStatus }) {
  const tone = status.tone ?? "neutral"
  return (
    <span
      className="inline-flex h-5 max-w-56 items-center gap-1.5 rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground"
      title={status.title}
      data-slot="feature-header-status"
      data-tone={tone}
      data-testid={status.testId}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[tone])} aria-hidden="true" />
      <span className="truncate">{status.label}</span>
    </span>
  )
}

function TabCount({ count }: { count: number }) {
  return <span className="text-[11px] font-normal tabular-nums text-muted-foreground">{count}</span>
}

/** The one tab style: the underline (`line`) tab list, in the view bar. */
function HeaderTabs({ tabs }: { tabs: FeatureHeaderTabs }) {
  const list = (
    <TabsList
      variant="line"
      aria-label={tabs.ariaLabel}
      data-testid={tabs.testId}
      className="h-8 gap-3 p-0 group-data-[orientation=horizontal]/tabs:h-8"
    >
      {tabs.items.map((tab) => {
        const Icon = tab.icon
        const content = (
          <>
            {Icon ? <Icon className="size-3.5" aria-hidden="true" /> : null}
            <span>{tab.label}</span>
            {tab.count === undefined ? null : <TabCount count={tab.count} />}
            {tab.badge ? (
              <span
                data-testid="feature-header-tab-badge"
                className="rounded-sm bg-muted px-1 py-px text-[10px] leading-none font-medium text-muted-foreground"
              >
                {tab.badge}
              </span>
            ) : null}
          </>
        )
        return (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            disabled={tab.disabled}
            asChild={Boolean(tab.href)}
            data-testid={tab.testId}
            data-tab={tab.value}
            data-badged={tab.badge ? "true" : undefined}
            className="flex-none px-0.5 text-[13px] group-data-[orientation=horizontal]/tabs:after:bottom-[-6px]"
          >
            {tab.href ? (
              <Link href={tab.href} aria-current={tab.value === tabs.value ? "page" : undefined}>
                {content}
              </Link>
            ) : (
              content
            )}
          </TabsTrigger>
        )
      })}
    </TabsList>
  )
  if (tabs.inOuterRoot) return list
  return (
    <Tabs value={tabs.value} onValueChange={tabs.onValueChange} className="gap-0">
      {list}
    </Tabs>
  )
}

/**
 * The one search field: a leading glyph and a quiet fill, sized to the bar.
 *
 * It shows its own draft and reports only final text, so every page's search
 * is safe for an IME and for a query that lives in the URL:
 *
 * - Inside an IME composition nothing is reported until `compositionend`. A
 *   filter on "ni" is not a query anyone asked for, and a URL-backed page
 *   would write every pinyin syllable to `?q=`.
 * - A value that comes back is an echo of what this box sent when it is one
 *   of the values sent since the last echo of the latest. A URL-backed query
 *   returns "a" a render after the user typed "ab"; adopting it would reset
 *   the box under the typist.
 * - Anything else came from outside (a Clear filters button, a deep link) and
 *   replaces the draft.
 */
function HeaderSearch({ search }: { search: FeatureHeaderSearch }) {
  const [draft, setDraft] = useState(search.value)
  const lastSent = useRef(search.value)
  const pending = useRef<Set<string>>(new Set())
  // Destructured up front: `inputRef` rides in the same object, and reading
  // the others off it during render reads as touching a ref.
  const { value, onChange, inputRef, onKeyDown, placeholder, ariaLabel, testId } = search

  useEffect(() => {
    if (pending.current.has(value)) {
      // The latest echo settles the round trip: older sends can no longer
      // arrive, so a later outside change to one of them reads as outside.
      if (value === lastSent.current) pending.current = new Set([value])
      return
    }
    pending.current = new Set()
    lastSent.current = value
    setDraft(value)
  }, [value])

  const send = (next: string) => {
    lastSent.current = next
    pending.current.add(next)
    onChange(next)
  }

  return (
    <div
      className="relative min-w-40 flex-1 @3xl/feature-header:max-w-md"
      data-slot="feature-header-search"
    >
      <SearchIcon
        className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        ref={inputRef}
        type="search"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          if (!(event.nativeEvent as InputEvent).isComposing) send(event.target.value)
        }}
        onCompositionEnd={(event) => send(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        data-testid={testId}
        className="h-8 ps-8 text-sm md:text-sm"
      />
    </div>
  )
}

function HeaderRefresh({ refresh }: { refresh: FeatureHeaderRefresh }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={refresh.label}
          aria-busy={refresh.busy || undefined}
          disabled={refresh.busy}
          onClick={refresh.onSelect}
          data-testid={refresh.testId}
        >
          <RefreshCwIcon
            className={cn("size-4", refresh.busy && "motion-safe:animate-spin")}
            aria-hidden="true"
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{refresh.label}</TooltipContent>
    </Tooltip>
  )
}

function HeaderBack({ back, compact }: { back: FeatureHeaderBack; compact: boolean }) {
  const glyph = <ArrowLeftIcon className="size-4" aria-hidden="true" />
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild={Boolean(back.href)}
          type={back.href ? undefined : "button"}
          variant="ghost"
          size="icon-sm"
          aria-label={back.label}
          onClick={back.href ? undefined : back.onSelect}
          data-testid={back.testId}
          data-slot="feature-header-back"
          className={cn("shrink-0", !compact && "-ms-1")}
        >
          {back.href ? <Link href={back.href}>{glyph}</Link> : glyph}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{back.label}</TooltipContent>
    </Tooltip>
  )
}

export function FeaturePageHeader({
  variant = "management",
  icon,
  avatar,
  back,
  title,
  description,
  context,
  breadcrumb,
  status,
  summary,
  tabs,
  navigation,
  search,
  controls,
  refresh,
  primaryAction,
  secondaryActions = [],
  overflowActions = [],
  overflowLabel,
  actions,
  headingLevel = 1,
  className,
  testId,
}: FeaturePageHeaderProps) {
  const t = useTranslations("featureShell")
  const viewNavigation = tabs ? <HeaderTabs tabs={tabs} /> : (navigation ?? null)
  const hasViewBar = Boolean(viewNavigation || search || controls)
  const visibleSecondary = secondaryActions.slice(0, MAX_VISIBLE_SECONDARY_ACTIONS)
  const overflowItems = [
    ...secondaryActions.slice(MAX_VISIBLE_SECONDARY_ACTIONS),
    ...overflowActions,
  ]
  const Heading = headingLevel === 2 ? "h2" : "h1"
  const isCompact = variant === "compact"
  const isCard = variant === "card"

  return (
    <header
      data-slot="feature-page-header"
      data-testid={testId}
      data-variant={variant}
      data-elevation={isCard ? "1" : undefined}
      data-has-secondary={String(hasViewBar)}
      className={cn(
        // No rule under the band and no hairline over it: the band is the
        // page's own ground (translucent, blurred over what scrolls beneath),
        // and the toolbar or panes that follow separate by tone. The card
        // variant lifts onto the raised fill instead of drawing a frame.
        "@container/feature-header relative z-10 shrink-0 overflow-hidden bg-background/88 text-foreground backdrop-blur-xl supports-[backdrop-filter]:bg-background/76",
        isCard && "mb-5 rounded-stage bg-card supports-[backdrop-filter]:bg-card",
        className
      )}
    >
      <div
        className={cn(
          "relative flex min-w-0 items-center gap-2.5 px-3 @md/feature-header:px-4",
          isCompact ? "min-h-[var(--chrome-h)] py-1" : "min-h-[var(--chrome-h-tall)] py-2"
        )}
      >
        {breadcrumb ? (
          <div
            // Same contract as the view-bar slots. The header is
            // `overflow-hidden` and the actions are `shrink-0`, so a trail
            // that refuses to give way pushes the actions past the edge, where
            // they are clipped rather than wrapped.
            className="flex min-w-0 shrink items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-slot="feature-header-breadcrumb"
          >
            {breadcrumb}
          </div>
        ) : null}

        {back ? (
          <HeaderBack back={back} compact={isCompact} />
        ) : avatar ? (
          <span
            data-slot="feature-header-avatar"
            className={cn(
              "grid shrink-0 place-items-center overflow-hidden bg-gradient-to-br from-primary/14 via-primary/8 to-primary/[0.03]",
              isCompact ? "size-7 rounded-lg" : "size-9 rounded-xl"
            )}
            aria-hidden="true"
          >
            {avatar}
          </span>
        ) : icon ? (
          <span
            data-slot="feature-header-icon"
            className={cn(
              "grid shrink-0 place-items-center bg-gradient-to-br from-primary/14 via-primary/8 to-primary/[0.03] text-primary",
              isCompact ? "size-7 rounded-lg [&_svg]:size-3.5" : "size-9 rounded-xl [&_svg]:size-4"
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Heading
              className={cn(
                "truncate font-semibold tracking-tight",
                isCompact ? "text-sm" : "text-base @xl/feature-header:text-[17px]"
              )}
            >
              {title}
            </Heading>
            {status ? (
              <div className="hidden shrink-0 @md/feature-header:block">
                <StatusChip status={status} />
              </div>
            ) : null}
          </div>
          {!isCompact && (description || context) ? (
            <div className="mt-0.5 hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground @lg/feature-header:flex">
              {description ? <span className="truncate">{description}</span> : null}
              {description && context ? (
                <span className="size-0.5 shrink-0 rounded-full bg-muted-foreground/60" />
              ) : null}
              {context ? <span className="shrink-0">{context}</span> : null}
            </div>
          ) : null}
        </div>

        {summary ? (
          <div
            className="hidden shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground @3xl/feature-header:flex"
            data-slot="feature-header-summary"
          >
            {summary}
          </div>
        ) : null}

        <div
          className="flex shrink-0 items-center gap-1.5 @md/feature-header:gap-2"
          data-testid="feature-header-actions"
        >
          {refresh ? <HeaderRefresh refresh={refresh} /> : null}
          {actions}
          {visibleSecondary.map((action) => (
            <HeaderActionButton key={action.id} action={action} responsive />
          ))}
          {overflowItems.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={overflowLabel ?? t("moreActions")}
                  data-slot="feature-header-overflow"
                  className="motion-safe:transition-colors motion-safe:duration-200"
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <MenuItems items={overflowItems} />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {primaryAction ? <PrimaryAction action={primaryAction} /> : null}
        </div>
      </div>

      {hasViewBar ? (
        <div
          className="relative flex min-h-[var(--chrome-h)] min-w-0 items-center gap-3 bg-muted/30 px-3 py-1 @md/feature-header:px-4"
          data-slot="feature-header-view-bar"
        >
          {viewNavigation ? (
            <div
              // Shrinks and scrolls rather than holding its content width: a
              // tab set wider than the bar was cut off by the header's
              // `overflow-hidden` (/eval lost two of four tabs at 375px).
              className="min-w-0 shrink-0 overflow-x-auto [scrollbar-width:none] @max-md/feature-header:shrink [&::-webkit-scrollbar]:hidden"
              data-slot="feature-header-view-navigation"
            >
              {viewNavigation}
            </div>
          ) : null}
          {viewNavigation && (search || controls) ? (
            <span className="h-4 w-px shrink-0 bg-border/80" aria-hidden="true" />
          ) : null}
          {search ? <HeaderSearch search={search} /> : null}
          {controls ? (
            <div
              className="ms-auto flex min-w-0 shrink items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              data-slot="feature-header-controls"
            >
              {controls}
            </div>
          ) : null}
        </div>
      ) : null}
    </header>
  )
}
