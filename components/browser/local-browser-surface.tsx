"use client"

/** Shared low-level surface only: no history, agent, vault or browser chrome. */
import {
  useCallback,
  useEffect,
  useRef,
  type RefObject,
  type KeyboardEvent,
  type PointerEvent,
} from "react"
import { localBrowser } from "@/lib/browser/local-client"
import { createFramePainter, type FramePainter } from "@/lib/browser/frame-painter"
import type { LocalViewport, LocalViewportResult } from "@/lib/browser/local-viewport-scheduler"
import { createLocalInputQueue, type LocalInputQueue } from "@/lib/browser/local-input-queue"
import {
  canvasPointToFrame,
  decodeRemoteBrowserFrame,
  type RemoteBrowserFrame,
} from "@/lib/browser/remote-stream"

export interface FrameCanvas {
  canvasRef: RefObject<HTMLCanvasElement | null>
  frameSizeRef: RefObject<{ width: number; height: number }>
  drawFrame: (bytes: Uint8Array) => void
  resetPage: () => void
  requestViewport: (viewport: LocalViewport) => void
  applyViewport: (viewport: LocalViewport, result: LocalViewportResult | void) => void
}

/** The canvas the screencast is drawn into (`createFramePainter`). */
export function useFrameCanvas(): FrameCanvas {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameSizeRef = useRef({ width: 1, height: 1 })
  // Made on the first frame and dropped on unmount (a remount makes another).
  const painterRef = useRef<FramePainter | null>(null)
  const activeRef = useRef(false)
  const viewportRef = useRef<{
    width: number
    height: number
    ready: boolean
    after: number
  } | null>(null)
  const candidateRef = useRef<RemoteBrowserFrame | null>(null)
  const resetPage = useCallback(() => {
    painterRef.current?.dispose()
    painterRef.current = null
    viewportRef.current = null
    candidateRef.current = null
    frameSizeRef.current = { width: 1, height: 1 }
    if (canvasRef.current) {
      canvasRef.current.style.opacity = "0"
      canvasRef.current.style.pointerEvents = "none"
      canvasRef.current.dataset.viewportReady = "false"
    }
  }, [])
  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      painterRef.current?.dispose()
      painterRef.current = null
      candidateRef.current = null
    }
  }, [])
  const paint = useCallback((frame: RemoteBrowserFrame) => {
    if (!activeRef.current) return
    painterRef.current ??= createFramePainter(() => canvasRef.current, undefined, {
      canPaint: (next) => {
        const viewport = viewportRef.current
        return (
          !!viewport?.ready &&
          next.width === viewport.width &&
          next.height === viewport.height &&
          next.sequence > viewport.after
        )
      },
      onPaint: (next) => {
        frameSizeRef.current = { width: next.width, height: next.height }
        if (canvasRef.current) {
          canvasRef.current.style.opacity = "1"
          canvasRef.current.style.pointerEvents = "auto"
          canvasRef.current.dataset.viewportReady = "true"
        }
      },
    })
    painterRef.current.paint(frame)
  }, [])
  const requestViewport = useCallback((viewport: LocalViewport) => {
    viewportRef.current = { ...viewport, ready: false, after: viewportRef.current?.after ?? -1 }
    candidateRef.current = null
  }, [])
  const applyViewport = useCallback(
    (viewport: LocalViewport, result: LocalViewportResult | void) => {
      const current = viewportRef.current
      if (!current || current.width !== viewport.width || current.height !== viewport.height) return
      current.ready = true
      if (typeof result?.frameSequence === "number") current.after = result.frameSequence
      const candidate = candidateRef.current
      candidateRef.current = null
      if (candidate) paint(candidate)
    },
    [paint]
  )
  const drawFrame = useCallback(
    (bytes: Uint8Array) => {
      let frame
      try {
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        frame = decodeRemoteBrowserFrame(buffer as ArrayBuffer)
      } catch {
        return
      }
      if (!activeRef.current) return
      const viewport = viewportRef.current
      if (!viewport || frame.width !== viewport.width || frame.height !== viewport.height) return
      // The only fresh damage frame can beat the viewport RPC response.
      if (!viewport.ready) candidateRef.current = frame
      else paint(frame)
    },
    [paint]
  )
  return { canvasRef, frameSizeRef, drawFrame, resetPage, requestViewport, applyViewport }
}

