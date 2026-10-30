import { API_CONTRACT_VERSION } from "../api/generated/command-index"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
/**
 * `cognia-agent api ...`, the complete surface over a Cognia Host's command
 * plane.
 *
 * Everything the host exposes is reachable here without the CLI having to
 * grow a hand-written command per RPC, because the generated index already
 * describes every command's fields, risk, approval and wire. `api call` is
 * the floor. `api list` / `describe` / `schema` exist so the floor is
 * discoverable rather than something you need the OpenAPI spec open to use.
 */

import os from "node:os"

import { parseArgv, stringFlag, type ParsedArgs } from "./args"
import { EXIT_OK, EXIT_USAGE, emitFailure, usageFailure, type CliFailure } from "./errors"
import { emitResult, parseDuration, resolveOutputOptions, type OutputOptions } from "./format"
import { realOutput, type OutputSink } from "./output"
import { connectHost, type ConnectDeps } from "../api/connect"
import {
  commandGroups,
  filterCommands,
  remoteCommandEntry,
  findCommand,
  listCommands,
  suggestCommands,
  type ApiCommandEntry,
} from "../api/catalog"
import { invokeCommand, preflight } from "../api/invoke"
import { buildRequestBody, parseDataFlag, requestTemplate, validateContract } from "../api/validate"
import { commandForWire } from "../api/types"
import type { HostTransport } from "../api/transport"
import { resolveHost, type HostResolution } from "../host/resolve"
import { resolveHome } from "../config/load"

export const API_HELP = `cognia-agent api - call any command a Cognia Host exposes

Usage:
  cognia-agent api call <command> [--data JSON|@file|-] [--<field> value ...] [--wait]
  cognia-agent api list [--group g] [--wire internal|http] [--capability c]
                        [--risk low|high|critical] [--approval none|interactive|signed-policy]
                        [--search text]
  cognia-agent api groups [--wire internal|http]
  cognia-agent api describe <command>
  cognia-agent api schema <command> [--template]
  cognia-agent api request <METHOD> <path> [--data JSON|@file|-]
                         [--body-file path | --multipart JSON]
                         [--header JSON] [--content-type type]
                         [--response json|text|bytes|stream] [--save path]
  cognia-agent api events --channels <channel,...> [--since seq]
                         [--cursor-file path] [--max-events n] [--reconnects n]

Host selection:
  --host <name> / --profile <name>  a saved host (or COGNIA_PROFILE)
  --endpoint <url>                  an explicit base URL (or COGNIA_ENDPOINT)
  --tenant <id>                     tenant for the device wire (or COGNIA_TENANT_ID)

Output:
  --format raw|json|pretty  compact JSON | indented JSON | rendered (default pretty)
  -o, --output <dir>        write the result into <dir> instead of stdout (implies raw)
  --timeout <30s|1m|500ms>  per-request budget (default 30s)
  --total-timeout <duration> total budget including auth, discovery and all reads
  --all / --paginate        aggregate page-token results (bounded by --max-pages)
  --max-pages <n>            pagination bound, 1..10000 (default 1000)
  --strict-output           validate the selected wire's domain response
  --live                    discover admitted commands and schemas from the Host
  --wire internal|http       select an offline schema/discovery projection
  --output-schema           export the domain response schema
  --body-idempotency-key k   business intent key, separate from --idempotency-key UUID
  --max-bytes <n>            bound byte/stream responses (default 64 MiB)
  --debug                   log command and request field names only
  --json                    alias for --format raw

Wires:
  internal  POST /internal/_rpc/{name}, loopback service token, every command
  http      POST /api/_rpc/{name}, DPoP device session, execution and host-admin
            commands only, with capability grants and approvals enforced
`

