/**
 * `cognia-agent provider …` (ADR-0163 §8): the provider operation plane from
 * the terminal.
 *
 * ```
 * provider capabilities [--provider id] [--operation id]
 * provider models       [--provider id] [--refresh]
 * provider balance      [--live] [--provider id]
 * provider limits       --live [--provider id]
 * provider usage        [--provider id] [--days n]
 * provider probe        --live --yes [--provider id] [--model m] [--admin-lease l]
 * ```
 *
 * The verbs follow the Host selection every command uses (`--host`,
 * `--endpoint`, `COGNIA_PROFILE`, `COGNIA_SERVER_URL`, `host use`), and
 * `--local` answers from this machine whatever is selected (`../provider/target.ts`).
 * A selected Host answers `balance` (the balances it last measured) and
 * `probe` (its gateway, or a diagnostics job on the paired-device wire).
 * `capabilities`, `models`, `limits` and `usage` read this machine's
 * configuration, credentials and database whatever is selected, and say so.
 *
 * Every report opens with who answered it. A reading that contacts a provider
 * from this machine (`balance`, `limits`) needs `--live`, and a probe needs
 * `--live --yes` wherever it runs.
 *
 * No management credential ever leaves this process: the Host's transport
 * carries its own token or device key and nothing reaches an agent.
 */

import os from "node:os"

import { PROVIDER_OPERATION_IDS, isProviderOperationId } from "@cognia/provider-types"

import type { ProviderLimits } from "@/types/subscription"

import { connectResolvedHost, type ConnectDeps } from "../api/connect"
import { loadConfig as defaultLoadConfig, resolveHome } from "../config/load"
import type { ResolvedConfig } from "../config/schema"
import { resolveHost } from "../host/resolve"
import { formatCapabilityCell, readProviderCapabilities } from "../provider/capabilities"
import {
  HOST_PROBE_WAIT_MS,
  probeOnHost,
  readHostBalance,
  type HostVerbResult,
} from "../provider/host"
import { readProviderLimits, formatMeterLine, type LimitsVerb } from "../provider/limits"
import {
  createCliProviderExecutor,
  isConfiguredLocally,
  type CliProviderExecutor,
} from "../provider/local"
import { formatModelLine, listProviderModels } from "../provider/models"
import {
  formatGatewayProbeRow,
  formatHostProbeRow,
  formatLocalProbeRow,
  probeLocally,
  probeReportFailed,
  type ProviderProbeReport,
} from "../provider/probe"
import {
  LOCAL_ANSWER,
  localWhileHostSelected,
  selectProviderTarget,
  type ProviderAnswerSource,
} from "../provider/target"
import { formatUsageRow, readProviderUsage, type ReadUsageDeps } from "../provider/usage"
import {
  applyFilters,
  formatSourceDiagnostic,
  parseScope,
  USAGE_CLI_SCOPES,
  type SourceDiagnostic,
} from "../provider/usage-filters"
import { boolFlag, numberFlag, stringFlag, type ParsedArgs } from "./args"
import { EXIT_FAILURE, EXIT_USAGE, emitFailure } from "./errors"
import { realOutput, type OutputSink } from "./output"

export const PROVIDER_VERBS = [
  "capabilities",
  "models",
  "balance",
  "limits",
  "usage",
  "probe",
] as const
export type ProviderVerb = (typeof PROVIDER_VERBS)[number]

