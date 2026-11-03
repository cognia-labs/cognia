"use client"

import Link from "next/link"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useAccountStore } from "@/stores/account/account-store"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import type { RuntimeSupportCell } from "@/lib/external-services/runtime-support"

/** Shared wording and working recovery destinations for every auth surface. */
export function RuntimeSupportNotice({ support }: { support: RuntimeSupportCell }) {
  const t = useTranslations("plugins.auth.runtimeSupport")
  const [failed, setFailed] = useState(false)
  // Re-render when the account (and so its Browser Vault) unlocks or locks.
  useAccountStore((state) => state.unlockedAccountId)
  // The matrix says what this runtime can do; the vault state says whether the
  // condition is already met. An unlocked vault persists secrets, and its
  // "unlock" action would only lock the account and drop the open form.
  if (support.reason === "non-persistent-until-vault-unlock" && getActiveBrowserVault() !== null)
    return null
  if (support.availability === "supported" && support.recovery.length === 0) return null
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>{t(`reasons.${support.reason}`)}</p>
      <div className="flex flex-wrap items-center gap-2">
        {support.recovery.map((action) =>
          action === "pair-with-desktop" ? (
            <Button key={action} asChild variant="outline" size="sm">
              <Link href="/pair">{t(`recovery.${action}`)}</Link>
            </Button>
          ) : action === "unlock-vault" ? (
            <Button
              key={action}
              variant="outline"
              size="sm"
              onClick={async () => {
                // AccountGate owns the existing vault/password unlock screen.
                setFailed(false)
                try {
                  await useAccountStore.getState().lock()
                } catch {
                  setFailed(true)
                }
              }}
            >
              {t(`recovery.${action}`)}
            </Button>
          ) : (
            <span key={action}>{t(`recovery.${action}`)}</span>
          )
        )}
      </div>
      {failed && <p role="alert">{t("recoveryFailed")}</p>}
    </div>
  )
}
