/**
 * `pnpm smoke:subagent-models` — check that a real Pi or OpenCode process
 * sends each subagent to the model its Cognia slot names, against the
 * loopback fixture model (scripts/smoke/agents/fixture-model.ts).
 *
 *   pnpm smoke:subagent-models              both lanes
 *   pnpm smoke:subagent-models pi           Pi with the gotgenes and nico subagent packages
 *   pnpm smoke:subagent-models opencode     OpenCode server, ACP and V2 service
 *
 * No provider credentials and no remote model calls. The Pi lane needs `pi`
 * (or PI_BIN) and both subagent packages (GOTGENES_SUBAGENTS_DIR,
 * NICO_SUBAGENTS_DIR); the OpenCode lane needs OPENCODE_V1_BIN and
 * OPENCODE_V2_BIN. Evidence lands under .cache/{pi,opencode}-subagent-models/.
 */
import { parseArgs } from "node:util"
import { runOpenCodeSubagentModels } from "./agents/subagent-models/opencode"
import { runPiSubagentModels } from "./agents/subagent-models/pi"

/** Each lane and how long its real processes may take before the smoke gives up. */
export const LANES = {
  pi: { run: runPiSubagentModels, timeoutMs: 120_000 },
  opencode: { run: runOpenCodeSubagentModels, timeoutMs: 180_000 },
} as const

export type Lane = keyof typeof LANES

export const USAGE = `Usage: pnpm smoke:subagent-models [pi] [opencode]

  With no lane, runs both.`

export function parseLanes(argv: string[]): Lane[] {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true })
  for (const lane of positionals)
    if (!(lane in LANES)) throw new Error(`Unknown lane "${lane}"; expected pi or opencode`)
  return positionals.length ? [...new Set(positionals as Lane[])] : (Object.keys(LANES) as Lane[])
}

/** Reject with a timeout once `ms` passes, so a hung agent cannot hang the smoke. */
export async function withTimeout<T>(lane: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${lane} lane timed out after ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE)
    return
  }
  let lanes: Lane[]
  try {
    lanes = parseLanes(argv)
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  const failures: string[] = []
  for (const lane of lanes) {
    try {
      const { run, timeoutMs } = LANES[lane]
      await withTimeout(lane, timeoutMs, run)
      console.error(`[smoke:subagent-models] ${lane} passed`)
    } catch (error) {
      failures.push(`${lane}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length) {
    console.error(`[smoke:subagent-models] failed\n  ✗ ${failures.join("\n  ✗ ")}`)
    process.exitCode = 1
  }
  // Agent processes and sockets a failed lane left behind must not keep the smoke alive.
  process.exit()
}

if (require.main === module)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
