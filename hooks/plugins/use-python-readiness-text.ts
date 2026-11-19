"use client"

/**
 * `(readiness) => sentence`: why a Python plugin's environment is in the state
 * the Host reported (ENV01, ADR-0258 §2), for the environment badge's tooltip,
 * the detail page's environment section and the failed-preparation toast. A
 * failure whose cause the Host named (ENV02: an out-of-date lock, missing
 * bundled wheels) is worded from the cause rather than the installer's text.
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
        case "needs-uv":
          return t("needsUv")
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
          if (readiness.cause?.kind === "lock-out-of-date") return t("failedCause.lockOutOfDate")
          if (readiness.cause?.kind === "missing-wheels") {
            return t("failedCause.missingWheels", {
              packages: format.list(readiness.cause.packages, { type: "conjunction" }),
            })
          }
          return t("failed", { message: readiness.message })
        case "user-managed":
          return t(`userManaged.${USER_MANAGED_KEY[readiness.reason]}`)
      }
    },
    [t, format]
  )
}
