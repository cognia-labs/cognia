"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useStore } from "zustand"
import { useTranslations } from "next-intl"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  RotateCwIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { LocalBrowserDialog } from "./local-browser-dialog"
import { LocalBrowserCanvas, useFrameCanvas } from "./local-browser-surface"
import { localBrowser } from "@/lib/browser/local-client"
import {
  activateDocumentViewerPage,
  answerDocumentViewerDialog,
  documentViewerErrorReason,
  documentViewerStore,
  ensureDocumentViewerPage,
  refreshDocumentViewerPages,
  retainDocumentViewer,
  signOutDocumentViewer,
  subscribeDocumentViewerFrames,
} from "@/lib/browser/document-viewer-session"
import { classifyCloudDocumentUrl } from "@/lib/docs-providers/document-url"
import { LARK_HOST_SUFFIXES } from "@/lib/twin/ingest/lark-url"
import { isTauri } from "@/lib/tauri"
import { openExternal } from "@/lib/tauri/opener"
import { cn } from "@/lib/utils"
import {
  createLocalViewportScheduler,
  type LocalViewportResult,
} from "@/lib/browser/local-viewport-scheduler"

export type DocumentLiveState =
  "idle" | "preparing" | "needs-login" | "loading" | "ready" | "error" | "blocked"
export interface DocumentViewerBrowserProps {
  sessionId: string
  docTabId: string
  url: string
  providerId: string
  onState: (state: DocumentLiveState, detail?: { reason?: string }) => void
}

/** Exact hosts; suffix boundaries come from the same owner as the strict document classifier. */
export const DOCUMENT_VIEWER_LOGIN_HOSTS = {
  google: ["accounts.google.com"],
  lark: LARK_HOST_SUFFIXES.flatMap((suffix) =>
    [
      "login",
      "passport",
      "accounts",
      "passport-sg",
      "passport-us",
      "login-sg",
      "login-us",
      "accounts-sg",
      "accounts-us",
    ].map((prefix) => `${prefix}${suffix}`)
  ),
} as const
function safeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !/^https:\/\/[^/?#]*@/i.test(raw.trim())
      ? url
      : null
  } catch {
    return null
  }
}
export function isDocumentProviderHost(raw: string, providerId: string): boolean {
  const url = safeUrl(raw)
  if (!url) return false
  if (providerId === "google") return url.hostname === "docs.google.com"
  return (
    providerId === "lark" &&
    LARK_HOST_SUFFIXES.some(
      (suffix) => url.hostname === suffix.slice(1) || url.hostname.endsWith(suffix)
    )
  )
}
export function isDocumentLoginUrl(raw: string, providerId: string): boolean {
  const url = safeUrl(raw)
  const hosts = DOCUMENT_VIEWER_LOGIN_HOSTS[
    providerId as keyof typeof DOCUMENT_VIEWER_LOGIN_HOSTS
  ] as readonly string[] | undefined
  return !!url && !!hosts?.includes(url.hostname)
}
const BLOCKED_REASONS = new Set([
  "web",
  "chromium",
  "profile-in-use",
  "op-refused",
  "cap-reached",
  "update-app",
  "signed-out",
])

