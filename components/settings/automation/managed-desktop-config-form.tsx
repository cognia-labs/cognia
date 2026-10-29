"use client"

import { useEffect, useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useConfirmDialog } from "@/components/shared/confirm-dialog"
import {
  managedDesktopClient,
  managedDesktopErrorKey,
  type ManagedDesktopConfigDraft,
  type ManagedDesktopConfigSummary,
  type ManagedDesktopCredentialSource,
  type ManagedDesktopTarget,
} from "@/lib/automation/managed-desktop-client"
import { missingQualification } from "@/lib/automation/managed-desktop-qualification"
import {
  providerCredentialSecretId,
  remoteSandboxesGet,
} from "@/lib/sandbox/remote-sandboxes-client"
import type { IsolationTier } from "@/types/sandbox/environment-spec"

/** v1 upper bounds (ADR-0233 §3); a configuration may only tighten them. */
export const MANAGED_DESKTOP_LIMITS = Object.freeze({
  maxConcurrent: 2,
  maxLifetimeSeconds: 3600,
  idleTimeoutSeconds: 600,
  planMaxLifetimeSeconds: 86_400,
  maxValidDays: 30,
})
const DAY_MS = 24 * 60 * 60 * 1000
const ISOLATION_TIERS: IsolationTier[] = ["vm", "gvisor", "container"]
const CONFIG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

interface FormState {
  id: string
  enabled: boolean
  cpuCount: string
  memoryMb: string
  maxConcurrent: string
  maxLifetimeSeconds: string
  idleTimeoutSeconds: string
  planMaxLifetimeSeconds: string
  planSource: string
  planNamespace: string
  planValidDays: string
  priceHourly: string
  priceCurrency: string
  priceSource: string
  priceValidDays: string
  /**
   * The stored confirmation windows, kept until the day field is edited, so a
   * save that only flips switches keeps the Host's binding (and its receipts).
   */
  planValidForMs: number | null
  priceValidForMs: number | null
  isolationMinimum: IsolationTier
  manualGui: boolean
  agentControl: boolean
  acceptance: boolean
}

const ENABLEMENT = ["manualGui", "agentControl", "acceptance"] as const

/** Whole days shown for a stored window, within the form's accepted range. */
function windowDays(window: number): string {
  return String(
    Math.min(MANAGED_DESKTOP_LIMITS.maxValidDays, Math.max(1, Math.round(window / DAY_MS)))
  )
}

function initialState(config?: ManagedDesktopConfigSummary): FormState {
  const planWindow = config ? config.plan.expiresAt - config.plan.observedAt : null
  const priceWindow = config ? config.price.expiresAt - config.price.observedAt : null
  return {
    id: config?.id ?? "",
    enabled: config?.enabled ?? true,
    cpuCount: String(config?.cpuCount ?? 2),
    memoryMb: String(config?.memoryMb ?? 4096),
    maxConcurrent: String(config?.maxConcurrent ?? MANAGED_DESKTOP_LIMITS.maxConcurrent),
    maxLifetimeSeconds: String(
      config?.maxLifetimeSeconds ?? MANAGED_DESKTOP_LIMITS.maxLifetimeSeconds
    ),
    idleTimeoutSeconds: String(
      config?.idleTimeoutSeconds ?? MANAGED_DESKTOP_LIMITS.idleTimeoutSeconds
    ),
    planMaxLifetimeSeconds: String(config?.plan.maxLifetimeSeconds ?? 3600),
    planSource: config?.plan.source ?? "",
    planNamespace: config?.plan.namespace ?? "",
    planValidDays: planWindow === null ? "30" : windowDays(planWindow),
    planValidForMs: planWindow,
    priceHourly: config ? String(config.price.hourlyRateMicros / 1_000_000) : "",
    priceCurrency: config?.price.currency ?? "USD",
    priceSource: config?.price.source ?? "",
    priceValidDays: priceWindow === null ? "30" : windowDays(priceWindow),
    priceValidForMs: priceWindow,
    isolationMinimum: config?.isolationMinimum ?? "vm",
    manualGui: config?.enablement.manualGui ?? false,
    agentControl: config?.enablement.agentControl ?? false,
    acceptance: config?.enablement.acceptance ?? false,
  }
}

function integer(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const parsed = Number(value)
  return parsed >= min && parsed <= max ? parsed : null
}