export const PROVIDER_HELP = `cognia-agent provider — the provider operation plane from the terminal

  provider capabilities [--provider id] [--operation id]   operation profile per provider
  provider models       [--provider id] [--refresh]        model inventory (catalog + upstream)
  provider balance      [--live] [--provider id]           credit balance meters
  provider limits       --live [--provider id]             usage window meters
  provider usage        [--provider id] [--days n] [--scope s] [--source id] [--model m]
                                                            local spend per provider and model
  provider probe        --live --yes [--provider id] [--model m] [--admin-lease l]
                                                            one minimal request per provider

Where it answers:
  The verbs follow the Host every command uses: --host / --profile, --endpoint,
  COGNIA_PROFILE, COGNIA_ENDPOINT or COGNIA_SERVER_URL, then the active host of
  ./.cognia/hosts.json and ~/.cognia/hosts.json (cognia-agent host use). With
  no Host selected, or with --local, this machine answers.

  A selected Host answers balance and probe:
    balance  the balances the Host last measured; this asks no provider, so
             it needs no --live
    probe    a paired-device Host runs one diagnostics job for --provider and
             needs an approval lease granted on the Host (--admin-lease); a
             headless Host probes --model through its gateway
  capabilities, models, limits and usage always read this machine's
  configuration, credentials and database, and say so when a Host is selected.

Flags:
  --provider <id>       one provider (default: every one the answering side has)
  --operation <id>      capabilities: only this operation's cell
  --refresh             models: bypass the cached inventory and ask upstream
  --days <n>            usage: window length (default 7)
  --scope <s>           usage: cognia (default) | all-tools. all-tools folds in
                        what your other coding agents cost, shown separately
  --source <id>         usage: restrict all-tools to one external agent
  --model <id>          usage: substring match on the model id
                        probe: the model to probe (a headless Host needs it)
  --host <name>         a saved Host (also --profile); --endpoint <url> and
                        --tenant <id> as for every Host command
  --local               answer from this machine, whatever Host is selected
  --admin-lease <l>     probe on a paired-device Host: the approval lease from
                        cognia-agent api call host_admin_lease_issue
                          --operations '["provider_diagnostics_start"]'
  --timeout <ms>        probe: per-provider timeout here; how long to wait for
                        a Host's job there (default ${HOST_PROBE_WAIT_MS})
  --live                required where a reading contacts the provider from
                        this machine (balance, limits) and for every probe
  --yes                 required for probe: it sends real requests
  --json                emit one machine-readable record instead of the summary
`

export interface ProviderCommandDeps {
  out?: OutputSink
  env?: Record<string, string | undefined>
  /** CLI home (`~/.cognia`), where `hosts.json` lives. */
  home?: string
  cwd?: string
  now?: () => number
  loadConfig?: (flags?: Record<string, string | boolean>) => ResolvedConfig
  resolveHost?: typeof resolveHost
  connect?: typeof connectResolvedHost
  connectDeps?: ConnectDeps
  /** Poll sleep for a Host probe job (tests). */
  sleep?: (ms: number) => Promise<void>
  createExecutor?: (config: ResolvedConfig) => CliProviderExecutor
  /** Seams the verb modules expose (tests). */
  loadLimits?: LimitsLoader
  ensureDb?: ReadUsageDeps["ensureDb"]
  fsx?: ReadUsageDeps["fsx"]
  modelCatalog?: ReadUsageDeps["modelCatalog"]
  /**
   * External-agent scan diagnostics for `provider usage`.
   *
   * Injected rather than imported, because the CLI must not drag the whole
   * session-import registry into every invocation just to print a summary the
   * common case does not ask for. Absent means the section is omitted, which
   * is the correct rendering for a host that never scanned anything.
   */
  usageSources?: () => Promise<SourceDiagnostic[]>
}

type LimitsLoader = NonNullable<Parameters<typeof readProviderLimits>[0]["loadLimits"]>

/** The verbs a selected Host answers. Every other verb answers here. */
const HOST_VERBS = new Set<ProviderVerb>(["balance", "probe"])

/** Why a verb answers here even with a Host selected, for the report's note. */
const LOCAL_REASON: Record<Exclude<ProviderVerb, "balance" | "probe">, string> = {
  capabilities: "the operation profile is computed from this machine's configuration",
  models: "the model inventory is read with this machine's credentials",
  limits: "a Host keeps no usage-window meters",
  usage: "spend is read from this machine's ledger and sessions",
}

function isVerb(value: string | undefined): value is ProviderVerb {
  return (PROVIDER_VERBS as readonly string[]).includes(value ?? "")
}

function answeredHeader(answeredBy: ProviderAnswerSource, note?: string): string {
  return note
    ? `Answered by: ${answeredBy.label}\nNote: ${note}`
    : `Answered by: ${answeredBy.label}`
}

function hostVerbFailure<T>(out: OutputSink, result: Extract<HostVerbResult<T>, { ok: false }>) {
  return emitFailure(out, result.failure, result.usage ? EXIT_USAGE : EXIT_FAILURE)
}

