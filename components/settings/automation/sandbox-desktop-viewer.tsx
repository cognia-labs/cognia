"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useSandboxDesktop } from "@/hooks/automation/use-sandbox-desktop"
import {
  useSandboxDesktopStream,
  type SandboxDesktopStreamDeps,
} from "@/hooks/automation/use-sandbox-desktop-stream"
import { screenshotMimeType } from "@/lib/automation/model-frame"
import type { Point, Screenshot } from "@/lib/automation/types"
import type { OpenSandboxDesktop, SandboxControlLease } from "@/lib/automation/sandbox-client"
import { isCapacitor } from "@/lib/platform/detect"
import { prefersTouchInput } from "@cognia/plugin-ui"
import { NativeTouchControls } from "@/components/devices/remote-desktop/native-touch-controls"
import { openManagedDesktop } from "@/lib/automation/managed-desktop-client"
import { SandboxFileTransfer, type ManagedDesktopTransferTarget } from "./sandbox-file-transfer"

function framePoint(
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
  frame: Screenshot
): Point | null {
  const rect = image.getBoundingClientRect()
  if (
    !rect.width ||
    !rect.height ||
    clientX < rect.left ||
    clientY < rect.top ||
    clientX > rect.right ||
    clientY > rect.bottom
  )
    return null
  const width = frame.sourceWidth ?? frame.width
  const height = frame.sourceHeight ?? frame.height
  return {
    x: Math.min(width - 1, Math.floor(((clientX - rect.left) / rect.width) * width)),
    y: Math.min(height - 1, Math.floor(((clientY - rect.top) / rect.height) * height)),
  }
}

/**
 * Native frames use the authenticated Host stream, with single-frame RPC as
 * the fallback. A local sandbox built with Selkies (ADR-0234 Phase 4)
 * is shown as its live stream instead: a loopback page with a Host-issued
 * session token that can only watch until this viewer holds the control lease.
 */
