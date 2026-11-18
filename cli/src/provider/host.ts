/**
 * The provider verbs a selected Host answers (ADR-0163 §8): `balance` and
 * `probe`.
 *
 * `balance` reads the balances the Host last measured
 * (`provider_diagnostics_status`). That asks no provider and bills nothing,
 * and the snapshots are projected onto the same `ProviderLimits` meters a
 * reading on this machine produces, so the report, its JSON and the TUI panel
 * render one shape.
 *
 * `probe` depends on the wire the Host is reached on:
 *   - paired device (`http`): one `provider_diagnostics_start` job for one
 *     provider. The command is interactive, so it carries an approval lease a
 *     person granted on the Host (`--admin-lease`), and the request limit it
 *     confirms is the job's exact size: one probe target, one request.
 *   - service token (`internal`): the Host's gateway probe
 *     (`gateway_probe_upstream`), which walks the candidates a chat request
 *     for that model would walk.
 *
 * The diagnostics commands answer only a paired device the Host lets control
 * it remotely. A refusal is reported as the Host's, never answered from this
 * machine in its place.
 */

import type {
  ProviderBalanceAmount,
  ProviderDiagnosticFailure,
  ProviderDiagnosticStatus,
  ProviderProbeResult,
} from "@cognia/provider-types"

import { balanceMeter } from "@/lib/subscription/limits/meters"
import type { LimitsMeter, ProviderLimits } from "@/types/subscription"

import { findCommand } from "../api/catalog"
import { WAIT_POLL_INTERVAL_MS, invokeCommand, preflight } from "../api/invoke"
import type { CommandFailure, HostTransport } from "../api/transport"
import { commandForWire } from "../api/types"
import type { CliFailure } from "../cli/errors"
import type { ProviderLimitsReport } from "./limits"
import type { GatewayProbeRow, HostProbeRow, ProviderProbeReport } from "./probe"
import { hostAnswer, type ProviderAnswerSource, type ProviderTarget } from "./target"

export const HOST_STATUS_COMMAND = "provider_diagnostics_status"
export const HOST_HISTORY_COMMAND = "provider_diagnostics_history"
export const HOST_START_COMMAND = "provider_diagnostics_start"
export const GATEWAY_PROBE_COMMAND = "gateway_probe_upstream"

/** How long `probe` waits for a Host job by default. */
export const HOST_PROBE_WAIT_MS = 60_000
/** Per-request budget for one Host call. */
export const HOST_REQUEST_TIMEOUT_MS = 30_000

const SETTLED: ReadonlySet<ProviderDiagnosticStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "unverified",
])
const STATUSES: ReadonlySet<string> = new Set([...SETTLED, "queued", "running"])

type HostTarget = Extract<ProviderTarget, { kind: "host" }>

export interface HostCallOptions {
  transport: HostTransport
  timeoutMs?: number
  signal?: AbortSignal
  now?: () => number
  newId?: () => string
}

export type HostCallResult = { ok: true; result: unknown } | { ok: false; failure: CliFailure }

export type HostVerbResult<T> =
  | { ok: true; report: T }
  /** `usage` marks a call the CLI refused before sending, for exit code 2. */
  | { ok: false; failure: CliFailure; usage?: boolean }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(record).filter((entry): entry is Record<string, unknown> => !!entry)
    : []
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function failureFix(name: string, outcome: CommandFailure): string[] {
  if (outcome.code === "unknown_command") {
    return [`this Host predates ${name}; update the Host`, "or pass --local"]
  }
  if (outcome.code === "interactive_approval_required") {
    return [
      `cognia-agent api call host_admin_lease_issue --operations '["${name}"]'`,
      "then pass --admin-lease <lease>",
    ]
  }
  if (/not permitted to run provider diagnostics/.test(outcome.message)) {
    return [
      "on the Host, allow remote control for this paired device",
      "or pass --local to answer from this machine",
    ]
  }
  return ["cognia-agent host show", "or pass --local to answer from this machine"]
}

/**
 * One command through the same path `api call` takes: the wire's own request
 * shape, the approval preflight, a minted idempotency key, and the relay
 * fallback the transport carries.
 */