export async function providerCommand(
  args: ParsedArgs,
  deps: ProviderCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? realOutput
  const json = boolFlag(args, "json")
  const verb = args.subcommand ?? args.positionals[0]

  if (args.help) {
    out.write(PROVIDER_HELP)
    return 0
  }
  if (!verb) {
    out.error(PROVIDER_HELP)
    return 2
  }
  if (!isVerb(verb)) {
    out.error(`Unknown provider verb: "${verb}"\n\n${PROVIDER_HELP}`)
    return 2
  }

  const operationId = stringFlag(args, "operation")
  if (operationId !== undefined && !isProviderOperationId(operationId)) {
    out.error(
      `Unknown operation "${operationId}". Known operations:\n  ${PROVIDER_OPERATION_IDS.join("\n  ")}\n`
    )
    return 2
  }

  const env = deps.env ?? process.env
  const home = deps.home ?? resolveHome(env, os.homedir())
  const profile = stringFlag(args, "host") ?? stringFlag(args, "profile")
  const selected = selectProviderTarget({
    local: boolFlag(args, "local"),
    ...(stringFlag(args, "endpoint") ? { endpoint: stringFlag(args, "endpoint") } : {}),
    ...(profile ? { profile } : {}),
    ...(stringFlag(args, "tenant") ? { tenantId: stringFlag(args, "tenant") } : {}),
    env,
    home,
    cwd: deps.cwd ?? process.cwd(),
    ...(deps.resolveHost ? { resolve: deps.resolveHost } : {}),
  })
  if (!selected.ok) return emitFailure(out, selected.failure, EXIT_USAGE)
  const target = selected.target
  const onHost = target.kind === "host" && HOST_VERBS.has(verb)

  // Every probe contacts a provider. A balance or limits reading does only
  // when this machine takes it: the Host's balance is what it last measured.
  const needsLive = verb === "probe" || ((verb === "balance" || verb === "limits") && !onHost)
  if (needsLive && !boolFlag(args, "live")) {
    out.error(
      `provider ${verb} contacts the provider${verb === "probe" ? "" : " from this machine"} and may be billed. Re-run with --live to confirm.\n`
    )
    return 2
  }
  if (verb === "probe" && !boolFlag(args, "yes")) {
    out.error(`provider probe sends real requests to the provider. Add --yes to spend them.\n`)
    return 2
  }

  const providerId = stringFlag(args, "provider")
  const now = deps.now ?? Date.now

  if (onHost && target.kind === "host") {
    const connected = await (deps.connect ?? connectResolvedHost)(
      target.host,
      deps.connectDeps ?? {}
    )
    if (!connected.ok) return emitFailure(out, connected.failure)
    const transport = connected.transport
    try {
      if (verb === "balance") {
        const result = await readHostBalance({
          transport,
          target,
          now,
          ...(providerId ? { providerId } : {}),
        })
        if (!result.ok) return hostVerbFailure(out, result)
        return printBalance(out, json, result.report, verb)
      }
      const timeout = numberFlag(args, "timeout")
      const adminLease = stringFlag(args, "admin-lease")
      const model = stringFlag(args, "model")
      const result = await probeOnHost({
        transport,
        target,
        now,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(providerId ? { providerId } : {}),
        ...(model ? { model } : {}),
        ...(adminLease ? { adminLease } : {}),
        ...(timeout ? { waitMs: timeout } : {}),
      })
      if (!result.ok) return hostVerbFailure(out, result)
      return printProbe(out, json, result.report)
    } finally {
      transport.close?.()
    }
  }

  let config: ResolvedConfig
  try {
    config = (deps.loadConfig ?? defaultLoadConfig)()
  } catch (error) {
    out.error(`Config error: ${(error as Error).message}\n`)
    return 2
  }

  // This machine answers from here on, so the id is checked against its
  // configuration.
  if (providerId && verb !== "probe" && !isConfiguredLocally(config, providerId)) {
    out.error(
      `Provider "${providerId}" is not configured on this machine, which answers provider ${verb}. ` +
        `Add it under providers in ~/.cognia/config.json.\n`
    )
    return 2
  }

  const note =
    verb === "balance" || verb === "probe"
      ? undefined
      : localWhileHostSelected(target, LOCAL_REASON[verb])
  const selectedHost = target.kind === "host" ? { selectedHost: target.label } : {}
  const executor = (deps.createExecutor ?? ((c) => createCliProviderExecutor(c)))(config)

  switch (verb) {
    case "capabilities": {
      const report = await readProviderCapabilities({
        config,
        executor,
        ...(providerId ? { providerId } : {}),
        ...(operationId ? { operationId } : {}),
      })
      if (json) {
        out.json({ verb, ...selectedHost, ...report })
        return report.providers.some((p) => p.failure) ? 1 : 0
      }
      out.write(`${answeredHeader(report.answeredBy, note)}\n`)
      out.write(`Contract v${report.schemaVersion}: ${report.operationCount} operations\n`)
      let failed = false
      for (const entry of report.providers) {
        out.write(`\n${entry.providerId}\n`)
        if (entry.failure) {
          failed = true
          out.write(`  ${entry.failure.availability}: ${entry.failure.failure.message}\n`)
          continue
        }
        for (const cell of entry.profile!.cells) out.write(`  ${formatCapabilityCell(cell)}\n`)
        if (entry.profile!.cells.length === 0) out.write(`  (no matching operation)\n`)
      }
      return failed ? 1 : 0
    }

    case "models": {
      const report = await listProviderModels({
        config,
        executor,
        ...(providerId ? { providerId } : {}),
        refresh: boolFlag(args, "refresh"),
      })
      if (json) {
        out.json({ verb, answeredBy: LOCAL_ANSWER, ...selectedHost, ...report })
        return report.failure ? 1 : 0
      }
      out.write(`${answeredHeader(LOCAL_ANSWER, note)}\n`)
      if (report.failure) {
        out.error(
          `${report.providerId}: ${report.failure.availability}: ${report.failure.failure.message}\n`
        )
        return 1
      }
      const listing = report.listing!
      out.write(
        `${report.providerId}: ${listing.models.length} models (${listing.source}, ${listing.freshness}, fetched ${new Date(listing.fetchedAt).toISOString()})\n`
      )
      for (const model of listing.models) out.write(`  ${formatModelLine(model)}\n`)
      return 0
    }

    case "balance":
    case "limits": {
      const report = await readProviderLimits({
        config,
        verb: verb as LimitsVerb,
        ...(providerId ? { providerId } : {}),
        now,
        ...(deps.loadLimits ? { loadLimits: deps.loadLimits } : {}),
      })
      return printBalance(
        out,
        json,
        { ...report, answeredBy: LOCAL_ANSWER, ...selectedHost },
        verb,
        note
      )
    }

    case "usage": {
      const days = numberFlag(args, "days") ?? 7
      if (!Number.isFinite(days) || days <= 0) {
        out.error(`--days must be a positive number\n`)
        return 2
      }
      const scope = parseScope(stringFlag(args, "scope"))
      if (!scope) {
        out.error(`--scope must be one of: ${USAGE_CLI_SCOPES.join(", ")}\n`)
        return 2
      }
      const sourceFilter = stringFlag(args, "source")
      if (sourceFilter && scope !== "all-tools") {
        // Naming a source while scoped to this app would silently return
        // nothing, which reads as "that agent has no spend" rather than
        // "you asked the wrong scope".
        out.error(`--source requires --scope all-tools\n`)
        return 2
      }
      const filters = {
        scope,
        ...(sourceFilter ? { sourceId: sourceFilter } : {}),
        ...(stringFlag(args, "model") ? { model: stringFlag(args, "model") as string } : {}),
      }
      const to = now()
      const report = await readProviderUsage({
        config,
        executor,
        home,
        ...(providerId ? { providerId } : {}),
        from: to - days * 24 * 60 * 60 * 1000,
        to,
        now,
        ...(deps.ensureDb ? { ensureDb: deps.ensureDb } : {}),
        ...(deps.fsx ? { fsx: deps.fsx } : {}),
        ...(deps.modelCatalog ? { modelCatalog: deps.modelCatalog } : {}),
      })
      // Filters are applied to the REPORT, not inside the reader, so the
      // `--json` payload and the printed table are the same rows and cannot
      // disagree about what a filter meant.
      const filtered = {
        ...report,
        ledger: { ...report.ledger, rows: applyFilters(report.ledger.rows, filters) },
        sessions: { ...report.sessions, rows: applyFilters(report.sessions.rows, filters) },
      }
      const sources: SourceDiagnostic[] = deps.usageSources ? await deps.usageSources() : []

      if (json) {
        out.json({ verb, answeredBy: LOCAL_ANSWER, ...selectedHost, scope, ...filtered, sources })
        return 0
      }
      const report2 = filtered
      out.write(`${answeredHeader(LOCAL_ANSWER, note)}\n`)
      out.write(
        `Usage ${new Date(report2.from).toISOString().slice(0, 10)} to ${new Date(report2.to).toISOString().slice(0, 10)} (${scope})\n`
      )
      out.write(`\nRecorded ledger (exact attribution)\n`)
      if (report2.ledger.unavailable) {
        out.write(`  local database unavailable: ${report2.ledger.unavailable}\n`)
      } else if (report2.ledger.rows.length === 0) {
        out.write(`  (no rows)\n`)
      }
      for (const row of report2.ledger.rows) out.write(`  ${formatUsageRow(row)}\n`)
      for (const failure of report2.ledger.failures) {
        out.write(`  ${failure.providerId}: ${failure.failure.failure.message}\n`)
      }
      out.write(
        `\nCLI sessions (${report2.sessions.scanned} in window, ${report2.sessions.withoutUsage} without usage)\n`
      )
      if (report2.sessions.rows.length === 0) out.write(`  (no rows)\n`)
      for (const row of report2.sessions.rows) out.write(`  ${formatUsageRow(row)}\n`)
      if (sources.length > 0) {
        out.write(`\nExternal agents\n`)
        for (const source of sources) out.write(`${formatSourceDiagnostic(source)}\n`)
      }
      if (report2.sessions.catalogAttributed + report2.sessions.approximate > 0) {
        out.write(
          `\n  c = provider attributed from the model catalog, ~ = approximate (alias shared by several providers, or unknown)\n`
        )
      }
      return 0
    }

    case "probe": {
      const report = await probeLocally({
        config,
        executor,
        ...(providerId ? { providerId } : {}),
        ...(stringFlag(args, "model") ? { model: stringFlag(args, "model") } : {}),
        ...(numberFlag(args, "timeout") ? { timeoutMs: numberFlag(args, "timeout") } : {}),
      })
      if (report.via === "local" && report.notConfigured) {
        out.error(
          `Provider "${report.notConfigured}" is not configured on this machine, which answered the probe. ` +
            `Add it under providers in ~/.cognia/config.json.\n`
        )
        return 2
      }
      return printProbe(out, json, report)
    }
  }
}

