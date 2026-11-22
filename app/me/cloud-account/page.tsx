"use client"

/**
 * Mobile cloud-account route: official Cognia account and self-hosted gateway.
 *
 * When a local profile is active, embeds the shared `AccountIdentityTab` so
 * mobile users get the exact same official Cognia account sign-in, re-sign-in,
 * sign-out, encrypted account sync, account deletion, and self-hosted gateway
 * replacement controls as desktop and web. Falls back to `CloudDeploymentCard`
 * before the profile store hydrates.
 */

import { useTranslations } from "next-intl"

import { AccountIdentityTab } from "@/components/account/manage/account-identity-tab"
import { CloudDeploymentCard } from "@/components/settings/companion/cloud-deployment-card"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { selectActiveAccount, useAccountStore } from "@/stores/account/account-store"

export default function MobileCloudAccountPage() {
  const t = useTranslations("mobile.me")
  const activeAccount = useAccountStore(selectActiveAccount)

  return (
    <SubPageShell
      settingsPanel
      title={t("cloudAccountRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-cloud-account-page"
    >
      {activeAccount ? <AccountIdentityTab account={activeAccount} /> : <CloudDeploymentCard />}
    </SubPageShell>
  )
}
