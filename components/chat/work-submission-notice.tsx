"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertCircleIcon, CloudOffIcon, ClockIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { useWorkSubmissionStatus } from "@/hooks/work-submission/use-work-submission-status"
import { interruptedTurnMayRepeatEffects } from "@/lib/chat/interrupted-turn"

interface Props {
  sessionId: string | undefined
  /**
   * Continue the parked turn from where it stopped. Offered only for a chat
   * turn; when the reason says it may already have had effects, the person
   * confirms first.
   */
  onResume?: () => Promise<void> | void
}

function recoveryBodyKey(errorCode: string | undefined) {
  switch (errorCode) {
    case "observed-tool-activity":
      return "recoveryRequired.reasons.toolActivity"
    case "unconfirmed-attempt":
      return "recoveryRequired.reasons.unconfirmedAttempt"
    case "ambiguous-side-effects":
      return "recoveryRequired.reasons.uncertainEffects"
    case "corrupt-canonical-log":
      return "recoveryRequired.reasons.corruptLog"
    case "unreadable-journal":
      return "recoveryRequired.reasons.unreadableJournal"
    case "no-candidates":
      return "recoveryRequired.reasons.missingHistory"
    case "forked-history":
      return "recoveryRequired.reasons.conflictingHistory"
    case "no-dominant":
      return "recoveryRequired.reasons.ambiguousHistory"
    case "missing_frozen_input":
      return "recoveryRequired.reasons.missingInput"
    case "missing_frozen_context":
    case "missing_frozen_send_options":
      return "recoveryRequired.reasons.incompleteContext"
    case "invalid_frozen_input":
      return "recoveryRequired.reasons.invalidInput"
    case "frozen_payload_unreadable":
      return "recoveryRequired.reasons.unreadablePayload"
    case "frozen_input_digest_mismatch":
    case "frozen_context_digest_mismatch":
      return "recoveryRequired.reasons.integrityMismatch"
    case "takeover_abort_failed":
      return "recoveryRequired.reasons.previousRuntime"
    case "frozen_transcript_host_unverified":
      return "recoveryRequired.reasons.unverifiedHost"
    case "transcript_authoritative_host_required":
      return "recoveryRequired.reasons.authoritativeHost"
    case "frozen_transcript_session_missing":
      return "recoveryRequired.reasons.missingSession"
    case "frozen_transcript_generation_mismatch":
      return "recoveryRequired.reasons.changedHistory"
    default:
      return "recoveryRequired.body"
  }
}

/**
 * Tells the user what happened to a turn the system accepted but has not
 * answered (ADR-0123).
 *
 * Before durable submission, the three states below were indistinguishable
 * from a hung request: the message sat there and nothing explained why. Each
 * one now says which it is, because the right user response differs — wait,
 * reconnect, or intervene.
 *
 * Renders nothing while a turn is streaming normally. The existing streaming
 * UI already reports that, and a second indicator beside it would be noise.
 *
 * Visual treatment follows `character-missing-banner.tsx` so the chat surface
 * stays homogeneous; no new variant or palette is introduced.
 */
export function WorkSubmissionNotice({ sessionId, onResume }: Props) {
  const t = useTranslations("chat.workSubmission")
  const { state, submission } = useWorkSubmissionStatus(sessionId)
  const [confirming, setConfirming] = useState(false)
  const [resuming, setResuming] = useState(false)

  if (state === "idle") return null

  if (state === "recoveryRequired") {
    const resumable = onResume !== undefined && submission?.sourceKind === "chat"
    const mayRepeat = interruptedTurnMayRepeatEffects(submission?.errorCode)
    const resume = async () => {
      setConfirming(false)
      setResuming(true)
      try {
        await onResume?.()
      } finally {
        setResuming(false)
      }
    }
    return (
      <Alert variant="destructive" data-testid="work-submission-recovery">
        <AlertCircleIcon />
        <AlertTitle>{t("recoveryRequired.title")}</AlertTitle>
        <AlertDescription>
          <p>{t(recoveryBodyKey(submission?.errorCode))}</p>
          {resumable ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={resuming}
              onClick={() => (mayRepeat ? setConfirming(true) : void resume())}
            >
              {resuming ? t("recoveryRequired.resuming") : t("recoveryRequired.resume")}
            </Button>
          ) : null}
        </AlertDescription>
        {resumable ? (
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("recoveryRequired.resumeConfirm.title")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("recoveryRequired.resumeConfirm.body")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("recoveryRequired.resumeConfirm.cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void resume()}>
                  {t("recoveryRequired.resumeConfirm.confirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </Alert>
    )
  }

  if (state === "blocked") {
    return (
      <Alert data-testid="work-submission-blocked">
        <CloudOffIcon />
        <AlertTitle>{t("blocked.title")}</AlertTitle>
        <AlertDescription>{t("blocked.body")}</AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert data-testid="work-submission-queued">
      <ClockIcon />
      <AlertTitle>{t("queued.title")}</AlertTitle>
      <AlertDescription>{t("queued.body")}</AlertDescription>
    </Alert>
  )
}