/** Human-only chrome: importing this never mounts the ordinary browser's history or agent tools. */
export function DocumentViewerBrowser({
  docTabId,
  url,
  providerId,
  onState,
}: DocumentViewerBrowserProps) {
  const t = useTranslations("cloudDocPreview")
  const runtime = useStore(documentViewerStore)
  const [failure, setFailure] = useState<string | null>(null)
  const [signOutOpen, setSignOutOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const canvas = useFrameCanvas()
  const { resetPage, requestViewport, applyViewport, drawFrame } = canvas
  const viewportRef = useRef<HTMLDivElement>(null)
  const fail = useCallback((error: unknown) => setFailure(documentViewerErrorReason(error)), [])
  const desktop = isTauri()
  const page = runtime.byTab[docTabId]
  const runtimeSessionId = runtime.sessionId
  const pageId = page?.id.startsWith("pending:") ? undefined : page?.id
  const dialog = pageId ? (runtime.dialogs[pageId] ?? null) : null
  const reason = !desktop
    ? "web"
    : (failure ?? runtime.error ?? (page?.loadError ? "browser-error" : null))
  const state: DocumentLiveState = reason
    ? BLOCKED_REASONS.has(reason)
      ? "blocked"
      : "error"
    : !page
      ? "preparing"
      : isDocumentLoginUrl(page.url, providerId)
        ? "needs-login"
        : page.loading === false && classifyCloudDocumentUrl(page.url)?.providerId === providerId
          ? "ready"
          : "loading"
  useEffect(() => {
    onState(state, reason ? { reason } : undefined)
  }, [state, reason, onState])
  useEffect(() => {
    if (!desktop) return
    let active = true
    const release = retainDocumentViewer()
    void ensureDocumentViewerPage(docTabId, url).catch((error) => {
      if (active) fail(error)
    })
    return () => {
      active = false
      release()
    }
  }, [docTabId, url, desktop, fail])
  useEffect(() => {
    if (!pageId || !runtimeSessionId) return
    resetPage()
    void activateDocumentViewerPage(pageId).catch(fail)
    return subscribeDocumentViewerFrames(pageId, drawFrame, fail)
  }, [pageId, runtimeSessionId, resetPage, drawFrame, fail])
  useEffect(() => {
    const element = viewportRef.current
    if (
      !desktop ||
      !runtimeSessionId ||
      !pageId ||
      runtime.activePageId !== pageId ||
      dialog ||
      signingOut ||
      !element
    )
      return
    const scheduler = createLocalViewportScheduler({
      sessionId: runtimeSessionId,
      resize: (viewport, synchronizeFrame) =>
        localBrowser.rpc<LocalViewportResult>("browser.emulate", {
          sessionId: runtimeSessionId,
          pageId,
          viewport,
          ...(synchronizeFrame ? { synchronizeFrame: true } : {}),
        }),
      onRequest: requestViewport,
      onApplied: applyViewport,
      onError: fail,
    })
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = element
      scheduler.update(
        width > 0 && height > 0
          ? {
              width: Math.max(1, Math.min(8192, Math.round(width))),
              height: Math.max(1, Math.min(8192, Math.round(height))),
              deviceScaleFactor: Math.max(0.5, Math.min(4, window.devicePixelRatio || 1)),
              fitToWidth: false,
            }
          : null
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    let densityQuery: MediaQueryList
    const watchDensity = () => {
      densityQuery?.removeEventListener("change", densityChanged)
      densityQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      densityQuery.addEventListener("change", densityChanged)
    }
    const densityChanged = () => {
      measure()
      watchDensity()
    }
    watchDensity()
    window.addEventListener("resize", measure)
    measure()
    return () => {
      scheduler.dispose()
      observer.disconnect()
      densityQuery.removeEventListener("change", densityChanged)
      window.removeEventListener("resize", measure)
    }
  }, [
    desktop,
    runtimeSessionId,
    pageId,
    runtime.activePageId,
    dialog,
    signingOut,
    requestViewport,
    applyViewport,
    fail,
  ])
  const run = (op: "browser.back" | "browser.forward" | "browser.reload") => {
    if (!runtimeSessionId || !pageId) return
    void localBrowser
      .rpc(op, { sessionId: runtimeSessionId, pageId })
      .then(() => refreshDocumentViewerPages(runtimeSessionId))
      .catch(fail)
  }
  let host = ""
  try {
    host = new URL(page?.url ?? url).host
  } catch {
    /* Unknown originals remain blocked by the dock. */
  }
  const providerHost = isDocumentProviderHost(page?.url ?? url, providerId)
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div
        role="toolbar"
        aria-label={t("live.toolbar")}
        className="flex h-9 shrink-0 items-center gap-1 border-b px-1"
      >
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("live.back")}
          disabled={!pageId || !runtimeSessionId || !!dialog}
          onClick={() => run("browser.back")}
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("live.forward")}
          disabled={!pageId || !runtimeSessionId || !!dialog}
          onClick={() => run("browser.forward")}
        >
          <ArrowRightIcon className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("live.reload")}
          disabled={!pageId || !runtimeSessionId || !!dialog}
          onClick={() => run("browser.reload")}
        >
          <RotateCwIcon className="size-4" />
        </Button>
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-xs",
            providerHost
              ? "text-muted-foreground"
              : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
          )}
        >
          <span className="truncate">{host}</span>
          {providerHost && (
            <span className="shrink-0 rounded bg-primary/10 px-1 text-primary">
              {t("live.providerBadge")}
            </span>
          )}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("openSystem")}
          disabled={!/^https?:/i.test(page?.url ?? url)}
          onClick={() => void openExternal(page?.url ?? url).catch(fail)}
        >
          <ExternalLinkIcon className="size-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-7" aria-label={t("live.more")}>
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={signingOut} onSelect={() => setSignOutOpen(true)}>
              {t("live.signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <LocalBrowserCanvas
          canvas={canvas}
          sessionId={runtimeSessionId}
          pageId={pageId}
          ready={!!pageId && !!runtimeSessionId && !dialog && !signingOut}
          label={t("live.canvas")}
          onError={fail}
        />
      </div>
      <LocalBrowserDialog
        dialog={dialog}
        onAnswer={(answer) => {
          if (pageId) void answerDocumentViewerDialog(pageId, answer).catch(fail)
        }}
      />
      <AlertDialog open={signOutOpen} onOpenChange={setSignOutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("live.signOut")}</AlertDialogTitle>
            <AlertDialogDescription>{t("live.signOutDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("live.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setSigningOut(true)
                void signOutDocumentViewer()
                  .catch(fail)
                  .finally(() => setSigningOut(false))
              }}
            >
              {t("live.signOut")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
