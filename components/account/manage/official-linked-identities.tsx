"use client"

/**
 * Settings → Account → Identity → Backup sign-in methods (G1, G2).
 *
 * Dedicated sub-panel for the official Cognia account's linked social sign-in
 * methods (`official-linked-identities.ts`), separated from `account-identity-tab.tsx`
 * so the tab remains a thin coordinator while this component owns its own
 * fresh-login `AbortController`, provider buttons, and last-provider guard.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { LinkIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { BrandIcon, hasBrandIcon } from "@/components/icons/brand-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { captureAccountScope } from "@/lib/accounts/active-account-id"
import { readCloudSessionState } from "@/lib/identity/cloud-session"
import {
  isOfficialIssuer,
  type OfficialDeployment,
  type OfficialSocialProvider,
} from "@/lib/identity/official-deployment"
import {
  OfficialIdentityLinkError,
  linkOfficialIdentity,
  readOfficialLinkedIdentities,
  unlinkOfficialIdentity,
  type OfficialLinkedIdentitiesState,
} from "@/lib/identity/official-linked-identities"
import { LogtoSignInCancelled } from "@/lib/logto/capacitor-drivers"
import type { LogtoSession } from "@/lib/logto/client"
import { platformSignInDrivers } from "@/lib/logto/platform-drivers"
import { decodeJwtPayload, stringClaim } from "@/lib/security/jwt-payload"

export interface OfficialLinkedIdentitiesDeps {
  read?: typeof readOfficialLinkedIdentities
  link?: typeof linkOfficialIdentity
  unlink?: typeof unlinkOfficialIdentity
  drivers?: typeof platformSignInDrivers
  resolveSession?: () => Promise<LogtoSession | null>
}

export interface OfficialLinkedIdentitiesProps {
  deployment: OfficialDeployment
  session: LogtoSession
  localAccountId?: string
  onChanged?: () => void
  deps?: OfficialLinkedIdentitiesDeps
}

type Phase =
  | { kind: "idle" }
  | { kind: "reauthenticating"; provider: OfficialSocialProvider; action: "link" | "unlink" }
  | { kind: "awaiting-provider"; provider: OfficialSocialProvider }

function isCancelled(cause: unknown): boolean {
  return (
    cause instanceof LogtoSignInCancelled ||
    (cause instanceof OfficialIdentityLinkError && cause.code === "cancelled") ||
    (cause instanceof Error && cause.name === "AbortError")
  )
}

export function OfficialLinkedIdentities({
  deployment,
  session,
  localAccountId,
  onChanged,
  deps = {},
}: OfficialLinkedIdentitiesProps) {
  const t = useTranslations("account.identity.linkedManage")
  const tProvider = useTranslations("account.cloud.provider")
  const [state, setState] = useState<OfficialLinkedIdentitiesState | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const activeAbortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const depsRef = useRef(deps)
  useEffect(() => {
    depsRef.current = deps
  })

  const providerLabel = useCallback(
    (provider: OfficialSocialProvider): string =>
      tProvider.has(provider) ? tProvider(provider) : provider,
    [tProvider]
  )

  const resolveActiveSession = useCallback(async (): Promise<LogtoSession> => {
    if (depsRef.current.resolveSession) {
      const fresh = await depsRef.current.resolveSession()
      if (!fresh) throw new OfficialIdentityLinkError("unauthorized", "session expired")
      return fresh
    }
    if (!localAccountId) return session
    const currentState = await readCloudSessionState({ localAccountId })
    if (
      currentState.status === "active" &&
      isOfficialIssuer(currentState.session.issuer, deployment)
    ) {
      return currentState.session
    }
    throw new OfficialIdentityLinkError("unauthorized", "session expired")
  }, [deployment, localAccountId, session])

  const explain = useCallback(
    (cause: unknown, provider?: OfficialSocialProvider): string => {
      const label = provider ? providerLabel(provider) : ""
      if (cause instanceof OfficialIdentityLinkError) {
        if (cause.code === "different-person") return t("error.differentPerson")
        if (cause.code === "stale-sign-in") return t("error.staleSignIn")
        if (cause.code === "unauthorized") return t("error.unauthorized")
        if (cause.code === "last-identity") return t("error.lastIdentity")
        if (cause.code === "identity-already-linked") {
          return t("error.alreadyLinked", { provider: label })
        }
        if (cause.code === "provider-already-linked") {
          return t("error.providerAlreadyLinked", { provider: label })
        }
        if (cause.code === "provider-unavailable") {
          return t("error.unavailable", { provider: label })
        }
        if (cause.code === "expired") return t("error.expired")
      }
      return t("error.generic", { message: cause instanceof Error ? cause.message : String(cause) })
    },
    [providerLabel, t]
  )
  const explainRef = useRef(explain)
  useEffect(() => {
    explainRef.current = explain
  })

  const load = useCallback(async () => {
    setReadError(null)
    try {
      const activeSession = await resolveActiveSession()
      const next = await (depsRef.current.read ?? readOfficialLinkedIdentities)(activeSession)
      if (!mountedRef.current) return
      setState(next)
    } catch (cause) {
      if (!mountedRef.current) return
      setState(null)
      setReadError(explainRef.current(cause))
    }
  }, [resolveActiveSession])

  useEffect(() => {
    mountedRef.current = true
    queueMicrotask(() => void load())
    return () => {
      mountedRef.current = false
      activeAbortRef.current?.abort()
    }
  }, [load])

  const stop = () => {
    const current = activeAbortRef.current
    activeAbortRef.current = null
    current?.abort()
    setPhase({ kind: "idle" })
  }

  const runLink = async (provider: OfficialSocialProvider) => {
    const controller = new AbortController()
    activeAbortRef.current = controller
    const assertProfileScope = localAccountId ? captureAccountScope(localAccountId) : null
    const { drivers, redirectUri, clientKind } = (depsRef.current.drivers ?? platformSignInDrivers)(
      { issuerKind: deployment.issuerKind, signal: controller.signal }
    )
    setPhase({ kind: "reauthenticating", provider, action: "link" })
    try {
      const activeSession = await resolveActiveSession()
      const next = await (depsRef.current.link ?? linkOfficialIdentity)(
        deployment,
        drivers,
        { redirectUri, clientKind },
        activeSession,
        provider,
        {
          signal: controller.signal,
          assertActive: async (expectedSub) => {
            assertProfileScope?.()
            if (!mountedRef.current) {
              throw Object.assign(new Error("unmounted"), { name: "AbortError" })
            }
            const latest = await resolveActiveSession()
            if (stringClaim(decodeJwtPayload(latest.accessToken), "sub") !== expectedSub) {
              throw new OfficialIdentityLinkError("unauthorized", "session changed")
            }
          },
          onAwaitingProvider: () => {
            if (mountedRef.current) setPhase({ kind: "awaiting-provider", provider })
          },
        }
      )
      if (!mountedRef.current) return
      setState(next)
      setPhase({ kind: "idle" })
      toast.success(t("added", { provider: providerLabel(provider) }))
      onChanged?.()
    } catch (cause) {
      drivers.abandon?.()
      if (!mountedRef.current) return
      setPhase({ kind: "idle" })
      if (!isCancelled(cause)) toast.error(explain(cause, provider))
    } finally {
      if (activeAbortRef.current === controller) activeAbortRef.current = null
    }
  }

  const runUnlink = async (provider: OfficialSocialProvider) => {
    const controller = new AbortController()
    activeAbortRef.current = controller
    const assertProfileScope = localAccountId ? captureAccountScope(localAccountId) : null
    const { drivers, redirectUri, clientKind } = (depsRef.current.drivers ?? platformSignInDrivers)(
      { issuerKind: deployment.issuerKind, signal: controller.signal }
    )
    setPhase({ kind: "reauthenticating", provider, action: "unlink" })
    try {
      const activeSession = await resolveActiveSession()
      const next = await (depsRef.current.unlink ?? unlinkOfficialIdentity)(
        deployment,
        drivers,
        { redirectUri, clientKind },
        activeSession,
        provider,
        {
          signal: controller.signal,
          assertActive: async (expectedSub) => {
            assertProfileScope?.()
            if (!mountedRef.current) {
              throw Object.assign(new Error("unmounted"), { name: "AbortError" })
            }
            const latest = await resolveActiveSession()
            if (stringClaim(decodeJwtPayload(latest.accessToken), "sub") !== expectedSub) {
              throw new OfficialIdentityLinkError("unauthorized", "session changed")
            }
          },
        }
      )
      if (!mountedRef.current) return
      setState(next)
      setPhase({ kind: "idle" })
      toast.success(t("removed", { provider: providerLabel(provider) }))
      onChanged?.()
    } catch (cause) {
      drivers.abandon?.()
      if (!mountedRef.current) return
      setPhase({ kind: "idle" })
      if (!isCancelled(cause)) toast.error(explain(cause, provider))
      void load()
    } finally {
      if (activeAbortRef.current === controller) activeAbortRef.current = null
    }
  }

  const busy = phase.kind !== "idle"
  const linkedSet = new Set(state?.identities.map((item) => item.providerId) ?? [])
  const addableProviders = (state?.availableProviders ?? []).filter(
    (provider) => !linkedSet.has(provider)
  )

  return (
    <section
      className="flex flex-col gap-2.5 border-t pt-4"
      data-testid="official-linked-identities"
      data-busy={busy ? "true" : "false"}
    >
      <div className="flex flex-col gap-0.5">
        <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <LinkIcon className="size-3.5" aria-hidden />
          {t("title")}
        </h4>
        <p className="text-[11px] text-muted-foreground">{t("description")}</p>
      </div>

      {readError ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-xs text-destructive">
            {readError}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => void load()}
            data-testid="official-linked-identities-retry"
          >
            {t("retry")}
          </Button>
        </div>
      ) : state === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Spinner className="size-3" />
          {t("loading")}
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5" data-testid="official-linked-identities-list">
            {state.identities.map((item) => (
              <li
                key={`${item.providerId}:${item.identity.subject}`}
                className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm"
                data-testid={`official-linked-provider-${item.providerId}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {hasBrandIcon(item.providerId) ? (
                    <BrandIcon id={item.providerId} size={16} />
                  ) : null}
                  <span className="truncate font-medium">{providerLabel(item.providerId)}</span>
                </span>
                {state.canUnlink ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void runUnlink(item.providerId)}
                    data-testid={`official-unlink-${item.providerId}`}
                  >
                    <Trash2Icon data-icon="inline-start" />
                    {t("remove")}
                  </Button>
                ) : (
                  <Badge variant="secondary" data-testid="official-only-method-badge">
                    {t("onlyMethodBadge")}
                  </Badge>
                )}
              </li>
            ))}
          </ul>

          {!state.canUnlink ? (
            <p
              className="text-[11px] text-muted-foreground"
              data-testid="official-last-method-hint"
            >
              {t("lastMethodHint")}
            </p>
          ) : null}

          {phase.kind !== "idle" ? (
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              role="status"
              data-testid="official-linked-identities-pending"
            >
              <Spinner className="size-3" />
              <span>
                {phase.kind === "reauthenticating"
                  ? t("awaitingReauth")
                  : t("awaitingProvider", { provider: providerLabel(phase.provider) })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={stop}
                data-testid="official-linked-identities-stop"
              >
                {t("stop")}
              </Button>
            </div>
          ) : addableProviders.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" data-testid="official-addable-providers">
              {addableProviders.map((provider) => (
                <Button
                  key={provider}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void runLink(provider)}
                  data-testid={`official-link-${provider}`}
                >
                  {hasBrandIcon(provider) ? (
                    <BrandIcon id={provider} size={14} />
                  ) : (
                    <PlusIcon data-icon="inline-start" />
                  )}
                  {t("add", { provider: providerLabel(provider) })}
                </Button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

export default OfficialLinkedIdentities