export async function callHost(
  name: string,
  body: Record<string, unknown>,
  options: HostCallOptions
): Promise<HostCallResult> {
  const catalogEntry = findCommand(name)
  if (!catalogEntry) {
    return {
      ok: false,
      failure: {
        error: `${name} is not in this CLI's command contract`,
        cause: "unknown-command",
        fix: ["upgrade cognia-agent"],
      },
    }
  }
  const entry = commandForWire(catalogEntry, options.transport.wire)
  const refused = preflight({ entry, transport: options.transport, body })
  if (refused) return { ok: false, failure: refused }
  const { outcome } = await invokeCommand({
    entry,
    body,
    transport: options.transport,
    timeoutMs: options.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.newId ? { newId: options.newId } : {}),
  })
  if (outcome.ok) return { ok: true, result: outcome.result }
  return {
    ok: false,
    failure: {
      error: `${name} on ${options.transport.label}: ${outcome.message}`,
      ...(outcome.details ? { details: outcome.details } : {}),
      cause: outcome.cause,
      fix: failureFix(name, outcome),
      inspect: [`cognia-agent api describe ${name}`],
      ...(outcome.problem ? { problem: outcome.problem } : {}),
    },
  }
}

// ── balance ─────────────────────────────────────────────────────────────────

const CURRENCY = /^[A-Z]{3}$/

function amountsOf(value: unknown): ProviderBalanceAmount[] {
  return list(value).flatMap((amount) => {
    const unit = text(amount.unit)
    if (!unit) return []
    const remaining = finite(amount.remaining)
    const total = finite(amount.total)
    const used = finite(amount.used)
    return [
      {
        unit,
        ...(remaining !== undefined ? { remaining } : {}),
        ...(total !== undefined ? { total } : {}),
        ...(used !== undefined ? { used } : {}),
      },
    ]
  })
}

function failureOf(value: unknown): ProviderDiagnosticFailure | undefined {
  const failure = record(value)
  const message = text(failure?.message)
  const code = text(failure?.code)
  if (!failure || !message || !code) return undefined
  return {
    code: code as ProviderDiagnosticFailure["code"],
    retryable: failure.retryable === true,
    message,
    ...(finite(failure.httpStatus) !== undefined ? { httpStatus: finite(failure.httpStatus) } : {}),
  }
}

function sourceKey(providerId: string, sourceId: string, accountId: string | undefined): string {
  return `${providerId}\u0000${sourceId}\u0000${accountId ?? ""}`
}

function meterFor(
  sourceId: string,
  label: string,
  amount: ProviderBalanceAmount,
  several: boolean,
  fetchedAt: number,
  providerId: string
): LimitsMeter {
  const currency = CURRENCY.test(amount.unit) ? amount.unit : undefined
  const { labelKey: _labelKey, ...meter } = balanceMeter(
    {
      fetchedAt,
      providerKey: providerId,
      accountId: providerId,
      kind: "credit",
      unit: amount.unit,
      ...(currency ? { currency } : {}),
      ...(amount.total !== undefined ? { total: amount.total } : {}),
      ...(amount.remaining !== undefined ? { remaining: amount.remaining } : {}),
      ...(amount.used !== undefined ? { used: amount.used } : {}),
      raw: {},
    },
    { id: `${sourceId}:${amount.unit}` }
  )
  return { ...meter, label: several || !currency ? `${label} (${amount.unit})` : label }
}

/**
 * The Host's latest balance per source and account, as `ProviderLimits`.
 * Each snapshot says when the Host measured it and whether it has gone stale.
 */
export function hostBalanceLimits(
  status: unknown,
  now: number
): Pick<ProviderLimitsReport, "snapshots" | "silent"> {
  const body = record(status) ?? {}
  const sources = new Map<string, { label: string; primary: boolean }>()
  for (const source of list(body.balanceSources)) {
    const id = text(source.id)
    const providerId = text(source.providerId)
    if (!id || !providerId) continue
    sources.set(sourceKey(providerId, id, text(source.accountId)), {
      label: text(source.label) ?? id,
      primary: source.primary === true,
    })
  }
  const rows: Array<{ providerId: string; primary: boolean; limits: ProviderLimits }> = []
  const silent: string[] = []
  for (const snapshot of list(body.balanceSnapshots)) {
    const providerId = text(snapshot.providerId)
    const sourceId = text(snapshot.sourceId)
    const fetchedAt = finite(snapshot.fetchedAt)
    if (!providerId || !sourceId || fetchedAt === undefined) continue
    const accountId = text(snapshot.accountId)
    const source = sources.get(sourceKey(providerId, sourceId, accountId))
    const label = source?.label ?? sourceId
    const amounts = amountsOf(snapshot.amounts)
    const failure = failureOf(snapshot.failure)
    if (amounts.length === 0 && !failure) {
      silent.push(providerId)
      continue
    }
    const staleAt = finite(snapshot.staleAt)
    const measured = `measured by the Host ${new Date(fetchedAt).toISOString()}`
    const notice =
      staleAt !== undefined && staleAt <= now
        ? `${measured}, stale since ${new Date(staleAt).toISOString()}`
        : measured
    rows.push({
      providerId,
      primary: source?.primary === true,
      limits: {
        provider: providerId,
        sourceId,
        ...(accountId ? { accountId } : {}),
        accountLabel:
          `${providerId} · ${label}` +
          (source?.primary ? " (primary)" : "") +
          (accountId ? ` · account ${accountId}` : ""),
        fetchedAt,
        meters: amounts.map((amount) =>
          meterFor(sourceId, label, amount, amounts.length > 1, fetchedAt, providerId)
        ),
        ...(failure ? { error: `${failure.code}: ${failure.message}` } : {}),
        notice,
      },
    })
  }
  rows.sort(
    (left, right) =>
      left.providerId.localeCompare(right.providerId) ||
      Number(right.primary) - Number(left.primary) ||
      (left.limits.accountLabel ?? "").localeCompare(right.limits.accountLabel ?? "")
  )
  return {
    snapshots: rows.map((row) => row.limits),
    silent: [...new Set(silent)].filter(
      (providerId) => !rows.some((row) => row.providerId === providerId)
    ),
  }
}

