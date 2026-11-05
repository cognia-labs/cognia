"use client"

/**
 * Starts the module runtimes that wait for `boot` on this renderer host
 * (ADR-0250 §14, M2): every active module manifest's desktop adapter, or its
 * mobile one in the Capacitor build (`lib/modules/runtimes.ts`).
 *
 * Mounted once per boot group: in the main boot cluster with no `boot`, and
 * inside each deferred capability group for the runtimes that name it. A
 * runtime starts once an account is unlocked and restarts against the
 * database that is selected after a switch; a locked account starts nothing.
 * The desktop pet's overlay windows load this same tree and start nothing,
 * because a runtime has one owner per process (ADR-0250 §2).
 */

import { useEffect } from "react"

import { loggers } from "@cognia/logging"

import type { ModuleRuntimeBoot, RendererRuntimeContext } from "@/lib/modules/manifest-types"
import { startModuleRuntimes } from "@/lib/modules/runtime-runner"
import { RENDERER_HOST, rendererRuntimes } from "@/lib/modules/runtimes"
import { getPetWindowRole, isSecondaryOverlayRole } from "@/lib/pet/window-role"
import { useAccountStore } from "@/stores/account/account-store"

/** Each group's last teardown, which its next run waits for. */
const lastStop = new Map<string, Promise<void>>()

const log: RendererRuntimeContext["log"] = (level, message) => loggers.app[level](message)

export function ModuleRuntimeHost({ boot }: { boot?: ModuleRuntimeBoot }) {
  const accountRevision = useAccountStore((state) => state.accountRevision)
  const accountId = useAccountStore((state) => state.unlockedAccountId)

  useEffect(() => {
    if (!accountId) return
    if (isSecondaryOverlayRole(getPetWindowRole())) return
    const entries = rendererRuntimes(boot)
    if (!entries.length) return
    const key = boot ?? "main"
    const run = startModuleRuntimes(
      entries,
      { host: RENDERER_HOST, accountId, log },
      { after: lastStop.get(key) }
    )
    return () => {
      lastStop.set(key, run.stop())
    }
  }, [boot, accountRevision, accountId])

  return null
}

/** Test seam: forget the groups' last teardowns. */
export function __resetModuleRuntimeHostForTests(): void {
  lastStop.clear()
}

export default ModuleRuntimeHost
