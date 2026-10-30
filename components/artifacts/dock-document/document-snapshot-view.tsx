"use client"

import { useEffect, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { FilePartPreview } from "@/components/chat/message-parts/file-part-preview"
import { DocsProviderNotice } from "@/components/docs-providers/docs-provider-notice"
import { Button } from "@/components/ui/button"
import { openExternal } from "@/lib/tauri/opener"
import {
  setDockDocumentView,
  type DockDocumentSnapshotContent,
} from "@/lib/artifacts/dock-documents"
import type { DockDocumentTab } from "@/stores/artifact/dock-documents-store"
import { DocumentGridView } from "./document-grid-view"
import { useDocumentSnapshot } from "./use-document-snapshot"

function SnapshotBody({ content }: { content: DockDocumentSnapshotContent }) {
  const [bodyUrl, setBodyUrl] = useState<{ text: string; url: string } | null>(null)
  useEffect(() => {
    if (content.format === "csv") return
    let disposed = false
    const url = URL.createObjectURL(
      new Blob([content.text], {
        type: content.format === "markdown" ? "text/markdown" : "text/plain",
      })
    )
    // Keep URLs paired with their body so an old preview cannot flash on a body change.
    void Promise.resolve().then(() => {
      if (!disposed) setBodyUrl({ text: content.text, url })
    })
    return () => {
      disposed = true
      URL.revokeObjectURL(url)
    }
  }, [content.text, content.format])
  if (content.format === "csv") return <DocumentGridView text={content.text} />
  return bodyUrl?.text === content.text ? (
    <FilePartPreview
      url={bodyUrl.url}
      filename={`${content.title.replace(/[/\\:*?"<>|]/g, " ")}.${content.format === "markdown" ? "md" : "txt"}`}
      mediaType={content.format === "markdown" ? "text/markdown" : "text/plain"}
      presentation="document"
      hideDownloadFallback
    />
  ) : null
}

export function DocumentSnapshotView({
  sessionId,
  tab,
}: {
  sessionId: string
  tab: DockDocumentTab
}) {
  const t = useTranslations("cloudDocPreview")
  const format = useFormatter()
  const snapshot = useDocumentSnapshot(sessionId, tab)
  const { content } = snapshot
  const [openFailed, setOpenFailed] = useState(false)
  const [attachFailed, setAttachFailed] = useState(false)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="space-y-2 border-b p-4">
        <p className="text-xs text-muted-foreground">
          {t(`providers.${tab.providerId}`)} · {t(`kinds.${tab.resourceKind}`)}
        </p>
        <h2 className="truncate font-medium">{content?.title || tab.title || t("title")}</h2>
        {content ? (
          <p className="text-xs text-muted-foreground">
            {t(content.origin === "sent" ? "sentAt" : "readAt", {
              time: format.dateTime(content.fetchedAt, { dateStyle: "medium", timeStyle: "short" }),
            })}
          </p>
        ) : null}
        {snapshot.sent && snapshot.latest ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-pressed={!snapshot.showLatest}
              onClick={() => snapshot.setShowLatest(false)}
            >
              {t("sentSnapshot")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-pressed={snapshot.showLatest}
              onClick={() => snapshot.setShowLatest(true)}
            >
              {t("latestPreview")}
            </Button>
          </div>
        ) : null}
        {content?.completeness.status === "partial" ? (
          <p className="text-xs text-amber-600">
            {t("partial", {
              reasons: content.completeness.reasons
                .map((reason) =>
                  t(
                    `reasons.${["budget", "upstream-truncated", "inaccessible-block", "unsupported-content", "parse-degraded"].includes(reason) ? reason : "parse-degraded"}`
                  )
                )
                .join(" · "),
            })}
          </p>
        ) : null}
        {content?.truncated ? <p className="text-xs text-amber-600">{t("truncated")}</p> : null}
        <div className="flex flex-wrap gap-2">
          {snapshot.canAttach ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void snapshot.attachToChat().then((claimed) => setAttachFailed(!claimed))
              }}
            >
              {t("attachToChat")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={
              !snapshot.reach.available ||
              ["resolving", "loading", "refreshing"].includes(snapshot.state)
            }
            onClick={() => void snapshot.refresh()}
          >
            {t("refresh")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDockDocumentView(sessionId, tab.id, "live")}
          >
            {t("openLive")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!tab.url}
            onClick={() => void openExternal(tab.url).catch(() => setOpenFailed(true))}
          >
            {t("openSystem")}
          </Button>
        </div>
        {!tab.url ? (
          <p className="text-xs text-muted-foreground">{t("live.reasons.unknown-link")}</p>
        ) : null}
        {attachFailed ? <p role="alert">{t("attachUnavailable")}</p> : null}
        {openFailed ? <p role="alert">{t("live.reasons.browser-error")}</p> : null}
        <DocsProviderNotice reach={snapshot.reach} />
        {snapshot.accounts ? (
          <div className="space-y-2" role="group" aria-label={t("chooseAccount")}>
            <p className="text-xs">{t("chooseAccount")}</p>
            {snapshot.accounts.length ? (
              snapshot.accounts.map((account) => (
                <Button
                  key={account.id}
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void snapshot.refresh({
                      accountId: account.id,
                      authorizationEpoch: account.authorizationEpoch,
                    })
                  }
                >
                  {account.label}
                </Button>
              ))
            ) : (
              <p className="text-xs">{t("noAccounts")}</p>
            )}
          </div>
        ) : null}
        {snapshot.sourceRemoved ? (
          <p role="alert" className="text-xs text-muted-foreground">
            {t("sourceRemoved")}
          </p>
        ) : null}
        {snapshot.refreshFailed ? (
          <p role="alert" className="text-xs text-amber-600">
            {t("refreshFailed")}
          </p>
        ) : null}
        {snapshot.error ? (
          <p role="alert" className="text-xs text-destructive">
            {t(`errors.${snapshot.error}`)}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground" role="status">
          {t(`snapshot.states.${snapshot.state}`)}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {content && content.text.trim() ? <SnapshotBody content={content} /> : null}
      </div>
    </div>
  )
}
