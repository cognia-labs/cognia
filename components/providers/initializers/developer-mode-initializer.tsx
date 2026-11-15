"use client"

import { useEffect } from "react"

import { applyBootDeveloperMode } from "@/lib/plugin/devtools/developer-mode"

/**
 * Boot-time enable of global developer mode on development builds (ADR-0117).
 *
 * Runs once per boot and writes only when developer mode is off and this is a
 * development build. Mirrors the `ChatMiddlewareFlagInitializer` shape so the
 * `app/layout.tsx` initializer block stays homogeneous.
 */
export function DeveloperModeInitializer() {
  useEffect(() => {
    applyBootDeveloperMode()
  }, [])

  return null
}

export default DeveloperModeInitializer
