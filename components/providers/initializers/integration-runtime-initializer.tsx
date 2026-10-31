"use client"

import { useEffect } from "react"
import { detectPlatform } from "@/lib/platform/detect"
import { startIntegrationRuntime } from "@/lib/integrations/runtime"
import { isIntegrationRuntimeOwner } from "@/lib/integrations/runtime-owner"
import { useAccountStore } from "@/stores/account/account-store"

export function IntegrationRuntimeInitializer() {
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const accountRevision = useAccountStore((state) => state.accountRevision)
  const runtimeOwnerKey = unlockedAccountId ? `${unlockedAccountId}:${accountRevision}` : null
  useEffect(() => {
    if (!runtimeOwnerKey) return
    const platform = detectPlatform()
    if (platform !== "tauri" && platform !== "headless") return

    let cancelled = false
    let disposeRuntime: (() => void) | undefined
    void isIntegrationRuntimeOwner().then(async (owner) => {
      if (!owner || cancelled) return
      const dispose = await startIntegrationRuntime()
      if (cancelled) dispose()
      else disposeRuntime = dispose
    })
    return () => {
      cancelled = true
      disposeRuntime?.()
    }
  }, [runtimeOwnerKey])

  return null
}

export default IntegrationRuntimeInitializer
