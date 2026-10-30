"use client"

import { useEffect, useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { pickStreamFiles } from "@/lib/files/file-bridge"
import { saveExport } from "@/lib/files/save-export"
import { decodeBase64, encodeBase64 } from "@/lib/share/encoding"
import { MAX_SANDBOX_TRANSFER_BYTES, sandboxClient } from "@/lib/automation/sandbox-client"
import {
  openManagedDesktop,
  type ManagedDesktopOperationSession,
  type ManagedDesktopTarget,
  type ManagedDesktopRef,
} from "@/lib/automation/managed-desktop-client"
import { lumeFailureKind } from "@/lib/automation/lume-client"

type Notice =
  | "cancelled"
  | "uploaded"
  | "downloaded"
  | "tooLarge"
  | "readFailed"
  | "saveFailed"
  | "uploadFailed"
  | "downloadFailed"
  | "invalidPath"
  | "invalidPayload"
  | "writers"
  | null

function absolutePath(value: string): boolean {
  return value.startsWith("/") && !value.includes("\0") && !value.split("/").includes("..")
}

export interface ManagedDesktopTransferTarget {
  target: ManagedDesktopTarget
  ref: ManagedDesktopRef
  operationsQualified: boolean
}
interface SandboxFileTransferProps {
  managed?: ManagedDesktopTransferTarget
  connectionId: string
  containerId?: string
  defaultFolder?: string
  enabled: boolean
  releaseControl: () => Promise<void> | undefined
  onBusyChange: (busy: boolean) => void
}

/** A bounded single-file transfer, scoped to the container selected before any native dialog. */
export function SandboxFileTransfer(props: SandboxFileTransferProps) {
  return (
    <SandboxFileTransferSession
      key={`${props.connectionId}:${props.containerId ?? ""}:${props.enabled}:${props.managed?.ref.desktopId ?? ""}:${props.managed?.ref.generation ?? ""}:${props.managed?.operationsQualified ?? false}:${props.managed?.target.kind === "remote" ? props.managed.target.hostId : "local"}`}
      {...props}
    />
  )
}

function SandboxFileTransferSession({
  connectionId,
  managed,
  containerId,
  defaultFolder = "/home/cua",
  enabled,
  releaseControl,
  onBusyChange,
}: SandboxFileTransferProps) {
  const t = useTranslations("automation.sandboxConnections.fileTransfer")
  const lumeErrors = useTranslations("automation.lume.errors")
  const id = useId()
  const [folder, setFolder] = useState(defaultFolder)
  const [downloadPath, setDownloadPath] = useState("")
  const [busy, setBusy] = useState<"upload" | "download" | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const lifetime = useRef({ current: true, busy: false })

  useEffect(() => {
    const generation = { current: true, busy: false }
    lifetime.current = generation
    return () => {
      generation.current = false
      onBusyChange(false)
    }
  }, [connectionId, containerId, enabled, onBusyChange])

  async function transfer(kind: "upload" | "download") {
    const generation = lifetime.current
    if (
      !enabled ||
      (!containerId && !managed) ||
      (managed && !managed.operationsQualified) ||
      generation.busy
    )
      return
    const path = kind === "upload" ? folder.trim() : downloadPath.trim()
    if (!absolutePath(path) || (kind === "download" && path.endsWith("/"))) {
      setNotice("invalidPath")
      return
    }
    generation.busy = true
    setBusy(kind)
    setNotice(null)
    onBusyChange(true)
    let managedSession: ManagedDesktopOperationSession | undefined
    let token: string | undefined
    let fence = 0
    let failure: Notice = kind === "upload" ? "readFailed" : "downloadFailed"
    try {
      if (kind === "upload") {
        const files = await pickStreamFiles({ multiple: false })
        if (!generation.current) return
        const file = files[0]
        if (!file) {
          setNotice("cancelled")
          return
        }
        if (!file.name || /[\\/\0]/.test(file.name) || file.name === "." || file.name === "..") {
          setNotice("invalidPath")
          return
        }
        const chunks: Uint8Array[] = []
        let length = 0
        // Breaking/returning from for-await closes the shared picker stream,
        // including its native file descriptor on oversize or target change.
        for await (const chunk of file.stream()) {
          if (!generation.current) return
          length += chunk.byteLength
          if (length > MAX_SANDBOX_TRANSFER_BYTES) {
            setNotice("tooLarge")
            return
          }
          chunks.push(chunk)
        }
        if (!generation.current) return
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        // Multiples of three preserve base64 padding across chunk boundaries
        // without the encoder building an eight-million-character rope.
        const encodedChunks: string[] = []
        for (let start = 0; start < bytes.length; start += 48 * 1024) {
          encodedChunks.push(encodeBase64(bytes.subarray(start, start + 48 * 1024)))
        }
        const encoded = encodedChunks.join("")
        failure = "uploadFailed"
        await releaseControl()
        if (!generation.current) return
        managedSession = managed ? await openManagedDesktop(managed.target, managed.ref) : undefined
        if (!generation.current) return
        const lease = managedSession
          ? await managedSession.acquire(true)
          : await sandboxClient.acquireControl(connectionId, true)
        token = lease.token
        fence = lease.fence
        if (!generation.current) return
        const destination = `${path.replace(/\/+$/, "")}/${file.name}`
        if (managedSession) {
          for (let start = 0; ; start += 64 * 1024) {
            if (!generation.current) return
            const chunk = bytes.subarray(start, start + 64 * 1024)
            await managedSession.renew(lease)
            if (!generation.current) return
            await managedSession.writeChunk(
              lease,
              destination,
              start,
              Array.from(chunk),
              start + chunk.length === bytes.length
            )
            if (start + chunk.length === bytes.length) break
          }
        } else
          await sandboxClient.uploadFile(connectionId, containerId!, token, destination, encoded)
        if (generation.current) setNotice("uploaded")
      } else {
        let result
        if (managed) {
          await releaseControl()
          if (!generation.current) return
          managedSession = await openManagedDesktop(managed.target, managed.ref)
          if (!generation.current) return
          const lease = await managedSession.acquire(true)
          token = lease.token
          fence = lease.fence ?? 0
          const chunks: Uint8Array[] = []
          let length = 0
          for (;;) {
            if (!generation.current) return
            await managedSession.renew(lease)
            if (!generation.current) return
            const answer = await managedSession.readChunk(
              lease,
              path,
              length,
              Math.min(64 * 1024, MAX_SANDBOX_TRANSFER_BYTES - length)
            )
            if (
              answer.kind !== "file-read" ||
              answer.chunk.length > 64 * 1024 ||
              answer.chunk.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
            )
              throw new Error("managed_desktop_operation_protocol")
            chunks.push(new Uint8Array(answer.chunk))
            length += answer.chunk.length
            if (answer.eof) break
            if (!answer.chunk.length || length >= MAX_SANDBOX_TRANSFER_BYTES)
              throw new Error("managed_desktop_operation_limit")
          }
          const bytes = new Uint8Array(length)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.length
          }
          const hash = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (byte) => byte.toString(16).padStart(2, "0")
          ).join("")
          const encoded: string[] = []
          for (let i = 0; i < bytes.length; i += 48 * 1024)
            encoded.push(encodeBase64(bytes.subarray(i, i + 48 * 1024)))
          result = { path, size: length, sha256: hash, dataBase64: encoded.join("") }
        } else result = await sandboxClient.downloadFile(connectionId, containerId!, path)
        if (!generation.current) return
        // Bound allocation before decoding a response crossing the IPC boundary.
        if (
          !Number.isSafeInteger(result.size) ||
          result.size < 0 ||
          result.size > MAX_SANDBOX_TRANSFER_BYTES ||
          result.dataBase64.length > Math.ceil(MAX_SANDBOX_TRANSFER_BYTES / 3) * 4
        ) {
          setNotice("tooLarge")
          return
        }
        failure = "invalidPayload"
        const bytes = decodeBase64(result.dataBase64)
        if (bytes.byteLength !== result.size) {
          setNotice("invalidPayload")
          return
        }
        const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
        if (!generation.current) return
        const hash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("")
        if (hash !== result.sha256.toLowerCase()) {
          setNotice("invalidPayload")
          return
        }
        failure = "saveFailed"
        const outcome = await saveExport({
          filename: path.split("/").pop()!,
          data: bytes,
          mimeType: "application/octet-stream",
          shouldContinue: () => generation.current,
        })
        if (!generation.current) return
        setNotice(
          outcome.kind === "saved"
            ? "downloaded"
            : outcome.kind === "cancelled"
              ? "cancelled"
              : "saveFailed"
        )
      }
    } catch (error) {
      if (generation.current) setNotice(lumeFailureKind(error) === "writers" ? "writers" : failure)
    } finally {
      // A dispatched upload may finish after unmount. Release its exact lease,
      // even though no UI is left to receive the result. Expiry is already safe.
      if (token) {
        if (managedSession)
          await managedSession.release({ token, fence, expiresAt: 0 }).catch(() => undefined)
        else await sandboxClient.releaseControl(connectionId, token, fence).catch(() => undefined)
      }
      managedSession?.close()
      generation.busy = false
      if (generation.current) {
        setBusy(null)
        onBusyChange(false)
      }
    }
  }

  const dormant = managed && !managed.operationsQualified
  const disabled = !enabled || (!containerId && !managed) || dormant || busy !== null
  const isError = notice !== null && !["cancelled", "uploaded", "downloaded"].includes(notice)
  return (
    <section className="space-y-3" aria-label={t("title")}>
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <p className="text-xs text-muted-foreground">
        {t(managed ? "managedHelp" : "help", { limit: MAX_SANDBOX_TRANSFER_BYTES / 1024 / 1024 })}
      </p>
      {dormant ? <p className="text-xs text-muted-foreground">{t("operationsDormant")}</p> : null}
      {!containerId && !managed ? (
        <p className="text-xs text-muted-foreground">{t("missingContainer")}</p>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor={`${id}-folder`}>{t("folder")}</Label>
        <Input
          id={`${id}-folder`}
          value={folder}
          disabled={disabled}
          onChange={(event) => setFolder(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void transfer("upload")}
        >
          {busy === "upload" ? t("uploading") : t("upload")}
        </Button>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-download`}>{t("downloadPath")}</Label>
        <Input
          id={`${id}-download`}
          value={downloadPath}
          disabled={disabled}
          onChange={(event) => setDownloadPath(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !downloadPath.trim()}
          onClick={() => void transfer("download")}
        >
          {busy === "download" ? t("downloading") : t("download")}
        </Button>
      </div>
      {notice ? (
        <p
          role={isError ? "alert" : "status"}
          className={`text-xs ${isError ? "text-destructive" : "text-muted-foreground"}`}
        >
          {notice === "writers"
            ? lumeErrors("writers")
            : t(
                `notice.${managed && notice === "uploadFailed" ? "managedUploadFailed" : managed && notice === "downloadFailed" ? "managedDownloadFailed" : notice}`
              )}
        </p>
      ) : null}
    </section>
  )
}
