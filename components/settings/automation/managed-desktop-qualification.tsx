"use client"

import { useEffect, useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useConfirmDialog } from "@/components/shared/confirm-dialog"
import {
  managedDesktopClient,
  managedDesktopErrorKey,
  type ManagedDesktopConfigSummary,
  type ManagedDesktopQualificationRun,
  type ManagedDesktopQualificationScope,
  type ManagedDesktopTarget,
} from "@/lib/automation/managed-desktop-client"
import {
  managedDesktopHandoffClient,
  type ManagedDesktopDeliverySummary,
} from "@/lib/automation/managed-desktop-handoff-client"
import {
  MANAGED_DESKTOP_HANDOFF_SCRIPT,
  isQualificationRunActive,
} from "@/lib/automation/managed-desktop-qualification"

interface Props {
  target: ManagedDesktopTarget
  config: ManagedDesktopConfigSummary
  /** This configuration's runs, newest first. */
  runs: ManagedDesktopQualificationRun[]
}

const HISTORY = 5

/**
 * In-Host qualification (ADR-0233 A3, Q25). The Host runs the native checks;
 * this panel only starts a run, approves the exact quote it is paused on, or
 * cancels it. Receipts come from the Host, never from this renderer.
 */
export function ManagedDesktopQualification({ target, config, runs }: Props) {
  const t = useTranslations("settings.managedDesktops")
  const q = useTranslations("settings.managedDesktops.qualification")
  const id = useId()
  const [scope, setScope] = useState<ManagedDesktopQualificationScope>("gui")
  const [deliveries, setDeliveries] = useState<ManagedDesktopDeliverySummary[]>()
  const [deliveryId, setDeliveryId] = useState("")
  const [script, setScript] = useState("")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const { confirm, dialog } = useConfirmDialog()
  const pending = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const active = runs.find(isQualificationRunActive)
  const history = runs.filter((run) => !isQualificationRunActive(run)).slice(0, HISTORY)
  // The Host bundles the selected commit itself for the recovery check, so any
  // delivery it can hand off qualifies both modes from the same source tree.
  const handoffable = (deliveries ?? []).filter((delivery) => delivery.modes.length > 0)
  const scriptValid = MANAGED_DESKTOP_HANDOFF_SCRIPT.test(script)
  const canStart =
    !busy &&
    !active &&
    config.credentialPresent &&
    (scope === "gui" || (Boolean(deliveryId) && scriptValid))

  async function act(work: () => Promise<unknown>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      await work()
    } catch (cause) {
      if (alive.current) setError(managedDesktopErrorKey(cause))
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }

  const loadDeliveries = () =>
    act(async () => {
      const next = await managedDesktopHandoffClient.deliveries(target)
      if (alive.current) setDeliveries(next)
    })

  const start = () =>
    act(() =>
      managedDesktopClient.qualifyStart(target, {
        providerConfigId: config.id,
        scope,
        ...(scope === "acceptance" ? { handoff: { deliveryId, script } } : {}),
      })
    )

  const cancel = async (run: ManagedDesktopQualificationRun) => {
    if (
      !(await confirm({
        title: q("cancelTitle"),
        description: q("cancelDescription"),
        confirmLabel: q("cancel"),
        destructive: true,
      }))
    )
      return
    await act(() => managedDesktopClient.qualifyCancel(target, run.runId))
  }

  const money = (currency: string, micros: number) =>
    `${currency} ${(micros / 1_000_000).toFixed(4)}`
  const date = (ms: number) => new Date(ms).toISOString()

  return (
    <section className="space-y-2 border-t pt-2" aria-label={q("title")}>
      <h5 className="text-xs font-medium">{q("title")}</h5>
      <p className="text-xs text-muted-foreground">{q("description")}</p>
      <ul className="grid gap-1 text-xs sm:grid-cols-2">
        {config.qualificationCategories.map((receipt) => (
          <li
            key={receipt.category}
            className="flex items-center gap-2"
            data-receipt={receipt.category}
            data-current={receipt.current}
          >
            <span>{q(`category.${receipt.category}`)}</span>
            <Badge variant={receipt.current ? "secondary" : "outline"}>
              {receipt.current && receipt.observedAt !== null
                ? q("receiptCurrent", { date: date(receipt.observedAt) })
                : q("receiptMissing")}
            </Badge>
          </li>
        ))}
      </ul>

      {active ? (
        <ActiveRun
          run={active}
          busy={busy}
          money={money}
          date={date}
          onApprove={(quoteId) =>
            void act(() => managedDesktopClient.qualifyApprove(target, active.runId, quoteId))
          }
          onCancel={() => void cancel(active)}
        />
      ) : (
        <div className="space-y-2">
          <Label htmlFor={`${id}-scope`}>{q("scopeLabel")}</Label>
          <NativeSelect
            id={`${id}-scope`}
            value={scope}
            disabled={busy}
            onChange={(event) => setScope(event.target.value as ManagedDesktopQualificationScope)}
          >
            <NativeSelectOption value="gui">{q("scope.gui")}</NativeSelectOption>
            <NativeSelectOption value="acceptance">{q("scope.acceptance")}</NativeSelectOption>
          </NativeSelect>
          {scope === "acceptance" ? (
            <div className="space-y-2">
              {deliveries === undefined ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void loadDeliveries()}
                >
                  {q("loadDeliveries")}
                </Button>
              ) : handoffable.length === 0 ? (
                <p className="text-xs text-muted-foreground">{q("noDeliveries")}</p>
              ) : (
                <>
                  <Label htmlFor={`${id}-delivery`}>{q("delivery")}</Label>
                  <NativeSelect
                    id={`${id}-delivery`}
                    value={deliveryId}
                    disabled={busy}
                    onChange={(event) => setDeliveryId(event.target.value)}
                  >
                    <NativeSelectOption value="">{q("chooseDelivery")}</NativeSelectOption>
                    {handoffable.map((delivery) => (
                      <NativeSelectOption key={delivery.id} value={delivery.id}>
                        {q("deliveryOption", {
                          branch: delivery.branch,
                          commit: delivery.commit.slice(0, 12),
                        })}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </>
              )}
              <Label htmlFor={`${id}-script`}>{q("script")}</Label>
              <Input
                id={`${id}-script`}
                value={script}
                disabled={busy}
                aria-invalid={script !== "" && !scriptValid}
                aria-describedby={`${id}-script-help`}
                onChange={(event) => setScript(event.target.value.trim())}
              />
              <p id={`${id}-script-help`} className="text-xs text-muted-foreground">
                {script !== "" && !scriptValid ? q("scriptInvalid") : q("scriptHelp")}
              </p>
            </div>
          ) : null}
          {!config.credentialPresent ? (
            <p className="text-xs text-muted-foreground">{t("configForm.credentialMissing")}</p>
          ) : null}
          <Button size="sm" disabled={!canStart} onClick={() => void start()}>
            {busy ? q("starting") : q("start")}
          </Button>
        </div>
      )}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      {history.length > 0 ? (
        <div className="space-y-1">
          <h6 className="text-xs font-medium">{q("history")}</h6>
          <ul className="space-y-1 text-xs">
            {history.map((run) => (
              <li key={run.runId} data-run-state={run.state}>
                {q("runTitle", { scope: q(`scope.${run.scope}`), date: date(run.startedAt) })} ·{" "}
                {q(`runState.${run.state}`)}
                {run.errorCode ? ` · ${t(`errors.${managedDesktopErrorKey(run.errorCode)}`)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">{q("empty")}</p>
      ) : null}
      {dialog}
    </section>
  )
}

function ActiveRun({
  run,
  busy,
  money,
  date,
  onApprove,
  onCancel,
}: {
  run: ManagedDesktopQualificationRun
  busy: boolean
  money: (currency: string, micros: number) => string
  date: (ms: number) => string
  onApprove: (quoteId: string) => void
  onCancel: () => void
}) {
  const t = useTranslations("settings.managedDesktops")
  const q = useTranslations("settings.managedDesktops.qualification")
  const awaiting = run.awaitingApproval
  return (
    <div className="space-y-2 rounded-md border p-2 text-xs" data-run-state={run.state}>
      <p className="font-medium">
        {q("runTitle", { scope: q(`scope.${run.scope}`), date: date(run.startedAt) })}
      </p>
      <p role="status">
        {q(`runState.${run.state}`)}
        {run.currentCategory
          ? ` · ${q("current", { category: q(`category.${run.currentCategory}`) })}`
          : ""}
      </p>
      <ol className="space-y-0.5">
        {run.categories.map((step) => (
          <li key={step.category} data-step={step.category} data-step-state={step.state}>
            {q(`category.${step.category}`)} · {q(`categoryState.${step.state}`)}
            {step.errorCode ? ` · ${t(`errors.${managedDesktopErrorKey(step.errorCode)}`)}` : ""}
          </li>
        ))}
      </ol>
      {awaiting ? (
        <div className="space-y-1 border-t pt-2" aria-label={q("awaitingTitle")} role="group">
          <p className="font-medium">{q("awaitingTitle")}</p>
          <p>{q(`purpose.${awaiting.purpose}`)}</p>
          <p>{t("spec", { cpu: awaiting.quote.cpuCount, memory: awaiting.quote.memoryMb })}</p>
          <p>
            {t("hourly", {
              cost: money(awaiting.quote.currency, awaiting.quote.hourlyRateMicros),
            })}
          </p>
          <p>
            {t("maximum", {
              cost: money(awaiting.quote.currency, awaiting.quote.maximumComputeCostMicros),
            })}
          </p>
          <p className="text-muted-foreground">{t("costs")}</p>
          {awaiting.templateBuildCharges ? (
            <p className="text-muted-foreground" data-disclosure="template-build">
              {q("templateBuildCharges")}
            </p>
          ) : null}
          <Button size="sm" disabled={busy} onClick={() => onApprove(awaiting.quote.id)}>
            {q("approve")}
          </Button>
        </div>
      ) : null}
      <Button size="sm" variant="destructive" disabled={busy} onClick={onCancel}>
        {q("cancel")}
      </Button>
    </div>
  )
}
