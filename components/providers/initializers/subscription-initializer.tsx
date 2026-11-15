"use client"

// Fires on app boot and on every local-account switch. Calls into the Rust
// `subscription_init` command, which rebuilds the active-account projection
// from the unlocked account's persisted vaults.
//
// Also hydrates the subscription cloud-sync passphrase (opt-in keyring copy)
// and pokes the unattended uploader once — covering changes whose debounce
// was lost to an app exit. All gating lives inside
// `maybeAutoUploadSubscription`; this is a no-op when the toggle is off.

import { useEffect, useRef } from "react"

import { deferUntilSecretStoreReady } from "@/lib/credentials/secret-store-readiness"
import { subscriptionInitOnce } from "@/lib/subscription/core/init"
import { notifySubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { maybeAutoUploadSubscription } from "@/lib/subscription/sync/subscription-sync"
import { useAccountStore } from "@/stores/account/account-store"

export function SubscriptionInitializer() {
  const lastInitializedKey = useRef<string | null>(null)
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const accountRevision = useAccountStore((state) => state.accountRevision)

  useEffect(() => {
    if (!unlockedAccountId) return
    const initKey = `${unlockedAccountId}:${accountRevision}`
    if (lastInitializedKey.current === initKey) return
    lastInitializedKey.current = initKey

    const run = async (): Promise<void> => {
      const result = await subscriptionInitOnce()
      // A locked secret store is not a finished boot: run the whole init again
      // once the user unlocks it, unless the account has changed since.
      if (result.secretStoreUnavailable) {
        deferUntilSecretStoreReady("subscription.init", async () => {
          if (lastInitializedKey.current === initKey) await run()
        })
      }
      // The boot rebuild (subscription_init → apply_active_projection) may have
      // just pushed the OAuth bearer into ApiKeyState. Tell the chat header so
      // it drops the stale "No API key" badge without waiting for the user to
      // poke the settings popover. This also re-fires every limits refresh.
      notifySubscriptionChanged()
      await maybeAutoUploadSubscription().catch(() => undefined)
    }
    void run()
  }, [accountRevision, unlockedAccountId])

  return null
}

export default SubscriptionInitializer
