"use client"

// Routes `cognia://plugin/<id>/...` deep-links to the owning plugin's handler
// (C2). Mirrors ConnectorDeepLinkRouter: subscribes to the live Tauri deep-link
// pipe (`onDeepLink`) + reads the cold-start launch URL (`getLaunchDeepLink`).
// For each plugin URL it lazy-activates the plugin (`onUri:<id>` activation)
// then dispatches to its registered handler. No-op outside Tauri.

import { startHostAuthCallbackListeners } from "@/lib/plugin/auth/callback-acceptor"
import { useEffect } from "react"
import { isTauri } from "@/lib/tauri"
import { onDeepLink, getLaunchDeepLink } from "@/lib/tauri/deep-link"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { routePluginDeepLink } from "@/lib/plugin/uri/route-deep-link"

export function PluginDeepLinkRouter() {
  useEffect(() => {
    const stopCallbacks = startHostAuthCallbackListeners()
    if (!isTauri()) return stopCallbacks
    let unlisten: (() => void) | null = null
    let cancelled = false

    void (async () => {
      // Cold-start: the URL the app was launched with.
      const launch = await getLaunchDeepLink()
      if (!cancelled && launch) {
        for (const url of launch) void routePluginDeepLink(url)
      }
      unlisten = await onDeepLink((urls) => {
        for (const url of urls) void routePluginDeepLink(url)
      })
      if (cancelled && unlisten) {
        safeUnlisten(unlisten)
        unlisten = null
      }
    })()

    return () => {
      stopCallbacks()
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [])

  return null
}

export default PluginDeepLinkRouter
