"use client"

/**
 * The Identity tab of the account manager: who this profile is on the shared
 * deployment, which organization it works in, and the organizations it could
 * switch to. ADR-0149 section 9.
 *
 * Reads the same cloud session state the settings card reads, and switches
 * organizations through the same `adoptOrganization` the sign-in gate uses,
 * so there is one way to change standing and it is tested once.
 *
 * # The official account
 *
 * When discovery offers the official Cognia account (ADR-0215 §2) the tab is
 * personal: the person, the sign-ins the issuer linked to them, the session,
 * and the account's deletion. There is no organization. "Sign in" asks the
 * gate for its screen (`sign-in-request.ts`) instead of reloading, and the
 * deployment card below names a self-hosted gateway that would replace it.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CloudIcon, LogInIcon, LogOutIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { type CollabAccountMembership } from "@/lib/collab/client"
import { sessionMatchesDeployment, type CloudSessionState } from "@/lib/identity/cloud-session"
import { completeSignOut } from "@/lib/identity/complete-sign-in"
import { type DeploymentDiscovery } from "@/lib/identity/deployment-discovery"
import { issuerIdentities } from "@/lib/identity/issuer-identities"
import { isOfficialIssuer } from "@/lib/identity/official-deployment"
import { externalProviderFor } from "@/lib/identity/link-signed-in-identities"
import {
  loadOrgSwitchSnapshot,
  switchOrganization,
  type OrgSwitchDeps,
  type OrgSwitchSnapshot,
} from "@/lib/identity/org-switch"
import { requestCloudSignIn } from "@/lib/identity/sign-in-request"
import {
  signOutFromLogto,
  signOutLeftTokensLive,
  signOutRevocationWarning,
  type LogtoSignOutRevocationWarning,
} from "@/lib/logto/app-session"
import { tryOpenUrl } from "@/lib/native/opener"
import { forgetOfflineChoice } from "@/components/account/cloud-sign-in-gate"
import { CloudDeploymentCard } from "@/components/settings/companion/cloud-deployment-card"
import { OfficialAccountDeletion } from "@/components/account/manage/official-account-deletion"
import { AccountSyncSection } from "@/components/account/sync/account-sync-section"
import { useAccountStore } from "@/stores/account/account-store"

import type { LocalAccountRecord } from "@/lib/accounts/account-types"

export interface AccountIdentityTabDeps extends OrgSwitchDeps {
  signOut?: (localAccountId: string) => Promise<{
    endSessionUrl?: string | null
    endSessionOpened?: boolean
    tokensLive: boolean
    revocationWarning?: LogtoSignOutRevocationWarning | null
  }>
  reload?: () => void
  /** Ask the gate for its sign-in screen. Defaults to the request bus. */
  requestSignIn?: (localAccountId: string) => void
}

export interface AccountIdentityTabProps {
  account: LocalAccountRecord
  deps?: AccountIdentityTabDeps
}

async function defaultSignOut(localAccountId: string) {
  const report = await signOutFromLogto({
    localAccountId,
    afterClear: (context) => completeSignOut({ localAccountId, ...context }),
  })
  return {
    endSessionUrl: report.endSessionUrl ?? null,
    tokensLive: signOutLeftTokensLive(report),
    revocationWarning: signOutRevocationWarning(report),
  }
}

