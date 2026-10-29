"use client"

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { useSandboxConnections } from "@/hooks/automation/use-sandbox-connections"
import {
  managedDesktopClient,
  managedDesktopTargetConfig,
  subscribeManagedDesktopTargetChanges,
  type ManagedDesktopConfigSummary,
  type ManagedDesktopResource,
} from "@/lib/automation/managed-desktop-client"
import { watchManagedDesktopBindings } from "@/lib/sandbox/managed-desktop-binding"
import {
  managedDesktopCapabilities,
  supportsSandboxOperation,
} from "@/lib/sandbox/connection-capabilities"
import { useAccountStore } from "@/stores/account/account-store"

const LOCAL = { kind: "local" } as const

/** Shared character/composer options. Managed routing is local to this Host. */
export function useComputerUseTargets() {
  const { connections } = useSandboxConnections()
  const owner = useAccountStore((state) => state.unlockedAccountId)
  const locked = useAccountStore((state) => state.locked)
  const hostConfig = useSyncExternalStore(
    subscribeManagedDesktopTargetChanges,
    () => managedDesktopTargetConfig(LOCAL),
    () => undefined
  )
  const identity = JSON.stringify([owner, locked, hostConfig])
  const [managed, setManaged] = useState<{
    desktops: ManagedDesktopResource[]
    configs: ManagedDesktopConfigSummary[]
    failed: boolean
    identity: string
  }>({ desktops: [], configs: [], failed: false, identity })

  const load = useCallback(async () => {
    const [desktops, configs] = await Promise.all([
      managedDesktopClient.list({ kind: "local" }),
      managedDesktopClient.listConfigs({ kind: "local" }),
    ])
    return { desktops, configs, failed: false }
  }, [])

  useEffect(() => {
    let active = true
    let stop: (() => void) | undefined
    // Watch setup can synchronously refuse while the account is locked.
    void Promise.resolve()
      .then(() => {
        if (!active) return
        stop = watchManagedDesktopBindings()
        return load()
      })
      .then(
        (next) => {
          if (active && next) setManaged({ ...next, identity })
        },
        () => {
          if (active) setManaged({ desktops: [], configs: [], failed: true, identity })
        }
      )
    return () => {
      active = false
      stop?.()
    }
  }, [load, identity])

  return {
    // Managed rows are selected through a fresh human delegation below, never
    // by borrowing another grantee's stored routing id. Remote Hosts are absent.
    connections: connections.filter(
      (row) => row.provider !== "e2b" && supportsSandboxOperation(row.capabilities, "gui")
    ),
    managed: (managed.identity === identity ? managed.desktops : [])
      .filter((desktop) => desktop.state === "running")
      .map((desktop) => {
        const config = managed.configs.find((item) => item.id === desktop.providerConfigId)
        const enabled =
          !!config &&
          managedDesktopCapabilities({
            ...config,
            agentControl: config.enablement.agentControl,
          }).gui
        return { desktop, enabled }
      }),
    failed: managed.identity === identity && managed.failed,
  }
}
