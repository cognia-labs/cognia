"use client"

/**
 * `(readiness) => sentence`: why a Python plugin's environment is in the state
 * the Host reported (ENV01, ADR-0258 §2), for the environment badge's tooltip
 * and the detail page's environment section.
 */

import { useCallback } from "react"
import { useFormatter, useTranslations } from "next-intl"

import type { PythonReadiness } from "@/lib/plugin/python/readiness"

const USER_MANAGED_KEY = {
  "venv-disabled": "venvDisabled",
  "interpreter-override": "interpreterOverride",
  "custom-installer": "customInstaller",
} as const

export function usePythonReadinessText(): (readiness: PythonReadiness) => string {
  const t = useTranslations("plugins.pythonEnvironment.state")
  const format = useFormatter()
  return useCallback(
    (readiness: PythonReadiness) => {
      switch (readiness.state) {
        case "not-required":
          return t("notRequired")
        case "not-prepared":
          return t("notPrepared", { installer: readiness.installer })
        case "stale":
          return t("stale", {
            reasons: format.list(
              readiness.reasons.map((reason) => t(`staleReason.${reason}`)),
              { type: "conjunction" }
            ),
          })
        case "preparing":
          return t("preparing", { installer: readiness.installer })
        case "ready":
          return t("ready", { scope: readiness.scope, installer: readiness.installer })
        case "failed":
          return t("failed", { message: readiness.message })
        case "user-managed":
          return t(`userManaged.${USER_MANAGED_KEY[readiness.reason]}`)
      }
    },
    [t, format]
  )
}
