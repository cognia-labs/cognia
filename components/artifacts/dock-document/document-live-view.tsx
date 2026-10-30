"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  DocumentViewerBrowser,
  type DocumentLiveState,
} from "@/components/browser/document-viewer-browser"
import { LocalChromiumInstall } from "@/components/browser/browser-backend-switcher"
import { Button } from "@/components/ui/button"
import { useLocalBrowser } from "@/hooks/browser/use-local-browser"
import { isTauri } from "@/lib/tauri"
import { openExternal } from "@/lib/tauri/opener"
import type { DockDocumentTab } from "@/stores/artifact/dock-documents-store"

export function DocumentLiveView({ sessionId, tab }: { sessionId: string; tab: DockDocumentTab }) {
  const t = useTranslations("cloudDocPreview")
  const desktop = isTauri()
  const local = useLocalBrowser({ enabled: desktop })
  const [attempt, setAttempt] = useState(0)
  const [runtime, setRuntime] = useState<{ state: DocumentLiveState; reason?: string }>({
    state: "idle",
  })
  const onState = useCallback(
    (state: DocumentLiveState, detail?: { reason?: string }) =>
      setRuntime({ state, reason: detail?.reason }),
    []
  )
  const reason = !tab.url
    ? "unknown-link"
    : !desktop
      ? "web"
      : local.error
        ? "browser-error"
        : !local.status
          ? undefined
          : !local.status.installed
            ? "chromium"
            : runtime.reason
  const state = reason ? "blocked" : !local.status ? "preparing" : runtime.state
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <p role="status">{t(`live.states.${state}`)}</p>
      {reason ? (
        <p className="text-sm text-muted-foreground">
          {t(
            `live.reasons.${["unknown-link", "web", "chromium", "isolation-unavailable", "browser-error"].includes(reason) ? reason : "browser-error"}`
          )}
        </p>
      ) : null}
      {reason === "chromium" ? <LocalChromiumInstall local={local} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!tab.url}
          onClick={() =>
            void openExternal(tab.url).catch(() => onState("error", { reason: "browser-error" }))
          }
        >
          {t("openSystem")}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setRuntime({ state: "preparing" })
            setAttempt((value) => value + 1)
            void local.refresh()
          }}
        >
          {t("retry")}
        </Button>
      </div>
      {desktop && tab.url && local.status?.installed ? (
        <DocumentViewerBrowser
          key={attempt}
          sessionId={sessionId}
          docTabId={tab.id}
          url={tab.url}
          providerId={tab.providerId}
          onState={onState}
        />
      ) : null}
    </div>
  )
}