export function AccountIdentityTab({ account, deps = {} }: AccountIdentityTabProps) {
  const t = useTranslations("account.identity")
  const tProvider = useTranslations("account.cloud.provider")
  // The gate serves one profile; it answers sign-in requests for that one only.
  const servedAccountId = useAccountStore(
    (store) => store.unlockedAccountId ?? store.activeAccountId
  )
  const [state, setState] = useState<CloudSessionState | null>(null)
  const [discovery, setDiscovery] = useState<DeploymentDiscovery | null>(null)
  const [memberships, setMemberships] = useState<CollabAccountMembership[] | null>(null)
  const [membershipsError, setMembershipsError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const isServedProfile = !servedAccountId || account.id === servedAccountId
  const depsRef = useRef(deps)
  const snapshotRef = useRef<OrgSwitchSnapshot | null>(null)
  useEffect(() => {
    depsRef.current = deps
  })

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const snapshot = await loadOrgSwitchSnapshot(account.id, depsRef.current)
      snapshotRef.current = snapshot
      setState(snapshot.state)
      setDiscovery(snapshot.discovery)
      setMemberships(snapshot.memberships)
      setMembershipsError(snapshot.membershipsError)
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [account.id])

  useEffect(() => {
    queueMicrotask(() => void load())
  }, [load])

  const switchTo = async (membership: CollabAccountMembership) => {
    if (!isServedProfile) {
      toast.error(t("signInOtherProfile"))
      return
    }
    const snapshot = snapshotRef.current
    if (snapshot?.state.status !== "active" || snapshot.discovery.status !== "ready") return
    setBusy(true)
    try {
      await switchOrganization(snapshot, membership, account.id, {
        ...depsRef.current,
        servedAccountId: () => servedAccountId ?? account.id,
      })
      toast.success(t("switched", { org: membership.orgName }))
      await load()
    } catch (cause) {
      toast.error(
        t("switchFailed", { message: cause instanceof Error ? cause.message : String(cause) })
      )
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    if (!isServedProfile) {
      toast.error(t("signInOtherProfile"))
      return
    }
    setBusy(true)
    try {
      const report = await (depsRef.current.signOut ?? defaultSignOut)(account.id)
      toast.success(t("signOutDone"))
      const warning = report.revocationWarning ?? (report.tokensLive ? "failed" : null)
      if (warning === "failed") toast.warning(t("revocationFailed"))
      else if (warning === "unsupported") toast.warning(t("revocationUnsupported"))
      if (report.endSessionUrl) {
        const opened = report.endSessionOpened ?? (await tryOpenUrl(report.endSessionUrl))
        if (!opened) toast.warning(t("endSessionBlocked"))
      }
      await load()
    } catch (cause) {
      toast.error(
        t("signOutFailed", {
          message: cause instanceof Error ? cause.message : String(cause),
        })
      )
    } finally {
      setBusy(false)
    }
  }

  const signIn = () => {
    if (!isServedProfile) {
      toast.error(t("signInOtherProfile"))
      return
    }
    if (discovery?.status === "official") {
      ;(depsRef.current.requestSignIn ?? requestCloudSignIn)(account.id)
      return
    }
    // The gate decides at boot. Forget the tab's offline choice and let it.
    forgetOfflineChoice(account.id)
    ;(depsRef.current.reload ?? (() => window.location.reload()))()
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-2" role="alert" data-testid="account-identity-load-error">
        <p className="text-xs text-destructive">{t("loadFailed", { message: loadError })}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => void load()}
          data-testid="account-identity-retry"
        >
          {t("retry")}
        </Button>
      </div>
    )
  }

  if (!state || !discovery) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner className="size-4" />
        {t("loading")}
      </div>
    )
  }

  const currentOrgId = state.status === "active" ? state.identity.orgId : undefined
  const official = discovery.status === "official" ? discovery.deployment : null
  const readyMatchesSession =
    discovery.status === "ready" ? sessionMatchesDeployment(state, discovery) : true
  // A session another issuer minted (a deployment since forgotten) is not the
  // official account: no linked sign-ins, and no deletion sent its token.
  const officialSession =
    official && state.status === "active" && isOfficialIssuer(state.session.issuer, official)
      ? state.session
      : null
  const foreignActiveSession =
    state.status === "active" &&
    ((official !== null && officialSession === null) ||
      (discovery.status === "ready" && !readyMatchesSession))
  const canSignOut =
    state.status === "active" || state.status === "offline" || state.status === "error"
  const canSignIn =
    (discovery.status === "ready" || official !== null) &&
    (state.status === "signed-out" ||
      state.status === "reauth-required" ||
      state.status === "error" ||
      foreignActiveSession)
  const linked = officialSession
    ? issuerIdentities(officialSession).map((identity) => {
        const provider = externalProviderFor(identity.provider) ?? identity.provider
        return {
          key: `${identity.provider}:${identity.tenant ?? ""}:${identity.subject}`,
          label: provider === "lark" ? "feishu" : provider,
        }
      })
    : []

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="account-identity-tab"
      data-status={state.status}
    >
      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <CloudIcon className="size-4" aria-hidden />
          {official ? t("officialTitle") : t("title")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {official ? t("officialDescription") : t("description")}
        </p>
      </div>

      {state.status === "active" ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("person")}</dt>
          <dd className="truncate" data-testid="account-identity-person">
            {state.identity.displayName ?? state.identity.email ?? state.identity.userId}
          </dd>
          {officialSession ? (
            <>
              <dt className="text-muted-foreground">{t("linked")}</dt>
              <dd className="text-xs" data-testid="account-identity-linked">
                {linked.length > 0
                  ? linked
                      .map((identity) =>
                        tProvider.has(identity.label) ? tProvider(identity.label) : identity.label
                      )
                      .join(", ")
                  : t("linkedNone")}
              </dd>
            </>
          ) : official ? null : (
            <>
              <dt className="text-muted-foreground">{t("organization")}</dt>
              <dd className="truncate font-mono text-xs" data-testid="account-identity-org">
                {memberships?.find((row) => row.orgId === currentOrgId)?.orgName ??
                  currentOrgId ??
                  t("membershipsEmpty")}
              </dd>
            </>
          )}
          {state.identity.orgRole ? (
            <>
              <dt className="text-muted-foreground">{t("role")}</dt>
              <dd className="text-xs">{t(`roleName.${state.identity.orgRole}`)}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">{t("session")}</dt>
          <dd className="text-xs">
            <Badge variant="secondary">{t("state.active")}</Badge>{" "}
            {state.session.expiresAt
              ? t("sessionExpires", { date: new Date(state.session.expiresAt).toLocaleString() })
              : t("sessionUnknownExpiry")}
          </dd>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="account-identity-signed-out">
          {state.status === "signed-out" ? t("signedOut") : t(`state.${state.status}`)}
        </p>
      )}

      {!isServedProfile ? (
        <p className="text-xs text-muted-foreground" data-testid="account-identity-inactive-notice">
          {t("signInOtherProfile")}
        </p>
      ) : null}

      {foreignActiveSession ? (
        <p className="text-xs text-muted-foreground" data-testid="account-identity-foreign-session">
          {t("foreignSession")}
        </p>
      ) : null}

      {state.status === "active" && !official && readyMatchesSession ? (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">{t("memberships")}</h4>
          {membershipsError ? (
            <p role="alert" className="text-xs text-destructive">
              {t("membershipsFailed", { message: membershipsError })}
            </p>
          ) : memberships === null ? (
            discovery.status === "ready" && discovery.collaborationServiceUrl ? (
              <p className="text-xs text-muted-foreground">{t("membershipsLoading")}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t("noDeployment")}</p>
            )
          ) : memberships.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("membershipsEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {memberships.map((membership) => {
                const current = membership.orgId === currentOrgId
                return (
                  <li
                    key={membership.orgId}
                    className="flex items-center gap-2 text-sm"
                    data-testid={`account-identity-membership-${membership.orgId}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{membership.orgName}</span>
                    {current ? (
                      <Badge variant="secondary">{t("current")}</Badge>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy || !isServedProfile}
                        title={!isServedProfile ? t("signInOtherProfile") : undefined}
                        onClick={() => void switchTo(membership)}
                        data-testid={`account-identity-switch-${membership.orgId}`}
                      >
                        {busy ? t("switching") : t("switch")}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canSignIn ? (
          <Button
            type="button"
            size="sm"
            onClick={signIn}
            disabled={busy || !isServedProfile}
            title={!isServedProfile ? t("signInOtherProfile") : undefined}
            data-testid="account-identity-sign-in"
          >
            <LogInIcon data-icon="inline-start" />
            {t("signIn")}
          </Button>
        ) : null}
        {canSignOut ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !isServedProfile}
            title={!isServedProfile ? t("signInOtherProfile") : undefined}
            onClick={() => void signOut()}
            data-testid="account-identity-sign-out"
          >
            <LogOutIcon data-icon="inline-start" />
            {t("signOut")}
          </Button>
        ) : null}
      </div>

      {isServedProfile && official && officialSession && state.status === "active" ? (
        <AccountSyncSection
          account={state.identity.email ?? state.identity.displayName ?? state.identity.userId}
        />
      ) : null}

      {isServedProfile && official && officialSession ? (
        <OfficialAccountDeletion
          deployment={official}
          session={officialSession}
          localAccountId={account.id}
        />
      ) : null}

      {isServedProfile ? (
        // Naming, changing, or forgetting a self-hosted gateway lives right
        // here for all discovery states so mobile (/me/cloud-account), web, and
        // desktop users can switch between Official and Self-Hosted without
        // hunting another settings page.
        <section className="flex flex-col gap-2" data-testid="account-identity-deployment">
          <h4 className="text-xs font-medium text-muted-foreground">
            {official
              ? t("selfHosted")
              : discovery.status === "ready"
                ? t("deploymentSection")
                : t("noDeployment")}
          </h4>
          <CloudDeploymentCard frame="plain" deps={{ localAccountId: account.id }} />
        </section>
      ) : null}
    </div>
  )
}

export default AccountIdentityTab