export interface ApiCommandDeps {
  out?: OutputSink
  /** The process argv slice, so a command's own boolean fields can be parsed. */
  argv?: string[]
  env?: Record<string, string | undefined>
  cwd?: string
  home?: string
  connect?: typeof connectHost
  resolve?: typeof resolveHost
  connectDeps?: ConnectDeps
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

function projectRow(entry: ApiCommandEntry): Record<string, unknown> {
  return {
    command: entry.name,
    group: entry.group,
    action: entry.action,
    wires: entry.wires.join("+"),
    capability: entry.capability,
    risk: entry.risk,
    approval: entry.approval,
  }
}

function describeEntry(entry: ApiCommandEntry): Record<string, unknown> {
  return {
    command: entry.name,
    resource: entry.action.length > 0 ? `${entry.group} ${entry.action}` : entry.group,
    ...(entry.description ? { description: entry.description } : {}),
    target: entry.target,
    capability: entry.capability,
    risk: entry.risk,
    approval: entry.approval,
    idempotency: entry.idempotency,
    wires: entry.wires.join(", "),
    body: entry.bodyKind,
    ...(entry.requireOneOf
      ? { requireOneOf: entry.requireOneOf.map((group) => group.join(" or ")) }
      : {}),
    fields: entry.flags.map((flag) => ({
      field: flag.name,
      flag: flag.flag.length > 0 ? `--${flag.flag}` : "(use --data)",
      type: flag.type,
      required: flag.required ? "yes" : "",
      ...(flag.nullable ? { nullable: "yes" } : {}),
      ...(flag.enum ? { allowed: flag.enum.join(", ") } : {}),
      ...(flag.description ? { description: flag.description } : {}),
    })),
  }
}

function unknownCommandFailure(name: string): CliFailure {
  const suggestions = suggestCommands(name)
  return {
    error: `no command named "${name}"`,
    cause: "unknown-command",
    fix:
      suggestions.length > 0
        ? [`did you mean: ${suggestions.join(", ")}`]
        : ["cognia-agent api list --search <text>"],
    inspect: ["cognia-agent api list", "cognia-agent api groups"],
  }
}

/** Resolve a host and open a transport, or hand back the failure to print. */
async function openTransport(
  args: ParsedArgs,
  deps: ApiCommandDeps
): Promise<{ transport: HostTransport } | { failure: CliFailure }> {
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveHome(env, os.homedir())
  const cwd = deps.cwd ?? process.cwd()
  const profile = stringFlag(args, "host") ?? stringFlag(args, "profile")
  const resolution: HostResolution = (deps.resolve ?? resolveHost)({
    ...(stringFlag(args, "endpoint") ? { endpoint: stringFlag(args, "endpoint") } : {}),
    ...(profile ? { profile } : {}),
    ...(stringFlag(args, "tenant") ? { tenantId: stringFlag(args, "tenant") } : {}),
    env,
    home,
    cwd,
  })
  const connected = await (deps.connect ?? connectHost)(resolution, deps.connectDeps ?? {})
  return connected.ok ? { transport: connected.transport } : { failure: connected.failure }
}

function readData(args: ParsedArgs): { value?: unknown } | { failure: CliFailure } {
  const raw = stringFlag(args, "data")
  if (raw === undefined) return {}
  const parsed = parseDataFlag(raw)
  if (parsed.ok) return { value: parsed.value }
  return {
    failure: {
      error: parsed.error,
      ...(parsed.details ? { details: parsed.details } : {}),
      cause: "invalid-request",
      fix: parsed.fix,
    },
  }
}

function failureFix(entry: ApiCommandEntry, code?: string): string[] {
  switch (code) {
    case "interactive_approval_required":
      return [
        `cognia-agent api call host_admin_lease_issue --operations '["${entry.name}"]'`,
        "then pass --admin-lease <lease>",
      ]
    case "signed_policy_required":
      return ["pass --policy-id <id> naming a policy the host has signed"]
    case "idempotency_key_required":
      return ["pass --idempotency-key <uuid>, or report this as a CLI bug"]
    case "command_transport_forbidden":
      return [`this wire does not carry ${entry.name}`, `cognia-agent api describe ${entry.name}`]
    case "unknown_command":
      return ["this host predates the command", "cognia-agent api list --wire internal"]
    default:
      return [
        "cognia-agent host show",
        "re-run with --debug to see the command and request field names",
      ]
  }
}

async function liveEntries(
  transport: HostTransport,
  options: OutputOptions,
  signal?: AbortSignal
): Promise<ApiCommandEntry[]> {
  const result = await transport.request(
    "GET",
    transport.wire === "internal" ? "/internal/catalog" : "/api/catalog",
    undefined,
    { timeoutMs: options.timeoutMs, signal }
  )
  if (!result.ok) throw new Error(`Host catalog unavailable: ${result.message}`)
  const catalog = result.result as {
    contractVersion?: number
    commands?: Record<string, unknown>[]
    schemas?: Record<string, { input?: Record<string, unknown>; output?: Record<string, unknown> }>
  }
  if (catalog?.contractVersion !== API_CONTRACT_VERSION || !Array.isArray(catalog.commands))
    throw new Error("Host contract version mismatch; upgrade the CLI or Host before dispatch")
  return catalog.commands.map((descriptor) => {
    const name = String(descriptor.name)
    const local = findCommand(name)
    const compiled = local ? commandForWire(local, transport.wire) : undefined
    const schema = catalog.schemas?.[name] ?? {
      input: compiled?.inputSchema,
      output: compiled?.outputSchema,
    }
    return remoteCommandEntry(descriptor, schema, transport.wire)
  })
}

async function runCall(
  args: ParsedArgs,
  options: OutputOptions,
  deps: ApiCommandDeps,
  out: OutputSink
): Promise<number> {
  const name = args.positionals[0]
  if (!name) {
    return usageFailure(out, "api call needs a <command>", [
      "cognia-agent api call plugin_list",
      "cognia-agent api list --search plugin",
    ])
  }
  const catalogEntry = findCommand(name)
  if (!catalogEntry && args.flags.live !== true)
    return emitFailure(out, unknownCommandFailure(name), EXIT_USAGE)
  const opened = await openTransport(args, deps)
  if ("failure" in opened) return emitFailure(out, opened.failure)
  try {
    const entry =
      args.flags.live === true
        ? (await liveEntries(opened.transport, options, deps.signal)).find(
            (command) => command.name === name
          )
        : catalogEntry
          ? commandForWire(catalogEntry, opened.transport.wire)
          : undefined
    if (!entry) return emitFailure(out, unknownCommandFailure(name), EXIT_USAGE)

    // Second parse: this command's own boolean fields become boolean flags, so
    // `--muted --id x` cannot read "--id" as the value of "--muted". They are
    // never added to the global set, which would change how other commands parse.
    const booleanFields = entry.flags
      .filter((flag) => flag.type === "boolean" && flag.flag.length > 0)
      .map((flag) => flag.flag)
    const reparsed =
      booleanFields.length > 0 && deps.argv
        ? parseArgv(deps.argv, { booleanFlags: booleanFields })
        : args

    const data = readData(reparsed)
    if ("failure" in data) return emitFailure(out, data.failure, EXIT_USAGE)

    const approval = preflight({
      entry,
      transport: opened.transport,
      body: {
        ...(data.value && typeof data.value === "object"
          ? (data.value as Record<string, unknown>)
          : {}),
        ...(stringFlag(reparsed, "admin-lease")
          ? { adminLease: stringFlag(reparsed, "admin-lease") }
          : {}),
        ...(stringFlag(reparsed, "policy-id")
          ? { policyId: stringFlag(reparsed, "policy-id") }
          : {}),
      },
    })
    if (approval) return emitFailure(out, approval)
    const built = buildRequestBody({
      entry,
      flags: reparsed.flags,
      ...(data.value !== undefined ? { data: data.value } : {}),
    })
    if (!built.ok) {
      return emitFailure(
        out,
        {
          error: built.error,
          ...(built.details ? { details: built.details } : {}),
          cause: "invalid-request",
          fix: built.fix,
        },
        EXIT_USAGE
      )
    }

    const runOpenedCommand = async (transport: HostTransport): Promise<number> => {
      if (options.debug) {
        out.error(
          `[debug] ${transport.wire} ${entry.name} ${JSON.stringify(Object.keys(built.body))}`
        )
      }

      const result = await invokeCommand({
        entry,
        body: built.body,
        transport: transport,
        timeoutMs: options.timeoutMs,
        wait: reparsed.flags.wait === true,
        all: reparsed.flags.all === true || reparsed.flags.paginate === true,
        ...(stringFlag(reparsed, "max-pages")
          ? { maxPages: Number(stringFlag(reparsed, "max-pages")) }
          : {}),
        ...(stringFlag(reparsed, "total-timeout")
          ? { totalTimeoutMs: parseDuration(stringFlag(reparsed, "total-timeout")!) }
          : {}),
        signal: deps.signal,
        ...(stringFlag(reparsed, "idempotency-key")
          ? { idempotencyKey: stringFlag(reparsed, "idempotency-key") }
          : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      })

      if (!result.outcome.ok) {
        return emitFailure(out, {
          error: `${entry.name} failed`,
          details: [result.outcome.message, ...(result.outcome.details ?? [])],
          cause: result.outcome.cause,
          problem: result.outcome.problem,
          fix: failureFix(entry, result.outcome.code),
          inspect: [`cognia-agent api describe ${entry.name}`],
          diagnostics: {
            ...(result.outcome.status ? { status: result.outcome.status } : {}),
            ...(result.outcome.code ? { code: result.outcome.code } : {}),
            ...(result.outcome.requestId ? { requestId: result.outcome.requestId } : {}),
            wire: transport.wire,
            retryable:
              result.outcome.retryable === undefined ? undefined : String(result.outcome.retryable),
            retryAfter: result.outcome.retryAfter,
            retryAfterMs: result.outcome.retryAfterMs,
            operationId: result.outcome.operationId,
          },
        })
      }

      if (result.outcome.accepted && !result.waited) {
        out.error(
          `[accepted] ${entry.name} is running as operation ${result.operationId ?? "(no id)"}. Add --wait to follow it.`
        )
      }
      if (reparsed.flags["strict-output"] === true) {
        const invalid = validateContract(entry, result.outcome.result, "output")
        if (invalid)
          return emitFailure(out, {
            error: invalid.error,
            details: invalid.details,
            cause: "failed",
            fix: invalid.fix,
          })
      }
      emitResult(out, result.outcome.result, options, entry.name)
      return EXIT_OK
    }
    return await runOpenedCommand(opened.transport)
  } finally {
    opened.transport.close?.()
  }
}

async function runRequest(
  args: ParsedArgs,
  options: OutputOptions,
  deps: ApiCommandDeps,
  out: OutputSink
): Promise<number> {
  const [method, routePath] = args.positionals
  if (!method || !routePath) {
    return usageFailure(out, "api request needs <METHOD> and <path>", [
      "cognia-agent api request GET /api/devices",
    ])
  }
  if (!routePath.startsWith("/")) {
    return usageFailure(out, 'path must start with "/"', [
      "cognia-agent api request GET /api/devices",
    ])
  }
  const data = readData(args)
  if ("failure" in data) return emitFailure(out, data.failure, EXIT_USAGE)

  const opened = await openTransport(args, deps)
  if ("failure" in opened) return emitFailure(out, opened.failure)

  const displayPath = new URL(routePath, "https://display.invalid").pathname
  if (options.debug) out.error(`[debug] ${opened.transport.wire} ${method} request`)

  const mode = stringFlag(args, "response") ?? "json"
  if (!["json", "text", "bytes", "stream"].includes(mode)) {
    opened.transport.close?.()
    return usageFailure(out, "invalid --response", ["use json|text|bytes|stream"])
  }
  const save = stringFlag(args, "save")
  if (mode === "bytes" && !save) {
    opened.transport.close?.()
    return usageFailure(out, "--response bytes needs --save <path>", [
      "use --save to preserve binary bytes",
    ])
  }
  const bodyFile = stringFlag(args, "body-file")
  const multipart = stringFlag(args, "multipart")
  const contentType = stringFlag(args, "content-type")
  if (
    [stringFlag(args, "data"), bodyFile, multipart].filter((value) => value !== undefined).length >
    1
  ) {
    opened.transport.close?.()
    return usageFailure(out, "choose one of --data, --body-file, --multipart", [
      "send one request body",
    ])
  }
  const headerValue = stringFlag(args, "header")
  let headers: Record<string, string> = {}
  let rawBody: BodyInit | undefined
  let temporary: string | undefined
  let fd: number | undefined
  const decoder = new StringDecoder("utf8")
  let outcome: Awaited<ReturnType<HostTransport["request"]>>
  try {
    if (headerValue) {
      const parsed: unknown = JSON.parse(headerValue)
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((value) => typeof value !== "string")
      )
        throw new Error("--header must be a JSON object of strings")
      headers = Object.fromEntries(new Headers(parsed as Record<string, string>))
      if (
        Object.keys(headers).some((key) =>
          /^(authorization|dpop|host|cookie|content-length|connection|transfer-encoding|proxy-authorization)$/i.test(
            key
          )
        )
      )
        throw new Error("--header cannot override authentication or routing headers")
    }
    if (contentType) headers["content-type"] = contentType
    if (bodyFile) {
      rawBody = fs.readFileSync(bodyFile) as unknown as BodyInit
      headers["content-type"] ??= "application/octet-stream"
    }
    if (multipart) {
      const fields: unknown = JSON.parse(multipart)
      if (!fields || typeof fields !== "object" || Array.isArray(fields))
        throw new Error("--multipart must be a JSON field map (file values begin with @)")
      const form = new FormData()
      for (const [name, value] of Object.entries(fields)) {
        if (typeof value !== "string") throw new Error("multipart field values must be strings")
        if (value.startsWith("@"))
          form.append(
            name,
            new Blob([fs.readFileSync(value.slice(1))]),
            path.basename(value.slice(1))
          )
        else form.append(name, value)
      }
      const encoded = new Request("https://encoding.invalid", { method: "POST", body: form })
      rawBody = Buffer.from(await encoded.arrayBuffer()) as unknown as BodyInit
      headers["content-type"] = encoded.headers.get("content-type")!
    }
    if (save) {
      temporary = `${path.resolve(save)}.${randomUUID()}.tmp`
      fd = fs.openSync(temporary, "wx", 0o600)
    }
    const maxBytes = stringFlag(args, "max-bytes")
      ? Number(stringFlag(args, "max-bytes"))
      : undefined
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0))
      throw new Error("--max-bytes must be a positive integer")
    outcome = await opened.transport.request(method, routePath, data.value, {
      timeoutMs: options.timeoutMs,
      signal: deps.signal,
      responseMode: mode as "json" | "text" | "bytes" | "stream",
      headers,
      rawBody,
      maxBytes,
      ...(stringFlag(args, "idempotency-key")
        ? { idempotencyKey: stringFlag(args, "idempotency-key") }
        : {}),
      onChunk: (chunk) => {
        if (fd !== undefined) fs.writeSync(fd, chunk)
        else out.write(decoder.write(Buffer.from(chunk)))
      },
    })
    if (outcome.ok && fd !== undefined && mode !== "stream") {
      if (mode === "bytes") fs.writeSync(fd, outcome.result as Uint8Array)
      else
        fs.writeSync(fd, mode === "text" ? String(outcome.result) : JSON.stringify(outcome.result))
    }
    if (mode === "stream" && !save) out.write(decoder.end())
    if (fd !== undefined) {
      fs.closeSync(fd)
      fd = undefined
    }
    if (outcome.ok && temporary && save) {
      fs.renameSync(temporary, path.resolve(save))
      temporary = undefined
    }
  } catch (error) {
    outcome = {
      ok: false,
      cause: "invalid-request",
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (temporary) fs.rmSync(temporary, { force: true })
    opened.transport.close?.()
  }
  if (!outcome.ok) {
    return emitFailure(out, {
      error: `${method.toUpperCase()} ${displayPath} failed`,
      details: [outcome.message, ...(outcome.details ?? [])],
      cause: outcome.cause,
      problem: outcome.problem,
      fix: ["cognia-agent host show", "check the route against protocol/companion-api-routes.json"],
      diagnostics: {
        ...(outcome.status ? { status: outcome.status } : {}),
        ...(outcome.code ? { code: outcome.code } : {}),
        wire: opened.transport.wire,
        requestId: outcome.requestId,
        retryable: outcome.retryable === undefined ? undefined : String(outcome.retryable),
        retryAfter: outcome.retryAfter,
        retryAfterMs: outcome.retryAfterMs,
        operationId: outcome.operationId,
      },
    })
  }
  const basename = displayPath.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")
  if (!save && mode === "json")
    emitResult(out, outcome.result, options, basename.length > 0 ? basename : "request")
  else if (!save && mode === "text") out.write(String(outcome.result))
  return EXIT_OK
}

