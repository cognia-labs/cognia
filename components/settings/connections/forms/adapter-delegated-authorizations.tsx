"use client"

/**
 * Whose account this bot's turns use, and who has authorized it
 * (ADR-0243 phase 4, D5 and D9).
 *
 * The lane switch is a person's decision on this Host: each requester acting
 * with their own authorization (`delegated`), or every turn on the app's
 * service credentials (`service`). A paired shell cannot set it. The list is
 * everyone who authorized this bot, each with a revoke that takes effect on
 * that person's next request. Renders only for a platform with per-person
 * authorizations (`delegatedCredentials` on its vendor contribution).
 */

import { useLiveQuery } from "dexie-react-hooks"
import { useFormatter, useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { DelegatedAuthorization } from "@/lib/connectors/vendor-contribution"
import { connectorVendor } from "@/lib/connectors/vendor-contribution"
import { forgetAuthorizationOffer } from "@/lib/connectors/delegated-authorization"
import { hostAdapterInstanceWriter } from "@/lib/db/adapter-instance-remote-writer"
import { setAdapterCredentialLane } from "@/lib/db/adapter-instances"
import { getDb } from "@/lib/db/schema"
import { principalKey } from "@cognia/plugin-contract/types/execution/acting-identity"

export function AdapterDelegatedAuthorizations({ adapterId }: { adapterId: string }) {
  const t = useTranslations("settings.connections.delegatedAuthorizations")
  const format = useFormatter()
  const row = useLiveQuery(
    async () =>
      typeof window === "undefined" ? undefined : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
  const credentials = row ? connectorVendor(row.type)?.delegatedCredentials : undefined
  const [people, setPeople] = useState<DelegatedAuthorization[] | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  useEffect(() => {
    if (!row || !credentials) return
    let current = true
    void credentials.list(row).then((list) => {
      if (current) setPeople(list)
    })
    return () => {
      current = false
    }
  }, [row, credentials])

  if (!row || !credentials) return null
  const remote = hostAdapterInstanceWriter() !== null
  const delegated = row.credentialLane !== "service"

  const setLane = async (next: boolean) => {
    try {
      await setAdapterCredentialLane(row.id, next ? "delegated" : "service")
      toast.success(t("laneSaved"))
    } catch (error) {
      toast.error(
        t("laneFailed", { reason: error instanceof Error ? error.message : String(error) })
      )
    }
  }

  const revoke = async (entry: DelegatedAuthorization) => {
    const key = principalKey(entry.person)
    setRevoking(key)
    try {
      await credentials.revoke(row, entry.person)
      forgetAuthorizationOffer(row.id, entry.person)
      toast.success(t("revoked"))
    } catch (error) {
      toast.error(
        t("revokeFailed", { reason: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setRevoking(null)
    }
  }

  return (
    <Card data-testid="adapter-delegated-authorizations">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor={`delegated-lane-${row.id}`} className="text-xs font-medium">
              {t("laneLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {delegated ? t("laneDelegatedHelp") : t("laneServiceHelp")}
            </p>
            {remote && <p className="text-xs text-muted-foreground">{t("laneHostOnly")}</p>}
          </div>
          <Switch
            id={`delegated-lane-${row.id}`}
            checked={delegated}
            onCheckedChange={(next) => void setLane(next)}
            disabled={remote}
            aria-label={t("laneLabel")}
            data-testid="delegated-lane-switch"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">{t("peopleLabel")}</Label>
          {people === null ? null : people.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="divide-y rounded-md border" data-testid="delegated-people">
              {people.map((entry) => {
                const key = principalKey(entry.person)
                const label =
                  entry.name ?? (entry.person.kind === "platform" ? entry.person.remoteUserId : key)
                return (
                  <li key={key} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{label}</p>
                      {entry.authorizedAt !== undefined && (
                        <p className="text-[11px] text-muted-foreground">
                          {t("authorizedAt", {
                            when: format.dateTime(entry.authorizedAt, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }),
                          })}
                        </p>
                      )}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void revoke(entry)}
                      disabled={revoking === key}
                      aria-label={t("revokeAria", { name: label })}
                    >
                      {t("revoke")}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
          <p className="text-[11px] text-muted-foreground">{t("registryNote")}</p>
        </div>
      </CardContent>
    </Card>
  )
}
