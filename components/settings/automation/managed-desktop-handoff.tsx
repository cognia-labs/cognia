"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useAccountStore } from "@/stores/account/account-store"
import {
  managedDesktopHandoffClient,
  managedDesktopHandoffErrorKey,
  validManagedDesktopCriteria,
  watchManagedDesktopAcceptance,
  type ManagedDesktopAcceptanceCriterion,
  type ManagedDesktopAcceptanceRun,
  type ManagedDesktopAcceptanceStart,
  type ManagedDesktopDeliverySummary,
  type ManagedDesktopHandoffMode,
  type ManagedDesktopHandoffProposal,
} from "@/lib/automation/managed-desktop-handoff-client"
import type {
  ManagedDesktopConfigSummary,
  ManagedDesktopTarget,
} from "@/lib/automation/managed-desktop-client"
import { MANAGED_DESKTOP_HANDOFF_SCRIPT } from "@/lib/automation/managed-desktop-qualification"
import {
  consumeAcceptancePanelRequest,
  subscribeAcceptancePanelRequest,
} from "@/lib/automation/managed-desktop-acceptance-request"
import { ManagedDesktopAcceptanceCriteria } from "./managed-desktop-acceptance-criteria"
import { useConfirmDialog } from "@/components/shared/confirm-dialog"
import { createAttachedSession } from "@/lib/chat/attached-session"
import { getSession, updateSession } from "@/lib/db/sessions"
import { revealSpawnedTask } from "@/lib/tasks/spawn-task-dispatch"
import {
  managedDesktopConnectionId,
  reconcileManagedDesktopBindings,
} from "@/lib/sandbox/managed-desktop-binding"
import { managedDesktopIdentityScope } from "@/lib/automation/managed-desktop-client"
import type { ChatSession } from "@cognia/agent-config-types"
import { useRouter } from "next/navigation"
import { useChatStore } from "@/stores/chat"
import { useUIStore } from "@/stores/ui"

type AcceptanceSession = ChatSession & { managedAcceptance?: { acceptanceId: string } }
const activeRun = (run: ManagedDesktopAcceptanceRun) =>
  ["provisioning", "awaitingSession", "running"].includes(run.state)

interface Props {
  target: ManagedDesktopTarget
  config: ManagedDesktopConfigSummary
}

/** User-requested preparation only. No agent suggestion, mount or form submit can spend. */
export function ManagedDesktopHandoff(props: Props) {
  const account = useAccountStore((state) => (state.locked ? null : state.unlockedAccountId))
  const targetId = props.target.kind === "remote" ? props.target.hostId : "local"
  return <HandoffForm key={`${account}:${targetId}:${props.config.id}`} {...props} />
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

function parseArgv(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) &&
      (parsed.length === 0 ||
        (parsed.length === 3 &&
          parsed[0] === "npm" &&
          parsed[1] === "run" &&
          typeof parsed[2] === "string" &&
          MANAGED_DESKTOP_HANDOFF_SCRIPT.test(parsed[2])))
      ? parsed
      : null
  } catch {
    return null
  }
}