export interface HostBalanceReport extends ProviderLimitsReport {
  answeredBy: ProviderAnswerSource
}

export interface HostBalanceDeps extends HostCallOptions {
  target: HostTarget
  providerId?: string
}

export async function readHostBalance(
  deps: HostBalanceDeps
): Promise<HostVerbResult<HostBalanceReport>> {
  const answer = await callHost(
    HOST_STATUS_COMMAND,
    deps.providerId ? { providerId: deps.providerId } : {},
    deps
  )
  if (!answer.ok) return answer
  const now = (deps.now ?? Date.now)()
  const capturedAt = finite(record(answer.result)?.capturedAt) ?? now
  return {
    ok: true,
    report: {
      verb: "balance",
      answeredBy: hostAnswer(deps.target),
      fetchedAt: capturedAt,
      ...hostBalanceLimits(answer.result, now),
    },
  }
}

// ── probe ───────────────────────────────────────────────────────────────────

export interface HostProbeDeps extends HostCallOptions {
  target: HostTarget
  providerId?: string
  model?: string
  /** `--admin-lease`, required on the paired-device wire. */
  adminLease?: string
  /** How long to wait for a Host job to settle. */
  waitMs?: number
  sleep?: (ms: number) => Promise<void>
}

function toGatewayRow(value: unknown): GatewayProbeRow | null {
  const row = record(value)
  if (!row || typeof row.providerId !== "string" || typeof row.modelId !== "string") return null
  return {
    providerId: row.providerId,
    modelId: row.modelId,
    ok: row.ok === true,
    ...(typeof row.status === "number" ? { status: row.status } : {}),
    latencyMs: typeof row.latencyMs === "number" ? row.latencyMs : 0,
    ...(typeof row.error === "string" ? { error: row.error } : {}),
  }
}

function probeResultOf(value: unknown): ProviderProbeResult | undefined {
  const probe = record(value)
  if (!probe || typeof probe.reachable !== "boolean") return undefined
  const failure = failureOf(probe.failure)
  return {
    reachable: probe.reachable,
    ...(typeof probe.authenticated === "boolean" ? { authenticated: probe.authenticated } : {}),
    capabilityVerified: probe.capabilityVerified === true,
    durationMs: finite(probe.durationMs) ?? 0,
    ...(finite(probe.httpStatus) !== undefined ? { httpStatus: finite(probe.httpStatus) } : {}),
    ...(failure ? { failure } : {}),
  }
}

function statusOf(value: unknown): ProviderDiagnosticStatus | undefined {
  return typeof value === "string" && STATUSES.has(value)
    ? (value as ProviderDiagnosticStatus)
    : undefined
}

function jobSamples(history: unknown, jobId: string): HostProbeRow[] {
  return list(record(history)?.samples)
    .filter((sample) => sample.jobId === jobId)
    .flatMap((sample) => {
      const providerId = text(sample.providerId)
      const status = statusOf(sample.status)
      if (!providerId || !status) return []
      const probe = probeResultOf(sample.probe)
      const failure = failureOf(sample.failure)
      const modelId = text(sample.modelId)
      return [
        {
          providerId,
          ...(modelId ? { modelId } : {}),
          status,
          ...(probe ? { probe } : {}),
          ...(failure ? { failure } : {}),
        },
      ]
    })
}

