"use client"

/**
 * Settings → Account → delete the official Cognia account (ADR-0215 §10).
 *
 * Three states, read from the identity Worker:
 *
 * - nothing pending: "Delete account" opens an inline confirmation that says
 *   what goes (the account and its linked sign-ins, after 7 days) and what
 *   stays (everything on this device), and offers a backup first. Confirming
 *   asks the person to sign in again; the request is made with that fresh
 *   sign-in (`confirmAccountDeletion`).
 * - pending: the purge date, and "Cancel deletion".
 * - the read failed: the reason, and a retry.
 *
 * The local profile is never touched here: deleting it is the Danger tab.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArchiveIcon, Trash2Icon, Undo2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { captureAccountScope } from "@/lib/accounts/active-account-id"
import { readCloudSessionState } from "@/lib/identity/cloud-session"
import {
  AccountDeletionError,
  DEFAULT_DELETION_COOLING_OFF_DAYS,
  cancelAccountDeletion,
  confirmAccountDeletion,
  readAccountDeletion,
  type OfficialDeletionState,
} from "@/lib/identity/official-account-deletion"
import { isOfficialIssuer, type OfficialDeployment } from "@/lib/identity/official-deployment"
import { platformSignInDrivers } from "@/lib/logto/platform-drivers"
import { LogtoSignInCancelled } from "@/lib/logto/capacitor-drivers"
import { decodeJwtPayload, stringClaim } from "@/lib/security/jwt-payload"

import type { LogtoSession } from "@/lib/logto/client"

export interface OfficialAccountDeletionDeps {
  read?: typeof readAccountDeletion
  cancel?: typeof cancelAccountDeletion
  confirm?: typeof confirmAccountDeletion
  drivers?: typeof platformSignInDrivers
  /** Resolve a fresh bearer session for this profile before API calls. */
  resolveSession?: () => Promise<LogtoSession | null>
}

export interface OfficialAccountDeletionProps {
  deployment: OfficialDeployment
  /** The profile's active official session. */
  session: LogtoSession
  /** Profile owning this session; enables automatic token refresh and scope fencing. */
  localAccountId?: string
  deps?: OfficialAccountDeletionDeps
}

type Phase = "idle" | "confirming" | "awaiting-sign-in" | "working"

function isCancel(cause: unknown): boolean {
  return (
    cause instanceof LogtoSignInCancelled || (cause instanceof Error && cause.name === "AbortError")
  )
}

