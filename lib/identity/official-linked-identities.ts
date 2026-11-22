/**
 * Managing backup social sign-in methods on the official Cognia account (G1, G2).
 *
 * Dedicated client module for `/api/account/identities` and
 * `/api/account/identities/link(/claim)`, kept separate from
 * `official-account-deletion.ts` because it owns PKCE claim generation,
 * external/popup link navigation, and claim polling.
 *
 * Both adding a new provider and removing an existing one require a fresh
 * OAuth sign-in (`prompt=login&max_age=0`) naming the same `usr_` subject as
 * this profile's session. Temporary refresh tokens minted during re-auth are
 * revoked immediately in `finally`.
 */

import {
  loginToLogto,
  revokeLogtoToken,
  type LogtoDrivers,
  type LogtoSession,
} from "@/lib/logto/client"
import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { decodeJwtPayload, stringClaim } from "@/lib/security/jwt-payload"
import { openExternal } from "@/lib/tauri/opener"
import { isTauri, isCapacitor } from "@/lib/tauri"

import type { CollabExternalIdentity } from "@/lib/collab/client"
import {
  OFFICIAL_SOCIAL_PROVIDERS,
  officialLogtoConfig,
  type OfficialConfigOptions,
  type OfficialDeployment,
  type OfficialSocialProvider,
} from "./official-deployment"

export interface LinkedOfficialProvider {
  providerId: OfficialSocialProvider
  identity: CollabExternalIdentity
  createdAt: string | null
}

export interface OfficialLinkedIdentitiesState {
  identities: LinkedOfficialProvider[]
  availableProviders: OfficialSocialProvider[]
  canUnlink: boolean
}

export type OfficialIdentityLinkErrorCode =
  | "unauthorized"
  | "stale-sign-in"
  | "different-person"
  | "last-identity"
  | "identity-already-linked"
  | "provider-already-linked"
  | "provider-unavailable"
  | "cancelled"
  | "expired"
  | "failed"

export class OfficialIdentityLinkError extends Error {
  constructor(
    readonly code: OfficialIdentityLinkErrorCode,
    message: string
  ) {
    super(message)
    this.name = "OfficialIdentityLinkError"
  }
}

export interface OfficialIdentitiesDeps {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface MutateOfficialIdentityDeps extends OfficialIdentitiesDeps {
  login?: typeof loginToLogto
  revoke?: typeof revokeLogtoToken
  assertActive?: (expectedSub: string) => void | Promise<void>
  onAwaitingProvider?: () => void
  /**
   * Opens the upstream social provider authorization URL. Returns an optional
   * handle with `closed()` / `close()` when backed by a browser popup.
   */
  openLinkWindow?: (url: string) => Promise<LinkWindowHandle | void> | LinkWindowHandle | void
  pollIntervalMs?: number
}

export interface LinkWindowHandle {
  isClosed?: () => boolean
  close?: () => void
}

type Credentials = Pick<LogtoSession, "issuer" | "accessToken">

const KNOWN_PROVIDERS = new Set<string>(OFFICIAL_SOCIAL_PROVIDERS)
const DEFAULT_POLL_INTERVAL_MS = 1_200

export function accountIdentitiesUrl(issuer: string): string {
  return new URL("/api/account/identities", issuer).href
}

export function accountIdentityLinkUrl(issuer: string): string {
  return new URL("/api/account/identities/link", issuer).href
}

export function accountIdentityLinkClaimUrl(issuer: string): string {
  return new URL("/api/account/identities/link/claim", issuer).href
}

function base64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function createClaimPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64Url(new Uint8Array(digest)) }
}

function parseIdentitiesState(body: unknown): OfficialLinkedIdentitiesState {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OfficialIdentityLinkError("failed", "Malformed account identities response")
  }
  const record = body as Record<string, unknown>
  if (!Array.isArray(record.identities) || !Array.isArray(record.availableProviders)) {
    throw new OfficialIdentityLinkError("failed", "Malformed account identities payload")
  }
  const identities: LinkedOfficialProvider[] = []
  for (const item of record.identities) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    if (typeof row.providerId !== "string" || !KNOWN_PROVIDERS.has(row.providerId)) continue
    const rawIdentity = row.identity as Record<string, unknown> | undefined
    if (
      !rawIdentity ||
      typeof rawIdentity.provider !== "string" ||
      typeof rawIdentity.subject !== "string"
    ) {
      continue
    }
    identities.push({
      providerId: row.providerId as OfficialSocialProvider,
      identity: {
        provider: rawIdentity.provider,
        subject: rawIdentity.subject,
        ...(typeof rawIdentity.tenant === "string" ? { tenant: rawIdentity.tenant } : {}),
      },
      createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
    })
  }
  const availableProviders: OfficialSocialProvider[] = []
  for (const item of record.availableProviders) {
    if (typeof item === "string" && KNOWN_PROVIDERS.has(item)) {
      const provider = item as OfficialSocialProvider
      if (!availableProviders.includes(provider)) availableProviders.push(provider)
    }
  }
  return {
    identities,
    availableProviders,
    canUnlink: typeof record.canUnlink === "boolean" ? record.canUnlink : identities.length > 1,
  }
}

