import type { Goal, GoalConfig, GoalStatus } from "@/types/goal"
import type { CapabilityContributionContext } from "@/lib/modules/manifest-types"
import { GOAL_SECTION_MARKER } from "./prompts"
import { contributions, goalCapabilityGrant } from "./context-injector"
import goalModule from "./module"

const SAMPLE_CONFIG: GoalConfig = {
  maxTurns: 20,
  maxTokens: 200_000,
  maxJudgeFailures: 3,
  timeoutMs: 30 * 60_000,
}

function buildGoal(overrides: Partial<Goal> = {}): Goal {
  const now = Date.now()
  return {
    id: "g1",
    sessionId: "ses_a",
    rawObjective: "ship feature flag system",
    safeObjective: "ship feature flag system",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 0,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: SAMPLE_CONFIG,
    generationId: "gen-1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("goalCapabilityGrant", () => {
  it("adds nothing without a goal", () => {
    expect(goalCapabilityGrant(null)).toBeNull()
    expect(goalCapabilityGrant(undefined)).toBeNull()
  })

  it.each<GoalStatus>([
    "paused",
    "completed",
    "stopped",
    "budget_limited",
    "turn_limited",
    "timed_out",
    "preempted",
  ])("adds nothing when status is %s", (status) => {
    expect(goalCapabilityGrant(buildGoal({ status }))).toBeNull()
  })

  it("adds the goal section as the only instruction when status is active", () => {
    const grant = goalCapabilityGrant(buildGoal({ status: "active" }))
    expect(grant?.instructions).toHaveLength(1)
    expect(grant?.instructions?.[0].startsWith(GOAL_SECTION_MARKER)).toBe(true)
    expect(grant?.instructions?.[0]).toContain("ship feature flag system")
    expect(grant).not.toHaveProperty("maxBudgetUsd")
  })

  it("carries a positive per-turn USD ceiling as the run's budget", () => {
    const goal = buildGoal({ config: { ...SAMPLE_CONFIG, maxBudgetUsd: 1.5 } })
    expect(goalCapabilityGrant(goal)?.maxBudgetUsd).toBe(1.5)
    for (const maxBudgetUsd of [0, -1]) {
      const unset = buildGoal({ config: { ...SAMPLE_CONFIG, maxBudgetUsd } })
      expect(goalCapabilityGrant(unset)).not.toHaveProperty("maxBudgetUsd")
    }
  })

  it("leaves out a section that carries leaking PII (red-line gate) but keeps the budget", () => {
    const goal = buildGoal({
      safeObjective: "email the report to john.doe@example.com before EOD",
      config: { ...SAMPLE_CONFIG, maxBudgetUsd: 2 },
    })
    expect(goalCapabilityGrant(goal)).toEqual({ maxBudgetUsd: 2 })
    expect(goalCapabilityGrant({ ...goal, config: SAMPLE_CONFIG })).toBeNull()
  })

  it("still adds a clean goal section that has no PII", () => {
    const grant = goalCapabilityGrant(buildGoal({ safeObjective: "ship the flag system" }))
    expect(grant?.instructions?.[0]).toContain("ship the flag system")
  })
})

describe("the goal module's contribution", () => {
  const run = (activeGoal: Goal | null): CapabilityContributionContext => ({
    session: null,
    agent: null,
    settings: null,
    activeGoal,
    prompts: { snapshot: null, context: {} },
  })

  it("is one refuse-turn contribution, because its budget narrows the run", async () => {
    expect(contributions.map(({ id, failure }) => ({ id, failure }))).toEqual([
      { id: "active-goal", failure: "refuse-turn" },
    ])
    expect((await goalModule.capabilityContributions.load()).contributions).toBe(contributions)
  })

  it("reads the run's active goal", async () => {
    const goal = buildGoal({ config: { ...SAMPLE_CONFIG, maxBudgetUsd: 3 } })
    expect(await contributions[0].produce(run(goal))).toEqual(goalCapabilityGrant(goal, null))
    expect(await contributions[0].produce(run(null))).toBeNull()
  })
})