export function OfficialAccountDeletion({
  deployment,
  session,
  localAccountId,
  deps = {},
}: OfficialAccountDeletionProps) {
  const t = useTranslations("account.identity.deletion")
  const [state, setState] = useState<OfficialDeletionState | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const signInWait = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const phaseRef = useRef<Phase>("idle")
  const depsRef = useRef(deps)
  useEffect(() => {
    depsRef.current = deps
    phaseRef.current = phase
  })

  const resolveActiveSession = useCallback(async (): Promise<LogtoSession> => {
    if (depsRef.current.resolveSession) {
      const fresh = await depsRef.current.resolveSession()
      if (!fresh) throw new AccountDeletionError("unauthorized", "session expired")
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
    throw new AccountDeletionError("unauthorized", "session expired")
  }, [deployment, localAccountId, session])

  const explain = useCallback(
    (cause: unknown): string => {
      if (cause instanceof AccountDeletionError) {
        if (cause.code === "different-person") return t("error.differentPerson")
        if (cause.code === "stale-sign-in") return t("error.staleSignIn")
        if (cause.code === "unauthorized") return t("error.unauthorized")
      }
      return t("error.generic", { message: cause instanceof Error ? cause.message : String(cause) })
    },
    [t]
  )

  // Read once per session: the translator takes a new identity on renders,
  // and a read that followed it would undo every state change it reports.
  const explainRef = useRef(explain)
  useEffect(() => {
    explainRef.current = explain
  })
  const load = useCallback(async () => {
    setReadError(null)
    try {
      const activeSession = await resolveActiveSession()
      const next = await (depsRef.current.read ?? readAccountDeletion)(activeSession)
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
    const refreshOnFocus = () => {
      if (document.visibilityState === "hidden") return
      if (phaseRef.current === "awaiting-sign-in" || phaseRef.current === "working") return
      void load()
    }
    window.addEventListener("focus", refreshOnFocus)
    document.addEventListener("visibilitychange", refreshOnFocus)
    return () => {
      mountedRef.current = false
      window.removeEventListener("focus", refreshOnFocus)
      document.removeEventListener("visibilitychange", refreshOnFocus)
      signInWait.current?.abort()
    }
  }, [load])

  const stopSignInWait = () => {
    const active = signInWait.current
    signInWait.current = null
    active?.abort()
    setPhase("confirming")
  }

  const confirm = async () => {
    const controller = new AbortController()
    signInWait.current = controller
    const assertProfileScope = localAccountId ? captureAccountScope(localAccountId) : null
    const { drivers, redirectUri, clientKind } = (depsRef.current.drivers ?? platformSignInDrivers)(
      { issuerKind: deployment.issuerKind, signal: controller.signal }
    )
    setPhase("awaiting-sign-in")
    try {
      const activeSession = await resolveActiveSession()
      const next = await (depsRef.current.confirm ?? confirmAccountDeletion)(
        deployment,
        drivers,
        { redirectUri, clientKind },
        activeSession,
        {
          signal: controller.signal,
          assertActive: async (expectedSub) => {
            assertProfileScope?.()
            if (!mountedRef.current) {
              const aborted = new Error("Account deletion confirmation unmounted")
              aborted.name = "AbortError"
              throw aborted
            }
            const latest = await resolveActiveSession()
            if (stringClaim(decodeJwtPayload(latest.accessToken), "sub") !== expectedSub) {
              throw new AccountDeletionError(
                "unauthorized",
                "the profile session changed while confirming deletion"
              )
            }
          },
          onSubmitting: () => {
            if (mountedRef.current) setPhase("working")
          },
        }
      )
      if (!mountedRef.current) return
      setState(next)
      setPhase("idle")
      if (next.status === "pending") {
        toast.success(t("requested"))
      } else {
        toast.error(t("error.notScheduled"))
      }
    } catch (cause) {
      drivers.abandon?.()
      if (!mountedRef.current) return
      setPhase("confirming")
      if (!isCancel(cause)) toast.error(explain(cause))
    } finally {
      if (signInWait.current === controller) {
        signInWait.current = null
      }
    }
  }

  const cancelDeletion = async () => {
    setPhase("working")
    try {
      const activeSession = await resolveActiveSession()
      const next = await (depsRef.current.cancel ?? cancelAccountDeletion)(activeSession)
      if (!mountedRef.current) return
      setState(next)
      if (next.status === "cancelled") {
        toast.success(t("cancelled"))
      } else if (next.status === "none") {
        toast.error(t("error.nothingToCancel"))
      } else {
        toast.error(t("error.stillPending"))
      }
    } catch (cause) {
      if (!mountedRef.current) return
      toast.error(explain(cause))
    } finally {
      if (mountedRef.current) setPhase("idle")
    }
  }

  const coolingOffDays = state?.coolingOffDays ?? DEFAULT_DELETION_COOLING_OFF_DAYS

  return (
    <section
      className="flex flex-col gap-2 border-t pt-4"
      data-testid="official-account-deletion"
      data-status={state?.status ?? (readError ? "error" : "loading")}
    >
      <h4 className="text-xs font-medium text-muted-foreground">{t("title")}</h4>

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
            data-testid="official-account-deletion-retry"
          >
            {t("retry")}
          </Button>
        </div>
      ) : state === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Spinner className="size-3" />
          {t("loading")}
        </p>
      ) : state.status === "pending" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm" data-testid="official-account-deletion-pending">
            {state.purgeAfter
              ? t("pending", { date: new Date(state.purgeAfter).toLocaleString() })
              : t("pendingNoDate")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            disabled={phase === "working"}
            onClick={() => void cancelDeletion()}
            data-testid="official-account-deletion-cancel"
          >
            <Undo2Icon data-icon="inline-start" />
            {t("cancel")}
          </Button>
        </div>
      ) : phase === "idle" ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {t("description", { days: coolingOffDays })}
          </p>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="self-start"
            onClick={() => setPhase("confirming")}
            data-testid="official-account-deletion-start"
          >
            <Trash2Icon data-icon="inline-start" />
            {t("delete")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2" data-testid="official-account-deletion-confirm">
          <p className="text-sm">{t("confirmBody", { days: coolingOffDays })}</p>
          <p className="text-xs text-muted-foreground">{t("confirmLocal")}</p>
          <Button asChild size="sm" variant="outline" className="self-start">
            <Link href="/me/backup" data-testid="official-account-deletion-backup">
              <ArchiveIcon data-icon="inline-start" />
              {t("backupFirst")}
            </Link>
          </Button>
          {phase === "awaiting-sign-in" ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Spinner className="size-3" />
              {t("awaitingSignIn")}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={stopSignInWait}
                data-testid="official-account-deletion-stop"
              >
                {t("stop")}
              </Button>
            </div>
          ) : phase === "working" ? (
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              role="status"
              data-testid="official-account-deletion-submitting"
            >
              <Spinner className="size-3" />
              {t("submitting")}
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => void confirm()}
                data-testid="official-account-deletion-confirm-button"
              >
                {t("confirm")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setPhase("idle")}
                data-testid="official-account-deletion-back"
              >
                {t("back")}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default OfficialAccountDeletion
