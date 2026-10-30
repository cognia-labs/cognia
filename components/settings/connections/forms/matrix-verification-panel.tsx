"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { getBus } from "@/lib/connectors/bus"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import {
  decodeMatrixVerificationFile,
  decodeMatrixVerificationPixels,
} from "@/lib/connectors/adapters/matrix/verification-qr"

type Api = NonNullable<PlatformAdapter["verification"]>
type State = Awaited<ReturnType<Api["interact"]>>
type InputAction = Parameters<Api["interact"]>[0]["action"] | "refreshTrust"
type Flow = { api: Api; state: State }

export function MatrixVerificationPanel({
  adapterId,
  available,
}: {
  adapterId: string
  available: boolean
}) {
  const t = useTranslations("settings.connections.matrix.verification")
  const id = useId()
  const [userId, setUserId] = useState("")
  const [deviceId, setDeviceId] = useState("")
  const [flow, setFlow] = useState<Flow | null>(null)
  const [requests, setRequests] = useState<{
    api: Api
    states: Awaited<ReturnType<Api["pending"]>>
  } | null>(null)
  const [failedAction, setFailedAction] = useState(false)
  const failed = useRef<{
    api: Api
    action: InputAction
    selected?: State
    bytes?: number[]
  } | null>(null)
  const cameraGeneration = useRef(0)
  const cameraPending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [qr, setQr] = useState<State["qrImage"]>(undefined)
  const [camera, setCamera] = useState(false)
  const owner = useRef(0)
  const currentFlow = useRef<Flow | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const image = useRef<State["qrImage"]>(undefined)

  const inFlight = useRef(false)
  const apiNow = useCallback(() => getBus().getAdapter(adapterId)?.verification, [adapterId])
  const clearImage = useCallback(() => {
    image.current?.modules.fill(false)
    image.current = undefined
    setQr(undefined)
  }, [])
  const clearFailure = useCallback(() => {
    failed.current?.bytes?.fill(0)
    failed.current = null
    setFailedAction(false)
  }, [])
  const stopCamera = useCallback(() => {
    cameraGeneration.current += 1
    cameraPending.current = false
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
    setCamera(false)
  }, [])
  const publish = useCallback((next: Flow) => {
    currentFlow.current = next
    setFlow(next)
  }, [])

  useEffect(() => {
    return () => {
      owner.current += 1
      failed.current?.bytes?.fill(0)
      cameraGeneration.current += 1
      image.current?.modules.fill(false)
      stream.current?.getTracks().forEach((track) => track.stop())
    }
  }, [adapterId])

  const run = useCallback(
    async (action: InputAction, selected?: State, qrBytes?: number[], expectedApi?: Api) => {
      if (inFlight.current) {
        qrBytes?.fill(0)
        return
      }
      const api = apiNow()
      const before = selected ?? currentFlow.current?.state
      const generation = owner.current
      if (
        !available ||
        !api ||
        (expectedApi && expectedApi !== api) ||
        (currentFlow.current && currentFlow.current.api !== api)
      ) {
        qrBytes?.fill(0)
        owner.current += 1
        clearFailure()
        clearImage()
        stopCamera()
        currentFlow.current = null
        setFlow(null)
        setError(t("unavailable"))
        return
      }
      clearFailure()
      stopCamera()
      inFlight.current = true
      setBusy(true)
      setError(null)
      try {
        const result =
          action === "refreshTrust" && before
            ? await api.refreshTrust(before.userId, before.flowId)
            : await api.interact({
                action: action as Exclude<InputAction, "refreshTrust">,
                userId: before?.userId ?? userId.trim(),
                deviceId: (before?.deviceId ?? deviceId.trim()) || undefined,
                flowId: before?.flowId,
                qrBytes,
              })
        const { qrBytes: secret, qrImage, ...publicState } = result
        secret?.fill(0)
        if (owner.current !== generation || apiNow() !== api) {
          qrImage?.modules.fill(false)
          return
        }
        if (qrImage) {
          clearImage()
          image.current = qrImage
          setQr(qrImage)
        }
        if (result.state === "done" || result.state === "cancelled") {
          clearImage()
          stopCamera()
        }
        publish({ api, state: publicState })
      } catch {
        if (owner.current === generation && apiNow() === api) {
          failed.current = { api, action, selected: before, bytes: qrBytes?.slice() }
          setFailedAction(true)
          setError(t("failed"))
        }
      } finally {
        qrBytes?.fill(0)
        inFlight.current = false
        if (owner.current === generation) setBusy(false)
      }
    },
    [apiNow, available, clearFailure, clearImage, deviceId, publish, stopCamera, t, userId]
  )

  // Poll only observations. Confirmation always requires an explicit action.
  useEffect(() => {
    if (failedAction || !flow || flow.state.state === "done" || flow.state.state === "cancelled")
      return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const update = async () => {
      try {
        if (apiNow() !== flow.api) {
          clearImage()
          stopCamera()
          currentFlow.current = null
          setFlow(null)
          setError(t("unavailable"))
          return
        }
        if (inFlight.current) {
          timer = setTimeout(update, 1000)
          return
        }
        const state = await flow.api.interact({
          action: "status",
          userId: flow.state.userId,
          flowId: flow.state.flowId,
        })
        if (!disposed && apiNow() === flow.api) {
          if (state.state === "done" || state.state === "cancelled") {
            clearImage()
            stopCamera()
          }
          publish({ api: flow.api, state })
        }
      } catch {
        if (!disposed) setError(t("failed"))
      }
      if (!disposed) timer = setTimeout(update, 1000)
    }
    timer = setTimeout(update, 1000)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [failedAction, flow, apiNow, clearImage, publish, stopCamera, t])

  async function discover() {
    const api = apiNow()
    const generation = owner.current
    if (!api || !available) {
      setError(t("unavailable"))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const next = await api.pending(userId.trim())
      if (generation === owner.current && apiNow() === api) setRequests({ api, states: next })
    } catch {
      if (generation === owner.current) setError(t("failed"))
    } finally {
      if (generation === owner.current) setBusy(false)
    }
  }

  async function readImage(file: File) {
    const generation = owner.current
    const before = currentFlow.current
    if (inFlight.current || !before) return
    stopCamera()
    setBusy(true)
    try {
      const bytes = await decodeMatrixVerificationFile(file)
      if (
        generation !== owner.current ||
        currentFlow.current?.state.flowId !== before.state.flowId ||
        apiNow() !== before.api ||
        !["ready", "qr"].includes(currentFlow.current?.state.state ?? "")
      ) {
        bytes.fill(0)
        return
      }
      await run("scanQr", undefined, bytes)
    } catch {
      if (generation === owner.current) setError(t("invalidQr"))
    } finally {
      if (generation === owner.current) setBusy(false)
    }
  }

  async function startCamera() {
    const generation = owner.current
    const before = currentFlow.current
    if (!before || stream.current || cameraPending.current) return
    cameraPending.current = true
    const cameraRequest = ++cameraGeneration.current
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      })
      if (
        cameraRequest !== cameraGeneration.current ||
        generation !== owner.current ||
        currentFlow.current?.state.flowId !== before.state.flowId ||
        !["ready", "qr"].includes(currentFlow.current?.state.state ?? "") ||
        apiNow() !== before.api
      ) {
        media.getTracks().forEach((track) => track.stop())
        return
      }
      cameraPending.current = false
      stream.current = media
      setCamera(true)
    } catch {
      if (generation === owner.current && cameraRequest === cameraGeneration.current) {
        cameraPending.current = false
        setError(t("cameraFailed"))
      }
    }
  }
  useEffect(() => {
    if (!camera || !video.current || !stream.current) return
    const element = video.current
    const media = stream.current
    const scanGeneration = cameraGeneration.current
    const scanFlow = currentFlow.current
    let disposed = false
    element.srcObject = media
    void element.play().catch(() => {
      if (!disposed && stream.current === media) {
        stopCamera()
        setError(t("cameraFailed"))
      }
    })
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d", { willReadFrequently: true })
    let frame = 0,
      last = 0
    const scan = (time: number) => {
      if (disposed || scanGeneration !== cameraGeneration.current) return
      if (
        !scanFlow ||
        apiNow() !== scanFlow.api ||
        currentFlow.current?.state.flowId !== scanFlow.state.flowId ||
        !["ready", "qr"].includes(currentFlow.current?.state.state ?? "")
      ) {
        if (stream.current === media) stopCamera()
        return
      }
      if (context && element.readyState >= 2 && time - last >= 150) {
        last = time
        canvas.width = Math.min(element.videoWidth, 640)
        canvas.height = Math.round((element.videoHeight * canvas.width) / element.videoWidth)
        context.drawImage(element, 0, 0, canvas.width, canvas.height)
        try {
          const bytes = decodeMatrixVerificationPixels(
            context.getImageData(0, 0, canvas.width, canvas.height).data,
            canvas.width,
            canvas.height
          )
          stopCamera()
          void run("scanQr", undefined, bytes)
          return
        } catch {
          /* Continue until a Matrix QR image is visible. */
        }
      }
      frame = requestAnimationFrame(scan)
    }
    frame = requestAnimationFrame(scan)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      element.srcObject = null
    }
  }, [apiNow, camera, run, stopCamera, t])

  const state = flow?.state
  const terminal = state?.state === "done" || state?.state === "cancelled"
  const lockedFields = failedAction || Boolean(state && !terminal)
  const canConfirm = Boolean(
    state?.decimals?.length === 3 && !state.confirmed && state.state === "sas"
  )
  return (
    <section aria-label={t("title")} className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-user`}>{t("peerUser")}</FieldLabel>
          <Input
            id={`${id}-user`}
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            disabled={!available || busy || lockedFields}
            placeholder={t("peerPlaceholder")}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-device`}>{t("peerDevice")}</FieldLabel>
          <Input
            id={`${id}-device`}
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
            disabled={!available || busy || lockedFields}
          />
        </Field>
      </FieldGroup>
      {!state && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={!available || busy || !userId.trim() || !deviceId.trim()}
            onClick={() => void run("request")}
          >
            {t("request")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!available || busy || !userId.trim()}
            onClick={() => void discover()}
          >
            {t("discover")}
          </Button>
        </div>
      )}
      {!state &&
        requests?.states.map((request) => (
          <Button
            type="button"
            variant="outline"
            key={request.flowId}
            disabled={busy || failedAction}
            onClick={() => void run("accept", request as State, undefined, requests.api)}
          >
            {t("acceptRequest", { device: request.deviceId ?? request.flowId })}
          </Button>
        ))}
      {state && (
        <div className="space-y-3">
          <p role="status">{t(`state.${state.state}`)}</p>
          <p className="break-all font-mono text-xs">
            {state.userId} / {state.deviceId}
          </p>
          {state.state === "ready" && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={busy || failedAction}
                onClick={() => void run("startSas")}
              >
                {t("startSas")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy || failedAction}
                onClick={() => void run("generateQr")}
              >
                {t("showQr")}
              </Button>
            </div>
          )}
          {state.state === "sas" && !state.decimals && !state.sasStartedByUs && (
            <Button
              type="button"
              disabled={busy || failedAction}
              onClick={() => void run("acceptSas")}
            >
              {t("acceptSas")}
            </Button>
          )}
          {state.decimals && state.state === "sas" && (
            <div>
              <p>{t("compareSas")}</p>
              <output
                aria-label={t("sasCode")}
                className="block py-3 font-mono text-2xl tracking-widest"
              >
                {state.decimals.join(" · ")}
              </output>
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={busy || failedAction || !canConfirm}
                  onClick={() => void run("confirmSas")}
                >
                  {t("match")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || failedAction || Boolean(state.confirmed)}
                  onClick={() => void run("cancel")}
                >
                  {t("mismatch")}
                </Button>
              </div>
            </div>
          )}
          {qr && !terminal && (
            <svg
              role="img"
              aria-label={t("qrImage")}
              viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}
              width="256"
              height="256"
              shapeRendering="crispEdges"
            >
              <rect width="100%" height="100%" fill="white" />
              <path
                fill="black"
                d={qr.modules
                  .map((dark, index) =>
                    dark
                      ? `M${(index % qr.size) + 4},${Math.floor(index / qr.size) + 4}h1v1h-1z`
                      : ""
                  )
                  .join("")}
              />
            </svg>
          )}
          {(state.state === "ready" || state.state === "qr") && !state.confirmed && (
            <div className="space-y-2">
              <Field>
                <FieldLabel htmlFor={`${id}-image`}>{t("uploadQr")}</FieldLabel>
                <Input
                  id={`${id}-image`}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={busy || failedAction}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ""
                    if (file) void readImage(file)
                  }}
                />
              </Field>
              <Button
                type="button"
                variant="outline"
                disabled={busy || failedAction || camera}
                onClick={() => void startCamera()}
              >
                {t("camera")}
              </Button>
            </div>
          )}
          {camera && (
            <div>
              <video
                ref={video}
                muted
                playsInline
                aria-label={t("cameraPreview")}
                className="max-w-full"
              />
              <Button type="button" variant="outline" onClick={stopCamera}>
                {t("stopCamera")}
              </Button>
            </div>
          )}
          {state.state === "qr" && state.scanned && !state.confirmed && (
            <Button
              type="button"
              disabled={busy || failedAction}
              onClick={() => void run("confirmQr")}
            >
              {t("confirmScan")}
            </Button>
          )}
          {state.state === "done" && <p>{t(state.deviceVerified ? "trusted" : "proofComplete")}</p>}
          {state.state === "done" && !state.deviceVerified && (
            <Button
              type="button"
              disabled={busy || failedAction}
              onClick={() => void run("refreshTrust")}
            >
              {t("refreshTrust")}
            </Button>
          )}
          {!terminal && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void run("cancel")}
            >
              {t("cancel")}
            </Button>
          )}
          {terminal && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                owner.current += 1
                clearFailure()
                clearImage()
                currentFlow.current = null
                setFlow(null)
                setRequests(null)
                setError(null)
              }}
            >
              {t("newFlow")}
            </Button>
          )}
        </div>
      )}
      {!available && <p>{t("unavailable")}</p>}
      {failedAction && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            const retry = failed.current
            if (retry) void run(retry.action, retry.selected, retry.bytes?.slice(), retry.api)
          }}
        >
          {t("retry")}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