/** Field name of the first invalid input, or the draft the Host will validate again. */
export function managedDesktopDraft(
  form: FormState,
  expectedRevision: number | null
): { draft: ManagedDesktopConfigDraft } | { invalid: keyof FormState } {
  if (!CONFIG_ID.test(form.id)) return { invalid: "id" }
  const cpuCount = integer(form.cpuCount, 1, 64)
  if (cpuCount === null) return { invalid: "cpuCount" }
  const memoryMb = integer(form.memoryMb, 128, 262_144)
  if (memoryMb === null) return { invalid: "memoryMb" }
  const maxConcurrent = integer(form.maxConcurrent, 1, MANAGED_DESKTOP_LIMITS.maxConcurrent)
  if (maxConcurrent === null) return { invalid: "maxConcurrent" }
  const maxLifetimeSeconds = integer(
    form.maxLifetimeSeconds,
    1,
    MANAGED_DESKTOP_LIMITS.maxLifetimeSeconds
  )
  if (maxLifetimeSeconds === null) return { invalid: "maxLifetimeSeconds" }
  const idleTimeoutSeconds = integer(
    form.idleTimeoutSeconds,
    1,
    MANAGED_DESKTOP_LIMITS.idleTimeoutSeconds
  )
  if (idleTimeoutSeconds === null) return { invalid: "idleTimeoutSeconds" }
  const planMaxLifetimeSeconds = integer(
    form.planMaxLifetimeSeconds,
    1,
    MANAGED_DESKTOP_LIMITS.planMaxLifetimeSeconds
  )
  if (planMaxLifetimeSeconds === null) return { invalid: "planMaxLifetimeSeconds" }
  if (!form.planSource.trim()) return { invalid: "planSource" }
  if (!form.planNamespace.trim()) return { invalid: "planNamespace" }
  const planValidDays = integer(form.planValidDays, 1, MANAGED_DESKTOP_LIMITS.maxValidDays)
  if (planValidDays === null) return { invalid: "planValidDays" }
  const hourly = Number(form.priceHourly)
  if (!/^\d+(\.\d{1,6})?$/.test(form.priceHourly.trim()) || !(hourly > 0))
    return { invalid: "priceHourly" }
  const currency = form.priceCurrency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) return { invalid: "priceCurrency" }
  if (!form.priceSource.trim()) return { invalid: "priceSource" }
  const priceValidDays = integer(form.priceValidDays, 1, MANAGED_DESKTOP_LIMITS.maxValidDays)
  if (priceValidDays === null) return { invalid: "priceValidDays" }
  return {
    draft: {
      id: form.id,
      expectedRevision,
      enabled: form.enabled,
      shape: { cpuCount, memoryMb },
      limits: { maxConcurrent, maxLifetimeSeconds, idleTimeoutSeconds },
      plan: {
        maxLifetimeSeconds: planMaxLifetimeSeconds,
        source: form.planSource.trim(),
        namespace: form.planNamespace.trim(),
        validForMs: form.planValidForMs ?? planValidDays * DAY_MS,
      },
      price: {
        currency,
        hourlyRateMicros: Math.round(hourly * 1_000_000),
        source: form.priceSource.trim(),
        validForMs: form.priceValidForMs ?? priceValidDays * DAY_MS,
      },
      egress: { mode: "off" },
      isolationMinimum: form.isolationMinimum,
      enablement: {
        manualGui: form.manualGui,
        agentControl: form.agentControl,
        acceptance: form.acceptance,
      },
    },
  }
}

interface CopySource {
  id: string
  label: string
}

