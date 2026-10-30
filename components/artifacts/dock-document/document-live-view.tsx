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
  const state =
    !tab.url || !desktop || local.error || !local.status?.installed
      ? reason
        ? "blocked"
        : "preparing"
      : runtime.state
  const showBanner = state !== "ready"
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      {showBanner ? (
        <div className="pointer-events-none absolute inset-x-2 top-11 z-10 flex justify-center">
          <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-xs shadow-sm">
            <span role="status">{t(`live.states.${state}`)}</span>
            {reason ? (
              <span className="text-muted-foreground">
                {t(
                  `live.reasons.${
                    [
                      "unknown-link",
                      "web",
                      "chromium",
                      "isolation-unavailable",
                      "browser-error",
                      "profile-in-use",
                      "op-refused",
                      "cap-reached",
                      "runtime-exited",
                      "update-app",
                      "signed-out",
                    ].includes(reason)
                      ? reason
                      : "browser-error"
                  }`
                )}
              </span>
            ) : null}
            {reason === "chromium" ? <LocalChromiumInstall local={local} /> : null}
            <Button
              size="sm"
              variant="outline"
              disabled={!tab.url}
              onClick={() =>
                void openExternal(tab.url).catch(() =>
                  onState("error", { reason: "browser-error" })
                )
              }
            >
              {t("openSystem")}
            </Button>
            <Button
              size="sm"
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
        </div>
      ) : null}
      {desktop && tab.url && local.status?.installed && !local.error ? (
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
