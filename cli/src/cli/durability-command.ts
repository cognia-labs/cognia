/**
 * `cognia-agent durability …` — operator tooling for the headless brain's
 * SQLite durability store (ADR-0059).
 *
 * ```
 * durability verify   --account <id> | --root <path>
 * durability compact  --account <id>
 * ```
 *
 * The tooling never runs the brain. `verify` is read-only and safe while serve
 * runs; `compact` (VACUUM) needs the writer stopped. Restoring an account is a
 * Host backup restore: the backup copies the SQLite store online and runs
 * `verify` over the staged copy before sealing the archive.
 *
 * Every verb prints a human summary by default and a machine record under
 * `--json`, because these are the commands an operator reaches for during an
 * incident and both audiences are real.
 */
import { durabilityRoot, resolveServeHome } from "../serve/persistence/backend"
import { verifyDurability } from "../serve/persistence/operations"
import { compactSqlite } from "../serve/persistence/sqlite"
import { DurabilityFault } from "../serve/persistence/types"
import { boolFlag, stringFlag, type ParsedArgs } from "./args"
import type { OutputSink } from "./output"

export const DURABILITY_HELP = `cognia-agent durability — headless persistence tooling

  durability verify   --account <id> | --root <path>   integrity check + decode every row
  durability compact  --account <id>                   VACUUM SQLite while the writer is stopped

Flags:
  --home <dir>   explicit persistence home (default: COGNIA_DATA_DIR/serve or ~/.cognia/serve)
  --root <path>  verify only: inspect a staged account root (a backup's copy)
  --json         emit one machine-readable record instead of the summary
`

export interface DurabilityDeps {
  out: OutputSink
  env?: Record<string, string | undefined>
}

export async function durabilityCommand(args: ParsedArgs, deps: DurabilityDeps): Promise<number> {
  const { out } = deps
  const env = deps.env ?? process.env
  const json = boolFlag(args, "json")
  const verb = args.positionals[0] ?? args.subcommand

  if (!verb || verb === "help") {
    out.write(DURABILITY_HELP)
    return verb ? 0 : 2
  }

  const explicitRoot = stringFlag(args, "root")
  if (args.flags.root !== undefined && (verb !== "verify" || !explicitRoot)) {
    out.error("durability: --root is only supported by verify and requires <path>\n")
    return 2
  }
  const accountId = stringFlag(args, "account")
  if (!accountId && !explicitRoot) {
    out.error("durability: --account <id> is required\n")
    return 2
  }
  const root =
    explicitRoot ?? durabilityRoot(resolveServeHome(env, stringFlag(args, "home")), accountId!)

  try {
    switch (verb) {
      case "verify":
        return await runVerify(root, out, json)
      case "compact": {
        const result = compactSqlite(root)
        if (json) out.json({ ok: true, ...result })
        else {
          out.write(`bytes before:    ${result.bytesBefore}\n`)
          out.write(`bytes after:     ${result.bytesAfter}\n`)
        }
        return 0
      }
      default:
        out.error(`durability: unknown subcommand "${verb}"\n`)
        out.write(DURABILITY_HELP)
        return 2
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error instanceof DurabilityFault ? error.code : "error"
    if (json) out.json({ ok: false, code, message })
    else out.error(`durability: ${message}\n`)
    return 1
  }
}

async function runVerify(root: string, out: OutputSink, json: boolean): Promise<number> {
  const status = await verifyDurability(root)
  if (json) {
    out.json({ ok: status.faults.length === 0, ...status })
    return status.faults.length === 0 ? 0 : 1
  }
  out.write(`root:            ${status.root}\n`)
  out.write(`backend:         ${status.backend}\n`)
  out.write(
    `sqlite:          ${status.sqlitePresent ? `present (sequence ${status.sqliteSequence ?? "-"})` : "absent"}\n`
  )
  for (const fault of status.faults) {
    out.error(
      `fault ${fault.code}${fault.sequence === null ? "" : ` @${fault.sequence}`}: ${fault.message}\n`
    )
  }
  return status.faults.length === 0 ? 0 : 1
}
