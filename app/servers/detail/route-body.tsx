"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { LogOutIcon, PlugZapIcon } from "lucide-react"
import { useServerOps } from "@/components/servers/ops-context"
import type { Operation, ServerHealth } from "@/lib/server-ops/client"
import type { ServerDetailMobileBodyProps } from "@/components/mobile/servers/server-detail-mobile-body"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { ServerDetailMobileBody } from "@/components/mobile/servers/server-detail-mobile-body"
import {
  FeaturePageHeader,
  type FeatureHeaderStatusTone,
} from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { ConnectAgentDialog } from "@/components/servers/connect-agent-dialog"
import { OperationInspector } from "@/components/servers/operation-inspector"
import { OperationsRail } from "@/components/servers/operations-rail"
import { ServerDetailView } from "@/components/servers/server-detail"

/** A target's health as the header's one status chip. */
const HEALTH_TONE: Record<ServerHealth, FeatureHeaderStatusTone> = {
  healthy: "success",
  degraded: "warning",
  unavailable: "danger",
  unknown: "neutral",
}

export interface RouteBodyProps extends ServerDetailMobileBodyProps {
  /**
   * The page's "All servers" link, which its missing-target state draws. The
   * wide header does not render it: its way back is the header's own `back`.
   */
  backToFleet: ReactNode
  controllerUrl: string
  enrollOpen: boolean
  setEnrollOpen: (open: boolean) => void
  inspected: Operation | null
  setInspected: (operation: Operation | null) => void
}

export default function RouteBody(props: RouteBodyProps) {
  const compact = useCompactLayout()
  return compact ? <ServerDetailMobileBody {...props} /> : <ServerDetailWideBody {...props} />
}

function ServerDetailWideBody({
  server,
  backups,
  logs,
  loadingDetail,
  actions,
  controllerUrl,
  enrollOpen,
  setEnrollOpen,
  inspected,
  setInspected,
}: RouteBodyProps) {
  const t = useTranslations("servers")
  const ops = useServerOps()
  return (
    <>
      <FeaturePageShell
        storageId="server-detail"
        header={
          <FeaturePageHeader
            variant="management"
            back={{
              label: t("actions.backToServers"),
              href: "/servers",
              testId: "server-detail-back",
            }}
            title={server.label || server.id}
            description={t("detail.description")}
            status={{
              label: t(`health.${server.health}`),
              tone: HEALTH_TONE[server.health],
              testId: "server-detail-health",
            }}
            context={
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono">{server.id}</span>
                {server.publicUrl && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{server.publicUrl}</span>
                  </>
                )}
              </span>
            }
            refresh={{
              label: t("actions.refresh"),
              onSelect: () => void ops.refresh(),
              busy: ops.loading,
            }}
            secondaryActions={[
              {
                id: "enroll",
                label: t("enroll.action"),
                icon: PlugZapIcon,
                onSelect: () => setEnrollOpen(true),
              },
            ]}
            overflowActions={[
              {
                id: "disconnect",
                label: t("connection.disconnect"),
                icon: LogOutIcon,
                onSelect: () => void ops.disconnect(),
                destructive: true,
              },
            ]}
            overflowLabel={t("actions.more")}
          />
        }
        rightPane={{
          label: t("operations.ariaLabel"),
          content: (
            <OperationsRail
              operations={ops.operations}
              liveEvents={ops.liveEvents}
              eventStreamConnected={ops.eventStreamConnected}
              selectedId={inspected?.id ?? null}
              onSelect={setInspected}
              targetId={server.id}
            />
          ),
        }}
      >
        <ServerDetailView
          server={server}
          backups={backups}
          logs={logs}
          loadingDetail={loadingDetail}
          actions={{ ...actions, onConnectAgent: () => setEnrollOpen(true) }}
        />
      </FeaturePageShell>

      <ConnectAgentDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        servers={ops.servers}
        controllerUrl={controllerUrl}
        initialTargetId={server.id}
        onIssueToken={ops.createEnrollmentToken}
        onRefresh={ops.refresh}
      />
      <OperationInspector
        operation={inspected}
        loadEvents={ops.listOperationEvents}
        onOpenChange={(open) => !open && setInspected(null)}
        onCancel={(id) => {
          void ops.cancelOperation(id)
          setInspected(null)
        }}
      />
    </>
  )
}
