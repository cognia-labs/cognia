"use client"
import { useTranslations } from "next-intl"

import { DraftEditor } from "@/components/inbox/draft-editor"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"

/** The IM conversation's pending connector drafts, each editable in place. */
export function DraftReviewDialog({
  open,
  onOpenChange,
  drafts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  drafts: readonly ConnectorDraftRow[]
}) {
  const tDraftReview = useTranslations("chat.composer.draftReview")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg sm:max-w-lg max-w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>{tDraftReview("title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tDraftReview("noPendingDrafts")}</p>
          ) : (
            drafts.map((draft) => (
              <DraftEditor key={draft.id} draft={draft} onClose={() => onOpenChange(false)} />
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
