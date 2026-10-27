"use client"

/**
 * The Squad fleet on a wide pane: every Squad in a rail, and in the centre
 * either one Squad's own view or the fleet overview.
 *
 * Laid out the way `/bots` and `/devices` are: one management header with a
 * single primary verb, a fixed-width rail of rows, and `ConsoleSection` cards
 * in the centre. It used to carry four header buttons of equal weight (two ways
 * to create, a link to Settings, a link to `/fleet`), a rail that also listed
 * the chat sidebar's built-in Teams, and every "configure" or "edit" sent the
 * reader to Settings. The path through the page is now:
 *
 *  1. New Squad, the one primary action, opens `CreateSquadDialog`, which
 *     names the three ways to start. The new Squad opens with its edit drawer.
 *  2. With nothing selected the centre is `SquadFleetOverview`: what needs an
 *     answer, what is working, the latest runs.
 *  3. A selected Squad heads its own view with its controls (`SquadDetailView`),
 *     and editing it opens `SquadEditSheet` over the page (`?edit=`), the same
 *     panel Settings shows, without leaving the run being watched.
 *
 * Settings and `/fleet` stay one click away in the header's overflow menu.
 *
 * The board carries two plugin slots (`agent.team.task.actions`,
 * `agent.team.board.toolbar`) whose declared host stopped being rendered when
 * ADR-0140 retired `/agent-teams/workspace`. It is not folded into `/issues`:
 * both boards' headers record that crossing their two guard vocabularies (six
 * statuses against eight, `blocked` machine-only in one of them) was avoided on
 * purpose.
 *
 * This is the WIDE-PANE surface only. The phone has its own body
 * (`SquadsMobileBody`), and the list, the Squad view, the overview, the dialog
 * and the drawer are shared components rather than two branches of one file.
 * Between `md` and `lg` the shell moves the rail into a sheet; picking a Squad
 * there closes it, because the pick is the whole reason the sheet was opened.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ActivityIcon, PlusIcon, SettingsIcon, UsersIcon } from "lucide-react"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { CreateSquadDialog } from "@/components/squads/create-squad-dialog"
import { SquadDetailView } from "@/components/squads/squad-detail-view"
import { SquadEditSheet } from "@/components/squads/squad-edit-sheet"
import { SquadFleetOverview, squadRunHref } from "@/components/squads/squad-fleet-overview"
import { SquadListPane } from "@/components/squads/squad-list-pane"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useFleetSnapshot } from "@/hooks/fleet/use-fleet-snapshot"
import { useSquadFleet } from "@/hooks/squads/use-squad-fleet"
import { useSelectedSquad } from "@/hooks/squads/use-selected-squad"
import {
  resolveSquadTab,
  type SquadDetailTab,
  type SquadRouteState,
} from "@/hooks/squads/use-squad-route-state"
import { settingsHref } from "@/lib/settings/deep-link"

export interface SquadFleetConsoleProps {
  /**
   * The URL state, owned by the route and shared with the phone body, so a
   * link opens the same Squad and the same narrowed list on either.
   */
  route: SquadRouteState
}