function mapErrorResponse(
  status: number,
  payload: Record<string, unknown> | null
): OfficialIdentityLinkError {
  const error = typeof payload?.error === "string" ? payload.error : ""
  const description =
    typeof payload?.error_description === "string" ? payload.error_description : `HTTP ${status}`
  if (status === 401) return new OfficialIdentityLinkError("unauthorized", description)
  if (status === 403) return new OfficialIdentityLinkError("stale-sign-in", description)
  if (error === "last_identity") return new OfficialIdentityLinkError("last-identity", description)
  if (error === "identity_already_linked") {
    return new OfficialIdentityLinkError("identity-already-linked", description)
  }
  if (error === "provider_already_linked") {
    return new OfficialIdentityLinkError("provider-already-linked", description)
  }
  if (error === "provider_unavailable") {
    return new OfficialIdentityLinkError("provider-unavailable", description)
  }
  return new OfficialIdentityLinkError("failed", description)
}

function mapLinkFailureCode(code: unknown): OfficialIdentityLinkError {
  if (code === "identity_already_linked") {
    return new OfficialIdentityLinkError(
      "identity-already-linked",
      "that social account already belongs to another Cognia account"
    )
  }
  if (code === "provider_already_linked") {
    return new OfficialIdentityLinkError(
      "provider-already-linked",
      "another account for that provider is already linked"
    )
  }
  if (code === "access_denied") {
    return new OfficialIdentityLinkError("cancelled", "linking was cancelled")
  }
  if (code === "expired") {
    return new OfficialIdentityLinkError("expired", "linking expired before completion")
  }
  return new OfficialIdentityLinkError("failed", "could not complete social account linking")
}

export async function readOfficialLinkedIdentities(
  session: Credentials,
  deps: OfficialIdentitiesDeps = {}
): Promise<OfficialLinkedIdentitiesState> {
  deps.signal?.throwIfAborted()
  const fetchImpl = deps.fetchImpl ?? (createPlatformFetch() as unknown as typeof fetch)
  const response = await fetchImpl(accountIdentitiesUrl(session.issuer), {
    method: "GET",
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      accept: "application/json",
    },
    ...(deps.signal ? { signal: deps.signal } : {}),
  })
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (response.ok) return parseIdentitiesState(payload)
  throw mapErrorResponse(response.status, payload)
}

async function withFreshOfficialAuth<T>(
  deployment: OfficialDeployment,
  drivers: LogtoDrivers,
  options: Omit<OfficialConfigOptions, "freshLogin">,
  current: Pick<LogtoSession, "accessToken">,
  deps: MutateOfficialIdentityDeps,
  work: (fresh: LogtoSession) => Promise<T>
): Promise<T> {
  const expectedSub = stringClaim(decodeJwtPayload(current.accessToken), "sub")
  if (!expectedSub) {
    throw new OfficialIdentityLinkError("unauthorized", "this profile's session names no person")
  }
  deps.signal?.throwIfAborted()
  const fresh = await (deps.login ?? loginToLogto)(
    {
      ...officialLogtoConfig(deployment, { ...options, freshLogin: true }),
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    drivers
  )
  const disposeFreshRefreshToken = () => {
    if (!fresh.refreshToken) return
    void (deps.revoke ?? revokeLogtoToken)(
      { issuer: fresh.issuer, clientId: fresh.clientId },
      fresh.refreshToken,
      "refresh_token",
      deps.fetchImpl ?? drivers.fetchImpl
    ).catch(() => undefined)
  }
  try {
    deps.signal?.throwIfAborted()
    await deps.assertActive?.(expectedSub)
    deps.signal?.throwIfAborted()
    if (stringClaim(decodeJwtPayload(fresh.accessToken), "sub") !== expectedSub) {
      throw new OfficialIdentityLinkError(
        "different-person",
        "the confirming sign-in belongs to a different Cognia account"
      )
    }
    if (!fresh.idToken) {
      throw new OfficialIdentityLinkError(
        "stale-sign-in",
        "the confirming sign-in returned no ID token"
      )
    }
    return await work(fresh)
  } finally {
    disposeFreshRefreshToken()
  }
}

export function unlinkOfficialIdentity(
  deployment: OfficialDeployment,
  drivers: LogtoDrivers,
  options: Omit<OfficialConfigOptions, "freshLogin">,
  current: Pick<LogtoSession, "issuer" | "accessToken">,
  provider: OfficialSocialProvider,
  deps: MutateOfficialIdentityDeps = {}
): Promise<OfficialLinkedIdentitiesState> {
  return withFreshOfficialAuth(deployment, drivers, options, current, deps, async (fresh) => {
    const fetchImpl = deps.fetchImpl ?? (createPlatformFetch() as unknown as typeof fetch)
    const response = await fetchImpl(accountIdentitiesUrl(fresh.issuer), {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${fresh.accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider, id_token: fresh.idToken }),
    })
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (response.ok) return parseIdentitiesState(payload)
    throw mapErrorResponse(response.status, payload)
  })
}