async function runEvents(
  args: ParsedArgs,
  options: OutputOptions,
  deps: ApiCommandDeps,
  out: OutputSink
): Promise<number> {
  const channels = (stringFlag(args, "channels") ?? "").split(",").filter(Boolean)
  if (!channels.length || channels.length > 32)
    return usageFailure(out, "events needs --channels <channel,...> (at most 32)", [
      "choose channels from the Host's event catalog",
    ])
  const opened = await openTransport(args, deps)
  if ("failure" in opened) return emitFailure(out, opened.failure)
  try {
    if (!opened.transport.watch)
      return emitFailure(out, { error: "this transport cannot watch events", cause: "refused" })
    const checkpoint = stringFlag(args, "cursor-file")
    let since =
      stringFlag(args, "since") !== undefined ? Number(stringFlag(args, "since")) : undefined
    if (checkpoint && fs.existsSync(checkpoint)) {
      const saved: unknown = JSON.parse(fs.readFileSync(checkpoint, "utf8"))
      if (
        !saved ||
        typeof saved !== "object" ||
        (saved as { host?: unknown }).host !== opened.transport.label
      )
        throw new Error("cursor file belongs to a different Host")
      if (since === undefined) since = (saved as { seq: number }).seq
    }
    const maxEvents =
      stringFlag(args, "max-events") !== undefined
        ? Number(stringFlag(args, "max-events"))
        : undefined
    const reconnects =
      stringFlag(args, "reconnects") !== undefined ? Number(stringFlag(args, "reconnects")) : 3
    if (
      (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) ||
      (maxEvents !== undefined && (!Number.isSafeInteger(maxEvents) || maxEvents < 1)) ||
      !Number.isSafeInteger(reconnects) ||
      reconnects < 0 ||
      reconnects > 10
    )
      throw new Error("invalid --since, --max-events or --reconnects")
    const outcome = await opened.transport.watch({
      channels,
      since,
      maxEvents,
      reconnects,
      timeoutMs: options.timeoutMs,
      signal: deps.signal,
      onEvent: (event) => {
        out.write(`${JSON.stringify(event)}\n`)
        if (checkpoint) {
          const temporary = `${checkpoint}.${randomUUID()}.tmp`
          try {
            fs.writeFileSync(
              temporary,
              JSON.stringify({ host: opened.transport.label, seq: event.seq }),
              { mode: 0o600 }
            )
            fs.renameSync(temporary, checkpoint)
          } finally {
            fs.rmSync(temporary, { force: true })
          }
        }
      },
    })
    return outcome.ok
      ? EXIT_OK
      : emitFailure(out, { error: outcome.message, cause: outcome.cause, problem: outcome.problem })
  } catch (error) {
    return usageFailure(out, error instanceof Error ? error.message : String(error), [
      "check the event flags and cursor file",
    ])
  } finally {
    opened.transport.close?.()
  }
}

