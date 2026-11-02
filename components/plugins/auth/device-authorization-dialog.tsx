"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { HostDeviceAuthorization } from "@/lib/plugin/auth/connection-manager"
import { openUrl } from "@/lib/native/opener"

interface DeviceAuthorizationDialogProps {
  authorization: HostDeviceAuthorization
  onAuthorized?: () => void | Promise<void>
  onClose: () => void
}

/** One polling owner for every Host driver's device challenge. Mount per attempt. */
export function DeviceAuthorizationDialog({
  authorization,
  onAuthorized,
  onClose,
}: DeviceAuthorizationDialogProps) {
  const t = useTranslations("plugins.auth")
  const [status, setStatus] = useState<"pending" | "denied" | "expired" | "failed">("pending")
  const [copied, setCopied] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)
  const callbacks = useRef({ onAuthorized, onClose })
  const stop = useRef<(() => void) | null>(null)
  const mountedAuthorization = useRef<HostDeviceAuthorization | null>(null)
  useEffect(() => {
    callbacks.current = { onAuthorized, onClose }
  }, [onAuthorized, onClose])

  useEffect(() => {
    mountedAuthorization.current = authorization
    let active = true
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let interval = Math.max(1, authorization.intervalSeconds)
    const cancel = () => {
      if (cancelled) return
      cancelled = true
      void authorization.cancel().catch(() => undefined)
    }
    const halt = () => {
      active = false
      clearTimeout(timer)
      clearTimeout(expiry)
      cancel()
    }
    const expire = () => {
      if (!active) return
      setStatus("expired")
      halt()
    }
    const expiry = setTimeout(expire, Math.max(0, authorization.expiresAt - Date.now()))
    const poll = async () => {
      if (!active) return
      if (Date.now() >= authorization.expiresAt) return expire()
      try {
        const result = await authorization.poll()
        if (!active) return
        if (Date.now() >= authorization.expiresAt) return expire()
        if (result.status === "authorized") {
          // Stop expiry/polling before the consumer publishes its exact binding.
          clearTimeout(expiry)
          await callbacks.current.onAuthorized?.()
          if (!active) return
          halt()
          callbacks.current.onClose()
        } else if (result.status === "denied" || result.status === "expired") {
          setStatus(result.status)
          halt()
        } else {
          interval = Math.max(1, result.intervalSeconds ?? interval)
          // Schedule only after the preceding request resolved: never overlap polls.
          timer = setTimeout(() => void poll(), interval * 1000)
        }
      } catch {
        if (!active) return
        setStatus("failed")
        halt()
      }
    }
    stop.current = halt
    timer = setTimeout(() => void poll(), interval * 1000)
    return () => {
      active = false
      clearTimeout(timer)
      clearTimeout(expiry)
      mountedAuthorization.current = null
      // Strict Mode replays effects for the same mounted challenge. Defer only
      // disposal so that replay cannot cancel the new polling owner.
      void Promise.resolve().then(() => {
        if (mountedAuthorization.current !== authorization) cancel()
      })
    }
  }, [authorization])

  const close = () => {
    stop.current?.()
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("deviceTitle")}</DialogTitle>
          <DialogDescription>{t("deviceInstructions")}</DialogDescription>
        </DialogHeader>
        <p className="break-all font-mono text-lg tracking-widest">{authorization.userCode}</p>
        <Button
          variant="outline"
          onClick={() => {
            void (async () => {
              try {
                await navigator.clipboard.writeText(authorization.userCode)
                setCopied(true)
              } catch {
                setActionFailed(true)
              }
            })()
          }}
        >
          {t(copied ? "deviceCopied" : "deviceCopy")}
        </Button>
        <a
          href={authorization.verificationUrl}
          className="break-all text-sm underline"
          onClick={(event) => {
            event.preventDefault()
            void openUrl(authorization.verificationUrl).catch(() => setActionFailed(true))
          }}
        >
          {authorization.verificationUrl}
        </a>
        <p role={status === "pending" ? "status" : "alert"}>
          {t(
            status === "pending"
              ? "devicePending"
              : status === "denied"
                ? "deviceDenied"
                : status === "expired"
                  ? "deviceExpired"
                  : "deviceFailed"
          )}
        </p>
        {actionFailed && <p role="alert">{t("deviceActionFailed")}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t(status === "pending" ? "deviceCancel" : "deviceClose")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