function HandoffForm({ target, config }: Props) {
  const t = useTranslations("settings.managedDesktops.handoff")
  const cost = useTranslations("settings.managedDesktops")
  const a = useTranslations("managedAcceptance")
  const router = useRouter()
  const { confirm, dialog } = useConfirmDialog()
  const id = useId()
  const [deliveries, setDeliveries] = useState<ManagedDesktopDeliverySummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [deliveryId, setDeliveryId] = useState("")
  const [mode, setMode] = useState<ManagedDesktopHandoffMode>("commit")
  const [criteria, setCriteria] = useState<ManagedDesktopAcceptanceCriterion[]>([
    { description: "", screenshotRequired: false },
  ])
  const [files, setFiles] = useState("")
  const [argv, setArgv] = useState("[]")
  const [minutes, setMinutes] = useState(String(Math.min(60, config.maxLifetimeSeconds / 60)))
  const [proposal, setProposal] = useState<ManagedDesktopHandoffProposal>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [confirmedCost, setConfirmedCost] = useState(false)
  const [runs, setRuns] = useState<ManagedDesktopAcceptanceRun[]>([])
  const [runError, setRunError] = useState<string>()
  const [now, setNow] = useState(Date.now)
  const preparedInput = useRef<ManagedDesktopAcceptanceStart | undefined>(undefined)
  const attaching = useRef(new Set<string>())
  const failedAttachments = useRef(new Set<string>())
  const startIntent = useRef<ManagedDesktopAcceptanceStart | undefined>(undefined)
  const pending = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const selected = deliveries.find((delivery) => delivery.id === deliveryId)
  const lifetimeSeconds = Number(minutes) * 60
  const parsedArgv = parseArgv(argv)
  const valid = Boolean(
    selected?.modes.includes(mode) &&
    parsedArgv &&
    validManagedDesktopCriteria(criteria) &&
    Number.isSafeInteger(lifetimeSeconds) &&
    lifetimeSeconds > 0 &&
    lifetimeSeconds <= Math.min(3600, config.maxLifetimeSeconds)
  )

  const targetKind = target.kind
  const targetHost = target.kind === "remote" ? target.hostId : undefined
  const stableTarget = useCallback(
    (): ManagedDesktopTarget =>
      targetKind === "remote" ? { kind: "remote", hostId: targetHost! } : { kind: "local" },
    [targetKind, targetHost]
  )

  const attach = useCallback(
    async (run: ManagedDesktopAcceptanceRun) => {
      if (
        run.state !== "awaitingSession" ||
        attaching.current.has(run.acceptanceId) ||
        failedAttachments.current.has(run.acceptanceId)
      )
        return
      attaching.current.add(run.acceptanceId)
      const currentTarget = stableTarget()
      if (currentTarget.kind !== "local") return
      const identity = managedDesktopIdentityScope(currentTarget)
      try {
        if (!(await getSession(run.source.sessionId))) throw new Error("sourceMissing")
        identity.assertActive()
        if (!alive.current) throw new Error("runFailed")
        if (!run.desktopId || run.desktopGeneration === null) throw new Error("runFailed")
        const branch =
          deliveries.find((delivery) => delivery.id === run.deliveryId)?.branch ?? run.deliveryId
        const request = preparedInput.current
        const promptCriteria = request?.deliveryId === run.deliveryId ? request.criteria : []
        const child = await createAttachedSession({
          parentSessionId: run.source.sessionId,
          title: a("childTitle", { branch }),
          context: { mode: "none" },
          workspace: "shared",
          prompt: a("childPrompt", {
            acceptanceId: run.acceptanceId,
            commit: run.commit,
            criteria: promptCriteria
              .map(
                (row, index) =>
                  `criterion-${index}: ${row.description}${row.screenshotRequired ? ` (${a("screenshotRequired")})` : ""}`
              )
              .join("\n"),
          }),
          extra: {
            managedAcceptance: { acceptanceId: run.acceptanceId },
          } as Partial<AcceptanceSession>,
        })
        identity.assertActive()
        if (!alive.current) throw new Error("runFailed")
        await managedDesktopHandoffClient.acceptanceAttach(
          currentTarget,
          run.acceptanceId,
          child.id
        )
        identity.assertActive()
        await reconcileManagedDesktopBindings()
        identity.assertActive()
        await updateSession(child.id, {
          computerUseTarget: {
            connectionId: managedDesktopConnectionId(run.desktopId, run.desktopGeneration),
          },
        })
        identity.assertActive()
        if (!alive.current) throw new Error("runFailed")
        useChatStore.getState().setActiveSession(run.source.sessionId)
        useUIStore.getState().setSelectedGuild({ kind: "dm" })
        revealSpawnedTask(run.source.sessionId, child.id)
        router.push("/")
      } catch (cause) {
        failedAttachments.current.add(run.acceptanceId)
        if (alive.current)
          setRunError(
            cause instanceof Error && cause.message === "sourceMissing"
              ? "sourceMissing"
              : "runFailed"
          )
        try {
          identity.assertActive()
          await managedDesktopHandoffClient.acceptanceCancel(currentTarget, run.acceptanceId)
        } catch {
          if (alive.current) setRunError("cancelFailed")
        }
      } finally {
        identity.dispose()
      }
    },
    [a, deliveries, stableTarget, router]
  )

  useEffect(() => {
    const currentTarget = stableTarget()
    return watchManagedDesktopAcceptance(
      currentTarget,
      (next) => {
        const own = next.filter((run) => run.providerConfigId === config.id)
        setRuns(own)
        for (const run of own) if (activeRun(run)) void attach(run)
      },
      () => {
        if (alive.current) setRunError("statusFailed")
      }
    )
  }, [stableTarget, config.id, attach])

  useEffect(() => {
    if (!proposal) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [proposal])

  useEffect(() => {
    const consume = () => {
      const request = consumeAcceptancePanelRequest()
      if (!request) return
      setCriteria(request.criteria)
      setDeliveryId(request.deliveryId)
      setProposal(undefined)
      setConfirmedCost(false)
      void managedDesktopHandoffClient
        .deliveries(stableTarget())
        .then((next) => {
          if (!alive.current) return
          setDeliveries(next)
          setLoaded(true)
          setMode(next.find((row) => row.id === request.deliveryId)?.modes[0] ?? "commit")
        })
        .catch(() => {
          if (alive.current) setRunError("proposalUnavailable")
        })
    }
    consume()
    return subscribeAcceptancePanelRequest(consume)
  }, [stableTarget])

  const live = runs.filter(activeRun)
  const canStart =
    !busy &&
    live.length === 0 &&
    !!proposal?.executionEnabled &&
    proposal.expiresAt > now &&
    proposal.quote.expiresAt > now &&
    confirmedCost &&
    valid &&
    target.kind === "local"

  async function start() {
    if (
      !canStart ||
      !preparedInput.current ||
      pending.current ||
      !proposal ||
      proposal.expiresAt <= Date.now() ||
      proposal.quote.expiresAt <= Date.now()
    )
      return
    // The criteria become the child's first prompt, which the send-time gate
    // would refuse only after the Host has billed a desktop. Refuse first.
    if (!hasNoLeakingPiiDeep(preparedInput.current.criteria)) {
      setRunError("criteriaSensitive")
      return
    }
    pending.current = true
    setBusy(true)
    setRunError(undefined)
    const identity = managedDesktopIdentityScope(target)
    let run: ManagedDesktopAcceptanceRun | undefined
    try {
      // An uncertain transport response reuses this intent; a fresh click after a
      // successful start gets its own key. The Host reconciles duplicate intents.
      const input = startIntent.current ?? {
        ...preparedInput.current,
        idempotencyKey: crypto.randomUUID(),
      }
      startIntent.current = input
      run = await managedDesktopHandoffClient.acceptanceStart(target, input)
      identity.assertActive()
      if (!alive.current) throw new Error("runFailed")
      startIntent.current = undefined
      setRuns((previous) => [
        ...previous.filter((row) => row.acceptanceId !== run!.acceptanceId),
        run!,
      ])
      setConfirmedCost(false)
      await attach(run)
    } catch {
      if (run) {
        try {
          identity.assertActive()
          await managedDesktopHandoffClient.acceptanceCancel(target, run.acceptanceId)
        } catch {
          if (alive.current) setRunError("cancelFailed")
        }
      }
      if (alive.current) setRunError((previous) => previous ?? "runFailed")
    } finally {
      identity.dispose()
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }

  async function cancel(run: ManagedDesktopAcceptanceRun) {
    if (
      !(await confirm({
        title: a("cancelTitle"),
        description: a("cancelDescription"),
        destructive: true,
      }))
    )
      return
    await perform(async () => {
      const next = await managedDesktopHandoffClient.acceptanceCancel(target, run.acceptanceId)
      if (alive.current)
        setRuns((previous) =>
          previous.map((row) => (row.acceptanceId === next.acceptanceId ? next : row))
        )
    })
  }

  async function perform(action: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    setProposal(undefined)
    setConfirmedCost(false)
    try {
      await action()
    } catch (cause) {
      if (alive.current) setError(managedDesktopHandoffErrorKey(cause))
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }

  async function load() {
    await perform(async () => {
      const next = await managedDesktopHandoffClient.deliveries(target)
      if (!alive.current) return
      setDeliveries(next)
      setLoaded(true)
      setDeliveryId("")
    })
  }

  async function prepare() {
    if (!valid || !selected || !parsedArgv) return
    await perform(async () => {
      const request = {
        deliveryId: selected.id,
        deliveryRevision: selected.revision,
        mode,
        providerConfigId: config.id,
        lifetimeSeconds,
        criteria,
        acceptanceFiles: lines(files),
        argv: parsedArgv,
      }
      const next = await managedDesktopHandoffClient.prepare(target, request)
      if (alive.current) {
        preparedInput.current = { ...request, quoteId: next.quote.id, idempotencyKey: "" }
        startIntent.current = undefined
        setNow(Date.now())
        setProposal(next)
      }
    })
  }

  const money = (micros: number) =>
    `${proposal?.quote.currency ?? "USD"} ${(micros / 1_000_000).toFixed(4)}`
  return (
    <section aria-label={t("title")} className="space-y-3 border-t pt-3">
      <h4 className="text-sm font-medium">{t("title")}</h4>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      <p className="text-xs text-muted-foreground">{t("sourceScope")}</p>
      {proposal && !proposal.executionEnabled ? (
        <p
          className="text-xs text-muted-foreground"
          data-dormant="managed-desktop-handoff-execution"
        >
          {a("executionDisabled")}
        </p>
      ) : null}
      {target.kind === "remote" ? (
        <p
          className="text-xs text-muted-foreground"
          data-dormant="managed-desktop-remote-acceptance"
        >
          {a("localOnly")}
        </p>
      ) : null}
      <p
        className="text-xs text-muted-foreground"
        data-dormant="managed-desktop-live-preview-cross-host-project-auto"
      >
        {t("unsupported")}
      </p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
        {t("load")}
      </Button>
      {loaded && deliveries.length === 0 ? <p className="text-xs">{t("empty")}</p> : null}
      {deliveries.length > 0 ? (
        <fieldset
          disabled={busy || live.length > 0}
          className="space-y-3"
          onChange={() => {
            setProposal(undefined)
            setConfirmedCost(false)
          }}
        >
          <Label htmlFor={`${id}-delivery`}>{t("delivery")}</Label>
          <NativeSelect
            id={`${id}-delivery`}
            value={deliveryId}
            onChange={(event) => {
              setDeliveryId(event.target.value)
              const next = deliveries.find((item) => item.id === event.target.value)
              setMode(next?.modes[0] ?? "commit")
            }}
          >
            <NativeSelectOption value="">{t("chooseDelivery")}</NativeSelectOption>
            {deliveries.map((delivery) => (
              <NativeSelectOption key={delivery.id} value={delivery.id}>
                {t("deliveryOption", {
                  id: delivery.id,
                  revision: delivery.revision,
                  commit: delivery.commit,
                })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Label htmlFor={`${id}-mode`}>{t("mode")}</Label>
          <NativeSelect
            id={`${id}-mode`}
            value={mode}
            onChange={(event) => setMode(event.target.value as ManagedDesktopHandoffMode)}
          >
            <NativeSelectOption value="commit" disabled={!selected?.modes.includes("commit")}>
              {t("commit")}
            </NativeSelectOption>
            <NativeSelectOption value="bundle" disabled={!selected?.modes.includes("bundle")}>
              {t("bundle")}
            </NativeSelectOption>
          </NativeSelect>
          <ManagedDesktopAcceptanceCriteria
            value={criteria}
            onChange={(next) => {
              setCriteria(next)
              setProposal(undefined)
              setConfirmedCost(false)
            }}
          />
          <Label htmlFor={`${id}-files`}>{t("files")}</Label>
          <Textarea
            id={`${id}-files`}
            value={files}
            onChange={(event) => setFiles(event.target.value)}
            aria-describedby={`${id}-files-help`}
          />
          <p id={`${id}-files-help`} className="text-xs text-muted-foreground">
            {t("filesHelp")}
          </p>
          <Label htmlFor={`${id}-argv`}>{t("argv")}</Label>
          <Textarea
            id={`${id}-argv`}
            value={argv}
            onChange={(event) => setArgv(event.target.value)}
            aria-describedby={`${id}-argv-help`}
          />
          <p id={`${id}-argv-help`} className="text-xs text-muted-foreground">
            {t("argvHelp")}
          </p>
          <Label htmlFor={`${id}-minutes`}>{t("lifetime")}</Label>
          <Input
            id={`${id}-minutes`}
            type="number"
            min={1}
            max={Math.min(60, config.maxLifetimeSeconds / 60)}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
          <Button size="sm" variant="outline" disabled={!valid} onClick={() => void prepare()}>
            {t("prepare")}
          </Button>
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(error)}
        </p>
      ) : null}
      {proposal ? (
        <div role="status" className="space-y-1 text-xs">
          <p>{t("prepared", { commit: proposal.commit, revision: proposal.deliveryRevision })}</p>
          <p>{cost("spec", { cpu: proposal.quote.cpuCount, memory: proposal.quote.memoryMb })}</p>
          <p>{cost("hourly", { cost: money(proposal.quote.hourlyRateMicros) })}</p>
          <p>{cost("maximum", { cost: money(proposal.quote.maximumComputeCostMicros) })}</p>
          <p>{cost("costs")}</p>
          <p>{t("expires", { at: new Date(proposal.expiresAt).toISOString() })}</p>
          {proposal.expiresAt <= now || proposal.quote.expiresAt <= now ? (
            <p>{a("quoteExpired")}</p>
          ) : null}
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-confirm-cost`}
              checked={confirmedCost}
              onCheckedChange={(checked) => setConfirmedCost(checked === true)}
            />
            <Label htmlFor={`${id}-confirm-cost`}>{a("confirmCost")}</Label>
          </div>
        </div>
      ) : null}
      <Button size="sm" disabled={!canStart} onClick={() => void start()}>
        {a("start")}
      </Button>
      {runError ? (
        <p role="alert" className="text-xs text-destructive">
          {a(runError)}
        </p>
      ) : null}
      {runs.map((run) => (
        <div key={run.acceptanceId} role="status" className="space-y-1 text-xs">
          <p>{a("runState", { id: run.acceptanceId, state: a(`state.${run.state}`) })}</p>
          {run.deadlineAt !== null ? (
            <p>{a("deadline", { at: new Date(run.deadlineAt).toISOString() })}</p>
          ) : null}
          {activeRun(run) ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void cancel(run)}
            >
              {a("cancel")}
            </Button>
          ) : null}
        </div>
      ))}
      {dialog}
    </section>
  )
}