async function apiCommandImpl(args: ParsedArgs, deps: ApiCommandDeps = {}): Promise<number> {
  const baseOut = deps.out ?? realOutput
  const machine =
    args.flags.json === true || ["raw", "json"].includes(stringFlag(args, "format") ?? "")
  const out: OutputSink = machine
    ? {
        ...baseOut,
        failure: (failure, exitCode) =>
          baseOut.error(JSON.stringify({ ok: false, ...failure, exitCode })),
      }
    : baseOut
  deps = { ...deps, out }

  if (args.help || !args.subcommand) {
    out.write(API_HELP)
    return args.subcommand ? EXIT_OK : EXIT_USAGE
  }

  const options = resolveOutputOptions(args, deps.env ?? process.env)
  if ("error" in options) return usageFailure(out, options.error, [options.fix])

  let currentEntries: ApiCommandEntry[] | undefined
  if (
    args.flags.live === true &&
    ["list", "groups", "describe", "schema"].includes(args.subcommand ?? "")
  ) {
    const opened = await openTransport(args, deps)
    if ("failure" in opened) return emitFailure(out, opened.failure)
    try {
      currentEntries = await liveEntries(opened.transport, options, deps.signal)
    } finally {
      opened.transport.close?.()
    }
  }
  switch (args.subcommand) {
    case "list": {
      const rows = filterCommands(currentEntries ?? listCommands(), {
        group: stringFlag(args, "group"),
        wire: stringFlag(args, "wire") as "internal" | "http" | undefined,
        capability: stringFlag(args, "capability"),
        risk: stringFlag(args, "risk") as ApiCommandEntry["risk"] | undefined,
        approval: stringFlag(args, "approval") as ApiCommandEntry["approval"] | undefined,
        search: stringFlag(args, "search"),
      }).map(projectRow)
      emitResult(out, rows, options, "api-list")
      return EXIT_OK
    }
    case "groups": {
      const wire = stringFlag(args, "wire") as "internal" | "http" | undefined
      const admitted = currentEntries ? filterCommands(currentEntries, { wire }) : undefined
      const groups = admitted
        ? [...new Set(admitted.map((entry) => entry.group))].map((group) => ({
            group,
            count: admitted.filter((entry) => entry.group === group).length,
          }))
        : commandGroups(wire)
      emitResult(out, groups, options, "api-groups")
      return EXIT_OK
    }
    case "describe": {
      const name = args.positionals[0]
      if (!name) {
        return usageFailure(out, "api describe needs a <command>", [
          "cognia-agent api describe plugin_list",
        ])
      }
      const found = currentEntries
        ? currentEntries.find((entry) => entry.name === name)
        : findCommand(name)
      const entry = found
        ? commandForWire(found, stringFlag(args, "wire") === "http" ? "http" : "internal")
        : undefined
      if (!entry) return emitFailure(out, unknownCommandFailure(name), EXIT_USAGE)
      emitResult(out, describeEntry(entry), options, `${entry.name}-describe`)
      return EXIT_OK
    }
    case "schema": {
      const name = args.positionals[0]
      if (!name) {
        return usageFailure(out, "api schema needs a <command>", [
          "cognia-agent api schema adapter_update_policy --template",
        ])
      }
      const found = currentEntries
        ? currentEntries.find((entry) => entry.name === name)
        : findCommand(name)
      const entry = found
        ? commandForWire(found, stringFlag(args, "wire") === "http" ? "http" : "internal")
        : undefined
      if (!entry) return emitFailure(out, unknownCommandFailure(name), EXIT_USAGE)
      if (args.flags.template === true) {
        // A template is meant to be piped into an editor and back through
        // --data, so it is always JSON regardless of --format.
        emitResult(
          out,
          requestTemplate(entry),
          { ...options, format: "json" },
          `${entry.name}-body`
        )
        return EXIT_OK
      }
      emitResult(
        out,
        args.flags["output-schema"] === true ? entry.outputSchema : entry.inputSchema,
        options,
        `${entry.name}-schema`
      )
      return EXIT_OK
    }
    case "events":
      return runEvents(args, options, deps, out)
    case "call":
      return runCall(args, options, deps, out)
    case "request":
      return runRequest(args, options, deps, out)
    default:
      return usageFailure(
        out,
        `unknown api subcommand "${args.subcommand}"`,
        ["cognia-agent api --help"],
        ["cognia-agent api list"]
      )
  }
}

