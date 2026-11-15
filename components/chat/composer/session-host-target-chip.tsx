"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { CheckIcon } from "lucide-react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import {
  executionHostOriginLabel,
  hostTone,
  useExecutionHostTargets,
} from "@/components/devices/execution-host-switcher"
import { useExecutionHostSwitch } from "@/hooks/devices/use-execution-host-switch"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SITE_TONE_DOT } from "@/components/sites/site-status"
import { getSession, updateSessionHostBinding } from "@/lib/db/sessions"
import { getDb } from "@/lib/db/schema"
import { captureTaskWorkspaceOrigin, sameTaskWorkspaceOrigin } from "@/lib/task-workspace/origin"
import type { TaskWorkspaceOrigin } from "@/lib/task-workspace/types"
import {
  sessionHostOriginForId,
  sessionHostWorkspaceRoots,
  switchSessionHostTarget,
} from "@/lib/chat/session-host-binding"
import type { ChatSession } from "@cognia/agent-config-types"
import { cn } from "@/lib/utils"
import { COMPOSER_TOOLBAR_CHIP } from "@/lib/chat/composer-skin"
// Installs the send guard's prompt (see `registerSessionHostPromptHandler`).
import "./session-host-prompt"

interface Props {
  session: Pick<ChatSession, "id" | "hostBinding">
  disabled?: boolean
  onRebound?: () => void
}