async function defaultOpenLinkWindow(url: string): Promise<LinkWindowHandle | void> {
  if (typeof window !== "undefined" && !isTauri() && !isCapacitor()) {
    const width = 520
    const height = 680
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2))
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2))
    const popup = window.open(
      url,
      "cognia-account-link",
      `popup=yes,width=${width},height=${height},left=${left},top=${top}`
    )
    if (popup) {
      return {
        isClosed: () => popup.closed,
        close: () => {
          try {
            if (!popup.closed) popup.close()
          } catch {
            // Cross-origin COOP may block close; safe to ignore.
          }
        },
      }
    }
  }
  await openExternal(url)
}

function waitForNextPoll(intervalMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? Object.assign(new Error("Aborted"), { name: "AbortError" }))
      return
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", wake)
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible)
      }
    }
    const wake = () => {
      cleanup()
      resolve()
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") wake()
    }
    const onAbort = () => {
      cleanup()
      reject(signal?.reason ?? Object.assign(new Error("Aborted"), { name: "AbortError" }))
    }
    const timer = setTimeout(wake, intervalMs)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (typeof window !== "undefined") {
      window.addEventListener("focus", wake, { once: true })
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible)
    }
  })
}

export function linkOfficialIdentity(
  deployment: OfficialDeployment,
  drivers: LogtoDrivers,
  options: Omit<OfficialConfigOptions, "freshLogin">,
  current: Pick<LogtoSession, "issuer" | "accessToken">,
  provider: OfficialSocialProvider,
  deps: MutateOfficialIdentityDeps = {}
): Promise<OfficialLinkedIdentitiesState> {
  return withFreshOfficialAuth(deployment, drivers, options, current, deps, async (fresh) => {
    const fetchImpl = deps.fetchImpl ?? (createPlatformFetch() as unknown as typeof fetch)
    const { verifier, challenge } = await createClaimPkce()
    const startRes = await fetchImpl(accountIdentityLinkUrl(fresh.issuer), {
      method: "POST",
      headers: {
        authorization: `Bearer ${fresh.accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider,
        id_token: fresh.idToken,
        code_challenge: challenge,
      }),
      ...(deps.signal ? { signal: deps.signal } : {}),
    })
    const startPayload = (await startRes.json().catch(() => null)) as Record<string, unknown> | null
    if (!startRes.ok) throw mapErrorResponse(startRes.status, startPayload)
    const authUrl = typeof startPayload?.url === "string" ? startPayload.url : ""
    const state = typeof startPayload?.state === "string" ? startPayload.state : ""
    const expiresAtMs =
      typeof startPayload?.expiresAt === "string"
        ? Date.parse(startPayload.expiresAt)
        : Date.now() + 10 * 60_000
    if (!authUrl || !state) {
      throw new OfficialIdentityLinkError("failed", "Malformed link authorization response")
    }

    deps.onAwaitingProvider?.()
    const handle = await (deps.openLinkWindow ?? defaultOpenLinkWindow)(authUrl)
    const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    let closedGracePolls = 0

    try {
      while (Date.now() < expiresAtMs) {
        deps.signal?.throwIfAborted()
        const claimRes = await fetchImpl(accountIdentityLinkClaimUrl(fresh.issuer), {
          method: "POST",
          headers: {
            authorization: `Bearer ${fresh.accessToken}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ state, code_verifier: verifier }),
          ...(deps.signal ? { signal: deps.signal } : {}),
        })
        const claimPayload = (await claimRes.json().catch(() => null)) as Record<
          string,
          unknown
        > | null
        if (claimRes.status === 404) {
          throw new OfficialIdentityLinkError("expired", "link request expired")
        }
        if (!claimRes.ok) throw mapErrorResponse(claimRes.status, claimPayload)

        if (claimPayload?.status === "linked") {
          return parseIdentitiesState(claimPayload)
        }
        if (claimPayload?.status === "failed") {
          throw mapLinkFailureCode(claimPayload.error)
        }

        if (handle?.isClosed?.()) {
          closedGracePolls += 1
          // Give one extra poll after popup close in case callback finished right before window.close().
          if (closedGracePolls >= 2) {
            throw new OfficialIdentityLinkError("cancelled", "link window was closed")
          }
        }
        await waitForNextPoll(pollIntervalMs, deps.signal)
      }
      throw new OfficialIdentityLinkError("expired", "link request timed out")
    } finally {
      handle?.close?.()
    }
  })
}
