"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useAsideInheritance } from "@/hooks/chat/use-aside-inheritance"
import { renderAsideMessage } from "@/lib/chat/session-aside-context"
import { Button } from "@/components/ui/button"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"

const ATTACHMENT_REASON_KEY = {
  missingBytes: "inheritanceMissingBytes",
  readFailed: "inheritanceReadFailed",
  composerUnavailable: "inheritanceComposerUnavailable",
} as const

export function AsideInheritance({ sessionId, parentId }: { sessionId: string; parentId: string }) {
  const t = useTranslations("contextWorkbench.asides")
  const { data, failed, setIncluded, attach } = useAsideInheritance(sessionId, parentId)
  const [busy, setBusy] = useState(false)
  const [attachmentError, setAttachmentError] = useState<
    (typeof ATTACHMENT_REASON_KEY)[keyof typeof ATTACHMENT_REASON_KEY] | null
  >(null)
  if (!data)
    return failed ? (
      <p role="status" className="px-3 py-1 text-xs">
        {t("inheritanceLoadFailed")}
      </p>
    ) : null
  const { summary } = data
  return (
    <div className="px-3 py-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-auto max-w-full whitespace-normal text-left text-xs"
            aria-label={t("inheritanceOpen")}
          >
            {t("inheritanceSummary", {
              included: summary.recentIncluded.length,
              omitted: summary.omitted.length,
              attachments: summary.attachments.length,
            })}
            {summary.validPins.length
              ? ` · ${t("inheritancePins", { count: summary.validPins.length })}`
              : null}
            {data.hidden ? ` · ${t("inheritanceHidden", { count: data.hidden })}` : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="max-h-[min(70vh,36rem)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto"
          aria-label={t("inheritanceTitle")}
        >
          <h2 className="text-sm font-medium">{t("inheritanceTitle")}</h2>
          <p className="mb-3 text-xs text-muted-foreground">{t("inheritanceHelp")}</p>
          {failed ? <p role="alert">{t("actionError")}</p> : null}
          {attachmentError ? <p role="alert">{t(attachmentError)}</p> : null}
          {data.hidden ? (
            <p className="text-xs">{t("inheritanceHidden", { count: data.hidden })}</p>
          ) : null}
          <ol className="space-y-3">
            {data.messages.map((message, index) => {
              const pinned = summary.validPins.includes(message.id)
              const included = summary.included.includes(message.id)
              return (
                <li key={message.id} className="rounded-md border p-2 text-xs">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span>
                      {t(
                        summary.truncated.includes(message.id)
                          ? "inheritanceTruncated"
                          : included
                            ? "inheritanceIncluded"
                            : "inheritanceOmitted"
                      )}
                    </span>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={pinned}
                        disabled={busy}
                        aria-label={t("inheritancePinMessage", { index: index + 1 })}
                        onChange={(event) => {
                          setBusy(true)
                          void setIncluded(message.id, event.target.checked).finally(() =>
                            setBusy(false)
                          )
                        }}
                      />
                      {t("inheritancePin")}
                    </label>
                  </div>
                  <p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words">
                    {renderAsideMessage(message)}
                  </p>
                  {data.attachments
                    .filter((attachment) => attachment.messageId === message.id)
                    .map((attachment) => (
                      <div key={attachment.partIndex} className="mt-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy || !!attachment.unavailable}
                          aria-label={t("inheritanceAttach", { filename: attachment.filename })}
                          onClick={() => {
                            setBusy(true)
                            void attach(message.id, attachment.partIndex)
                              .then((reason) =>
                                setAttachmentError(reason ? ATTACHMENT_REASON_KEY[reason] : null)
                              )
                              .catch(() => setAttachmentError("inheritanceReadFailed"))
                              .finally(() => setBusy(false))
                          }}
                        >
                          {t("inheritanceAttach", { filename: attachment.filename })}
                        </Button>
                        {attachment.unavailable ? (
                          <p className="text-muted-foreground">
                            {t(
                              attachment.unavailable === "missingBytes"
                                ? "inheritanceMissingBytes"
                                : "inheritanceReadFailed"
                            )}
                          </p>
                        ) : null}
                      </div>
                    ))}
                </li>
              )
            })}
          </ol>
        </PopoverContent>
      </Popover>
    </div>
  )
}
