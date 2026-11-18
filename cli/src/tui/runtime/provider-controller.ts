/**
 * `/provider <usage|inspect|capabilities|probe>`, `/models` and `/balance`
 * controller. Every verb delegates to `cli/src/provider/*`, the same modules
 * `cognia-agent provider …` runs, so the panel and the terminal command
 * cannot answer differently.
 *
 * They answer where the CLI command answers without flags: the selected Host
 * (`COGNIA_PROFILE`, `COGNIA_SERVER_URL`, `host use`) for `/balance` and
 * `/provider probe`, this machine for the rest, and every document says which.
 *
 * Overlays are the existing ones: `/models` seeds the real model switcher
 * (the `model` overlay) from the catalog and live-refreshes it with the
 * discovered inventory, `/balance` opens the `limits` panel filtered to
 * balance meters, and the rest render markdown in the document pager. The
 * loading overlays open immediately, like `/limits`, so a slow provider
 * cannot turn subsequent input into a queued steer.
 */

import type { ProviderLimits } from "@/types/subscription"

import type { ConnectDeps } from "../../api/connect"
import type { HostTransport } from "../../api/transport"
import { renderFailure, type CliFailure } from "../../cli/errors"
import type { ResolvedConfig } from "../../config/schema"
import { readProviderCapabilities } from "../../provider/capabilities"
import { readProviderLimits } from "../../provider/limits"
import {
  createCliProviderExecutor,
  isConfiguredLocally,
  type CliProviderExecutor,
} from "../../provider/local"
import { listProviderModels } from "../../provider/models"
import { probeLocally, type ProviderProbeReport } from "../../provider/probe"
import {
  localWhileHostSelected,
  selectProviderTarget,
  type ProviderTarget,
  type ProviderTargetResult,
} from "../../provider/target"
import { readProviderUsage, type ReadUsageDeps } from "../../provider/usage"
import { collectModelOptions } from "../components/model-options"
import {
  formatCapabilitiesDocument,
  formatInspectDocument,
  formatMeterSummary,
  formatProbeDocument,
  formatUsageDocument,
} from "../format/provider"
import type { RateLimitSnapshot } from "../format/rate-limits"
import { analyzeSession } from "../format/usage-analysis"
import type { ToolStat, TuiAction } from "../state/types"
import { isBuiltinBackend } from "./backend-capabilities"
import { allocateLimitsRequestId, runLimits, type LimitsDeps } from "./limits-controller"

export const PROVIDER_ACTIONS = [
  "models",
  "balance",
  "usage",
  "inspect",
  "capabilities",
  "probe",
] as const
export type ProviderAction = (typeof PROVIDER_ACTIONS)[number]

type LimitsLoader = NonNullable<Parameters<typeof readProviderLimits>[0]["loadLimits"]>

export interface ProviderControllerDeps {
  dispatch: (action: TuiAction) => void
  config: ResolvedConfig
  /** Config home (`~/.cognia`), for the usage ledgers. */
  home: string
  action: string
  /** A provider id (usage, inspect, capabilities) or a model id (probe). */
  arg?: string
  signal?: AbortSignal
  now?: () => number
  usageHistory?: number[]
  toolStats?: Record<string, ToolStat>
  rateLimits?: RateLimitSnapshot
  presetId?: string
  backendAgentId?: string
  agentRateLimits?: LimitsDeps["agentRateLimits"]
  loadCodexLimits?: LimitsDeps["loadCodexLimits"]
  /** Where `hosts.json` is looked up from (defaults to the process's). */
  cwd?: string
  env?: Record<string, string | undefined>
  /** Seams (tests). Production resolves the selected Host and the real executor. */
  selectTarget?: () => ProviderTargetResult
  connect?: (
    target: Extract<ProviderTarget, { kind: "host" }>,
    deps: ConnectDeps
  ) => Promise<{ ok: true; transport: HostTransport } | { ok: false; failure: CliFailure }>
  connectDeps?: ConnectDeps
  createExecutor?: (config: ResolvedConfig) => CliProviderExecutor
  loadLimits?: LimitsLoader
  ensureDb?: ReadUsageDeps["ensureDb"]
  fsx?: ReadUsageDeps["fsx"]
  modelCatalog?: ReadUsageDeps["modelCatalog"]
  modelOptions?: (config: ResolvedConfig) => string[]
}

