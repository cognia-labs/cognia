"use client"

/**
 * Remote document providers settings card (ADR-0134).
 *
 * Two providers, two very different setup stories, which is the whole reason
 * this card exists rather than a row in a generic list:
 *
 *   - Feishu borrows the credentials of configured Lark connector instances.
 *     The card reports configuration and document search consent separately
 *     and points at the existing adapter controls. A second Feishu connection
 *     here would be a second thing to keep in sync and a second thing to
 *     revoke.
 *   - Google needs the user's own Google Cloud "Desktop app" credential,
 *     because the read scopes this feature requires cannot be obtained through
 *     the device-code flow the Drive *backup* connection uses.
 *
 * Off the desktop shell the rows stay rendered and go inert, and each says why
 * (project rule 7, UI axis). They used to be replaced wholesale by a single
 * "Desktop app only." line, which told a paired phone nothing about the
 * desktop sitting next to it that already holds both accounts. The reasoning
 * now comes from `lib/docs-providers/reach.ts` and reads out through
 * `DocsProviderNotice`.
 */

import { useDocsProvidersRevision } from "@/hooks/chat/use-docs-providers"
import { useCallback, useEffect, useState, useRef } from "react"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { toast } from "sonner"
import { CloudIcon, ExternalLinkIcon } from "lucide-react"
import { DeviceAuthorizationDialog } from "@/components/plugins/auth/device-authorization-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Field, FieldContent, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  DocsProviderNotice,
  useDocsProviderReach,
} from "@/components/docs-providers/docs-provider-notice"
import { openUrl } from "@/lib/native/opener"
import { connectionsHref } from "@/lib/settings/deep-link"
import { DocsProviderError } from "@/lib/docs-providers"
import { larkDocsProvider } from "@/lib/docs-providers/providers/lark"
import { googleDocsProvider } from "@/lib/docs-providers/providers/google"
import { listDocsProviders } from "@/lib/docs-providers/registry"
import type { DocsProvider, DocsProviderAccount } from "@/lib/docs-providers/types"
import {
  GOOGLE_DOCS_SCOPES,
  getGoogleDocsSettings,
  subscribeGoogleDocsSettings,
  saveGoogleClientSecret,
  clearGoogleClientSecret,
  updateGoogleDocsSettings,
} from "@/lib/docs-providers/providers/google/config"
import {
  beginGoogleDocsAuth,
  disconnectGoogleDocs,
} from "@/lib/docs-providers/providers/google/auth"
import {
  googleState,
  subscribeGoogleStateChanged,
  type GoogleStateReply,
} from "@/lib/docs-providers/providers/google/state"
import { listGoogleConnections } from "@/lib/auth-providers/google/host-auth"
import {
  getHostConnectionDriver,
  type HostDeviceAuthorization,
} from "@/lib/plugin/auth/connection-manager"
import type { AuthConnectionRow } from "@/lib/db/auth-connections"

export function DocsProvidersCard() {
  useDocsProvidersRevision()
  const providers = listDocsProviders().filter(
    (provider) => provider.id !== "lark" && provider.id !== "google"
  )
  const t = useTranslations("docsProviders")

  return (
    <Card data-testid="docs-providers-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <CloudIcon className="size-4" />
          {t("settings.title")}
        </CardTitle>
        <p className="text-muted-foreground text-xs">{t("settings.description")}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        <LarkDocsRow />
        <GoogleDocsRow />
        {providers.map((provider) => (
          <ContributedDocsRow key={provider.id} provider={provider} />
        ))}
      </CardContent>
    </Card>
  )
}

/**
 * Header line shared by both rows: name, its `@` namespace, and a status badge
 * pushed to the end. Identical markup in two places was how the Google row
 * grew a status badge that the Feishu row never got.
 */
function ProviderHeading({
  name,
  mentionPrefix,
  status,
  statusTone,
  testId,
}: {
  name: string
  mentionPrefix: string
  status: string | null
  statusTone: "connected" | "idle"
  testId: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium">{name}</span>
      <Badge variant="secondary" className="font-mono text-[10px]">
        @{mentionPrefix}
      </Badge>
      {status ? (
        <Badge
          variant={statusTone === "connected" ? "default" : "outline"}
          className="ml-auto text-[10px]"
          data-testid={testId}
        >
          {status}
        </Badge>
      ) : null}
    </div>
  )
}