/** Session target, rather than whichever Host happens to be active now. */
export function SessionHostTargetChip({ session, disabled, onRebound }: Props) {
  const t = useTranslations("chat.composer.target")
  const td = useTranslations("devices.executionHost")
  const { hosts, origin: active, baseOrigin, baseTone } = useExecutionHostTargets()
  const { requestSwitch, dialog } = useExecutionHostSwitch()
  const latest = useLiveQuery(() => getSession(session.id), [session.id]) ?? session
  const target = latest.hostBinding?.origin ?? active
  const targetKey = JSON.stringify(target)
  const host = target.kind === "remote" ? hosts.find((row) => row.id === target.hostId) : undefined
  const label = executionHostOriginLabel(target, hosts, td)
  const mismatch = !sameTaskWorkspaceOrigin(target, active)
  const tone = mismatch
    ? "warning"
    : sameTaskWorkspaceOrigin(target, baseOrigin)
      ? baseTone
      : hostTone(host ?? null)
  const workspace = latest.hostBinding?.workspaceRoot ?? t("defaultWorkspace")
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState<{ key: string; roots: string[]; failed: boolean } | null>(
    null
  )
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void sessionHostWorkspaceRoots(JSON.parse(targetKey) as TaskWorkspaceOrigin).then(
      (roots) => {
        if (!cancelled) setLoaded({ key: targetKey, roots, failed: false })
      },
      () => {
        if (!cancelled) setLoaded({ key: targetKey, roots: [], failed: true })
      }
    )
    return () => {
      cancelled = true
    }
  }, [open, targetKey])

  const selectHost = async (origin: TaskWorkspaceOrigin) => {
    const db = getDb()
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    setOpen(false)
    setPending(true)
    setError(false)
    try {
      if (
        !(await switchSessionHostTarget(origin, requestSwitch, controller.signal)) ||
        getDb() !== db
      )
        return
      if (latest.hostBinding && sameTaskWorkspaceOrigin(latest.hostBinding.origin, origin)) {
        onRebound?.()
        return
      }
      // An explicit target choice creates a fresh Host-local working-copy
      // binding. Never carry the previous Host's path or bundle onto it.
      const roots = await sessionHostWorkspaceRoots(origin).catch(() => [])
      if (getDb() !== db || controller.signal.aborted) return
      if (!sameTaskWorkspaceOrigin(origin, captureTaskWorkspaceOrigin())) return
      await updateSessionHostBinding(session.id, {
        origin,
        ...(roots[0] ? { workspaceRoot: roots[0] } : {}),
      })
      onRebound?.()
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }

  const selectWorkspace = async (workspaceRoot: string) => {
    setPending(true)
    setError(false)
    try {
      await updateSessionHostBinding(session.id, { origin: target, workspaceRoot })
      setOpen(false)
      onRebound?.()
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }

  // With no other Host registered and the session on this device, there is
  // nothing to choose and nothing to warn about: the chip stays out of the
  // toolbar (`CHROME_BUDGET.composerToolbar` counts this default state).
  if (hosts.length === 0 && baseOrigin.kind === "local" && target.kind === "local" && !mismatch) {
    return dialog
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled || pending}
            className={cn(COMPOSER_TOOLBAR_CHIP, "max-w-52 gap-1")}
            aria-label={t(mismatch ? "ariaMismatch" : "aria", { host: label, workspace })}
            data-tone={tone}
            data-host-mismatch={mismatch || undefined}
          >
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", SITE_TONE_DOT[tone])}
            />
            <span className="truncate">{t("chipLabel", { host: label, workspace })}</span>
            {mismatch && <span>{t("mismatch")}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-label={t("chooseTarget")}
          align="start"
          className="w-80 max-w-[90vw] p-2"
        >
          <div role="group" aria-label={t("hosts")} className="flex flex-col">
            <p aria-hidden className={SECTION_LABEL}>
              {t("hosts")}
            </p>
            <TargetOption
              selected={sameTaskWorkspaceOrigin(target, baseOrigin)}
              onSelect={() => void selectHost(baseOrigin)}
            >
              {executionHostOriginLabel(baseOrigin, hosts, td)}
            </TargetOption>
            {hosts.map((row) => (
              <TargetOption
                key={row.id}
                selected={sameTaskWorkspaceOrigin(target, sessionHostOriginForId(row.id))}
                onSelect={() => void selectHost(sessionHostOriginForId(row.id))}
              >
                {t("hostOption", {
                  host: row.label,
                  state: td(`state.${row.connectionState}`),
                })}
              </TargetOption>
            ))}
          </div>
          <div
            role="group"
            aria-label={t("workspaces", { host: label })}
            className="mt-2 flex flex-col border-t pt-2"
          >
            <p aria-hidden className={SECTION_LABEL}>
              {t("workspaces", { host: label })}
            </p>
            {loaded?.key !== targetKey ? (
              <p role="status" className={STATUS_TEXT}>
                {t("loadingWorkspaces")}
              </p>
            ) : loaded.failed ? (
              <p role="status" className={STATUS_TEXT}>
                {t("workspacesUnavailable")}
              </p>
            ) : loaded.roots.length === 0 ? (
              <p role="status" className={STATUS_TEXT}>
                {t("noWorkspaces")}
              </p>
            ) : (
              loaded.roots.map((root) => (
                <TargetOption
                  key={root}
                  disabled={pending || disabled}
                  ariaLabel={t("workspaceOption", { path: root })}
                  selected={latest.hostBinding?.workspaceRoot === root}
                  onSelect={() => void selectWorkspace(root)}
                  mono
                >
                  {root}
                </TargetOption>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
      {error && <span role="alert">{t("updateFailed")}</span>}
      {dialog}
    </>
  )
}

const SECTION_LABEL = "px-2 pb-1 text-xs font-medium text-muted-foreground"
const STATUS_TEXT = "px-2 py-1.5 text-xs text-muted-foreground"

/** One menu row: left-aligned, with a check on the current choice. */
function TargetOption({
  selected,
  onSelect,
  disabled,
  ariaLabel,
  mono,
  children,
}: {
  selected: boolean
  onSelect: () => void
  disabled?: boolean
  ariaLabel?: string
  mono?: boolean
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={selected}
      className="h-8 justify-start gap-2 px-2 font-normal"
      onClick={onSelect}
    >
      <CheckIcon aria-hidden className={cn("size-3.5 shrink-0", !selected && "invisible")} />
      <span className={cn("min-w-0 truncate", mono && "font-mono text-xs")}>{children}</span>
    </Button>
  )
}
