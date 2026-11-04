/**
 * `pnpm smoke:agent` — run the external-agent smoke for runtimes from
 * protocol/external-agent-runtimes.json through Cognia's real CLI host and
 * sandbox (scripts/smoke/agents/).
 *
 *   pnpm smoke:agent --list              every runtime, whether it is installed, which lane covers it
 *   pnpm smoke:agent kimi qoder          the generic ACP lane plus each vendor module
 *   pnpm smoke:agent --installed         every installed ACP runtime
 *   pnpm smoke:agent kimi --live         also run real model turns on the local login
 *
 * The default lane reads no user credentials and sends no model request.
 * Each report is printed and written to .cache/smoke-agent/<runtime>.json
 * (stdout also carries the adapter's log lines). Needs the sandbox launcher:
 * `pnpm cli:external-host:build`.
 */
import "./agents/cli-host"
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { probeRuntimeVersion } from "@/cli/src/runtime/external/version-probe"
import {
  EXTERNAL_AGENT_RUNTIMES,
  runtimeSupportsPlatform,
} from "@/lib/ai/agent/external/config/install-catalog"
import { RuntimeNotInstalled, runAgentSmoke, type VendorSmoke } from "./agents/generic"
import { printReport } from "./agents/kit"
import { kimi } from "./agents/vendors/kimi"
import { qoder } from "./agents/vendors/qoder"

const REPORT_DIR = path.resolve(".cache/smoke-agent")

/** Vendor modules by runtime id; every other ACP runtime gets the generic lane alone. */
export const VENDORS: Record<string, VendorSmoke> = { kimi, qoder }

const Options = z
  .object({
    runtimes: z.array(z.string().trim().min(1)),
    list: z.boolean(),
    installed: z.boolean(),
    live: z.boolean(),
    keep: z.boolean(),
  })
  .refine((value) => value.list || value.installed || value.runtimes.length > 0, {
    message: "Name at least one runtime, or pass --installed or --list",
  })
  .refine((value) => !(value.installed && value.runtimes.length), {
    message: "--installed selects the runtimes itself; do not also name runtimes",
  })

export type AgentSmokeOptions = z.infer<typeof Options>

export const USAGE = `Usage: pnpm smoke:agent [runtimes...] [--list | --installed] [--live] [--keep]

  runtimes      Runtime ids from protocol/external-agent-runtimes.json
  --list        List runtimes, install state and covering lane
  --installed   Run every installed ACP runtime
  --live        Use the real local login and run model turns (spends tokens)
  --keep        Keep each scratch workspace for inspection`

// node:util parseArgs, not commander: commander 15 is ESM-only and this file
// also loads under Jest's CommonJS transform.
export function parseAgentSmokeArgs(argv: string[]): AgentSmokeOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      list: { type: "boolean", default: false },
      installed: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
    },
  })
  return Options.parse({ runtimes: positionals, ...values })
}

/** Which smoke covers a runtime: a vendor module, the generic ACP lane, or none yet. */
export function coveringLane(runtimeId: string, protocol: string): string {
  if (VENDORS[runtimeId]) return "generic + vendor"
  return protocol === "acp" ? "generic" : `none (${protocol})`
}

async function installed(runtimeId: string): Promise<string | null> {
  try {
    return (await probeRuntimeVersion(runtimeId)).output?.trim() || null
  } catch {
    return null
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE)
    return
  }
  let options: AgentSmokeOptions
  try {
    options = parseAgentSmokeArgs(argv)
  } catch (error) {
    const messages =
      error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message)
        : [error instanceof Error ? error.message : String(error)]
    console.error(`${messages.join("\n")}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  const runtimes = EXTERNAL_AGENT_RUNTIMES.filter((runtime) =>
    runtimeSupportsPlatform(runtime, process.platform)
  )
  if (options.list) {
    for (const runtime of runtimes) {
      const version = await installed(runtime.runtimeId)
      console.log(
        `${runtime.runtimeId.padEnd(22)} ${runtime.protocol.padEnd(16)} ${(version ?? "-").padEnd(24)} ${coveringLane(runtime.runtimeId, runtime.protocol)}`
      )
    }
    return
  }

  const selected = options.installed
    ? (
        await Promise.all(
          runtimes
            .filter((runtime) => runtime.protocol === "acp")
            .map(async (runtime) =>
              (await installed(runtime.runtimeId)) ? runtime.runtimeId : null
            )
        )
      ).filter((id): id is string => id !== null)
    : options.runtimes
  const results: Array<{ runtimeId: string; status: "passed" | "failed"; detail?: string }> = []
  for (const runtimeId of selected) {
    try {
      const report = await runAgentSmoke(runtimeId, options, VENDORS[runtimeId])
      printReport(report)
      fs.mkdirSync(REPORT_DIR, { recursive: true })
      fs.writeFileSync(
        path.join(REPORT_DIR, `${runtimeId}${options.live ? "-live" : ""}.json`),
        `${JSON.stringify(report, null, 2)}\n`
      )
      results.push({ runtimeId, status: "passed" })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`[smoke:agent] ${runtimeId}: ${detail}`)
      results.push({
        runtimeId,
        status: "failed",
        detail: error instanceof RuntimeNotInstalled ? `not installed: ${detail}` : detail,
      })
    }
  }
  console.error(
    `[smoke:agent] ${results.filter((r) => r.status === "passed").length}/${results.length} passed` +
      results
        .filter((r) => r.status === "failed")
        .map((r) => `\n  ✗ ${r.runtimeId}: ${r.detail}`)
        .join("")
  )
  if (results.some((result) => result.status === "failed") || results.length === 0)
    process.exitCode = 1
}

if (require.main === module)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
