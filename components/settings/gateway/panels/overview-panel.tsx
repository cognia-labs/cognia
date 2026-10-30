"use client"

/**
 * Settings → Gateway → Overview.
 *
 * The read-only face of the gateway: run state, the durable call counters, the
 * routing snapshot the listener is serving from, the client connect snippets,
 * and the upstream self-check.
 *
 * Most of what this renders already existed and was simply never shown.
 * `GatewayStatus` carries `callsTotal`, `lastCallAt`, `snapshotGeneratedAtMs`,
 * `snapshotProviderCount` and `snapshotAliasCount`; before this panel every one
 * of them appeared only in a test fixture. `/healthz/upstream` was likewise
 * fully implemented Rust-side with no caller anywhere in the app.
 *
 * A "Get started" list sits on top until the first request has been served
 * (`overview-setup-steps.tsx`): create a key, start, connect — each with the
 * action that does it, so a keyless first visit no longer ends at a locked
 * switch. The request counter opens the request log.
 *
 * Times are relative ("2 minutes ago") with the absolute value on hover, via
 * `SinceTime`: a bare `toLocaleTimeString()` made yesterday's last request
 * read as today's.
 */

import { useCallback, useRef, useState } from "react"
import { useNow, useTranslations } from "next-intl"
import {
  ActivityIcon,
  ArrowUpRightIcon,
  CheckCircle2Icon,
  Loader2Icon,
  LockIcon,
  PlugIcon,
  StethoscopeIcon,
  XCircleIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Snippet, SnippetCopyButton, SnippetInput } from "@/components/ai-elements/snippet"
import {
  MotionCollapse,
  MotionReveal,
  MotionStatusSwap,
  useFlowMotion,
} from "@/components/chat/motion/motion-reveal"
import { RollingNumber } from "@/components/settings/subagents/motion/rolling-number"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { InputGroupTextarea } from "@/components/ui/input-group"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { shellQuote } from "@/lib/mcp/config-transfer"
import { isGatewayAccountLocked } from "@/lib/gateway/status"
import { gatewayProbeUpstream } from "@/lib/tauri/gateway"
import type { GatewayConfig, GatewayStatus, GatewayUpstreamProbeResult } from "@/types/gateway"

import type { GatewayNavigate, GatewayPanelContext } from "../gateway-section"
import { GatewayPanelSection, GatewayPanelStack } from "../shared/panel-section"
import { SinceTime } from "../shared/since-time"
import { GatewaySetupSteps, isGatewaySetupComplete } from "./overview-setup-steps"
import { GatewayClientConnections } from "../gateway-client-connections"

/** The first connect snippet — focused when the setup list sends the user there. */
const FIRST_SNIPPET_INPUT_ID = "gw-snippet-anthropic"

export interface GatewayOverviewPanelProps {
  ctx: GatewayPanelContext
  /** True while a start/stop round-trip is in flight. */
  starting: boolean
  onToggleEnabled: (next: boolean) => Promise<void>
  onRefreshStatus: () => Promise<void>
  /** Open another gateway panel (setup steps, the request counter). */
  onNavigate: GatewayNavigate
}

/**
 * The origin external clients should dial: the operator's public origin when
 * one is set (it exists precisely because the listener address is not what
 * callers reach), otherwise loopback on the bound — or configured — port.
 */
export function gatewayClientOrigin(config: GatewayConfig, status: GatewayStatus | null): string {
  const publicOrigin = config.publicOrigin?.trim().replace(/\/+$/, "")
  if (publicOrigin) return publicOrigin
  return `http://127.0.0.1:${status?.boundPort ?? config.port}`
}

