"use client"

/**
 * Boot-time hygiene for the cloud identity of the unlocked profile.
 *
 * `resolveLogtoSession` runs once per unlocked profile and has no UI. Resolving
 * on boot is what turns "the token expired while the app was closed" into a
 * marker the Account surface can show, instead of the first cloud request of
 * the day failing with a 401. A refresh that succeeds here is also the refresh
 * every later caller gets for free.
 *
 * It is best effort. A keyring that is not reachable at boot is logged and
 * retried on the next unlock, never surfaced as a boot failure: local data does
 * not depend on the cloud, and the gate must never wait on it.
 */

import { useEffect, useRef } from "react"
import { loggers } from "@cognia/logging"

import { resolveLogtoSession } from "@/lib/logto/app-session"
import { useAccountStore } from "@/stores/account/account-store"

const log = loggers.shell

export function CloudIdentityInitializer() {
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const ranFor = useRef<string | null>(null)

  useEffect(() => {
    if (!unlockedAccountId) return
    if (ranFor.current === unlockedAccountId) return
    ranFor.current = unlockedAccountId

    void (async () => {
      try {
        const resolved = await resolveLogtoSession({ localAccountId: unlockedAccountId })
        if (resolved.status === "reauth-required") {
          log.info("cloud-identity: sign-in required", { reason: resolved.reason })
        }
      } catch (error) {
        log.warn("cloud-identity: session resolution failed", { error: String(error) })
      }
    })()
  }, [unlockedAccountId])

  return null
}

export default CloudIdentityInitializer
