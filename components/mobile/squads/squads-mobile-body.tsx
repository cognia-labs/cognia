"use client"

/**
 * `/squads` on a phone.
 *
 * `FeaturePageShell` does have a mobile branch, but it collapses the left pane
 * into a Sheet behind an unlabelled glyph. For a fleet console that is
 * backwards: the list is not a sidebar here, it is the page, and the detail is
 * what should arrive on demand.
 *
 * Two levels, like every phone list: the Squads, then one Squad.
 *
 *  - Nothing selected: the list, and the fleet overview (what needs you, what
 *    is working, the latest runs) as a second tab. The top bar has one verb,
 *    New Squad, and a menu for Settings and the host's live activity.
 *  - A Squad selected: its own full-screen view (`SquadDetailView`), the same
 *    component the wide pane centres, with a back button in its masthead.
 *
 * Nothing about a Squad is re-modelled here. `SquadListPane`, `SquadDetailView`,
 * `SquadFleetOverview`, `CreateSquadDialog` and `SquadEditSheet` are the
 * components the wide pane renders, and everything reads the same
 * `useSquadFleet` projection, so a row can never say one thing here and
 * another on a desktop.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { ActivityIcon, MoreHorizontalIcon, PlusIcon, SettingsIcon } from "lucide-react"

import { CreateSquadDialog } from "@/components/squads/create-squad-dialog"
import { SquadDetailView } from "@/components/squads/squad-detail-view"
import { SquadEditSheet } from "@/components/squads/squad-edit-sheet"
import { SquadFleetOverview } from "@/components/squads/squad-fleet-overview"
import { SquadListPane } from "@/components/squads/squad-list-pane"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useFleetSnapshot } from "@/hooks/fleet/use-fleet-snapshot"
import { useSquadFleet } from "@/hooks/squads/use-squad-fleet"
import { useSelectedSquad } from "@/hooks/squads/use-selected-squad"
import {
  resolveSquadTab,
  type SquadDetailTab,
  type SquadFleetTab,
  type SquadRouteState,
} from "@/hooks/squads/use-squad-route-state"
import { settingsHref } from "@/lib/settings/deep-link"

export interface SquadsMobileBodyProps {
  route: SquadRouteState
}

export function SquadsMobileBody({ route }: SquadsMobileBodyProps) {
  const t = useTranslations("squads.fleet")
  const fleet = useSquadFleet({ query: route.query, filter: route.filter })
  const selected = useSelectedSquad(route.selectedId)
  const [createOpen, setCreateOpen] = useState(false)
  // Only where `/fleet` exists; see `SquadFleetConsole`.
  const { source: fleetSource } = useFleetSnapshot()

  const onCreated = useCallback(
    (squadId: string) => route.setSelectedId(squadId, { edit: "general" }),
    [route]
  )

  const dialogs = (
    <>
      <CreateSquadDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={onCreated} />
      {route.selectedId && selected.status === "found" ? (
        <SquadEditSheet
          squadId={route.selectedId}
          focus={route.editing}
          onFocusChange={route.setEditing}
          onDeleted={() => route.setSelectedId(undefined)}
          onOpenSquad={(id) => route.setSelectedId(id, { edit: "general" })}
        />
      ) : null}
    </>
  )

  if (route.selectedId && selected.status === "found") {
    return (
      // The shell owns `data-bg-target` for every route that goes through it.
      // This body does not, so without the mark the wallpaper has nothing to
      // paint against and the page renders on bare canvas.
      <div
        className="safe-area-pt flex h-full min-h-0 flex-col pb-[env(safe-area-inset-bottom)]"
        data-bg-target="chat"
        data-testid="squads-mobile-body"
      >
        <SquadDetailView
          squadId={route.selectedId}
          route={route}
          tab={resolveSquadTab(route.tab, { selected: true, compact: true }) as SquadDetailTab}
          onBack={() => route.setSelectedId(undefined)}
          onEdit={route.setEditing}
          compact
        />
        {dialogs}
      </div>
    )
  }

  // A link to a Squad that is gone (deleted, or from another workspace) says so
  // and offers the way back, rather than quietly showing the list with a dead
  // `?id=` still on the URL for the next share or reload to trip over.
  // Still arriving from Dexie: nothing rather than a flash of the list or of
  // "Squad unavailable" for a Squad that is a moment away.
  if (selected.status === "loading") {
    return (
      <div className="h-full" data-bg-target="chat" data-testid="squads-mobile-body">
        {dialogs}
      </div>
    )
  }

  if (selected.status === "missing") {
    return (
      <div
        className="safe-area-pt flex h-full min-h-0 flex-col"
        data-bg-target="chat"
        data-testid="squads-mobile-body"
      >
        <Empty className="flex-1" data-testid="squads-mobile-missing">
          <EmptyHeader>
            <EmptyTitle className="text-sm">{t("detail.missingTitle")}</EmptyTitle>
            <EmptyDescription className="text-xs">
              {t("detail.missingDescription")}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" onClick={() => route.setSelectedId(undefined)}>
              {t("detail.backToAll")}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  const tab = resolveSquadTab(route.tab, { selected: false, compact: true })

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-bg-target="chat"
      data-testid="squads-mobile-body"
    >
      <div className="safe-area-pt flex shrink-0 items-start justify-between gap-2 px-4 pb-2 pt-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{t("title")}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {fleet.total > 0
              ? t("summary", { total: fleet.total, live: fleet.live })
              : t("description")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            size="icon"
            className="size-9"
            onClick={() => setCreateOpen(true)}
            aria-label={t("createCta")}
            data-testid="squads-mobile-create"
          >
            <PlusIcon aria-hidden className="size-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 text-muted-foreground"
                aria-label={t("moreActions")}
                data-testid="squads-mobile-more"
              >
                <MoreHorizontalIcon aria-hidden className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem asChild>
                <Link href={settingsHref("squads")} data-testid="squads-mobile-manage">
                  <SettingsIcon aria-hidden className="size-4" />
                  {t("manageAction")}
                </Link>
              </DropdownMenuItem>
              {fleetSource === "none" ? null : (
                <DropdownMenuItem asChild>
                  <Link href="/fleet" data-testid="squads-mobile-host-activity">
                    <ActivityIcon aria-hidden className="size-4" />
                    {t("openFleet")}
                  </Link>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(next) => route.setTab(next as SquadFleetTab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="mx-4 grid w-auto shrink-0 grid-cols-2">
          <TabsTrigger value="overview" data-testid="squads-mobile-tab-overview">
            {t("tabs.fleet")}
          </TabsTrigger>
          <TabsTrigger value="squads" data-testid="squads-mobile-tab-squads">
            {t("tabs.squads")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-2 min-h-0 flex-1">
          <SquadFleetOverview route={route} className="px-3" />
        </TabsContent>

        <TabsContent value="squads" className="mt-2 min-h-0 flex-1">
          <SquadListPane
            fleet={fleet}
            route={route}
            onCreate={() => setCreateOpen(true)}
            variant="page"
            emptyStyle="full"
          />
        </TabsContent>
      </Tabs>
      {dialogs}
    </div>
  )
}

export default SquadsMobileBody