interface SandboxDesktopViewerProps {
  connectionId: string
  enabled: boolean
  containerId?: string
  transferTargetId?: string
  transferFolder?: string
  managed?: ManagedDesktopTransferTarget
  openDesktop?: OpenSandboxDesktop
  observeOnly?: boolean
  /** Test seam for the stream grant calls. */
  streamDeps?: SandboxDesktopStreamDeps
  allowStreaming?: boolean
}
export function SandboxDesktopViewer(props: SandboxDesktopViewerProps) {
  const target = props.managed
  return (
    <SandboxDesktopViewerSession
      key={`${props.connectionId}:${props.enabled}:${target?.ref.desktopId ?? ""}:${target?.ref.generation ?? ""}:${target?.operationsQualified ?? false}:${target?.target.kind === "remote" ? target.target.hostId : "local"}`}
      {...props}
    />
  )
}
function SandboxDesktopViewerSession({
  connectionId,
  enabled,
  containerId,
  transferTargetId,
  transferFolder,
  managed,
  openDesktop,
  observeOnly = false,
  streamDeps,
  allowStreaming = true,
}: SandboxDesktopViewerProps) {
  const t = useTranslations("automation.sandboxConnections.desktopViewer")
  const mobileObservation = observeOnly
  const [touchScreen] = useState(
    () =>
      isCapacitor() ||
      prefersTouchInput() ||
      (typeof navigator !== "undefined" && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent))
  )
  const releaseRef = useRef<
    ((expectedLease?: SandboxControlLease) => Promise<void> | undefined) | null
  >(null)
  const leaseChangeEpoch = useRef(0)
  useLayoutEffect(
    () => () => {
      leaseChangeEpoch.current += 1
    },
    [connectionId, enabled, openDesktop, allowStreaming]
  )
  const releaseBeforeRecovery = useCallback(async () => {
    await releaseRef.current?.()
  }, [])
  // Only the client-local Docker desktop has a Selkies variant.
  const {
    grant: streamGrant,
    status: streamStatus,
    attachFrame: attachStreamFrame,
    claim: claimStream,
    reopen: reopenStream,
  } = useSandboxDesktopStream(
    connectionId,
    enabled && allowStreaming && !openDesktop,
    streamDeps,
    releaseBeforeRecovery
  )
  const streaming = streamGrant !== null
  const onLeaseChange = useCallback(
    (lease: SandboxControlLease | null) => {
      const epoch = ++leaseChangeEpoch.current
      if (!lease) {
        void reopenStream()
        return
      }
      // Control the stream cannot carry is control the user cannot use.
      void claimStream(lease).then((claimed) => {
        if (!claimed && leaseChangeEpoch.current === epoch) void releaseRef.current?.(lease)
      })
    },
    [claimStream, reopenStream]
  )
  const {
    frame,
    controlling,
    acquiring,
    error,
    acquire,
    release,
    refresh,
    input,
    status,
    transport,
  } = useSandboxDesktop(connectionId, enabled, openDesktop, !mobileObservation, {
    streaming,
    streamHealthy: streamStatus === "open" && streamGrant?.healthVersion === 1,
    onLeaseChange: openDesktop || !allowStreaming ? undefined : onLeaseChange,
  })
  useLayoutEffect(() => {
    releaseRef.current = release
  })
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [clipboard, setClipboard] = useState("")
  const [clipboardBusy, setClipboardBusy] = useState(false)
  const clipboardInFlight = useRef(false)
  const [clipboardError, setClipboardError] = useState(false)
  const [doubleClick, setDoubleClick] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const operationEpoch = useRef(0)
  useEffect(() => {
    operationEpoch.current += 1
    return () => {
      operationEpoch.current += 1
    }
  }, [connectionId, managed?.ref.desktopId, managed?.ref.generation, managed?.operationsQualified])
  async function transferClipboard(write: boolean) {
    if (!managed?.operationsQualified || !enabled || clipboardInFlight.current) return
    clipboardInFlight.current = true
    const epoch = operationEpoch.current
    setClipboardBusy(true)
    setClipboardError(false)
    let session: Awaited<ReturnType<typeof openManagedDesktop>> | undefined
    let lease: SandboxControlLease | undefined
    try {
      if (new TextEncoder().encode(clipboard).length > 1024 * 1024)
        throw new Error("managed_desktop_operation_limit")
      await release()
      if (epoch !== operationEpoch.current) return
      session = await openManagedDesktop(managed.target, managed.ref)
      lease = await session.acquire(true)
      if (epoch !== operationEpoch.current) return
      if (write) await session.clipboardSet(lease, clipboard)
      else {
        const result = await session.clipboardGet(lease)
        if (new TextEncoder().encode(result.text).length > 1024 * 1024)
          throw new Error("managed_desktop_operation_limit")
        if (epoch === operationEpoch.current) setClipboard(result.text)
      }
    } catch {
      if (epoch === operationEpoch.current) setClipboardError(true)
    } finally {
      if (lease) await session?.release(lease).catch(() => undefined)
      session?.close()
      clipboardInFlight.current = false
      if (epoch === operationEpoch.current) setClipboardBusy(false)
    }
  }
  const image = useRef<HTMLImageElement>(null)
  const touchSurface = useCallback(() => image.current, [])
  const start = useRef<{
    point: Point
    frame: Screenshot
    startedAt: number
    button: "left" | "middle" | "right"
  } | null>(null)

  useEffect(() => {
    start.current = null
  }, [connectionId, controlling, openDesktop])

  useEffect(() => {
    const element = image.current
    if (!element || !controlling || !frame) return
    const wheel = (event: WheelEvent) => {
      const point = framePoint(element, event.clientX, event.clientY, frame)
      if (!point) return
      event.preventDefault()
      // Browser wheel deltas may represent pixels, lines, or pages.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1
      void input(
        {
          kind: "scroll",
          opts: { dx: Math.round(event.deltaX * unit), dy: Math.round(event.deltaY * unit) },
        },
        point,
        frame.capturedAt
      )
    }
    // React delegates wheel handlers as passive listeners, so suppress native
    // sheet scrolling at the actual desktop surface instead.
    element.addEventListener("wheel", wheel, { passive: false })
    return () => element.removeEventListener("wheel", wheel)
  }, [controlling, frame, input])

  function pointerDown(event: PointerEvent<HTMLImageElement>) {
    if (!controlling || !frame) return
    event.preventDefault()
    event.currentTarget.focus()
    const point = framePoint(event.currentTarget, event.clientX, event.clientY, frame)
    if (!point) return
    start.current = {
      point,
      frame,
      startedAt: Date.now(),
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  function pointerUp(event: PointerEvent<HTMLImageElement>) {
    const previous = start.current
    start.current = null
    if (
      !controlling ||
      !frame ||
      !previous ||
      Date.now() - previous.startedAt > 5_000 ||
      previous.frame.width !== frame.width ||
      previous.frame.height !== frame.height ||
      previous.frame.sourceWidth !== frame.sourceWidth ||
      previous.frame.sourceHeight !== frame.sourceHeight
    )
      return
    const point = framePoint(event.currentTarget, event.clientX, event.clientY, frame)
    if (!point) return
    const distance = Math.hypot(point.x - previous.point.x, point.y - previous.point.y)
    void input(
      distance > 4
        ? { kind: "drag", to: point, opts: { button: previous.button } }
        : { kind: "click", button: previous.button, count: doubleClick ? 2 : 1 },
      previous.point,
      frame.capturedAt
    )
  }

  function keyDown(event: KeyboardEvent<HTMLImageElement>) {
    if (
      !controlling ||
      !frame ||
      event.nativeEvent.isComposing ||
      ["Shift", "Control", "Alt", "Meta", "Dead", "Process", "Unidentified"].includes(event.key)
    )
      return
    // Escape always releases control locally, including when a remote app is hung.
    if (event.key === "Escape") {
      event.preventDefault()
      void release()
      return
    }
    event.preventDefault()
    const modifiers = [
      event.ctrlKey ? "ctrl" : "",
      event.altKey ? "alt" : "",
      event.metaKey ? "meta" : "",
      event.shiftKey ? "shift" : "",
    ].filter(Boolean)
    void input(
      event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey
        ? { kind: "typeText", text: event.key }
        : {
            kind: "pressKey",
            chord: [
              ...modifiers,
              event.key === " " ? "Space" : event.key === "+" ? "Plus" : event.key,
            ].join("+"),
          },
      null,
      frame.capturedAt
    )
  }

  async function sendText() {
    if (!frame || !controlling || !text || sending) return
    const submitted = text
    setSending(true)
    try {
      if (await input({ kind: "typeText", text: submitted }, null, frame.capturedAt)) {
        setText((current) => (current === submitted ? "" : current))
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="space-y-3" aria-label={t("title")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <span className="text-xs text-muted-foreground" role="status">
          {controlling
            ? t("controlling")
            : status?.state === "quarantined"
              ? t("quarantined")
              : status?.controllerKind === "human"
                ? t("otherController")
                : t("readOnly")}
        </span>
      </div>
      {streaming || transport === "frames" ? (
        <p className="text-xs text-muted-foreground">
          {streaming ? t("streamCadence") : t("cadence")}
        </p>
      ) : null}
      {streamStatus === "connecting" || streamStatus === "opening" ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t("streamConnecting")}
        </p>
      ) : streamStatus === "error" ? (
        <p className="text-xs text-destructive" role="alert">
          {t("streamRecovering")}
        </p>
      ) : null}
      {streamStatus === "unmonitored" ? (
        <p className="text-xs text-muted-foreground">{t("streamLegacy")}</p>
      ) : null}
      {openDesktop ? (
        <p className="text-xs text-muted-foreground" data-dormant="managed-desktop-agent-control">
          {t("agentDormant")}
        </p>
      ) : null}
      {mobileObservation ? (
        <p className="text-xs text-muted-foreground">{t("mobileObservation")}</p>
      ) : null}
      {status && !status.qualified ? (
        <p className="text-xs text-muted-foreground" data-dormant="managed-desktop-control">
          {t("qualificationRequired")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(
            error === "capture" && streaming && controlling
              ? "error.captureStreaming"
              : `error.${error}`
          )}
        </p>
      ) : null}
      {streamGrant ? (
        // Remounted per grant: a role change closes Selkies' socket anyway.
        <iframe
          ref={attachStreamFrame}
          key={streamGrant.url}
          src={streamGrant.url}
          title={t("streamTitle")}
          data-sandbox-stream={connectionId}
          data-stream-role={streamGrant.role}
          sandbox="allow-scripts allow-same-origin allow-pointer-lock"
          allow="fullscreen"
          referrerPolicy="no-referrer"
          className="block aspect-[16/10] w-full rounded border bg-black"
        />
      ) : frame ? (
        <div className="relative">
          {/* Native img preserves the screenshot pixel aspect ratio for pointer mapping. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={image}
            src={`data:${screenshotMimeType(frame.format)};base64,${frame.bytes}`}
            alt={t("screen")}
            width={frame.width}
            height={frame.height}
            tabIndex={controlling ? 0 : -1}
            draggable={false}
            className={`block h-auto w-full rounded border outline-none focus-visible:ring-2 focus-visible:ring-ring ${controlling ? "touch-none cursor-crosshair" : ""}`}
            onPointerDown={pointerDown}
            onPointerUp={pointerUp}
            onPointerCancel={() => {
              start.current = null
            }}
            onContextMenu={(event) => {
              if (controlling) event.preventDefault()
            }}
            onKeyDown={keyDown}
          />
          {controlling && touchScreen ? (
            <NativeTouchControls
              surface={touchSurface}
              width={frame.sourceWidth ?? frame.width}
              height={frame.sourceHeight ?? frame.height}
              labels={(key) => t(key)}
              input={(action, point) => {
                void input(action, point, frame.capturedAt)
              }}
            />
          ) : null}
        </div>
      ) : (
        <div className="rounded border p-6 text-center text-xs text-muted-foreground">
          {enabled ? (error ? t("disconnected") : t("loading")) : t("unavailable")}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!enabled} onClick={() => void refresh()}>
          {t("refresh")}
        </Button>
        <Button
          size="sm"
          disabled={
            !enabled ||
            (!frame && !controlling) ||
            (!controlling &&
              streaming &&
              streamStatus !== "open" &&
              streamStatus !== "unmonitored") ||
            acquiring ||
            transferring ||
            clipboardBusy ||
            mobileObservation ||
            (Boolean(openDesktop) && !controlling && !status?.canAcquire)
          }
          variant={controlling ? "secondary" : "outline"}
          onClick={() =>
            void (controlling
              ? release()
              : acquire(Boolean(openDesktop) || status?.controllerKind === "agent"))
          }
        >
          {acquiring ? t("acquiring") : controlling ? t("release") : t("takeControl")}
        </Button>
      </div>
      {controlling && streaming ? (
        <p className="text-xs text-muted-foreground">{t("streamControlHelp")}</p>
      ) : null}
      {controlling && !streaming ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("controlHelp")}</p>
          <Textarea
            aria-label={t("textLabel")}
            placeholder={t("textPlaceholder")}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-pressed={doubleClick}
              onClick={() => setDoubleClick((value) => !value)}
            >
              {t("doubleClick")}
            </Button>
            <Button size="sm" disabled={!text || sending} onClick={() => void sendText()}>
              {t("sendText")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (frame) void input({ kind: "pressKey", chord: "Escape" }, null, frame.capturedAt)
              }}
            >
              {t("sendEscape")}
            </Button>
          </div>
        </div>
      ) : null}
      {!openDesktop || managed ? (
        <SandboxFileTransfer
          key={`${connectionId}:${transferTargetId ?? containerId ?? ""}`}
          connectionId={connectionId}
          managed={managed}
          containerId={transferTargetId ?? containerId}
          defaultFolder={transferFolder}
          enabled={enabled && !clipboardBusy}
          releaseControl={release}
          onBusyChange={setTransferring}
        />
      ) : null}
      {managed ? (
        <section aria-label={t("clipboardTitle")} className="space-y-2">
          <h3 className="text-sm font-medium">{t("clipboardTitle")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(managed.operationsQualified ? "clipboardHelp" : "operationsDormant")}
          </p>
          <Textarea
            aria-label={t("clipboardText")}
            value={clipboard}
            disabled={!enabled || !managed.operationsQualified || clipboardBusy}
            onChange={(event) => setClipboard(event.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!enabled || !managed.operationsQualified || clipboardBusy || transferring}
            onClick={() => void transferClipboard(false)}
          >
            {t("clipboardGet")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!enabled || !managed.operationsQualified || clipboardBusy || transferring}
            onClick={() => void transferClipboard(true)}
          >
            {t("clipboardSet")}
          </Button>
          {clipboardError ? <p role="alert">{t("clipboardFailed")}</p> : null}
        </section>
      ) : null}
    </section>
  )
}