async function probeThroughGateway(
  deps: HostProbeDeps
): Promise<HostVerbResult<ProviderProbeReport>> {
  if (!deps.model) {
    return {
      ok: false,
      usage: true,
      failure: {
        error: `${deps.target.label} probes through its gateway, which routes by model`,
        cause: "invalid-request",
        fix: ["pass --model <id>", "or pass --local to probe each provider from this machine"],
      },
    }
  }
  const answer = await callHost(GATEWAY_PROBE_COMMAND, { model: deps.model }, deps)
  if (!answer.ok) return answer
  const rows = (Array.isArray(answer.result) ? answer.result : [])
    .map(toGatewayRow)
    .filter((row): row is GatewayProbeRow => row !== null)
    .filter((row) => !deps.providerId || row.providerId === deps.providerId)
  return {
    ok: true,
    report: {
      via: "gateway",
      answeredBy: hostAnswer(deps.target),
      model: deps.model,
      ...(deps.providerId ? { providerFilter: deps.providerId } : {}),
      rows,
    },
  }
}

async function probeThroughDiagnostics(
  deps: HostProbeDeps
): Promise<HostVerbResult<ProviderProbeReport>> {
  const providerId = deps.providerId
  if (!providerId) {
    return {
      ok: false,
      usage: true,
      failure: {
        error: `${deps.target.label} runs a probe as a diagnostics job for one provider`,
        cause: "invalid-request",
        fix: ["pass --provider <id>, a provider configured on the Host"],
      },
    }
  }
  if (!deps.adminLease) {
    return {
      ok: false,
      usage: true,
      failure: {
        error: `${HOST_START_COMMAND} needs an approval lease a person granted on the Host`,
        cause: "refused",
        fix: [
          `cognia-agent api call host_admin_lease_issue --operations '["${HOST_START_COMMAND}"]'` +
            (deps.target.host.name ? ` --host ${deps.target.host.name}` : ""),
          "then pass --admin-lease <lease>",
        ],
        inspect: [`cognia-agent api describe ${HOST_START_COMMAND}`],
      },
    }
  }
  const started = await callHost(
    HOST_START_COMMAND,
    {
      targets: [
        { providerId, ...(deps.model ? { modelId: deps.model } : {}), capability: "probe" },
      ],
      mode: "quick",
      // One target, one measured request: the job's exact size. A probe is
      // not a paid diagnostic, so it confirms no spend.
      confirmedRequestLimit: 1,
      confirmedMaxEstimatedCostUsd: 0,
      adminLease: deps.adminLease,
    },
    deps
  )
  if (!started.ok) return started
  const jobId = text(record(started.result)?.jobId)
  if (!jobId) {
    return {
      ok: false,
      failure: {
        error: `${HOST_START_COMMAND} on ${deps.transport.label} answered without a job id`,
        cause: "failed",
      },
    }
  }

  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + (deps.waitMs ?? HOST_PROBE_WAIT_MS)
  const remaining = () => Math.max(1, deadline - now())
  let status: ProviderDiagnosticStatus = "queued"
  let settled = false
  let rows: HostProbeRow[] = []
  for (;;) {
    const answer = await callHost(
      HOST_STATUS_COMMAND,
      { providerId },
      {
        ...deps,
        timeoutMs: Math.min(deps.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS, remaining()),
      }
    )
    if (!answer.ok) return answer
    const job = list(record(answer.result)?.jobs).find((entry) => entry.id === jobId)
    const jobStatus = statusOf(job?.status)
    if (jobStatus) status = jobStatus
    // The status lists each provider's latest job, so a newer job for the
    // same provider hides this one; its samples still say how it ended.
    if ((jobStatus && SETTLED.has(jobStatus)) || !job) {
      const history = await callHost(
        HOST_HISTORY_COMMAND,
        { providerId, limit: 50 },
        {
          ...deps,
          timeoutMs: Math.min(deps.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS, remaining()),
        }
      )
      if (!history.ok) return history
      rows = jobSamples(history.result, jobId)
      const sampled = rows.find((row) => SETTLED.has(row.status))
      if (jobStatus && SETTLED.has(jobStatus)) {
        settled = true
        break
      }
      if (!job && sampled) {
        status = rows.every((row) => row.status === "completed") ? "completed" : sampled.status
        settled = true
        break
      }
    }
    if (now() >= deadline) break
    await sleep(Math.min(WAIT_POLL_INTERVAL_MS, remaining()))
  }
  return {
    ok: true,
    report: {
      via: "host-job",
      answeredBy: hostAnswer(deps.target),
      providerId,
      ...(deps.model ? { model: deps.model } : {}),
      jobId,
      status,
      settled,
      rows,
    },
  }
}

/** Probe on the selected Host, through whichever path its wire carries. */
export function probeOnHost(deps: HostProbeDeps): Promise<HostVerbResult<ProviderProbeReport>> {
  return deps.transport.wire === "internal"
    ? probeThroughGateway(deps)
    : probeThroughDiagnostics(deps)
}
