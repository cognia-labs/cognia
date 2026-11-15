"use client"

// Renderer-side subscription bootstrap.
//
// Called on app boot and after a local-account switch by
// `SubscriptionInitializer`. It invokes the Rust `subscription_init` command,
// which rebuilds the in-process active-account projection (and the Anthropic
// OAuth bearer) from the persisted vaults.
//
// Plain browser mode has no local vault at all: `subscription_init` is a
// `target: "client"` command that only the Tauri shell answers, so the call is
// skipped there instead of rejecting with a "tauri-only command" error.
//
// Failures never block app boot. A locked secret store is reported through the
// readiness sink so the caller can re-run once it unlocks; anything else is
// logged as a console warning.

import { isTauri } from "@/lib/platform/detect"
import { reportSecretStoreFailure } from "@/lib/credentials/secret-store-readiness"
import { subscriptionInit } from "./transport"

export interface SubscriptionInitResult {
  error?: string
  /**
   * True when no host backend was reachable, so nothing was invoked. Distinct
   * from `error` — this is the expected steady state of plain web mode, not a
   * failure.
   */
  skipped?: boolean
  /**
   * True when `subscription_init` failed only because the encrypted secret
   * store was locked or still initializing. Already reported (and logged once)
   * through the readiness sink; the caller defers a re-run until it unlocks.
   */
  secretStoreUnavailable?: boolean
}

/**
 * Bootstrap entry point. Idempotent on the Rust side; the caller dedupes
 * repeated runs for the same account revision.
 */
export async function subscriptionInitOnce(): Promise<SubscriptionInitResult> {
  if (!isTauri()) return { skipped: true }

  try {
    await subscriptionInit()
    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const secretStoreUnavailable = reportSecretStoreFailure(err, "subscription.init")
    if (!secretStoreUnavailable) console.warn("subscription_init failed:", message)
    return {
      error: message,
      ...(secretStoreUnavailable ? { secretStoreUnavailable: true } : {}),
    }
  }
}
