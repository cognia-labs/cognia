"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import type { ToolUIPart } from "ai"
import type { AcceptanceProposal } from "@/lib/claude/acceptance-builtin-tools"
import { requestAcceptancePanel } from "@/lib/automation/managed-desktop-acceptance-request"
import { validManagedDesktopCriteria } from "@/lib/automation/managed-desktop-handoff-client"
import { deviceConsoleHref } from "@/lib/devices/device-console-href"
import { Button } from "@/components/ui/button"
import { useParsedOutput } from "./common"

export function AcceptanceProposalCard({ part }: { part: ToolUIPart; sessionId?: string }) {
  const t = useTranslations("managedAcceptance.proposal")
  const router = useRouter()
  const [error, setError] = useState(false)
  const output = useParsedOutput<{ ok?: boolean; proposal?: AcceptanceProposal }>(part.output)
  const proposal = output?.ok ? output.proposal : undefined
  if (
    !proposal?.delivery ||
    typeof proposal.delivery.id !== "string" ||
    !proposal.delivery.id.trim() ||
    typeof proposal.delivery.branch !== "string" ||
    typeof proposal.delivery.commit !== "string" ||
    !validManagedDesktopCriteria(proposal.criteria) ||
    (proposal.summary !== undefined && typeof proposal.summary !== "string")
  )
    return null
  const estimate = proposal.estimate
  const knownPrice =
    estimate &&
    typeof estimate.currency === "string" &&
    Number.isSafeInteger(estimate.hourlyRateMicros) &&
    estimate.hourlyRateMicros >= 0
  return (
    <section aria-label={t("title")} className="space-y-2 rounded-lg border p-3 text-sm">
      <h4 className="font-medium">{t("title")}</h4>
      <p className="break-words">
        {t("delivery", {
          id: proposal.delivery.id,
          branch: proposal.delivery.branch,
          commit: proposal.delivery.commit,
        })}
      </p>
      {proposal.summary ? <p>{proposal.summary}</p> : null}
      <ol className="list-inside list-decimal space-y-1">
        {proposal.criteria.map((row, index) => (
          <li key={index}>
            {row.description}{" "}
            <span className="text-xs text-muted-foreground">
              ({t(row.screenshotRequired ? "required" : "optional")})
            </span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        {knownPrice
          ? t("estimate", {
              cost: `${estimate.currency} ${(estimate.hourlyRateMicros / 1_000_000).toFixed(4)}`,
            })
          : t("estimateUnavailable")}
      </p>
      <p className="text-xs">{t("cost")}</p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          try {
            requestAcceptancePanel({
              deliveryId: proposal.delivery.id,
              criteria: proposal.criteria,
            })
            // The existing handoff settings live in the device console's sandbox section.
            router.push(deviceConsoleHref("local", "sandbox"))
          } catch {
            setError(true)
          }
        }}
      >
        {t("open")}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t("openFailed")}
        </p>
      ) : null}
    </section>
  )
}