export function LocalBrowserCanvas({
  canvas,
  sessionId,
  pageId,
  ready,
  label,
  onPointerPress,
  onKeyDown,
  onError,
}: {
  canvas: FrameCanvas
  sessionId: string | null
  pageId?: string
  ready: boolean
  label: string
  onPointerPress?: (event: PointerEvent<HTMLCanvasElement>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLCanvasElement>) => boolean
  onError?: (error: unknown) => void
}) {
  const { canvasRef } = canvas
  const attachCanvas = useCallback(
    (element: HTMLCanvasElement | null) => {
      canvasRef.current = element
    },
    [canvasRef]
  )
  const queue = useRef<{ target: string; queue: LocalInputQueue } | null>(null)
  const composing = useRef(false)
  useEffect(
    () => () => {
      queue.current?.queue.dispose()
      queue.current = null
    },
    [sessionId, pageId]
  )
  const send = (input: Parameters<LocalInputQueue["send"]>[0]) => {
    if (!ready || !sessionId) return
    const target = `${sessionId}:${pageId ?? ""}`
    if (queue.current?.target !== target) {
      queue.current?.queue.dispose()
      queue.current = {
        target,
        queue: createLocalInputQueue((next) =>
          localBrowser
            .rpc("browser.input", { sessionId, ...(pageId ? { pageId } : {}), input: next })
            .catch((error) => {
              onError?.(error)
              throw error
            })
        ),
      }
    }
    queue.current.queue.send(input)
  }
  const point = (event: {
    clientX: number
    clientY: number
    button: number
    currentTarget: HTMLCanvasElement
  }) => ({
    ...canvasPointToFrame(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      canvas.frameSizeRef.current
    ),
    button: event.button === 1 ? "middle" : event.button === 2 ? "right" : "left",
    clickCount: 1,
  })
  const key = (event: KeyboardEvent<HTMLCanvasElement>, type: "keyDown" | "keyUp") => {
    if (
      !ready ||
      composing.current ||
      event.nativeEvent.isComposing ||
      event.key === "Process" ||
      event.keyCode === 229
    )
      return
    event.preventDefault()
    send({
      kind: "key",
      payload: {
        type,
        key: event.key,
        code: event.code,
        modifiers:
          (event.altKey ? 1 : 0) |
          (event.ctrlKey ? 2 : 0) |
          (event.metaKey ? 4 : 0) |
          (event.shiftKey ? 8 : 0),
        ...(type === "keyDown" && event.key.length === 1 ? { text: event.key } : {}),
      },
    })
  }
  return (
    <canvas
      ref={attachCanvas}
      style={{ opacity: 0, pointerEvents: "none" }}
      tabIndex={0}
      role="application"
      aria-label={label}
      contentEditable
      suppressContentEditableWarning
      className="absolute inset-0 h-full w-full object-contain outline-none"
      onPointerMove={(event) =>
        send({ kind: "mouse", payload: { type: "mouseMoved", ...point(event) } })
      }
      onPointerDown={(event) => {
        event.currentTarget.focus()
        if (!ready) return
        onPointerPress?.(event)
        send({ kind: "mouse", payload: { type: "mousePressed", ...point(event) } })
      }}
      onPointerUp={(event) =>
        send({ kind: "mouse", payload: { type: "mouseReleased", ...point(event) } })
      }
      onWheel={(event) =>
        send({
          kind: "mouse",
          payload: {
            type: "mouseWheel",
            ...point(event as unknown as PointerEvent<HTMLCanvasElement>),
            deltaX: event.deltaX,
            deltaY: event.deltaY,
          },
        })
      }
      onKeyDown={(event) => {
        if (!onKeyDown?.(event)) key(event, "keyDown")
      }}
      onKeyUp={(event) => key(event, "keyUp")}
      onCompositionStart={() => {
        composing.current = true
      }}
      onCompositionEnd={(event) => {
        composing.current = false
        if (event.data) send({ kind: "key", payload: { type: "char", text: event.data } })
        event.currentTarget.textContent = ""
      }}
      onBeforeInput={(event) => event.preventDefault()}
    />
  )
}
