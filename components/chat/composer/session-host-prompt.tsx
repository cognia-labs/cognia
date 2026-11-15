"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useExecutionHostSwitch } from "@/hooks/devices/use-execution-host-switch"
import {
  executionHostOriginLabel,
  useExecutionHostTargets,
} from "@/components/devices/execution-host-switcher"
import { captureTaskWorkspaceOrigin } from "@/lib/task-workspace/origin"
import {
  assessSessionHostBinding,
  sessionHostLiveState,
  subscribeSessionHostTarget,
  registerSessionHostPromptHandler,
  switchSessionHostTarget,
  type SessionHostPrompt,
} from "@/lib/chat/session-host-binding"
import { SessionHostTargetChip } from "./session-host-target-chip"
import { getDb } from "@/lib/db/schema"

/** Mounted by the toast host, so controller callers need no additional UI slot. */
export function SessionHostPromptDialog({
  prompt,
  onAnswer,
}: {
  prompt: SessionHostPrompt
  onAnswer: (retry: boolean) => void
}) {
  const t = useTranslations("chat.composer.target")
  const td = useTranslations("devices.executionHost")
  const { hosts } = useExecutionHostTargets()
  const { requestSwitch, dialog } = useExecutionHostSwitch()
  const [waiting, setWaiting] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState(false)
  const switchingOperation = useRef<AbortController | null>(null)
  useEffect(() => () => switchingOperation.current?.abort(), [])
  const origin = prompt.binding.origin
  const label = executionHostOriginLabel(origin, hosts, td)

  useEffect(() => {
    if (!waiting) return
    const check = () => {
      const active = captureTaskWorkspaceOrigin()
      if (assessSessionHostBinding(prompt.binding, active, sessionHostLiveState(active)) === "ok")
        onAnswer(true)
    }
    const unsubscribe = subscribeSessionHostTarget(check)
    check()
    return unsubscribe
  }, [waiting, prompt.binding, onAnswer])

  const switchBack = async () => {
    switchingOperation.current?.abort()
    const controller = new AbortController()
    switchingOperation.current = controller
    setSwitching(true)
    setError(false)
    try {
      if (await switchSessionHostTarget(origin, requestSwitch, controller.signal)) onAnswer(true)
      else setError(true)
    } catch {
      setError(true)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onAnswer(false)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t(prompt.decision === "switch-required" ? "switchTitle" : "unavailableTitle")}
            </DialogTitle>
            <DialogDescription>
              {t(prompt.decision === "switch-required" ? "switchBody" : "unavailableBody", {
                host: label,
              })}
            </DialogDescription>
          </DialogHeader>
          {prompt.decision === "host-unavailable" && (
            <>
              <p className="text-sm">{t("switchAnother")}</p>
              <SessionHostTargetChip
                session={{ id: prompt.sessionId, hostBinding: prompt.binding }}
                onRebound={() => onAnswer(true)}
              />
            </>
          )}
          {error && <p role="alert">{t("updateFailed")}</p>}
          {waiting && <p role="status">{t("waiting", { host: label })}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onAnswer(false)}>
              {t("cancel")}
            </Button>
            {prompt.decision === "switch-required" ? (
              <Button type="button" disabled={switching} onClick={() => void switchBack()}>
                {t("switchTo", { host: label })}
              </Button>
            ) : (
              <Button type="button" disabled={waiting} onClick={() => setWaiting(true)}>
                {t("wait")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {dialog}
    </>
  )
}

/** Why an unattended send in this conversation did not go out. */
export function SessionHostHeldBackNotice({ prompt }: { prompt: SessionHostPrompt }) {
  const t = useTranslations("chat.composer.target")
  const td = useTranslations("devices.executionHost")
  const { hosts } = useExecutionHostTargets()
  const host = executionHostOriginLabel(prompt.binding.origin, hosts, td)
  return (
    <div className="space-y-1">
      <p className="font-medium">{t("heldBackTitle")}</p>
      <p className="text-muted-foreground text-xs">
        {t(prompt.decision === "switch-required" ? "heldBackSwitch" : "heldBackUnavailable", {
          host,
        })}
      </p>
    </div>
  )
}

const pendingPrompts = new WeakMap<object, Map<string, Promise<boolean>>>()

export function promptSessionHostSend(prompt: SessionHostPrompt): Promise<boolean> {
  if (!prompt.interactive) {
    // One notice per conversation, replaced rather than stacked when a
    // background result retries; nothing waits on it.
    toast.warning(<SessionHostHeldBackNotice prompt={prompt} />, {
      id: `session-host-held-back:${prompt.sessionId}`,
    })
    return Promise.resolve(false)
  }
  const db = getDb()
  let prompts = pendingPrompts.get(db)
  if (!prompts) {
    prompts = new Map()
    pendingPrompts.set(db, prompts)
  }
  const existing = prompts.get(prompt.sessionId)
  if (existing) return existing
  const promise = new Promise<boolean>((resolve) => {
    let settled = false
    const answer = (retry: boolean) => {
      if (settled) return
      settled = true
      prompts.delete(prompt.sessionId)
      toast.dismiss(id)
      resolve(retry)
    }
    const id = toast.custom(() => <SessionHostPromptDialog prompt={prompt} onAnswer={answer} />, {
      duration: Infinity,
      onDismiss: () => answer(false),
    })
  })
  prompts.set(prompt.sessionId, promise)
  return promise
}

// Loaded with the composer toolbar (the target chip imports this module), so
// the kernel's send guard can ask without importing the chat UI.
registerSessionHostPromptHandler(promptSessionHostSend)
