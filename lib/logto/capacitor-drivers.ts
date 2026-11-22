/**
 * Logto sign-in drivers for the Capacitor shell.
 *
 * A WebView cannot pop a window: `window.open` returns null on iOS and the
 * Android WebView has no opener to post back to, so the web popup drivers
 * fail before the authorize page is even shown. The mobile shell already has
 * the right shape for this in `lib/oauth/mobile-flow.ts`: open the authorize
 * URL in the system in-app browser, wait for the `cognia://` deep link the
 * OS hands back, close the browser. These drivers put the Logto PKCE flow on
 * that path, with the redirect URI registered on the native Logto application.
 *
 * `openUrl` only remembers the URL. `runOAuth` opens the browser itself, and
 * opening it twice would leave one sheet under another. A request naming a
 * provider whose app is installed (Feishu) is handed to that app instead, and
 * when that app will not open the deep link back, the code is claimed from
 * the issuer with this request's PKCE verifier (`claimAppReturn`).
 */

import { isAppHandoffAvailable, openInApp } from "@/lib/capacitor/app-handoff"
import { subscribeResume } from "@/lib/capacitor/app"
import { appHandoffFor } from "@/lib/oauth/app-handoff"
import { runOAuth as defaultRunOAuth, type AppHandoff } from "@/lib/oauth/mobile-flow"

import type { LogtoDrivers } from "./client"

/** The person closed the browser sheet or the wait ran out. Not a failure to report. */
export class LogtoSignInCancelled extends Error {
  constructor(message = "Logto sign-in was cancelled") {
    super(message)
    this.name = "LogtoSignInCancelled"
  }
}

export interface LogtoCapacitorDriverDeps {
  runOAuth?: typeof defaultRunOAuth
  /** Override the in-app browser timeout. Defaults to the flow's five minutes. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Cancel waiting and close the in-app browser when the caller aborts. */
  signal?: AbortSignal
  /** The provider app that can run this authorize request, if any. Tests swap it. */
  appHandoff?: (authorizeUrl: string, pickup?: AppReturnPickup) => AppHandoff | undefined
}

/** What proves this app sent the authorize request, to claim its code back. */
export interface AppReturnPickup {
  state: string
  codeVerifier: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

/** The issuer's app-return claim (cognia-services/services/identity-server/src/app-return.ts). */
export const APP_RETURN_CLAIM_PATH = "/api/app-return/claim"

/**
 * Ask the issuer for the code it redirected to this app, proving the request
 * is ours with its PKCE verifier. Null when there is none: not issued yet,
 * already taken, expired, or an issuer without app returns. The code is then
 * redeemed at the token endpoint like a delivered one, PKCE checked again.
 */
export async function claimAppReturn(
  authorizeUrl: string,
  pickup: AppReturnPickup
): Promise<{ code: string; state: string } | null> {
  const response = await (pickup.fetchImpl ?? fetch)(
    new URL(APP_RETURN_CLAIM_PATH, authorizeUrl).toString(),
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ state: pickup.state, code_verifier: pickup.codeVerifier }),
      ...(pickup.signal ? { signal: pickup.signal } : {}),
    }
  )
  if (!response.ok) return null
  const body = (await response.json().catch(() => null)) as {
    code?: unknown
    state?: unknown
  } | null
  if (typeof body?.code !== "string" || !body.code || body.state !== pickup.state) return null
  return { code: body.code, state: pickup.state }
}

/**
 * A sign-in that names a provider whose app is on this phone (Feishu) runs
 * in that app, where the person is already signed in; any other runs in the
 * in-app browser. See `lib/oauth/app-handoff.ts`.
 */
export function providerAppHandoff(
  authorizeUrl: string,
  pickup?: AppReturnPickup
): AppHandoff | undefined {
  const handoff = appHandoffFor(authorizeUrl)
  if (!handoff) return undefined
  return {
    open: async () =>
      (await isAppHandoffAvailable(handoff.target)) && openInApp(handoff.target, handoff.url),
    onReturn: (handler) => subscribeResume(handler),
    ...(pickup ? { recover: () => claimAppReturn(authorizeUrl, pickup) } : {}),
  }
}

export function createLogtoCapacitorDrivers(deps: LogtoCapacitorDriverDeps = {}): LogtoDrivers {
  let authorizeUrl: string | null = null
  return {
    fetchImpl: deps.fetchImpl,
    openUrl: (url) => {
      authorizeUrl = url
    },
    waitForCode: async ({ state, codeVerifier }) => {
      if (deps.signal?.aborted) {
        authorizeUrl = null
        const aborted = new Error("Logto mobile sign-in aborted")
        aborted.name = "AbortError"
        throw aborted
      }
      if (!authorizeUrl) throw new Error("Logto authorize URL was never opened")
      const outcome = await (deps.runOAuth ?? defaultRunOAuth)({
        authorizeUrl,
        provider: "logto",
        timeoutMs: deps.timeoutMs,
        ...(deps.signal ? { signal: deps.signal } : {}),
        appHandoff: (deps.appHandoff ?? providerAppHandoff)(
          authorizeUrl,
          codeVerifier
            ? {
                state,
                codeVerifier,
                fetchImpl: deps.fetchImpl,
                ...(deps.signal ? { signal: deps.signal } : {}),
              }
            : undefined
        ),
        accept: (route) => {
          if (route.kind !== "logto_callback") return null
          // Ignore stale callbacks from an abandoned earlier attempt so they
          // cannot close the active browser sheet or kill the current login.
          if (route.state !== state) return null
          if (route.error) return { error: route.error }
          if (!route.code) return { error: "missing_code" }
          return { code: route.code, state }
        },
      })
      authorizeUrl = null
      if (deps.signal?.aborted) {
        const aborted = new Error("Logto mobile sign-in aborted")
        aborted.name = "AbortError"
        throw aborted
      }
      switch (outcome.kind) {
        case "ok":
          return { code: outcome.result.code, state }
        case "mismatch":
          throw new Error("Logto callback state mismatch")
        case "error":
          if (outcome.error === "missing_code") {
            throw new Error("Logto callback is missing code")
          }
          throw new Error(`Logto authorization failed: ${outcome.error}`)
        case "timeout":
          throw new LogtoSignInCancelled("Logto sign-in timed out")
        case "cancelled":
          throw new LogtoSignInCancelled()
      }
    },
  }
}