export function GatewayOverviewPanel({
  ctx,
  starting,
  onToggleEnabled,
  onRefreshStatus,
  onNavigate,
}: GatewayOverviewPanelProps) {
  const t = useTranslations("settings.gateway")
  const now = useNow({ updateInterval: 15_000 })
  const { reduce } = useFlowMotion()
  const { config, status } = ctx
  const connectRef = useRef<HTMLDivElement>(null)
  const [primaryAlias, setPrimaryAlias] = useState("")
  const [helperAlias, setHelperAlias] = useState("")

  const running = status?.running ?? false
  const origin = gatewayClientOrigin(config, status)
  const aliases = status?.modelAliases ?? []
  const selectedPrimary = aliases.includes(primaryAlias) ? primaryAlias : aliases[0]
  const selectedHelper = aliases.includes(helperAlias)
    ? helperAlias
    : (aliases[1] ?? selectedPrimary)
  const roleSnippet =
    selectedPrimary && selectedHelper
      ? [
          `export ANTHROPIC_BASE_URL=${shellQuote(origin)}`,
          'export ANTHROPIC_API_KEY="$COGNIA_GATEWAY_KEY"',
          `export ANTHROPIC_MODEL=${shellQuote(selectedPrimary)}`,
          `export ANTHROPIC_DEFAULT_HAIKU_MODEL=${shellQuote(selectedHelper)}`,
        ].join("\n")
      : null
  const accountLocked = isGatewayAccountLocked(status)
  const lastCall = status?.lastCallAt ? new Date(status.lastCallAt) : null
  const snapshotAt = status?.snapshotGeneratedAtMs ? new Date(status.snapshotGeneratedAtMs) : null
  // Hidden until status has hydrated: before that every step would read as
  // unfinished and the list would flash in for a returning user.
  const showSetup =
    status !== null &&
    !isGatewaySetupComplete({
      hasToken: status.hasToken,
      running: status.running,
      callsTotal: status.callsTotal,
    })

  const onShowConnect = useCallback(() => {
    connectRef.current?.scrollIntoView?.({
      behavior: reduce ? "auto" : "smooth",
      block: "start",
    })
    // Focus without a second jump, so keyboard users land on the snippet too.
    document.getElementById(FIRST_SNIPPET_INPUT_ID)?.focus({ preventScroll: true })
  }, [reduce])

  const snippets = [
    { id: "anthropic", label: t("anthropicSnippet"), value: `ANTHROPIC_BASE_URL=${origin}` },
    { id: "openai", label: t("openaiSnippet"), value: `OPENAI_BASE_URL=${origin}/v1` },
    {
      id: "verify",
      label: t("verifySnippet"),
      value: `curl -H "Authorization: Bearer $COGNIA_GATEWAY_KEY" ${origin}/v1/models`,
    },
  ]

  return (
    <GatewayPanelStack>
      {showSetup && status ? (
        <GatewaySetupSteps
          hasToken={status.hasToken}
          running={status.running}
          callsTotal={status.callsTotal}
          accountLocked={accountLocked}
          starting={starting}
          onCreateKey={() => onNavigate("keys")}
          onStart={() => void onToggleEnabled(true)}
          onShowConnect={onShowConnect}
        />
      ) : null}

      <GatewayPanelSection
        icon={<ActivityIcon className="size-4" />}
        title={t("serverHeading")}
        description={t("enabledHelp")}
        badge={running ? t("badgeRunning") : t("badgeStopped")}
        badgeVariant={running ? "default" : "outline"}
        action={
          <div className="flex items-center gap-2">
            {starting ? (
              <Loader2Icon
                className="size-3.5 animate-spin text-muted-foreground"
                data-testid="gateway-toggle-pending"
                aria-hidden
              />
            ) : null}
            <Switch
              id="gw-enabled"
              // Disabled mid-flight: without it a double-click queues a stop
              // behind a start and the UI ends up disagreeing with Rust. The key
              // check gates STARTING only — a running listener whose last key
              // was just deleted must still be stoppable from here.
              disabled={starting || (!running && !status?.hasToken)}
              checked={running}
              onCheckedChange={(next) => void onToggleEnabled(next)}
              aria-label={t("enabled")}
            />
          </div>
        }
      >
        <MotionCollapse open={accountLocked}>
          <Alert data-testid="gateway-account-locked">
            <LockIcon />
            <AlertDescription>{t("accountLocked")}</AlertDescription>
          </Alert>
        </MotionCollapse>

        <div className="grid grid-cols-2 gap-2 @lg/gateway-pane:grid-cols-4">
          <StatTile
            label={t("statCalls")}
            value={<RollingNumber value={status?.callsTotal ?? 0} />}
            testId="gateway-stat-calls"
            onOpen={() => onNavigate("logs")}
            openLabel={t("statCallsOpenLog")}
          />
          <StatTile
            label={t("statLastCall")}
            value={lastCall ? <SinceTime date={lastCall} now={now} /> : t("statNever")}
            testId="gateway-stat-last-call"
          />
          <StatTile
            label={t("statProviders")}
            value={<RollingNumber value={status?.snapshotProviderCount ?? 0} />}
            testId="gateway-stat-providers"
          />
          <StatTile
            label={t("statAliases")}
            value={<RollingNumber value={status?.snapshotAliasCount ?? 0} />}
            testId="gateway-stat-aliases"
          />
        </div>

        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs @lg/gateway-pane:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t("snapshotLabel")}</dt>
          <dd data-testid="gateway-snapshot-age">
            {snapshotAt ? (
              <SinceTime
                date={snapshotAt}
                now={now}
                label={(time) => t("snapshotGeneratedAt", { time })}
              />
            ) : (
              <span className="text-muted-foreground">{t("snapshotNone")}</span>
            )}
          </dd>
          <dt className="text-muted-foreground">{t("routingLabel")}</dt>
          <dd data-testid="gateway-routing-authority">
            {status?.localRoutingEnabled
              ? t("localRoutingActive", {
                  revision: status.routingPolicyRevision ?? t("routingRevisionUnavailable"),
                })
              : t("localRoutingLegacy")}
            {status?.localRoutingEnabled && status.routingStrategy ? (
              <span className="text-muted-foreground" data-testid="gateway-auto-strategy">
                {" · "}
                {t("autoStrategy", { strategy: status.routingStrategy })}
              </span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">{t("routingModeLabel")}</dt>
          <dd>{t(config.gatewayLocalRoutingV2 ? "routingLocalHelp" : "routingLiveHelp")}</dd>
        </dl>
        {status?.routingStrategyUnavailable ? (
          <Alert variant="destructive">
            <AlertDescription>
              {t("strategyUnavailable", { strategy: status.routingStrategyUnavailable })}
            </AlertDescription>
          </Alert>
        ) : null}
      </GatewayPanelSection>

      <UpstreamSelfCheckSection running={running} onProbed={onRefreshStatus} />

      {status?.subscriptionRotationProviders?.length ? (
        <GatewayPanelSection
          title={t("subscriptionRotationHeading")}
          description={t("subscriptionRotationHelp")}
        >
          {status.subscriptionRotationProviders.map(({ providerId, accountCount }) => (
            <div key={providerId} className="flex items-center gap-2">
              <Checkbox
                id={`gw-rotate-${providerId}`}
                aria-label={t("subscriptionRotationProvider", { providerId, count: accountCount })}
                checked={config.subscriptionRotationProviderIds?.includes(providerId) ?? false}
                onCheckedChange={(checked) =>
                  void ctx.persist({
                    subscriptionRotationProviderIds:
                      checked === true
                        ? [
                            ...new Set([
                              ...(config.subscriptionRotationProviderIds ?? []),
                              providerId,
                            ]),
                          ]
                        : (config.subscriptionRotationProviderIds ?? []).filter(
                            (id) => id !== providerId
                          ),
                  })
                }
              />
              <Label htmlFor={`gw-rotate-${providerId}`}>
                {t("subscriptionRotationProvider", { providerId, count: accountCount })}
              </Label>
            </div>
          ))}
        </GatewayPanelSection>
      ) : null}

      <GatewayPanelSection title={t("privacyHeading")} description={t("privacyMaskTextHelp")}>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="gw-privacy-mask" className="text-sm">
            {t("privacyMaskText")}
          </Label>
          <Switch
            id="gw-privacy-mask"
            aria-label={t("privacyMaskText")}
            checked={config.privacyMode === "mask"}
            onCheckedChange={(next) => void ctx.persist({ privacyMode: next ? "mask" : "off" })}
          />
        </div>
      </GatewayPanelSection>

      <GatewayPanelSection
        title={t("gatewayExtensionsHeading")}
        description={t("gatewayExtensionsHelp")}
      >
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="gw-extensions" className="text-sm">
            {t("gatewayExtensionsEnabled")}
          </Label>
          <Switch
            id="gw-extensions"
            aria-label={t("gatewayExtensionsEnabled")}
            checked={config.middlewareEnabled === true}
            onCheckedChange={(next) => void ctx.persist({ middlewareEnabled: next })}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("gatewayBridgeHelp")}</p>
        <div className="grid gap-3 @lg/gateway-pane:grid-cols-2">
          {(["search", "vision"] as const).map((kind) => {
            const configured = config.bridgeModels?.[kind]
            const unavailable = configured && !aliases.includes(configured)
            return (
              <div key={kind} className="space-y-1.5">
                <Label htmlFor={`gw-bridge-${kind}`}>
                  {t(kind === "search" ? "gatewayBridgeSearch" : "gatewayBridgeVision")}
                </Label>
                <Select
                  value={configured ? `alias:${configured}` : "off"}
                  onValueChange={(value) =>
                    void ctx.persist({
                      bridgeModels: {
                        ...config.bridgeModels,
                        [kind]: value === "off" ? undefined : value.slice("alias:".length),
                      },
                    })
                  }
                >
                  <SelectTrigger
                    id={`gw-bridge-${kind}`}
                    aria-label={t(
                      kind === "search" ? "gatewayBridgeSearch" : "gatewayBridgeVision"
                    )}
                    className="w-full min-w-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">{t("gatewayBridgeDisabled")}</SelectItem>
                    {unavailable ? (
                      <SelectItem value={`alias:${configured}`} disabled>
                        {configured}
                      </SelectItem>
                    ) : null}
                    {aliases.map((alias) => (
                      <SelectItem key={alias} value={`alias:${alias}`}>
                        {alias}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {unavailable ? (
                  <p className="text-xs text-destructive">{t("gatewayBridgeAliasUnavailable")}</p>
                ) : null}
              </div>
            )
          })}
        </div>
      </GatewayPanelSection>

      <div ref={connectRef} className="scroll-mt-3" data-testid="gateway-connect-section">
        <GatewayPanelSection
          icon={<PlugIcon className="size-4" />}
          title={t("connectHeading")}
          description={t("connectHelp")}
        >
          {snippets.map((snippet) => (
            <div key={snippet.id} className="flex min-w-0 flex-col gap-1">
              <Label htmlFor={`gw-snippet-${snippet.id}`} className="text-xs text-muted-foreground">
                {snippet.label}
              </Label>
              <Snippet code={snippet.value} className="min-w-0">
                <SnippetInput id={`gw-snippet-${snippet.id}`} className="text-xs" />
                <SnippetCopyButton
                  aria-label={`${t("copy")} ${snippet.label}`}
                  title={t("copy")}
                  onCopy={() => toast.success(t("copied"))}
                  onError={(error) =>
                    toast.error(error instanceof Error ? error.message : t("copyFailed"))
                  }
                />
              </Snippet>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{t("authNote")}</p>
          <div className="grid gap-3 border-t pt-3 text-xs @lg/gateway-pane:grid-cols-2">
            <div className="space-y-1">
              <p className="font-medium">{t("ordinaryClientsTitle")}</p>
              <p className="text-muted-foreground">{t("ordinaryClientsHelp")}</p>
            </div>
            <div className="space-y-1">
              <p className="font-medium">{t("managedTasksTitle")}</p>
              <p className="text-muted-foreground">{t("managedTasksHelp")}</p>
              <Button size="sm" variant="outline" onClick={() => onNavigate("tickets")}>
                {t("managedTasksOpen")}
              </Button>
            </div>
          </div>
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-medium">{t("roleModelsTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("roleModelsHelp")}</p>
            {roleSnippet ? (
              <>
                <p className="text-[11px] text-muted-foreground">{t("roleAliasesLive")}</p>
                <div className="grid gap-2 @md/gateway-pane:grid-cols-2">
                  {(
                    [
                      ["primary", t("rolePrimaryAlias"), selectedPrimary, setPrimaryAlias],
                      ["helper", t("roleHelperAlias"), selectedHelper, setHelperAlias],
                    ] as const
                  ).map(([id, label, value, onChange]) => (
                    <div key={id} className="space-y-1">
                      <Label htmlFor={`gw-role-${id}`} className="text-xs">
                        {label}
                      </Label>
                      <Select value={value} onValueChange={onChange}>
                        <SelectTrigger
                          id={`gw-role-${id}`}
                          className="w-full text-xs"
                          aria-label={label}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {aliases.map((alias) => (
                            <SelectItem key={alias} value={alias}>
                              {alias}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
                <Label htmlFor="gw-role-snippet" className="text-xs">
                  {t("roleSnippet")}
                </Label>
                <Snippet code={roleSnippet} className="min-w-0">
                  <InputGroupTextarea
                    id="gw-role-snippet"
                    className="min-h-24 text-xs"
                    readOnly
                    value={roleSnippet}
                  />
                  <SnippetCopyButton
                    aria-label={t("roleSnippetCopy")}
                    title={t("copy")}
                    onCopy={() => toast.success(t("copied"))}
                    onError={() => toast.error(t("copyFailed"))}
                  />
                </Snippet>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{t("roleAliasesUnavailable")}</p>
            )}
          </div>
          <GatewayClientConnections
            primaryAlias={selectedPrimary}
            helperAlias={selectedHelper}
            running={running}
            accountGeneration={status?.accountGeneration}
          />
          <p className="border-t pt-3 text-xs text-muted-foreground">
            {t("headlessCredentialsHelp")}
          </p>
          {config.publicOrigin ? (
            <p className="text-xs text-muted-foreground" data-testid="gateway-origin-note">
              {t("connectUsesPublicOrigin")}
            </p>
          ) : status?.bindInterface === "lan" ? (
            <p className="text-xs text-muted-foreground" data-testid="gateway-origin-note">
              {t("connectLanNote")}
            </p>
          ) : null}
        </GatewayPanelSection>
      </div>
    </GatewayPanelStack>
  )
}

function StatTile({
  label,
  value,
  testId,
  onOpen,
  openLabel,
}: {
  label: string
  value: React.ReactNode
  testId: string
  /** Makes the tile a button that opens the surface behind the number. */
  onOpen?: () => void
  /** Accessible name / tooltip for that action; required with `onOpen`. */
  openLabel?: string
}) {
  const content = (
    <ItemContent className="min-w-0">
      <ItemDescription className="flex items-center gap-1 text-[11px]">
        {label}
        {onOpen ? <ArrowUpRightIcon className="size-3" aria-hidden /> : null}
      </ItemDescription>
      <ItemTitle className="truncate text-sm tabular-nums">{value}</ItemTitle>
    </ItemContent>
  )
  if (!onOpen) {
    return (
      <Item variant="muted" size="sm" data-testid={testId}>
        {content}
      </Item>
    )
  }
  return (
    <Item asChild variant="muted" size="sm">
      <button
        type="button"
        className="cursor-pointer text-left hover:bg-accent/50"
        onClick={onOpen}
        title={openLabel}
        data-testid={testId}
      >
        {content}
        {/* Appended, not an aria-label: that would replace the number itself
            in the accessible name. */}
        {openLabel ? <span className="sr-only">{openLabel}</span> : null}
      </button>
    </Item>
  )
}

/**
 * Drives `gateway_probe_upstream`, the IPC path onto the loopback-only
 * `/healthz/upstream` route. Every row is a real, billable upstream call, so
 * this never runs on mount — only on an explicit click.
 */
function UpstreamSelfCheckSection({
  running,
  onProbed,
}: {
  running: boolean
  onProbed: () => Promise<void>
}) {
  const t = useTranslations("settings.gateway")
  const [model, setModel] = useState("")
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<GatewayUpstreamProbeResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onProbe = useCallback(async () => {
    const target = model.trim()
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const rows = await gatewayProbeUpstream(target)
      setResults(rows)
      // A probe counts toward callsTotal / in-flight, so pull fresh status.
      await onProbed()
    } catch (e) {
      setResults(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [model, onProbed])

  const okCount = (results ?? []).filter((row) => row.ok).length

  return (
    <GatewayPanelSection
      icon={<StethoscopeIcon className="size-4" />}
      title={t("selfCheckHeading")}
      description={t("selfCheckHelp")}
    >
      <div className="flex flex-col gap-2 @lg/gateway-pane:flex-row @lg/gateway-pane:items-end">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="gw-probe-model" className="text-xs">
            {t("selfCheckModel")}
          </Label>
          <Input
            id="gw-probe-model"
            value={model}
            placeholder={t("selfCheckModelPlaceholder")}
            className="font-mono text-xs"
            onChange={(e) => setModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return
              e.preventDefault()
              void onProbe()
            }}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="self-start @lg/gateway-pane:self-auto"
          // Probing a stopped gateway would report against throwaway state, so
          // Rust refuses it; disable rather than surface that as an error.
          disabled={!running || busy || !model.trim()}
          onClick={() => void onProbe()}
          data-testid="gateway-probe-run"
        >
          {busy ? (
            <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
          ) : (
            <StethoscopeIcon className="mr-1.5 size-3.5" aria-hidden />
          )}
          {t("selfCheckRun")}
        </Button>
      </div>

      {!running ? (
        <Alert>
          <AlertDescription>{t("selfCheckNeedsRunning")}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("selfCheckBillingWarning")}</p>

      <MotionCollapse open={error !== null}>
        {error ? (
          <Alert variant="destructive" data-testid="gateway-probe-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </MotionCollapse>

      <MotionCollapse open={results !== null && results.length > 0}>
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground" data-testid="gateway-probe-summary">
            {t("selfCheckSummary", { ok: okCount, total: results?.length ?? 0 })}
          </p>
          <ItemGroup className="gap-1.5" data-testid="gateway-probe-results">
            {(results ?? []).map((row, index) => (
              <MotionReveal key={`${row.providerId}-${row.modelId}`} index={index}>
                <Item role="listitem" size="sm" variant="muted" className="items-start">
                  <ItemContent className="min-w-0">
                    <ItemTitle className="w-full truncate font-mono text-xs">
                      {row.providerId} · {row.modelId}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none text-xs tabular-nums">
                      {t("latencyMs", { ms: row.latencyMs })}
                    </ItemDescription>
                    {row.error ? (
                      <p
                        className="whitespace-pre-wrap break-words text-[11px] text-destructive"
                        data-testid={`gateway-probe-error-${row.providerId}`}
                      >
                        {row.error}
                      </p>
                    ) : null}
                  </ItemContent>
                  <MotionStatusSwap swapKey={`${row.providerId}-${row.ok}`}>
                    <Badge
                      variant={row.ok ? "secondary" : "destructive"}
                      aria-label={t(row.ok ? "logFilterOk" : "logFilterErrors")}
                    >
                      {row.ok ? (
                        <CheckCircle2Icon className="size-3.5" aria-hidden />
                      ) : (
                        <XCircleIcon className="size-3.5" aria-hidden />
                      )}
                      {row.status ?? t("selfCheckNoStatus")}
                    </Badge>
                  </MotionStatusSwap>
                </Item>
              </MotionReveal>
            ))}
          </ItemGroup>
        </div>
      </MotionCollapse>
    </GatewayPanelSection>
  )
}
