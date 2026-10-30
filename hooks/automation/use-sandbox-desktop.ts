"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  sandboxClient,
  type SandboxControlLease,
  type SandboxDesktopFrame,
  type SandboxDesktopSession,
  type SandboxDesktopStatus,
  type OpenSandboxDesktop,
} from "@/lib/automation/sandbox-client"
import type { Point, Screenshot, UiAction } from "@/lib/automation/types"
import { openNativeFrameStream, type NativeFrameStream } from "@/lib/remote-desktop/native-stream"
import { LOCAL_REMOTE_DESKTOP_HOST } from "@/lib/remote-desktop/types"

export type SandboxDesktopError = "capture" | "control" | "input" | "release" | "session" | null
const POLL_MS = 1_000
/** While a Selkies stream shows the desktop, snapshots only gate control. */
export const STREAM_POLL_MS = 5_000
const MAX_FRAME_AGE_MS = 5_000

export interface SandboxDesktopOptions {
  /** A Selkies stream is on screen (ADR-0234 Phase 4); poll snapshots slowly. */
  streaming?: boolean
  /** Media liveness is verified. Only unmanaged, view-only sessions may idle. */
  streamHealthy?: boolean
  /**
   * The lease after acquisition, and `null` once it is released or lost. The
   * `null` comes after the Host answered the release, which revokes any stream
   * controller first.
   */
  onLeaseChange?: (lease: SandboxControlLease | null) => void
}

/** The stream frame of this connection holds focus inside this window. */
/**
 * The native window's focus as `WindowFocusTracker` mirrors it onto
 * `<html data-window-focused>`, or null where nothing mirrors it.
 */
function windowFocused(): boolean | null {
  const value = document.documentElement.dataset.windowFocused
  return value === undefined ? null : value === "true"
}

function focusInStream(connectionId: string): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLIFrameElement) || active.dataset.sandboxStream !== connectionId)
    return false
  // WebKit reports `document.hasFocus()` false while a cross-origin child
  // frame has focus, so on the desktop the native window focus tells working
  // in the stream apart from leaving the app.
  return windowFocused() ?? document.hasFocus()
}

