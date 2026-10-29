"use client"

import { useEffect, useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import {
  NativeSelect,
  NativeSelectOption,
  NativeSelectOptGroup,
} from "@/components/ui/native-select"
import { useComputerUseTargets } from "@/hooks/sandbox/use-computer-use-targets"
import {
  bindManagedDesktop,
  managedDesktopConnectionId,
  unbindManagedDesktop,
  type ManagedDesktopGrantee,
} from "@/lib/sandbox/managed-desktop-binding"
import type { ComputerUseTargetSetting } from "@/lib/automation/sandbox-target"
import { updateSession } from "@/lib/db/sessions"
import type { ChatSession } from "@cognia/agent-config-types"

interface ComputerUseTargetPickerProps {
  value: ComputerUseTargetSetting
  onChange: (next: ComputerUseTargetSetting) => void | Promise<void>
  /** Absent for an unsaved character, which cannot receive a Host delegation. */
  grantee?: ManagedDesktopGrantee
  allowInherit?: boolean
  /** Character forms preserve their saved target until Save/Cancel settles the draft. */
  revokePrevious?: boolean
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  preserveBindingOnCancel?: string
}

/** Both editors use the same ordering: delegate → connection row → saved target. */
export function ComputerUseTargetPicker({
  value,
  onChange,
  grantee,
  allowInherit,
  revokePrevious = true,
  disabled,
  onBusyChange,
  preserveBindingOnCancel,
}: ComputerUseTargetPickerProps) {
  const t = useTranslations("computerUseTarget")
  const id = useId()
  const { connections, managed, failed } = useComputerUseTargets()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const selectionLifetime = useRef({ active: true })
  const granteeKey = JSON.stringify(grantee)
  useEffect(() => {
    const lifetime = { active: true }
    selectionLifetime.current = lifetime
    return () => {
      lifetime.active = false
    }
  }, [granteeKey])
  const selected =
    typeof value === "object" ? value.connectionId : (value ?? (allowInherit ? "inherit" : "local"))
  const offered =
    selected === "local" ||
    selected === "inherit" ||
    connections.some((row) => row.id === selected) ||
    managed.some(
      ({ desktop }) => managedDesktopConnectionId(desktop.id, desktop.generation) === selected
    )

  async function select(next: string) {
    if (busy || disabled || next === selected) return
    const desktop = managed.find(
      ({ desktop }) => managedDesktopConnectionId(desktop.id, desktop.generation) === next
    )
    if (desktop && (!grantee || !desktop.enabled)) return
    setBusy(true)
    onBusyChange?.(true)
    setError(false)
    let newBinding: string | undefined
    const lifetime = selectionLifetime.current
    try {
      if (desktop && grantee)
        newBinding = await bindManagedDesktop({
          desktopId: desktop.desktop.id,
          generation: desktop.desktop.generation,
          grantee,
        })
      if (!lifetime.active) {
        if (newBinding && newBinding !== preserveBindingOnCancel && grantee)
          await unbindManagedDesktop(newBinding, grantee)
        return
      }
      if (
        revokePrevious &&
        typeof value === "object" &&
        value.connectionId.startsWith("managed:") &&
        grantee
      )
        await unbindManagedDesktop(value.connectionId, grantee)
      await onChange(
        next === "inherit"
          ? undefined
          : next === "local"
            ? "local"
            : { connectionId: newBinding ?? next }
      )
    } catch {
      // If persistence/replacement failed, do not leave a newly delegated target orphaned.
      if (newBinding && newBinding !== preserveBindingOnCancel && grantee) {
        try {
          await unbindManagedDesktop(newBinding, grantee)
        } catch {
          /* The Host still fences the delegation's deadline. */
        }
      }
      setError(true)
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {t("label")}
      </Label>
      <NativeSelect
        id={id}
        aria-label={t("label")}
        value={selected}
        disabled={busy || disabled}
        aria-describedby={`${id}-description`}
        onChange={(event) => {
          void select(event.target.value)
        }}
      >
        {allowInherit && <NativeSelectOption value="inherit">{t("inherit")}</NativeSelectOption>}
        <NativeSelectOption value="local">{t("local")}</NativeSelectOption>
        {!offered && (
          <NativeSelectOption value={selected} disabled>
            {t("unavailable")}
          </NativeSelectOption>
        )}
        {connections.map((row) => (
          <NativeSelectOption key={row.id} value={row.id}>
            {row.name}
          </NativeSelectOption>
        ))}
        {managed.length > 0 && (
          <NativeSelectOptGroup label={t("managedGroup")}>
            {managed.map(({ desktop, enabled }) => {
              const reason = !grantee
                ? t("unsavedCharacter")
                : !enabled
                  ? t("agentControlDisabled")
                  : undefined
              return (
                <NativeSelectOption
                  key={desktop.id}
                  value={managedDesktopConnectionId(desktop.id, desktop.generation)}
                  disabled={!!reason}
                >
                  {reason
                    ? t("disabledDesktop", { desktop: desktop.id, reason })
                    : t("managedDesktop", { desktop: desktop.id })}
                </NativeSelectOption>
              )
            })}
          </NativeSelectOptGroup>
        )}
      </NativeSelect>
      <p id={`${id}-description`} className="text-[10px] text-muted-foreground">
        {t("description")}
      </p>
      {failed && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("loadFailed")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {t("changeFailed")}
        </p>
      )}
    </div>
  )
}

/** Persist through the same session writer used by the adjacent sandbox control. */
export function SessionComputerUseTargetPicker({ session }: { session: ChatSession }) {
  return (
    <ComputerUseTargetPicker
      value={session.computerUseTarget}
      allowInherit
      grantee={{ kind: "session", sessionKey: session.id }}
      onChange={async (computerUseTarget) => {
        await updateSession(session.id, { computerUseTarget })
      }}
    />
  )
}