/** Create or edit one Host configuration and its write-only provider key. */
export function ManagedDesktopConfigForm({
  target,
  config,
  onSaved,
  onDeleted,
  onCancel,
}: {
  target: ManagedDesktopTarget
  config?: ManagedDesktopConfigSummary
  onSaved: (config: ManagedDesktopConfigSummary) => void
  onDeleted?: () => void
  onCancel?: () => void
}) {
  const t = useTranslations("settings.managedDesktops")
  const f = useTranslations("settings.managedDesktops.configForm")
  const formId = useId()
  const [form, setForm] = useState(() => initialState(config))
  const [invalid, setInvalid] = useState<keyof FormState>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState("")
  const [copyFrom, setCopyFrom] = useState("")
  const [copySources, setCopySources] = useState<CopySource[]>([])
  const alive = useRef(true)
  const { confirm, dialog } = useConfirmDialog()

  useEffect(() => {
    alive.current = true
    // Copying a code-sandbox key is a Host-local action of this desktop only.
    if (target.kind === "local" && config) {
      remoteSandboxesGet()
        .then((view) => {
          if (!alive.current) return
          const stored = new Set(view.storedSecretIds)
          setCopySources(
            view.settings.providers.providers.flatMap((provider) => {
              const secretId = providerCredentialSecretId(provider)
              return provider.kind === "e2b" && secretId && stored.has(secretId)
                ? [{ id: provider.id, label: provider.label ?? provider.id }]
                : []
            })
          )
        })
        .catch(() => {
          if (alive.current) setCopySources([])
        })
    }
    return () => {
      alive.current = false
    }
  }, [target.kind, config])

  const update = <K extends keyof FormState>(field: K, value: FormState[K]) =>
    setForm((current) => ({
      ...current,
      [field]: value,
      // Editing a day count confirms a new window; the stored one no longer applies.
      ...(field === "planValidDays" ? { planValidForMs: null } : {}),
      ...(field === "priceValidDays" ? { priceValidForMs: null } : {}),
    }))

  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    setBusy(true)
    setError(undefined)
    try {
      return await operation()
    } catch (cause) {
      if (alive.current) setError(managedDesktopErrorKey(cause))
      return undefined
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  async function save() {
    const result = managedDesktopDraft(form, config?.revision ?? null)
    if ("invalid" in result) {
      setInvalid(result.invalid)
      return
    }
    setInvalid(undefined)
    const saved = await run(() => managedDesktopClient.saveConfig(target, result.draft))
    if (saved && alive.current) onSaved(saved)
  }

  async function storeCredential(source: ManagedDesktopCredentialSource) {
    if (!config) return
    const rotate = config.credentialPresent
    if (
      rotate &&
      !(await confirm({
        title: f("rotateTitle"),
        description: f("rotateDescription"),
        confirmLabel: f("rotate"),
      }))
    )
      return
    const saved = await run(() =>
      rotate
        ? managedDesktopClient.rotateCredential(target, config.id, config.revision, source)
        : managedDesktopClient.setCredential(target, config.id, config.revision, source)
    )
    if (saved && alive.current) {
      setKey("")
      setCopyFrom("")
      onSaved(saved)
    }
  }

  async function remove() {
    if (!config) return
    if (
      !(await confirm({
        title: f("deleteTitle", { id: config.id }),
        description: f("deleteDescription"),
        confirmLabel: f("delete"),
        destructive: true,
      }))
    )
      return
    const removed = await run(() =>
      managedDesktopClient.deleteConfig(target, config.id, config.revision)
    )
    if (removed !== undefined && alive.current) onDeleted?.()
  }

  const field = (
    name: keyof FormState,
    props: { type?: string; inputMode?: "numeric" | "decimal" | "text"; disabled?: boolean } = {}
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`${formId}-${name}`}>{f(`fields.${name}`)}</Label>
      <Input
        id={`${formId}-${name}`}
        value={String(form[name])}
        inputMode={props.inputMode ?? "numeric"}
        type={props.type ?? "text"}
        disabled={busy || props.disabled}
        aria-invalid={invalid === name}
        aria-describedby={invalid === name ? `${formId}-invalid` : undefined}
        onChange={(event) => update(name, event.target.value as never)}
      />
    </div>
  )

  return (
    <form
      className="space-y-4 rounded-md border p-3"
      aria-label={config ? f("editTitle", { id: config.id }) : f("createTitle")}
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <h4 className="text-sm font-medium">
        {config ? f("editTitle", { id: config.id }) : f("createTitle")}
      </h4>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("id", { inputMode: "text", disabled: Boolean(config) })}
        <div className="flex items-center gap-2 pt-6">
          <Switch
            id={`${formId}-enabled`}
            checked={form.enabled}
            disabled={busy}
            onCheckedChange={(checked) => update("enabled", checked)}
          />
          <Label htmlFor={`${formId}-enabled`}>{f("fields.enabled")}</Label>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{f("shapeTitle")}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {field("cpuCount")}
          {field("memoryMb")}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{f("limitsTitle")}</legend>
        <p className="text-xs text-muted-foreground">
          {f("limitsHint", {
            concurrent: MANAGED_DESKTOP_LIMITS.maxConcurrent,
            lifetime: MANAGED_DESKTOP_LIMITS.maxLifetimeSeconds,
            idle: MANAGED_DESKTOP_LIMITS.idleTimeoutSeconds,
          })}
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {field("maxConcurrent")}
          {field("maxLifetimeSeconds")}
          {field("idleTimeoutSeconds")}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{f("planTitle")}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {field("planMaxLifetimeSeconds")}
          {field("planNamespace", { inputMode: "text" })}
          {field("planSource", { inputMode: "text" })}
          {field("planValidDays")}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{f("priceTitle")}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {field("priceHourly", { inputMode: "decimal" })}
          {field("priceCurrency", { inputMode: "text" })}
          {field("priceSource", { inputMode: "text" })}
          {field("priceValidDays")}
        </div>
        <p className="text-xs text-muted-foreground">{f("confirmationHint")}</p>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${formId}-isolation`}>{f("fields.isolationMinimum")}</Label>
          <NativeSelect
            id={`${formId}-isolation`}
            value={form.isolationMinimum}
            disabled={busy}
            onChange={(event) => update("isolationMinimum", event.target.value as IsolationTier)}
          >
            {ISOLATION_TIERS.map((tier) => (
              <NativeSelectOption key={tier} value={tier}>
                {f(`isolation.${tier}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <span className="text-sm font-medium">{f("fields.egress")}</span>
          <p className="text-xs text-muted-foreground" data-dormant="managed-desktop-egress">
            {f("egressOffOnly")}
          </p>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{f("enablementTitle")}</legend>
        <p className="text-xs text-muted-foreground">{f("enablementHint")}</p>
        {ENABLEMENT.map((gate) => {
          const missing = missingQualification(config?.qualificationCategories ?? [], gate)
          // Turning a switch off is always allowed; turning it on needs current receipts.
          const locked = !form[gate] && missing.length > 0
          return (
            <div key={gate} className="space-y-1">
              <div className="flex items-center gap-2">
                <Switch
                  id={`${formId}-${gate}`}
                  checked={form[gate]}
                  disabled={busy || locked}
                  aria-describedby={locked ? `${formId}-${gate}-missing` : undefined}
                  onCheckedChange={(checked) => update(gate, checked)}
                />
                <Label htmlFor={`${formId}-${gate}`}>{f(`fields.${gate}`)}</Label>
              </div>
              {locked ? (
                <p
                  id={`${formId}-${gate}-missing`}
                  className="text-xs text-muted-foreground"
                  data-gate-missing={gate}
                >
                  {f("enablementMissing", {
                    categories: missing
                      .map((category) => t(`qualification.category.${category}`))
                      .join(", "),
                  })}
                </p>
              ) : null}
              {gate === "agentControl" ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-dormant="managed-desktop-agent-delegation"
                >
                  {f("agentControlDormant")}
                </p>
              ) : null}
            </div>
          )
        })}
      </fieldset>

      {invalid ? (
        <p id={`${formId}-invalid`} role="alert" className="text-xs text-destructive">
          {f("invalid", { field: f(`fields.${invalid}`) })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {config ? f("save") : f("create")}
        </Button>
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            {f("cancel")}
          </Button>
        ) : null}
        {config ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void remove()}
          >
            {f("delete")}
          </Button>
        ) : null}
      </div>

      {config ? (
        <section className="space-y-2 border-t pt-3" aria-label={f("credentialTitle")}>
          <div className="flex flex-wrap items-center gap-2">
            <h5 className="text-xs font-medium">{f("credentialTitle")}</h5>
            <Badge variant={config.credentialPresent ? "secondary" : "outline"}>
              {config.credentialPresent
                ? f("credentialStored", { generation: config.credentialGeneration })
                : f("credentialMissing")}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{f("credentialHint")}</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1 space-y-1">
              <Label htmlFor={`${formId}-key`}>{f("fields.key")}</Label>
              <Input
                id={`${formId}-key`}
                type="password"
                autoComplete="off"
                value={key}
                disabled={busy}
                onChange={(event) => setKey(event.target.value)}
              />
            </div>
            <Button
              type="button"
              size="sm"
              disabled={busy || !key}
              onClick={() => void storeCredential({ kind: "key", key })}
            >
              {config.credentialPresent ? f("rotate") : f("storeKey")}
            </Button>
          </div>
          {copySources.length > 0 ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1 space-y-1">
                <Label htmlFor={`${formId}-copy`}>{f("fields.copyFrom")}</Label>
                <NativeSelect
                  id={`${formId}-copy`}
                  value={copyFrom}
                  disabled={busy}
                  onChange={(event) => setCopyFrom(event.target.value)}
                >
                  <NativeSelectOption value="">{f("copyNone")}</NativeSelectOption>
                  {copySources.map((source) => (
                    <NativeSelectOption key={source.id} value={source.id}>
                      {source.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || !copyFrom}
                onClick={() =>
                  void storeCredential({ kind: "remoteSandbox", providerId: copyFrom })
                }
              >
                {f("copyKey")}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
      {dialog}
    </form>
  )
}
