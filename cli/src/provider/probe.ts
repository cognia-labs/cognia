/**
 * `provider probe` on this machine, and the row shapes every probe report
 * shares.
 *
 * Here every configured provider is probed through the shared `health.probe`
 * operation, with this machine's credentials. A selected Host probes inside
 * its own gateway or diagnostics job instead (`./host.ts`). Either way a probe
 * contacts the provider, so the command requires `--live --yes`.
 */

import type {
  ProviderDiagnosticFailure,
  ProviderDiagnosticStatus,
  ProviderOperationFailure,
  ProviderProbeResult,
} from "@cognia/provider-types"

import type { ResolvedConfig } from "../config/schema"
import { configuredProviderIds, isConfiguredLocally, type CliProviderExecutor } from "./local"
import { LOCAL_ANSWER, type ProviderAnswerSource } from "./target"

/** One gateway candidate's answer (`cognia_gateway::server::UpstreamProbeResult`). */
export interface GatewayProbeRow {
  providerId: string
  modelId: string
  ok: boolean
  status?: number
  latencyMs: number
  error?: string
}

export interface LocalProbeRow {
  providerId: string
  model?: string
  result?: ProviderProbeResult
  failure?: ProviderOperationFailure
}

/** One sample of a Host diagnostics job (`ProviderDiagnosticSample`, endpoint withheld). */
export interface HostProbeRow {
  providerId: string
  modelId?: string
  status: ProviderDiagnosticStatus
  probe?: ProviderProbeResult
  failure?: ProviderDiagnosticFailure
}

export type ProviderProbeReport =
  | {
      /** The Host's gateway walked its candidates for one model. */
      via: "gateway"
      answeredBy: ProviderAnswerSource
      model: string
      /** `--provider`, which narrowed the gateway's candidates. */
      providerFilter?: string
      rows: GatewayProbeRow[]
    }
  | {
      /** A Host diagnostics job probed one provider. */
      via: "host-job"
      answeredBy: ProviderAnswerSource
      providerId: string
      model?: string
      jobId: string
      status: ProviderDiagnosticStatus
      /** False when the wait ran out before the Host finished the job. */
      settled: boolean
      rows: HostProbeRow[]
    }
  | {
      via: "local"
      answeredBy: ProviderAnswerSource
      /** `--provider` named a provider this machine has not configured. */
      notConfigured?: string
      rows: LocalProbeRow[]
    }

export interface ProbeDeps {
  config: ResolvedConfig
  executor: CliProviderExecutor
  providerId?: string
  model?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/** Probe every configured provider (or `--provider`) from this machine. */
export async function probeLocally(deps: ProbeDeps): Promise<ProviderProbeReport> {
  if (deps.providerId && !isConfiguredLocally(deps.config, deps.providerId)) {
    return { via: "local", answeredBy: LOCAL_ANSWER, notConfigured: deps.providerId, rows: [] }
  }
  const ids = deps.providerId ? [deps.providerId] : configuredProviderIds(deps.config)
  const rows: LocalProbeRow[] = []
  for (const providerId of ids) {
    const input = {
      ...(deps.model ? { model: deps.model } : {}),
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    }
    const result = await deps.executor.execute<ProviderProbeResult>(
      "health.probe",
      providerId,
      input,
      deps.signal ? { signal: deps.signal } : {}
    )
    rows.push(
      result.ok
        ? { providerId, ...(deps.model ? { model: deps.model } : {}), result: result.output }
        : { providerId, ...(deps.model ? { model: deps.model } : {}), failure: result }
    )
  }
  return { via: "local", answeredBy: LOCAL_ANSWER, rows }
}

/** A probe passed: the provider answered, accepted the credential and reported no failure. */
export function probePassed(result: ProviderProbeResult): boolean {
  return result.reachable && result.authenticated !== false && !result.failure
}

/** Whether a report carries any failure, for the exit code. */
export function probeReportFailed(report: ProviderProbeReport): boolean {
  switch (report.via) {
    case "gateway":
      return report.rows.some((row) => !row.ok)
    case "host-job":
      return (
        !report.settled ||
        report.status !== "completed" ||
        report.rows.length === 0 ||
        report.rows.some((row) => row.failure || !row.probe || !probePassed(row.probe))
      )
    case "local":
      return report.rows.some((row) => row.failure || !row.result || !probePassed(row.result))
  }
}

export function formatGatewayProbeRow(row: GatewayProbeRow): string {
  const mark = row.ok ? "ok  " : "FAIL"
  const status = row.status !== undefined ? ` HTTP ${row.status}` : ""
  const error = row.error ? `  ${row.error}` : ""
  return `${mark} ${row.providerId.padEnd(16)} ${row.modelId.padEnd(28)} ${row.latencyMs}ms${status}${error}`
}

function formatProbeResult(name: string, result: ProviderProbeResult): string {
  const mark = probePassed(result) ? "ok  " : "FAIL"
  const auth = result.authenticated === undefined ? "" : result.authenticated ? " auth" : " no-auth"
  const status = result.httpStatus !== undefined ? ` HTTP ${result.httpStatus}` : ""
  const failure = result.failure ? `  ${result.failure.message}` : ""
  return `${mark} ${name} ${result.durationMs}ms${auth}${status}${failure}`
}

export function formatLocalProbeRow(row: LocalProbeRow): string {
  const name = row.providerId.padEnd(16)
  if (row.failure) {
    return `FAIL ${name} ${row.failure.availability}: ${row.failure.failure.message}`
  }
  return formatProbeResult(name, row.result!)
}

export function formatHostProbeRow(row: HostProbeRow): string {
  const name = `${row.providerId.padEnd(16)}${row.modelId ? ` ${row.modelId.padEnd(28)}` : ""}`
  if (row.probe) return formatProbeResult(name, row.probe)
  const failure = row.failure ? `  ${row.failure.code}: ${row.failure.message}` : ""
  return `FAIL ${name} ${row.status}${failure}`
}