interface BalanceOutput {
  verb: LimitsVerb
  answeredBy: ProviderAnswerSource
  selectedHost?: string
  fetchedAt: number
  snapshots: ProviderLimits[]
  silent: string[]
}

function printBalance(
  out: OutputSink,
  json: boolean,
  report: BalanceOutput,
  verb: LimitsVerb,
  note?: string
): number {
  const failed = report.snapshots.some((snapshot) => snapshot.error)
  if (json) {
    out.json(report)
    return failed ? 1 : 0
  }
  out.write(`${answeredHeader(report.answeredBy, note)}\n`)
  for (const snapshot of report.snapshots) {
    out.write(`\n${snapshot.accountLabel ?? snapshot.accountId ?? snapshot.provider}\n`)
    if (snapshot.notice) out.write(`  ${snapshot.notice}\n`)
    if (snapshot.error) out.write(`  error: ${snapshot.error}\n`)
    for (const meter of snapshot.meters) {
      out.write(`  ${formatMeterLine(meter, report.fetchedAt)}\n`)
    }
  }
  if (report.silent.length > 0) {
    out.write(
      `\nNo ${verb === "balance" ? "balance" : "window"} meters: ${report.silent.join(", ")}\n`
    )
  }
  if (report.snapshots.length === 0 && report.silent.length === 0) {
    out.write(
      report.answeredBy.plane === "host"
        ? `The Host has measured no balance yet.\n`
        : `No configured provider exposes ${verb} meters.\n`
    )
  }
  return failed ? 1 : 0
}

