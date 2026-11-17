"use client"
import { useTranslations } from "next-intl"

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

/** A parked send waiting on the user's choice: `resolve(true)` sends anyway. */
export interface OversizeConfirmRequest {
  tokens: number
  resolve: (ok: boolean) => void
}

/**
 * Oversize attachment confirmation — large inlined documents (decision: warn
 * + confirm, never silently truncate).
 */
export function OversizeAttachmentDialog({ request }: { request: OversizeConfirmRequest | null }) {
  const tAttach = useTranslations("chat.composer.attachments")
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) request?.resolve(false)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tAttach("oversizeTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {tAttach("oversizeBody", {
              tokens: Math.round((request?.tokens ?? 0) / 1000),
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => request?.resolve(false)}>
            {tAttach("oversizeCancel")}
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => request?.resolve(true)}>
            {tAttach("oversizeConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
