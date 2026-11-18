"use client"

/**
 * The phone's Sites overview.
 *
 * A phone never builds or deploys: the sandbox, the terminal and the keyring
 * that publishing needs are the desktop's. What it does is show Sites, in one
 * of two honest ways.
 *
 *  - **Paired with a Host.** The Sites tables are a read-only mirror of the
 *    Host's (`lib/sites/sync/sync-handlers.ts`), so each row is the Host's
 *    Site: its lifecycle, the version in production and when it went live,
 *    the anonymous entry check of a restricted Site, and its last few
 *    operations. Nothing here writes; every change is made on the Host.
 *  - **Standalone.** The phone owns its database (ADR-0084), which is normally
 *    empty, and the overview says that pairing with the desktop is how its
 *    Sites get here.
 */
import { useFormatter, useNow, useTranslations } from "next-intl"
import { CloudIcon, GlobeIcon } from "lucide-react"

import { ExternalLink } from "@/components/shared/external-link"
import { Surface } from "@/components/surface/surface"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { useSitesHostMirror } from "@/hooks/sites/use-site-action-gate"
import {
  useSiteOverviewDetails,
  type SiteOverviewDetails,
} from "@/hooks/sites/use-site-overview-details"
import { pickActiveDeployment, siteProductionUrl } from "@/lib/sites/console-model"
import { cn } from "@/lib/utils"
import {
  SITE_ENTRY_FACE,
  SITE_LIFECYCLE_FACE,
  SITE_OPERATION_FACE,
  SiteStatusPill,
} from "./site-status"
import type { SiteDeploymentRow, SiteProjectRow } from "@/types/sites"

export interface SiteMobileOverviewProps {
  sites: readonly SiteProjectRow[]
  activeDeployments: readonly SiteDeploymentRow[]
  loading: boolean
}

export interface SiteMobileOverviewViewProps extends SiteMobileOverviewProps {
  /** The Sites here are a paired Host's mirror rather than this phone's own. */
  mirror: boolean
  details: SiteOverviewDetails
}

/** The overview wired to the live mirror and the version / journal reads. */
export function SiteMobileOverview(props: SiteMobileOverviewProps) {
  const mirror = useSitesHostMirror()
  const details = useSiteOverviewDetails(props.activeDeployments)
  return <SiteMobileOverviewView {...props} mirror={mirror} details={details} />
}

export function SiteMobileOverviewView({
  sites,
  activeDeployments,
  loading,
  mirror,
  details,
}: SiteMobileOverviewViewProps) {
  const t = useTranslations("sites")
  const format = useFormatter()
  const now = useNow()
  const ago = (at: number) => format.relativeTime(new Date(at), now)

  return (
    <div className="space-y-4 p-4" data-testid="sites-mobile-notice">
      <Alert data-testid={mirror ? "sites-mobile-host" : "sites-mobile-standalone"}>
        <CloudIcon />
        <AlertTitle>{mirror ? t("mobile.host.title") : t("mobile.readOnly")}</AlertTitle>
        <AlertDescription>
          {mirror ? t("mobile.host.explain") : t("mobile.explain")}
        </AlertDescription>
      </Alert>

      {loading ? (
        <div className="space-y-2" data-testid="sites-mobile-loading">
          <Skeleton className="h-14 w-full rounded-panel" />
          <Skeleton className="h-14 w-full rounded-panel" />
        </div>
      ) : sites.length === 0 ? (
        <Empty role="status" className="gap-3 px-4 py-10" data-testid="sites-mobile-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-primary/10 text-primary">
              <GlobeIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle className="text-sm">
              {mirror ? t("mobile.host.empty") : t("mobile.empty")}
            </EmptyTitle>
            <EmptyDescription className="max-w-sm text-xs">
              {mirror ? t("mobile.host.emptyExplain") : t("mobile.pairToSee")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="space-y-2" data-testid="sites-mobile-list">
          {sites.map((site) => {
            const siteDeployments = activeDeployments.filter((row) => row.siteId === site.id)
            const url = siteProductionUrl(siteDeployments)
            const live = pickActiveDeployment(siteDeployments)
            const production = live ? details.versionsById.get(live.versionId) : undefined
            const operations = details.operationsBySite.get(site.id) ?? []
            return (
              <li key={site.id}>
                <Surface
                  layer="raised"
                  radius="panel"
                  className={cn(
                    "flex items-start gap-2 border p-3",
                    site.lifecycle === "deleted" && "opacity-60"
                  )}
                  data-testid={`sites-mobile-row-${site.id}`}
                >
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded bg-primary/10 text-primary">
                    <GlobeIcon aria-hidden className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {site.name}
                      </span>
                      <SiteStatusPill
                        face={SITE_LIFECYCLE_FACE[site.lifecycle]}
                        label={t(`lifecycle.${site.lifecycle}`)}
                        className="shrink-0 px-1.5 text-[10px]"
                      />
                    </span>
                    {/* The live URL is the one thing a phone can do with a
                        Site, so it opens it rather than only printing it. */}
                    {url ? (
                      <ExternalLink
                        href={url}
                        className="block truncate font-mono text-xs text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
                        data-testid={`sites-mobile-url-${site.id}`}
                      >
                        {url}
                      </ExternalLink>
                    ) : (
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {site.providerConfig.workerName}
                      </span>
                    )}

                    <span
                      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
                      data-testid={`sites-mobile-production-${site.id}`}
                    >
                      {live ? (
                        <>
                          {production ? (
                            <span className="font-medium text-foreground">
                              {t("overview.currentVersion", { sequence: production.sequence })}
                            </span>
                          ) : null}
                          <span>{t("overview.deployedAt", { when: ago(live.updatedAt) })}</span>
                          {live.entryVerification ? (
                            <SiteStatusPill
                              face={SITE_ENTRY_FACE[live.entryVerification.state]}
                              label={t(`access.entries.state.${live.entryVerification.state}`)}
                              className="px-1.5 text-[10px]"
                            />
                          ) : null}
                        </>
                      ) : (
                        <span>{t("overview.noVersion")}</span>
                      )}
                    </span>

                    {operations.length > 0 ? (
                      <ul
                        aria-label={t("mobile.recentOperations")}
                        className="space-y-0.5 pt-1"
                        data-testid={`sites-mobile-operations-${site.id}`}
                      >
                        {operations.map((operation) => (
                          <li
                            key={operation.id}
                            className="flex min-w-0 items-center gap-1.5 text-xs"
                          >
                            <span className="min-w-0 truncate">
                              {t(`operationType.${operation.type}`)}
                            </span>
                            <SiteStatusPill
                              face={SITE_OPERATION_FACE[operation.status]}
                              label={t(`operationStatus.${operation.status}`)}
                              className="shrink-0 px-1.5 text-[10px]"
                            />
                            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                              {ago(operation.updatedAt)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </span>
                </Surface>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