export function SquadFleetConsole({ route }: SquadFleetConsoleProps) {
  const t = useTranslations("squads.fleet")
  const router = useRouter()
  const fleet = useSquadFleet({ query: route.query, filter: route.filter })
  const selected = useSelectedSquad(route.selectedId)
  const [createOpen, setCreateOpen] = useState(false)
  // Only consulted below `lg`, where the shell renders the rail as a sheet.
  const [railOpen, setRailOpen] = useState(false)
  // `/fleet` is the live triage read of the HOST's sessions, where a parked
  // permission can be answered remotely. Its contract is `standalone: "hidden"`
  // and `companion: "remote"`, so the link is offered only where the route
  // exists: `source === "none"` is an unpaired browser, and pointing it at a
  // hidden route would be a dead end.
  const { source: fleetSource } = useFleetSnapshot()

  // A run link from before the overview (`/squads?run=` with no Squad) named
  // the all-runs cockpit that used to fill this centre. That cockpit is
  // `/agent-runs` now, so the link goes on to the same run there.
  useEffect(() => {
    if (!route.selectedId && route.runId) router.replace(squadRunHref(undefined, route.runId))
  }, [route.selectedId, route.runId, router])

  // A new Squad opens with its drawer: naming and staffing it is the next step.
  const onCreated = useCallback(
    (squadId: string) => route.setSelectedId(squadId, { edit: "general" }),
    [route]
  )

  // The rail's copy of the route closes the sheet on a pick. The wide layout
  // ignores `open`, so this costs nothing there.
  const railRoute = useMemo<SquadRouteState>(
    () => ({
      ...route,
      setSelectedId: (id, options) => {
        if (options) route.setSelectedId(id, options)
        else route.setSelectedId(id)
        setRailOpen(false)
      },
    }),
    [route]
  )

  const empty = !fleet.loading && fleet.total === 0

  let center: React.ReactNode
  if (route.selectedId && selected.status === "found") {
    center = (
      <SquadDetailView
        squadId={route.selectedId}
        route={route}
        tab={resolveSquadTab(route.tab, { selected: true, compact: false }) as SquadDetailTab}
        onEdit={route.setEditing}
      />
    )
  } else if (selected.status === "missing") {
    // Deleted in another window, or a stale link. Saying so beats a blank
    // centre, which is what the inspector used to fall back to.
    center = (
      <Empty className="h-full border-none" data-testid="squad-fleet-missing">
        <EmptyHeader>
          <EmptyTitle className="text-sm">{t("detail.missingTitle")}</EmptyTitle>
          <EmptyDescription className="text-xs">{t("detail.missingDescription")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={() => route.setSelectedId(undefined)}>
            {t("detail.backToAll")}
          </Button>
        </EmptyContent>
      </Empty>
    )
  } else if (empty) {
    center = (
      <Empty className="h-full border-none" data-testid="squad-fleet-onboarding">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("onboarding.description")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="squad-fleet-create">
            <PlusIcon aria-hidden className="size-4" />
            {t("createCta")}
          </Button>
        </EmptyContent>
      </Empty>
    )
  } else if (selected.status === "none" && !fleet.loading) {
    center = <SquadFleetOverview route={route} />
  } else {
    center = null
  }

  return (
    <FeaturePageShell
      storageId="squads"
      header={
        <FeaturePageHeader
          variant="management"
          icon={<UsersIcon className="size-5" />}
          title={t("title")}
          description={t("description")}
          // Nothing to count yet: the centre already says "No Squads yet", and
          // a header reading "none working of 0 Squads" only repeated it badly.
          summary={
            fleet.total > 0 ? t("summary", { total: fleet.total, live: fleet.live }) : undefined
          }
          primaryAction={{
            id: "create",
            label: t("createCta"),
            icon: PlusIcon,
            onSelect: () => setCreateOpen(true),
            testId: "squad-fleet-new",
          }}
          overflowLabel={t("moreActions")}
          overflowActions={[
            {
              id: "manage",
              label: t("manageAction"),
              icon: SettingsIcon,
              href: settingsHref("squads"),
              testId: "squad-fleet-manage",
            },
            ...(fleetSource === "none"
              ? []
              : [
                  {
                    id: "fleet",
                    label: t("openFleet"),
                    icon: ActivityIcon,
                    href: "/fleet",
                    testId: "squad-fleet-host-activity",
                  },
                ]),
          ]}
          testId="squad-fleet-header"
        />
      }
      leftPane={{
        label: t("railLabel"),
        content: (
          <SquadListPane
            fleet={fleet}
            route={railRoute}
            variant="rail"
            // The centre carries the full empty state with the way to make a
            // Squad; the rail only needs to say the list is empty.
            emptyStyle="quiet"
          />
        ),
        // A fixed rail, as on `/bots`: a row does not get more readable as the
        // window widens, and a percentage let the rail take width the Squad's
        // cards needed. The center takes the remainder.
        defaultSize: "19rem",
        minSize: "15rem",
        maxSize: "24rem",
        open: railOpen,
        onOpenChange: setRailOpen,
      }}
      centerClassName="min-h-0"
    >
      {center}
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
    </FeaturePageShell>
  )
}

export default SquadFleetConsole
