"use client"

import { useEffect } from "react"
import { installConnectorNotificationBridge } from "@/lib/connectors/notifications/inbound-bridge"

/**
 * Installs the connector inbound → Notification Center bridge once per window
 * (ADR-0042), as the connectors' UI effect `inbound-notification-bridge`. The
 * bridge guards its own re-installation and outlives a remount, as it did
 * when the root provider installed it.
 */
export default function InboundNotificationBridge(): null {
  useEffect(() => {
    installConnectorNotificationBridge()
  }, [])
  return null
}