/** The session closure owns all timers and leases, including late async completions. */
export function useSandboxDesktop(
  connectionId: string,
  enabled: boolean,
  openDesktop?: OpenSandboxDesktop,
  inputAllowed = true,
  options: SandboxDesktopOptions = {}
) {
  const [status, setStatus] = useState<SandboxDesktopStatus | null>(null)
  const [frame, setFrame] = useState<Screenshot | null>(null)
  const [controlling, setControlling] = useState(false)
  const [acquiring, setAcquiring] = useState(false)
  const [error, setError] = useState<SandboxDesktopError>(null)
  const [transport, setTransport] = useState<"stream" | "frames">("stream")
  // Read through refs: toggling the stream must not restart the session and
  // drop the lease.
  const streaming = useRef(Boolean(options.streaming))
  const streamHealthy = useRef(Boolean(options.streamHealthy))
  const presentation = useRef([Boolean(options.streaming), Boolean(options.streamHealthy)])
  const leaseChange = useRef(options.onLeaseChange)
  useLayoutEffect(() => {
    streaming.current = Boolean(options.streaming)
    streamHealthy.current = Boolean(options.streamHealthy)
    leaseChange.current = options.onLeaseChange
  })
  const session = useRef<{
    acquire: (takeover?: boolean) => Promise<void>
    release: (expectedLease?: SandboxControlLease) => Promise<void>
    refresh: () => Promise<void>
    presentationChanged: () => void
    input: (action: UiAction, point: Point | null, capturedAt: number) => Promise<boolean>
  } | null>(null)

  useEffect(() => {
    let alive = true
    let lease: SandboxControlLease | null = null
    let publishedLease: SandboxControlLease | null = null
    let releaseNotificationPending = false
    let acquiringLease = false
    let generation = 0
    let capturing = false
    let captureEpoch = 0
    let mutationPending = false
    let refreshPending = false
    let consumedFrameId: string | undefined
    let currentFrame: Screenshot | null = null
    let currentProof: SandboxDesktopFrame | null = null
    let controlStatus: SandboxDesktopStatus | null = null
    let invalidated = false
    let nativeMode: "opening" | "stream" | "frames" = "opening"
    let nativeController: AbortController | null = null
    let nativeStream: NativeFrameStream | null = null
    let nativePixels: { jpeg: Uint8Array; screenshot: Screenshot } | null = null
    let controllerFrame: { resolve: () => void; reject: () => void } | null = null
    let detachInvalidated: (() => void) | undefined
    let desktop: SandboxDesktopSession | null = openDesktop
      ? null
      : {
          managed: false,
          frame: () => sandboxClient.desktopFrame(connectionId),
          acquire: () => sandboxClient.acquireControl(connectionId, true),
          renew: (current) =>
            sandboxClient.renewControl(connectionId, current.token, current.fence),
          release: (current) =>
            sandboxClient.releaseControl(connectionId, current.token, current.fence),
          input: (current, proof, point, action) =>
            sandboxClient.controlInput(
              connectionId,
              current.token,
              current.fence,
              proof.frameId,
              point,
              action
            ),
          close: () => undefined,
        }
    let receivedAt = 0
    let poll: ReturnType<typeof setTimeout> | undefined
    let renewal: ReturnType<typeof setTimeout> | undefined
    let expiry: ReturnType<typeof setTimeout> | undefined
    let inputs: Promise<unknown> = Promise.resolve()
    // This transport talks to the client-local Tauri host. Losing an external
    // network connection does not make a local Docker desktop unavailable.
    const visible = () =>
      enabled && !invalidated && !document.hidden && (!openDesktop || navigator.onLine)

    const healthyObserver = () =>
      streaming.current &&
      streamHealthy.current &&
      desktop?.managed === false &&
      currentFrame !== null &&
      !lease &&
      !acquiringLease
    const scheduleRefresh = () => {
      clearTimeout(poll)
      // Native pixels/proofs arrive only on the stream. Managed status still
      // checks qualification and ownership through the existing session.
      if (nativeMode !== "frames" && !desktop?.status) return
      if (alive && visible() && (refreshPending || !healthyObserver()))
        poll = setTimeout(
          () => void refresh(),
          refreshPending ? 0 : streaming.current ? STREAM_POLL_MS : POLL_MS
        )
    }

    const publishReleased = () => {
      if (alive && releaseNotificationPending && !lease && !acquiringLease) {
        releaseNotificationPending = false
        publishedLease = null
        leaseChange.current?.(null)
      }
    }
    const published = (current: SandboxControlLease) =>
      publishedLease?.token === current.token && publishedLease.fence === current.fence

    const release = async (expectedLease?: SandboxControlLease) => {
      if (
        expectedLease &&
        (!lease || lease.token !== expectedLease.token || lease.fence !== expectedLease.fence)
      )
        return
      generation += 1
      const previous = lease
      lease = null
      controllerFrame?.reject()
      clearTimeout(renewal)
      clearTimeout(expiry)
      if (alive) {
        setControlling(false)
        setAcquiring(false)
      }
      if (previous) {
        try {
          await desktop?.release(previous)
        } catch {
          // The backend lease also expires, so a disconnected viewer cannot
          // retain control indefinitely. Never reuse a locally released token.
          if (alive && published(previous) && !lease && !acquiringLease) setError("release")
        }
        // A delayed release response belongs to its original lease/session,
        // never to control acquired while that response was in flight.
        if (published(previous)) releaseNotificationPending = true
      }
      publishReleased()
      scheduleRefresh()
    }

    const scheduleRenewal = () => {
      if (!lease) return
      const token = lease.token
      clearTimeout(expiry)
      expiry = setTimeout(() => void release(), Math.max(0, lease.expiresAt - Date.now()))
      renewal = setTimeout(async () => {
        try {
          const next = await desktop!.renew(lease!)
          if (!alive || lease?.token !== token || !visible()) return
          lease = next
          scheduleRenewal()
        } catch {
          if (!alive || lease?.token !== token) return
          await release()
          if (alive) setError("control")
        }
      }, 5_000)
    }

    const clearFrame = () => {
      currentFrame = null
      currentProof = null
      if (alive) setFrame(null)
    }
    const stopNativeStream = () => {
      const previous = nativeStream
      nativeStream = null
      nativeController?.abort()
      nativeController = null
      previous?.close()
      nativePixels = null
      if (nativeMode === "stream") nativeMode = "opening"
    }
    const startNativeStream = async () => {
      if (nativeController || !alive || !visible() || !desktop) return
      const controller = new AbortController()
      nativeController = controller
      const active = () => alive && visible() && !controller.signal.aborted
      let opened: NativeFrameStream
      try {
        opened = await openNativeFrameStream(
          LOCAL_REMOTE_DESKTOP_HOST,
          desktop.managed ? `managed-desktop:${connectionId}` : `sandbox:${connectionId}`,
          {
            signal: controller.signal,
            onReconnect: () => {
              if (!active()) return
              clearFrame()
              void release()
              setError("capture")
            },
          }
        )
      } catch {
        // Only an initial open failure enables the legacy frame poller.
        if (active()) {
          nativeMode = "frames"
          setTransport("frames")
          void refresh()
        }
        return
      }
      if (!active()) {
        opened.close()
        return
      }
      nativeStream = opened
      nativeMode = "stream"
      setTransport("stream")
      try {
        for await (const next of opened) {
          if (!active()) break
          if (
            mutationPending ||
            (desktop.managed &&
              (!controlStatus?.qualified ||
                ["dormant", "quarantined", "unavailable"].includes(controlStatus.state)))
          )
            continue
          // Acquiring advances the fence. Ignore an in-flight observer tick;
          // a changed fence after acquisition ends the current control lease.
          if (lease && next.fence !== lease.fence) {
            if (!controllerFrame) {
              clearFrame()
              void release()
            }
            continue
          }
          const expiresAt = next.capturedAtMs + MAX_FRAME_AGE_MS
          if (expiresAt <= Date.now()) continue
          if (nativePixels?.jpeg !== next.jpeg) {
            let binary = ""
            for (let offset = 0; offset < next.jpeg.length; offset += 8192)
              binary += String.fromCharCode(...next.jpeg.subarray(offset, offset + 8192))
            nativePixels = {
              jpeg: next.jpeg,
              screenshot: {
                bytes: btoa(binary),
                width: next.width,
                height: next.height,
                capturedAt: next.capturedAtMs,
                format: "jpeg",
              },
            }
          }
          // Header-only ticks retain the image (and its data URL) while
          // refreshing the single-use proof and local freshness deadline.
          currentFrame = nativePixels.screenshot
          currentProof = {
            screenshot: currentFrame,
            frameId: next.frameId,
            fence: next.fence,
            expiresAt,
          }
          receivedAt = Date.now()
          setFrame(currentFrame)
          setError((previous) => (previous === "capture" ? null : previous))
          controllerFrame?.resolve()
        }
      } catch {
        // Transport recovery belongs to openNativeFrameStream. A live stream
        // must never silently start a second frame source or regain control.
      } finally {
        if (active()) {
          clearFrame()
          void release()
          setError("capture")
        }
      }
    }

    const refresh = async () => {
      if (!alive || !visible() || !desktop) return
      if (capturing || mutationPending) {
        refreshPending = true
        return
      }
      refreshPending = false
      const requestedCaptureEpoch = captureEpoch
      clearTimeout(poll)
      capturing = true
      const requestedGeneration = generation
      let frameRpcFailed = false
      try {
        if (desktop.status) {
          controlStatus = await desktop.status()
          if (
            !alive ||
            !visible() ||
            generation !== requestedGeneration ||
            captureEpoch !== requestedCaptureEpoch
          )
            return
          setStatus(controlStatus)
          if (
            !controlStatus.qualified ||
            ["dormant", "quarantined", "unavailable"].includes(controlStatus.state)
          ) {
            currentFrame = null
            currentProof = null
            setFrame(null)
            if (lease) await release()
            return
          }
          if (lease && (!controlStatus.controllerIsSelf || controlStatus.fence !== lease.fence)) {
            if (controllerFrame) return
            await release()
            return
          }
        }
        if (nativeMode !== "frames") {
          if (nativeMode === "opening") void startNativeStream()
          return
        }
        const proof = await desktop.frame().catch((error: unknown) => {
          frameRpcFailed = true
          throw error
        })
        const next = proof.screenshot
        if (
          !alive ||
          !visible() ||
          generation !== requestedGeneration ||
          captureEpoch !== requestedCaptureEpoch
        )
          return
        if (
          !proof.frameId ||
          !Number.isFinite(proof.expiresAt) ||
          proof.expiresAt <= Date.now() ||
          (lease && proof.fence !== lease.fence)
        )
          throw new Error("Invalid frame proof")
        currentProof = proof
        if (!next.bytes || next.width <= 0 || next.height <= 0) throw new Error("Invalid frame")
        currentFrame = next
        receivedAt = Date.now()
        setFrame(next)
        setError((previous) => (previous === "capture" ? null : previous))
      } catch {
        if (!alive || generation !== requestedGeneration || captureEpoch !== requestedCaptureEpoch)
          return
        currentFrame = null
        currentProof = null
        setFrame(null)
        // Selkies input is fenced by the Host lease, independently of this
        // auxiliary screenshot RPC. Keep that lease while renewals succeed;
        // invalid frame proofs and all screenshot-only failures still release.
        if (!frameRpcFailed || !streaming.current || desktop.managed) await release()
        if (alive) setError("capture")
      } finally {
        capturing = false
        scheduleRefresh()
      }
    }

    const acquire = async (takeover = false) => {
      if (
        !alive ||
        !visible() ||
        !inputAllowed ||
        !desktop ||
        lease ||
        acquiringLease ||
        !currentFrame ||
        (desktop.managed && !controlStatus?.canAcquire)
      )
        return
      const requestedGeneration = generation
      acquiringLease = true
      setAcquiring(true)
      setError(null)
      try {
        const next = await desktop.acquire(takeover)
        if (!alive || !visible() || generation !== requestedGeneration) {
          await desktop.release(next)
          return
        }
        lease = next
        scheduleRenewal()
        // Fence invalidates every observer frame. A capture begun before
        // acquisition must never overwrite the fresh controller frame.
        generation += 1
        currentFrame = null
        currentProof = null
        setFrame(null)
        const acquiredGeneration = generation
        if (nativeMode !== "frames") {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => controllerFrame?.reject(), MAX_FRAME_AGE_MS)
            const finish = (ready: boolean) => {
              clearTimeout(timer)
              controllerFrame = null
              if (ready) resolve()
              else reject(new Error("Controller frame unavailable"))
            }
            controllerFrame = { resolve: () => finish(true), reject: () => finish(false) }
          })
        } else {
          const proof = await desktop.frame()
          if (
            !alive ||
            !visible() ||
            generation !== acquiredGeneration ||
            lease?.token !== next.token
          )
            return
          if (
            !proof.frameId ||
            !Number.isFinite(proof.expiresAt) ||
            proof.fence !== next.fence ||
            proof.expiresAt! <= Date.now() ||
            !proof.screenshot.bytes ||
            proof.screenshot.width <= 0 ||
            proof.screenshot.height <= 0
          )
            throw new Error("Invalid controller frame")
          currentProof = proof
          currentFrame = proof.screenshot
          receivedAt = Date.now()
          setFrame(proof.screenshot)
        }
        if (
          !alive ||
          !visible() ||
          generation !== acquiredGeneration ||
          lease?.token !== next.token
        )
          return
        setControlling(true)
        publishedLease = next
        releaseNotificationPending = false
        leaseChange.current?.(next)
      } catch {
        await release()
        if (alive) setError("control")
      } finally {
        acquiringLease = false
        if (alive) setAcquiring(false)
        publishReleased()
        scheduleRefresh()
      }
    }

    const input = (action: UiAction, point: Point | null, capturedAt: number): Promise<boolean> => {
      const token = lease?.token
      const requestedGeneration = generation
      const observedFrame = currentFrame
      const observedProof = currentProof
      const inputLease = lease
      // Validate the pixels the user acted on when accepting the event. A
      // newer capture must not discard already accepted keyboard input.
      if (
        !inputAllowed ||
        !observedProof ||
        !observedFrame ||
        observedFrame.capturedAt !== capturedAt ||
        Date.now() - receivedAt > MAX_FRAME_AGE_MS
      )
        return Promise.resolve(false)
      const result = inputs.then(async () => {
        if (
          !alive ||
          !visible() ||
          !token ||
          lease?.token !== token ||
          generation !== requestedGeneration ||
          Date.now() >= lease.expiresAt ||
          !currentFrame ||
          (point !== null &&
            (currentFrame.width !== observedFrame.width ||
              currentFrame.height !== observedFrame.height ||
              currentFrame.sourceWidth !== observedFrame.sourceWidth ||
              currentFrame.sourceHeight !== observedFrame.sourceHeight)) ||
          Date.now() - receivedAt > MAX_FRAME_AGE_MS
        )
          return false
        try {
          if (
            !inputLease ||
            !observedProof ||
            !desktop ||
            observedProof.expiresAt <= Date.now() ||
            observedProof.fence !== inputLease.fence
          )
            return false
          // The Host consumes every frame proof after one mutation. A queued
          // event must not reuse that proof or adopt newer coordinates.
          if (currentProof !== observedProof || observedProof.frameId === consumedFrameId)
            return false
          consumedFrameId = observedProof.frameId
          currentProof = null
          captureEpoch += 1
          mutationPending = true
          try {
            await desktop.input(inputLease, observedProof, point, action)
          } finally {
            mutationPending = false
          }
          await refresh()
          return true
        } catch {
          await release()
          if (alive) setError("input")
          return false
        }
      })
      inputs = result
      return result
    }

    const visibilityChanged = () => {
      if (!visible()) {
        clearTimeout(poll)
        stopNativeStream()
        clearFrame()
        void release()
      } else void refresh()
    }
    // Focus moving into this desktop's stream frame blurs the window too; that
    // is the user starting to work, not leaving.
    const blur = () =>
      setTimeout(() => {
        if (!focusInStream(connectionId)) void release()
      }, 0)
    const invalidate = () => {
      invalidated = true
      clearTimeout(poll)
      stopNativeStream()
      currentFrame = null
      currentProof = null
      if (alive) {
        setFrame(null)
        setStatus(null)
        setError("session")
      }
      void release()
    }
    const networkChanged = () => {
      if (openDesktop) visibilityChanged()
    }
    const presentationChanged = () => {
      clearTimeout(poll)
      // Resuming native/legacy observation needs a fresh proof immediately,
      // independently of the previous slow-stream polling deadline.
      if (!healthyObserver()) void refresh()
    }
    session.current = { acquire, release, refresh, input, presentationChanged }
    const initial = setTimeout(() => {
      setFrame(null)
      setControlling(false)
      setError(null)
      setStatus(null)
      setTransport("stream")
      if (openDesktop && enabled) {
        void openDesktop()
          .then((opened) => {
            if (!alive) {
              opened.close()
              return
            }
            desktop = opened
            detachInvalidated = opened.onInvalidated?.(invalidate)
            void refresh()
          })
          .catch(() => {
            if (alive) {
              invalidate()
              setError("capture")
            }
          })
      } else void refresh()
    }, 0)
    // With focus inside the stream frame, leaving the app fires no `blur`
    // here; the native window losing focus gives control back instead.
    const windowFocus =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            if (windowFocused() === false) void release()
          })
    windowFocus?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-window-focused"],
    })
    document.addEventListener("visibilitychange", visibilityChanged)
    window.addEventListener("blur", blur)
    window.addEventListener("offline", networkChanged)
    window.addEventListener("online", networkChanged)
    return () => {
      alive = false
      session.current = null
      clearTimeout(initial)
      clearTimeout(poll)
      stopNativeStream()
      void release().finally(() => desktop?.close())
      detachInvalidated?.()
      windowFocus?.disconnect()
      document.removeEventListener("visibilitychange", visibilityChanged)
      window.removeEventListener("blur", blur)
      window.removeEventListener("offline", networkChanged)
      window.removeEventListener("online", networkChanged)
    }
  }, [connectionId, enabled, openDesktop, inputAllowed])

  useEffect(() => {
    const next = [Boolean(options.streaming), Boolean(options.streamHealthy)]
    if (presentation.current.every((value, index) => value === next[index])) return
    presentation.current = next
    session.current?.presentationChanged()
  }, [options.streaming, options.streamHealthy])

  const acquire = useCallback((takeover = false) => session.current?.acquire(takeover), [])
  const release = useCallback(
    (expectedLease?: SandboxControlLease) => session.current?.release(expectedLease),
    []
  )
  const refresh = useCallback(() => session.current?.refresh(), [])
  const input = useCallback(
    (action: UiAction, point: Point | null, capturedAt: number) =>
      session.current?.input(action, point, capturedAt) ?? Promise.resolve(false),
    []
  )
  return {
    status,
    frame: enabled ? frame : null,
    controlling: enabled && controlling,
    acquiring,
    error,
    transport,
    acquire,
    release,
    refresh,
    input,
  }
}
