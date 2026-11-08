// One-shot installer for the Unified Notification Center bridges (ADR-0042).
// Mounted once at app startup (see the root provider). Wires the inbound
// sources that funnel into the single `notify()` pipe the kernel owns: plugin
// notifications. Connector inbound messages arrive through the connectors' own
// bridge, installed by their UI effect (`components/connectors/module.ui.ts`).
// Mobile push is installed by the Capacitor boot provider after native plugin
// registration. The session-completion source is a React hook
// (`useSessionNotifications`) mounted separately. Idempotent — each bridge
// guards its own re-installation.

import { installPluginNotificationBridge } from "./plugin-bridge"

let installed = false

export function installNotificationBridges(): void {
  if (installed) return
  installed = true
  installPluginNotificationBridge()
}

export function __resetNotificationBridgesForTesting(): void {
  installed = false
}