function printProbe(out: OutputSink, json: boolean, report: ProviderProbeReport): number {
  const failed = probeReportFailed(report)
  if (json) {
    out.json({ verb: "probe", ...report })
    return failed ? 1 : 0
  }
  out.write(`${answeredHeader(report.answeredBy)}\n`)
  switch (report.via) {
    case "gateway":
      out.write(`Gateway probe for ${report.model} (${report.rows.length} candidates)\n`)
      for (const row of report.rows) out.write(`  ${formatGatewayProbeRow(row)}\n`)
      if (report.rows.length === 0)
        out.write(
          report.providerFilter
            ? `  (no candidate: the gateway has no route for this model through ${report.providerFilter})\n`
            : `  (no candidate: the gateway has no route for this model)\n`
        )
      break
    case "host-job":
      out.write(`Diagnostics job ${report.jobId} for ${report.providerId}: ${report.status}\n`)
      for (const row of report.rows) out.write(`  ${formatHostProbeRow(row)}\n`)
      if (!report.settled) {
        out.write(
          `  The Host is still running it. Read it later with:\n` +
            `  cognia-agent api call provider_diagnostics_history --provider-id ${report.providerId}\n`
        )
      } else if (report.rows.length === 0) {
        out.write(`  (the Host recorded no sample for this job)\n`)
      }
      break
    case "local":
      for (const row of report.rows) out.write(`  ${formatLocalProbeRow(row)}\n`)
      if (report.rows.length === 0) out.write(`  (no configured provider to probe)\n`)
      break
  }
  return failed ? 1 : 0
}