function LarkDocsRow() {
  const t = useTranslations("docsProviders")
  const reach = useDocsProviderReach(larkDocsProvider)
  const [count, setCount] = useState<number | null>(null)
  const [searchCount, setSearchCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    let version = 0
    const reload = () => {
      const attempt = ++version
      void larkDocsProvider
        .listAccounts({
          credentialContext: reach.available ? { localAuthorization: LOCAL_PERSON_RUN } : undefined,
        })
        .then((accounts) => {
          if (!cancelled && attempt === version) {
            setCount(accounts.length)
            setSearchCount(accounts.filter((account) => account.searchable).length)
          }
        })
        .catch(() => {
          if (!cancelled && attempt === version) {
            setCount(0)
            setSearchCount(0)
          }
        })
    }
    const stop = larkDocsProvider.subscribeAccounts?.(reload)
    reload()
    return () => {
      cancelled = true
      stop?.()
    }
  }, [reach.available])

  return (
    <section className="space-y-1.5" data-testid="docs-provider-lark">
      <ProviderHeading
        name={t("label")}
        mentionPrefix={larkDocsProvider.mentionPrefix}
        status={
          count === null
            ? null
            : count === 0
              ? t("settings.larkNoAccount")
              : t("settings.larkReadiness", { count, searchCount })
        }
        statusTone={count && count > 0 ? "connected" : "idle"}
        testId="docs-provider-lark-status"
      />
      <p className="text-muted-foreground text-xs">{t("settings.larkDescription")}</p>
      {count !== null && count > searchCount && (
        <p className="text-muted-foreground text-xs">{t("settings.larkSearchAuthorization")}</p>
      )}
      <DocsProviderNotice reach={reach} data-testid="docs-provider-lark-notice" />
      {/* The accounts this provider borrows are managed one tab over, and the
       * row used to only describe that rather than offer it. Deep-links to the
       * platform, so an empty adapter list opens the Lark "add" dialog instead
       * of a list with nothing in it. */}
      <Button
        asChild
        variant="outline"
        size="sm"
        className="mt-1"
        data-testid="docs-provider-lark-manage"
      >
        <Link href={connectionsHref({ platform: "lark" })}>
          <ExternalLinkIcon className="size-3.5" />
          {t("settings.larkManage")}
        </Link>
      </Button>
    </section>
  )
}

type GoogleOperation = {
  action: "connect" | "disconnect" | "reauthorize" | "saveSecret" | "clearSecret"
  connectionId?: string
}