let nextProviderRequestId = 0

function isAction(value: string): value is ProviderAction {
  return (PROVIDER_ACTIONS as readonly string[]).includes(value)
}

function providerArg(deps: ProviderControllerDeps): string | null | undefined {
  const id = deps.arg?.trim()
  if (!id) return undefined
  if (isConfiguredLocally(deps.config, id)) return id
  deps.dispatch({
    type: "NOTICE",
    message: `Provider "${id}" is not configured on this machine. Configured: ${Object.keys(deps.config.providers ?? {}).join(", ") || "none"}.`,
    severity: "error",
  })
  return null
}

function cliFailureNotice(deps: ProviderControllerDeps, failure: CliFailure): void {
  deps.dispatch({ type: "NOTICE", message: renderFailure(failure).trimEnd(), severity: "error" })
}

async function connectTarget(
  deps: ProviderControllerDeps,
  target: Extract<ProviderTarget, { kind: "host" }>
): Promise<{ ok: true; transport: HostTransport } | { ok: false; failure: CliFailure }> {
  if (deps.connect) return deps.connect(target, deps.connectDeps ?? {})
  // Loaded on use: the Host leg pulls the command contract and the TLS
  // pinning worker, which a session that never asks a Host does not need.
  const { connectResolvedHost } = await import("../../api/connect")
  return connectResolvedHost(target.host, deps.connectDeps ?? {})
}

/** A Host refusal carried through a promise chain with its whole Fix block. */
class HostVerbError extends Error {
  constructor(readonly failure: CliFailure) {
    super(renderFailure(failure).trimEnd())
    this.name = "HostVerbError"
  }
}

async function readBalanceFromHost(
  deps: ProviderControllerDeps,
  target: Extract<ProviderTarget, { kind: "host" }>,
  at: number
): Promise<{ snapshots: ProviderLimits[]; silent: string[] }> {
  const connected = await connectTarget(deps, target)
  if (!connected.ok) throw new HostVerbError(connected.failure)
  try {
    const { readHostBalance } = await import("../../provider/host")
    const result = await readHostBalance({ transport: connected.transport, target, now: () => at })
    if (!result.ok) throw new HostVerbError(result.failure)
    return result.report
  } finally {
    connected.transport.close?.()
  }
}

function failureNotice(deps: ProviderControllerDeps, what: string, error: unknown): void {
  deps.dispatch({
    type: "NOTICE",
    message: `${what} failed: ${error instanceof Error ? error.message : String(error)}`,
    severity: "error",
  })
}

