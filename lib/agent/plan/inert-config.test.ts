/**
 * Pins the dormant plan knobs (CLAUDE.md rule 7: documented at the type,
 * labelled inert in the UI, pinned by a test).
 *
 * `PlanConfig.maxStepRetries`, `judgeDeviation` and `maxTokens` are part of
 * the plugin contract and carry `@deprecated Inert` docs; the workflow form no
 * longer offers the `judge_deviation` refinement trigger. Nothing in the plan
 * runtime or the plan workflow nodes may start reading them without this test
 * — and those docs — changing with it.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { globSync } from "glob"

import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

const ROOT = join(__dirname, "..", "..", "..")
const SOURCES = [
  ...globSync("lib/agent/plan/**/*.ts", { cwd: ROOT, ignore: ["**/*.test.ts"] }),
  ...globSync("lib/workflow/nodes/plans/**/*.ts", { cwd: ROOT, ignore: ["**/*.test.ts"] }),
  ...globSync("sidecar/src/tools/builtin/plan/**/*.ts", { cwd: ROOT, ignore: ["**/*.test.ts"] }),
]

describe("inert plan config", () => {
  it("still ships the knobs in the contract defaults", () => {
    expect(DEFAULT_PLAN_CONFIG).toMatchObject({ maxStepRetries: 1, judgeDeviation: false })
    expect(DEFAULT_PLAN_CONFIG.maxTokens).toBeUndefined()
  })

  it("is read by no plan executor", () => {
    expect(SOURCES.length).toBeGreaterThan(10)
    const readers = SOURCES.filter((file) =>
      /\b(maxStepRetries|judgeDeviation)\b|config\??\.maxTokens\b/.test(
        readFileSync(join(ROOT, file), "utf8")
      )
    )
    expect(readers).toEqual([])
  })

  it("never raises the reserved judge_deviation trigger", () => {
    const raisers = SOURCES.filter((file) =>
      /trigger:\s*"judge_deviation"/.test(readFileSync(join(ROOT, file), "utf8"))
    )
    expect(raisers).toEqual([])
  })
})
