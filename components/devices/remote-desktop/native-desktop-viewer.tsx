"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { prefersTouchInput } from "@cognia/plugin-ui"
import { Button } from "@/components/ui/button"
import {
  openNativeFrameStream,
  type NativeFrameStream,
  type NativeFrameStreamDeps,
} from "@/lib/remote-desktop/native-stream"
import type { NativeFrame, NativeUiAction } from "@/lib/remote-desktop/frames"
import type { RemoteDesktopHostRef } from "@/lib/remote-desktop/types"
import { NativeTouchControls } from "./native-touch-controls"
import type { Point } from "@/lib/automation/types"

/** Built-in broker viewer; cognia-frames is independent of plugin providers. */
export function NativeDesktopViewer({ host, targetId, deps }: NativeDesktopViewerProps) {
  const key = JSON.stringify([host.kind, host.kind === "remote" ? host.hostRef : null, targetId])
  return <NativeDesktopSession key={key} host={host} targetId={targetId} deps={deps} />
}

interface NativeDesktopViewerProps {
  host: RemoteDesktopHostRef
  targetId: `sandbox:${string}` | `managed-desktop:${string}`
  deps?: NativeFrameStreamDeps
}

function NativeDesktopSession({ host, targetId, deps }: NativeDesktopViewerProps) {
  const hostKind = host.kind
  const hostRef = host.kind === "remote" ? host.hostRef : null
  const stableHost = useMemo<RemoteDesktopHostRef>(
    () => (hostKind === "remote" ? { kind: "remote", hostRef: hostRef! } : { kind: "local" }),
    [hostKind, hostRef]
  )
  const t = useTranslations("remoteDesktop.native")
  const tErrors = useTranslations("remoteDesktop.errors")
  const [mode, setMode] = useState<"view" | "control">("view")
  const [connected, setConnected] = useState(false)
  const [failed, setFailed] = useState(false)
  const [screen, setScreen] = useState<{ frame: NativeFrame; src: string } | null>(null)
  const stream = useRef<NativeFrameStream | null>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const surface = useCallback(() => image.current, [])
  const down = useRef<Point | null>(null)
  const [touch] = useState(
    () =>
      prefersTouchInput() ||
      (typeof navigator !== "undefined" && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent))
  )
  const controlling = connected && mode === "control"
  useEffect(() => {
    let active = true
    let opened: NativeFrameStream | null = null
    let url: string | null = null
    let pixels: Uint8Array | null = null
    const controller = new AbortController()
    const release = () => {
      if (mode === "control") {
        opened?.close()
        setMode("view")
      }
    }
    const visibility = () => {
      if (document.hidden) release()
    }
    window.addEventListener("blur", release)
    document.addEventListener("visibilitychange", visibility)
    void (async () => {
      try {
        opened = await openNativeFrameStream(
          stableHost,
          targetId,
          {
            mode,
            takeover: mode === "control",
            signal: controller.signal,
            onReconnect: () => {
              if (active) setConnected(false)
            },
          },
          deps
        )
        if (!active) {
          opened.close()
          return
        }
        stream.current = opened
        for await (const frame of opened) {
          if (!active) break
          if (pixels !== frame.jpeg) {
            if (url) URL.revokeObjectURL(url)
            url = URL.createObjectURL(
              new Blob([new Uint8Array(frame.jpeg)], { type: "image/jpeg" })
            )
            pixels = frame.jpeg
          }
          setScreen({ frame, src: url! })
          setConnected(true)
          setFailed(false)
        }
        if (active) {
          setConnected(false)
          if (mode === "control") setMode("view")
        }
      } catch {
        if (active) {
          setFailed(true)
          setConnected(false)
          if (mode === "control") setMode("view")
        }
      }
    })()
    return () => {
      active = false
      controller.abort()
      opened?.close()
      stream.current = null
      if (url) URL.revokeObjectURL(url)
      window.removeEventListener("blur", release)
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [stableHost, targetId, mode, deps])
  const input = useCallback((action: NativeUiAction, point: Point | null) => {
    try {
      stream.current?.input({ action, point })
    } catch {
      stream.current?.close()
      setMode("view")
      setFailed(true)
    }
  }, [])
  const point = (x: number, y: number): Point | null => {
    const rect = image.current?.getBoundingClientRect()
    if (!rect?.width || !rect.height || !screen) return null
    return {
      x: Math.max(
        0,
        Math.min(
          screen.frame.width - 1,
          Math.floor(((x - rect.left) * screen.frame.width) / rect.width)
        )
      ),
      y: Math.max(
        0,
        Math.min(
          screen.frame.height - 1,
          Math.floor(((y - rect.top) * screen.frame.height) / rect.height)
        )
      ),
    }
  }
  useEffect(() => {
    const element = image.current
    if (!element || !controlling) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      if (!screen || !rect.width || !rect.height) return
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1
      input(
        {
          kind: "scroll",
          opts: { dx: Math.round(event.deltaX * unit), dy: Math.round(event.deltaY * unit) },
        },
        {
          x: Math.max(
            0,
            Math.min(
              screen.frame.width - 1,
              Math.floor(((event.clientX - rect.left) * screen.frame.width) / rect.width)
            )
          ),
          y: Math.max(
            0,
            Math.min(
              screen.frame.height - 1,
              Math.floor(((event.clientY - rect.top) * screen.frame.height) / rect.height)
            )
          ),
        }
      )
    }
    element.addEventListener("wheel", wheel, { passive: false })
    return () => element.removeEventListener("wheel", wheel)
  }, [controlling, screen, input])
  return (
    <section aria-label={t("title")} className="space-y-2">
      {failed ? <p role="alert">{tErrors("unavailable")}</p> : null}
      <div className="relative">
        {screen ? (
          <>
            {/* Native image coordinates use the original frame proof extent. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={image}
              src={screen.src}
              alt={t("screen")}
              width={screen.frame.width}
              height={screen.frame.height}
              className="block h-auto w-full rounded border"
              draggable={false}
              tabIndex={controlling ? 0 : -1}
              onPointerDown={(event) => {
                if (!controlling || touch) return
                event.preventDefault()
                event.currentTarget.focus()
                down.current = point(event.clientX, event.clientY)
                event.currentTarget.setPointerCapture?.(event.pointerId)
              }}
              onPointerUp={(event) => {
                const from = down.current
                down.current = null
                if (!controlling || !from) return
                const to = point(event.clientX, event.clientY)
                if (to)
                  input(
                    Math.hypot(from.x - to.x, from.y - to.y) > 4
                      ? { kind: "drag", to, opts: { button: "left" } }
                      : { kind: "click", button: event.button === 2 ? "right" : "left", count: 1 },
                    from
                  )
              }}
              onPointerCancel={() => {
                down.current = null
              }}
              onContextMenu={(event) => {
                if (controlling) event.preventDefault()
              }}
              onKeyDown={(event) => {
                if (
                  !controlling ||
                  event.nativeEvent.isComposing ||
                  ["Control", "Alt", "Shift", "Meta", "Dead", "Process", "Unidentified"].includes(
                    event.key
                  )
                )
                  return
                event.preventDefault()
                if (event.key === "Escape") {
                  setMode("view")
                  return
                }
                input(
                  event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey
                    ? { kind: "typeText", text: event.key }
                    : {
                        kind: "pressKey",
                        chord: [
                          event.ctrlKey && "ctrl",
                          event.altKey && "alt",
                          event.metaKey && "meta",
                          event.shiftKey && "shift",
                          event.key === " " ? "Space" : event.key === "+" ? "Plus" : event.key,
                        ]
                          .filter(Boolean)
                          .join("+"),
                      },
                  null
                )
              }}
            />
            {controlling && touch ? (
              <NativeTouchControls
                surface={surface}
                width={screen.frame.width}
                height={screen.frame.height}
                labels={t}
                input={input}
              />
            ) : null}
          </>
        ) : (
          <p role="status">{t("loading")}</p>
        )}
      </div>
      <Button
        size="sm"
        disabled={!connected}
        onClick={() => {
          setConnected(false)
          setMode((value) => (value === "view" ? "control" : "view"))
        }}
      >
        {controlling ? t("release") : t("takeControl")}
      </Button>
    </section>
  )
}