export async function runProvider(deps: ProviderControllerDeps): Promise<void> {
  const { dispatch, config } = deps
  const action = deps.action.trim()
  if (!isAction(action)) {
    dispatch({
      type: "NOTICE",
      message: `Unknown /provider verb "${action}". Try: ${PROVIDER_ACTIONS.join(", ")}.`,
      severity: "error",
    })
    return
  }
  const now = deps.now ?? (() => Date.now())
  if (
    action === "balance" &&
    (!isBuiltinBackend(config.agentBackend) || Object.keys(deps.agentRateLimits ?? {}).length > 0)
  ) {
    runLimits({
      dispatch,
      config,
      now,
      presetId: deps.presetId,
      backendAgentId: deps.backendAgentId,
      agentRateLimits: deps.agentRateLimits,
      loadCodexLimits: deps.loadCodexLimits,
      usageHistory: deps.usageHistory,
      toolStats: deps.toolStats,
    })
    return
  }
  const requestId = ++nextProviderRequestId
  const isCurrent = () => nextProviderRequestId === requestId
  const executor = (deps.createExecutor ?? ((c) => createCliProviderExecutor(c)))(config)
  const selected = (
    deps.selectTarget ??
    (() =>
      selectProviderTarget({
        env: deps.env ?? process.env,
        home: deps.home,
        cwd: deps.cwd ?? process.cwd(),
      }))
  )()
  if (!selected.ok) {
    cliFailureNotice(deps, selected.failure)
    return
  }
  const target = selected.target

  switch (action) {
    case "models": {
      const seed = (deps.modelOptions ?? collectModelOptions)(config)
      dispatch({
        type: "OVERLAY_OPEN",
        overlay: { kind: "model", options: seed, index: 0, query: "" },
      })
      // The inventory is this credential's. Refresh the picker in place once
      // the provider answers, and say so when it does not.
      void listProviderModels({ config, executor, signal: deps.signal })
        .then((report) => {
          if (!isCurrent()) return
          if (report.failure) {
            dispatch({
              type: "NOTICE",
              message: `${report.providerId}: ${report.failure.availability}: ${report.failure.failure.message}`,
              severity: "error",
            })
            return
          }
          const ids = report.listing!.models.map((model) => model.id)
          if (ids.length === 0) {
            dispatch({ type: "NOTICE", message: `${report.providerId} lists no models.` })
            return
          }
          dispatch({ type: "OVERLAY_REFRESH_MODEL_OPTIONS", options: ids })
        })
        .catch((error: unknown) => {
          if (isCurrent()) failureNotice(deps, "Listing models", error)
        })
      return
    }

    case "balance": {
      const at = now()
      const limitsRequestId = allocateLimitsRequestId()
      dispatch({
        type: "OVERLAY_OPEN",
        overlay: {
          kind: "limits",
          snapshots: [],
          loading: true,
          requestId: limitsRequestId,
          analysis: analyzeSession({ usageHistory: deps.usageHistory, toolStats: deps.toolStats }),
          now: at,
          rateLimits: deps.rateLimits,
          activeProvider: config.provider,
        },
      })
      const load =
        target.kind === "host"
          ? readBalanceFromHost(deps, target, at)
          : readProviderLimits({
              config,
              verb: "balance",
              now: () => at,
              ...(deps.loadLimits ? { loadLimits: deps.loadLimits } : {}),
            })
      void load
        .then((report) => {
          dispatch({
            type: "LIMITS_LOADED",
            requestId: limitsRequestId,
            snapshots: report.snapshots,
          })
          if (!isCurrent()) return
          const summary = formatMeterSummary(report.snapshots, at)
          const answered = target.kind === "host" ? `Answered by: ${target.label}\n` : ""
          if (summary) dispatch({ type: "NOTICE", message: `${answered}${summary}` })
          else if (report.silent.length > 0) {
            dispatch({
              type: "NOTICE",
              message: `${answered}No balance meter for ${report.silent.join(", ")}.`,
            })
          } else if (target.kind === "host") {
            dispatch({
              type: "NOTICE",
              message: `${answered}The Host has measured no balance yet.`,
            })
          }
        })
        .catch((error: unknown) => {
          const label = target.kind === "host" ? target.label : config.provider
          dispatch({
            type: "LIMITS_LOADED",
            requestId: limitsRequestId,
            snapshots: [
              {
                provider: config.provider,
                accountId: config.provider,
                accountLabel: label,
                fetchedAt: at,
                meters: [],
                error: error instanceof Error ? error.message : String(error),
              },
            ],
          })
        })
      return
    }

    case "usage": {
      const providerId = providerArg(deps)
      if (providerId === null) return
      dispatch({ type: "NOTICE", message: "Reading usage…" })
      try {
        const report = await readProviderUsage({
          config,
          executor,
          home: deps.home,
          ...(providerId ? { providerId } : {}),
          now,
          ...(deps.ensureDb ? { ensureDb: deps.ensureDb } : {}),
          ...(deps.fsx ? { fsx: deps.fsx } : {}),
          ...(deps.modelCatalog ? { modelCatalog: deps.modelCatalog } : {}),
        })
        if (!isCurrent()) return
        dispatch({
          type: "OVERLAY_OPEN",
          overlay: {
            kind: "document",
            title: providerId ? `Usage · ${providerId}` : "Provider usage",
            body: formatUsageDocument(report),
            format: "markdown",
          },
        })
      } catch (error) {
        failureNotice(deps, "Reading usage", error)
      }
      return
    }

    case "capabilities": {
      const providerId = providerArg(deps)
      if (providerId === null) return
      dispatch({ type: "NOTICE", message: "Reading provider capabilities…" })
      try {
        const report = await readProviderCapabilities({
          config,
          executor,
          ...(providerId ? { providerId } : {}),
        })
        if (!isCurrent()) return
        dispatch({
          type: "OVERLAY_OPEN",
          overlay: {
            kind: "document",
            title: providerId ? `Capabilities · ${providerId}` : "Provider capabilities",
            body: formatCapabilitiesDocument(
              report,
              localWhileHostSelected(
                target,
                "the operation profile is computed from this machine's configuration"
              )
            ),
            format: "markdown",
          },
        })
      } catch (error) {
        failureNotice(deps, "Reading capabilities", error)
      }
      return
    }

    case "inspect": {
      const picked = providerArg(deps)
      if (picked === null) return
      const providerId = picked ?? config.provider
      dispatch({ type: "NOTICE", message: `Inspecting ${providerId}…` })
      try {
        const [capabilities, models] = await Promise.all([
          readProviderCapabilities({ config, executor, providerId }),
          listProviderModels({ config, executor, providerId, signal: deps.signal }),
        ])
        // Both halves are computed here, whichever Host is selected.
        if (!isCurrent()) return
        dispatch({
          type: "OVERLAY_OPEN",
          overlay: {
            kind: "document",
            title: `Provider · ${providerId}`,
            body: formatInspectDocument({
              providerId,
              answeredBy: capabilities.answeredBy.label,
              capabilities: capabilities.providers[0]!,
              models,
            }),
            format: "markdown",
          },
        })
      } catch (error) {
        failureNotice(deps, `Inspecting ${providerId}`, error)
      }
      return
    }

    case "probe": {
      const model = deps.arg?.trim() || undefined
      dispatch({
        type: "NOTICE",
        message:
          target.kind === "host"
            ? `Probing on ${target.label}… (real requests to the provider)`
            : model
              ? `Probing ${model}… (one real request per provider)`
              : "Probing every configured provider… (one real request each)",
      })
      try {
        let report: ProviderProbeReport
        if (target.kind === "host") {
          const connected = await connectTarget(deps, target)
          if (!connected.ok) {
            if (isCurrent()) cliFailureNotice(deps, connected.failure)
            return
          }
          try {
            const { probeOnHost } = await import("../../provider/host")
            const result = await probeOnHost({
              transport: connected.transport,
              target,
              ...(model ? { model } : {}),
              ...(deps.signal ? { signal: deps.signal } : {}),
            })
            if (!result.ok) {
              if (isCurrent()) cliFailureNotice(deps, result.failure)
              return
            }
            report = result.report
          } finally {
            connected.transport.close?.()
          }
        } else {
          report = await probeLocally({
            config,
            executor,
            ...(model ? { model } : {}),
            ...(deps.signal ? { signal: deps.signal } : {}),
          })
        }
        if (!isCurrent()) return
        dispatch({
          type: "OVERLAY_OPEN",
          overlay: {
            kind: "document",
            title: model ? `Probe · ${model}` : "Provider probe",
            body: formatProbeDocument(report),
            format: "markdown",
          },
        })
      } catch (error) {
        failureNotice(deps, "Probe", error)
      }
      return
    }
  }
}