function GoogleDocsRow() {
  const t = useTranslations("docsProviders")
  const reach = useDocsProviderReach(googleDocsProvider)
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [connections, setConnections] = useState<AuthConnectionRow[]>([])
  const [snapshot, setSnapshot] = useState<GoogleStateReply | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reloadVersion, setReloadVersion] = useState(0)
  const [authorization, setAuthorization] = useState<HostDeviceAuthorization | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [operation, setOperation] = useState<GoogleOperation | null>(null)
  const busy = operation !== null || authorization !== null
  const inert = !reach.available
  const refresh = useCallback(() => setReloadVersion((version) => version + 1), [])
  const hasClientSecret = Boolean(
    snapshot?.clients.find((client) => client.clientId === clientId.trim())?.hasClientSecret
  )

  useEffect(() => {
    let cancelled = false
    let revision = 0
    const apply = (settings: Awaited<ReturnType<typeof getGoogleDocsSettings>>) => {
      if (!cancelled) setClientId(settings.clientId ?? "")
    }
    const unsubscribe = subscribeGoogleDocsSettings(
      (settings) => {
        ++revision
        apply(settings)
      },
      { localAuthorization: LOCAL_PERSON_RUN }
    )
    const initialRevision = revision
    void getGoogleDocsSettings({ localAuthorization: LOCAL_PERSON_RUN })
      .then((settings) => {
        if (revision === initialRevision) apply(settings)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => subscribeGoogleStateChanged(refresh), [refresh])

  useEffect(() => {
    if (inert) return
    let current = true
    // Reconciliation finishes legacy migration before reading secret metadata.
    void listGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
      .then(
        async (rows) =>
          [
            await googleState({ action: "snapshot" }, { localAuthorization: LOCAL_PERSON_RUN }),
            rows,
          ] as const
      )
      .then(
        ([next, rows]) => {
          if (!current) return
          setSnapshot(next)
          setConnections(
            rows.filter((row) => row.status !== "tombstoned" && row.status !== "revoked")
          )
          setLoadFailed(false)
        },
        () => {
          if (!current) return
          setSnapshot(null)
          setConnections([])
          setLoadFailed(true)
        }
      )
    // A newer Host event invalidates this read before starting another one.
    return () => {
      current = false
    }
  }, [inert, reloadVersion])

  const run = async (
    nextOperation: GoogleOperation,
    action: () => Promise<void>,
    errorKey: "connectFailed" | "disconnectFailed" | "googleSecretSaveFailed"
  ) => {
    setOperation(nextOperation)
    try {
      await action()
      refresh()
    } catch (err) {
      const reason =
        err instanceof DocsProviderError
          ? t(`errors.${err.code}`, err.params ?? {})
          : err instanceof Error
            ? err.message
            : String(err)
      toast.error(t(`settings.${errorKey}`, { reason }))
    } finally {
      setOperation(null)
    }
  }

  const saveSecret = async () => {
    const id = clientId.trim()
    await updateGoogleDocsSettings({ clientId: id }, { localAuthorization: LOCAL_PERSON_RUN })
    await saveGoogleClientSecret(clientSecret.trim(), id)
    setClientSecret("")
  }

  const connect = () =>
    run(
      { action: "connect" },
      async () => {
        const id = clientId.trim()
        await updateGoogleDocsSettings({ clientId: id }, { localAuthorization: LOCAL_PERSON_RUN })
        if (clientSecret.trim()) {
          await saveGoogleClientSecret(clientSecret.trim(), id)
          setClientSecret("")
        }
        const { authorizeUrl } = await beginGoogleDocsAuth({ clientId: id })
        // Google sign-in requires the system browser. Rust completes the exchange.
        await openUrl(authorizeUrl)
      },
      "connectFailed"
    )

  const disconnect = (connection: AuthConnectionRow) =>
    run(
      { action: "disconnect", connectionId: connection.id },
      async () => {
        const outcome = await disconnectGoogleDocs(connection.hostMetadata!.adapterId, {
          localAuthorization: LOCAL_PERSON_RUN,
        })
        if (outcome.revoked) toast.success(t("settings.disconnectRevoked"))
        else if (outcome.reason !== "not-connected")
          toast.warning(
            t("settings.disconnectNotRevoked", {
              reason: outcome.reason ?? t("settings.googleRevokeUnavailable"),
            })
          )
      },
      "disconnectFailed"
    )

  return (
    <section className="space-y-2" data-testid="docs-provider-google">
      <ProviderHeading
        name={t("labelGoogle")}
        mentionPrefix={googleDocsProvider.mentionPrefix}
        status={
          connections.length
            ? t("settings.googleConnectionCount", { count: connections.length })
            : t("settings.notConnected")
        }
        statusTone={
          connections.some((connection) => connection.status === "connected") ? "connected" : "idle"
        }
        testId="docs-provider-google-status"
      />
      <p className="text-muted-foreground text-xs">{t("settings.googleScopes")}</p>
      <ul className="text-muted-foreground list-inside list-disc font-mono text-[10px]">
        {GOOGLE_DOCS_SCOPES.map((scope) => (
          <li key={scope}>{scope.replace("https://www.googleapis.com/auth/", "")}</li>
        ))}
      </ul>
      <DocsProviderNotice reach={reach} data-testid="docs-provider-google-notice" />
      {loadFailed && (
        <p role="alert" className="text-destructive text-xs">
          {t("settings.googleConnectionsFailed")}
        </p>
      )}
      {connections.length > 0 && (
        <ul aria-label={t("settings.googleConnections")} className="space-y-2">
          {connections.map((connection) => {
            const lineage = snapshot?.lineages.find(
              (value) => value.id === connection.hostMetadata?.adapterId
            )
            const disconnecting =
              operation?.action === "disconnect" && operation.connectionId === connection.id
            const reauthorizing =
              operation?.action === "reauthorize" && operation.connectionId === connection.id
            return (
              <li key={connection.id} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="break-all text-xs font-medium">{connection.accountLabel}</span>
                  <Badge variant={connection.status === "connected" ? "default" : "outline"}>
                    {t(`settings.googleConnectionStatus.${connection.status}`)}
                  </Badge>
                </div>
                <p className="text-muted-foreground break-all text-[11px]">
                  {t("settings.googleConnectionClient", { clientId: connection.clientId })}
                </p>
                {lineage?.needsIdentity && (
                  <p className="text-muted-foreground text-xs">
                    {t("settings.googleNeedsIdentity")}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || inert || !connection.hostMetadata}
                    onClick={() =>
                      void run(
                        { action: "reauthorize", connectionId: connection.id },
                        async () => {
                          const result = await getHostConnectionDriver("google")?.reauthorize?.(
                            connection.id,
                            { credentialContext: { localAuthorization: LOCAL_PERSON_RUN } }
                          )
                          if (result) {
                            if (mounted.current) setAuthorization(result)
                            else await result.cancel()
                          }
                        },
                        "connectFailed"
                      )
                    }
                  >
                    {reauthorizing ? t("settings.connecting") : t("settings.googleReauthorize")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || inert || !connection.hostMetadata}
                    onClick={() => void disconnect(connection)}
                  >
                    {disconnecting ? t("settings.disconnecting") : t("settings.disconnect")}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {operation?.action === "disconnect" && (
        <p role="status" className="text-muted-foreground text-xs">
          {t("settings.disconnecting")}
        </p>
      )}
      {authorization && (
        <DeviceAuthorizationDialog
          authorization={authorization}
          onClose={() => {
            setAuthorization(null)
            refresh()
          }}
        />
      )}
      <FieldGroup className="gap-2">
        <Field orientation="horizontal" data-disabled={inert || busy}>
          <FieldLabel htmlFor="docs-google-client-id" className="text-xs">
            {t("settings.googleClientId")}
          </FieldLabel>
          <FieldContent>
            <Input
              id="docs-google-client-id"
              value={clientId}
              onChange={(event) => {
                setClientId(event.target.value)
                setClientSecret("")
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={inert || busy}
            />
          </FieldContent>
        </Field>
        <Field orientation="horizontal" data-disabled={inert || busy}>
          <FieldLabel htmlFor="docs-google-client-secret" className="text-xs">
            {t("settings.googleClientSecret")}
          </FieldLabel>
          <FieldContent>
            <Input
              id="docs-google-client-secret"
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              autoComplete="new-password"
              disabled={inert || busy}
              aria-describedby="docs-google-secret-status"
            />
            <p id="docs-google-secret-status" className="text-muted-foreground text-[11px]">
              {hasClientSecret
                ? t("settings.googleSecretSaved")
                : t("settings.googleSecretWriteOnly")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || inert || !clientId.trim() || !clientSecret.trim()}
                onClick={() =>
                  void run({ action: "saveSecret" }, saveSecret, "googleSecretSaveFailed")
                }
              >
                {t("settings.googleSecretSave")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || inert || !hasClientSecret}
                onClick={() =>
                  void run(
                    { action: "clearSecret" },
                    async () => {
                      await clearGoogleClientSecret(clientId.trim())
                      setClientSecret("")
                    },
                    "googleSecretSaveFailed"
                  )
                }
              >
                {t("settings.googleSecretClear")}
              </Button>
            </div>
          </FieldContent>
        </Field>
      </FieldGroup>
      {snapshot?.migrationNeedsClientId && (
        <p className="text-muted-foreground text-xs">
          {t("settings.googleMigrationNeedsClientId")}
        </p>
      )}
      <p className="text-muted-foreground flex items-center gap-1 text-[11px]">
        <ExternalLinkIcon className="size-3" />
        {t("settings.googleClientHint")}
      </p>
      <Button
        size="sm"
        disabled={busy || inert || !clientId.trim()}
        onClick={() => void connect()}
        data-testid="docs-provider-google-connect"
      >
        {operation?.action === "connect" ? t("settings.connecting") : t("settings.connect")}
      </Button>
    </section>
  )
}

function ContributedDocsRow({ provider }: { provider: DocsProvider }) {
  const t = useTranslations("docsProviders")
  const reach = useDocsProviderReach(provider)
  const [accounts, setAccounts] = useState<DocsProviderAccount[]>([])
  useEffect(() => {
    let active = true
    let revision = 0
    const reload = () => {
      const attempt = ++revision
      void provider.listAccounts().then(
        (next) => {
          if (active && attempt === revision) setAccounts(next)
        },
        () => {
          if (active && attempt === revision) setAccounts([])
        }
      )
    }
    const stop = provider.subscribeAccounts?.(reload)
    reload()
    return () => {
      active = false
      stop?.()
    }
  }, [provider])
  return (
    <section className="space-y-1.5" data-testid={`docs-provider-${provider.id}`}>
      <ProviderHeading
        name={provider.label ?? provider.id}
        mentionPrefix={provider.mentionPrefix}
        status={
          accounts.length
            ? accounts.map((account) => account.label).join(" · ")
            : t("settings.notConnected")
        }
        statusTone={accounts.length ? "connected" : "idle"}
        testId={`docs-provider-${provider.id}-status`}
      />
      <DocsProviderNotice reach={reach} />
    </section>
  )
}