/** One cancellation/deadline scope includes auth, streaming and all page/operation reads. */
export async function apiCommand(args: ParsedArgs, deps: ApiCommandDeps = {}): Promise<number> {
  const base = deps.out ?? realOutput
  const machine =
    args.flags.json === true || ["raw", "json"].includes(stringFlag(args, "format") ?? "")
  const out: OutputSink = machine
    ? {
        ...base,
        failure: (failure, exitCode) =>
          base.error(JSON.stringify({ ok: false, ...failure, exitCode })),
      }
    : base
  const output = resolveOutputOptions(args, deps.env ?? process.env)
  if ("error" in output) return usageFailure(out, output.error, [output.fix])
  const total = stringFlag(args, "total-timeout")
  const budget = total ? parseDuration(total) : output.timeoutMs
  if (budget === undefined)
    return usageFailure(out, "invalid --total-timeout", ["use a duration such as 30s"])
  const controller = new AbortController()
  const stop = () => controller.abort()
  const timer = setTimeout(stop, budget)
  const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal
  process.once("SIGINT", stop)
  try {
    return await apiCommandImpl(args, { ...deps, out, signal })
  } catch (error) {
    return emitFailure(out, {
      error: error instanceof Error ? error.message : String(error),
      cause: signal.aborted ? "timeout" : "failed",
    })
  } finally {
    clearTimeout(timer)
    process.removeListener("SIGINT", stop)
  }
}
